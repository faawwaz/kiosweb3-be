import rateLimit from 'express-rate-limit';

/**
 * Global API Rate Limit
 * Standard protection for general endpoints
 * 100 requests / minute
 */
export const globalLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 100, // Limit each IP to 100 requests per windowMs
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
    message: { error: 'Too many requests, please try again later.' },
});

/**
 * Auth Rate Limit (Strict)
 * Protection for expensive/sensitive auth ops (Login, Register)
 * 5 attempts / 15 minutes
 */
export const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // Limit each IP to 5 requests per windowMs
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many login attempts, please try again after 15 minutes.' },
    skipSuccessfulRequests: true,
    skip: (req) => {
        // Whitelist localhost/internal if needed
        return false;
    }
});

/**
 * Order Creation Limit
 * Prevent spamming order creation (Inventory Locking Attack mitigation)
 * 10 orders / 60 minutes
 */
export const orderLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many orders created. Please try again later.' }
});
