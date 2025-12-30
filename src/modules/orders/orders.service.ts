import { Decimal } from '@prisma/client/runtime/library';
import { Order, OrderStatus, Prisma } from '@prisma/client';
import { prisma } from '../../libs/prisma.js';
import { logger } from '../../libs/logger.js';
import * as inventoryService from '../inventory/inventory.service.js';
import * as paymentsService from '../payments/payments.service.js';
import * as blockchainService from '../blockchain/blockchain.service.js';
import { TxBroadcastedError } from '../blockchain/blockchain.service.js';
import * as notificationsService from '../notifications/notifications.service.js';
import * as voucherService from '../vouchers/vouchers.service.js';
import { queueOrderProcessing } from '../../workers/order.worker.js';
import { orderQueue } from '../../workers/index.js';
import { PaymentResult } from '../payments/payments.service.js';

const formatIdr = (val: number) => {
  return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(val);
};

export interface CreateOrderInput {
  userId: string;
  chain: string;
  symbol: string;
  amountIdr: number;
  amountToken: Decimal;
  markupPercent: number;
  walletAddress: string;
  voucherCode?: string; // Input Code
}

/**
 * Create a new order
 */
export const createOrder = async (input: CreateOrderInput): Promise<Order> => {
  return prisma.$transaction(async (tx) => {
    // 1. Check pending limit
    const pendingCount = await tx.order.count({
      where: { userId: input.userId, status: 'PENDING' }
    });
    if (pendingCount >= 1) throw new Error('You have a pending order.');

    // 2. Reserve inventory (Atomic within TX)
    const reserved = await inventoryService.reserveInventory(input.chain, input.symbol, input.amountToken, tx);
    if (!reserved) throw new Error('Insufficient inventory');

    // 3. Reserve Voucher (If any)
    let voucherId = null;
    let finalAmountIdr = input.amountIdr;

    if (input.voucherCode) {
      try {
        // Pass tx to voucher service for atomicity
        const voucher = await voucherService.validateAndReserveVoucher(input.voucherCode, input.userId, input.amountIdr, tx);
        voucherId = voucher.id;
        finalAmountIdr = Math.max(0, input.amountIdr - voucher.value); // Apply Discount
      } catch (e: any) {
        // No need to manually rollback inventory, the TX will abort and rollback everything automatically!
        throw e;
      }
    }

    const order = await tx.order.create({
      data: {
        userId: input.userId,
        chain: input.chain,
        symbol: input.symbol,
        amountIdr: finalAmountIdr, // Discounted Price
        amountToken: input.amountToken, // Token Amount (Based on Original Price)
        markupPercent: input.markupPercent,
        walletAddress: input.walletAddress,
        voucherId: voucherId,
        status: 'PENDING',
      },
    });

    logger.info({ orderId: order.id, voucherId }, 'Order created');
    return order;
  });
};

/**
 * Get order by ID
 */
export const getOrderById = async (id: string): Promise<Order | null> => {
  return prisma.order.findUnique({ where: { id } });
};

/**
 * Get order by Midtrans ID
 */
export const getOrderByMidtransId = async (
  midtransId: string
): Promise<Order | null> => {
  return prisma.order.findUnique({ where: { midtransId } });
};

/**
 * Get user orders with pagination
 */
export const getUserOrders = async (
  userId: string,
  page: number = 0,
  limit: number = 10
): Promise<{ orders: Order[]; total: number }> => {
  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      skip: page * limit,
      take: limit,
    }),
    prisma.order.count({ where: { userId } }),
  ]);

  return { orders, total };
};

/**
 * Create payment for order
 */
/**
 * Create payment for order
 */


export const createPayment = async (orderId: string, method: 'QRIS' | 'VA'): Promise<PaymentResult> => {
  const order = await getOrderById(orderId);

  if (!order) {
    throw new Error('Order not found');
  }

  if (order.status !== 'PENDING') {
    throw new Error('Order is not pending');
  }

  // Strategy Pattern
  let result: PaymentResult;
  if (method === 'QRIS') {
    result = await paymentsService.createQrisPayment(order);
  } else {
    result = await paymentsService.createSnapBankPayment(order);
  }

  await prisma.order.update({
    where: { id: orderId },
    data: {
      midtransId: result.orderId,
      paymentUrl: result.paymentUrl,
      paymentMethod: method,
      feeIdr: result.fee,
      totalPay: result.total
    },
  });

  return result;
};

/**
 * Handle payment success
 */
