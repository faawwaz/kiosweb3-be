import { Worker, Queue, Job } from 'bullmq';
import { logger } from '../libs/logger.js';
import * as pricingService from '../modules/pricing/pricing.service.js';

const WORKER_NAME = 'price';

export const priceWorker = (connection: { host: string; port: number }): Worker => {
  const worker = new Worker(
    WORKER_NAME,
    async (job: Job) => {
      logger.debug({ jobId: job.id }, 'Processing price job');

      try {
        await pricingService.refreshAllPrices();
        return { success: true };
      } catch (error) {
        logger.error({ error }, 'Price refresh failed');
        throw error;
      }
    },
    {
      connection,
      concurrency: 1,
    }
  );

  worker.on('completed', (job) => {
    logger.debug({ jobId: job.id }, 'Price job completed');
  });

  worker.on('failed', (job, error) => {
    logger.error({ jobId: job?.id, error: error.message }, 'Price job failed');
  });

  return worker;
};

export const schedulePrice = async (queue: Queue): Promise<void> => {
  // Remove existing repeatable jobs
  const repeatableJobs = await queue.getRepeatableJobs();
  for (const job of repeatableJobs) {
    await queue.removeRepeatableByKey(job.key);
  }

  // Schedule price refresh every 60 seconds
  await queue.add(
    'refresh',
    {},
    {
      repeat: {
        every: 60000, // 60 seconds
      },
      removeOnComplete: 100,
      removeOnFail: 100,
    }
  );

  // Run immediately
  await queue.add('refresh-now', {}, { removeOnComplete: true });

  logger.info('Price worker scheduled');
};
