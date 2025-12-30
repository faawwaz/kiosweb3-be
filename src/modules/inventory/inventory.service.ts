import { Decimal } from '@prisma/client/runtime/library';
import { Inventory, Prisma } from '@prisma/client';
import { prisma } from '../../libs/prisma.js';
import { logger } from '../../libs/logger.js';
import * as blockchainService from '../blockchain/blockchain.service.js';

/**
 * Get all inventory
 */
export const getAllInventory = async (): Promise<Inventory[]> => {
  return prisma.inventory.findMany();
};

/**
 * Get inventory by chain & symbol
 */
export const getInventory = async (
  chain: string,
  symbol: string
): Promise<Inventory | null> => {
  return prisma.inventory.findUnique({
    where: { chain_symbol: { chain, symbol } },
  });
};

/**
 * Get available balance (balance - reserved)
 */
export const getAvailableBalance = async (chain: string, symbol: string): Promise<Decimal> => {
  const inventory = await getInventory(chain, symbol);

  if (!inventory) {
    return new Decimal(0);
  }

  return inventory.balance.minus(inventory.reserved);
};

/**
 * Reserve inventory for an order
 * Uses row-level locking to prevent race conditions
 */
/**
 * Reserve inventory for an order
 * Uses row-level locking to prevent race conditions
 * Supports external transaction for atomic operations
 */
export const reserveInventory = async (
  chain: string,
  symbol: string,
  amount: Decimal,
  tx?: Prisma.TransactionClient // Support external transaction
): Promise<boolean> => {
  const db = tx || prisma; // Use passed transaction or default client

  try {
    // Note: We cannot use $queryRaw easily with a passed transaction client in all Prisma versions
    // consistently if it's not the interactive type.
    // However, for recent Prisma, it works.
    // BUT to be safe and "Senior", we should use standard Prisma API where possible.
    // Row locking in Prisma is tricky without raw query.
    // Let's stick to valid raw query usage on the passed client.

    // Lock the row
    const inventories = await db.$queryRaw<Inventory[]>`
        SELECT * FROM "inventory"
        WHERE chain = ${chain} AND symbol = ${symbol}
        FOR UPDATE
      `;

    const inventory = inventories[0];

    if (!inventory) {
      logger.warn({ chain, symbol }, 'Inventory not found during reserve');
      return false;
    }

    const available = new Decimal(inventory.balance).minus(inventory.reserved);

    if (available.lessThan(amount)) {
      logger.warn(
        { chain, symbol, available: available.toString(), requested: amount.toString() },
        'Insufficient inventory'
      );
      return false;
    }

    // Reserve the amount
    await db.inventory.update({
      where: { chain_symbol: { chain, symbol } },
      data: {
        reserved: { increment: amount },
      },
    });

    return true;

  } catch (error) {
    logger.error({ error, chain, symbol, amount: amount.toString() }, 'Failed to reserve inventory');
    throw error; // Throw so the parent transaction can rollback!
  }
};

/**
 * Release reserved inventory (on order cancel/failure)
 * Uses atomic update with floor check to prevent negative reserved
 */
export const releaseInventory = async (
  chain: string,
  symbol: string,
  amount: Decimal
): Promise<void> => {
  try {
    // Use raw query to ensure reserved doesn't go below 0
    // ATOMIC: Only decrement if reserved >= amount
    const result = await prisma.$executeRaw`
      UPDATE "inventory"
      SET reserved = reserved - ${amount}
      WHERE chain = ${chain}
        AND symbol = ${symbol}
        AND reserved >= ${amount}
    `;

    if (result === 0) {
      // Either inventory not found OR reserved < amount
      // Fallback: Set reserved to 0 if it somehow got negative or stuck
      const inventory = await getInventory(chain, symbol);
      if (inventory && inventory.reserved.greaterThan(0)) {
        // Partial release: release whatever is available
        const availableToRelease = Decimal.min(inventory.reserved, amount);
        if (availableToRelease.greaterThan(0)) {
          await prisma.inventory.update({
            where: { chain_symbol: { chain, symbol } },
            data: { reserved: { decrement: availableToRelease } }
          });
          logger.warn(
            { chain, symbol, requested: amount.toString(), released: availableToRelease.toString() },
            'Partial inventory release (requested > reserved)'
          );
        }
      } else if (inventory && inventory.reserved.lessThan(0)) {
        // CRITICAL: Reserved somehow went negative - reset to 0
        await prisma.inventory.update({
          where: { chain_symbol: { chain, symbol } },
          data: { reserved: new Decimal(0) }
        });
        logger.error({ chain, symbol, reserved: inventory.reserved.toString() }, 'CRITICAL: Negative reserved detected, reset to 0');
      }
    } else {
      logger.debug({ chain, symbol, amount: amount.toString() }, 'Inventory released');
    }
  } catch (error) {
    logger.error({ error, chain, symbol, amount: amount.toString() }, 'Failed to release inventory');
  }
};

