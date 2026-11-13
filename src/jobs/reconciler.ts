import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { settlementService } from '../modules/auctions/settlement.service.js';
import { realtime } from '../realtime/gateway.js';

let intervalId: NodeJS.Timeout | null = null;
let isReconciling = false;

export const reconcileAll = async (): Promise<void> => {
  if (isReconciling) return;
  isReconciling = true;

  const now = new Date();

  // 1. Reconcile LIVE auctions whose endsAt has passed
  try {
    const endedAuctions = await prisma.auction.findMany({
      where: {
        status: 'LIVE',
        endsAt: { lte: now },
      },
      select: { id: true },
    });
    for (const a of endedAuctions) {
      await settlementService.finalizeAuction(a.id);
    }
  } catch (err) {
    logger.error({ err }, 'Error reconciling ended auctions');
  }

  // 2. Reconcile UPCOMING auctions whose startsAt has passed
  try {
    const liveAuctions = await prisma.auction.findMany({
      where: {
        status: 'UPCOMING',
        startsAt: { lte: now },
      },
      select: { id: true },
    });
    for (const a of liveAuctions) {
      await prisma.auction.update({
        where: { id: a.id },
        data: { status: 'LIVE' },
      });
      realtime.emitAuctionStatus(a.id, 'LIVE');
    }
  } catch (err) {
    logger.error({ err }, 'Error reconciling upcoming auctions');
  }

  // 3. Reconcile overdue settlements (payment deadlines, inspection, shipping)
  try {
    await settlementService.reconcileOverdue();
  } catch (err) {
    logger.error({ err }, 'Error reconciling overdue settlements');
  } finally {
    isReconciling = false;
  }
};

export const startReconciler = (): { stop: () => void } => {
  // Run once immediately on start
  void reconcileAll();

  // Sweep every 30 seconds
  intervalId = setInterval(() => {
    void reconcileAll();
  }, 30_000);

  logger.info('Database settlement/auction reconciler started (interval: 30s)');

  return {
    stop: () => {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    },
  };
};
