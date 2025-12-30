import TelegramBot from 'node-telegram-bot-api';
import { env } from '../config/env.js';
import { logger } from '../libs/logger.js';
import { setupStartHandler } from './handlers/start.handler.js';
import { setupBuyHandler, setupCheckStatusHandler } from './handlers/buy.handler.js';
import { setupPriceHandler } from './handlers/price.handler.js';
import { setupInventoryHandler } from './handlers/inventory.handler.js';
import { setupVoucherHandler } from './handlers/voucher.handler.js';
import { setupReferralHandler } from './handlers/referral.handler.js';
import { setupHistoryHandler } from './handlers/history.handler.js';
import { setupSettingsHandler } from './handlers/settings.handler.js';
import { setupHelpHandler } from './handlers/help.handler.js';
import { setupAuthHandler } from './handlers/auth.handler.js';
import { setupCallbackHandler } from './handlers/callback.handler.js';

let bot: TelegramBot | null = null;

export const getBot = (): TelegramBot => {
  if (!bot) {
    throw new Error('Bot not initialized');
  }
  return bot;
};

export const initBot = async (): Promise<void> => {
  if (bot) {
    logger.warn('Bot already initialized');
    return;
  }

  bot = new TelegramBot(env.TELEGRAM_BOT_TOKEN, {
    polling: env.NODE_ENV === 'development',
  });

  // Set Bot Commands
  await bot.setMyCommands([
    { command: '/start', description: 'Mulai Ulang / Menu Utama' },
    { command: '/help', description: 'Bantuan & Panduan' }
  ]);

  // Setup handlers
  setupStartHandler(bot);
  setupBuyHandler(bot);
  setupCheckStatusHandler(bot);
  setupPriceHandler(bot);
  setupInventoryHandler(bot);
  setupVoucherHandler(bot);
  setupReferralHandler(bot);
  setupHistoryHandler(bot);
  setupSettingsHandler(bot);
  setupHelpHandler(bot);
  setupAuthHandler(bot);
  setupCallbackHandler(bot); // Register Global Callbacks

  // Error handling
  bot.on('polling_error', (error) => {
    logger.error({ error: error.message }, 'Telegram polling error');
  });

  bot.on('error', (error) => {
    logger.error({ error: error.message }, 'Telegram bot error');
  });

  logger.info('Telegram bot initialized');
};

export default bot;
