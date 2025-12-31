import TelegramBot from 'node-telegram-bot-api';
import { logger } from '../../libs/logger.js';
import {
  mainMenuKeyboard,
  chainSelectionKeyboard,
  amountSelectionKeyboard,
  confirmationKeyboard,
  backKeyboard,
  getChainButtonText,
  paymentMethodKeyboard,
  checkPaymentInlineKeyboardWithCancel
} from '../keyboards/reply.keyboard.js';
import { getState, updateState, resetState, refreshStateTTL, ConversationState, acquireUserLock, releaseUserLock } from '../state.js';
import { formatIdr, formatTokenAmount } from '../../utils/price.js';
import * as usersService from '../../modules/users/users.service.js';
import * as pricingService from '../../modules/pricing/pricing.service.js';
import * as inventoryService from '../../modules/inventory/inventory.service.js';
import * as ordersService from '../../modules/orders/orders.service.js';
import * as blockchainService from '../../modules/blockchain/blockchain.service.js';
import * as vouchersService from '../../modules/vouchers/vouchers.service.js';
import { prisma } from '../../libs/prisma.js';
import { Decimal } from '@prisma/client/runtime/library.js';
import { enforceRateLimit } from '../middlewares/rate-limit.middleware.js';

// Constants for validation (Issue #3, #12)
const MIN_AMOUNT_IDR = 10000;
const MAX_AMOUNT_IDR = 50000000; // 50 juta max
const ETH_MAINNET_MIN_AMOUNT = 500000; // Issue #3: ETH Mainnet min Rp 500K

