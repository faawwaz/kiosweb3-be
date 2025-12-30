import { InlineKeyboardButton, InlineKeyboardMarkup } from 'node-telegram-bot-api';
import { ChainId, chains } from '../../config/chains.js';

/**
 * Main menu keyboard
 */
export const mainMenuKeyboard = (): InlineKeyboardMarkup => ({
  inline_keyboard: [
    [
      { text: '💰 Buy Token', callback_data: 'buy' },
      { text: '📊 Check Price', callback_data: 'price' },
    ],
    [
      { text: '📦 Inventory', callback_data: 'inventory' },
      { text: '🎟️ Voucher', callback_data: 'voucher' },
    ],
    [
      { text: '👥 Referral', callback_data: 'referral' },
      { text: '📜 History', callback_data: 'history' },
    ],
    [{ text: '⚙️ Settings', callback_data: 'settings' }],
  ],
});

/**
 * Chain selection keyboard
 */
export const chainSelectionKeyboard = (): InlineKeyboardMarkup => ({
  inline_keyboard: [
    [
      { text: '🔶 BNB (BSC)', callback_data: 'chain:bsc' },
    ],
    [
      { text: '💎 ETH (Ethereum)', callback_data: 'chain:eth' },
    ],
    [
      { text: '🔵 ETH (Base)', callback_data: 'chain:base' },
    ],
    [{ text: '« Back', callback_data: 'main_menu' }],
  ],
});

/**
 * Amount selection keyboard (predefined amounts in IDR)
 */
export const amountSelectionKeyboard = (chain: ChainId): InlineKeyboardMarkup => ({
  inline_keyboard: [
    [
      { text: 'Rp 50.000', callback_data: `amount:${chain}:50000` },
      { text: 'Rp 100.000', callback_data: `amount:${chain}:100000` },
    ],
    [
      { text: 'Rp 250.000', callback_data: `amount:${chain}:250000` },
      { text: 'Rp 500.000', callback_data: `amount:${chain}:500000` },
    ],
    [
      { text: 'Rp 1.000.000', callback_data: `amount:${chain}:1000000` },
      { text: 'Custom', callback_data: `amount:${chain}:custom` },
    ],
    [{ text: '« Back', callback_data: 'buy' }],
  ],
});

/**
 * Confirmation keyboard
 */
export const confirmationKeyboard = (orderId: string): InlineKeyboardMarkup => ({
  inline_keyboard: [
    [
      { text: '✅ Confirm & Pay', callback_data: `confirm:${orderId}` },
      { text: '❌ Cancel', callback_data: 'cancel_order' },
    ],
  ],
});

/**
 * Back to main menu keyboard
 */
export const backToMainKeyboard = (): InlineKeyboardMarkup => ({
  inline_keyboard: [[{ text: '« Back to Menu', callback_data: 'main_menu' }]],
});

/**
 * Payment status keyboard
 */
export const paymentKeyboard = (paymentUrl: string): InlineKeyboardMarkup => ({
  inline_keyboard: [
    [{ text: '💳 Pay Now', url: paymentUrl }],
    [{ text: '🔄 Check Status', callback_data: 'check_payment' }],
    [{ text: '« Back to Menu', callback_data: 'main_menu' }],
  ],
});

/**
 * History navigation keyboard
 */
export const historyNavigationKeyboard = (
  page: number,
  hasMore: boolean
): InlineKeyboardMarkup => {
  const buttons: InlineKeyboardButton[][] = [];

  const navRow: InlineKeyboardButton[] = [];
  if (page > 0) {
    navRow.push({ text: '« Previous', callback_data: `history:${page - 1}` });
  }
  if (hasMore) {
    navRow.push({ text: 'Next »', callback_data: `history:${page + 1}` });
  }

  if (navRow.length > 0) {
    buttons.push(navRow);
  }

  buttons.push([{ text: '« Back to Menu', callback_data: 'main_menu' }]);

  return { inline_keyboard: buttons };
};

/**
 * Settings keyboard
 */
export const settingsKeyboard = (): InlineKeyboardMarkup => ({
  inline_keyboard: [
    [{ text: '🔗 Link Email', callback_data: 'settings:link_email' }],
    [{ text: '« Back to Menu', callback_data: 'main_menu' }],
  ],
});

/**
 * Get chain emoji and name
 */
export const getChainDisplay = (chainId: ChainId): string => {
  const emojis: Record<ChainId, string> = {
    bsc: '🔶',
    eth: '💎',
    base: '🔵',
  };
  const chain = chains[chainId];
  return `${emojis[chainId]} ${chain.symbol} (${chain.name})`;
};
