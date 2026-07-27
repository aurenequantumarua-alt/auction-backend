import type { NotificationType, Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { realtime } from '../../realtime/gateway.js';

type Tx = Prisma.TransactionClient | PrismaClient;

interface CreateNotificationInput {
  userId: string;
  type: NotificationType;
  payload: Prisma.InputJsonValue;
}

/**
 * The notification service writes a row + emits a real-time event.
 * It accepts a transaction client so it can be called from within larger
 * transactions (e.g. settlement creation) without losing atomicity.
 */
export const notificationService = {
  async notify(tx: Tx, input: CreateNotificationInput) {
    const created = await tx.notification.create({
      data: {
        userId: input.userId,
        type: input.type,
        payload: input.payload,
      },
    });
    // Best-effort realtime push. Swallow errors so DB writes are not affected.
    try {
      realtime.emitNotification(input.userId, {
        id: created.id,
        type: created.type,
        payload: created.payload,
        createdAt: created.createdAt.toISOString(),
      });
    } catch {
      // ignore
    }
    return created;
  },

  async list(userId: string, opts: { unreadOnly?: boolean } = {}) {
    return prisma.notification.findMany({
      where: { userId, ...(opts.unreadOnly ? { readAt: null } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  },

  async markRead(userId: string, ids: string[]) {
    await prisma.notification.updateMany({
      where: { userId, id: { in: ids }, readAt: null },
      data: { readAt: new Date() },
    });
  },

  async markAllRead(userId: string) {
    await prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
  },

  async unreadCount(userId: string) {
    return prisma.notification.count({ where: { userId, readAt: null } });
  },
};
