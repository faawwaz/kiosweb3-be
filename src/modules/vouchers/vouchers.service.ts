import { prisma } from '../../libs/prisma.js';
import { logger } from '../../libs/logger.js';
import { Voucher } from '@prisma/client';

export interface CreateVoucherInput {
  code: string;
  value: number;
  minAmount?: number;
  maxUsage?: number; // 1 for personal, 1000 for promo
  expiresAt?: Date;
  userId?: string; // Optional target user
}

// --- ADMIN CRUD ---

export const createVoucher = async (input: CreateVoucherInput): Promise<Voucher> => {
  // Check duplicate
  const existing = await prisma.voucher.findUnique({ where: { code: input.code } });
  if (existing) throw new Error('Voucher code already exists');

  return prisma.voucher.create({
    data: {
      code: input.code.toUpperCase(),
      value: input.value,
      minAmount: input.minAmount || 0,
      maxUsage: input.maxUsage || 1,
      userId: input.userId || null,
      expiresAt: input.expiresAt,
      isActive: true
    }
  });
};

export const getVouchers = async (page = 0, limit = 10): Promise<{ data: Voucher[], total: number }> => {
  const [data, total] = await Promise.all([
    prisma.voucher.findMany({
      skip: page * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { email: true, name: true } } } // Show who owns it if any
    }),
    prisma.voucher.count()
  ]);
  return { data, total };
};

export const deleteVoucher = async (id: string): Promise<void> => {
  await prisma.voucher.delete({ where: { id } });
  logger.info({ id }, 'Voucher deleted by Admin');
};

// --- LOGIC HELPER ---

/**
 * Validate and Increment Voucher Usage
 * Call this when Order is Created
 */
/**
 * Validate and RESERVE Voucher (Atomic Increment)
 * Call this BEFORE creating order.
 */
// Update signature to accept transaction
import { Prisma } from '@prisma/client'; // Import Prisma Types if not already there, wait, I need to check imports.
// src/components/vouchers/vouchers.service.ts already imports prisma directly. 
// I need to ensure Prisma namespace is available. 
// Standard import: import { Prisma, Voucher } from '@prisma/client';

export const validateAndReserveVoucher = async (
  code: string,
  userId: string,
  orderAmount: number,
  tx?: Prisma.TransactionClient // Optional Transaction
): Promise<Voucher> => {
  const db = tx || prisma;

  // 1. Fetch & Basic Check (Non-Atomic, but read from TX if provided!)
  const voucher = await db.voucher.findUnique({ where: { code } });

  if (!voucher) throw new Error('Voucher code invalid');
  if (!voucher.isActive) throw new Error('Voucher is inactive');
  if (voucher.expiresAt && voucher.expiresAt < new Date()) throw new Error('Voucher expired');
  if (voucher.usageCount >= voucher.maxUsage) throw new Error('Voucher quota exceeded');

  // Authorization Check
  if (voucher.userId && voucher.userId !== userId) throw new Error('This voucher is not for you');
  if (orderAmount < voucher.minAmount) throw new Error(`Minimum spending Rp ${voucher.minAmount.toLocaleString()}`);

  // DOUBLE DIPPING CHECK (For Public Vouchers)
  if (!voucher.userId && voucher.maxUsage > 1) {
    // Check 1: Already successfully used (voucher was "burned")
    const successfullyUsed = await db.order.findFirst({
      where: {
        userId: userId,
        voucherId: voucher.id,
        status: 'SUCCESS'  // Only SUCCESS counts as truly used
      }
    });

    if (successfullyUsed) {
      throw new Error('Anda sudah pernah menggunakan voucher ini. (Maks 1x per User)');
    }

    // Check 2: Currently has an active/ongoing order with this voucher
    // This prevents user from creating multiple orders with same voucher simultaneously
    // EXCLUDED: CANCELLED, EXPIRED, FAILED - these released the voucher back
    const activeOrder = await db.order.findFirst({
      where: {
        userId: userId,
        voucherId: voucher.id,
        status: { in: ['PENDING', 'PAID', 'PROCESSING'] }
      }
    });

    if (activeOrder) {
      throw new Error('Anda masih memiliki pesanan aktif dengan voucher ini. Selesaikan atau batalkan dulu.');
    }
  }

  // 2. ATOMIC UPDATE (Critical Barrier)
  // We increment usageCount ONLY IF usageCount < maxUsage.
  try {
    const updated = await db.voucher.update({
      where: {
        id: voucher.id,
        // Concurrency Control: Ensure it hasn't changed since read
        usageCount: { lt: voucher.maxUsage }
      },
      data: { usageCount: { increment: 1 } }
    });
    return updated;
  } catch (error) {
    // Prisma throws if 'where' condition fails (RecordsNotFound) -> Meaning Quota Full!
    throw new Error('Voucher quota ran out just now!');
  }
};

