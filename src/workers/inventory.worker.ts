import { Worker, Queue, Job } from 'bullmq';
import { logger } from '../libs/logger.js';
import * as inventoryService from '../modules/inventory/inventory.service.js';
import * as blockchainService from '../modules/blockchain/blockchain.service.js';

const WORKER_NAME = 'inventory';

export const inventoryWorker = (connection: { host: string; port: number }): Worker => {
  const worker = new Worker(
    WORKER_NAME,
    async (job: Job) => {
      logger.debug({ jobId: job.id, type: job.name }, 'Processing inventory job');

      try {
        if (job.name === 'sync') {
          await inventoryService.syncInventory();
        } else if (job.name === 'init') {
          await inventoryService.initializeInventory();
        }

        return { success: true };
      } catch (error) {
        logger.error({ error }, 'Inventory job failed');
        throw error;
      }
    },
    {
      connection,
      concurrency: 1,
    }
  );

  worker.on('completed', (job) => {
    logger.debug({ jobId: job.id }, 'Inventory job completed');
  });

  worker.on('failed', (job, error) => {
    logger.error({ jobId: job?.id, error: error.message }, 'Inventory job failed');
  });

  return worker;
};

export const scheduleInventorySync = async (queue: Queue): Promise<void> => {
  // Remove existing repeatable jobs
  const repeatableJobs = await queue.getRepeatableJobs();
  for (const job of repeatableJobs) {
    await queue.removeRepeatableByKey(job.key);
  }

  // Schedule inventory sync every 1 minute
  await queue.add(
    'sync',
    {},
    {
      repeat: {
        every: 60000, // 1 minute
      },
      removeOnComplete: 50,
      removeOnFail: 50,
    }
  );

  // Initialize inventory on startup
  await queue.add('init', {}, { removeOnComplete: true });

  logger.info('Inventory worker scheduled');
};
