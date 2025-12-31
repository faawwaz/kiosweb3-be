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

// ==========================================
// 🛡️ SECURITY: Input Validation Helpers
// ==========================================

/**
 * Validate RPC URL to prevent SSRF attacks
 * - Must be HTTPS (except localhost for dev)
 * - Cannot be internal/private IPs
 * - Must be a valid URL format
 */
const validateRpcUrl = (url: string): { valid: boolean; error?: string } => {
    try {
        const parsed = new URL(url);

        // Must be http or https
        if (!['http:', 'https:'].includes(parsed.protocol)) {
            return { valid: false, error: 'RPC URL must use HTTP or HTTPS protocol' };
        }

        // Block internal/private IP ranges (SSRF prevention)
        const hostname = parsed.hostname.toLowerCase();
        const blockedPatterns = [
            /^localhost$/i,
            /^127\./,
            /^10\./,
            /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
            /^192\.168\./,
            /^169\.254\./,
            /^0\./,
            /^::1$/,
            /^fc00:/i,
            /^fe80:/i,
            /\.local$/i,
            /\.internal$/i,
            /\.corp$/i,
            /\.lan$/i,
        ];

        for (const pattern of blockedPatterns) {
            if (pattern.test(hostname)) {
                return { valid: false, error: 'RPC URL cannot point to internal/private networks' };
            }
        }

        // Must use HTTPS in production (allow HTTP for known testnets only)
        const allowedHttpHosts = ['localhost', '127.0.0.1'];
        if (parsed.protocol === 'http:' && !allowedHttpHosts.includes(hostname)) {
            return { valid: false, error: 'RPC URL must use HTTPS for security' };
        }

        return { valid: true };
    } catch {
        return { valid: false, error: 'Invalid URL format' };
    }
};

/**
 * Validate chain slug format
 */
const validateSlug = (slug: string): boolean => {
    return /^[a-z0-9-]+$/.test(slug) && slug.length >= 2 && slug.length <= 20;
};

/**
 * Validate chain name
 */
const validateName = (name: string): boolean => {
    return typeof name === 'string' && name.length >= 2 && name.length <= 50;
};

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
// CHAIN & TOKEN MANAGEMENT
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

        // Validate required fields
        if (!name || !slug || !rpcUrl || !privateKey) {
            return res.status(400).json({ error: 'Missing required fields: name, slug, rpcUrl, privateKey' });
        }

        // Validate name format
        if (!validateName(name)) {
            return res.status(400).json({ error: 'Name must be 2-50 characters' });
        }

        // Validate slug format (lowercase alphanumeric with hyphens)
        if (!validateSlug(slug.toLowerCase())) {
            return res.status(400).json({ error: 'Slug must be 2-20 lowercase alphanumeric characters with hyphens only' });
        }

        // Validate RPC URL (SSRF prevention)
        const rpcValidation = validateRpcUrl(rpcUrl);
        if (!rpcValidation.valid) {
            return res.status(400).json({ error: rpcValidation.error });
        }

        // Validate explorer URL if provided
        if (explorerUrl) {
            const explorerValidation = validateRpcUrl(explorerUrl);
            if (!explorerValidation.valid) {
                return res.status(400).json({ error: `Explorer URL: ${explorerValidation.error}` });
            }
        }

        // Validate private key format (basic hex check)
        const pkClean = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey;
        if (!/^[a-fA-F0-9]{64}$/.test(pkClean)) {
            return res.status(400).json({ error: 'Invalid private key format' });
        }

        const existing = await prisma.chain.findUnique({ where: { slug: slug.toLowerCase() } });
        if (existing) return res.status(400).json({ error: 'Chain Slug already exists' });

        const encryptedKey = await WalletManager.encrypt(privateKey);

        const newChain = await prisma.chain.create({
            data: {
                name: name.trim(),
                slug: slug.toLowerCase().trim(),
                type: (type as ChainType) || 'EVM',
                rpcUrl: rpcUrl.trim(),
                explorerUrl: explorerUrl?.trim() || '',
                chainId: chainId ? Number(chainId) : null,
                encryptedPrivateKey: encryptedKey,
                extraConfig: extraConfig || {},
                isActive: true
            }
        });

        logger.info({ chainId: newChain.id, slug: newChain.slug }, 'Admin added chain. Refreshing Engine...');
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

        // Validate RPC URL if provided (SSRF prevention)
        if (rpcUrl) {
            const rpcValidation = validateRpcUrl(rpcUrl);
            if (!rpcValidation.valid) {
                return res.status(400).json({ error: rpcValidation.error });
            }
        }

        // Validate explorer URL if provided
        if (explorerUrl) {
            const explorerValidation = validateRpcUrl(explorerUrl);
            if (!explorerValidation.valid) {
                return res.status(400).json({ error: `Explorer URL: ${explorerValidation.error}` });
            }
        }

        await prisma.chain.update({
            where: { id },
            data: {
                isActive,
                rpcUrl: rpcUrl?.trim(),
                explorerUrl: explorerUrl?.trim()
            }
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
