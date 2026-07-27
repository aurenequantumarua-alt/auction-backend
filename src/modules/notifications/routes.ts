import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth.js';
import { notificationService } from './service.js';

const MarkReadSchema = z.object({
  ids: z.array(z.string()).min(1).max(100),
});

export const registerNotificationRoutes = async (app: FastifyInstance): Promise<void> => {
  app.get('/notifications', { preHandler: requireAuth }, async (req) => {
    const items = await notificationService.list(req.user!.sub);
    const unread = await notificationService.unreadCount(req.user!.sub);
    return { items, unread };
  });

  app.post('/notifications/read', { preHandler: requireAuth }, async (req) => {
    const dto = MarkReadSchema.parse(req.body);
    await notificationService.markRead(req.user!.sub, dto.ids);
    return { ok: true };
  });

  app.post('/notifications/read-all', { preHandler: requireAuth }, async (req) => {
    await notificationService.markAllRead(req.user!.sub);
    return { ok: true };
  });
};