export const setupBuyHandler = (bot: TelegramBot): void => {

  bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;

    const chatId = msg.chat.id;
    const telegramId = String(msg.from?.id);
    const text = msg.text.trim();

    // Issue #10: Null check for telegramId
    if (!telegramId || telegramId === 'undefined') {
      logger.warn({ chatId }, 'Message received without valid telegramId');
      return;
    }

    try {
      const state = await getState(telegramId);

      // --- 0. CHECK PENDING ORDER (BLOCK NEW CREATION) ---
      if (text === '💰 Beli Token') {
        // Issue #8: Rate limiting for order creation
        const rateLimitError = await enforceRateLimit(telegramId, 'order');
        if (rateLimitError) {
          await bot.sendMessage(chatId, rateLimitError, { parse_mode: 'Markdown' });
          return;
        }

        const user = await usersService.findUserByTelegramId(telegramId);

        // AUTH CHECK
        if (!user) {
          await bot.sendMessage(chatId,
            `⚠️ **Akun Belum Terdaftar**\n\nMaaf, Anda harus mendaftar atau login terlebih dahulu untuk bertransaksi.\n\n👇 Silakan ketik perintah ini:\n\n/start`,
            { parse_mode: 'Markdown' }
          );
          return;
        }

        // Issue #1: Atomic check for pending orders using distributed lock
        const lockValue = await acquireUserLock(telegramId, 'buy_flow', 30);
        if (!lockValue) {
          await bot.sendMessage(chatId,
            '⚠️ **Proses Sedang Berjalan**\n\nMohon tunggu proses sebelumnya selesai.',
            { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard() }
          );
          return;
        }

        try {
          const pending = await prisma.order.findFirst({
            where: { userId: user.id, status: 'PENDING' }
          });

          if (pending) {
            await bot.sendMessage(chatId,
              '⚠️ **Aktivitas Tertunda**\n\nAnda masih memiliki pesanan yang belum dibayar. Harap selesaikan atau batalkan pesanan tersebut sebelum membuat baru.\n\nKlik tombol **👀 Lihat Order Aktif** di menu utama.',
              { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard() }
            );
            return;
          }

          await updateState(telegramId, { step: 'awaiting_chain' });
          const keyboard = await chainSelectionKeyboard();
          await bot.sendMessage(chatId, '🔗 **Pilih Jaringan Blockchain:**\n\nMau beli token di jaringan mana Kak?', {
            parse_mode: 'Markdown',
            reply_markup: keyboard,
          });
        } finally {
          await releaseUserLock(telegramId, 'buy_flow', lockValue);
        }
        return;
      }

      // --- HANDLE "KEMBALI" GLOBAL ---
      if (text === '🔙 Kembali' || text === '🔙 Kembali ke Menu Utama') {
        if (state.step === 'awaiting_voucher') {
          const user = await usersService.findUserByTelegramId(telegramId);
          if (user) await showConfirmationScreen(bot, chatId, telegramId, state, user.id);
          return;
        }

        await resetState(telegramId);
        await bot.sendMessage(chatId, '🏠 Menu Utama', { reply_markup: mainMenuKeyboard() });
        return;
      }

      // --- STATE: AWAITING CHAIN ---
      if (state.step === 'awaiting_chain') {
        const chains = await prisma.chain.findMany({ where: { isActive: true } });
        const selectedChainConfig = chains.find(c => getChainButtonText(c.name, c.type as any) === text);

        if (!selectedChainConfig) {
          const keyboard = await chainSelectionKeyboard();
          await bot.sendMessage(chatId, '❌ Pilih jaringan dari tombol di bawah ya Kak:', { reply_markup: keyboard });
          return;
        }

        const nativeToken = await prisma.token.findFirst({
          where: { chainId: selectedChainConfig.id, isNative: true }
        });

        let limitMsg = '';
        // Issue #3: Show minimum for ETH Mainnet
        if (selectedChainConfig.slug === 'eth') {
          limitMsg = `\n⚠️ **Minimal Pembelian:** ${formatIdr(ETH_MAINNET_MIN_AMOUNT)} (karena tingginya biaya gas ETH Mainnet)`;
        }

        if (nativeToken) {
          const available = await inventoryService.getAvailableBalance(selectedChainConfig.slug, nativeToken.symbol);
          const rate = await pricingService.getUsdIdrRate();
          const pair = `${nativeToken.symbol.toUpperCase()}USDT`;
          const binanceWsService = await import('../../modules/pricing/binance-ws.service.js');
          const price = binanceWsService.getPrice(pair);

          if (price && rate && available.greaterThan(0)) {
            const maxIdr = Math.floor(available.toNumber() * price * rate);
            limitMsg += `\n(Maksimal Pembelian: ${formatIdr(maxIdr)})`;
          }
        }

        await updateState(telegramId, { step: 'awaiting_amount', chain: selectedChainConfig.slug });
        await bot.sendMessage(chatId, `💰 **Beli ${text}**\n\nMau beli nominal berapa Rupiah?${limitMsg}`, {
          parse_mode: 'Markdown',
          reply_markup: amountSelectionKeyboard(),
        });
        return;
      }

      // --- STATE: AWAITING AMOUNT ---
      if (state.step === 'awaiting_amount') {
        if (text === '🖊️ Input Manual') {
          await updateState(telegramId, { step: 'awaiting_custom_amount' });
          // Issue #3: Show ETH minimum if applicable
          const minDisplay = state.chain === 'eth' ? formatIdr(ETH_MAINNET_MIN_AMOUNT) : 'Rp 10.000';
          await bot.sendMessage(chatId, `🖊️ **Input Nominal Manual**\n\nKetik nominal Rupiah (Min ${minDisplay}). Contoh: \`150000\``, {
            parse_mode: 'Markdown',
            reply_markup: backKeyboard()
          });
          return;
        }

        // Issue #12: Better amount parsing
        const amountIdr = parseAmount(text);

        if (amountIdr === null) {
          await bot.sendMessage(chatId, '❌ Pilih nominal dari tombol yang ada atau Input Manual.');
          return;
        }

        // Issue #10: Null check for chain
        if (!state.chain) {
          await bot.sendMessage(chatId, '⚠️ Sesi kadaluarsa. Silakan ketik /start untuk memulai ulang.');
          await resetState(telegramId);
          return;
        }

        await processAmountSelection(bot, chatId, telegramId, state.chain, amountIdr);
        return;
      }

      // --- STATE: AWAITING CUSTOM AMOUNT ---
      if (state.step === 'awaiting_custom_amount') {
        // Issue #12: Better amount parsing with bounds check
        const amountIdr = parseAmount(text);

        if (amountIdr === null) {
          await bot.sendMessage(chatId, '❌ Nominal tidak valid. Ketik angka saja, contoh: 150000', { reply_markup: backKeyboard() });
          return;
        }

        // Issue #3: ETH Mainnet minimum check
        const minAmount = state.chain === 'eth' ? ETH_MAINNET_MIN_AMOUNT : MIN_AMOUNT_IDR;

        if (amountIdr < minAmount) {
          const minDisplay = formatIdr(minAmount);
          const reason = state.chain === 'eth' ? ' (karena tingginya biaya gas ETH Mainnet)' : '';
          await bot.sendMessage(chatId, `❌ Nominal terlalu kecil. Minimal ${minDisplay}${reason}.`, { reply_markup: backKeyboard() });
          return;
        }

        // Issue #12: Maximum amount validation
        if (amountIdr > MAX_AMOUNT_IDR) {
          await bot.sendMessage(chatId, `❌ Nominal terlalu besar. Maksimal ${formatIdr(MAX_AMOUNT_IDR)}.`, { reply_markup: backKeyboard() });
          return;
        }

        // Issue #10: Null check for chain
        if (!state.chain) {
          await bot.sendMessage(chatId, '⚠️ Sesi kadaluarsa. Silakan ketik /start untuk memulai ulang.');
          await resetState(telegramId);
          return;
        }

        await processAmountSelection(bot, chatId, telegramId, state.chain, amountIdr);
        return;
      }

      // --- STATE: AWAITING WALLET (MANUAL) ---
      if (state.step === 'awaiting_wallet') {
        const rawWalletAddress = text.trim();

        // Basic format validation first
        if (!/^0x[a-fA-F0-9]{40}$/.test(rawWalletAddress)) {
          await bot.sendMessage(chatId,
            '❌ **Format Wallet Salah!**\n\nAlamat wallet harus dimulai dengan `0x` dan diikuti 40 karakter hex.\nContoh: `0x123abc...`\n\nSilakan copy-paste ulang dari Metamask/TrustWallet Kakak.',
            { parse_mode: 'Markdown' }
          );
          return;
        }

        // NORMALIZE: Use ethers.js to validate and get proper checksum address
        let normalizedAddress: string;
        try {
          const { ethers } = await import('ethers');
          normalizedAddress = ethers.getAddress(rawWalletAddress);
        } catch (checksumError) {
          // STRICT VALIDATION: Do not accept invalid checksums
          await bot.sendMessage(chatId,
            '❌ **Alamat Wallet Tidak Valid!**\n\nChecksum (huruf besar/kecil) tidak sesuai. Mohon copy ulang alamat yang benar dari wallet Anda untuk menghindari kesalahan transfer.',
            { parse_mode: 'Markdown' }
          );
          return;
        }

        // Issue #10: Null check before proceeding
        if (!state.chain || !state.amountIdr) {
          await bot.sendMessage(chatId, '⚠️ Sesi kadaluarsa. Silakan ketik /start untuk memulai ulang.');
          await resetState(telegramId);
          return;
        }

        const newState = await updateState(telegramId, {
          step: 'awaiting_confirmation',
          walletAddress: normalizedAddress
        });
        const user = await usersService.findUserByTelegramId(telegramId);

        if (!user) {
          await bot.sendMessage(chatId, '⚠️ Sesi tidak valid. Silakan ketik /start untuk memulai ulang.');
          await resetState(telegramId);
          return;
        }

        // Add Warning Message before confirmation
        await bot.sendMessage(chatId,
          '⚠️ **PENTING:**\nPastikan alamat wallet yang Kakak masukkan mendukung jaringan **' + state.chain.toUpperCase() + '** (EVM Compatible).\n\n_Kesalahan alamat dapat menyebabkan aset hilang selamanya!_',
          { parse_mode: 'Markdown' }
        );

        await showConfirmationScreen(bot, chatId, telegramId, newState, user.id);
        return;
      }

      // --- STATE: AWAITING VOUCHER ---
      if (state.step === 'awaiting_voucher') {
        const code = text.toUpperCase();
        const user = await usersService.findUserByTelegramId(telegramId);
        if (!user) return;

        // Issue #10: Null check for amountIdr
        if (!state.amountIdr) {
          await bot.sendMessage(chatId, '⚠️ Sesi kadaluarsa. Silakan ketik /start untuk memulai ulang.');
          await resetState(telegramId);
          return;
        }

        try {
          const voucher = await vouchersService.validateVoucherPeek(code, user.id, state.amountIdr);
          const newState = await updateState(telegramId, {
            step: 'awaiting_confirmation',
            voucherCode: voucher.code
          });
          await bot.sendMessage(chatId, `✅ **Voucher ${voucher.code} Dipasang!**\nDiskon: ${formatIdr(voucher.value)}`, { parse_mode: 'Markdown' });
          await showConfirmationScreen(bot, chatId, telegramId, newState, user.id);

        } catch (error: any) {
          await bot.sendMessage(chatId, `❌ **Gagal:** ${error.message}\n\nSilakan coba kode lain atau klik Kembali.`, {
            parse_mode: 'Markdown',
            reply_markup: backKeyboard()
          });
        }
        return;
      }

      // --- STATE: AWAITING CONFIRMATION ---
      if (state.step === 'awaiting_confirmation') {
        if (text === '✅ Bayar Sekarang') {
          // Issue #8: Rate limit for order creation
          const rateLimitError = await enforceRateLimit(telegramId, 'order');
          if (rateLimitError) {
            await bot.sendMessage(chatId, rateLimitError);
            return;
          }
          await executeOrderCreation(bot, chatId, telegramId, state);
        } else if (text === '🎫 Input Voucher') {
          await updateState(telegramId, { step: 'awaiting_voucher' });
          await bot.sendMessage(chatId, '🎫 **Input Kode Voucher**\n\nKetik kode promo atau referral Anda:', {
            parse_mode: 'Markdown',
            reply_markup: backKeyboard()
          });
        } else if (text === '❌ Batal') {
          await resetState(telegramId);
          await bot.sendMessage(chatId, '❌ Pesanan dibatalkan.', { reply_markup: mainMenuKeyboard() });
        }
        return;
      }

      // --- STATE: AWAITING PAYMENT METHOD ---
      if (state.step === 'awaiting_payment_method') {
        if (!state.orderId) {
          // Issue #17: Better recovery message
          await bot.sendMessage(chatId, '⚠️ Sesi kadaluarsa. Silakan ketik /start untuk memulai ulang.');
          await resetState(telegramId);
          return;
        }

        if (text.includes('QRIS')) {
          await processPaymentGeneration(bot, chatId, telegramId, state.orderId, 'QRIS');
        } else if (text.includes('Virtual Account')) {
          await processPaymentGeneration(bot, chatId, telegramId, state.orderId, 'VA');
        } else if (text === '❌ Batal') {
          try {
            await ordersService.cancelOrder(state.orderId);
            await bot.sendMessage(chatId, '❌ Pesanan dan pembayaran dibatalkan.');
          } catch (e) {
            await bot.sendMessage(chatId, '❌ Dibatalkan.');
          }
          await resetState(telegramId);
          await bot.sendMessage(chatId, '🏠 Menu Utama', { reply_markup: mainMenuKeyboard() });
        } else {
          await bot.sendMessage(chatId, '❌ Pilih metode pembayaran dari menu di bawah.');
        }
        return;
      }

    } catch (error: any) {
      logger.error({ error, telegramId, text }, 'Buy Handler Error');

      try {
        await resetState(telegramId);
      } catch (resetErr) {
        logger.error({ error: resetErr, telegramId }, 'Failed to reset state after error');
      }

      // Issue #15: Consistent Indonesian error messages
      let errorMessage = '❌ Terjadi kesalahan. Silakan ketik /start untuk memulai ulang.';

      if (error.message?.includes('timeout')) {
        errorMessage = '❌ Koneksi timeout. Silakan coba lagi.';
      } else if (error.message?.includes('inventory') || error.message?.includes('Inventory')) {
        errorMessage = '❌ Stok sedang tidak tersedia. Silakan coba lagi nanti.';
      } else if (error.message?.includes('pending')) {
        errorMessage = '❌ Anda masih memiliki pesanan yang belum diselesaikan.';
      }

      try {
        await bot.sendMessage(chatId, errorMessage, { reply_markup: mainMenuKeyboard() });
      } catch (msgErr) {
        logger.error({ error: msgErr }, 'Failed to send error message to user');
      }
    }
  });
};


