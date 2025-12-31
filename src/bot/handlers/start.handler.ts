import TelegramBot from 'node-telegram-bot-api';
import { logger } from '../../libs/logger.js';
import { mainMenuKeyboard, welcomeAuthInlineKeyboard } from '../keyboards/reply.keyboard.js';
import { resetState, updateState } from '../state.js';
import * as usersService from '../../modules/users/users.service.js';

export const setupStartHandler = (bot: TelegramBot): void => {
  // Handle /start command
  bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const telegramId = String(msg.from?.id);
    const referralCode = match?.[1];

    try {
      // Check if user exists
      const user = await usersService.findUserByTelegramId(telegramId);

      if (user) {
        // EXISTING USER -> Main Menu
        // Force Reset State to ensure clean slate from any stuck state
        await resetState(telegramId);

        const welcomeBack = `👋 *Halo Kak ${(user as any).name || 'User'}!* \n\n` +
          `Selamat datang kembali di KiosWeb3. Mau transaksi apa hari ini?\n\n` +
          `👇 **Silakan pilih menu di bawah:**\n\n` +
          `ℹ️ **Bingung cara pakainya?**\nKlik /help untuk melihat panduan lengkap fungsi tombol di dashboard ini.`;

        await bot.sendMessage(chatId, welcomeBack, {
          parse_mode: 'Markdown',
          reply_markup: mainMenuKeyboard(),
        });
      } else {
        // NEW USER -> Show Choice
        // Clean state first
        await resetState(telegramId);
        // Save referral code if any
        if (referralCode) {
          await updateState(telegramId, { regReferral: referralCode });
        }

        const welcomeMsg = `👋 **Selamat Datang di KiosWeb3!**\n\n` +
          `🤖 Bot ini adalah solusi termudah buat Kakak yang mau beli aset crypto secara **Eceran** (Nominal Kecil) tanpa ribet daftar exchange!\n\n` +
          `🚀 **Fitur Utama:**\n` +
          `• Beli mulai Rp 10.000\n` +
          `• Fee Transaksi Murah & Transparan\n` +
          `• Support QRIS & Virtual Account\n` +
          `• Kirim langsung ke Wallet Pribadi (Metamask/TrustWallet)\n\n` +
          `🛡️ _Aman & Terpercaya sejak 2025_\n\n` +
          `👇 **Langkah Pertama:**\nSilakan pilih salah satu menu di bawah ini untuk memulai akses:`;

        await bot.sendMessage(chatId, welcomeMsg, {
          parse_mode: 'Markdown',
          reply_markup: welcomeAuthInlineKeyboard()
        });
      }
    } catch (error) {
      logger.error({ error, telegramId }, 'Start handler error');
      await bot.sendMessage(chatId, '❌ Maaf ada gangguan sistem. Silakan coba lagi nanti.');
    }
  });
};
