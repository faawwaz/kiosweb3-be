import TelegramBot from 'node-telegram-bot-api';
import { logger } from '../../libs/logger.js';
import { mainMenuKeyboard, backKeyboard, settingsKeyboard } from '../keyboards/reply.keyboard.js';
import { getState, updateState } from '../state.js';
import * as usersService from '../../modules/users/users.service.js';

export const setupSettingsHandler = (bot: TelegramBot): void => {

  // Handle "Settings" / Input
  bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;

    const chatId = msg.chat.id;
    const telegramId = String(msg.from?.id);
    const text = msg.text.trim();

    try {
      const state = await getState(telegramId);

      // ENTRY: Settings Menu
      if (text === '⚙️ Pengaturan') {
        const user = await usersService.findUserByTelegramId(telegramId);
        if (!user) return; // Should not happen if logged in

        const info = `⚙️ **Pengaturan Akun**\n\n` +
          `👤 Nama: ${user.name || 'Belum set'}\n` +
          `📧 Email: ${user.email || 'Belum link'}\n` +
          `📆 Gabung: ${new Date(user.createdAt).toLocaleDateString('id-ID')}\n\n` +
          `Apa yang ingin diubah?`;

        await bot.sendMessage(chatId, info, {
          parse_mode: 'Markdown',
          reply_markup: settingsKeyboard()
        });
        return;
      }

      // STATE: AWAITING CHANGE EMAIL
      if (state.step === 'awaiting_change_email') {
        // Logic for changing email (separate from Auth registration)
        // For now, let's keep it simple or implement if requested.
        // To fix the bug, we just ensure we DON'T listen to 'awaiting_email'
        return;
      }

    } catch (error) {
      logger.error({ error }, 'Settings handler error');
    }
  });
};