export const setupCheckStatusHandler = (bot: TelegramBot): void => {
  bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    await bot.sendMessage(chatId, 'ℹ️ Untuk cek status pesanan, silakan gunakan menu **📜 Riwayat**.', { parse_mode: 'Markdown' });
  });

  bot.on('message', async (msg) => {
    if (msg.text !== '👀 Lihat Order Aktif') return;
    const chatId = msg.chat.id;
    const telegramId = String(msg.from?.id);

    // Issue #10: Null check
    if (!telegramId || telegramId === 'undefined') return;

    try {
      await bot.sendChatAction(chatId, 'typing');
      const user = await usersService.findUserByTelegramId(telegramId);
      if (!user) return;

      const pendingOrder = await prisma.order.findFirst({
        where: { userId: user.id, status: 'PENDING' },
        orderBy: { createdAt: 'desc' }
      });

      if (!pendingOrder) {
        await bot.sendMessage(chatId, '✅ Tidak ada pesanan aktif saat ini.\nSilakan buat pesanan baru!', { reply_markup: mainMenuKeyboard() });
        return;
      }

      const method = pendingOrder.paymentMethod || 'QRIS';
      const createdTime = new Date(pendingOrder.createdAt).getTime();
      const expiryTime = createdTime + (15 * 60 * 1000); // 15 Minutes
      const remainingMs = expiryTime - Date.now();

      if (remainingMs <= 0) {
        await bot.sendMessage(chatId, '⚠️ Pesanan terakhir Anda sudah kadaluarsa.', { reply_markup: mainMenuKeyboard() });
        return;
      }

      const expiryDate = new Date(expiryTime);
      const expiryStr = expiryDate.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });

      const msgText = `🔔 **Order Aktif Ditemukan!**\n\n` +
        `💳 Tipe: ${method}\n` +
        `💰 Total: ${formatIdr(pendingOrder.totalPay || pendingOrder.amountIdr)}\n` +
        `⏳ **Batas Bayar:** ${expiryStr} WIB\n\n` +
        `Silakan lanjutkan pembayaran atau batalkan pesanan jika ingin membuat baru.`;

      const inlineKb = checkPaymentInlineKeyboardWithCancel(pendingOrder.id);

      if (method === 'QRIS' && pendingOrder.paymentUrl) {
        await bot.sendMessage(chatId, `${msgText}\n\n🔗 [Link Pembayaran](${pendingOrder.paymentUrl})`, {
          parse_mode: 'Markdown',
          reply_markup: inlineKb
        });
      } else {
        await bot.sendMessage(chatId, msgText, {
          parse_mode: 'Markdown',
          reply_markup: inlineKb
        });
      }

    } catch (e: any) {
      logger.error({ error: e }, 'Active order check failed');
    }
  });
};


