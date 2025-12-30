import TelegramBot from 'node-telegram-bot-api';
import { logger } from '../../libs/logger';
import { mainMenuKeyboard } from '../keyboards/reply.keyboard';

export const setupHelpHandler = (bot: TelegramBot): void => {

    // Unified Logic for Help Message
    const sendHelpMessage = async (chatId: number) => {
        const message =
            `📚 **PUSAT BANTUAN & EDUKASI**\n\n` +

            `💡 **Apa itu KiosWeb3?**\n` +
            `Kami adalah platform yang memudahkan kamu beli aset crypto (BNB, ETH, MATIC) dengan nominal kecil (mulai Rp 10.000) langsung masuk ke Wallet Pribadi kamu.\n\n` +

            `❓ **FAQ (Tanya Jawab)**\n\n` +

            `1️⃣ **Bagaimana Cara Belinya?**\n` +
            `• Klik tombol **💰 Beli Token**\n` +
            `• Pilih Jaringan (Network)\n` +
            `• Masukkan Nominal (Rupiah)\n` +
            `• Masukkan Alamat Wallet kamu\n` +
            `• Bayar via QRIS\n` +
            `• Selesai! Token masuk 1-3 menit.\n\n` +

            `2️⃣ **Apa itu Wallet? (PENTING ⚠️)**\n` +
            `Wallet adalah "Dompet Digital" kamu sendiri (Contoh: TrustWallet, Metamask). Kamu WAJIB punya ini sebelum beli.\n` +
            `❌ Jangan pakai alamat dari Exchanger (Indodax/TokoCrypto/Binance) karena min. deposit mereka biasanya tinggi.\n\n` +

            `3️⃣ **Fee-nya Berapa?**\n` +
            `• QRIS: Gratis Fee Admin\n` +
            `• Virtual Account: Rp 4.000\n` +
            `• Gas Fee Blockchain: Ditanggung Admin (Gratis!)\n\n` +

            `4️⃣ **Kenapa Stok Bisa Habis?**\n` +
            `Karena ini sistem Eceran (P2P Pool), stok kami terbatas dan cepat habis. Jika ada stok, segera amankan!\n\n` +

            `---\n\n` +
            `🛡️ **Keamanan Kami**\n` +
            `• Transaksi diproses sistem otomatis.\n` +
            `• Kami tidak menyimpan dana kamu (Langsung dikirim).\n` +
            `• Bukti transaksi tercatat di Blockchain (Transparan).\n\n` +

            `👥 **Masih Butuh Bantuan?**\n` +
            `Chat Admin Support: @Hanzbroww\n`;

        try {
            await bot.sendMessage(chatId, message, {
                parse_mode: 'Markdown',
                reply_markup: mainMenuKeyboard(),
            });
        } catch (error) {
            logger.error({ error }, 'Help handler error');
        }
    };

    // Handle "/help" Command
    bot.onText(/\/help/, async (msg) => {
        await sendHelpMessage(msg.chat.id);
    });

    // Handle "Bantuan" Text Input
    bot.on('message', async (msg) => {
        if (!msg.text || msg.text.startsWith('/')) return;
        const text = msg.text.trim();
        if (text === '🆘 Bantuan') {
            await sendHelpMessage(msg.chat.id);
        }
    });
};
