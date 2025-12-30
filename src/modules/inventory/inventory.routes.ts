import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { Decimal } from '@prisma/client/runtime/library';
import { prisma } from '../../libs/prisma.js';
import { authMiddleware } from '../../middlewares/auth.middleware.js';
import { adminMiddleware } from '../../middlewares/admin.middleware.js';
import * as inventoryService from './inventory.service.js';
import { formatTokenAmount } from '../../utils/price.js';
import { logger } from '../../libs/logger.js';

const router = Router();

/**
 * GET /api/inventory
 * Get all inventory
 */
router.get('/', async (_req: Request, res: Response) => {
  try {
    const inventories = await inventoryService.getAllInventory();

    // Enrich with Chain Name if possible (Optional optimization)
    // For now simple dump is enough or map manually
    // Just return raw is fine for dynamic system

    const result = inventories.map(inv => ({
      chain: inv.chain,
      symbol: inv.symbol,
      balance: formatTokenAmount(inv.balance),
      reserved: formatTokenAmount(inv.reserved),
      available: formatTokenAmount(inv.balance.minus(inv.reserved))
    }));

    return res.json({ inventory: result });
  } catch (error) {
    logger.error({ error }, 'Failed to get inventory');
    return res.status(500).json({ error: 'Failed to get inventory' });
  }
});

/**
 * GET /api/inventory/:chain?symbol=ETH
 * Get inventory for specific chain & symbol
 */
router.get('/:chain', async (req: Request, res: Response) => {
  try {
    const chainSlug = req.params.chain;
    const symbolQuery = req.query.symbol as string;

    // Validate Chain Exists
    const chainConfig = await prisma.chain.findUnique({ where: { slug: chainSlug } });
    if (!chainConfig) {
      return res.status(404).json({ error: 'Chain not found' });
    }

    let targetSymbol = symbolQuery;

    // If no symbol, find Native Token
    if (!targetSymbol) {
      const nativeToken = await prisma.token.findFirst({
        where: { chainId: chainConfig.id, isNative: true }
      });
      targetSymbol = nativeToken ? nativeToken.symbol : 'ETH'; // fallback
    }

    const inventory = await inventoryService.getInventory(chainSlug, targetSymbol);

    if (!inventory) {
      return res.json({
        chain: chainSlug,
        symbol: targetSymbol,
        balance: '0',
        reserved: '0',
        available: '0',
      });
    }

    const available = inventory.balance.minus(inventory.reserved);

    return res.json({
      chain: chainSlug,
      symbol: inventory.symbol,
      balance: formatTokenAmount(inventory.balance),
      reserved: formatTokenAmount(inventory.reserved),
      available: formatTokenAmount(available),
    });
  } catch (error) {
    logger.error({ error }, 'Failed to get inventory');
    return res.status(500).json({ error: 'Failed to get inventory' });
  }
});

/**
 * POST /api/inventory/:chain
 * Update inventory balance (admin only)
 */
router.post('/:chain', authMiddleware, adminMiddleware, async (req: Request, res: Response) => {
  try {
    const chainSlug = req.params.chain;

    // Validate Chain
    const chainConfig = await prisma.chain.findUnique({ where: { slug: chainSlug } });
    if (!chainConfig) return res.status(404).json({ error: 'Chain not found' });

    const schema = z.object({
      balance: z.string().transform((v) => new Decimal(v)),
      symbol: z.string().optional()
    });

    const { balance, symbol } = schema.parse(req.body);

    const targetSymbol = symbol || (await prisma.token.findFirst({
      where: { chainId: chainConfig.id, isNative: true }
    }))?.symbol || 'ETH';

    const inventory = await inventoryService.updateInventoryBalance(chainSlug, balance, targetSymbol);

    return res.json({
      chain: chainSlug,
      symbol: inventory.symbol,
      balance: formatTokenAmount(inventory.balance),
      reserved: formatTokenAmount(inventory.reserved),
    });
  } catch (error) {
    logger.error({ error }, 'Failed to update inventory');
    return res.status(400).json({ error: 'Failed to update inventory' });
  }
});

/**
 * POST /api/inventory/sync
 * Force sync all inventory with blockchain
 */
router.post('/sync', authMiddleware, adminMiddleware, async (_req: Request, res: Response) => {
  try {
    await inventoryService.syncInventory();
    return res.json({ message: 'Inventory sync started' });
  } catch (error) {
    logger.error({ error }, 'Failed to sync inventory');
    return res.status(500).json({ error: 'Failed to sync inventory' });
  }
});

export default router;