// --- HELPER FUNCTIONS ---

/**
 * Issue #12: Robust amount parsing for Indonesian Rupiah
 * Handles various formats:
 * - "100.000" (ID format with dot thousand separator) -> 100000
 * - "100000" (plain number) -> 100000
 * - "Rp 100.000" (with currency prefix) -> 100000
 * - "100,000" (US format) -> 100000
 * - "Rp100.000,50" (with decimal - ignore decimal part) -> 100000
 *
 * Note: In Indonesian format, dot is thousand separator, comma is decimal
 * We only accept whole numbers for IDR transactions
 */
function parseAmount(text: string): number | null {
  // Trim and convert to lowercase for prefix removal
  let cleaned = text.trim();

  // Remove common currency prefixes
  cleaned = cleaned.replace(/^(rp\.?|idr)\s*/i, '');

  // Remove any remaining whitespace
  cleaned = cleaned.replace(/\s/g, '');

  // Handle Indonesian format: dots are thousand separators
  // e.g., "100.000" should be 100000, not 100
  // Check if the number looks like ID format (has dots but no comma before dot)
  const hasIdFormat = /^\d{1,3}(\.\d{3})+$/.test(cleaned);

  if (hasIdFormat) {
    // Indonesian format: remove dots (thousand separators)
    cleaned = cleaned.replace(/\./g, '');
  } else {
    // Could be US format with comma as thousand separator
    // or plain number with decimal dot
    // Remove comma thousand separators first
    cleaned = cleaned.replace(/,/g, '');

    // If there's a remaining dot, treat everything after as decimal (ignore it)
    const dotIndex = cleaned.indexOf('.');
    if (dotIndex !== -1) {
      cleaned = cleaned.substring(0, dotIndex);
    }
  }

  // Now we should have only digits
  if (!/^\d+$/.test(cleaned) || cleaned.length === 0) {
    return null;
  }

  const amount = parseInt(cleaned, 10);

  // Validate it's a sensible number (not zero, not negative, not absurdly large)
  if (isNaN(amount) || amount <= 0 || amount > 1_000_000_000_000) {
    return null;
  }

  return amount;
}


