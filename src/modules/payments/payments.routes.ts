import { Router, Request, Response } from 'express';
import { logger } from '../../libs/logger.js';
import * as paymentsService from './payments.service.js';
import * as ordersService from '../orders/orders.service.js';
import { prisma } from '../../libs/prisma.js';
import { authLimiter } from '../../middlewares/rate-limit.middleware.js';

const router = Router();

/**
 * Sanitize string to prevent XSS
 */
const sanitizeHtml = (str: unknown): string => {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
};

/**
 * POST /api/payments/webhook
 * Midtrans payment notification webhook
 */
router.post('/webhook', async (req: Request, res: Response) => {
  try {
    const notification = req.body as paymentsService.MidtransNotification;

    logger.info(
      {
        orderId: notification.order_id,
        status: notification.transaction_status,
      },
      'Received Midtrans webhook'
    );

    // Verify signature
    if (!paymentsService.verifySignature(notification)) {
      logger.warn({ orderId: notification.order_id }, 'Invalid signature');
      return res.status(400).json({ error: 'Invalid signature' });
    }

    // Find order by Midtrans order ID
    // SECURITY NOTE: If user regenerates payment, midtransId in DB changes to new one.
    // Old payment attempts will fail lookup here (Order not found). This is expected behavior to enforce latest payment.
    const order = await ordersService.getOrderByMidtransId(notification.order_id);

    if (!order) {
      logger.warn({ midtransId: notification.order_id }, 'Order not found (possibly expired or overwritten)');
      return res.status(200).json({ message: 'Order not found' });
    }

    // 2. SECURITY CHECK: Amount Validation (Prevent Manipulation)
    // If order has totalPay (New Flow), use it. If 0 (Old Flow), use amountIdr.
    const expectedAmount = order.totalPay > 0 ? order.totalPay : order.amountIdr;
    const paidAmount = Number(notification.gross_amount); // gross_amount is string "100000.00"

    // TOLERANCE CALCULATION:
    // - Midtrans VA may have unique code suffix (+1 to +999)
    // - Allow 0.5% tolerance OR minimum 1000 IDR, whichever is greater
    // - This handles rounding and VA unique codes while still catching fraud
    const tolerancePercent = expectedAmount * 0.005; // 0.5%
    const toleranceMin = 1000; // Min Rp 1.000
    const tolerance = Math.max(tolerancePercent, toleranceMin);

    const amountDiff = Math.abs(paidAmount - expectedAmount);

    if (amountDiff > tolerance) {
      logger.error(
        {
          orderId: order.id,
          expected: expectedAmount,
          paid: paidAmount,
          diff: amountDiff,
          tolerance
        },
        'CRITICAL: Payment amount mismatch - possible fraud!'
      );
      // Do not process. Return 200 to stop Midtrans retry but flag for review.
      return res.status(200).json({ message: 'Amount mismatch' });
    }

    // Log if there's any difference (for monitoring VA unique codes)
    if (amountDiff > 0) {
      logger.info(
        { orderId: order.id, expected: expectedAmount, paid: paidAmount, diff: amountDiff },
        'Payment amount has minor difference (within tolerance)'
      );
    }

    // Check if already processed (idempotency)
    if (order.status !== 'PENDING') {
      logger.info(
        { orderId: order.id, status: order.status },
        'Order already processed'
      );
      return res.status(200).json({ message: 'Already processed' });
    }

    // Handle based on transaction status
    if (paymentsService.isTransactionSuccess(notification)) {
      await ordersService.handlePaymentSuccess(order.id);
      logger.info({ orderId: order.id }, 'Payment success processed');
    } else if (paymentsService.isTransactionFailed(notification)) {
      await ordersService.cancelOrder(order.id);
      logger.info({ orderId: order.id }, 'Payment failed, order cancelled');
    } else if (paymentsService.isTransactionPending(notification)) {
      logger.info({ orderId: order.id }, 'Payment pending');
    }

    return res.status(200).json({ message: 'OK' });
  } catch (error) {
    logger.error({ error }, 'Webhook processing error');
    // Return 200 to prevent retries on internal errors
    return res.status(200).json({ message: 'Error processed' });
  }
});

/**
 * POST /api/payments/check/:orderId
 * Check payment status manually
 * Rate limited to prevent abuse
 */
router.post('/check/:orderId', authLimiter, async (req: Request, res: Response) => {
  try {
    const order = await ordersService.getOrderById(req.params.orderId);

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (!order.midtransId) {
      return res.status(400).json({ error: 'No payment created for this order' });
    }

    const status = await paymentsService.getTransactionStatus(order.midtransId);

    return res.json({
      orderId: order.id,
      orderStatus: order.status,
      paymentStatus: status.transaction_status,
    });
  } catch (error) {
    logger.error({ error }, 'Failed to check payment status');
    return res.status(500).json({ error: 'Failed to check status' });
  }
});

/**
 * GET /api/payments/finish
 * Payment finish redirect page
 * XSS Protected: All query params are sanitized
 */
router.get('/finish', async (req: Request, res: Response) => {
  // Sanitize all query params to prevent XSS
  const orderId = sanitizeHtml(req.query.order_id);
  const transactionStatus = sanitizeHtml(req.query.transaction_status);

  const isSuccess = transactionStatus === 'settlement';
  const statusClass = isSuccess ? 'success' : 'pending';
  const statusTitle = isSuccess ? 'Payment Successful!' : 'Payment Processing';

  // Simple HTML response for payment finish
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Payment ${isSuccess ? 'Success' : 'Status'}</title>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
        .success { color: green; }
        .pending { color: orange; }
        .failed { color: red; }
      </style>
    </head>
    <body>
      <h1 class="${statusClass}">${statusTitle}</h1>
      <p>Order ID: ${orderId}</p>
      <p>You can close this page and check your Telegram for updates.</p>
    </body>
    </html>
  `;

  res.send(html);
});

export default router;
