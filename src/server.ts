import { env } from './config/env.js';
import { logger } from './libs/logger.js';
import { prisma } from './libs/prisma.js';
import { redis } from './libs/redis.js';
import app from './app.js';
import { initBot } from './bot/index.js';
import { startInventoryMonitor } from './modules/inventory/inventory.monitor.js';
import { initMailer } from './services/mailer.service.js';
import { blockchainManager } from './modules/blockchain/engine/BlockchainManager.js';
import * as binanceWsService from "./modules/pricing/binance-ws.service.js"
import * as Sentry from "@sentry/node";
import { nodeProfilingIntegration } from "@sentry/profiling-node";

const startServer = async () => {
  try {
    // Initialize Sentry (First thing!)
    if (env.SENTRY_DSN) {
      Sentry.init({
        dsn: env.SENTRY_DSN,
        environment: env.SENTRY_ENVIRONMENT,
        integrations: [nodeProfilingIntegration()],
        tracesSampleRate: 1.0, // Capture 100% of transactions for now (adjust for high traffic)
        profilesSampleRate: 1.0,
      });
      logger.info('Sentry Monitoring initialized');
    }

    // Test database connection
    await prisma.$connect();
    logger.info('Database connected');

    // Test Redis connection
    await redis.ping();
    logger.info('Redis connected');

    // Initialize Telegram bot
    await initBot();
    logger.info('Telegram bot initialized');

    // Initialize Blockchain Engine (Dynamic)
    await blockchainManager.init();

    // Start Inventory Monitor (AFTER Engine Ready)
    await startInventoryMonitor();

    // Initialize Mailer
    await initMailer();

    // Start Binance WSS (Realtime Pricing)
    // Dynamic import to avoid circular dependency issues if any
    const { initBinanceWS } = binanceWsService;
    await initBinanceWS();
    logger.info('Binance WSS Engine started');

    // --- CRITICAL FIX: START WORKERS ---
    // Previously detailed in workers/index.ts but never called in server.ts
    const { initWorkers } = await import('./workers/index.js');
    await initWorkers();
    logger.info('Background Workers started');

    // Start Express server
    app.listen(env.PORT, () => {
      logger.info(`Server running on port ${env.PORT}`);
      logger.info(`Environment: ${env.NODE_ENV}`);
    });
  } catch (error) {
    logger.error({ error }, 'Failed to start server');
    process.exit(1);
  }
};

// Graceful shutdown
const shutdown = async () => {
  logger.info('Shutting down...');
  await prisma.$disconnect();
  await redis.quit();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Global Error Handlers (Cyber Security Best Practice: Log before crash)
process.on('unhandledRejection', (reason, promise) => {
  logger.fatal({ reason, promise }, '🚨 Unhandled Rejection at Promise');
  // Optional: process.exit(1) if you want to fail hard, but for now we just log
});

process.on('uncaughtException', (error) => {
  logger.fatal({ error }, '🚨 Uncaught Exception thrown');
  // It is unsafe to resume operation after uncaughtException, so we must exit
  process.exit(1);
});

startServer();