// --- LOGIC FUNCTIONS ---

async function processAmountSelection(
  bot: TelegramBot, chatId: number, telegramId: string,
  chain: string, amountIdr: number
) {
  try {
    await bot.sendChatAction(chatId, 'typing');

    // Issue #3: ETH Mainnet minimum check
    if (chain === 'eth' && amountIdr < ETH_MAINNET_MIN_AMOUNT) {
      await bot.sendMessage(chatId,
        `❌ **Nominal Terlalu Kecil**\n\nMinimal pembelian ETH di jaringan Ethereum Mainnet adalah ${formatIdr(ETH_MAINNET_MIN_AMOUNT)} karena tingginya biaya gas.\n\nSilakan pilih nominal yang lebih besar atau gunakan jaringan Base untuk fee lebih murah.`,
        { parse_mode: 'Markdown', reply_markup: backKeyboard() }
      );
      return;
    }

    const quote = await pricingService.getQuote(chain, amountIdr);
    const inventory = await inventoryService.getAvailableBalance(chain, quote.symbol);

    // Issue #14: Inventory check (note: final lock is in createOrder)
    if (quote.tokenAmount.greaterThan(inventory)) {
      const maxIdr = inventory.toNumber() * quote.tokenPriceUsd.toNumber() * quote.usdIdrRate;
      await bot.sendMessage(chatId,
        `❌ **Stok Tidak Mencukupi**\n\nMaaf Kak, stok ${quote.symbol} kami sedang menipis.\n\n` +
        `📊 Stok tersedia: ${formatTokenAmount(inventory)} ${quote.symbol}\n` +
        `💰 Maksimal bisa beli: ~${formatIdr(Math.floor(maxIdr))}`,
        { parse_mode: 'Markdown', reply_markup: backKeyboard() }
      );
      return;
    }

    await updateState(telegramId, { step: 'awaiting_wallet', amountIdr });
    await bot.sendMessage(chatId,
      `📊 **Estimasi Dapat:**\n${formatTokenAmount(quote.tokenAmount)} ${quote.symbol}\n\n🏠 **Mau dikirim kemana?**\nKetik alamat wallet (0x...) Kakak disini:`,
      { parse_mode: 'Markdown', reply_markup: backKeyboard() }
    );
  } catch (error) {
    logger.error({ error }, 'Quote Error');
    await bot.sendMessage(chatId, '❌ Gagal mengambil harga. Silakan coba lagi.');
  }
}

