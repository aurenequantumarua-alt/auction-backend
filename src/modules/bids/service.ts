import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { JOB_NAMES } from '../../config/constants.js';
import { auctionLifecycleQueue } from '../../jobs/queue.js';
import { realtime } from '../../realtime/gateway.js';
import { notificationService } from '../notifications/service.js';
import { badRequest, conflict, forbidden, notFound } from '../../utils/http-error.js';
import type { PlaceBidDto } from './dto.js';

export const bidService = {
  /**
   * Place a bid against a LIVE auction.
   *
   * Concurrency: Postgres serializable isolation guarantees that two bids
   * cannot both succeed thinking they're the highest. Whichever transaction
   * commits first wins; the other gets a serialization failure and is retried
   * once at the route layer (or surfaces as conflict to the client).
   *
   * Anti-sniping: if the bid is placed within `ANTI_SNIPE_WINDOW_SECONDS` of
   * the auction's `endsAt`, we extend `endsAt` by `ANTI_SNIPE_EXTEND_SECONDS`
   * and reschedule the auction.end job.
   */
  async place(auctionId: string, bidderId: string, dto: PlaceBidDto) {
    const amount = new Prisma.Decimal(dto.amount);

    const result = await prisma.$transaction(
      async (tx) => {
        // Exclusively lock the auction row for the duration of this transaction.
        // This serializes all concurrent bids on this auction and prevents race conditions
        // where two users place bids at the exact same millisecond.
        await tx.$queryRaw`SELECT id FROM "Auction" WHERE id = ${auctionId} FOR UPDATE`;

        const auction = await tx.auction.findUnique({
          where: { id: auctionId },
          include: { currentBid: true },
        });
        if (!auction) throw notFound('Auction not found');
        if (auction.sellerId === bidderId) throw forbidden('You cannot bid on your own auction');
        if (auction.status !== 'LIVE') throw conflict('Auction is not currently accepting bids');

        const now = new Date();
        if (now < auction.startsAt) throw conflict('Auction has not started yet');
        if (now >= auction.endsAt) throw conflict('Auction has already ended');

        const minRequired = auction.currentBid
          ? auction.currentBid.amount.plus(auction.minIncrement)
          : auction.basePrice;

        if (amount.lessThan(minRequired)) {
          throw badRequest(
            `Bid must be at least ${minRequired.toFixed(2)} (current ${
              auction.currentBid?.amount.toFixed(2) ?? auction.basePrice.toFixed(2)
            } + ${auction.minIncrement.toFixed(2)} increment)`,
          );
        }

        const previousTopBid = auction.currentBid;

        const bid = await tx.bid.create({
          data: {
            auctionId,
            bidderId,
            amount,
            status: 'ACTIVE',
          },
        });

        // Mark previous top bid OUTBID.
        if (previousTopBid) {
          await tx.bid.update({
            where: { id: previousTopBid.id },
            data: { status: 'OUTBID' },
          });
        }

        // Anti-snipe: if we're inside the trailing window, extend the auction.
        const remainingMs = auction.endsAt.getTime() - now.getTime();
        const updateData: Prisma.AuctionUpdateInput = {
          currentBid: { connect: { id: bid.id } },
          bidCount: { increment: 1 },
        };
        let extendedEndsAt: Date | null = null;
        if (remainingMs <= env.ANTI_SNIPE_WINDOW_SECONDS * 1000) {
          const newEndsAt = new Date(now.getTime() + env.ANTI_SNIPE_EXTEND_SECONDS * 1000);
          updateData.endsAt = newEndsAt;
          extendedEndsAt = newEndsAt;
        }

        await tx.auction.update({ where: { id: auctionId }, data: updateData });

        // Notify the previous top bidder that they're outbid.
        if (previousTopBid && previousTopBid.bidderId !== bidderId) {
          await notificationService.notify(tx, {
            userId: previousTopBid.bidderId,
            type: 'OUTBID',
            payload: {
              auctionId,
              title: auction.title,
              previousAmount: previousTopBid.amount.toFixed(2),
              newAmount: amount.toFixed(2),
            },
          });
        }

        return {
          bid,
          auctionTitle: auction.title,
          previousAmount: previousTopBid?.amount ?? null,
          extendedEndsAt,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    // Realtime broadcasts (outside the transaction so subscribers don't see
    // partially committed state).
    realtime.emitBidPlaced(auctionId, {
      bidId: result.bid.id,
      amount: result.bid.amount.toFixed(2),
      bidderId,
      placedAt: result.bid.placedAt.toISOString(),
    });
    if (result.extendedEndsAt) {
      realtime.emitAuctionExtended(auctionId, result.extendedEndsAt.toISOString());
      // Reschedule the end job so it fires at the new time.
      const endId = `${JOB_NAMES.endAuction}_${auctionId}`;
      const existing = await auctionLifecycleQueue.getJob(endId);
      if (existing) await existing.remove();
      await auctionLifecycleQueue.add(
        JOB_NAMES.endAuction,
        { auctionId },
        {
          delay: Math.max(0, result.extendedEndsAt.getTime() - Date.now()),
          jobId: endId,
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
    }

    return result.bid;
  },

  async listForAuction(auctionId: string) {
    return prisma.bid.findMany({
      where: { auctionId },
      orderBy: [{ amount: 'desc' }, { placedAt: 'asc' }],
      include: { bidder: { select: { id: true, name: true, avatarUrl: true } } },
      take: 100,
    });
  },
};
