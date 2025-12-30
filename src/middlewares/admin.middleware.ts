import { Request, Response, NextFunction } from 'express';
import { prisma } from '../libs/prisma.js';
import { logger } from '../libs/logger.js';
import { authMiddleware } from './auth.middleware.js';

/**
 * Admin Middleware
 * 1. Verifies JWT (via authMiddleware logic)
 * 2. Checks DB if user role is ADMIN
 */
export const adminMiddleware = async (req: Request, res: Response, next: NextFunction) => {
    // 1. Run Auth Check first manually (or assume it's chained in route)
    // To be safe, let's chain dependencies in the route definition or call it here.
    // But express middleware is better chained in route file. 
    // We assume req.userId IS SENT by previous authMiddleware.

    if (!req.userId) {
        return res.status(401).json({ error: 'Unauthorized: No User Session' });
    }

    try {
        const user = await prisma.user.findUnique({
            where: { id: req.userId },
            select: { role: true }
        });

        if (!user || user.role !== 'ADMIN') {
            logger.warn({ userId: req.userId }, '⛔ Admin Access Attempt Denied');
            return res.status(403).json({ error: 'Forbidden: Admin Access Only' });
        }

        next();
    } catch (error) {
        logger.error({ error }, 'Admin Middleware db check failed');
        return res.status(500).json({ error: 'Internal Server Error' });
    }
};