async function showConfirmationScreen(
  bot: TelegramBot, chatId: number, telegramId: string,
  state: ConversationState, userId: string
) {
  // Issue #10: Null checks
  if (!state.chain || !state.amountIdr || !state.walletAddress) {
    await bot.sendMessage(chatId, '⚠️ Data tidak lengkap. Silakan ketik /start untuk memulai ulang.');
    await resetState(telegramId);
    return;
  }

  const quote = await pricingService.getQuote(state.chain, state.amountIdr);

  // Estimate Gas Fee
  const gasNative = await blockchainService.estimateGasFeeNative(state.chain);
  const pricePerToken = new Decimal(state.amountIdr).div(quote.tokenAmount);
  const gasIdr = gasNative.mul(pricePerToken).toNumber();

  let discount = 0;
  let finalPrice = state.amountIdr;

  if (state.voucherCode) {
    try {
      const voucher = await vouchersService.validateVoucherPeek(state.voucherCode, userId, state.amountIdr);
      discount = voucher.value;
      finalPrice = Math.max(0, state.amountIdr - discount);
    } catch (e) {
      await updateState(telegramId, { voucherCode: undefined });
    }
  }

  await updateState(telegramId, {
    step: 'awaiting_confirmation',
    tokenAmount: quote.tokenAmount.toString()
  });

  let priceDisplay = `${formatIdr(state.amountIdr)}`;
  if (discount > 0) {
    priceDisplay = `~${formatIdr(state.amountIdr)}~ ➡️ *${formatIdr(finalPrice)}* 🎉`;
  }

  const msg = `📝 **Konfirmasi Pesanan**\n\n` +
    `• Network: ${state.chain.toUpperCase()}\n` +
    `• Bayar: ${priceDisplay}\n` +
    `• Dapat: ${formatTokenAmount(quote.tokenAmount)} ${quote.symbol}\n` +
    `• Ke: \`${state.walletAddress}\`\n\n` +
    `⛽ **Gas Fee:** ~${formatTokenAmount(gasNative)} ${quote.symbol} (${formatIdr(gasIdr)})\n` +
    `✅ _Biaya gas ditanggung oleh Admin._\n\n` +
    (state.voucherCode ? `🎫 Voucher: \`${state.voucherCode}\` (Hemat ${formatIdr(discount)})\n\n` : '') +
    `⚠️ _Jumlah token yang diterima dapat sedikit berubah menyesuaikan fluktuasi harga pasar jika pembayaran tertunda._\n\n` +
    `Sudah benar datanya Kak?`;

  await bot.sendMessage(chatId, msg, {
    parse_mode: 'Markdown',
    reply_markup: confirmationKeyboard()
  });
}