export const handlePaymentSuccess = async (orderId: string): Promise<void> => {
  // Atomic Update: Only update if status is PENDING
  const updateResult = await prisma.order.updateMany({
    where: {
      id: orderId,
      status: 'PENDING'
    },
    data: {
      status: 'PAID',
      paidAt: new Date(),
    },
  });

  if (updateResult.count === 0) {
    logger.warn({ orderId }, 'Order already processed or not found');
    return;
  }

  logger.info({ orderId }, 'Order marked as paid');

  // Process the order (send tokens) - ASYNC VIA WORKER
  await queueOrderProcessing(orderQueue, orderId);
};

/**
 * Manually sync payment status with Midtrans
 */
export const syncPayment = async (orderId: string): Promise<string> => {
  const order = await getOrderById(orderId);
  if (!order) throw new Error('Order not found');
  if (!order.midtransId) throw new Error('No payment info found');

  // Get Status from Midtrans
  const status = await paymentsService.getTransactionStatus(order.midtransId);

  // If succes -> Handle Success
  if (paymentsService.isTransactionSuccess(status)) {
    await handlePaymentSuccess(orderId);
    return 'SUCCESS';
  } else if (paymentsService.isTransactionFailed(status)) {
    // Handle fail if needed, or just let cron do it
    return 'FAILED';
  }

  return status.transaction_status;
};

/**
 * Process order - send tokens (Production Grade with Double-Spend Prevention)
 *
 * Critical invariants:
 * 1. Only ONE worker can process an order (atomic state transition)
 * 2. If txHash exists, money was sent - NEVER retry blockchain call
 * 3. State transitions: PAID → PROCESSING → SUCCESS (or FAILED)
 */
