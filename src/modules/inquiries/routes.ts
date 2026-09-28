import type { FastifyInstance } from 'fastify';
import { optionalAuth, requireAuth } from '../../middleware/auth.js';
import { AskQuestionSchema, AnswerQuestionSchema } from './dto.js';
import { inquiryService } from './service.js';

export const registerInquiryRoutes = async (app: FastifyInstance): Promise<void> => {
  // Public: list inquiries for an auction.
  app.get('/auctions/:id/inquiries', { preHandler: optionalAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const items = await inquiryService.list(id);
    return { items };
  });

  // Buyer: ask a question.
  app.post('/auctions/:id/inquiries', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const dto = AskQuestionSchema.parse(req.body);
    const inquiry = await inquiryService.ask(req.user!.sub, id, dto);
    reply.status(201);
    return inquiry;
  });

  // Seller: answer a question.
  app.post('/inquiries/:id/answer', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const dto = AnswerQuestionSchema.parse(req.body);
    return inquiryService.answer(req.user!.sub, id, dto);
  });

  // Seller: pin/unpin a question.
  app.post('/inquiries/:id/pin', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    return inquiryService.togglePin(req.user!.sub, id);
  });
};
