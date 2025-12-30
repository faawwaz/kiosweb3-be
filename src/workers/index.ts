import { Queue, Worker, QueueEvents } from 'bullmq';
import { env } from '../config/env.js';
import { logger } from '../libs/logger.js';
import { redis } from '../libs/redis.js';
import { priceWorker, schedulePrice } from './price.worker.js';
import { inventoryWorker, scheduleInventorySync } from './inventory.worker.js';
import { orderWorker, scheduleOrderExpiry } from './order.worker.js';
import { referralWorker, scheduleReferralCheck } from './referral.worker.js';

const connection = {
  host: new URL(env.REDIS_URL).hostname,
  port: parseInt(new URL(env.REDIS_URL).port || '6379', 10),
};

// Queues
export const priceQueue = new Queue('price', { connection });
export const inventoryQueue = new Queue('inventory', { connection });
export const orderQueue = new Queue('order', { connection });
export const referralQueue = new Queue('referral', { connection });

// Initialize workers
export const initWorkers = async (): Promise<void> => {
  logger.info('Initializing workers...');

  // Start workers
  const workers = [
    priceWorker(connection),
    inventoryWorker(connection),
    orderWorker(connection),
    referralWorker(connection),
  ];

  // Schedule recurring jobs
  await schedulePrice(priceQueue);
  await scheduleInventorySync(inventoryQueue);
  await scheduleOrderExpiry(orderQueue);
  await scheduleReferralCheck(referralQueue);

  logger.info('Workers initialized');

  // Handle graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down workers...');
    await Promise.all(workers.map((w) => w.close()));
    await priceQueue.close();
    await inventoryQueue.close();
    await orderQueue.close();
    await referralQueue.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
};

// Run workers standalone
if (process.argv[1]?.includes('workers')) {
  initWorkers().catch((error) => {
    logger.error({ error }, 'Failed to initialize workers');
    process.exit(1);
  });
}
