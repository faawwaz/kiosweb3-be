import TelegramBot from 'node-telegram-bot-api';
import { logger } from '../../libs/logger.js';
import { backToMainKeyboard, getChainDisplay } from '../keyboards/main.keyboard.js';
import { ChainId, chains, supportedChains } from '../../config/chains.js';
import { formatUsd, formatIdr } from '../../utils/price.js';
import * as pricingService from '../../modules/pricing/pricing.service.js';

export const setupPriceHandler = (bot: TelegramBot): void => {
  // Handle "Check Price" button
  bot.on('callback_query', async (query) => {
    if (query.data !== 'price') return;

    const chatId = query.message?.chat.id;

    if (!chatId) return;

    try {
      const prices = await Promise.all(
        supportedChains.map(async (chainId) => {
          try {
            const price = await pricingService.getTokenPrice(chainId);
            return { chainId, price, error: null };
          } catch (err) {
            // Issue #28: Error isolation - single chain failure doesn't crash all
            logger.warn({ chainId, error: err }, 'Failed to fetch price for chain');
            return { chainId, price: null, error: err };
          }
        })
      );

      const usdIdrRate = await pricingService.getUsdIdrRate();
      const markup = await pricingService.getMarkupPercent();

      // Issue #19: Add timestamp
      const now = new Date();
      const timeStr = now.toLocaleTimeString('id-ID', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        timeZone: 'Asia/Jakarta'
      });

      let message = `📊 **Harga Saat Ini**\n`;
      message += `🕐 Update: ${timeStr} WIB\n\n`;

      for (const { chainId, price, error } of prices) {
        const chain = chains[chainId];

        if (error || !price) {
          message += `${getChainDisplay(chainId)}\n`;
          message += `└ ⚠️ _Gagal memuat harga_\n\n`;
          continue;
        }

        const priceIdr = price.mul(usdIdrRate);
        const effectivePrice = priceIdr.div(1 - markup / 100);

        message +=
          `${getChainDisplay(chainId)}\n` +
          `├ Harga Pasar: ${formatUsd(price)}\n` +
          `├ Kurs IDR: ${formatIdr(priceIdr.toNumber())}\n` +
          `└ Harga Jual: ${formatIdr(effectivePrice.toNumber())} _(+${markup}% fee)_\n\n`;
      }

      message += `💱 Kurs USD/IDR: ${formatIdr(usdIdrRate)}\n`;
      message += `\n💡 _Harga diperbarui setiap 60 detik_`;

      await bot.editMessageText(message, {
        chat_id: chatId,
        message_id: query.message?.message_id,
        parse_mode: 'Markdown',
        reply_markup: backToMainKeyboard(),
      });

      await bot.answerCallbackQuery(query.id);
    } catch (error) {
      logger.error({ error }, 'Price handler error');
      await bot.answerCallbackQuery(query.id, { text: 'Gagal memuat harga' });
    }
  });
};
