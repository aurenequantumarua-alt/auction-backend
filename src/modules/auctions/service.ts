import { Prisma, AuctionStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { auctionLifecycleQueue } from '../../jobs/queue.js';
import { JOB_NAMES } from '../../config/constants.js';
import { conflict, forbidden, notFound } from '../../utils/http-error.js';
import { buildPage, skipTake } from '../../utils/pagination.js';
import { notificationService } from '../notifications/service.js';
import { realtime } from '../../realtime/gateway.js';
import { settlementService } from './settlement.service.js';
import type { CreateAuctionDto, UpdateAuctionDto, AuctionListQuery } from './dto.js';

const PUBLIC_AUCTION_INCLUDE = {
  seller: { select: { id: true, name: true, avatarUrl: true } },
  images: { orderBy: { sortOrder: 'asc' } },
  currentBid: { select: { id: true, amount: true, bidderId: true, placedAt: true } },
  _count: { select: { bids: true, watchlist: true } },
} satisfies Prisma.AuctionInclude;

export const auctionService = {
  async create(sellerId: string, dto: CreateAuctionDto) {
    const startsAt = new Date(dto.startsAt);
    const endsAt = new Date(dto.endsAt);
    const status: AuctionStatus = dto.publish
      ? startsAt <= new Date()
        ? 'LIVE'
        : 'UPCOMING'
      : 'DRAFT';

    const auction = await prisma.auction.create({
      data: {
        sellerId,
        title: dto.title,
        description: dto.description,
        category: dto.category,
        brand: dto.brand,
        condition: dto.condition,
        size: dto.size,
        basePrice: new Prisma.Decimal(dto.basePrice),
        minIncrement: new Prisma.Decimal(dto.minIncrement),
        buyNowPrice: dto.buyNowPrice ? new Prisma.Decimal(dto.buyNowPrice) : null,
        startsAt,
        endsAt,
        tags: dto.tags,
        status,
        images: {
          create: dto.images.map((img, idx) => ({
            url: img.url,
            sortOrder: idx,
            isCover: img.isCover || idx === 0,
          })),
        },
      },
      include: PUBLIC_AUCTION_INCLUDE,
    });

    if (status !== 'DRAFT') {
      await scheduleLifecycleJobs(auction.id, startsAt, endsAt, status);
    }

    return auction;
  },

  async update(sellerId: string, auctionId: string, dto: UpdateAuctionDto) {
    const existing = await prisma.auction.findUnique({
      where: { id: auctionId },
      include: { images: true },
    });
    if (!existing) throw notFound('Auction not found');
    if (existing.sellerId !== sellerId) throw forbidden('Not your auction');
    if (existing.status !== 'DRAFT' && existing.status !== 'UPCOMING') {
      throw conflict('Auctions can only be edited before they go live');
    }

    const data: Prisma.AuctionUpdateInput = {};
    if (dto.title !== undefined) data.title = dto.title;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.category !== undefined) data.category = dto.category;
    if (dto.brand !== undefined) data.brand = dto.brand;
    if (dto.condition !== undefined) data.condition = dto.condition;
    if (dto.size !== undefined) data.size = dto.size;
    if (dto.basePrice !== undefined) data.basePrice = new Prisma.Decimal(dto.basePrice);
    if (dto.minIncrement !== undefined) data.minIncrement = new Prisma.Decimal(dto.minIncrement);
    if (dto.buyNowPrice !== undefined) {
      data.buyNowPrice = dto.buyNowPrice ? new Prisma.Decimal(dto.buyNowPrice) : null;
    }
    if (dto.tags !== undefined) data.tags = dto.tags;
    if (dto.startsAt !== undefined) data.startsAt = new Date(dto.startsAt);
    if (dto.endsAt !== undefined) data.endsAt = new Date(dto.endsAt);

    const updated = await prisma.auction.update({
      where: { id: auctionId },
      data,
      include: PUBLIC_AUCTION_INCLUDE,
    });

    if (dto.images) {
      await prisma.$transaction([
        prisma.auctionImage.deleteMany({ where: { auctionId } }),
        prisma.auctionImage.createMany({
          data: dto.images.map((img, idx) => ({
            auctionId,
            url: img.url,
            sortOrder: idx,
            isCover: img.isCover || idx === 0,
          })),
        }),
      ]);
    }

    if (existing.status === 'UPCOMING' && (dto.startsAt || dto.endsAt)) {
      await rescheduleLifecycleJobs(updated.id, updated.startsAt, updated.endsAt);
    }

    return updated;
  },

  async publishDraft(sellerId: string, auctionId: string) {
    const auction = await prisma.auction.findUnique({ where: { id: auctionId } });
    if (!auction) throw notFound('Auction not found');
    if (auction.sellerId !== sellerId) throw forbidden('Not your auction');
    if (auction.status !== 'DRAFT') throw conflict('Auction is not a draft');

    const now = new Date();
    const status: AuctionStatus = auction.startsAt <= now ? 'LIVE' : 'UPCOMING';
    const updated = await prisma.auction.update({
      where: { id: auctionId },
      data: { status },
      include: PUBLIC_AUCTION_INCLUDE,
    });
    await scheduleLifecycleJobs(updated.id, updated.startsAt, updated.endsAt, status);
    return updated;
  },

  async deleteDraft(sellerId: string, auctionId: string) {
    const auction = await prisma.auction.findUnique({ where: { id: auctionId } });
    if (!auction) throw notFound('Auction not found');
    if (auction.sellerId !== sellerId) throw forbidden('Not your auction');
    if (auction.status !== 'DRAFT') throw conflict('Only drafts can be deleted');
    await prisma.auction.delete({ where: { id: auctionId } });
  },

  async cancel(sellerId: string, auctionId: string) {
    const auction = await prisma.auction.findUnique({ where: { id: auctionId } });
    if (!auction) throw notFound('Auction not found');
    if (auction.sellerId !== sellerId) throw forbidden('Not your auction');
    if (auction.status === 'LIVE' && auction.bidCount > 0) {
      throw conflict('Cannot cancel a live auction that already has bids');
    }
    if (auction.status === 'SOLD' || auction.status === 'CANCELLED') {
      throw conflict('Auction is already in a terminal state');
    }
    return prisma.auction.update({
      where: { id: auctionId },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
      include: PUBLIC_AUCTION_INCLUDE,
    });
  },

  /**
   * Seller ends a LIVE auction immediately ("close now"). If there are bids, the
   * current highest bidder wins right away (settlement created, PAYMENT_PENDING)
   * — the same path as a natural end, so the buyer-doesn't-pay fallback chain
   * still applies. If there are no bids, the auction simply expires. The
   * scheduled end job is removed so it can't double-fire.
   */
  async endNow(sellerId: string, auctionId: string) {
    const auction = await prisma.auction.findUnique({ where: { id: auctionId } });
    if (!auction) throw notFound('Auction not found');
    if (auction.sellerId !== sellerId) throw forbidden('Not your auction');
    if (auction.status !== 'LIVE') throw conflict('Only a live auction can be ended now');

    const endJobId = `${JOB_NAMES.endAuction}_${auctionId}`;
    const job = await auctionLifecycleQueue.getJob(endJobId);
    try { if (job) await job.remove(); } catch { /* job already picked up by worker */ }

    // Sells to the top bid (PAYMENT_PENDING) or expires if there are no bids.
    await settlementService.finalizeAuction(auctionId);

    return prisma.auction.findUnique({
      where: { id: auctionId },
      include: PUBLIC_AUCTION_INCLUDE,
    });
  },

  async list(query: AuctionListQuery) {
    const now = new Date();

    // Reconcile any LIVE auctions whose endsAt has passed
    await prisma.auction.updateMany({
      where: { status: 'LIVE', endsAt: { lte: now } },
      data: { status: 'ENDED' },
    });

    const where: Prisma.AuctionWhereInput = {};

    if (query.status === 'LIVE') {
      where.status = 'LIVE';
      where.endsAt = { gt: now };
      where.startsAt = { lte: now };
    } else if (query.status === 'UPCOMING') {
      where.OR = [
        { status: 'UPCOMING' },
        { status: 'LIVE', startsAt: { gt: now } },
      ];
    } else if (query.status === 'ENDED') {
      where.OR = [
        { status: { in: ['ENDED', 'EXPIRED', 'PAYMENT_PENDING', 'SOLD'] } },
        { status: 'LIVE', endsAt: { lte: now } },
      ];
    } else if (query.status) {
      where.status = query.status;
    } else {
      where.status = { in: ['UPCOMING', 'LIVE', 'ENDED'] };
    }
    if (query.q) {
      const textFilter: Prisma.AuctionWhereInput[] = [
        { title: { contains: query.q, mode: 'insensitive' } },
        { brand: { contains: query.q, mode: 'insensitive' } },
        { description: { contains: query.q, mode: 'insensitive' } },
      ];
      if (where.OR) {
        // Combine existing status filter with text search using AND
        where.AND = [{ OR: where.OR }, { OR: textFilter }];
        delete where.OR;
      } else {
        where.OR = textFilter;
      }
    }
    if (query.category) where.category = query.category;
    if (query.brand) where.brand = { equals: query.brand, mode: 'insensitive' };
    if (query.condition) where.condition = query.condition;
    if (query.minPrice !== undefined || query.maxPrice !== undefined) {
      where.basePrice = {
        ...(query.minPrice !== undefined ? { gte: new Prisma.Decimal(query.minPrice) } : {}),
        ...(query.maxPrice !== undefined ? { lte: new Prisma.Decimal(query.maxPrice) } : {}),
      };
    }

    if (query.sort === 'ending_soon' && !query.status) {
      where.endsAt = { gt: now };
    }

    // When status is not filtered (e.g. All statuses), always prioritize LIVE auctions before ENDED auctions
    const statusOrder: Prisma.AuctionOrderByWithRelationInput[] = !query.status
      ? [{ status: 'asc' }]
      : [];

    const orderBy: Prisma.AuctionOrderByWithRelationInput[] = (() => {
      switch (query.sort) {
        case 'ending_soon':
          return [...statusOrder, { endsAt: 'asc' }];
        case 'highest_bid':
          return [...statusOrder, { currentBid: { amount: 'desc' } }, { endsAt: 'asc' }];
        case 'most_bids':
          return [...statusOrder, { bidCount: 'desc' }, { endsAt: 'asc' }];
        case 'newest':
        default:
          return [...statusOrder, { createdAt: 'desc' }];
      }
    })();

    const [items, total] = await Promise.all([
      prisma.auction.findMany({
        where,
        orderBy,
        ...skipTake(query),
        include: PUBLIC_AUCTION_INCLUDE,
      }),
      prisma.auction.count({ where }),
    ]);
    return buildPage(items, total, query.page, query.pageSize);
  },

  async getById(auctionId: string, viewerId?: string) {
    const auction = await prisma.auction.findUnique({
      where: { id: auctionId },
      include: {
        ...PUBLIC_AUCTION_INCLUDE,
        settlement: {
          include: { currentWinnerBid: true, dispute: true },
        },
        bids: {
          orderBy: [{ amount: 'desc' }, { placedAt: 'asc' }],
          take: 25,
          include: { bidder: { select: { id: true, name: true, avatarUrl: true } } },
        },
      },
    });
    if (!auction) throw notFound('Auction not found');

    // Lazy reconciliation: if auction is LIVE but endsAt passed, finalize it immediately
    if (auction.status === 'LIVE' && auction.endsAt <= new Date()) {
      await settlementService.finalizeAuction(auctionId);
      const refreshed = await prisma.auction.findUnique({
        where: { id: auctionId },
        include: {
          ...PUBLIC_AUCTION_INCLUDE,
          settlement: {
            include: { currentWinnerBid: true, dispute: true },
          },
          bids: {
            orderBy: [{ amount: 'desc' }, { placedAt: 'asc' }],
            take: 25,
            include: { bidder: { select: { id: true, name: true, avatarUrl: true } } },
          },
        },
      });
      if (refreshed) {
        return { ...refreshed, isWatched: false };
      }
    }

    // Lazy reconciliation: if payment deadline elapsed while awaiting payment, forfeit and promote immediately
    if (
      auction.status === 'PAYMENT_PENDING' &&
      auction.settlement?.status === 'AWAITING_PAYMENT' &&
      auction.settlement.paymentDeadline <= new Date()
    ) {
      await settlementService.forfeitAndPromote(auction.settlement.id);
      const refreshed = await prisma.auction.findUnique({
        where: { id: auctionId },
        include: {
          ...PUBLIC_AUCTION_INCLUDE,
          settlement: {
            include: { currentWinnerBid: true, dispute: true },
          },
          bids: {
            orderBy: [{ amount: 'desc' }, { placedAt: 'asc' }],
            take: 25,
            include: { bidder: { select: { id: true, name: true, avatarUrl: true } } },
          },
        },
      });
      if (refreshed) {
        let isWatched = false;
        if (viewerId) {
          const w = await prisma.watchlist.findUnique({
            where: { userId_auctionId: { userId: viewerId, auctionId } },
          });
          isWatched = !!w;
        }
        return { ...refreshed, isWatched };
      }
    }

    // Fire-and-forget view counter — never block the response.
    void prisma.auction.update({
      where: { id: auctionId },
      data: { viewCount: { increment: 1 } },
      select: { id: true },
    }).catch(() => { });

    let isWatched = false;
    if (viewerId) {
      const w = await prisma.watchlist.findUnique({
        where: { userId_auctionId: { userId: viewerId, auctionId } },
      });
      isWatched = !!w;
    }
    return { ...auction, isWatched };
  },

  async listMine(sellerId: string) {
    return prisma.auction.findMany({
      where: { sellerId },
      orderBy: { createdAt: 'desc' },
      include: {
        ...PUBLIC_AUCTION_INCLUDE,
        settlement: true,
      },
    });
  },

  async sellerEarnings(sellerId: string) {
    const sold = await prisma.auction.findMany({
      where: { sellerId, status: 'SOLD' },
      select: { id: true, currentBid: { select: { amount: true } } },
    });
    const total = sold.reduce(
      (acc, a) => acc.plus(a.currentBid?.amount ?? 0),
      new Prisma.Decimal(0),
    );
    return {
      soldCount: sold.length,
      totalEarnings: total.toFixed(2),
    };
  },

  async myBids(userId: string) {
    return prisma.bid.findMany({
      where: { bidderId: userId },
      orderBy: { placedAt: 'desc' },
      include: {
        auction: { include: PUBLIC_AUCTION_INCLUDE },
      },
      take: 100,
    });
  },

  async myWins(userId: string) {
    return prisma.bid.findMany({
      where: { bidderId: userId, status: 'WON' },
      orderBy: { placedAt: 'desc' },
      include: {
        auction: {
          include: {
            ...PUBLIC_AUCTION_INCLUDE,
            settlement: {
              include: { dispute: true },
            },
          },
        },
      },
    });
  },

  /**
   * "Buy It Now": a buyer pays the buyNowPrice instantly. The auction ends,
   * the buyer becomes the sole winner, and a settlement is created exactly
   * like a natural auction close. Row-locked to prevent concurrent buys.
   */
  async buyNow(auctionId: string, buyerId: string) {
    await prisma.$transaction(async (tx) => {
      // Row-lock the auction to prevent concurrent buy-now / bid races.
      await tx.$queryRaw`SELECT id FROM "Auction" WHERE id = ${auctionId} FOR UPDATE`;

      const auction = await tx.auction.findUnique({
        where: { id: auctionId },
        include: { currentBid: true, settlement: true },
      });
      if (!auction) throw notFound('Auction not found');
      if (auction.status !== 'LIVE') throw conflict('Auction is not live');
      if (!auction.buyNowPrice) throw conflict('This auction does not have a Buy It Now price');
      if (auction.sellerId === buyerId) throw forbidden('Cannot buy your own auction');

      const buyNowAmount = auction.buyNowPrice;

      // Create a bid at the buy-now price and mark it WON immediately.
      const bid = await tx.bid.create({
        data: {
          auctionId,
          bidderId: buyerId,
          amount: buyNowAmount,
          status: 'WON',
        },
      });

      // Outbid all existing active bids.
      await tx.bid.updateMany({
        where: { auctionId, id: { not: bid.id }, status: 'ACTIVE' },
        data: { status: 'OUTBID' },
      });

      const deadline = new Date(Date.now() + 48 * 60 * 60 * 1000);
      await tx.auctionSettlement.create({
        data: {
          auctionId,
          currentWinnerBidId: bid.id,
          paymentDeadline: deadline,
        },
      });

      await tx.auction.update({
        where: { id: auctionId },
        data: {
          status: 'PAYMENT_PENDING',
          currentBidId: bid.id,
          bidCount: { increment: 1 },
        },
      });

      await notificationService.notify(tx, {
        userId: buyerId,
        type: 'WON',
        payload: { auctionId, title: auction.title, amount: buyNowAmount.toFixed(2), buyNow: true },
      });
      await notificationService.notify(tx, {
        userId: auction.sellerId,
        type: 'AUCTION_ENDED',
        payload: {
          auctionId,
          title: auction.title,
          winnerBidId: bid.id,
          amount: buyNowAmount.toFixed(2),
          buyNow: true,
        },
      });

      realtime.emitAuctionStatus(auctionId, 'PAYMENT_PENDING');
    });

    // Remove the scheduled end job — the auction is over.
    const endJobId = `${JOB_NAMES.endAuction}_${auctionId}`;
    const job = await auctionLifecycleQueue.getJob(endJobId);
    try { if (job) await job.remove(); } catch { /* job already picked up by worker */ }

    return prisma.auction.findUnique({
      where: { id: auctionId },
      include: PUBLIC_AUCTION_INCLUDE,
    });
  },
};

