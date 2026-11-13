import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../middleware/auth.js';
import { UpsertBankAccountSchema } from './dto.js';
import { bankAccountService, lookupIfsc } from './service.js';

export const registerBankAccountRoutes = async (app: FastifyInstance): Promise<void> => {
  app.get('/bank-account', { preHandler: requireAuth }, async (req) => {
    return { bankAccount: await bankAccountService.getMine(req.user!.sub) };
  });

  // Resolve an IFSC to its real bank + branch (validates the bank exists).
  app.get('/bank-account/ifsc/:ifsc', { preHandler: requireAuth }, async (req, reply) => {
    const { ifsc } = req.params as { ifsc: string };
    const info = await lookupIfsc(ifsc);
    if (!info) {
      reply.status(404);
      return { error: { code: 'not_found', message: 'IFSC not found' } };
    }
    return { ifsc: info };
  });


  app.put('/bank-account', { preHandler: requireAuth }, async (req) => {
    const dto = UpsertBankAccountSchema.parse(req.body);
    return { bankAccount: await bankAccountService.upsert(req.user!.sub, dto) };
  });

  app.delete('/bank-account', { preHandler: requireAuth }, async (req, reply) => {
    await bankAccountService.remove(req.user!.sub);
    reply.status(204);
  });
};
