import type { FastifyInstance } from 'fastify';
import { env } from '../../config/env.js';
import { requireAuth, optionalAuth } from '../../middleware/auth.js';
import { PlaceBidSchema } from './dto.js';
import { bidService } from './service.js';

export const registerBidRoutes = async (app: FastifyInstance): Promise<void> => {
  app.post('/auctions/:id/bids', {
    preHandler: requireAuth,
    config: {
      rateLimit: { max: env.RATE_LIMIT_BID_MAX, timeWindow: env.RATE_LIMIT_BID_WINDOW_MS },
    },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const dto = PlaceBidSchema.parse(req.body);
      const bid = await bidService.place(id, req.user!.sub, dto);
      reply.status(201);
      return {
        id: bid.id,
        amount: bid.amount.toFixed(2),
        placedAt: bid.placedAt.toISOString(),
      };
    },
  });

  app.get('/auctions/:id/bids', { preHandler: optionalAuth }, async (req) => {
    const { id } = req.params as { id: string };
    return { items: await bidService.listForAuction(id) };
  });
};
