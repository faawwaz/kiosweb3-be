import { Router, Request, Response } from 'express';
import { prisma } from '../../libs/prisma.js';
import { logger } from '../../libs/logger.js';
import { authMiddleware } from '../../middlewares/auth.middleware.js';
import { adminMiddleware } from '../../middlewares/admin.middleware.js';
import { WalletManager } from '../blockchain/engine/WalletManager.js';
import { blockchainManager } from '../blockchain/engine/BlockchainManager.js';
import { ChainType } from '@prisma/client';
import * as adminService from './admin.service.js';
import * as vouchersService from '../vouchers/vouchers.service.js';

const router = Router();

// Apply Auth & Admin Check to ALL routes here
router.use(authMiddleware, adminMiddleware);

// ==========================================
// 📊 DASHBOARD & DATA LISTS
// ==========================================

/**
 * GET /api/admin/stats
 */
router.get('/stats', async (req: Request, res: Response) => {
    try {
        const stats = await adminService.getDashboardStats();
        res.json(stats);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

/**
 * GET /api/admin/users
 * Query: page, limit, search
 */
router.get('/users', async (req: Request, res: Response) => {
    try {
        const page = Number(req.query.page) || 0;
        const limit = Number(req.query.limit) || 20;
        const search = req.query.search as string;

        const result = await adminService.getUsersList(page, limit, search);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

/**
 * GET /api/admin/orders
 * Query: page, limit, status
 */
router.get('/orders', async (req: Request, res: Response) => {
    try {
        const page = Number(req.query.page) || 0;
        const limit = Number(req.query.limit) || 20;
        const status = req.query.status as string;

        const result = await adminService.getOrdersList(page, limit, status);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch orders' });
    }
});

// ==========================================
// 🎫 VOUCHER MANAGEMENT
// ==========================================

/**
 * GET /api/admin/vouchers
 */
router.get('/vouchers', async (req: Request, res: Response) => {
    try {
        const page = Number(req.query.page) || 0;
        const limit = Number(req.query.limit) || 20;
        const result = await vouchersService.getVouchers(page, limit);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch vouchers' });
    }
});

/**
 * POST /api/admin/vouchers
 */
router.post('/vouchers', async (req: Request, res: Response) => {
    try {
        const voucher = await vouchersService.createVoucher({
            code: req.body.code,
            value: Number(req.body.value),
            minAmount: Number(req.body.minAmount || 0),
            maxUsage: Number(req.body.maxUsage || 1), // Default 1 (Personal) or 1000 (Promo)
            expiresAt: req.body.expiresAt ? new Date(req.body.expiresAt) : undefined,
            userId: req.body.userId // Optional: Null for public promo
        });
        res.status(201).json(voucher);
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

/**
 * DELETE /api/admin/vouchers/:id
 */
router.delete('/vouchers/:id', async (req: Request, res: Response) => {
    try {
        await vouchersService.deleteVoucher(req.params.id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed delete' });
    }
});


// ==========================================
// ⛓️ ORDER OPERATIONS
// ==========================================

/**
 * POST /api/admin/orders/:id/retry
 * Retry a failed or stuck order (Re-reserve inventory & Send token)
 */
router.post('/orders/:id/retry', async (req: Request, res: Response) => {
    try {
        const adminId = (req as any).user.id;
        const result = await adminService.retryOrder(req.params.id, adminId, req.ip);
        res.json({ message: result });
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

/**
 * POST /api/admin/orders/:id/mark-success
 * Manually mark order as SUCCESS (e.g. manual transfer)
 */
router.post('/orders/:id/mark-success', async (req: Request, res: Response) => {
    try {
        const { txHash } = req.body;
        if (!txHash) return res.status(400).json({ error: 'TxHash is required' });

        const adminId = (req as any).user.id;
        await adminService.markOrderSuccess(req.params.id, txHash, adminId, req.ip);
        res.json({ message: 'Order manually marked as SUCCESS' });
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

// ==========================================
// 🏦 TREASURY MANAGEMENT
// ==========================================

/**
 * POST /api/admin/treasury/withdraw
 * Securely withdraw funds from Hot Wallet to Cold Wallet
 */
router.post('/treasury/withdraw', async (req: Request, res: Response) => {
    try {
        const { chain, toAddress, amount } = req.body;
        if (!chain || !toAddress || !amount) {
            return res.status(400).json({ error: 'Chain, toAddress, and amount required' });
        }

        const adminId = (req as any).user.id;
        const txHash = await adminService.withdrawTreasury(chain, toAddress, Number(amount), adminId, req.ip);

        res.json({
            message: 'Withdrawal successful',
            txHash
        });
    } catch (error: any) {
        logger.error({ error }, 'Treasury Withdraw Failed');
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// CHAIN & TOKEN MANAGEMENT (Unchanged)
// ==========================================

/**
 * GET /api/admin/chains
 */
router.get('/chains', async (req: Request, res: Response) => {
    try {
        const chains = await prisma.chain.findMany({
            orderBy: { createdAt: 'desc' },
            include: { _count: { select: { tokens: true } } }
        });
        const safeChains = chains.map(c => {
            const { encryptedPrivateKey, ...safe } = c;
            return safe;
        });
        return res.json(safeChains);
    } catch (error) {
        logger.error({ error }, 'Admin List Chains Error');
        return res.status(500).json({ error: 'Failed to fetch chains' });
    }
});

/**
 * POST /api/admin/chains
 */
router.post('/chains', async (req: Request, res: Response) => {
    try {
        const {
            name, slug, type, rpcUrl, explorerUrl, chainId,
            privateKey, extraConfig
        } = req.body;

        if (!name || !slug || !rpcUrl || !privateKey) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const existing = await prisma.chain.findUnique({ where: { slug } });
        if (existing) return res.status(400).json({ error: 'Chain Slug already exists' });

        const encryptedKey = await WalletManager.encrypt(privateKey);

        const newChain = await prisma.chain.create({
            data: {
                name, slug, type: (type as ChainType) || 'EVM',
                rpcUrl, explorerUrl: explorerUrl || '',
                chainId: chainId ? Number(chainId) : null,
                encryptedPrivateKey: encryptedKey,
                extraConfig: extraConfig || {},
                isActive: true
            }
        });

        logger.info('🔄 Admin added chain. Refreshing Engine...');
        await blockchainManager.refresh();

        return res.status(201).json({ message: 'Chain created successfully', id: newChain.id });

    } catch (error) {
        logger.error({ error }, 'Admin Create Chain Error');
        return res.status(500).json({ error: 'Failed to create chain' });
    }
});

/**
 * PATCH /api/admin/chains/:id
 */
router.patch('/chains/:id', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const { isActive, rpcUrl, explorerUrl } = req.body;

        await prisma.chain.update({
            where: { id },
            data: { isActive, rpcUrl, explorerUrl }
        });

        await blockchainManager.refresh();
        return res.json({ message: 'Chain updated' });
    } catch (error) {
        return res.status(500).json({ error: 'Update failed' });
    }
});


router.get('/tokens', async (req: Request, res: Response) => {
    try {
        const { chainId } = req.query;
        const where = chainId ? { chainId: String(chainId) } : {};

        const tokens = await prisma.token.findMany({
            where,
            include: { chain: { select: { name: true, slug: true } } },
            orderBy: { symbol: 'asc' }
        });

        return res.json(tokens);
    } catch (error) {
        return res.status(500).json({ error: 'Fetch tokens failed' });
    }
});


router.post('/tokens', async (req: Request, res: Response) => {
    try {
        const { chainId, symbol, name, address, isNative, decimals, markupPercent } = req.body;

        if (!chainId || !symbol || !name) {
            return res.status(400).json({ error: 'Missing requirements' });
        }

        await prisma.token.create({
            data: {
                chainId,
                symbol: symbol.toUpperCase(),
                name, address, isNative: !!isNative,
                decimals: Number(decimals || 18),
                markupPercent: Number(markupPercent || 5.0)
            }
        });

        await blockchainManager.refresh();
        return res.status(201).json({ message: 'Token added' });

    } catch (error) {
        logger.error({ error }, 'Add Token Error');
        return res.status(500).json({ error: 'Failed to add token' });
    }
});


router.patch('/tokens/:id', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const { isActive, markupPercent } = req.body;

        await prisma.token.update({
            where: { id },
            data: {
                isActive,
                markupPercent: markupPercent !== undefined ? Number(markupPercent) : undefined
            }
        });

        await blockchainManager.refresh();
        return res.json({ message: 'Token updated' });
    } catch (error) {
        return res.status(500).json({ error: 'Update token failed' });
    }
});

export default router;
