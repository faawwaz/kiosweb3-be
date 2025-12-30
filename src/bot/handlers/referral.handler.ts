import TelegramBot from 'node-telegram-bot-api';
import { logger } from '../../libs/logger.js';
import { mainMenuKeyboard } from '../keyboards/reply.keyboard.js';
import { formatIdr } from '../../utils/price.js';
import * as usersService from '../../modules/users/users.service.js';
import * as referralsService from '../../modules/referrals/referrals.service.js';

// Issue #27: Cache bot username to avoid repeated API calls
let cachedBotUsername: string | null = null;

export const setupReferralHandler = (bot: TelegramBot): void => {
  // Handle "Referral" Text Input
  bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;

    const text = msg.text.trim();
    if (text !== '🎁 Referral') return;

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

      const stats = await referralsService.getReferralStats(user.id);

      // Issue #27: Cache bot username
      if (!cachedBotUsername) {
        try {
          const botInfo = await bot.getMe();
          cachedBotUsername = botInfo.username || 'KiosWeb3Bot';
        } catch (e) {
          cachedBotUsername = 'KiosWeb3Bot'; // Fallback
        }
      }

      const referralLink = `https://t.me/${cachedBotUsername}?start=${user.referralCode}`;

      const progress = stats.valid % 20;

      // Issue #20: Fix progress bar - ensure at least 1 char when progress > 0
      const filledCount = progress === 0 ? 0 : Math.max(1, Math.round(progress / 2));
      const emptyCount = 10 - filledCount;
      const progressBar = '█'.repeat(filledCount) + '░'.repeat(emptyCount);

      let message = `🎁 **Program Referral**\n\n`;
      message += `Ajak teman kamu beli token dan dapatkan Voucher Gratis!\n\n`;

      message += `🎟️ **Kode Kamu:** \`${user.referralCode}\`\n`;
      message += `🔗 **Link:**\n\`${referralLink}\`\n\n`;

      message += `📊 **Statistik Kamu:**\n`;
      message += `✅ Referral Valid: **${stats.valid}** orang\n`;
      message += `⏳ Pending: **${stats.pending}** orang\n`;
      message += `💰 Total Earned: ${formatIdr(stats.totalEarned)}\n\n`;

      message += `🎯 **Progress Reward Selanjutnya:**\n`;
      message += `[${progressBar}] ${progress}/20\n`;

      if (progress === 0 && stats.valid > 0) {
        message += `🎉 _Selamat! Kamu baru saja mencapai milestone!_`;
      } else {
        message += `_(Kurang ${20 - progress} orang lagi untuk dapat Voucher tambahan!)_`;
      }

      await bot.sendMessage(chatId, message, {
        parse_mode: 'Markdown',
        reply_markup: mainMenuKeyboard(),
        disable_web_page_preview: true
      });

    } catch (error) {
      logger.error({ error }, 'Referral handler error');
      await bot.sendMessage(chatId, '❌ Gagal memuat data referral.', { reply_markup: mainMenuKeyboard() });
    }
  });
};
