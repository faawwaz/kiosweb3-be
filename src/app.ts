import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { logger } from './libs/logger.js';
import { env } from './config/env.js';

// Import routes
import authRoutes from './modules/auth/auth.routes.js';
import usersRoutes from './modules/users/users.routes.js';
import pricingRoutes from './modules/pricing/pricing.routes.js';
import inventoryRoutes from './modules/inventory/inventory.routes.js';
import ordersRoutes from './modules/orders/orders.routes.js';
import paymentsRoutes from './modules/payments/payments.routes.js';
import vouchersRoutes from './modules/vouchers/vouchers.routes.js';
import referralsRoutes from './modules/referrals/referrals.routes.js';
// NEW: Admin Module
import adminRoutes from './modules/admin/admin.routes.js';

import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

const app: Express = express();

// Trust proxy (Required for Rate Limit behind Nginx/Cloudflare)
app.set('trust proxy', 1);

// Security Middleware
app.use(helmet());

// CORS Configuration
const allowedOrigins = env.CORS_ORIGINS.split(',').map(origin => origin.trim());
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, Postman, etc.)
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
      callback(null, true);
    } else {
      logger.warn({ origin }, 'CORS blocked request from unauthorized origin');
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
}));

// Rate Limiting (100 req per 15 min)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// Standard Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req: Request, _res: Response, next: NextFunction) => {
  logger.debug({ method: req.method, url: req.url }, 'Incoming request');
  next();
});

// Health check
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * API ROUTES
 * All auth logic is now native in authRoutes (mounted at /api/auth)
 */
app.use('/api/auth', authRoutes); // Register, Login, Google, Link
app.use('/api/users', usersRoutes);
app.use('/api/pricing', pricingRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/payments', paymentsRoutes);
app.use('/api/vouchers', vouchersRoutes);
app.use('/api/referrals', referralsRoutes);

// ADMIN DASHBOARD ROUTES
app.use('/api/admin', adminRoutes);

// Error handling middleware
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  logger.error({ err }, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error' });
});

export default app;
