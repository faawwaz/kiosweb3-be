import { Referral } from '@prisma/client';
import { prisma } from '../../libs/prisma.js';
import { logger } from '../../libs/logger.js';
import { authConfig } from '../../config/auth.js';
import * as vouchersService from '../vouchers/vouchers.service.js';
import * as notificationsService from '../notifications/notifications.service.js';

export interface ReferralStats {
  total: number;
  valid: number;
  pending: number;
  totalEarned: number;
}

/**
 * Get referral by referee ID
 */
export const getReferralByReferee = async (
  refereeId: string
): Promise<Referral | null> => {
  return prisma.referral.findUnique({ where: { refereeId } });
};

/**
 * Get referrals by referrer
 */
export const getReferralsByReferrer = async (
  referrerId: string
): Promise<Referral[]> => {
  return prisma.referral.findMany({
    where: { referrerId },
    orderBy: { createdAt: 'desc' },
  });
};

/**
 * Get referral stats for a user
 */
export const getReferralStats = async (userId: string): Promise<ReferralStats> => {
  const referrals = await getReferralsByReferrer(userId);

  const total = referrals.length;
  const valid = referrals.filter((r) => r.isValid).length;
  const pending = total - valid;
  const totalEarned = valid * authConfig.referral.rewardVoucherValue;

  return { total, valid, pending, totalEarned };
};

/**
 * Validate a referral (when referee completes first order)
 *
 * This is the SINGLE SOURCE OF TRUTH for referral validation and rewards.
 * Called from: orders.service.processReferralReward() and referral.worker
 */
export const validateReferral = async (refereeId: string): Promise<void> => {
  const referral = await getReferralByReferee(refereeId);

  if (!referral) {
    logger.debug({ refereeId }, 'No referral found for user');
    return;
  }

  // IDEMPOTENCY CHECK: If already valid AND reward given, nothing to do
  if (referral.isValid && referral.rewardGiven) {
    logger.debug({ referralId: referral.id }, 'Referral already validated and rewarded');
    return;
  }

  // Check if referee has completed enough orders
  const orderCount = await prisma.order.count({
    where: {
      userId: refereeId,
      status: 'SUCCESS',
    },
  });

  if (orderCount < authConfig.referral.minOrdersForValidation) {
    logger.debug(
      { refereeId, orderCount },
      'Not enough orders to validate referral'
    );
    return;
  }

  // ATOMIC UPDATE: Only update if not already valid (prevents race condition)
  // Using updateMany with condition for atomic check-and-set
  if (!referral.isValid) {
    const updateResult = await prisma.referral.updateMany({
      where: {
        id: referral.id,
        isValid: false  // Only update if still invalid
      },
      data: {
        isValid: true,
        validatedAt: new Date(),
      },
    });

    if (updateResult.count > 0) {
      logger.info(
        { referralId: referral.id, referrerId: referral.referrerId },
        'Referral validated'
      );
    }
  }

  // Grant voucher to referrer if not already given
  // Re-fetch to get latest state after potential concurrent updates
  const updatedReferral = await prisma.referral.findUnique({
    where: { id: referral.id }
  });

  if (updatedReferral && !updatedReferral.rewardGiven) {
    await grantReferralReward(referral.id);
  }
};

/**
 * Grant referral reward (voucher) to referrer
 *
 * ATOMIC: Uses updateMany with condition to prevent double rewards
 * from concurrent calls (e.g., order processing + worker running simultaneously)
 */
export const grantReferralReward = async (referralId: string): Promise<void> => {
  // ATOMIC LOCK: Mark reward as given FIRST to prevent double-grant
  // Only proceeds if rewardGiven was false
  const lockResult = await prisma.referral.updateMany({
    where: {
      id: referralId,
      rewardGiven: false  // Only if not already given
    },
    data: { rewardGiven: true },
  });

  // If count is 0, another process already granted the reward
  if (lockResult.count === 0) {
    logger.debug({ referralId }, 'Referral reward already granted (concurrent protection)');
    return;
  }

  // Now we own the reward grant - fetch full referral data
  const referral = await prisma.referral.findUnique({
    where: { id: referralId },
  });

  if (!referral) {
    logger.warn({ referralId }, 'Referral not found after lock - should not happen');
    return;
  }

  try {
    // Create voucher for referrer
    const code = `REF-${referral.referrerId.slice(-4)}-${Date.now().toString().slice(-4)}`;

    const voucher = await vouchersService.createVoucher({
      code,
      userId: referral.referrerId,
      value: authConfig.referral.rewardVoucherValue,
      expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000) // 90 days expiry
    });

    logger.info(
      { referralId, referrerId: referral.referrerId, voucherId: voucher.id },
      'Referral reward voucher created'
    );

    // CHECK FOR BONUS: Every 20 valid referrals, grant bonus voucher
    const validCount = await prisma.referral.count({
      where: { referrerId: referral.referrerId, isValid: true }
    });

    if (validCount > 0 && validCount % 20 === 0) {
      const bonusCode = `BONUS-${referral.referrerId.slice(-4)}-${validCount}`;

      try {
        const bonusVoucher = await vouchersService.createVoucher({
          code: bonusCode,
          userId: referral.referrerId,
          value: authConfig.referral.rewardVoucherValue, // Same value as regular
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 days expiry
        });

        logger.info(
          { referrerId: referral.referrerId, validCount, bonusCode },
          'Milestone bonus voucher granted (every 20 referrals)'
        );

        // Notify about bonus
        await notificationsService.notifyVoucherReceived(
          referral.referrerId,
          authConfig.referral.rewardVoucherValue,
          `🎉 BONUS! Selamat, Anda sudah mengajak ${validCount} teman!`
        );
      } catch (bonusErr) {
        // Bonus creation failed (maybe code collision) - log but don't fail
        logger.warn({ error: bonusErr, referrerId: referral.referrerId }, 'Failed to create bonus voucher');
      }
    }

    // Notify referrer about the regular reward
    await notificationsService.notifyVoucherReceived(
      referral.referrerId,
      authConfig.referral.rewardVoucherValue,
      'Referral reward - Thank you for referring a friend!'
    );

  } catch (error) {
    // If voucher creation fails, we should ideally rollback rewardGiven
    // But for simplicity, log and let admin handle manually
    logger.error({ error, referralId, referrerId: referral.referrerId }, 'Failed to create referral reward voucher');
    throw error;
  }
};

/**
 * Check and validate pending referrals
 */
export const checkPendingReferrals = async (): Promise<number> => {
  const pendingReferrals = await prisma.referral.findMany({
    where: { isValid: false },
  });

  let validatedCount = 0;

  for (const referral of pendingReferrals) {
    try {
      await validateReferral(referral.refereeId);

      // Check if it was validated
      const updated = await prisma.referral.findUnique({
        where: { id: referral.id },
      });

      if (updated?.isValid) {
        validatedCount++;
      }
    } catch (error) {
      logger.error({ error, referralId: referral.id }, 'Failed to validate referral');
    }
  }

  if (validatedCount > 0) {
    logger.info({ validatedCount }, 'Validated pending referrals');
  }

  return validatedCount;
};
