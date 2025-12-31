import { prisma } from '../../libs/prisma.js';
import { logger } from '../../libs/logger.js';
import * as ordersService from '../orders/orders.service.js';
import * as inventoryService from '../inventory/inventory.service.js';
import { redis } from '../../libs/redis.js';

const DASHBOARD_CACHE_KEY = 'admin:dashboard:stats';
const DASHBOARD_CACHE_TTL = 120; // Issue #30: Reduced to 2 minutes from 5

// --- CACHE INVALIDATION (Issue #30) ---
export const invalidateDashboardCache = async (): Promise<void> => {
    await redis.del(DASHBOARD_CACHE_KEY);
    logger.debug('Dashboard cache invalidated');
};

// --- STATS (CACHED & OPTIMIZED) ---
export const getDashboardStats = async (forceRefresh = false) => {
    // Option to force refresh (e.g., after admin action)
    if (!forceRefresh) {
        const cached = await redis.get(DASHBOARD_CACHE_KEY);
        if (cached) return JSON.parse(cached);
    }

    // OPTIMIZED: Only 3 queries instead of 7
    // 1. Single groupBy for all status counts
    // 2. Aggregate for revenue
    // 3. GroupBy for chain popularity
    const [byStatus, revenue, byChain] = await Promise.all([
        // Query 1: Get all counts by status in single query
        prisma.order.groupBy({
            by: ['status'],
            _count: { _all: true }
        }),
        // Query 2: Revenue aggregate
        prisma.order.aggregate({
            where: { status: 'SUCCESS' },
            _sum: { amountIdr: true }
        }),
        // Query 3: Chain popularity
        prisma.order.groupBy({
            by: ['chain'],
            _count: { _all: true },
            where: { status: 'SUCCESS' }
        })
    ]);

    // Calculate totals from groupBy result
    let totalOrders = 0;
    let successOrders = 0;
    let failedOrders = 0;
    let pendingOrders = 0;

    for (const row of byStatus) {
        const count = row._count._all;
        totalOrders += count;

        switch (row.status) {
            case 'SUCCESS':
                successOrders = count;
                break;
            case 'FAILED':
                failedOrders = count;
                break;
            case 'PENDING':
                pendingOrders = count;
                break;
        }
    }

    const result = {
        overview: {
            totalOrders,
            successOrders,
            pendingOrders,
            successRate: totalOrders > 0 ? (successOrders / totalOrders * 100).toFixed(1) + '%' : '0%',
            totalRevenueIdr: revenue._sum.amountIdr || 0,
            failedOrders
        },
        breakdown: {
            status: byStatus.map(s => ({ status: s.status, _count: s._count._all })),
            chain: byChain.map(c => ({ chain: c.chain, _count: c._count._all }))
        },
        calculatedAt: new Date().toISOString(),
        cacheExpiresIn: DASHBOARD_CACHE_TTL
    };

    // Save to Cache
    await redis.setex(DASHBOARD_CACHE_KEY, DASHBOARD_CACHE_TTL, JSON.stringify(result));

    return result;
};

// --- DATA LISTS (OPTIMIZED) ---

export const getUsersList = async (page = 0, limit = 20, search?: string) => {
    const where = search ? {
        OR: [{ email: { contains: search } }, { name: { contains: search } }]
    } : {};

    const [users, total] = await Promise.all([
        prisma.user.findMany({
            where,
            skip: page * limit,
            take: limit,
            orderBy: { createdAt: 'desc' },
            select: {
                id: true, name: true, email: true, role: true,
                createdAt: true, telegramId: true, referralCode: true,
                _count: { select: { orders: true, referrals: true } } // Rich Info
            }
        }),
        prisma.user.count({ where })
    ]);

    return { users, total };
};

export const getOrdersList = async (page = 0, limit = 20, status?: string) => {
    const where = status ? { status: status as any } : {};

    const [orders, total] = await Promise.all([
        prisma.order.findMany({
            where,
            skip: page * limit,
            take: limit,
            orderBy: { createdAt: 'desc' },
            // LEAN PROJECTION (Avoid selecting midtrans JSON logs if any)
            select: {
                id: true, userId: true, chain: true, symbol: true,
                amountIdr: true, amountToken: true, status: true,
                txHash: true, createdAt: true,
                user: { select: { email: true, name: true } } // Join basic info
            }
        }),
        prisma.order.count({ where })
    ]);

    return { orders, total };
};

// --- HELPER: AUDIT LOG ---
const logAudit = async (adminId: string, action: string, resource: string, details: any, ip?: string) => {
    try {
        await prisma.auditLog.create({
            data: { adminId, action, resource, details, ipAddress: ip }
        });
    } catch (e) {
        logger.error({ error: e }, 'Failed to write audit log');
    }
};

// --- OPS: RETRY ORDER ---
export const retryOrder = async (orderId: string, adminId: string, ip?: string): Promise<string> => {
    const order = await ordersService.getOrderById(orderId);
    if (!order) throw new Error('Order not found');

    const RECOVERABLE_STATUSES = ['FAILED', 'EXPIRED', 'CANCELLED'];
    const isStuckPaid = order.status === 'PAID' && !order.txHash;

    if (isStuckPaid) {
        // Minor Bug Fix: Prevent race condition with Workers (Zombie timeout is 5m)
        // Admin shouldn't retry "Stuck" paid orders until at least 10 mins have passed.
        const MIN_RETRY_AGE_MS = 10 * 60 * 1000;
        const lastUpdate = new Date(order.updatedAt).getTime();
        if (Date.now() - lastUpdate < MIN_RETRY_AGE_MS) {
            throw new Error('Order is currently processing or too fresh to retry. Please wait 10 minutes.');
        }
    }

    if (!RECOVERABLE_STATUSES.includes(order.status) && !isStuckPaid) {
        throw new Error(`Order status ${order.status} not eligible for retry`);
    }

    logger.info({ orderId, adminId }, 'Admin initiating order retry...');

    // Audit Log
    await logAudit(adminId, 'RETRY_ORDER', orderId, { prevStatus: order.status }, ip);

    // 1. Re-lock Inventory
    if (RECOVERABLE_STATUSES.includes(order.status)) {
        const reserved = await inventoryService.reserveInventory(order.chain, order.symbol, order.amountToken);
        if (!reserved) throw new Error('Cannot retry: Insufficient Inventory now.');
    }

    // 2. Force status
    await prisma.order.update({
        where: { id: orderId },
        data: { status: 'PAID', txHash: null }
    });

    try {
        await ordersService.processOrder(orderId);
        return 'Retry initiated successfully';
    } catch (e: any) {
        throw new Error(`Retry execution failed: ${e.message}`);
    }
};

// --- OPS: FORCED SUCCESS ---
export const markOrderSuccess = async (orderId: string, txHash: string, adminId: string, ip?: string): Promise<void> => {
    const order = await ordersService.getOrderById(orderId);
    if (!order) throw new Error('Order not found');

    await prisma.order.update({
        where: { id: orderId },
        data: { status: 'SUCCESS', txHash: txHash, completedAt: new Date() }
    });

    await logAudit(adminId, 'FORCE_SUCCESS', orderId, { txHash }, ip);
    logger.info({ orderId, adminId }, 'Order manually marked as SUCCESS');
};

// Treasury withdrawal removed - manual wallet management only for security
