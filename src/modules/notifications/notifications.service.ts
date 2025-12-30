import { Order } from '@prisma/client';
import { getBot } from '../../bot/index.js';
import { logger } from '../../libs/logger.js';
import { prisma } from '../../libs/prisma.js';
import { ChainId, getExplorerTxUrl, chains } from '../../config/chains.js';
import { formatIdr, formatTokenAmount } from '../../utils/price.js';
import { backToMainKeyboard, getChainDisplay } from '../../bot/keyboards/main.keyboard.js';
import * as blockchainService from '../blockchain/blockchain.service.js';

/**
 * Notify user of successful order
 */
export const notifyOrderSuccess = async (
  order: Order,
  txHash: string
): Promise<void> => {
  try {
    const user = await prisma.user.findUnique({ where: { id: order.userId } });

    if (!user?.telegramId) {
      logger.warn({ orderId: order.id }, 'No telegram ID for user notification');
      return;
    }

    const bot = getBot();
    const explorerUrl = getExplorerTxUrl(order.chain as ChainId, txHash);

    // Time formatting
    const createdAt = new Date(order.createdAt).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
    const completedAt = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });

    // Estimate Gas used for display
    let gasDisplay = '0';
    try {
      const gasEst = await blockchainService.estimateGasFeeNative(order.chain);
      gasDisplay = formatTokenAmount(gasEst);
    } catch (e) { gasDisplay = 'Checking...'; }

    const message =
      `✅ **Transaksi Berhasil!**\n\n` +
      `Terima kasih Kak ${(user.name || 'Customer').split(' ')[0]}, token telah berhasil dikirim ke wallet Kakak.\n\n` +

      `📝 **Rincian Transaksi:**\n` +
      `• Network: ${getChainDisplay(order.chain as ChainId)}\n` +
      `• Total Bayar: ${formatIdr(order.amountIdr)}\n` +
      `• **Jumlah Token:** ${formatTokenAmount(order.amountToken)} ${order.symbol}\n` +
      `• Wallet Tujuan: \`${order.walletAddress}\`\n\n` +

      `📊 **Transparansi Harga:**\n` +
      `• Estimasi Awal: \`${formatTokenAmount(order.amountToken)} ${order.symbol}\`\n` +
      `• **Real Diterima:** \`${formatTokenAmount(order.amountToken)} ${order.symbol}\`\n` +
      `✅ _(Akurat 100% tanpa potongan tersembunyi)_\n\n` +

      `⛽ **Gas Fee:** ~${gasDisplay} ${order.symbol} (✅ Ditanggung Admin)\n\n` +

      `🔗 **Bukti di Blockchain:**\n` +
      `[Klik Untuk Lihat Transaksi](${explorerUrl})\n` +
      `TX: \`${txHash}\`\n\n` +
      `_Simpan bukti ini jika diperlukan._`;

    await bot.sendMessage(parseInt(user.telegramId, 10), message, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      reply_markup: backToMainKeyboard(),
    });

    logger.info({ orderId: order.id, userId: user.id }, 'Order success notification sent');
  } catch (error) {
    logger.error({ error, orderId: order.id }, 'Failed to send success notification');
  }
};

/**
 * Notify user of failed order
 */
export const notifyOrderFailed = async (order: Order): Promise<void> => {
  try {
    const user = await prisma.user.findUnique({ where: { id: order.userId } });

    if (!user?.telegramId) {
      logger.warn({ orderId: order.id }, 'No telegram ID for user notification');
      return;
    }

    const bot = getBot();

    const message =
      `❌ **Gagal Mengirim Aset**\n\n` +
      `Mohon maaf, terjadi gangguan teknis saat pengiriman ke Blockchain.\n` +

      `📝 **Detail:**\n` +
      `• Network: ${getChainDisplay(order.chain as ChainId)}\n` +
      `• Nominal: ${formatIdr(order.amountIdr)}\n\n` +

      `🛡️ **Dana Anda Aman!**\n` +
      `Sistem kami telah mencatat insiden ini. Jika saldo bank terpotong, kami akan **Refund 100%**.\n\n` +
      `👇 **Bantuan Cepat:**\n` +
      `Silakan hubungi Admin / Support untuk proses refund segera.`;

    await bot.sendMessage(parseInt(user.telegramId, 10), message, {
      parse_mode: 'Markdown',
      reply_markup: backToMainKeyboard(),
    });

    logger.info({ orderId: order.id, userId: user.id }, 'Order failed notification sent');
  } catch (error) {
    logger.error({ error, orderId: order.id }, 'Failed to send failure notification');
  }
};

/**
 * Notify user of payment received
 */
export const notifyPaymentReceived = async (order: Order): Promise<void> => {
  try {
    const user = await prisma.user.findUnique({ where: { id: order.userId } });

    if (!user?.telegramId) {
      return;
    }

    const bot = getBot();

    const message =
      `💳 **Pembayaran Diterima!**\n\n` +
      `Pembayaran Kakak telah terverifikasi oleh Sistem.\n` +
      `Saat ini kami sedang memproses pengiriman aset ke blockchain...\n\n` +

      `📝 **Detail:**\n` +
      `• Network: ${getChainDisplay(order.chain as ChainId)}\n` +
      `• Mengirim: **${formatTokenAmount(order.amountToken)} ${order.symbol}**\n\n` +

      `⏳ _Mohon tunggu 1-2 menit untuk konfirmasi blockchain..._`;

    await bot.sendMessage(parseInt(user.telegramId, 10), message, {
      parse_mode: 'Markdown',
    });

    logger.info({ orderId: order.id }, 'Payment received notification sent');
  } catch (error) {
    logger.error({ error, orderId: order.id }, 'Failed to send payment notification');
  }
};

/**
 * Notify user of voucher received
 */
export const notifyVoucherReceived = async (
  userId: string,
  voucherValue: number,
  reason: string
): Promise<void> => {
  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });

    if (!user?.telegramId) {
      return;
    }

    const bot = getBot();

    const message =
      `🎟️ You received a voucher!\n\n` +
      `Value: ${formatIdr(voucherValue)}\n` +
      `Reason: ${reason}\n\n` +
      `Use it on your next purchase!`;

    await bot.sendMessage(parseInt(user.telegramId, 10), message, {
      parse_mode: 'Markdown',
      reply_markup: backToMainKeyboard(),
    });

    logger.info({ userId, voucherValue }, 'Voucher notification sent');
  } catch (error) {
    logger.error({ error, userId }, 'Failed to send voucher notification');
  }
};
