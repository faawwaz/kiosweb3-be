import { Worker, Queue, Job } from 'bullmq';
import * as Sentry from '@sentry/node';
import { logger } from '../libs/logger.js';
import * as ordersService from '../modules/orders/orders.service.js';

const WORKER_NAME = 'order';

export const orderWorker = (connection: { host: string; port: number }): Worker => {
  const worker = new Worker(
    WORKER_NAME,
    async (job: Job) => {
      logger.debug({ jobId: job.id, type: job.name }, 'Processing order job');

      try {
        if (job.name === 'expire') {
          const expiredCount = await ordersService.expirePendingOrders(15);
          return { expiredCount };
        } else if (job.name === 'expire_single') {
          const orderId = job.data.orderId;
          const expired = await ordersService.expireSingleOrder(orderId);
          return { expired };
        } else if (job.name === 'process') {
          const orderId = job.data.orderId;
          await ordersService.processOrder(orderId);
          return { success: true };
        }

        return { success: true };
      } catch (error) {
        logger.error({ error, jobName: job.name }, 'Order Job Failed');
        throw error;
      }
    },
    {
      connection,
      concurrency: 20, // Process multiple orders in parallel
    }
  );

  worker.on('completed', (job, result) => {
    logger.debug({ jobId: job.id, result }, 'Order job completed');
  });

  worker.on('failed', (job, error) => {
    logger.error({ jobId: job?.id, error: error.message }, 'Order job failed');
    // Report async failure to Sentry with context
    Sentry.captureException(error, {
      tags: {
        worker: WORKER_NAME,
        jobId: job?.id,
        jobType: job?.name
      },
      extra: {
        jobData: job?.data,
        attempts: job?.attemptsMade
      }
    });
  });

  return worker;
};

export const scheduleOrderExpiry = async (queue: Queue): Promise<void> => {
  // Remove existing repeatable jobs
  const repeatableJobs = await queue.getRepeatableJobs();
  for (const job of repeatableJobs) {
    await queue.removeRepeatableByKey(job.key);
  }

  // Schedule order expiry check every 5 minutes (Fallback)
  await queue.add(
    'expire',
    {},
    {
      repeat: {
        every: 300000,
      },
      removeOnComplete: 50,
      removeOnFail: 50,
    }
  );

  logger.info('Order worker scheduled');
};

/**
 * Schedule a delayed expiry job for a specific order (Exact Timing)
 */
export const scheduleSingleOrderExpiry = async (
  queue: Queue,
  orderId: string,
  delayMs: number
): Promise<void> => {
  await queue.add(
    'expire_single',
    { orderId },
    {
      delay: delayMs,
      removeOnComplete: true,
      removeOnFail: false, // Keep failed jobs for debugging
      attempts: 3,         // Retry if DB is busy
      backoff: {
        type: 'exponential',
        delay: 5000
      }
    }
  );
};

/**
 * Queue an order for processing
 */
export const queueOrderProcessing = async (
  queue: Queue,
  orderId: string
): Promise<void> => {
  await queue.add(
    'process',
    { orderId },
    {
      removeOnComplete: true,
      removeOnFail: false,
      attempts: 1, // CRITICAL: Do NOT retry payment processing automatically. Risk of Double Spend.
      // backoff removed
    }
  );

  logger.info({ orderId }, 'Order queued for processing');
};
