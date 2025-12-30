import TelegramBot from 'node-telegram-bot-api';
import { logger } from '../../libs/logger.js';
import * as ordersService from '../../modules/orders/orders.service.js';
import { renderHistory } from './history.handler.js';
import * as usersService from '../../modules/users/users.service.js';
import { prisma } from '../../libs/prisma.js';
import { enforceRateLimit } from '../middlewares/rate-limit.middleware.js';

export const setupCallbackHandler = (bot: TelegramBot): void => {
    bot.on('callback_query', async (query) => {
        const { id, data, message } = query;
        if (!data || !message) return;

        const telegramId = String(query.from.id);

        // Issue #10: Null check
        if (!telegramId || telegramId === 'undefined') return;

        try {
            // HANDLE: check_payment:ORDER_ID
            if (data.startsWith('check_payment:')) {
                // Issue #8: Rate limiting for callbacks
                const rateLimitError = await enforceRateLimit(telegramId, 'callback');
                if (rateLimitError) {
                    await bot.answerCallbackQuery(id, { text: rateLimitError, show_alert: true });
                    return;
                }

                const orderId = data.split(':')[1];

                // Issue #10: Null check for orderId
                if (!orderId) {
                    await bot.answerCallbackQuery(id, { text: '❌ Data tidak valid.' });
                    return;
                }

                // SECURITY: Verify ownership before allowing status check
                const user = await usersService.findUserByTelegramId(telegramId);
                const order = await ordersService.getOrderById(orderId);

                if (!order) {
                    await bot.answerCallbackQuery(id, { text: '❌ Pesanan tidak ditemukan.' });
                    return;
                }

                // Ownership validation
                if (!user || order.userId !== user.id) {
                    logger.warn({ orderId, telegramId, actualUserId: order.userId }, 'Unauthorized payment check attempt');
                    await bot.answerCallbackQuery(id, { text: '❌ Anda tidak memiliki akses ke pesanan ini.' });
                    return;
                }

                // Try to SYNC with Midtrans real-time
                try {
                    await ordersService.syncPayment(orderId);
                    // Re-fetch after sync to get updated status
                    const updatedOrder = await ordersService.getOrderById(orderId);
                    if (updatedOrder) {
                        const statusMessages: Record<string, string> = {
                            'PAID': '✅ PEMBAYARAN DITERIMA! Token sedang diproses.',
                            'SUCCESS': '✅ Token sudah terkirim ke wallet Anda!',
                            'PROCESSING': '⚙️ Token sedang diproses...',
                            'FAILED': '❌ Pembayaran gagal.',
                            'CANCELLED': '❌ Pesanan dibatalkan.',
                            'EXPIRED': '❌ Waktu pembayaran habis.',
                            'PENDING': '⏳ Menunggu pembayaran. Silakan selesaikan pembayaran.'
                        };

                        const msg = statusMessages[updatedOrder.status] || `Status: ${updatedOrder.status}`;
                        await bot.answerCallbackQuery(id, { text: msg, show_alert: true });
                        return;
                    }
                } catch (e) {
                    logger.debug({ error: e, orderId }, 'Sync failed, using cached status');
                }

                // Fallback to original order status if sync failed
                const statusMessages: Record<string, string> = {
                    'PAID': '✅ PEMBAYARAN DITERIMA! Token sedang diproses.',
                    'SUCCESS': '✅ Token sudah terkirim!',
                    'PROCESSING': '⚙️ Sedang memproses...',
                    'FAILED': '❌ Pembayaran gagal.',
                    'CANCELLED': '❌ Pesanan dibatalkan.',
                    'EXPIRED': '❌ Waktu pembayaran habis.',
                    'PENDING': '⏳ Menunggu pembayaran.'
                };

                const msg = statusMessages[order.status] || `Status: ${order.status}`;
                await bot.answerCallbackQuery(id, { text: msg, show_alert: true });
            }

            // HANDLE: cancel_order:ORDER_ID
            if (data.startsWith('cancel_order:')) {
                // Issue #8: Rate limiting
                const rateLimitError = await enforceRateLimit(telegramId, 'critical');
                if (rateLimitError) {
                    await bot.answerCallbackQuery(id, { text: rateLimitError, show_alert: true });
                    return;
                }

                const orderId = data.split(':')[1];

                // Issue #10: Null check
                if (!orderId) {
                    await bot.answerCallbackQuery(id, { text: '❌ Data tidak valid.' });
                    return;
                }

                // SECURITY: Verify ownership
                const user = await usersService.findUserByTelegramId(telegramId);

                // Issue #13: Fetch FRESH order status to prevent race with webhook
                const order = await prisma.order.findUnique({ where: { id: orderId } });

                if (!order) {
                    await bot.answerCallbackQuery(id, { text: '❌ Pesanan tidak ditemukan.' });
                    return;
                }

                // Critical ownership validation
                if (!user || order.userId !== user.id) {
                    logger.warn({ orderId, telegramId, actualUserId: order.userId }, 'Unauthorized cancel attempt blocked');
                    await bot.answerCallbackQuery(id, { text: '❌ Anda tidak memiliki akses untuk membatalkan pesanan ini.' });
                    return;
                }

                // Issue #13: Check status AFTER fetching fresh data
                if (order.status !== 'PENDING') {
                    if (order.status === 'PAID' || order.status === 'PROCESSING') {
                        await bot.answerCallbackQuery(id, {
                            text: '❌ Pembayaran sudah diterima! Pesanan sedang diproses dan tidak dapat dibatalkan.',
                            show_alert: true
                        });
                        return;
                    }
                    if (order.status === 'SUCCESS') {
                        await bot.answerCallbackQuery(id, {
                            text: '✅ Pesanan sudah selesai!',
                            show_alert: true
                        });
                        return;
                    }
                    // Already cancelled/expired/failed
                    await bot.answerCallbackQuery(id, {
                        text: '❌ Pesanan sudah dibatalkan/kadaluarsa.',
                        show_alert: true
                    });
                    return;
                }

                // Proceed with cancellation
                try {
                    await ordersService.cancelOrder(orderId);
                    await bot.answerCallbackQuery(id, { text: '✅ Pesanan berhasil dibatalkan.', show_alert: true });

                    try {
                        await bot.deleteMessage(message.chat.id, message.message_id);
                    } catch (delErr) {
                        // Ignore if message can't be deleted
                    }

                    await bot.sendMessage(message.chat.id, '❌ Pesanan Anda telah dibatalkan.');
                } catch (cancelError: any) {
                    logger.error({ error: cancelError, orderId }, 'Cancel order failed');

                    // Issue #13: Recheck status - might have been processed during our operation
                    const freshOrder = await prisma.order.findUnique({ where: { id: orderId } });
                    if (freshOrder && (freshOrder.status === 'PAID' || freshOrder.status === 'PROCESSING')) {
                        await bot.answerCallbackQuery(id, {
                            text: '❌ Pembayaran baru saja diterima! Tidak dapat dibatalkan.',
                            show_alert: true
                        });
                    } else {
                        await bot.answerCallbackQuery(id, {
                            text: '❌ Gagal membatalkan pesanan. Coba lagi.',
                            show_alert: true
                        });
                    }
                }
            }

            // HANDLE: history:PAGE
            if (data.startsWith('history:')) {
                const pageStr = data.split(':')[1];
                const page = parseInt(pageStr || '0', 10);

                if (isNaN(page) || page < 0) {
                    await bot.answerCallbackQuery(id);
                    return;
                }

                const user = await usersService.findUserByTelegramId(telegramId);

                if (user) {
                    await renderHistory(bot, message.chat.id, user.id, page, true, message.message_id);
                }
                await bot.answerCallbackQuery(id);
            }

            // HANDLE: main_menu
            if (data === 'main_menu') {
                await bot.answerCallbackQuery(id);
                const { mainMenuKeyboard } = await import('../keyboards/reply.keyboard.js');
                await bot.sendMessage(message.chat.id, '🏠 **Menu Utama**', {
                    parse_mode: 'Markdown',
                    reply_markup: mainMenuKeyboard()
                });
            }

        } catch (error) {
            logger.error({ error, data }, 'Callback Handler Error');
            // Try to stop loading animation even on error
            try { await bot.answerCallbackQuery(id, { text: '❌ Terjadi kesalahan sistem.' }); } catch (e) { }
        } finally {
            // Safety fallback: Ensure we answered if not done yet
            // (Note: Telegram API throws if we answer twice, so we usually just rely on the specific handlers to answer.
            // But to prevent infinite spinning on unhandled paths, we can do a suppress-error answer here?)
            // Actually, the specific handlers above (check_payment, cancel_order) might NOT have answered if they returned early.
            // Let's rely on the explicit answers inside the blocks, and the catch block above.
        }
    });
};