export const processOrder = async (orderId: string): Promise<void> => {
  // ============================================================
  // PHASE 0: ATOMIC LOCK ACQUISITION (Prevents Double-Spend)
  // ============================================================
  //
  // We use updateMany with strict conditions to atomically:
  // 1. Check status is PAID (not PROCESSING, SUCCESS, etc.)
  // 2. Check txHash is NULL (no blockchain tx sent yet)
  // 3. Transition to PROCESSING
  //
  // If any condition fails, count=0 and we handle accordingly.
  // This is the ONLY safe way to prevent race conditions.

  // ============================================================
  // PHASE 0: ATOMIC LOCK ACQUISITION (Prevents Double-Spend)
  // ============================================================

  let lockAcquired = false;
  let attempts = 0;
  const MAX_LOCK_ATTEMPTS = 3;

  while (!lockAcquired && attempts < MAX_LOCK_ATTEMPTS) {
    attempts++;
    try {
      const lockResult = await prisma.order.updateMany({
        where: {
          id: orderId,
          status: 'PAID',
          txHash: null,
        },
        data: {
          status: 'PROCESSING',
          updatedAt: new Date(),
        },
      });

      if (lockResult.count > 0) {
        lockAcquired = true;
        break; // Succcess
      }

      // If lock failed, analyze WHY
      const order = await getOrderById(orderId);
      if (!order) throw new Error(`Order ${orderId} not found`);

      // Case A: Already SUCCESS (Idempotent)
      if (order.status === 'SUCCESS') {
        logger.info({ orderId }, 'Order already completed (idempotent)');
        return;
      }

      // Case B: Has txHash (Recovery needed)
      if (order.txHash) {
        logger.warn({ orderId, txHash: order.txHash }, 'Order has txHash but not SUCCESS. Triggering recovery.');
        // Delegate to existing recovery logic below (break loop to fall through)
        break;
      }

      // Case C: Stuck in PROCESSING (Zombie Worker Strategy)
      if (order.status === 'PROCESSING') {
        const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 Minutes (Increased to ensure > RPC timeouts)
        const isStale = order.updatedAt && (Date.now() - order.updatedAt.getTime() > STALE_THRESHOLD_MS);

        if (isStale) {
          logger.warn({ orderId, updatedAt: order.updatedAt }, '⚠️ Detected STALE Processing Lock (Zombie Worker). Stealing lock...');

          // Attempt to STEAL lock atomically
          const stealResult = await prisma.order.updateMany({
            where: {
              id: orderId,
              status: 'PROCESSING',
              updatedAt: order.updatedAt, // Optimistic Concurrency Control
            },
            data: {
              updatedAt: new Date(), // Just refresh timestamp to claim ownership
            },
          });

          if (stealResult.count > 0) {
            lockAcquired = true;
            logger.info({ orderId }, '✅ Lock Stolen from Zombie Worker. Resuming processing.');
            break;
          }
        } else {
          // Not stale yet, maybe race condition? Wait and retry.
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
      }

      // Case D: Other status (FAILED, CANCELLED) -> Abort
      if (order.status !== 'PAID' && order.status !== 'PROCESSING') {
        throw new Error(`Order status ${order.status} invalid for processing`);
      }

    } catch (e: any) {
      // DB Errors (Connection, etc) - Retry
      logger.warn({ error: e.message, attempt: attempts }, 'Lock acquisition transient error');
      if (attempts >= MAX_LOCK_ATTEMPTS) throw e;
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // ============================================================
  // PHASE 0.5: POST-LOCK CHECKS (Recovery & Validation)
  // ============================================================

  // Re-fetch to ensure we have latest state
  const order = await getOrderById(orderId);
  if (!order) throw new Error(`Order ${orderId} missing after lock`);

  // 1. RECOVERY CHECK: If txHash exists, complete it (SAFE START)
  if (order.txHash) {
    if (order.status !== 'SUCCESS') {
      logger.info({ orderId, txHash: order.txHash }, 'Recovering order with existing hash...');
      await prisma.order.updateMany({
        where: { id: orderId, txHash: order.txHash, status: { not: 'SUCCESS' } },
        data: { status: 'SUCCESS', completedAt: new Date() }
      });
      try { await inventoryService.deductInventory(order.chain, order.symbol, order.amountToken); } catch { }
    }
    return; // Job Done
  }

  // 2. CHECK OWNERSHIP: Did we actually get the lock?
  // We accepted PAID -> PROCESSING transition OR Staled PROCESSING -> Refreshed PROCESSING
  // If status is not PROCESSING, or we didn't set the flag, abort.
  if (!lockAcquired) {
    // Check one last time if it's just race condition where another worker finished it
    if (order.status === 'SUCCESS') return;
    throw new Error(`Could not acquire lock for Order ${orderId}`);
  }

  // ============================================================
  // LOCK ACQUIRED - ENTTERING DANGER ZONE
  // ============================================================
  logger.info({ orderId }, 'Processing lock verified. Starting payout...');

  let txHash = '';

  // --- PHASE 1: EXECUTE BLOCKCHAIN TRANSACTION (EXTERNAL SIDE EFFECT) ---
  try {
    txHash = await blockchainService.sendNativeToken(
      order.chain,
      order.walletAddress,
      order.amountToken
    );
  } catch (error: any) {
    // FAILURE CASE A: Transaction error (Pre-confirmation or Broadcast fail)

    // 1. CHECK IF BROADCASTED (Timeout during wait)
    if (error instanceof TxBroadcastedError) {
      logger.warn({ orderId, txHash: error.txHash }, '⚠️ Generic confirmation timeout, but Tx Broadcasted. Proceeding to Phase 2.');
      txHash = error.txHash;
      // Do NOT return. Fall through to Phase 2 (Update DB).
      // The code below expects 'txHash' to be set.
    } else {
      // 2. REAL FAILURE (or Ambiguous)
      logger.error({ error, orderId }, 'Blockchain transaction failed locally');

      // ANALYZE ERROR TYPE SAFETY
      const errorMessage = error.message?.toLowerCase() || '';
      const isSafeToRefund =
        errorMessage.includes('insufficient funds') ||
        errorMessage.includes('gas limit') || // Usually safe if not broadcast
        errorMessage.includes('reverted') ||
        errorMessage.includes('nonce too low') || // Prevent loop, but maybe safe to refund? No, nonce error means we didn't send.
        errorMessage.includes('replacement fee too low'); // Didn't send.

      // Ambiguous Errors: "Timeout", "Network Error", "Connection Reset", "502 Bad Gateway"
      // If we represent "Unknown state", we MUST NOT Refund.

      if (isSafeToRefund) {
        logger.info({ orderId, reason: errorMessage }, 'Error is safe. Refunding inventory.');

        // Update order status to FAILED and refund inventory
        await prisma.$transaction(async (tx) => {
          await tx.order.update({
            where: { id: orderId },
            data: { status: 'FAILED' },
          });

          await inventoryService.releaseInventory(
            order.chain,
            order.symbol,
            order.amountToken
          );
        });

        // Notify user of failure
        await notificationsService.notifyOrderFailed(order);
        return; // Finished.
      }

      // 3. AMBIGUOUS / UNSAFE ERROR
      // DANGER: We don't know if tx went through.
      // ACTION: Log Critical, Throw Error (to fail job), Leave DB as PROCESSING.
      // Admin must investigate or Zombie worker will retry later (safely).
      logger.fatal({ orderId, error }, '🚨 CRITICAL: Ambiguous Blockchain Error. FREEZING Order to prevent Double Spend/Lost Funds.');
      throw error; // Throwing keeps job failed/active in Queue depends on config, and DB stays PROCESSING.
    }
  }

  // --- PHASE 2: UPDATE DATABASE (INTERNAL STATE) ---
  // CRITICAL: Money has been sent (or assumed sent via TxBroadcastedError).
  // We MUST NOT revert to FAILED or release inventory.
  try {
    await prisma.$transaction(async (tx) => {
      // Update Order
      await tx.order.update({
        where: { id: orderId },
        data: {
          status: 'SUCCESS',
          txHash,
          completedAt: new Date(),
        },
      });

      // Deduct inventory (Permanent removal)
      // Pass TX to ensure atomicity
      await inventoryService.deductInventory(
        order.chain,
        order.symbol,
        order.amountToken,
        tx
      );
    });

    logger.info({ orderId, txHash }, 'Order completed successfully');

    // Notify user (Non-critical)
    try {
      await notificationsService.notifyOrderSuccess(order, txHash);
      await processReferralReward(order.userId, orderId); // Extracted function
    } catch (e) {
      logger.warn({ orderId, error: e }, 'Failed to send success notification or reward');
    }

  } catch (error) {
    // FAILURE CASE B: ZOMBIE STATE
    // Money Sent (txHash) BUT DB Updated Failed.
    // This is the "Double Spend" risk zone if we retry blindly, but we MUST retry the DB update.

    logger.error({ error, orderId, txHash }, '🚨 DB Update Failed after Blockchain Send. Attempting Auto-Recovery...');

    // RETRY LOGIC (Senior Level) -> Attempt to force update one more time
    try {
      // Small delay to allow DB connection to recover
      await new Promise(resolve => setTimeout(resolve, 1000));

      await prisma.$transaction(async (tx) => {
        await tx.order.update({
          where: { id: orderId },
          data: { status: 'SUCCESS', txHash, completedAt: new Date() }
        });
        await inventoryService.deductInventory(order.chain, order.symbol, order.amountToken, tx);
      });

      logger.info({ orderId, txHash }, '✅ Zombie Order Recovered Successfully');
      return;

    } catch (retryError) {
      logger.fatal({ error: retryError, orderId, txHash }, '🚨 CRITICAL: Order sent on-chain but DB update failed TWICE! Manual reconciliation required.');

      // We do NOT throw here if we want to treat the job as "Technical Success" (money sent).
      // However, keeping it in 'PROCESSING' in DB is actually correct for "Stuck/Unknown".

      // Alert Admin via Telegram (Best Effort)
      try {
        // Implement alert logic here if available, or rely on logger
        // await notificationsService.alertAdmin(`CRITICAL: Order ${orderId} sent but DB failed. Hash: ${txHash}`);
      } catch (e) { }

      // We suppress the error so the Worker marks the job as COMPLETED (or at least doesn't retry).
      // If we throw, and the worker has retry > 0, we Double Spend.
      // Even with retry=0, throwing marks it "Failed" in BullMQ, which might be misleading but acceptable.
      // We choose to THROW so it shows up as FAILED in the dashboard, alerting the admin.
      // Since we set `attempts: 1`, it WON'T retry. This is safe.
      throw error;
    }
  }
};

// Import referrals service for centralized reward handling
import * as referralsService from '../referrals/referrals.service.js';

/**
 * Helper: Process Referral Reward
 *
 * IMPORTANT: Delegates to referrals.service.validateReferral() which is the
 * SINGLE SOURCE OF TRUTH for referral validation and reward granting.
 * This prevents double-reward issues.
 */
async function processReferralReward(userId: string, orderId: string) {
  try {
    // Delegate to centralized referral service
    // This handles: validation, reward voucher creation, bonus vouchers, notifications
    await referralsService.validateReferral(userId);
  } catch (refError) {
    // Non-critical - don't fail order processing
    logger.error({ error: refError, orderId, userId }, 'Referral validation failed');
  }
}

/**
 * Cancel order (Race-condition safe)
 * Uses atomic update to prevent double-release of inventory/voucher
 */
export const cancelOrder = async (orderId: string): Promise<void> => {
  // ATOMIC UPDATE: Only cancel if status is PENDING
  // This prevents race conditions where cancel is called multiple times
  const updateResult = await prisma.order.updateMany({
    where: {
      id: orderId,
      status: 'PENDING' // Only cancel if still PENDING
    },
    data: { status: 'CANCELLED' },
  });

  // If count is 0, order was already cancelled/processed by another request
  if (updateResult.count === 0) {
    const order = await getOrderById(orderId);
    if (!order) {
      throw new Error('Order not found');
    }
    if (order.status === 'CANCELLED') {
      logger.debug({ orderId }, 'Order already cancelled (idempotent)');
      return; // Idempotent - already cancelled
    }
    throw new Error('Only pending orders can be cancelled');
  }

  // Fetch order details for inventory/voucher release
  const order = await getOrderById(orderId);
  if (!order) {
    // Should never happen since we just updated it
    throw new Error('Order disappeared after cancel');
  }

  // Release inventory
  await inventoryService.releaseInventory(
    order.chain,
    order.symbol,
    order.amountToken
  );

  // Release Voucher
  if (order.voucherId) {
    await voucherService.releaseVoucher(order.voucherId);
  }

  logger.info({ orderId }, 'Order cancelled');
};

/**
 * Expire old pending orders
 *
 * IMPORTANT: Before expiring, we check Midtrans status for orders that have
 * initiated payment. This prevents expiring orders where payment succeeded
 * but webhook was delayed.
 *
 * Flow:
 * 1. Find old PENDING orders
 * 2. If order has midtransId, check Midtrans status first
 * 3. If Midtrans says paid, process as success instead of expire
 * 4. Only expire if no payment or payment truly failed/expired
 */
export const expirePendingOrders = async (
  olderThanMinutes: number = 15
): Promise<number> => {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000);

  const pendingOrders = await prisma.order.findMany({
    where: {
      status: 'PENDING',
      createdAt: { lt: cutoff },
    },
  });

  let expiredCount = 0;
  let recoveredCount = 0;

  for (const order of pendingOrders) {
    try {
      // SAFETY CHECK: If payment was initiated, verify with Midtrans first
      if (order.midtransId) {
        try {
          const status = await paymentsService.getTransactionStatus(order.midtransId);

          // If Midtrans says payment succeeded, process it instead of expire!
          if (paymentsService.isTransactionSuccess(status)) {
            logger.info(
              { orderId: order.id, midtransId: order.midtransId },
              'Found paid order during expiry check - recovering...'
            );

            // Process as success
            await handlePaymentSuccess(order.id);
            recoveredCount++;
            continue; // Skip expiration
          }

          // If Midtrans says pending but not expired yet, give grace period
          // This handles the edge case where user paid at minute 59
          if (paymentsService.isTransactionPending(status)) {
            const orderAge = Date.now() - new Date(order.createdAt).getTime();
            const gracePeriodMs = 70 * 60 * 1000; // 70 minutes (10 min buffer after 60 min payment expiry)

            if (orderAge < gracePeriodMs) {
              logger.debug(
                { orderId: order.id, ageMinutes: Math.floor(orderAge / 60000) },
                'Order still in grace period - skipping expiry'
              );
              continue; // Wait longer
            }
          }

          // If failed/expired in Midtrans, safe to expire our order

          // If failed/expired in Midtrans, safe to expire our order
        } catch (checkError) {
          // Midtrans check failed (API Down, Timeout, etc)
          // CRITICAL FIX: Do NOT expire the order if we can't verify payment status!
          // It's possible the user PAID, but Midtrans API is unreachable.
          // We must protect the user's potential payment.
          logger.warn(
            { error: (checkError as Error).message, orderId: order.id, midtransId: order.midtransId },
            '⚠️ Failed to check Midtrans status during expiry - SKIPPING expiry to protect potential payment'
          );
          continue; // Skip expiration for this order
        }
      }

      // ATOMIC UPDATE: Only expire if STILL pending
      const result = await prisma.order.updateMany({
        where: {
          id: order.id,
          status: 'PENDING'
        },
        data: { status: 'EXPIRED' }
      });

      if (result.count === 0) {
        // Order status changed (probably PAID by webhook), skip
        continue;
      }

      await inventoryService.releaseInventory(
        order.chain,
        order.symbol,
        order.amountToken
      );

      // Release Voucher
      if (order.voucherId) {
        await voucherService.releaseVoucher(order.voucherId);
      }

      expiredCount++;
    } catch (error) {
      logger.error({ error, orderId: order.id }, 'Failed to expire order');
    }
  }

  if (expiredCount > 0 || recoveredCount > 0) {
    logger.info({ expiredCount, recoveredCount }, 'Order expiry job completed');
  }

  return expiredCount;
};
