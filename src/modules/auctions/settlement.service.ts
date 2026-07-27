import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { JOB_NAMES } from '../../config/constants.js';
import { settlementQueue } from '../../jobs/queue.js';
import { notificationService } from '../notifications/service.js';
import { walletService } from '../wallet/service.js';
import { realtime } from '../../realtime/gateway.js';
import { logger } from '../../lib/logger.js';
import { conflict, forbidden, notFound } from '../../utils/http-error.js';

/**
 * Settlement service: owns the fallback bidder chain.
 *
 * When an auction ends with at least one bid, we create an AuctionSettlement
 * with the highest bid as the current winner. They have PAYMENT_WINDOW_HOURS
 * to pay. If they don't (or decline), we forfeit their bid and promote the
 * next-highest. This continues until somebody pays or the chain is exhausted.
 */
export const settlementService = {
  /**
   * Called by the auction.end job. Locks the auction, computes the winner from
   * the bid table (ordered by amount DESC, placedAt ASC), creates a Settlement
   * if there are bids, and transitions the auction status accordingly.
   *
   * Idempotent — calling twice for the same auction is a no-op after the first.
   */
  async finalizeAuction(auctionId: string): Promise<void> {
    await prisma.$transaction(async (tx) => {
      const auction = await tx.auction.findUnique({
        where: { id: auctionId },
        include: { settlement: true },
      });
      if (!auction) {
        logger.warn({ auctionId }, 'finalizeAuction: auction not found');
        return;
      }
      if (auction.status !== 'LIVE') {
        logger.debug({ auctionId, status: auction.status }, 'finalizeAuction: not in LIVE, skipping');
        return;
      }

      const topBid = await tx.bid.findFirst({
        where: { auctionId, status: { in: ['ACTIVE'] } },
        orderBy: [{ amount: 'desc' }, { placedAt: 'asc' }],
      });

      if (!topBid) {
        await tx.auction.update({
          where: { id: auctionId },
          data: { status: 'EXPIRED' },
        });
        await notificationService.notify(tx, {
          userId: auction.sellerId,
          type: 'AUCTION_EXPIRED',
          payload: { auctionId, title: auction.title },
        });
        realtime.emitAuctionStatus(auctionId, 'EXPIRED');
        return;
      }

      // Mark winner + outbid all others.
      await tx.bid.update({
        where: { id: topBid.id },
        data: { status: 'WON' },
      });
      await tx.bid.updateMany({
        where: { auctionId, id: { not: topBid.id }, status: 'ACTIVE' },
        data: { status: 'OUTBID' },
      });

      const deadline = new Date(Date.now() + env.PAYMENT_WINDOW_HOURS * 60 * 60 * 1000);
      const settlement = await tx.auctionSettlement.create({
        data: {
          auctionId,
          currentWinnerBidId: topBid.id,
          paymentDeadline: deadline,
        },
      });

      await tx.auction.update({
        where: { id: auctionId },
        data: { status: 'PAYMENT_PENDING' },
      });

      await notificationService.notify(tx, {
        userId: topBid.bidderId,
        type: 'WON',
        payload: { auctionId, title: auction.title, amount: topBid.amount.toFixed(2), deadline },
      });
      await notificationService.notify(tx, {
        userId: auction.sellerId,
        type: 'AUCTION_ENDED',
        payload: {
          auctionId,
          title: auction.title,
          winnerBidId: topBid.id,
          amount: topBid.amount.toFixed(2),
        },
      });

      realtime.emitAuctionStatus(auctionId, 'PAYMENT_PENDING');
      await schedulePaymentTimeout(settlement.id, deadline);
    });
  },

  /**
   * Forfeit the current winner and try to promote the next bidder.
   * Called from:
   *   - the settlement.payment-timeout job when the deadline lapses
   *   - the explicit `POST /settlements/:id/decline` endpoint when a winner
   *     opts out before paying
   */
  async forfeitAndPromote(settlementId: string): Promise<void> {
    await prisma.$transaction(async (tx) => {
      const settlement = await tx.auctionSettlement.findUnique({
        where: { id: settlementId },
        include: { auction: true, currentWinnerBid: true },
      });
      if (!settlement) return;
      if (settlement.status !== 'AWAITING_PAYMENT') return;
      if (!settlement.currentWinnerBid) return;

      const forfeitedBidId = settlement.currentWinnerBid.id;
      const forfeitedBidderId = settlement.currentWinnerBid.bidderId;

      await tx.bid.update({
        where: { id: forfeitedBidId },
        data: { status: 'FORFEITED' },
      });

      // Notify the forfeited bidder that their claim was dropped.
      await notificationService.notify(tx, {
        userId: forfeitedBidderId,
        type: 'WINNER_FORFEITED',
        payload: { auctionId: settlement.auctionId },
      });

      const next = await tx.bid.findFirst({
        where: {
          auctionId: settlement.auctionId,
          status: { in: ['OUTBID'] },
          id: { not: forfeitedBidId },
        },
        orderBy: [{ amount: 'desc' }, { placedAt: 'asc' }],
      });

      if (!next) {
        // Chain exhausted.
        await tx.auctionSettlement.update({
          where: { id: settlementId },
          data: { status: 'EXHAUSTED', currentWinnerBidId: null },
        });
        await tx.auction.update({
          where: { id: settlement.auctionId },
          data: { status: 'EXPIRED' },
        });
        await notificationService.notify(tx, {
          userId: settlement.auction.sellerId,
          type: 'AUCTION_EXPIRED',
          payload: { auctionId: settlement.auctionId, reason: 'all bidders forfeited' },
        });
        realtime.emitAuctionStatus(settlement.auctionId, 'EXPIRED');
        return;
      }

      // Promote the next bidder.
      await tx.bid.update({ where: { id: next.id }, data: { status: 'WON' } });

      const deadline = new Date(Date.now() + env.PAYMENT_WINDOW_HOURS * 60 * 60 * 1000);
      const updated = await tx.auctionSettlement.update({
        where: { id: settlementId },
        data: {
          currentWinnerBidId: next.id,
          paymentDeadline: deadline,
          attemptCount: { increment: 1 },
        },
      });

      await notificationService.notify(tx, {
        userId: next.bidderId,
        type: 'WON',
        payload: {
          auctionId: settlement.auctionId,
          title: settlement.auction.title,
          amount: next.amount.toFixed(2),
          deadline,
          promoted: true,
        },
      });
      await notificationService.notify(tx, {
        userId: settlement.auction.sellerId,
        type: 'AUCTION_ENDED',
        payload: {
          auctionId: settlement.auctionId,
          promoted: true,
          attempt: updated.attemptCount,
        },
      });

      realtime.emitAuctionStatus(settlement.auctionId, 'PAYMENT_PENDING');
      await schedulePaymentTimeout(settlementId, deadline);
    });
  },

  /**
   * Mark a settlement paid. Called from:
   *   - POST /payments/verify (winner confirms a Razorpay Checkout success)
   *   - the Razorpay webhook (payment.captured / order.paid)
   *   - the dev mock-complete endpoint
   *
   * Idempotent: if already PAID it is a no-op, so the verify call and the webhook
   * can both fire safely. `opts.provider` / `opts.externalRef` record the real PSP
   * reference; when a PENDING transaction already exists (created at checkout) it
   * is promoted to COMPLETED rather than duplicated.
   */
  async markPaid(
    settlementId: string,
    paidByUserId: string,
    amount: Prisma.Decimal,
    opts?: { provider?: string; externalRef?: string },
  ): Promise<void> {
    let didTransition = false;
    await prisma.$transaction(async (tx) => {
      // Lock the settlement row for the duration of the transaction. The verify
      // call and the payment.captured webhook fire near-simultaneously in the
      // normal Razorpay flow; without this, both could read AWAITING_PAYMENT and
      // double-write the ledger. The second caller blocks here, then sees PAID.
      await tx.$queryRaw`SELECT id FROM "AuctionSettlement" WHERE id = ${settlementId} FOR UPDATE`;

      const settlement = await tx.auctionSettlement.findUnique({
        where: { id: settlementId },
        include: { auction: true, currentWinnerBid: true },
      });
      if (!settlement) throw notFound('Settlement not found');
      if (settlement.status === 'PAID') return; // idempotent no-op
      if (settlement.status !== 'AWAITING_PAYMENT') {
        throw conflict('Settlement is not awaiting payment');
      }
      if (settlement.currentWinnerBid?.bidderId !== paidByUserId) {
        throw forbidden('You are not the current obligated buyer');
      }

      const provider = opts?.provider ?? 'MOCK';

      // Commission (revenue model): the platform keeps gross * bps / 10000,
      // rounded to 2dp; the seller's net is gross - commission. Exact Decimal
      // math throughout — never JS floats.
      const commission = amount
        .mul(env.PLATFORM_COMMISSION_BPS)
        .div(10000)
        .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
      const sellerNet = amount.minus(commission);

      // Promote the checkout-created PENDING transaction if present, else create one.
      const pending = await tx.transaction.findFirst({
        where: { settlementId, status: 'PENDING' },
        orderBy: { createdAt: 'desc' },
      });
      if (pending) {
        await tx.transaction.update({
          where: { id: pending.id },
          data: {
            status: 'COMPLETED',
            provider,
            externalRef: opts?.externalRef ?? pending.externalRef,
            commissionAmount: commission,
          },
        });
      } else {
        await tx.transaction.create({
          data: {
            settlementId,
            amount,
            status: 'COMPLETED',
            provider,
            externalRef: opts?.externalRef ?? null,
            commissionAmount: commission,
          },
        });
      }

      // Credit the SELLER's wallet with the net proceeds. Keyed by settlementId
      // so re-runs (verify + webhook) never double-credit — the unique
      // idempotencyKey on WalletTransaction enforces this. Composed inside this
      // transaction so the credit commits atomically with the sale.
      await walletService.credit(
        {
          userId: settlement.auction.sellerId,
          amountDecimal: sellerNet,
          type: 'SALE_CREDIT',
          reference: settlementId,
          idempotencyKey: `sale:${settlementId}`,
          description: `Sale proceeds for "${settlement.auction.title}" (net of ${commission.toFixed(2)} commission)`,
        },
        tx,
      );

      await tx.auctionSettlement.update({
        where: { id: settlementId },
        data: { status: 'PAID' },
      });
      await tx.auction.update({
        where: { id: settlement.auctionId },
        data: { status: 'SOLD', soldAt: new Date() },
      });

      await notificationService.notify(tx, {
        userId: settlement.auction.sellerId,
        type: 'AUCTION_SOLD',
        payload: { auctionId: settlement.auctionId, amount: amount.toFixed(2) },
      });
      realtime.emitAuctionStatus(settlement.auctionId, 'SOLD');
      didTransition = true;
    });

    // Cancel the pending timeout job — payment beat the clock.
    if (didTransition) await cancelPaymentTimeout(settlementId);
  },

  async getById(settlementId: string, viewerId: string) {
    const s = await prisma.auctionSettlement.findUnique({
      where: { id: settlementId },
      include: {
        auction: { include: { seller: { select: { id: true, name: true } } } },
        currentWinnerBid: { include: { bidder: { select: { id: true, name: true } } } },
      },
    });
    if (!s) throw notFound();
    if (s.currentWinnerBid?.bidderId !== viewerId && s.auction.sellerId !== viewerId) {
      throw forbidden('Not your settlement');
    }
    return s;
  },
};

const schedulePaymentTimeout = async (settlementId: string, deadline: Date): Promise<void> => {
  const delay = Math.max(0, deadline.getTime() - Date.now());
  await settlementQueue.add(
    JOB_NAMES.paymentTimeout,
    { settlementId },
    {
      delay,
      jobId: `${JOB_NAMES.paymentTimeout}_${settlementId}_${deadline.getTime()}`,
      removeOnComplete: true,
      removeOnFail: true,
    },
  );
};

const cancelPaymentTimeout = async (settlementId: string): Promise<void> => {
  const jobs = await settlementQueue.getJobs(['delayed', 'waiting']);
  for (const job of jobs) {
    if (job?.id?.startsWith(`${JOB_NAMES.paymentTimeout}_${settlementId}_`)) {
      await job.remove();
    }
  }
};
