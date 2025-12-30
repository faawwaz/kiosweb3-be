import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../libs/prisma.js';
import { authMiddleware } from '../../middlewares/auth.middleware.js';
import * as ordersService from './orders.service.js';
import * as pricingService from '../pricing/pricing.service.js';
import { formatTokenAmount } from '../../utils/price.js';
import { logger } from '../../libs/logger.js';
import { orderLimiter } from '../../middlewares/rate-limit.middleware.js';
import { ethers } from 'ethers';

const router = Router();

// Constants for validation (Issue #12)
const MIN_AMOUNT_IDR = 10000;
const MAX_AMOUNT_IDR = 50000000; // 50 juta max
const ETH_MAINNET_MIN_AMOUNT = 500000;

/**
 * Issue #11: Wallet address validation with checksum
 */
function validateAndNormalizeWallet(address: string): { valid: boolean; normalized: string; error?: string } {
  // Basic format check
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return { valid: false, normalized: '', error: 'Format wallet tidak valid. Harus dimulai dengan 0x dan 40 karakter hex.' };
  }

  try {
    // Use ethers to validate and normalize
    const normalized = ethers.getAddress(address);
    return { valid: true, normalized };
  } catch (e) {
    // STRICT SECURITY: Do not accept invalid checksums
    // If checksum differs, it might be a typo or a different network address format.
    // We reject it to force user to copy-paste the correct address.
    logger.warn({ address, error: (e as Error).message }, 'Wallet validation failed (Checksum mismatch)');
    return {
      valid: false,
      normalized: '',
      error: 'Format wallet tidak valid (Checksum salah). Mohon copy-paste ulang alamat dengan benar, perhatikan huruf besar/kecil.'
    };
  }
}

/**
 * POST /api/orders
 * Create a new order
 */
router.post('/', authMiddleware, orderLimiter, async (req: Request, res: Response) => {
  try {
    // Issue #12: Enhanced validation schema
    const schema = z.object({
      chain: z.string().min(1),
      amountIdr: z.number()
        .int('Nominal harus bilangan bulat')
        .min(MIN_AMOUNT_IDR, `Minimal pembelian ${MIN_AMOUNT_IDR.toLocaleString('id-ID')}`)
        .max(MAX_AMOUNT_IDR, `Maksimal pembelian ${MAX_AMOUNT_IDR.toLocaleString('id-ID')}`),
      walletAddress: z.string().min(1, 'Alamat wallet diperlukan'),
      voucherCode: z.string().optional(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: parsed.error.errors.map(e => e.message).join(', ')
      });
    }

    const { chain: chainSlug, amountIdr, walletAddress, voucherCode } = parsed.data;
    const userId = req.userId!;

    // Issue #11: Wallet validation with checksum
    const walletValidation = validateAndNormalizeWallet(walletAddress);
    if (!walletValidation.valid) {
      return res.status(400).json({ error: walletValidation.error });
    }

    // 1. Verify Chain Exists & Active
    const chainConfig = await prisma.chain.findUnique({ where: { slug: chainSlug } });
    if (!chainConfig || !chainConfig.isActive) {
      return res.status(400).json({ error: 'Jaringan tidak aktif atau tidak ditemukan' });
    }

    // 2. Issue #3: Dynamic Min Order Check
    if (chainConfig.chainId === 1 && amountIdr < ETH_MAINNET_MIN_AMOUNT) {
      return res.status(400).json({
        error: `Minimal pembelian untuk ETH Mainnet adalah Rp ${ETH_MAINNET_MIN_AMOUNT.toLocaleString('id-ID')} karena tingginya biaya gas.`
      });
    }

    // 3. Get quote
    const quote = await pricingService.getQuote(chainSlug, amountIdr);

    // 4. Create order with normalized wallet
    const order = await ordersService.createOrder({
      userId,
      chain: chainSlug,
      symbol: quote.symbol,
      amountIdr,
      amountToken: quote.tokenAmount,
      markupPercent: quote.markupPercent,
      walletAddress: walletValidation.normalized, // Issue #11: Use normalized address
      voucherCode,
    });

    return res.status(201).json({
      order: {
        id: order.id,
        chain: order.chain,
        symbol: order.symbol,
        amountIdr: order.amountIdr,
        amountToken: formatTokenAmount(order.amountToken),
        walletAddress: order.walletAddress,
        status: order.status,
        createdAt: order.createdAt,
      },
    });
  } catch (error) {
    logger.error({ error }, 'Failed to create order');
    const message = error instanceof Error ? error.message : 'Gagal membuat pesanan';

    // SPECIAL HANDLING: Pending Order Exists
    if (message.includes('pending order') || message.includes('pending')) {
      const pendingOrder = await prisma.order.findFirst({
        where: { userId: (req as any).userId, status: 'PENDING' }
      });
      if (pendingOrder) {
        return res.status(409).json({
          error: 'PENDING_ORDER_EXISTS',
          message: 'Anda masih memiliki pesanan aktif yang belum dibayar.',
          pendingOrder: {
            id: pendingOrder.id,
            chain: pendingOrder.chain,
            amountIdr: pendingOrder.amountIdr,
            createdAt: pendingOrder.createdAt
          }
        });
      }
    }

    return res.status(400).json({ error: message });
  }
});

