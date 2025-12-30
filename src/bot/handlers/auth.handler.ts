import TelegramBot from 'node-telegram-bot-api';
import { logger } from '../../libs/logger';
import { mainMenuKeyboard } from '../keyboards/reply.keyboard';
import { clearState, getState, resetState, updateState } from '../state';
import * as usersService from '../../modules/users/users.service';
import { sendOtpEmail } from '../../services/mailer.service';
import { redis } from '../../libs/redis';
import { prisma } from '../../libs/prisma';
import { enforceRateLimit } from '../middlewares/rate-limit.middleware';
import crypto from 'crypto';

export const setupAuthHandler = (bot: TelegramBot): void => {
    const OTP_EXPIRY = 300; // 5 mins
    const OTP_PREFIX = 'bot:otp:';
    const LINK_CODE_PREFIX = 'link_code:';

    // --- CALLBACK QUERY HANDLER ---
    bot.on('callback_query', async (query) => {
        const data = query.data;
        const chatId = query.message?.chat.id;
        const telegramId = String(query.from.id);

        if (!chatId || !data) return;

        // Issue #8: Rate limiting for auth operations
        if (data === 'auth_register' || data === 'auth_link') {
            const rateLimitError = await enforceRateLimit(telegramId, 'auth');
            if (rateLimitError) {
                await bot.answerCallbackQuery(query.id, { text: rateLimitError, show_alert: true });
                return;
            }
        }

        if (data === 'auth_register') {
            await updateState(telegramId, { step: 'awaiting_name' });
            // Issue #16: Step indicator
            await bot.sendMessage(chatId,
                '📝 **Pendaftaran Baru** (Langkah 1/3)\n\nSiapa nama lengkap Kakak?',
                { parse_mode: 'Markdown' }
            );
            await bot.answerCallbackQuery(query.id);

        } else if (data === 'auth_link') {
            const existingUser = await usersService.findUserByTelegramId(telegramId);
            if (existingUser) {
                await bot.sendMessage(chatId,
                    `⚠️ **Akun Anda Sudah Terdaftar!**\n\nHalo Kak ${(existingUser as any).name}, akun ini sudah terdaftar.\n\nKlik /start untuk menu utama.`,
                    { parse_mode: 'Markdown' }
                );
                await bot.answerCallbackQuery(query.id);
                return;
            }

            await updateState(telegramId, { step: 'awaiting_link_code' });
            const linkMsg = `🔗 **Sambung Akun Web** (Langkah 1/2)\n\n` +
                `1. Login ke Website EceranStore.\n` +
                `2. Buka Profil → Generate Telegram Code.\n` +
                `3. Masukkan kode 6 digit tersebut di sini:`;
            await bot.sendMessage(chatId, linkMsg, { parse_mode: 'Markdown' });
            await bot.answerCallbackQuery(query.id);
        }
    });

    // --- MESSAGE HANDLER ---
    bot.on('message', async (msg) => {
        if (!msg.text || msg.text.startsWith('/')) return;

        const chatId = msg.chat.id;
        const telegramId = String(msg.from?.id);
        const text = msg.text.trim();

        // Issue #10: Null check
        if (!telegramId || telegramId === 'undefined') return;

        try {
            const state = await getState(telegramId);

            // --- FLOW REGISTER: NAMA ---
            if (state.step === 'awaiting_name') {
                if (text.length < 3) {
                    await bot.sendMessage(chatId, '❌ Nama terlalu pendek. Silakan input nama lengkap (minimal 3 karakter):');
                    return;
                }

                if (text.length > 100) {
                    await bot.sendMessage(chatId, '❌ Nama terlalu panjang. Maksimal 100 karakter.');
                    return;
                }

                await updateState(telegramId, { step: 'awaiting_email', regName: text });
                // Issue #16: Step indicator
                await bot.sendMessage(chatId,
                    `Halo Kak ${text}! 👋\n\n` +
                    `📝 **Pendaftaran Baru** (Langkah 2/3)\n\n` +
                    `Sekarang ketik **Alamat Email** aktif Kakak untuk verifikasi:`,
                    { parse_mode: 'Markdown' }
                );
                return;
            }

            // --- FLOW REGISTER: EMAIL ---
            if (state.step === 'awaiting_email') {
                const email = text.toLowerCase().trim();

                // Better email validation
                if (!/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email)) {
                    await bot.sendMessage(chatId, '❌ Format email tidak valid. Contoh yang benar: nama@gmail.com');
                    return;
                }

                // Issue #8: Rate limiting
                const rateLimitError = await enforceRateLimit(telegramId, 'auth');
                if (rateLimitError) {
                    await bot.sendMessage(chatId, rateLimitError);
                    return;
                }

                const existing = await prisma.user.findUnique({ where: { email } });
                if (existing) {
                    await bot.sendMessage(chatId,
                        '❌ **Email Sudah Terdaftar!**\n\n' +
                        'Kami menemukan akun dengan email ini.\n' +
                        'Silakan gunakan menu **"🔗 Sambungkan Akun Web"** jika ini akun Kakak.',
                        { parse_mode: 'Markdown' }
                    );
                    await resetState(telegramId);
                    return;
                }

                // Issue #5: Only store OTP in Redis, NOT in state
                const otp = generateSecureOTP();
                await redis.setex(`${OTP_PREFIX}${telegramId}`, OTP_EXPIRY, otp);
                await sendOtpEmail(email, otp);

                // Store email but NOT OTP in state
                await updateState(telegramId, { step: 'awaiting_otp', regEmail: email });

                // Issue #16: Step indicator
                await bot.sendMessage(chatId,
                    `� **Pendaftaran Baru** (Langkah 3/3)\n\n` +
                    `�📧 Kode OTP telah dikirim ke **${maskEmail(email)}**.\n\n` +
                    `Silakan cek inbox/spam dan masukkan 6 digit kode OTP di sini:`,
                    { parse_mode: 'Markdown' }
                );
                return;
            }

            // --- FLOW REGISTER: OTP ---
            if (state.step === 'awaiting_otp') {
                // Issue #5: Only check OTP from Redis
                const storedOtp = await redis.get(`${OTP_PREFIX}${telegramId}`);

                if (!storedOtp) {
                    await bot.sendMessage(chatId,
                        '❌ Kode OTP sudah kadaluarsa.\n\n' +
                        'Silakan ketik /start untuk mendaftar ulang.',
                        { parse_mode: 'Markdown' }
                    );
                    await resetState(telegramId);
                    return;
                }

                if (text !== storedOtp) {
                    await bot.sendMessage(chatId, '❌ Kode OTP salah. Silakan cek kembali email Anda.');
                    return;
                }

                // Issue #10: Null check
                if (!state.regEmail || !state.regName) {
                    await bot.sendMessage(chatId, '⚠️ Sesi pendaftaran tidak valid. Silakan ketik /start untuk memulai ulang.');
                    await resetState(telegramId);
                    return;
                }

                await bot.sendChatAction(chatId, 'typing');

                // Create User
                await usersService.createUser({
                    email: state.regEmail,
                    name: state.regName,
                    telegramId,
                    telegramUsername: msg.from?.username,
                    referredByCode: state.regReferral
                });

                // Cleanup
                await redis.del(`${OTP_PREFIX}${telegramId}`);
                await resetState(telegramId);

                await bot.sendMessage(chatId,
                    `✅ **Registrasi Berhasil!**\n\n` +
                    `Selamat bergabung, Kak ${state.regName}.\n` +
                    `Akun Telegram Kakak sudah aktif dan siap digunakan!`,
                    { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard() }
                );
                return;
            }

            // --- FLOW LINK: KODE ---
            if (state.step === 'awaiting_link_code') {
                const linkCode = text.trim();

                // Issue #7: Rate limiting for link code verification
                const rateLimitError = await enforceRateLimit(telegramId, 'auth');
                if (rateLimitError) {
                    await bot.sendMessage(chatId, rateLimitError);
                    return;
                }

                // Validate format
                if (!/^\d{6}$/.test(linkCode)) {
                    await bot.sendMessage(chatId, '❌ Kode harus 6 digit angka. Silakan cek kembali.');
                    return;
                }

                const userId = await redis.get(`${LINK_CODE_PREFIX}${linkCode}`);

                if (!userId) {
                    await bot.sendMessage(chatId,
                        '❌ **Kode Salah / Kadaluarsa.**\n\nSilakan generate kode baru di Website.',
                        { parse_mode: 'Markdown' }
                    );
                    return;
                }

                const user = await prisma.user.findUnique({ where: { id: userId } });
                if (!user || !user.email) {
                    await bot.sendMessage(chatId, '❌ Akun Web tidak valid / tidak memiliki email.');
                    return;
                }

                // Check if telegram already linked to someone else
                const existingTgUser = await usersService.findUserByTelegramId(telegramId);
                if (existingTgUser) {
                    await bot.sendMessage(chatId,
                        '❌ Telegram ini sudah terhubung dengan akun lain.\n\nSilakan gunakan menu /start.',
                        { parse_mode: 'Markdown' }
                    );
                    return;
                }

                // Issue #5: Only store OTP in Redis
                const otp = generateSecureOTP();
                await redis.setex(`${OTP_PREFIX}${telegramId}`, OTP_EXPIRY, otp);
                await sendOtpEmail(user.email, otp);

                // Store linkCode in state (needed for verification), but NOT OTP
                await updateState(telegramId, { step: 'awaiting_link_otp', linkCode });

                // Issue #24: Better email masking
                const masked = maskEmail(user.email);

                await bot.sendMessage(chatId,
                    `🔒 **Verifikasi Keamanan** (Langkah 2/2)\n\n` +
                    `Akun ditemukan: **${user.name || 'User'}** (${masked})\n\n` +
                    `Demi keamanan, kami mengirim Kode OTP ke email tersebut.\n` +
                    `Masukkan OTP di sini untuk konfirmasi:`,
                    { parse_mode: 'Markdown' }
                );
                return;
            }

            // --- FLOW LINK: OTP ---
            if (state.step === 'awaiting_link_otp') {
                // Issue #5: Only check OTP from Redis
                const storedOtp = await redis.get(`${OTP_PREFIX}${telegramId}`);

                if (!storedOtp) {
                    await bot.sendMessage(chatId,
                        '❌ OTP sudah kadaluarsa. Silakan ulangi dari awal.',
                        { parse_mode: 'Markdown' }
                    );
                    await resetState(telegramId);
                    return;
                }

                if (text !== storedOtp) {
                    await bot.sendMessage(chatId, '❌ OTP Salah. Silakan cek kembali email Anda.');
                    return;
                }

                // Issue #10: Null check
                if (!state.linkCode) {
                    await bot.sendMessage(chatId, '⚠️ Sesi tidak valid. Silakan ketik /start untuk memulai ulang.');
                    await resetState(telegramId);
                    return;
                }

                // Re-verify link code
                const userId = await redis.get(`${LINK_CODE_PREFIX}${state.linkCode}`);
                if (!userId) {
                    await bot.sendMessage(chatId, '❌ Sesi Link kadaluarsa. Silakan ulangi dari awal.');
                    await resetState(telegramId);
                    return;
                }

                // Final check: telegram not already linked
                const existingTgUser = await usersService.findUserByTelegramId(telegramId);
                if (existingTgUser) {
                    await bot.sendMessage(chatId, '❌ Telegram ini sudah terhubung dengan akun lain.');
                    await resetState(telegramId);
                    return;
                }

                // Update User
                await prisma.user.update({
                    where: { id: userId },
                    data: {
                        telegramId,
                        telegramUsername: msg.from?.username
                    }
                });

                // Cleanup
                await redis.del(`${LINK_CODE_PREFIX}${state.linkCode}`);
                await redis.del(`${OTP_PREFIX}${telegramId}`);
                await resetState(telegramId);

                await bot.sendMessage(chatId,
                    `🎉 **Akun Berhasil Terhubung!**\n\n` +
                    `Sekarang Kakak bisa transaksi lewat Bot atau Web dengan data yang sama.`,
                    { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard() }
                );
                return;
            }

        } catch (error) {
            logger.error({ error, telegramId }, 'Auth handler error');
            await bot.sendMessage(chatId, '❌ Terjadi kesalahan. Silakan ketik /start untuk memulai ulang.');
            await clearState(telegramId);
        }
    });
};

/**
 * Issue #7: Generate cryptographically secure 6-digit OTP
 */
function generateSecureOTP(): string {
    const bytes = crypto.randomBytes(4);
    const num = bytes.readUInt32BE(0) % 900000 + 100000;
    return num.toString();
}

/**
 * Issue #24: Better email masking
 * Shows first 2 chars and last char before @ for emails with username > 3 chars
 */
function maskEmail(email: string): string {
    const [username, domain] = email.split('@');

    if (!domain) return '***@***';

    if (username.length <= 2) {
        return `${username[0] || '*'}***@${domain}`;
    } else if (username.length <= 4) {
        return `${username.slice(0, 2)}***@${domain}`;
    } else {
        return `${username.slice(0, 2)}***${username.slice(-1)}@${domain}`;
    }
}
