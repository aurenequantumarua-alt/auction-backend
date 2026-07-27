import { Worker } from 'bullmq';
import { createBullConnection, redisAvailable } from '../lib/redis.js';
import { JOB_NAMES, QUEUE_NAMES } from '../config/constants.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { settlementService } from '../modules/auctions/settlement.service.js';
import { realtime } from '../realtime/gateway.js';

interface AuctionLifecyclePayload {
  auctionId: string;
}

interface SettlementPayload {
  settlementId: string;
}

export const startWorkers = (): { close: () => Promise<void> } => {
  // If Redis is not available, return a no-op closer.
  try {
    const testConn = createBullConnection();
    // Try to connect; if it fails immediately, skip workers.
    testConn.on('error', () => {});

    const lifecycleWorker = new Worker<AuctionLifecyclePayload>(
      QUEUE_NAMES.auctionLifecycle,
      async (job) => {
        const { auctionId } = job.data;
        if (job.name === JOB_NAMES.goLive) {
          await goLive(auctionId);
          return;
        }
        if (job.name === JOB_NAMES.endAuction) {
          await settlementService.finalizeAuction(auctionId);
          return;
        }
        logger.warn({ jobName: job.name, auctionId }, 'Unknown lifecycle job');
      },
      { connection: createBullConnection(), concurrency: 8 },
    );

    const settlementWorker = new Worker<SettlementPayload>(
      QUEUE_NAMES.settlement,
      async (job) => {
        if (job.name === JOB_NAMES.paymentTimeout) {
          await settlementService.forfeitAndPromote(job.data.settlementId);
        }
      },
      { connection: createBullConnection(), concurrency: 4 },
    );

    for (const w of [lifecycleWorker, settlementWorker]) {
      w.on('failed', (job, err) => {
        logger.error({ err, jobId: job?.id, jobName: job?.name }, 'Job failed');
      });
      w.on('completed', (job) => {
        logger.debug({ jobId: job.id, jobName: job.name }, 'Job completed');
      });
    }

    logger.info('BullMQ workers started');

    return {
      close: async () => {
        await Promise.all([lifecycleWorker.close(), settlementWorker.close()]);
      },
    };
  } catch (err) {
    logger.warn('BullMQ workers could not start — Redis unavailable. Auction lifecycle jobs are disabled.');
    return {
      close: async () => {},
    };
  }
};

const goLive = async (auctionId: string): Promise<void> => {
  const auction = await prisma.auction.findUnique({ where: { id: auctionId } });
  if (!auction) return;
  if (auction.status !== 'UPCOMING') return;
  await prisma.auction.update({
    where: { id: auctionId },
    data: { status: 'LIVE' },
  });
  realtime.emitAuctionStatus(auctionId, 'LIVE');
};
