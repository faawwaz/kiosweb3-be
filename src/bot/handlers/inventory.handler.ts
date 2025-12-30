import TelegramBot from 'node-telegram-bot-api';
import { logger } from '../../libs/logger.js';
import { mainMenuKeyboard } from '../keyboards/reply.keyboard.js';
import { formatTokenAmount, formatIdr } from '../../utils/price.js';
import * as inventoryService from '../../modules/inventory/inventory.service.js';
import { prisma } from '../../libs/prisma.js';
import * as binanceWsService from '../../modules/pricing/binance-ws.service.js';
import * as pricingService from '../../modules/pricing/pricing.service.js';

// Issue #26: Cache chain config to avoid repeated DB calls
let chainConfigCache: Map<string, { name: string; slug: string }> | null = null;
let chainCacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getChainMap(): Promise<Map<string, { name: string; slug: string }>> {
  const now = Date.now();
  if (!chainConfigCache || (now - chainCacheTime > CACHE_TTL)) {
    const chains = await prisma.chain.findMany({
      select: { slug: true, name: true }
    });
    chainConfigCache = new Map(chains.map(c => [c.slug, { name: c.name, slug: c.slug }]));
    chainCacheTime = now;
  }
  return chainConfigCache;
}

export const setupInventoryHandler = (bot: TelegramBot): void => {
  // Handle "Cek Stok" Text Input
  bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;

    const text = msg.text.trim();
    if (text !== '📦 Cek Stok' && text !== '/stock') return;

    const chatId = msg.chat.id;
    const telegramId = String(msg.from?.id);

    // Issue #10: Null check
    if (!telegramId || telegramId === 'undefined') return;

    // AUTH CHECK
    const user = await prisma.user.findUnique({ where: { telegramId } });
    if (!user) {
      await bot.sendMessage(chatId,
        `⚠️ **Akun Belum Terdaftar**\n\nSilakan daftar atau login terlebih dahulu.\n\n👉 Ketik /start untuk memulai.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    try {
      await bot.sendChatAction(chatId, 'typing');

      const inventories = await inventoryService.getAllInventory();
      const chainMap = await getChainMap(); // Issue #26: Use cached chain config

      // Fetch USD-IDR Rate
      const rate = await pricingService.getUsdIdrRate();

      // Issue #19: Add timestamp
      const now = new Date();
      const timeStr = now.toLocaleTimeString('id-ID', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Jakarta'
      });

      let message = `📊 **Stok & Estimasi Harga**\n`;
      message += `🕐 Update: ${timeStr} WIB\n\n`;

      let highDemand = false;

      if (inventories.length === 0) {
        message += `📭 _Belum ada data inventaris._`;
      } else {
        // Sort: Non-Zero balance first, then alphabetical
        inventories.sort((a, b) => {
          const balA = Number(a.balance);
          const balB = Number(b.balance);
          if (balA === 0 && balB > 0) return 1;
          if (balB === 0 && balA > 0) return -1;
          return a.chain.localeCompare(b.chain);
        });

        for (const inv of inventories) {
          const available = Number(inv.balance) - Number(inv.reserved);
          const reserved = Number(inv.reserved);

          // Dynamic pair format
          const pair = `${inv.symbol.toUpperCase()}USDT`;
          const tokenPriceUsd = binanceWsService.getPrice(pair);

          const estIdr = available * tokenPriceUsd * rate;

          // Status based on IDR value
          let statusStr = '';
          let statusIcon = '';
          if (estIdr > 500000) {
            statusStr = 'Stok Banyak';
            statusIcon = '✅';
          } else if (estIdr > 100000) {
            statusStr = 'Stok Cukup';
            statusIcon = '🟡';
          } else if (estIdr > 10000) {
            statusStr = 'Terbatas';
            statusIcon = '🔥';
            highDemand = true;
          } else {
            statusStr = 'Habis (Restock Soon)';
            statusIcon = '🔴';
          }

          const chainInfo = chainMap.get(inv.chain);
          const chainName = chainInfo?.name || inv.chain.toUpperCase();
          const displayIdr = estIdr > 0 ? `~${formatIdr(estIdr)}` : 'Rp 0';

          message += `${statusIcon} **${chainName}**\n`;
          message += `   • Tersedia: **${formatTokenAmount(available)} ${inv.symbol}**\n`;
          message += `   • Estimasi: ${displayIdr}\n`;

          if (reserved > 0) {
            message += `   • Sedang Diproses: ${formatTokenAmount(reserved)} ${inv.symbol}\n`;
          }

          message += `   ${statusStr}\n\n`;
        }
      }

      message += `💡 _Harga estimasi real-time. Dapat berubah sewaktu-waktu._\n`;
      if (highDemand) {
        message += `⚡ **Stok cepat berubah!** Segera amankan token Anda.`;
      }

      await bot.sendMessage(chatId, message, {
        parse_mode: 'Markdown',
        reply_markup: mainMenuKeyboard(),
      });

    } catch (error) {
      logger.error({ error }, 'Inventory handler error');
      await bot.sendMessage(chatId, '❌ Gagal cek stok. Silakan coba lagi nanti.', { reply_markup: mainMenuKeyboard() });
    }
  });
};