/**
 * Deduct inventory after successful transfer
 */
export const deductInventory = async (
  chain: string,
  symbol: string,
  amount: Decimal,
  tx?: Prisma.TransactionClient
): Promise<void> => {
  const db = tx || prisma;

  // 1. Perform Reduction
  const updated = await db.inventory.update({
    where: { chain_symbol: { chain, symbol } },
    data: {
      balance: { decrement: amount },
      reserved: { decrement: amount },
    },
  });

  // 2. Negative Protection Check (Post-Action Alert)
  // We don't rollback because money is already sent (Phase 2),
  // but we MUST alert Admin if inventory goes negative (Drift/Phantom).
  if (updated.balance.lessThan(0) || updated.reserved.lessThan(0)) {
    logger.fatal(
      {
        chain,
        symbol,
        balance: updated.balance.toString(),
        reserved: updated.reserved.toString()
      },
      '🚨 CRITICAL: NEGATIVE INVENTORY DETECTED after deduction! Check Order/Wallet sync.'
    );
  }
};

/**
 * Update inventory balance (for syncing with hot wallet)
 */
export const updateInventoryBalance = async (
  chain: string,
  balance: Decimal,
  symbol: string // Symbol Must Be Explicit!
): Promise<Inventory> => {
  // In Dynamic system, we should know the symbol.
  // However, blockchainService.getHotWalletBalance usually returns Native Coin balance.
  // So usually this is "BNB", "ETH", etc.
  // The Monitor script needs to know the NATIVE symbol for that chain.

  // Quick Fix: Look up native symbol for this chain slug from DB?
  // Costly. Better pass it.
  // If not passed, we might assume ETH or rely on existing inventory record?

  // For now, let's upsert. If symbol is wrong, it creates new row (bad).
  // Monitor logic needs to fetch Native Token Symbol.

  return prisma.inventory.upsert({
    where: { chain_symbol: { chain, symbol } },
    update: { balance },
    create: { chain, symbol, balance, reserved: new Decimal(0) },
  });
};


/**
 * Initialize inventory for all active chains (Dynamic)
 */
export const initializeInventory = async (): Promise<void> => {
  const chains = await prisma.chain.findMany({
    where: { isActive: true },
    include: { tokens: { where: { isNative: true } } }
  });

  for (const chain of chains) {
    if (chain.tokens.length > 0) {
      const nativeSymbol = chain.tokens[0].symbol;
      const existing = await prisma.inventory.findUnique({
        where: { chain_symbol: { chain: chain.slug, symbol: nativeSymbol } }
      });

      if (!existing) {
        await prisma.inventory.create({
          data: {
            chain: chain.slug,
            symbol: nativeSymbol,
            balance: new Decimal(0),
            reserved: new Decimal(0)
          }
        });
        logger.info({ chain: chain.slug, symbol: nativeSymbol }, 'Inventory Initialized');
      }
    }
  }
};

/**
 * Sync inventory with blockchain
 */
export const syncInventory = async (chainSlug?: string): Promise<void> => {
  // If chainSlug is provided, sync that. Else sync all active.
  const where = chainSlug ? { slug: chainSlug } : { isActive: true };
  const chains = await prisma.chain.findMany({
    where,
    include: { tokens: { where: { isNative: true } } }
  });

  for (const chain of chains) {
    if (chain.tokens.length === 0) continue;
    const symbol = chain.tokens[0].symbol;

    try {
      const balance = await blockchainService.getHotWalletBalance(chain.slug);
      await updateInventoryBalance(chain.slug, balance, symbol);
      logger.debug({ chain: chain.slug, balance: balance.toString() }, 'Inventory synced');
    } catch (error) {
      logger.error({ error, chain: chain.slug }, 'Failed to sync inventory');
    }
  }
};
