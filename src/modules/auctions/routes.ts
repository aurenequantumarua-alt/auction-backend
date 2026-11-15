import type { FastifyInstance } from 'fastify';
import { optionalAuth, requireAuth } from '../../middleware/auth.js';
import {
  AuctionListQuerySchema,
  CreateAuctionSchema,
  UpdateAuctionSchema,
} from './dto.js';
import { auctionService } from './service.js';
import { settlementService } from './settlement.service.js';
import { badRequest, forbidden } from '../../utils/http-error.js';
import { prisma } from '../../lib/prisma.js';
import { z } from 'zod';

const ShipSchema = z.object({
  trackingNumber: z.string().trim().min(1, 'Tracking number is required').max(100),
  courierName: z.string().trim().min(1, 'Courier name is required').max(100),
});

const ShippingAddressSchema = z.object({
  shippingName: z.string().min(2, 'Full name is required').max(100).trim(),
  shippingPhone: z.string().min(10, 'Valid 10-digit mobile number required').max(15).trim(),
  shippingAddress: z.string().min(5, 'Detailed delivery address required').max(300).trim(),
  shippingCity: z.string().min(2, 'City is required').max(100).trim(),
  shippingState: z.string().min(2, 'State is required').max(100).trim(),
  shippingPostalCode: z.string().min(5, 'Postal PIN code required').max(10).trim(),
});

const DisputeSchema = z.object({
  reason: z.enum([
    'COUNTERFEIT',
    'NOT_AS_DESCRIBED',
    'DAMAGED',
    'WRONG_ITEM',
    'NOT_DELIVERED',
  ]),
  description: z.string().trim().min(10, 'Description must be at least 10 characters').max(2000),
  proofUrls: z
    .array(
      z
        .string()
        .url('Each proof must be a valid image URL')
        .refine((u) => /^https?:\/\//i.test(u), 'Proof URL must use http or https'),
    )
    .min(1, 'At least one proof image is required')
    .max(10, 'Maximum 10 proof images allowed'),
});

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

  // Buyer triggers "Buy It Now" on a live auction with a buyNowPrice set.
  app.post('/auctions/:id/buy-now', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    return auctionService.buyNow(id, req.user!.sub);
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

  // ── Escrow lifecycle endpoints ────────────────────────────────────────

  // Buyer submits / updates delivery address for their won auction.
  app.post('/settlements/:id/address', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const address = ShippingAddressSchema.parse(req.body);
    const s = await settlementService.getById(id, req.user!.sub);
    if (s.currentWinnerBid?.bidderId !== req.user!.sub) {
      throw forbidden('Only the winning bidder can submit the delivery address');
    }
    await prisma.auctionSettlement.update({
      where: { id },
      data: address,
    });
    return { ok: true };
  });

  // Seller marks the item as shipped with tracking info.
  app.post('/settlements/:id/ship', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const { trackingNumber, courierName } = ShipSchema.parse(req.body);
    await settlementService.markShipped(id, req.user!.sub, { trackingNumber, courierName });
    return { ok: true };
  });

  // Buyer or seller marks the item as delivered → starts inspection clock.
  app.post('/settlements/:id/delivered', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    await settlementService.markDelivered(id, req.user!.sub);
    return { ok: true };
  });

  // Buyer confirms item authenticity → releases funds (90% seller, 10% platform).
  app.post('/settlements/:id/confirm', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    await settlementService.confirmAndRelease(id, 'buyer', req.user!.sub);
    return { ok: true };
  });

  // Buyer opens a dispute with proof.
  app.post('/settlements/:id/dispute', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const { reason, description, proofUrls } = DisputeSchema.parse(req.body);
    await settlementService.openDispute(id, req.user!.sub, {
      reason,
      description,
      proofUrls,
    });
    return { ok: true };
  });
};
