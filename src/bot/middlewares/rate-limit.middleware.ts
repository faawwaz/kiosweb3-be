/**
 * Bot Rate Limiting Middleware (Issue #8)
 * Implements per-user rate limiting for Telegram bot handlers
 */

import { redis } from '../../libs/redis.js';
import { logger } from '../../libs/logger.js';
import TelegramBot from 'node-telegram-bot-api';

// Rate limit configurations
const LIMITS = {
    // General bot interactions
    general: { window: 60, max: 30 },     // 30 requests per minute
    // Order creation attempts
    order: { window: 3600, max: 10 },      // 10 orders per hour
    // Auth operations (OTP, register)
    auth: { window: 900, max: 5 },         // 5 auth attempts per 15 min
    // Callback button clicks
    callback: { window: 10, max: 10 },     // 10 clicks per 10 seconds
    // Critical operations (payment, cancel)
    critical: { window: 60, max: 5 },      // 5 per minute
};

type LimitType = keyof typeof LIMITS;

const RATE_LIMIT_PREFIX = 'bot:ratelimit:';

interface RateLimitResult {
    allowed: boolean;
    remaining: number;
    resetIn: number;
}

/**
 * Check rate limit for a user/operation
 */
export const checkRateLimit = async (
    telegramId: string,
    limitType: LimitType
): Promise<RateLimitResult> => {
    const config = LIMITS[limitType];
    const key = `${RATE_LIMIT_PREFIX}${limitType}:${telegramId}`;

    const current = await redis.incr(key);

    // First request - set expiry
    if (current === 1) {
        await redis.expire(key, config.window);
    }

    const ttl = await redis.ttl(key);

    if (current > config.max) {
        logger.warn({ telegramId, limitType, current, max: config.max }, 'Rate limit exceeded');
        return {
            allowed: false,
            remaining: 0,
            resetIn: ttl > 0 ? ttl : config.window
        };
    }

    return {
        allowed: true,
        remaining: config.max - current,
        resetIn: ttl > 0 ? ttl : config.window
    };
};

/**
 * Rate limit decorator for bot handlers
 */
export const withRateLimit = (
    limitType: LimitType,
    handler: (bot: TelegramBot, msg: TelegramBot.Message) => Promise<void>
) => {
    return async (bot: TelegramBot, msg: TelegramBot.Message): Promise<void> => {
        const telegramId = String(msg.from?.id);

        if (!telegramId || telegramId === 'undefined') {
            return;
        }

        const result = await checkRateLimit(telegramId, limitType);

        if (!result.allowed) {
            await bot.sendMessage(
                msg.chat.id,
                `⚠️ **Terlalu Banyak Request**\n\nMohon tunggu ${result.resetIn} detik sebelum mencoba lagi.`,
                { parse_mode: 'Markdown' }
            );
            return;
        }

        await handler(bot, msg);
    };
};

/**
 * Rate limit check for callback queries
 */
export const withCallbackRateLimit = (
    limitType: LimitType,
    handler: (bot: TelegramBot, query: TelegramBot.CallbackQuery) => Promise<void>
) => {
    return async (bot: TelegramBot, query: TelegramBot.CallbackQuery): Promise<void> => {
        const telegramId = String(query.from.id);

        const result = await checkRateLimit(telegramId, limitType);

        if (!result.allowed) {
            await bot.answerCallbackQuery(query.id, {
                text: `⚠️ Terlalu cepat! Tunggu ${result.resetIn} detik.`,
                show_alert: true
            });
            return;
        }

        await handler(bot, query);
    };
};

/**
 * Manual rate limit enforcement helper
 * Returns error message if rate limited, null if allowed
 */
export const enforceRateLimit = async (
    telegramId: string,
    limitType: LimitType
): Promise<string | null> => {
    const result = await checkRateLimit(telegramId, limitType);

    if (!result.allowed) {
        return `⚠️ Terlalu banyak percobaan. Mohon tunggu ${result.resetIn} detik.`;
    }

    return null;
};

/**
 * Get rate limit info without incrementing
 */
export const getRateLimitInfo = async (
    telegramId: string,
    limitType: LimitType
): Promise<{ current: number; max: number; resetIn: number }> => {
    const config = LIMITS[limitType];
    const key = `${RATE_LIMIT_PREFIX}${limitType}:${telegramId}`;

    const current = parseInt(await redis.get(key) || '0', 10);
    const ttl = await redis.ttl(key);

    return {
        current,
        max: config.max,
        resetIn: ttl > 0 ? ttl : 0
    };
};
