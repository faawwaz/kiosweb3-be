import TelegramBot from 'node-telegram-bot-api';
import { logger } from '../../libs/logger';
import { mainMenuKeyboard } from '../keyboards/reply.keyboard';
import { formatIdr, formatTokenAmount } from '../../utils/price';
import { getExplorerTxUrl, ChainId } from '../../config/chains';
import * as usersService from '../../modules/users/users.service';
import * as ordersService from '../../modules/orders/orders.service';
import { prisma } from '../../libs/prisma';
import { historyNavigationKeyboard } from '../keyboards/main.keyboard';

const ORDERS_PER_PAGE = 5;

// Helper to Render History Page
export const renderHistory = async (
  bot: TelegramBot,
  chatId: number,
  userId: string,
  page: number,
  isEdit: boolean = false,
  messageId?: number
) => {
  const { orders, total } = await ordersService.getUserOrders(userId, page, ORDERS_PER_PAGE);
  const totalPages = Math.max(1, Math.ceil(total / ORDERS_PER_PAGE)); // Issue #22: Fix "Hal. 1/0"
  const hasMore = page < totalPages - 1;

  let message = `📜 **Riwayat Transaksi**`;

  // Issue #22: Only show page number if there are orders
  if (total > 0) {
    message += ` (Halaman ${page + 1}/${totalPages})`;
  }
  message += `\n\n`;

  if (orders.length === 0) {
    // Issue #21: More neutral empty state message
    message += `📭 Belum ada riwayat transaksi.\n\n`;
    message += `Mulai transaksi pertama Anda dengan klik **💰 Beli Token** di menu utama.`;
  } else {
    for (const order of orders) {
      const statusEmoji = getStatusEmoji(order.status);
      const date = new Date(order.createdAt).toLocaleDateString('id-ID', {
        day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
      });
      const chainName = order.chain === 'bsc' ? 'BSC' : order.chain === 'base' ? 'Base' : 'ETH';

      message += `${statusEmoji} **${date}**\n`;
      message += `├ ${chainName} | ${formatIdr(order.amountIdr)}\n`;
      message += `├ Dapat: ${formatTokenAmount(order.amountToken)} ${order.symbol}\n`;

      if (order.txHash) {
        const explorerUrl = getExplorerTxUrl(order.chain as ChainId, order.txHash);
        message += `└ [Lihat di Blockchain](${explorerUrl})\n`;
      } else {
        message += `└ Status: ${translateStatus(order.status)}\n`;
      }
      message += `\n`;
    }
  }

  const keyboard = historyNavigationKeyboard(page, hasMore);

  if (isEdit && messageId) {
    await bot.editMessageText(message, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      reply_markup: keyboard
    });
  } else {
    await bot.sendMessage(chatId, message, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      reply_markup: keyboard
    });
  }
};


export const setupHistoryHandler = (bot: TelegramBot): void => {
  // Handle "Riwayat" Text Input
  bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;

    const text = msg.text.trim();
    if (text !== '📜 Riwayat') return;

    const chatId = msg.chat.id;
    const telegramId = String(msg.from?.id);

    // Issue #10: Null check
    if (!telegramId || telegramId === 'undefined') return;

    try {
      await bot.sendChatAction(chatId, 'typing');

      const user = await usersService.findUserByTelegramId(telegramId);
      if (!user) {
        await bot.sendMessage(chatId,
          `⚠️ **Akun Belum Terdaftar**\n\nSilakan daftar atau login terlebih dahulu.\n\n👉 Ketik /start untuk memulai.`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      await renderHistory(bot, chatId, user.id, 0);

    } catch (error) {
      logger.error({ error }, 'History handler error');
      await bot.sendMessage(chatId, '❌ Gagal memuat riwayat. Silakan coba lagi.', { reply_markup: mainMenuKeyboard() });
    }
  });
};

// Issue #15: Consistent Indonesian status translations
function translateStatus(status: string): string {
  const map: Record<string, string> = {
    PENDING: 'Menunggu Pembayaran',
    PAID: 'Sudah Bayar (Memproses)',
    PROCESSING: 'Sedang Dikirim',
    SUCCESS: 'Berhasil',
    FAILED: 'Gagal',
    EXPIRED: 'Kadaluarsa',
    CANCELLED: 'Dibatalkan'
  };
  return map[status] || status;
}

function getStatusEmoji(status: string): string {
  const emojis: Record<string, string> = {
    PENDING: '⏳',
    PAID: '💳',
    PROCESSING: '⚙️',
    SUCCESS: '✅',
    FAILED: '❌',
    EXPIRED: '⌛',
    CANCELLED: '🚫',
  };
  return emojis[status] || '❓';
}