// 1. CREATE ORDER WITH LOCK (Issue #1)
async function executeOrderCreation(
  bot: TelegramBot, chatId: number, telegramId: string, state: ConversationState
) {
  // Issue #1: Acquire lock to prevent race condition
  const lockValue = await acquireUserLock(telegramId, 'create_order', 30);
  if (!lockValue) {
    await bot.sendMessage(chatId, '⚠️ Mohon tunggu, pesanan sedang diproses...');
    return;
  }

  try {
    await bot.sendChatAction(chatId, 'typing');
    const user = await usersService.findUserByTelegramId(telegramId);
    if (!user) throw new Error('User tidak ditemukan');

    // Issue #10: Null checks
    if (!state.chain || !state.amountIdr || !state.walletAddress) {
      throw new Error('Data tidak lengkap');
    }

    const quoteMetadata = await pricingService.getQuote(state.chain, state.amountIdr);

    // SLIPPAGE PROTECTION (Edge Case)
    // If output amount changed by > 5% since confirmation, abort to protect user/store.
    // This happens if price spiked/dumped in the few seconds between "Confirm" and "Create".
    if (state.tokenAmount) {
      const lockedAmount = new Decimal(state.tokenAmount);
      const currentAmount = quoteMetadata.tokenAmount;

      // Calculate % difference: abs(current - locked) / locked
      const diff = currentAmount.minus(lockedAmount).abs();
      const diffPercent = diff.div(lockedAmount).toNumber();

      if (diffPercent > 0.05) { // 5% Slippage Tolerance
        logger.warn({ telegramId, locked: lockedAmount.toString(), current: currentAmount.toString() }, 'Order blocked due to high slippage');
        await bot.sendMessage(chatId,
          '⚠️ **Harga Berubah Signifikan!**\n\nPasar sangat volatil saat ini. Harga berubah lebih dari 5% sejak Anda konfirmasi.\n\nSilakan ulangi pesanan untuk mendapatkan harga terbaru.',
          { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard() }
        );
        return;
      }
    }

    const finalAmountToken = state.tokenAmount ? new Decimal(state.tokenAmount) : quoteMetadata.tokenAmount;

    // Create Order (PENDING) - this has its own internal locking
    const order = await ordersService.createOrder({
      userId: user.id,
      chain: state.chain,
      symbol: quoteMetadata.symbol,
      amountIdr: state.amountIdr,
      amountToken: finalAmountToken,
      markupPercent: quoteMetadata.markupPercent,
      walletAddress: state.walletAddress,
      voucherCode: state.voucherCode
    });

    await refreshStateTTL(telegramId);

    await updateState(telegramId, {
      step: 'awaiting_payment_method',
      orderId: order.id
    });

    // Issue #18: Better payment method explanation
    const msg = `✅ **Pesanan Dibuat!** (ID: \`${order.id.slice(-6)}\`)\n\n` +
      `Silakan pilih metode pembayaran:\n\n` +
      `🔥 **QRIS** - Gratis biaya admin!\n` +
      `🏦 **Virtual Account** - Biaya admin Rp 4.000\n\n` +
      `⭐ **Rekomendasi:** Gunakan QRIS`;

    await bot.sendMessage(chatId, msg, {
      parse_mode: 'Markdown',
      reply_markup: paymentMethodKeyboard()
    });

  } catch (error: any) {
    logger.error({ error }, 'Order Creation Error');

    // Issue #15: Consistent Indonesian error messages
    let errMsg = '❌ Gagal membuat pesanan. Silakan coba lagi.';

    if (error.message?.includes('pending')) {
      errMsg = '❌ Anda masih memiliki pesanan yang belum diselesaikan.';
    } else if (error.message?.includes('Voucher')) {
      errMsg = `❌ **Voucher Error:** ${error.message}`;
    } else if (error.message?.includes('inventory') || error.message?.includes('Inventory')) {
      errMsg = '❌ Stok tidak mencukupi. Silakan coba nominal yang lebih kecil.';
    }

    await bot.sendMessage(chatId, errMsg, { parse_mode: 'Markdown' });
  } finally {
    await releaseUserLock(telegramId, 'create_order', lockValue);
  }
}

