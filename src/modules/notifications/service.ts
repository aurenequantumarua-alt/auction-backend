import type { NotificationType, Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { realtime } from '../../realtime/gateway.js';
import { emailService } from '../../lib/email.js';
import { logger } from '../../lib/logger.js';

type Tx = Prisma.TransactionClient | PrismaClient;

interface CreateNotificationInput {
  userId: string;
  type: NotificationType;
  payload: Prisma.InputJsonValue;
}

/** Map of notification types that trigger an email, with their subject lines. */
const EMAIL_SUBJECTS: Partial<Record<NotificationType, string>> = {
  WON: 'You won the auction!',
  PAYMENT_DUE: 'Payment deadline reminder',
  ESCROW_SECURED: 'Payment received - please ship your item',
  FUNDS_RELEASED: 'Funds credited to your wallet',
  DISPUTE_OPENED: 'A dispute has been opened',
  DISPUTE_RESOLVED: 'Dispute has been resolved',
};

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

    // Fire-and-forget email for notifications.
    if (input.type === 'OUTBID') {
      const payload = input.payload as Record<string, unknown>;
      void prisma.user
        .findUnique({ where: { id: input.userId }, select: { email: true, name: true } })
        .then((user) => {
          if (user?.email) {
            return emailService.sendOutbidEmail({
              to: user.email,
              recipientName: user.name,
              auctionTitle: String(payload.title || 'Auction Piece'),
              auctionId: String(payload.auctionId || ''),
              previousAmount: String(payload.previousAmount || payload.amount || '0'),
              newAmount: String(payload.newAmount || payload.amount || '0'),
              isRunnerUp: Boolean(payload.isRunnerUp),
              appUrl: env.CORS_ORIGINS?.[0] || 'https://aurenefashions.in',
            });
          }
        })
        .catch((err) => {
          logger.error({ err, userId: input.userId, type: input.type }, 'Failed to send outbid notification email');
        });
    } else {
      const subject = EMAIL_SUBJECTS[input.type];
      if (subject) {
        const payload = input.payload as Record<string, unknown>;
        const body = typeof payload?.message === 'string' ? payload.message : subject;

        // Query user email OUTSIDE the transaction, fire-and-forget.
        void prisma.user
          .findUnique({ where: { id: input.userId }, select: { email: true, name: true } })
          .then((user) => {
            if (user?.email) {
              return emailService.sendNotificationEmail(user.email, subject, body);
            }
          })
          .catch((err) => {
            logger.error({ err, userId: input.userId, type: input.type }, 'Failed to send notification email');
          });
      }
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
