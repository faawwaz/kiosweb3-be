import { Router, Request, Response } from 'express';
import { authMiddleware } from '../../middlewares/auth.middleware.js';
import * as vouchersService from './vouchers.service.js';
import { formatIdr } from '../../utils/price.js';
import { logger } from '../../libs/logger.js';

const router = Router();

/**
 * GET /api/vouchers
 * Get user's vouchers
 */
router.get('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const vouchers = await vouchersService.getUserVouchers(userId);
    const balance = await vouchersService.getVoucherBalance(userId);

    return res.json({
      vouchers: vouchers.map((v) => ({
        id: v.id,
        code: v.code,
        value: v.value,
        valueFormatted: formatIdr(v.value),
        usedAt: v.usedAt,
        expiresAt: v.expiresAt,
        createdAt: v.createdAt,
      })),
      balance,
      balanceFormatted: formatIdr(balance),
    });
  } catch (error) {
    logger.error({ error }, 'Failed to get vouchers');
    return res.status(500).json({ error: 'Failed to get vouchers' });
  }
});

/**
 * GET /api/vouchers/available
 * Get available vouchers for user
 */
router.get('/available', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const vouchers = await vouchersService.getAvailableVouchers(userId);

    return res.json({
      vouchers: vouchers.map((v) => ({
        id: v.id,
        code: v.code,
        value: v.value,
        valueFormatted: formatIdr(v.value),
        expiresAt: v.expiresAt,
      })),
    });
  } catch (error) {
    logger.error({ error }, 'Failed to get available vouchers');
    return res.status(500).json({ error: 'Failed to get vouchers' });
  }
});

/**
 * GET /api/vouchers/:code
 * Get voucher by code
 */
router.get('/:code', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const voucher = await vouchersService.getVoucherByCode(req.params.code);

    if (!voucher) {
      return res.status(404).json({ error: 'Voucher not found' });
    }

    if (voucher.userId !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    return res.json({
      voucher: {
        id: voucher.id,
        code: voucher.code,
        value: voucher.value,
        valueFormatted: formatIdr(voucher.value),
        usedAt: voucher.usedAt,
        expiresAt: voucher.expiresAt,
        createdAt: voucher.createdAt,
      },
    });
  } catch (error) {
    logger.error({ error }, 'Failed to get voucher');
    return res.status(500).json({ error: 'Failed to get voucher' });
  }
});

export default router;
