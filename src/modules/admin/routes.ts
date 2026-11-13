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
};
