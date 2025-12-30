import { Router, Request, Response } from 'express';
import { authMiddleware } from '../../middlewares/auth.middleware.js';
import * as referralsService from './referrals.service.js';
import * as usersService from '../users/users.service.js';
import { authConfig } from '../../config/auth.js';
import { formatIdr } from '../../utils/price.js';
import { logger } from '../../libs/logger.js';

const router = Router();

/**
 * GET /api/referrals
 * Get user's referral info and stats
 */
router.get('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const user = await usersService.findUserById(userId);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const stats = await referralsService.getReferralStats(userId);

    return res.json({
      referralCode: user.referralCode,
      stats: {
        total: stats.total,
        valid: stats.valid,
        pending: stats.pending,
        totalEarned: stats.totalEarned,
        totalEarnedFormatted: formatIdr(stats.totalEarned),
      },
      rewards: {
        perReferral: authConfig.referral.rewardVoucherValue,
        perReferralFormatted: formatIdr(authConfig.referral.rewardVoucherValue),
        minOrdersRequired: authConfig.referral.minOrdersForValidation,
      },
    });
  } catch (error) {
    logger.error({ error }, 'Failed to get referral info');
    return res.status(500).json({ error: 'Failed to get referral info' });
  }
});

/**
 * GET /api/referrals/list
 * Get user's referrals list
 */
router.get('/list', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const referrals = await referralsService.getReferralsByReferrer(userId);

    return res.json({
      referrals: referrals.map((r) => ({
        id: r.id,
        isValid: r.isValid,
        rewardGiven: r.rewardGiven,
        createdAt: r.createdAt,
        validatedAt: r.validatedAt,
      })),
    });
  } catch (error) {
    logger.error({ error }, 'Failed to get referrals list');
    return res.status(500).json({ error: 'Failed to get referrals' });
  }
});

export default router;
