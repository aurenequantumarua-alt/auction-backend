import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../middleware/auth.js';
import { CreateReportSchema } from './dto.js';
import { reportService } from './service.js';

export const registerReportRoutes = async (app: FastifyInstance): Promise<void> => {
  // User reports an auction.
  app.post('/auctions/:id/report', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const dto = CreateReportSchema.parse(req.body);
    const report = await reportService.create(req.user!.sub, id, dto);
    reply.status(201);
    return report;
  });
};
