import jwt from 'jsonwebtoken';
import { logger } from '../libs/logger.js';
import { env } from '../config/env.js';

// Use validated env - no fallback, app will crash if AUTH_SECRET missing (validated in env.ts)
const JWT_SECRET = env.AUTH_SECRET;
const TOKEN_EXPIRY = '7d';

export interface JwtPayload {
    userId: string;
}

/**
 * Generate Access Token (JWT)
 */
export const generateToken = (userId: string): string => {
    return jwt.sign({ userId }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
};

/**
 * Verify Access Token
 * Returns payload if valid, throws error if invalid
 */
export const verifyToken = (token: string): JwtPayload => {
    try {
        return jwt.verify(token, JWT_SECRET) as JwtPayload;
    } catch (error) {
        logger.warn({ error }, 'Invalid JWT Token');
        throw new Error('Invalid or expired token');
    }
};
