import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { ChainId, supportedChains, chains } from '../../config/chains.js';
import { authMiddleware } from '../../middlewares/auth.middleware.js';
import * as pricingService from './pricing.service.js';
import { formatTokenAmount } from '../../utils/price.js';
import { logger } from '../../libs/logger.js';

const router = Router();

/**
 * GET /api/pricing
 * Get current prices for all chains
 */
router.get('/', async (_req: Request, res: Response) => {
  try {
    const prices = await Promise.all(
      supportedChains.map(async (chainId) => {
        const price = await pricingService.getTokenPrice(chainId);
        const chain = chains[chainId];
        return {
          chain: chainId,
          symbol: chain.symbol,
          name: chain.name,
          priceUsd: price.toString(),
        };
      })
    );

    const usdIdrRate = await pricingService.getUsdIdrRate();
    const markupPercent = await pricingService.getMarkupPercent();

    return res.json({
      prices,
      usdIdrRate,
      markupPercent,
    });
  } catch (error) {
    logger.error({ error }, 'Failed to get prices');
    return res.status(500).json({ error: 'Failed to get prices' });
  }
});

/**
 * GET /api/pricing/quote
 * Get a price quote
 */
router.get('/quote', async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      chain: z.enum(['bsc', 'eth', 'base']),
      amountIdr: z.string().transform(Number),
    });

    const { chain, amountIdr } = schema.parse(req.query);

    if (amountIdr < 50000) {
      return res.status(400).json({ error: 'Minimum amount is Rp 50.000' });
    }

    const quote = await pricingService.getQuote(chain as ChainId, amountIdr);

    // --- INVENTORY CHECK (Real-time Pre-flight) ---
    // User Request: "STOK YG BISA DI BELI TUH STOK PENDING"
    // We check `getAvailableBalance` which is (Balance - Reserved).

    // Dynamic import to avoid circular dependency
    const inventoryService = await import('../inventory/inventory.service.js');
    const availableToken = await inventoryService.getAvailableBalance(chain, quote.symbol);

    let inventoryStatus = 'AVAILABLE';
    let maxBuyIdr = 0;

    // Calculate Max Buy in IDR
    // Formula: AvailableToken * PriceUSD * RateIDR
    const maxBuyIdrRaw = availableToken.toNumber() * quote.tokenPriceUsd.toNumber() * quote.usdIdrRate;
    maxBuyIdr = Math.floor(maxBuyIdrRaw);

    if (quote.tokenAmount.greaterThan(availableToken)) {
      inventoryStatus = 'OUT_OF_STOCK';
    } else if (availableToken.lessThan(quote.tokenAmount.mul(2))) {
      // Optional: Warn if stock is low (less than 2x the order)
      inventoryStatus = 'LIMITED';
    }

    return res.json({
      chain,
      symbol: chains[chain as ChainId].symbol,
      amountIdr,
      tokenAmount: formatTokenAmount(quote.tokenAmount),
      tokenPriceUsd: quote.tokenPriceUsd.toString(),
      usdIdrRate: quote.usdIdrRate,
      markupPercent: quote.markupPercent,
      effectivePriceIdr: quote.effectivePriceIdr.toString(),
      // New Inventory Fields
      inventoryStatus,
      maxBuyIdr
    });
  } catch (error) {
    logger.error({ error }, 'Failed to get quote');
    return res.status(400).json({ error: 'Failed to get quote' });
  }
});

/**
 * POST /api/pricing/settings
 * Update pricing settings (admin only - simplified for now)
 */
router.post('/settings', authMiddleware, async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      usdIdrRate: z.number().positive().optional(),
      markupPercent: z.number().min(0).max(50).optional(),
    });

    const { usdIdrRate, markupPercent } = schema.parse(req.body);

    if (usdIdrRate !== undefined) {
      await pricingService.setUsdIdrRate(usdIdrRate);
    }

    if (markupPercent !== undefined) {
      await pricingService.setMarkupPercent(markupPercent);
    }

    return res.json({ success: true });
  } catch (error) {
    logger.error({ error }, 'Failed to update pricing settings');
    return res.status(400).json({ error: 'Failed to update settings' });
  }
});

export default router;
