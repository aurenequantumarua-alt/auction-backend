import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../middleware/auth.js';
import { RequestWithdrawalSchema } from './dto.js';
import { withdrawalService } from './service.js';

export const registerWithdrawalRoutes = async (app: FastifyInstance): Promise<void> => {
  app.post('/withdrawals', { preHandler: requireAuth }, async (req, reply) => {
    const dto = RequestWithdrawalSchema.parse(req.body);
    const withdrawal = await withdrawalService.request(req.user!.sub, dto.amount);
    reply.status(201);
    return { withdrawal };
  });

  app.get('/withdrawals', { preHandler: requireAuth }, async (req) => {
    return { items: await withdrawalService.list(req.user!.sub) };
  });
};
