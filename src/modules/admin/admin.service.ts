import { prisma } from '../../libs/prisma.js';
import { logger } from '../../libs/logger.js';
import * as ordersService from '../orders/orders.service.js';
import * as inventoryService from '../inventory/inventory.service.js';
import * as blockchainService from '../blockchain/blockchain.service.js';
import { Decimal } from '@prisma/client/runtime/library.js';

import { redis } from '../../libs/redis.js';

const DASHBOARD_CACHE_KEY = 'admin:dashboard:stats';
const DASHBOARD_CACHE_TTL = 120; // Issue #30: Reduced to 2 minutes from 5

// --- CACHE INVALIDATION (Issue #30) ---
export const invalidateDashboardCache = async (): Promise<void> => {
    await redis.del(DASHBOARD_CACHE_KEY);
    logger.debug('Dashboard cache invalidated');
};

// --- STATS (CACHED) ---
export const getDashboardStats = async (forceRefresh = false) => {
    // Option to force refresh (e.g., after admin action)
    if (!forceRefresh) {
        const cached = await redis.get(DASHBOARD_CACHE_KEY);
        if (cached) return JSON.parse(cached);
    }

    // Heavy Computation
    const [totalOrders, successOrders, failedOrders, pendingOrders] = await Promise.all([
        prisma.order.count(),
        prisma.order.count({ where: { status: 'SUCCESS' } }),
        prisma.order.count({ where: { status: 'FAILED' } }),
        prisma.order.count({ where: { status: 'PENDING' } })
    ]);

    const revenue = await prisma.order.aggregate({
        where: { status: 'SUCCESS' },
        _sum: { amountIdr: true }
    });

    // Group by status
    const byStatus = await prisma.order.groupBy({
        by: ['status'],
        _count: true
    });

    // Group by Chain (Popularity)
    const byChain = await prisma.order.groupBy({
        by: ['chain'],
        _count: true,
        where: { status: 'SUCCESS' }
    });

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
            status: byStatus,
            chain: byChain
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

// --- TREASURY ---
export const withdrawTreasury = async (chain: string, toAddress: string, amount: number, adminId: string, ip?: string): Promise<string> => {
    if (!blockchainService.isValidAddress(toAddress)) throw new Error('Invalid address');

    const amountDec = new Decimal(amount);
    const txHash = await blockchainService.sendNativeToken(chain, toAddress, amountDec);

    await logAudit(adminId, 'WITHDRAW_TREASURY', chain, { toAddress, amount, txHash }, ip);
    logger.warn({ chain, toAddress, amount, txHash, adminId }, 'Treasury Withdrawal Executed');

    return txHash;
};
