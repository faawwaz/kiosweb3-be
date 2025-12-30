import { Request, Response, NextFunction } from 'express';
import { prisma } from '../libs/prisma.js';
import { verifyToken } from '../utils/jwt.js';
import { logger } from '../libs/logger.js';

// Extend Express Request type for user
declare global {
  namespace Express {
    interface Request {
      userId?: string;
      user?: any; // Full user object
    }
  }
}

/**
 * Authentication Middleware (JWT)
 * Expects Header: Authorization: Bearer <token>
 * Validates both token AND user existence in database
 */
export const authMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Unauthorized: No Token Provided' });
      return;
    }

    const token = authHeader.split(' ')[1];
    const payload = verifyToken(token);

    if (!payload.userId) {
      res.status(401).json({ error: 'Unauthorized: Invalid Token Payload' });
      return;
    }

    // SECURITY: Verify user still exists in database
    // This prevents access with valid JWT for deleted users
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { id: true, role: true }
    });

    if (!user) {
      logger.warn({ userId: payload.userId }, 'JWT valid but user not found in DB');
      res.status(401).json({ error: 'Unauthorized: User not found' });
      return;
    }

    req.userId = payload.userId;
    req.user = user; // Attach user object for downstream use

    next();
  } catch (error) {
    logger.warn({ error }, 'Auth middleware failed');
    res.status(401).json({ error: 'Unauthorized: Invalid Token' });
  }
};

/**
 * Optional Auth - Doesn't fail if no token
 */
export const optionalAuthMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      const payload = verifyToken(token);
      if (payload.userId) {
        req.userId = payload.userId;
      }
    }
    next();
  } catch {
    next();
  }
};