/**
 * POST /api/orders/:id/pay
 * Select Payment Method & Generate
 */
router.post('/:id/pay', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { method } = req.body; // 'QRIS' | 'VA'

    if (!method || !['QRIS', 'VA'].includes(method)) {
      return res.status(400).json({ error: 'Silakan pilih metode pembayaran: QRIS atau VA' });
    }

    const order = await ordersService.getOrderById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan' });
    if (order.userId !== req.userId) return res.status(403).json({ error: 'Akses ditolak' });

    const result = await ordersService.createPayment(order.id, method);

    return res.json({
      orderId: result.orderId,
      paymentUrl: result.paymentUrl,
      qrImage: result.qrImage,
      fee: result.fee,
      totalPay: result.total,
      expiryTime: new Date(Date.now() + 15 * 60 * 1000).toISOString()
    });

  } catch (error) {
    return res.status(400).json({ error: (error as Error).message });
  }
});

/**
 * POST /api/orders/:id/sync
 */
router.post('/:id/sync', authMiddleware, async (req: Request, res: Response) => {
  try {
    const order = await ordersService.getOrderById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan' });
    if (order.userId !== req.userId) return res.status(403).json({ error: 'Akses ditolak' });

    const status = await ordersService.syncPayment(req.params.id);
    return res.json({ status });
  } catch (error) {
    return res.status(500).json({ error: 'Gagal sinkronisasi pembayaran' });
  }
});

/**
 * POST /api/orders/:id/cancel
 * Issue #13: Fixed race condition with payment webhook
 */
router.post('/:id/cancel', authMiddleware, async (req: Request, res: Response) => {
  try {
    const orderId = req.params.id;

    // Fetch *fresh* order status (not stale)
    const order = await prisma.order.findUnique({ where: { id: orderId } });

    if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan' });
    if (order.userId !== req.userId) return res.status(403).json({ error: 'Akses ditolak' });

    // Issue #13: Check status AFTER fetching fresh data
    if (order.status !== 'PENDING') {
      // If already paid/processing, don't allow cancellation
      if (order.status === 'PAID' || order.status === 'PROCESSING') {
        return res.status(400).json({
          error: 'Pembayaran sudah diterima. Pesanan sedang diproses dan tidak dapat dibatalkan.'
        });
      }
      if (order.status === 'SUCCESS') {
        return res.status(400).json({
          error: 'Pesanan sudah selesai dan tidak dapat dibatalkan.'
        });
      }
      // Already cancelled/expired/failed - just acknowledge
      return res.json({ success: true, message: 'Pesanan sudah dibatalkan/kadaluarsa.' });
    }

    await ordersService.cancelOrder(order.id);
    return res.json({ success: true, message: 'Pesanan berhasil dibatalkan.' });
  } catch (error) {
    logger.error({ error, orderId: req.params.id }, 'Cancel order failed');
    return res.status(400).json({ error: (error as Error).message });
  }
});

export default router;