// 2. GENERATE PAYMENT
async function processPaymentGeneration(
  bot: TelegramBot, chatId: number, telegramId: string,
  orderId: string, method: 'QRIS' | 'VA'
) {
  try {
    await bot.sendChatAction(chatId, 'typing');

    const result = await ordersService.createPayment(orderId, method);

    await resetState(telegramId);

    // Issue #18: Show fee explanation
    const feeNote = method === 'QRIS' ? ' (Bebas Biaya Admin!)' : ` (Termasuk biaya admin ${formatIdr(result.fee)})`;

    const baseMsg = `✅ **Tagihan Siap!**\n\n` +
      `💳 Metode: ${method}\n` +
      `💰 Total: ${formatIdr(result.total)}${feeNote}`;

    const inlineKb = checkPaymentInlineKeyboardWithCancel(orderId);

    // Calculate Expiry (15 Minutes)
    const expiryDate = new Date(Date.now() + 15 * 60 * 1000);
    const expiryStr = expiryDate.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    const expiryWarning = `\n\n⏳ **Batas Waktu:** ${expiryStr} WIB (15 Menit)\n⚠️ **PENTING:** Jika lewat dari jam tersebut, mohon JANGAN TRANSFER karena pesanan akan otomatis dibatalkan sistem.`;

    if (method === 'QRIS' && result.qrImage) {
      const isUrl = result.qrImage.startsWith('http');
      const caption = `${baseMsg}${expiryWarning}\n\n📸 **Scan QR Code di atas** dengan aplikasi e-wallet apa saja (GoPay, OVO, Dana, BCA, dll).`;

      if (isUrl) {
        await bot.sendPhoto(chatId, result.qrImage, {
          caption,
          reply_markup: inlineKb
        });
      } else {
        const base64Data = result.qrImage.replace(/^data:image\/png;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');
        await bot.sendPhoto(chatId, buffer, {
          caption,
          reply_markup: inlineKb
        });
      }

    } else if (result.paymentUrl) {
      const msg = `${baseMsg}${expiryWarning}\n\n🔗 **Klik Link untuk Bayar:**\n${result.paymentUrl}`;
      await bot.sendMessage(chatId, msg, {
        parse_mode: 'Markdown',
        reply_markup: inlineKb
      });
    }

    await bot.sendMessage(chatId, '👇 Menu Utama', { reply_markup: mainMenuKeyboard() });

  } catch (error: any) {
    logger.error({ error }, 'Payment Gen Error');
    await bot.sendMessage(chatId, '❌ Gagal membuat tagihan. Silakan cek menu **📜 Riwayat** untuk mencoba lagi.', { parse_mode: 'Markdown' });
  }
}
