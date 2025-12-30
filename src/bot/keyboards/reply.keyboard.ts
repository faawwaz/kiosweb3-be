import { ReplyKeyboardMarkup, KeyboardButton, InlineKeyboardMarkup } from 'node-telegram-bot-api';
import { prisma } from '../../libs/prisma.js';

// --- MENU UTAMA ---
export const mainMenuKeyboard = (): ReplyKeyboardMarkup => {
    return {
        keyboard: [
            [{ text: '💰 Beli Token' }, { text: '📦 Cek Stok' }],
            [{ text: '👀 Lihat Order Aktif' }, { text: '📜 Riwayat' }],
            [{ text: '🎁 Referral' }, { text: '⚙️ Pengaturan' }, { text: '🆘 Bantuan' }],
        ],
        resize_keyboard: true,
        one_time_keyboard: false,
    };
};

/**
 * GENERATE CHAIN BUTTON TEXT
 */
export const getChainButtonText = (name: string, type: 'EVM' | 'SOLANA' | 'SUI' | 'TON'): string => {
    // Basic Icon Mapping based on Type or Name
    let icon = '🔗';
    const n = name.toLowerCase();

    // if (n.includes('bnb') || n.includes('bsc')) icon = '🟡';
    // else if (n.includes('eth') || n.includes('base')) icon = '🔵';
    // else if (n.includes('solana')) icon = '🟣';
    // else if (n.includes('sui')) icon = '💧';
    // else if (n.includes('polygon') || n.includes('matic')) icon = '💜';

    return `${icon} ${name}`;
};

// --- MENU PILIH CHAIN (DYNAMIC) ---
export const chainSelectionKeyboard = async (): Promise<ReplyKeyboardMarkup> => {
    // Fetch active chains from DB
    const chains = await prisma.chain.findMany({
        where: { isActive: true },
        orderBy: { name: 'asc' }
    });

    // Layout: 2 buttons per row
    const buttons: KeyboardButton[][] = [];
    let currentRow: KeyboardButton[] = [];

    chains.forEach((chain, index) => {
        const text = getChainButtonText(chain.name, chain.type as any);
        currentRow.push({ text });

        if (currentRow.length === 2) {
            buttons.push(currentRow);
            currentRow = [];
        }
    });

    if (currentRow.length > 0) {
        buttons.push(currentRow);
    }

    buttons.push([{ text: '🔙 Kembali ke Menu Utama' }]);

    return {
        keyboard: buttons,
        resize_keyboard: true,
    };
};



// --- MENU PILIH NOMINAL ---
export const amountSelectionKeyboard = (): ReplyKeyboardMarkup => {
    return {
        keyboard: [
            [{ text: '10.000' }, { text: '25.000' }, { text: '50.000' }],
            [{ text: '100.000' }, { text: '250.000' }, { text: '500.000' }],
            [{ text: '🖊️ Input Manual' }],
            [{ text: '🔙 Kembali' }],
        ],
        resize_keyboard: true,
    };
};

// --- MENU KONFIRMASI ---
export const confirmationKeyboard = (): ReplyKeyboardMarkup => {
    return {
        keyboard: [
            [{ text: '✅ Bayar Sekarang' }],
            [{ text: '🎫 Input Voucher' }],
            [{ text: '❌ Batal' }],
        ],
        resize_keyboard: true,
        one_time_keyboard: true,
    };
};

// --- MENU STATIS LAIN ---
export const cancelKeyboard = (): ReplyKeyboardMarkup => {
    return { keyboard: [[{ text: '❌ Batal' }]], resize_keyboard: true, one_time_keyboard: true };
};

export const backKeyboard = (): ReplyKeyboardMarkup => {
    return { keyboard: [[{ text: '🔙 Kembali' }]], resize_keyboard: true, one_time_keyboard: true };
};

export const settingsKeyboard = (): ReplyKeyboardMarkup => {
    return { keyboard: [[{ text: '📧 Ganti Email' }], [{ text: '🔙 Kembali' }]], resize_keyboard: true };
};

export const welcomeAuthInlineKeyboard = (): InlineKeyboardMarkup => {
    return {
        inline_keyboard: [
            [{ text: '📝 Daftar Baru', callback_data: 'auth_register' }],
            [{ text: '🔗 Sambungkan Akun Web', callback_data: 'auth_link' }]
        ]
    };
};

// --- MENU METODE PEMBAYARAN (NEW) ---
export const paymentMethodKeyboard = (): ReplyKeyboardMarkup => {
    return {
        keyboard: [
            [{ text: '🔥 QRIS (Bebas Biaya Admin)' }],
            [{ text: '🏦 Virtual Account (Admin Rp 4.000)' }],
            [{ text: '❌ Batal' }] // Bisa batal bayar -> Cancel order
        ],
        resize_keyboard: true,
        one_time_keyboard: true
    };
};

// --- CEK STATUS PEMBAYARAN (INLINE) ---
// export const checkPaymentInlineKeyboard = (orderId: string): InlineKeyboardMarkup => {
//     return {
//         inline_keyboard: [
//             [{ text: '🔄 Cek Status Pembayaran (Refresh)', callback_data: `check_payment:${orderId}` }]
//         ]
//     };
// };

export const checkPaymentInlineKeyboardWithCancel = (orderId: string): InlineKeyboardMarkup => {
    return {
        inline_keyboard: [
            [{ text: '🔄 Cek Status (Refresh)', callback_data: `check_payment:${orderId}` }],
            [{ text: '❌ Batalkan Pesanan', callback_data: `cancel_order:${orderId}` }]
        ]
    };
};