const scheduleLifecycleJobs = async (
  auctionId: string,
  startsAt: Date,
  endsAt: Date,
  status: AuctionStatus,
): Promise<void> => {
  try {
    const now = Date.now();
    if (status === 'UPCOMING') {
      const delay = Math.max(0, startsAt.getTime() - now);
      await auctionLifecycleQueue.add(
        JOB_NAMES.goLive,
        { auctionId },
        { delay, jobId: `${JOB_NAMES.goLive}_${auctionId}`, removeOnComplete: true, removeOnFail: true },
      );
    }
    const endDelay = Math.max(0, endsAt.getTime() - now);
    await auctionLifecycleQueue.add(
      JOB_NAMES.endAuction,
      { auctionId },
      { delay: endDelay, jobId: `${JOB_NAMES.endAuction}_${auctionId}`, removeOnComplete: true, removeOnFail: true },
    );
  } catch (err) {
    // Non-blocking: BullMQ is optional when local Redis is not running
  }
};

const rescheduleLifecycleJobs = async (
  auctionId: string,
  startsAt: Date,
  endsAt: Date,
): Promise<void> => {
  try {
    const goLiveId = `${JOB_NAMES.goLive}_${auctionId}`;
    const endId = `${JOB_NAMES.endAuction}_${auctionId}`;
    const existingGoLive = await auctionLifecycleQueue.getJob(goLiveId);
    if (existingGoLive) await existingGoLive.remove();
    const existingEnd = await auctionLifecycleQueue.getJob(endId);
    if (existingEnd) await existingEnd.remove();

    const now = Date.now();
    await auctionLifecycleQueue.add(
      JOB_NAMES.goLive,
      { auctionId },
      { delay: Math.max(0, startsAt.getTime() - now), jobId: goLiveId, removeOnComplete: true, removeOnFail: true },
    );
    await auctionLifecycleQueue.add(
      JOB_NAMES.endAuction,
      { auctionId },
      { delay: Math.max(0, endsAt.getTime() - now), jobId: endId, removeOnComplete: true, removeOnFail: true },
    );
  } catch (err) {
    // Non-blocking
  }
};

export const auctionLifecycle = { schedule: scheduleLifecycleJobs, reschedule: rescheduleLifecycleJobs };
