import { User, Prisma } from '@prisma/client';
import { prisma } from '../../libs/prisma.js';
import { generateReferralCode } from '../../utils/crypto.js';

export interface CreateUserInput {
  email?: string;
  telegramId?: string;
  telegramUsername?: string;
  referredByCode?: string;
  name?: string;
  password?: string;
  googleId?: string;
}

export interface UpdateUserInput {
  email?: string;
  telegramId?: string;
  telegramUsername?: string;
  name?: string;
}

// ... existing code ...

/**
 * Find user by ID
 */
export const findUserById = async (id: string): Promise<User | null> => {
  return prisma.user.findUnique({ where: { id } });
};

/**
 * Find user by Telegram ID
 */
export const findUserByTelegramId = async (telegramId: string): Promise<User | null> => {
  return prisma.user.findUnique({ where: { telegramId } });
};

/**
 * Find user by email
 */
export const findUserByEmail = async (email: string): Promise<User | null> => {
  return prisma.user.findUnique({ where: { email } });
};

/**
 * Find user by referral code
 */
export const findUserByReferralCode = async (referralCode: string): Promise<User | null> => {
  return prisma.user.findUnique({ where: { referralCode } });
};

/**
 * Create a new user
 */
export const createUser = async (input: CreateUserInput): Promise<User> => {
  // Generate unique referral code
  let referralCode = generateReferralCode();
  let attempts = 0;
  const maxAttempts = 10;

  while (attempts < maxAttempts) {
    const existing = await findUserByReferralCode(referralCode);
    if (!existing) break;
    referralCode = generateReferralCode();
    attempts++;
  }

  // Find referrer if code provided
  let referredById: string | undefined;
  if (input.referredByCode) {
    const referrer = await findUserByReferralCode(input.referredByCode);
    if (referrer) {
      referredById = referrer.id;
    }
  }

  // Explicitly construct data object to avoid TS issues with optional fields
  const userData: any = {
    email: input.email,
    telegramId: input.telegramId,
    telegramUsername: input.telegramUsername,
    referralCode,
    referredById,
    name: input.name,
    password: input.password,
    googleId: input.googleId,
  };

  if (input.email) {
    userData.email = input.email;
  }

  const user = await prisma.user.create({
    data: userData,
  });

  // Create referral record if referred
  if (referredById) {
    await prisma.referral.create({
      data: {
        referrerId: referredById,
        refereeId: user.id,
      },
    });
  }

  return user;
};
// getOrCreateUserByTelegram removed - replaced by auth.handler logic

/**
 * Update user
 */
export const updateUser = async (
  id: string,
  input: UpdateUserInput
): Promise<User> => {
  return prisma.user.update({
    where: { id },
    data: input,
  });
};

/**
 * Link Telegram to existing user
 */
export const linkTelegramToUser = async (
  userId: string,
  telegramId: string,
  telegramUsername?: string
): Promise<User> => {
  // Check if telegram is already linked to another user
  const existing = await findUserByTelegramId(telegramId);
  if (existing && existing.id !== userId) {
    throw new Error('Telegram already linked to another account');
  }

  return prisma.user.update({
    where: { id: userId },
    data: {
      telegramId,
      telegramUsername,
    },
  });
};

/**
 * Merge source user into target user (e.g. Merge Bot User into Web User)
 * Moves all relations and data to target user, then deletes source user.
 */
export const mergeUsers = async (sourceUserId: string, targetUserId: string): Promise<User> => {
  const sourceUser = await findUserById(sourceUserId);
  const targetUser = await findUserById(targetUserId);

  if (!sourceUser || !targetUser) {
    throw new Error('Source or Target user not found');
  }

  return prisma.$transaction(async (tx) => {
    // 1. Move Telegram Identity to Target
    if (sourceUser.telegramId) {
      // Ensure target doesn't key collision
      await tx.user.update({
        where: { id: targetUserId },
        data: {
          telegramId: sourceUser.telegramId,
          telegramUsername: sourceUser.telegramUsername || undefined,
        },
      });
    }

    // 2. Move ReferralCode if target doesn't have one? 
    // Usually target (Web) already has one. If not, take source's.
    // But referralCode is unique. We just discard source's referralCode unless target needs it.

    // 3. Move Referrals (Downline)
    await tx.referral.updateMany({
      where: { referrerId: sourceUserId },
      data: { referrerId: targetUserId },
    });

    // 4. Move Orders
    await tx.order.updateMany({
      where: { userId: sourceUserId },
      data: { userId: targetUserId },
    });

    // 5. Move Vouchers
    await tx.voucher.updateMany({
      where: { userId: sourceUserId },
      data: { userId: targetUserId },
    });

    // 6. Move Inventory/Balances? (If we had user balances)
    // Currently inventory is global/admin. But if we had UserWallet, we would move it.

    // 7. Delete Source User
    await tx.user.delete({
      where: { id: sourceUserId },
    });

    return tx.user.findUniqueOrThrow({ where: { id: targetUserId } });
  });
};

/**
 * Get user stats
 */
export const getUserStats = async (userId: string) => {
  const [orderCount, referralCount, voucherBalance] = await Promise.all([
    prisma.order.count({
      where: { userId, status: 'SUCCESS' },
    }),
    prisma.referral.count({
      where: { referrerId: userId, isValid: true },
    }),
    prisma.voucher.aggregate({
      where: { userId, usedAt: null },
      _sum: { value: true },
    }),
  ]);

  return {
    totalOrders: orderCount,
    validReferrals: referralCount,
    availableVoucherBalance: voucherBalance._sum.value || 0,
  };
};