/**
 * Release Voucher Reservation (Race-condition safe)
 * Call this if Order Fails/Cancelled/Expired.
 * Uses atomic update with floor check to prevent negative usageCount.
 */
export const releaseVoucher = async (voucherId: string): Promise<void> => {
  try {
    // ATOMIC UPDATE: Only decrement if usageCount > 0
    // This prevents race conditions that could make usageCount negative
    const result = await prisma.voucher.updateMany({
      where: {
        id: voucherId,
        usageCount: { gt: 0 } // Only decrement if > 0
      },
      data: { usageCount: { decrement: 1 } }
    });

    if (result.count > 0) {
      logger.info({ voucherId }, 'Voucher usage released (Order Cancelled/Failed)');
    } else {
      logger.debug({ voucherId }, 'Voucher release skipped (already at 0 or not found)');
    }
  } catch (e) {
    logger.warn({ voucherId, error: e }, 'Failed to release voucher reservation');
  }
};

/**
 * Validates voucher without reserving it (READ ONLY).
 * Used for UI Preview in Bot/Web.
 */
export const validateVoucherPeek = async (code: string, userId: string, orderAmount: number): Promise<Voucher> => {
  const voucher = await prisma.voucher.findUnique({ where: { code } });

  if (!voucher) throw new Error('Kode voucher tidak ditemukan');
  if (!voucher.isActive) throw new Error('Voucher tidak aktif');
  if (voucher.expiresAt && voucher.expiresAt < new Date()) throw new Error('Voucher sudah kadaluarsa');
  if (voucher.usageCount >= voucher.maxUsage) throw new Error('Kuota voucher habis');

  // Personal Voucher Check
  if (voucher.userId && voucher.userId !== userId) {
    throw new Error('Voucher ini khusus untuk pengguna tertentu (Bukan milik Anda)');
  }

  // Min Spend Check
  if (orderAmount < voucher.minAmount) {
    throw new Error(`Minimal belanja Rp ${voucher.minAmount.toLocaleString('id-ID')}`);
  }

  return voucher;
};
// ... existing code ...

/**
 * Get all vouchers owned by a specific user
 */
export const getUserVouchers = async (userId: string): Promise<Voucher[]> => {
  return prisma.voucher.findMany({
    where: {
      userId,
      isActive: true
    },
    orderBy: { createdAt: 'desc' }
  });
};

/**
 * Expire (Deactivate) old vouchers
 */
export const expireVouchers = async (): Promise<number> => {
  const result = await prisma.voucher.updateMany({
    where: {
      isActive: true,
      expiresAt: { lt: new Date() }
    },
    data: { isActive: false }
  });

  if (result.count > 0) {
    logger.info({ count: result.count }, 'Expired old vouchers');
  }

  return result.count;
};

/**
 * Get available vouchers for a user (Active & Not fully used)
 */
export const getAvailableVouchers = async (userId: string): Promise<Voucher[]> => {
  const vouchers = await getUserVouchers(userId);
  return vouchers.filter(v => v.usageCount < v.maxUsage);
};

/**
 * Get total value of available vouchers
 */
export const getVoucherBalance = async (userId: string): Promise<number> => {
  const available = await getAvailableVouchers(userId);
  return available.reduce((acc, v) => acc + v.value, 0);
};

/**
 * Get voucher by code
 */
export const getVoucherByCode = async (code: string): Promise<Voucher | null> => {
  return prisma.voucher.findUnique({ where: { code } });
};
