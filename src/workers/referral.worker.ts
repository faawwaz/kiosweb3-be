import { Worker, Queue, Job } from 'bullmq';
import { logger } from '../libs/logger.js';
import * as referralsService from '../modules/referrals/referrals.service.js';
import * as vouchersService from '../modules/vouchers/vouchers.service.js';

const WORKER_NAME = 'referral';

export const referralWorker = (connection: { host: string; port: number }): Worker => {
  const worker = new Worker(
    WORKER_NAME,
    async (job: Job) => {
      logger.debug({ jobId: job.id, type: job.name }, 'Processing referral job');

      try {
        if (job.name === 'check') {
          const validatedCount = await referralsService.checkPendingReferrals();
          return { validatedCount };
        } else if (job.name === 'validate') {
          const refereeId = job.data.refereeId;
          await referralsService.validateReferral(refereeId);
          return { success: true };
        } else if (job.name === 'expire-vouchers') {
          const expiredCount = await vouchersService.expireVouchers();
          return { expiredCount };
        }

        return { success: true };
      } catch (error) {
        logger.error({ error, jobName: job.name }, 'Referral job failed');
        throw error;
      }
    },
    {
      connection,
      concurrency: 1,
    }
  );

  worker.on('completed', (job, result) => {
    logger.debug({ jobId: job.id, result }, 'Referral job completed');
  });

  worker.on('failed', (job, error) => {
    logger.error({ jobId: job?.id, error: error.message }, 'Referral job failed');
  });

  return worker;
};

export const scheduleReferralCheck = async (queue: Queue): Promise<void> => {
  // Remove existing repeatable jobs
  const repeatableJobs = await queue.getRepeatableJobs();
  for (const job of repeatableJobs) {
    await queue.removeRepeatableByKey(job.key);
  }

  // Schedule referral check every 10 minutes
  await queue.add(
    'check',
    {},
    {
      repeat: {
        every: 600000, // 10 minutes
      },
      removeOnComplete: 50,
      removeOnFail: 50,
    }
  );

  // Schedule voucher expiry check every hour
  await queue.add(
    'expire-vouchers',
    {},
    {
      repeat: {
        every: 3600000, // 1 hour
      },
      removeOnComplete: 50,
      removeOnFail: 50,
    }
  );

  logger.info('Referral worker scheduled');
};

/**
 * Queue a referral for validation
 */
export const queueReferralValidation = async (
  queue: Queue,
  refereeId: string
): Promise<void> => {
  await queue.add(
    'validate',
    { refereeId },
    {
      removeOnComplete: true,
      removeOnFail: false,
      delay: 5000, // Wait 5 seconds before checking
    }
  );

  logger.info({ refereeId }, 'Referral validation queued');
};
