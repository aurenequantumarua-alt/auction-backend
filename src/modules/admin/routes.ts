import type { FastifyInstance } from 'fastify';
import { requireAuth, requireAdmin } from '../../middleware/auth.js';
import { adminService } from './service.js';
import { reportService } from '../reports/service.js';
import { UpdateReportStatusSchema } from '../reports/dto.js';
import { settlementService, resolveAdminWalletUserId } from '../auctions/settlement.service.js';
import { prisma } from '../../lib/prisma.js';
import { badRequest } from '../../utils/http-error.js';
import { withdrawalService } from '../withdrawals/service.js';
import { walletService } from '../wallet/service.js';
import { z } from 'zod';
import { logger } from '../../lib/logger.js';

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

  // ── Dispute management ──────────────────────────────────────────────────

  const DisputesQuerySchema = z.object({
    status: z.enum(['OPEN', 'RESOLVED_REFUND', 'RESOLVED_REJECTED']).optional(),
  });

  // List all settlement disputes.
  app.get('/disputes', { preHandler: [requireAuth, requireAdmin] }, async (req) => {
    const { status } = DisputesQuerySchema.parse(req.query);
    const where = status ? { status } : {};
    const disputes = await prisma.settlementDispute.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        buyer: { select: { id: true, name: true, email: true } },
        settlement: {
          include: {
            auction: {
              select: {
                id: true,
                title: true,
                brand: true,
                images: { take: 1, where: { isCover: true } },
                seller: { select: { id: true, name: true, email: true } },
              },
            },
            currentWinnerBid: { select: { amount: true } },
          },
        },
      },
    });
    return { items: disputes };
  });

  const ResolveDisputeSchema = z.object({
    action: z.enum(['APPROVE_REFUND', 'DISMISS_DISPUTE']),
    adminNotes: z.string().trim().max(2000).optional(),
  });

  // Resolve a dispute.
  app.post('/disputes/:id/resolve', { preHandler: [requireAuth, requireAdmin] }, async (req) => {
    const { id } = req.params as { id: string };
    const { action, adminNotes } = ResolveDisputeSchema.parse(req.body);
    // Find the settlement from the dispute.
    const dispute = await prisma.settlementDispute.findUnique({ where: { id } });
    if (!dispute) throw badRequest('Dispute not found');

    await settlementService.resolveDispute(dispute.settlementId, action, adminNotes);
    return { ok: true };
  });

  // ── Withdrawal & Manual Payout Management ─────────────────────────────────

  const WithdrawalsQuerySchema = z.object({
    status: z.enum(['REQUESTED', 'PROCESSING', 'COMPLETED', 'FAILED']).optional(),
  });

  // List all withdrawal requests with decrypted payout destinations.
  app.get('/withdrawals', { preHandler: [requireAuth, requireAdmin] }, async (req) => {
    const { status } = WithdrawalsQuerySchema.parse(req.query);
    const items = await withdrawalService.listAdmin(status);
    return { items };
  });

  // Complete a manual withdrawal (admin has transferred via GPay/Netbanking).
  const CompleteWithdrawalSchema = z.object({
    externalRef: z.string().min(1, 'Payment reference / UTR is required'),
  });
  app.post('/withdrawals/:id/complete', { preHandler: [requireAuth, requireAdmin] }, async (req) => {
    const { id } = req.params as { id: string };
    const { externalRef } = CompleteWithdrawalSchema.parse(req.body);
    const item = await withdrawalService.completeManual(id, externalRef);
    return { item };
  });

  // Reject a withdrawal and auto-refund funds back to the seller's wallet.
  const RejectWithdrawalSchema = z.object({
    reason: z.string().min(1, 'Rejection reason is required'),
  });
  app.post('/withdrawals/:id/reject', { preHandler: [requireAuth, requireAdmin] }, async (req) => {
    const { id } = req.params as { id: string };
    const { reason } = RejectWithdrawalSchema.parse(req.body);
    const item = await withdrawalService.rejectManual(id, reason);
    return { item };
  });

  // ── Platform Profit & Commission Tracking ────────────────────────────────
  // Summarizes completed (released) commission vs escrow-held commission and the
  // live claimable Admin Wallet balance.
  app.get('/platform-profit', { preHandler: [requireAuth, requireAdmin] }, async (req) => {
    const [completedAgg, pendingAgg, ownerId] = await Promise.all([
      prisma.transaction.aggregate({
        where: {
          status: 'COMPLETED',
          commissionAmount: { not: null },
          settlement: { status: 'COMPLETED' },
        },
        _sum: { commissionAmount: true },
        _count: true,
      }),
      prisma.transaction.aggregate({
        where: {
          status: 'COMPLETED',
          commissionAmount: { not: null },
          settlement: { status: { in: ['ESCROW_HOLD', 'DELIVERED_PENDING', 'DISPUTED'] } },
        },
        _sum: { commissionAmount: true },
        _count: true,
      }),
      resolveAdminWalletUserId(prisma),
    ]);

    const walletUserId = ownerId ?? req.user!.sub;
    const adminWallet = await walletService.getBalance(walletUserId);

    const totalProfit = Number(completedAgg._sum.commissionAmount ?? 0);
    const pendingEscrowProfit = Number(pendingAgg._sum.commissionAmount ?? 0);

    return {
      totalProfitFormatted: `₹${totalProfit.toFixed(2)}`,
      totalProfit,
      completedCount: completedAgg._count,
      pendingEscrowProfit,
      pendingEscrowProfitFormatted: `₹${pendingEscrowProfit.toFixed(2)}`,
      pendingEscrowCount: pendingAgg._count,
      adminWalletBalance: Number(adminWallet.balance),
      adminWalletBalanceFormatted: `₹${adminWallet.balance}`,
      adminUserId: walletUserId,
    };
  });

  // ── Shill Bid Detection ──────────────────────────────────────────────────
  // Finds auctions where two or more different users bid from the same IP.
  // Also flags when a bidder shares an IP with the auction's seller.
  app.get('/shill-alerts', { preHandler: [requireAuth, requireAdmin] }, async () => {
    try {
      // 1. Find all IPs that were used by multiple users on the SAME auction.
      const sharedIpBids = await prisma.$queryRaw<
        {
          auctionId: string;
          ipAddress: string;
          bidderIds: string[];
          bidCount: number;
        }[]
      >`
        SELECT
          b."auctionId",
          b."ipAddress",
          array_agg(DISTINCT b."bidderId") AS "bidderIds",
          COUNT(*)::int AS "bidCount"
        FROM "Bid" b
        WHERE b."ipAddress" IS NOT NULL
        GROUP BY b."auctionId", b."ipAddress"
        HAVING COUNT(DISTINCT b."bidderId") > 1
        ORDER BY "bidCount" DESC
        LIMIT 100
      `;

      if (sharedIpBids.length === 0) {
        return { alerts: [], count: 0 };
      }

      // 2. Enrich with auction + user details.
      const auctionIds = [...new Set(sharedIpBids.map((r) => r.auctionId))];
      const allUserIds = [...new Set(sharedIpBids.flatMap((r) => r.bidderIds))];

      const [auctions, users] = await Promise.all([
        prisma.auction.findMany({
          where: { id: { in: auctionIds } },
          select: { id: true, title: true, sellerId: true, status: true, seller: { select: { name: true, email: true } } },
        }),
        prisma.user.findMany({
          where: { id: { in: allUserIds } },
          select: { id: true, name: true, email: true },
        }),
      ]);

      const auctionMap = Object.fromEntries(auctions.map((a) => [a.id, a]));
      const userMap = Object.fromEntries(users.map((u) => [u.id, u]));

      const alerts = sharedIpBids.map((row) => {
        const auction = auctionMap[row.auctionId];
        const bidders = row.bidderIds.map((id) => userMap[id] ?? { id, name: 'Unknown', email: '' });
        const sellerIsBidder = auction ? row.bidderIds.includes(auction.sellerId) : false;

        return {
          auctionId: row.auctionId,
          auctionTitle: auction?.title ?? 'Deleted',
          auctionStatus: auction?.status ?? 'UNKNOWN',
          seller: auction ? { name: auction.seller.name, email: auction.seller.email } : null,
          sharedIp: row.ipAddress,
          bidders,
          bidCount: row.bidCount,
          sellerIsBidder,
          severity: sellerIsBidder ? 'CRITICAL' : 'WARNING',
        };
      });

      // Sort: CRITICAL (seller is bidder) first
      alerts.sort((a, b) => (a.severity === 'CRITICAL' ? -1 : 1) - (b.severity === 'CRITICAL' ? -1 : 1));

      return { alerts, count: alerts.length };
    } catch (err) {
      logger.error({ err }, 'Failed to compute shill alerts');
      return { alerts: [], count: 0 };
    }
  });
};
