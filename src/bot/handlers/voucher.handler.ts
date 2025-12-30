import TelegramBot from 'node-telegram-bot-api';
import { logger } from '../../libs/logger.js';
import { backToMainKeyboard } from '../keyboards/main.keyboard.js';
import { formatIdr } from '../../utils/price.js';
import * as usersService from '../../modules/users/users.service.js';
import * as vouchersService from '../../modules/vouchers/vouchers.service.js';

export const setupVoucherHandler = (bot: TelegramBot): void => {
  // Handle "Voucher" button
  bot.on('callback_query', async (query) => {
    if (query.data !== 'voucher') return;

    const chatId = query.message?.chat.id;
    const telegramId = String(query.from.id);

    if (!chatId) return;

    // Issue #10: Null check
    if (!telegramId || telegramId === 'undefined') return;

    try {
      const user = await usersService.findUserByTelegramId(telegramId);

      if (!user) {
        await bot.answerCallbackQuery(query.id, { text: 'Pengguna tidak ditemukan' });
        return;
      }

      const vouchers = await vouchersService.getUserVouchers(user.id);
      const availableVouchers = vouchers.filter((v) => v.usageCount < v.maxUsage);
      const totalValue = availableVouchers.reduce((sum, v) => sum + v.value, 0);

      // Issue #15: Consistent Indonesian messages
      let message = `🎟️ **Voucher Anda**\n\n`;

      if (availableVouchers.length === 0) {
        // Issue #21: More neutral empty state
        message += `📭 Anda belum memiliki voucher.\n\n`;
        message += `💡 **Cara Mendapatkan Voucher:**\n`;
        message += `• Ajak teman dengan kode referral Anda\n`;
        message += `• Setiap 20 referral yang valid = Voucher Rp 10.000\n\n`;
        message += `Kode Referral Anda: \`${user.referralCode}\``;
      } else {
        message += `💰 **Total Saldo:** ${formatIdr(totalValue)}\n\n`;
        message += `📋 **Voucher Tersedia:**\n`;

        for (const voucher of availableVouchers.slice(0, 5)) {
          const remaining = voucher.maxUsage - voucher.usageCount;
          message += `├ ${formatIdr(voucher.value)} - \`${voucher.code}\``;
          if (voucher.maxUsage > 1) {
            message += ` (${remaining}x tersisa)`;
          }
          message += `\n`;
        }

        if (availableVouchers.length > 5) {
          message += `└ ... dan ${availableVouchers.length - 5} lainnya\n`;
        }

        message += `\n💡 _Voucher akan otomatis diterapkan saat checkout, atau Anda bisa input kode manual._`;
      }

      await bot.editMessageText(message, {
        chat_id: chatId,
        message_id: query.message?.message_id,
        parse_mode: 'Markdown',
        reply_markup: backToMainKeyboard(),
      });

      await bot.answerCallbackQuery(query.id);
    } catch (error) {
      logger.error({ error }, 'Voucher handler error');
      await bot.answerCallbackQuery(query.id, { text: 'Gagal memuat voucher' });
    }
  });
};
