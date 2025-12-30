import jwt from 'jsonwebtoken';
import { logger } from '../libs/logger.js';

const JWT_SECRET = process.env.AUTH_SECRET || 'fallback-secret-pls-change';
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
