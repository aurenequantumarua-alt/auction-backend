import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { requireAuth } from '../../middleware/auth.js';

const UpdateProfileSchema = z.object({
  name: z.string().min(1).max(80).trim().optional(),
  avatarUrl: z.string().url().nullable().optional(),
});

export const registerUserRoutes = async (app: FastifyInstance): Promise<void> => {
  app.get('/users/me/dashboard', { preHandler: requireAuth }, async (req) => {
    const userId = req.user!.sub;
    const [activeBids, listings, won] = await Promise.all([
      prisma.bid.count({
        where: { bidderId: userId, status: { in: ['ACTIVE'] } },
      }),
      prisma.auction.count({
        where: { sellerId: userId, status: { notIn: ['DRAFT', 'CANCELLED'] } },
      }),
      prisma.bid.count({
        where: { bidderId: userId, status: 'WON' },
      }),
    ]);
    return { stats: { activeBids, listings, won } };
  });

  app.patch('/users/me', { preHandler: requireAuth }, async (req) => {
    const dto = UpdateProfileSchema.parse(req.body);
    const updated = await prisma.user.update({
      where: { id: req.user!.sub },
      data: dto,
      select: { id: true, email: true, name: true, role: true, avatarUrl: true },
    });
    return { user: updated };
  });
};
