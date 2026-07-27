import type { FastifyInstance } from 'fastify';
import { optionalAuth, requireAuth } from '../../middleware/auth.js';
import {
  AuctionListQuerySchema,
  CreateAuctionSchema,
  UpdateAuctionSchema,
} from './dto.js';
import { auctionService } from './service.js';
import { settlementService } from './settlement.service.js';
import { forbidden } from '../../utils/http-error.js';

export const registerAuctionRoutes = async (app: FastifyInstance): Promise<void> => {
  // Browse / search
  app.get('/auctions', { preHandler: optionalAuth }, async (req) => {
    const query = AuctionListQuerySchema.parse(req.query);
    return auctionService.list(query);
  });

  app.get('/auctions/:id', { preHandler: optionalAuth }, async (req) => {
    const { id } = req.params as { id: string };
    return auctionService.getById(id, req.user?.sub);
  });

  // Seller endpoints
  app.post('/auctions', { preHandler: requireAuth }, async (req, reply) => {
    const dto = CreateAuctionSchema.parse(req.body);
    const auction = await auctionService.create(req.user!.sub, dto);
    reply.status(201);
    return auction;
  });

  app.patch('/auctions/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const dto = UpdateAuctionSchema.parse(req.body);
    return auctionService.update(req.user!.sub, id, dto);
  });

  app.post('/auctions/:id/publish', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    return auctionService.publishDraft(req.user!.sub, id);
  });

  app.post('/auctions/:id/cancel', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    return auctionService.cancel(req.user!.sub, id);
  });

  // Seller ends a live auction immediately, selling to the current top bidder.
  app.post('/auctions/:id/end-now', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    return auctionService.endNow(req.user!.sub, id);
  });

  app.delete('/auctions/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await auctionService.deleteDraft(req.user!.sub, id);
    reply.status(204);
  });

  app.get('/auctions/me/listings', { preHandler: requireAuth }, async (req) => {
    return { items: await auctionService.listMine(req.user!.sub) };
  });

  app.get('/auctions/me/earnings', { preHandler: requireAuth }, async (req) => {
    return auctionService.sellerEarnings(req.user!.sub);
  });

  app.get('/auctions/me/bids', { preHandler: requireAuth }, async (req) => {
    return { items: await auctionService.myBids(req.user!.sub) };
  });

  app.get('/auctions/me/wins', { preHandler: requireAuth }, async (req) => {
    return { items: await auctionService.myWins(req.user!.sub) };
  });

  // Settlement endpoints (used by the winner / seller while payment is pending)
  app.get('/settlements/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    return settlementService.getById(id, req.user!.sub);
  });

  app.post('/settlements/:id/decline', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    // Only the current obligated buyer can decline; service enforces this.
    const s = await settlementService.getById(id, req.user!.sub);
    if (s.currentWinnerBid?.bidderId !== req.user!.sub) {
      throw forbidden('Only the current winner can decline');
    }
    await settlementService.forfeitAndPromote(id);
    return { ok: true };
  });
};
