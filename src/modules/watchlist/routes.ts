import type { FastifyInstance } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { requireAuth } from '../../middleware/auth.js';
import { notFound } from '../../utils/http-error.js';

export const registerWatchlistRoutes = async (app: FastifyInstance): Promise<void> => {
  app.get('/watchlist', { preHandler: requireAuth }, async (req) => {
    const items = await prisma.watchlist.findMany({
      where: { userId: req.user!.sub },
      orderBy: { createdAt: 'desc' },
      include: {
        auction: {
          include: {
            images: { orderBy: { sortOrder: 'asc' } },
            currentBid: { select: { amount: true } },
            seller: { select: { id: true, name: true, avatarUrl: true } },
            _count: { select: { bids: true } },
          },
        },
      },
    });
    return { items };
  });

  app.post('/auctions/:id/watch', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const auction = await prisma.auction.findUnique({ where: { id } });
    if (!auction) throw notFound('Auction not found');
    await prisma.watchlist.upsert({
      where: { userId_auctionId: { userId: req.user!.sub, auctionId: id } },
      update: {},
      create: { userId: req.user!.sub, auctionId: id },
    });
    return { watching: true };
  });

  app.delete('/auctions/:id/watch', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    await prisma.watchlist.deleteMany({
      where: { userId: req.user!.sub, auctionId: id },
    });
    return { watching: false };
  });
};
