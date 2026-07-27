import type { FastifyInstance } from 'fastify';
import { requireAuth, requireAdmin } from '../../middleware/auth.js';
import { adminService } from './service.js';
import { reportService } from '../reports/service.js';
import { UpdateReportStatusSchema } from '../reports/dto.js';

export const registerAdminRoutes = async (app: FastifyInstance): Promise<void> => {
  app.get('/auctions', { preHandler: [requireAuth, requireAdmin] }, async () => {
    const auctions = await adminService.listAuctions();
    return { items: auctions };
  });

  app.delete('/auctions/:id', { preHandler: [requireAuth, requireAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await adminService.deleteAuction(id);
    reply.status(204);
  });

  // Reports management
  app.get('/reports', { preHandler: [requireAuth, requireAdmin] }, async (req) => {
    const { status } = req.query as { status?: string };
    const reports = await reportService.listAll(status);
    return { items: reports };
  });

  app.patch('/reports/:id', { preHandler: [requireAuth, requireAdmin] }, async (req) => {
    const { id } = req.params as { id: string };
    const dto = UpdateReportStatusSchema.parse(req.body);
    return reportService.updateStatus(id, dto);
  });
};
