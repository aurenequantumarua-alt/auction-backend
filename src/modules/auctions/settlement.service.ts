import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { JOB_NAMES } from '../../config/constants.js';
import { settlementQueue } from '../../jobs/queue.js';
import { notificationService } from '../notifications/service.js';
import { walletService } from '../wallet/service.js';
import { realtime } from '../../realtime/gateway.js';
import { logger } from '../../lib/logger.js';
import { badRequest, conflict, forbidden, notFound } from '../../utils/http-error.js';

/**
 * Resolve the Admin user whose wallet receives the 10% platform commission.
 * Uses PLATFORM_OWNER_USER_ID when it points to an existing ADMIN user, and
 * falls back to the earliest ADMIN account so commissions are never lost or
 * cause foreign-key errors if env config is unset or stale.
 */
export const resolveAdminWalletUserId = async (
  db: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<string | null> => {
  if (env.PLATFORM_OWNER_USER_ID) {
    const configured = await db.user.findUnique({
      where: { id: env.PLATFORM_OWNER_USER_ID },
      select: { id: true, role: true },
    });
    if (configured?.role === 'ADMIN') return configured.id;
    logger.warn(
      { configuredId: env.PLATFORM_OWNER_USER_ID },
      'PLATFORM_OWNER_USER_ID missing or not ADMIN — falling back to primary ADMIN wallet',
    );
  }
  const admin = await db.user.findFirst({
    where: { role: 'ADMIN' },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  return admin?.id ?? null;
};

/**
 * Split a released escrow payment into seller net proceeds (90%) and platform
 * commission (10%) stored directly in the Admin wallet so the admin can claim it.
 */
const creditReleasePayouts = async (
  tx: Prisma.TransactionClient,
  params: {
    settlementId: string;
    auctionId: string;
    auctionTitle: string;
    sellerId: string;
    grossAmount: Prisma.Decimal;
    note?: string;
  },
): Promise<{ commission: Prisma.Decimal; sellerNet: Prisma.Decimal }> => {
  const commission = params.grossAmount
    .mul(env.PLATFORM_COMMISSION_BPS)
    .div(10000)
    .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  const sellerNet = params.grossAmount.minus(commission);
  const suffix = params.note ? ` (${params.note})` : '';

  if (sellerNet.greaterThan(0)) {
    await walletService.credit(
      {
        userId: params.sellerId,
        amountDecimal: sellerNet,
        type: 'SALE_CREDIT',
        reference: params.settlementId,
        idempotencyKey: `sale:${params.settlementId}`,
        description: `Sale proceeds for "${params.auctionTitle}" (net of ₹${commission.toFixed(2)} commission)${suffix}`,
      },
      tx,
    );
  }

  if (commission.greaterThan(0)) {
    const adminUserId = await resolveAdminWalletUserId(tx);
    if (adminUserId) {
      await walletService.credit(
        {
          userId: adminUserId,
          amountDecimal: commission,
          type: 'PLATFORM_PROFIT_CREDIT',
          reference: params.settlementId,
          idempotencyKey: `profit:${params.settlementId}`,
          description: `Platform fee (${env.PLATFORM_COMMISSION_BPS / 100}%) from "${params.auctionTitle}"${suffix}`,
        },
        tx,
      );

      if (adminUserId !== params.sellerId) {
        await notificationService.notify(tx, {
          userId: adminUserId,
          type: 'FUNDS_RELEASED',
          payload: {
            auctionId: params.auctionId,
            title: params.auctionTitle,
            commission: commission.toFixed(2),
            message: `₹${commission.toFixed(2)} platform fee credited to your Admin wallet and ready to claim.`,
          },
        });
      }
    } else {
      logger.warn(
        { settlementId: params.settlementId, commission: commission.toFixed(2) },
        'No ADMIN user found — platform commission not credited to any wallet',
      );
    }
  }

  return { commission, sellerNet };
};

/**
 * Settlement service: owns the fallback bidder chain AND the escrow lifecycle.
 *
 * Flow:
 *   1. Auction ends → finalizeAuction → AWAITING_PAYMENT
 *   2. Buyer pays  → markPaid         → ESCROW_HOLD (funds NOT released yet)
 *   3. Seller ships → markShipped      → (still ESCROW_HOLD, tracking saved)
 *   4. Delivered    → markDelivered    → DELIVERED_PENDING (48h inspection clock)
 *   5a. Buyer confirms or 48h timeout → confirmAndRelease → COMPLETED (90% seller, 10% platform)
 *   5b. Buyer disputes               → openDispute       → DISPUTED
 *   6.  Admin resolves dispute        → resolveDispute    → COMPLETED or REFUNDED
 *
 * If the seller doesn't ship within SHIPPING_DEADLINE_DAYS, auto-refund the buyer.
 */
export const settlementService = {
  /**
   * Called by the auction.end job. Locks the auction, computes the winner from
   * the bid table (ordered by amount DESC, placedAt ASC), creates a Settlement
   * if there are bids, and transitions the auction status accordingly.
   *
   * Idempotent — calling twice for the same auction is a no-op after the first.
   */
  async finalizeAuction(auctionId: string): Promise<void> {
    await prisma.$transaction(async (tx) => {
      const auction = await tx.auction.findUnique({
        where: { id: auctionId },
        include: { settlement: true },
      });
      if (!auction) {
        logger.warn({ auctionId }, 'finalizeAuction: auction not found');
        return;
      }
      if (auction.status !== 'LIVE') {
        logger.debug({ auctionId, status: auction.status }, 'finalizeAuction: not in LIVE, skipping');
        return;
      }

      const topBid = await tx.bid.findFirst({
        where: { auctionId, status: { in: ['ACTIVE'] } },
        orderBy: [{ amount: 'desc' }, { placedAt: 'asc' }],
      });

      if (!topBid) {
        await tx.auction.update({
          where: { id: auctionId },
          data: { status: 'EXPIRED' },
        });
        await notificationService.notify(tx, {
          userId: auction.sellerId,
          type: 'AUCTION_EXPIRED',
          payload: { auctionId, title: auction.title },
        });
        realtime.emitAuctionStatus(auctionId, 'EXPIRED');
        return;
      }

      // Mark winner + outbid all others.
      await tx.bid.update({
        where: { id: topBid.id },
        data: { status: 'WON' },
      });
      await tx.bid.updateMany({
        where: { auctionId, id: { not: topBid.id }, status: 'ACTIVE' },
        data: { status: 'OUTBID' },
      });

      const deadline = new Date(Date.now() + env.PAYMENT_WINDOW_HOURS * 60 * 60 * 1000);
      const settlement = await tx.auctionSettlement.create({
        data: {
          auctionId,
          currentWinnerBidId: topBid.id,
          paymentDeadline: deadline,
        },
      });

      await tx.auction.update({
        where: { id: auctionId },
        data: { status: 'PAYMENT_PENDING' },
      });

      await notificationService.notify(tx, {
        userId: topBid.bidderId,
        type: 'WON',
        payload: { auctionId, title: auction.title, amount: topBid.amount.toFixed(2), deadline },
      });
      await notificationService.notify(tx, {
        userId: auction.sellerId,
        type: 'AUCTION_ENDED',
        payload: {
          auctionId,
          title: auction.title,
          winnerBidId: topBid.id,
          amount: topBid.amount.toFixed(2),
        },
      });

      realtime.emitAuctionStatus(auctionId, 'PAYMENT_PENDING');
      await schedulePaymentTimeout(settlement.id, deadline);
    });
  },

  /**
   * Forfeit the current winner and try to promote the next bidder.
   * Called from:
   *   - the settlement.payment-timeout job when the deadline lapses
   *   - the explicit `POST /settlements/:id/decline` endpoint when a winner
   *     opts out before paying
   */
  async forfeitAndPromote(settlementId: string): Promise<void> {
    await prisma.$transaction(async (tx) => {
      const settlement = await tx.auctionSettlement.findUnique({
        where: { id: settlementId },
        include: { auction: true, currentWinnerBid: true },
      });
      if (!settlement) return;
      if (settlement.status !== 'AWAITING_PAYMENT') return;
      if (!settlement.currentWinnerBid) return;

      const forfeitedBidId = settlement.currentWinnerBid.id;
      const forfeitedBidderId = settlement.currentWinnerBid.bidderId;

      // Mark all bids by the non-paying winner on this auction as FORFEITED
      await tx.bid.updateMany({
        where: {
          auctionId: settlement.auctionId,
          bidderId: forfeitedBidderId,
          status: { in: ['ACTIVE', 'OUTBID', 'WON'] },
        },
        data: { status: 'FORFEITED' },
      });

      // Notify the forfeited bidder that their claim was dropped.
      await notificationService.notify(tx, {
        userId: forfeitedBidderId,
        type: 'WINNER_FORFEITED',
        payload: { auctionId: settlement.auctionId },
      });

      const next = await tx.bid.findFirst({
        where: {
          auctionId: settlement.auctionId,
          status: { in: ['OUTBID'] },
          bidderId: { not: forfeitedBidderId },
        },
        orderBy: [{ amount: 'desc' }, { placedAt: 'asc' }],
      });

      if (!next) {
        // Chain exhausted.
        await tx.auctionSettlement.update({
          where: { id: settlementId },
          data: { status: 'EXHAUSTED', currentWinnerBidId: null },
        });
        await tx.auction.update({
          where: { id: settlement.auctionId },
          data: { status: 'EXPIRED' },
        });
        await notificationService.notify(tx, {
          userId: settlement.auction.sellerId,
          type: 'AUCTION_EXPIRED',
          payload: { auctionId: settlement.auctionId, reason: 'all bidders forfeited' },
        });
        realtime.emitAuctionStatus(settlement.auctionId, 'EXPIRED');
        return;
      }

      // Promote the next bidder.
      await tx.bid.update({ where: { id: next.id }, data: { status: 'WON' } });

      const deadline = new Date(Date.now() + env.PAYMENT_WINDOW_HOURS * 60 * 60 * 1000);
      const updated = await tx.auctionSettlement.update({
        where: { id: settlementId },
        data: {
          currentWinnerBidId: next.id,
          paymentDeadline: deadline,
          attemptCount: { increment: 1 },
        },
      });

      await notificationService.notify(tx, {
        userId: next.bidderId,
        type: 'WON',
        payload: {
          auctionId: settlement.auctionId,
          title: settlement.auction.title,
          amount: next.amount.toFixed(2),
          deadline,
          promoted: true,
        },
      });
      await notificationService.notify(tx, {
        userId: settlement.auction.sellerId,
        type: 'AUCTION_ENDED',
        payload: {
          auctionId: settlement.auctionId,
          promoted: true,
          attempt: updated.attemptCount,
        },
      });

      realtime.emitAuctionStatus(settlement.auctionId, 'PAYMENT_PENDING');
      await schedulePaymentTimeout(settlementId, deadline);
    });
  },

  /**
   * Mark a settlement paid → ESCROW_HOLD.
   *
   * Funds are NOT released to the seller yet. The seller must ship, the buyer
   * must confirm delivery, and a 48-hour inspection window must pass (or the
   * buyer must explicitly confirm) before the seller's wallet is credited.
   *
   * Idempotent: if already past AWAITING_PAYMENT it is a no-op.
   */
  async markPaid(
    settlementId: string,
    paidByUserId: string,
    amount: Prisma.Decimal,
    opts?: { provider?: string; externalRef?: string },
  ): Promise<void> {
    let didTransition = false;
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "AuctionSettlement" WHERE id = ${settlementId} FOR UPDATE`;

      const settlement = await tx.auctionSettlement.findUnique({
        where: { id: settlementId },
        include: { auction: true, currentWinnerBid: true },
      });
      if (!settlement) throw notFound('Settlement not found');
      // Idempotent: already in escrow or beyond
      if (settlement.status !== 'AWAITING_PAYMENT') return;
      if (settlement.currentWinnerBid?.bidderId !== paidByUserId) {
        throw forbidden('You are not the current obligated buyer');
      }

      const provider = opts?.provider ?? 'MOCK';

      // Commission calculation (for recording; NOT credited yet).
      const commission = amount
        .mul(env.PLATFORM_COMMISSION_BPS)
        .div(10000)
        .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

      // Promote the checkout-created PENDING transaction if present, else create one.
      const pending = await tx.transaction.findFirst({
        where: { settlementId, status: 'PENDING' },
        orderBy: { createdAt: 'desc' },
      });
      if (pending) {
        await tx.transaction.update({
          where: { id: pending.id },
          data: {
            status: 'COMPLETED',
            provider,
            externalRef: opts?.externalRef ?? pending.externalRef,
            commissionAmount: commission,
          },
        });
      } else {
        await tx.transaction.create({
          data: {
            settlementId,
            amount,
            status: 'COMPLETED',
            provider,
            externalRef: opts?.externalRef ?? null,
            commissionAmount: commission,
          },
        });
      }

      // Calculate shipping deadline (5 days from now by default).
      const shippingDeadline = new Date(
        Date.now() + env.SHIPPING_DEADLINE_DAYS * 24 * 60 * 60 * 1000,
      );

      // Transition to ESCROW_HOLD — do NOT credit the seller yet.
      await tx.auctionSettlement.update({
        where: { id: settlementId },
        data: { status: 'ESCROW_HOLD', shippingDeadline },
      });
      await tx.auction.update({
        where: { id: settlement.auctionId },
        data: { status: 'SOLD', soldAt: new Date() },
      });

      // Notify both parties about the escrow hold.
      await notificationService.notify(tx, {
        userId: settlement.auction.sellerId,
        type: 'ESCROW_SECURED',
        payload: {
          auctionId: settlement.auctionId,
          title: settlement.auction.title,
          amount: amount.toFixed(2),
          shippingDeadline: shippingDeadline.toISOString(),
          message: 'Payment secured in Escrow. Please ship the item to the buyer.',
        },
      });
      await notificationService.notify(tx, {
        userId: paidByUserId,
        type: 'ESCROW_SECURED',
        payload: {
          auctionId: settlement.auctionId,
          title: settlement.auction.title,
          amount: amount.toFixed(2),
          message: 'Payment held safely in Escrow until you receive and verify the item.',
        },
      });

      realtime.emitAuctionStatus(settlement.auctionId, 'SOLD');
      didTransition = true;
    });

    // Cancel the pending payment timeout job — payment beat the clock.
    if (didTransition) {
      await cancelPaymentTimeout(settlementId);
      await scheduleShippingDeadline(settlementId);
    }
  },

  /**
   * Seller marks the item as shipped with tracking details.
   * Only callable when status is ESCROW_HOLD.
   */
  async markShipped(
    settlementId: string,
    sellerId: string,
    trackingInfo: { trackingNumber: string; courierName: string },
  ): Promise<void> {
    await prisma.$transaction(async (tx) => {
      const settlement = await tx.auctionSettlement.findUnique({
        where: { id: settlementId },
        include: { auction: true, currentWinnerBid: true },
      });
      if (!settlement) throw notFound('Settlement not found');
      if (settlement.auction.sellerId !== sellerId) {
        throw forbidden('Only the seller can mark items as shipped');
      }
      if (settlement.status !== 'ESCROW_HOLD') {
        throw conflict('Settlement is not in escrow hold');
      }

      await tx.auctionSettlement.update({
        where: { id: settlementId },
        data: {
          shippedAt: new Date(),
          trackingNumber: trackingInfo.trackingNumber,
          courierName: trackingInfo.courierName,
        },
      });

      // Notify buyer that the item has been shipped.
      if (settlement.currentWinnerBid) {
        await notificationService.notify(tx, {
          userId: settlement.currentWinnerBid.bidderId,
          type: 'ITEM_SHIPPED',
          payload: {
            auctionId: settlement.auctionId,
            title: settlement.auction.title,
            trackingNumber: trackingInfo.trackingNumber,
            courierName: trackingInfo.courierName,
            message: `Your item has been shipped via ${trackingInfo.courierName}. Tracking: ${trackingInfo.trackingNumber}`,
          },
        });
      }
    });
  },

  /**
   * Mark the item as delivered — starts the inspection countdown.
   * Callable by either the buyer ("I received it") or the seller ("item delivered").
   */
  async markDelivered(
    settlementId: string,
    callerUserId: string,
  ): Promise<void> {
    await prisma.$transaction(async (tx) => {
      const settlement = await tx.auctionSettlement.findUnique({
        where: { id: settlementId },
        include: { auction: true, currentWinnerBid: true },
      });
      if (!settlement) throw notFound('Settlement not found');

      // Either the buyer or the seller can mark delivered.
      const isSeller = settlement.auction.sellerId === callerUserId;
      const isBuyer = settlement.currentWinnerBid?.bidderId === callerUserId;
      if (!isSeller && !isBuyer) {
        throw forbidden('Only the buyer or seller can mark delivery');
      }
      if (settlement.status !== 'ESCROW_HOLD') {
        throw conflict('Settlement is not in escrow hold');
      }
      if (!settlement.shippedAt) {
        throw conflict('Item must be marked shipped before delivery can be confirmed');
      }
      if (settlement.deliveredAt) {
        throw conflict('Already marked as delivered');
      }

      const now = new Date();
      const inspectionDeadline = new Date(
        now.getTime() + env.INSPECTION_WINDOW_HOURS * 60 * 60 * 1000,
      );

      await tx.auctionSettlement.update({
        where: { id: settlementId },
        data: {
          status: 'DELIVERED_PENDING',
          deliveredAt: now,
          inspectionDeadline,
        },
      });

      // Notify the OTHER party about delivery.
      if (isSeller && settlement.currentWinnerBid) {
        await notificationService.notify(tx, {
          userId: settlement.currentWinnerBid.bidderId,
          type: 'ITEM_DELIVERED',
          payload: {
            auctionId: settlement.auctionId,
            title: settlement.auction.title,
            inspectionDeadline: inspectionDeadline.toISOString(),
            message: `The seller marked your item as delivered. You have ${env.INSPECTION_WINDOW_HOURS} hours to verify it.`,
          },
        });
      }
      if (isBuyer) {
        await notificationService.notify(tx, {
          userId: settlement.auction.sellerId,
          type: 'ITEM_DELIVERED',
          payload: {
            auctionId: settlement.auctionId,
            title: settlement.auction.title,
            message: 'The buyer confirmed receiving the item. Inspection period has started.',
          },
        });
      }
    });

    // Schedule auto-release job for when inspection window expires.
    await scheduleInspectionAutoRelease(settlementId);
    // Cancel shipping deadline since item is delivered.
    await cancelShippingDeadline(settlementId);
  },

  /**
   * Confirm the item is authentic and release funds.
   * Called by the buyer explicitly, or by the auto-release job on inspection timeout.
   *
   * 90% → seller wallet (SALE_CREDIT)
   * 10% → Admin wallet (PLATFORM_PROFIT_CREDIT) so admin can claim/withdraw it
   */
  async confirmAndRelease(
    settlementId: string,
    triggeredBy: 'buyer' | 'auto',
    buyerUserId?: string,
  ): Promise<void> {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "AuctionSettlement" WHERE id = ${settlementId} FOR UPDATE`;

      const settlement = await tx.auctionSettlement.findUnique({
        where: { id: settlementId },
        include: { auction: true, currentWinnerBid: true, transactions: true },
      });
      if (!settlement) throw notFound('Settlement not found');

      // Already completed → idempotent no-op.
      if (settlement.status === 'COMPLETED') return;

      // Valid from ESCROW_HOLD (early confirm) or DELIVERED_PENDING (normal flow).
      if (settlement.status !== 'ESCROW_HOLD' && settlement.status !== 'DELIVERED_PENDING') {
        throw conflict(`Cannot release funds when settlement is ${settlement.status}`);
      }
      if (triggeredBy === 'buyer' && buyerUserId) {
        if (settlement.currentWinnerBid?.bidderId !== buyerUserId) {
          throw forbidden('Only the winning buyer can confirm');
        }
      }

      // Find the completed payment transaction for the amount.
      const paymentTxn = settlement.transactions.find((t) => t.status === 'COMPLETED');
      if (!paymentTxn) throw conflict('No completed payment found for this settlement');

      const { commission, sellerNet } = await creditReleasePayouts(tx, {
        settlementId,
        auctionId: settlement.auctionId,
        auctionTitle: settlement.auction.title,
        sellerId: settlement.auction.sellerId,
        grossAmount: paymentTxn.amount,
      });

      await tx.auctionSettlement.update({
        where: { id: settlementId },
        data: { status: 'COMPLETED', releasedAt: new Date() },
      });

      // Notify seller that funds are available.
      await notificationService.notify(tx, {
        userId: settlement.auction.sellerId,
        type: 'FUNDS_RELEASED',
        payload: {
          auctionId: settlement.auctionId,
          title: settlement.auction.title,
          sellerNet: sellerNet.toFixed(2),
          commission: commission.toFixed(2),
          message: `₹${sellerNet.toFixed(2)} has been credited to your wallet.`,
        },
      });

      // Notify buyer about completion.
      if (settlement.currentWinnerBid) {
        await notificationService.notify(tx, {
          userId: settlement.currentWinnerBid.bidderId,
          type: 'FUNDS_RELEASED',
          payload: {
            auctionId: settlement.auctionId,
            title: settlement.auction.title,
            message: 'Funds released to the seller. Enjoy your purchase!',
          },
        });
      }
    });

    // Cancel any pending inspection auto-release job (buyer confirmed early).
    await cancelInspectionAutoRelease(settlementId);
  },

  /**
   * Buyer opens a dispute during the inspection window.
   */
  async openDispute(
    settlementId: string,
    buyerId: string,
    input: { reason: string; description: string; proofUrls: string[] },
  ): Promise<void> {
    await prisma.$transaction(async (tx) => {
      const settlement = await tx.auctionSettlement.findUnique({
        where: { id: settlementId },
        include: { auction: true, currentWinnerBid: true, dispute: true },
      });
      if (!settlement) throw notFound('Settlement not found');
      if (settlement.currentWinnerBid?.bidderId !== buyerId) {
        throw forbidden('Only the winning buyer can open a dispute');
      }
      if (settlement.status !== 'ESCROW_HOLD' && settlement.status !== 'DELIVERED_PENDING') {
        throw conflict(`Cannot open dispute when settlement is ${settlement.status}`);
      }
      if (settlement.dispute) {
        throw conflict('A dispute has already been opened for this settlement');
      }

      // Create the dispute record.
      await tx.settlementDispute.create({
        data: {
          settlementId,
          buyerId,
          reason: input.reason as any, // DisputeReason enum
          description: input.description,
          proofUrls: input.proofUrls,
        },
      });

      await tx.auctionSettlement.update({
        where: { id: settlementId },
        data: { status: 'DISPUTED' },
      });

      // Notify the admin(s).
      const admins = await tx.user.findMany({ where: { role: 'ADMIN' } });
      for (const admin of admins) {
        await notificationService.notify(tx, {
          userId: admin.id,
          type: 'DISPUTE_OPENED',
          payload: {
            settlementId,
            auctionId: settlement.auctionId,
            title: settlement.auction.title,
            buyerId,
            reason: input.reason,
            message: `Dispute opened by buyer for "${settlement.auction.title}"`,
          },
        });
      }

      // Notify the seller.
      await notificationService.notify(tx, {
        userId: settlement.auction.sellerId,
        type: 'DISPUTE_OPENED',
        payload: {
          auctionId: settlement.auctionId,
          title: settlement.auction.title,
          reason: input.reason,
          message: 'The buyer has opened a dispute regarding the authenticity of your item.',
        },
      });
    });

    // Cancel the inspection auto-release job.
    await cancelInspectionAutoRelease(settlementId);
  },

  /**
   * Admin resolves a dispute.
   * action = 'APPROVE_REFUND' → 100% refund to buyer wallet
   * action = 'DISMISS_DISPUTE' → 90% seller + 10% platform (standard release)
   */
  async resolveDispute(
    settlementId: string,
    action: 'APPROVE_REFUND' | 'DISMISS_DISPUTE',
    adminNotes?: string,
  ): Promise<void> {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "AuctionSettlement" WHERE id = ${settlementId} FOR UPDATE`;

      const settlement = await tx.auctionSettlement.findUnique({
        where: { id: settlementId },
        include: { auction: true, currentWinnerBid: true, dispute: true, transactions: true },
      });
      if (!settlement) throw notFound('Settlement not found');
      if (settlement.status !== 'DISPUTED') {
        throw conflict('Settlement is not in disputed state');
      }
      if (!settlement.dispute) throw conflict('No dispute record found');

      const paymentTxn = settlement.transactions.find((t) => t.status === 'COMPLETED');
      if (!paymentTxn) throw conflict('No completed payment found');

      const grossAmount = paymentTxn.amount;

      if (action === 'APPROVE_REFUND') {
        // 100% refund to buyer's wallet.
        if (settlement.currentWinnerBid) {
          await walletService.credit(
            {
              userId: settlement.currentWinnerBid.bidderId,
              amountDecimal: grossAmount,
              type: 'REFUND_CREDIT',
              reference: settlementId,
              idempotencyKey: `refund:${settlementId}`,
              description: `Refund for disputed item "${settlement.auction.title}"`,
            },
            tx,
          );
        }

        await tx.settlementDispute.update({
          where: { id: settlement.dispute.id },
          data: {
            status: 'RESOLVED_REFUND',
            adminNotes: adminNotes ?? null,
            resolvedAt: new Date(),
          },
        });

        await tx.auctionSettlement.update({
          where: { id: settlementId },
          data: { status: 'REFUNDED', releasedAt: new Date() },
        });
      } else {
        // DISMISS_DISPUTE → standard 90/10 release.
        await creditReleasePayouts(tx, {
          settlementId,
          auctionId: settlement.auctionId,
          auctionTitle: settlement.auction.title,
          sellerId: settlement.auction.sellerId,
          grossAmount,
          note: 'dispute dismissed',
        });

        await tx.settlementDispute.update({
          where: { id: settlement.dispute.id },
          data: {
            status: 'RESOLVED_REJECTED',
            adminNotes: adminNotes ?? null,
            resolvedAt: new Date(),
          },
        });

        await tx.auctionSettlement.update({
          where: { id: settlementId },
          data: { status: 'COMPLETED', releasedAt: new Date() },
        });
      }

      // Notify both parties.
      const buyerMsg =
        action === 'APPROVE_REFUND'
          ? `Your dispute was approved. ₹${grossAmount.toFixed(2)} has been refunded to your wallet.`
          : 'Your dispute was reviewed and dismissed. Funds have been released to the seller.';
      const sellerMsg =
        action === 'APPROVE_REFUND'
          ? `The buyer's dispute was approved. The payment has been refunded to the buyer.`
          : `The buyer's dispute was dismissed. ₹${grossAmount.minus(grossAmount.mul(env.PLATFORM_COMMISSION_BPS).div(10000).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)).toFixed(2)} has been credited to your wallet.`;

      if (settlement.currentWinnerBid) {
        await notificationService.notify(tx, {
          userId: settlement.currentWinnerBid.bidderId,
          type: 'DISPUTE_RESOLVED',
          payload: {
            auctionId: settlement.auctionId,
            title: settlement.auction.title,
            action,
            message: buyerMsg,
          },
        });
      }
      await notificationService.notify(tx, {
        userId: settlement.auction.sellerId,
        type: 'DISPUTE_RESOLVED',
        payload: {
          auctionId: settlement.auctionId,
          title: settlement.auction.title,
          action,
          message: sellerMsg,
        },
      });
    });
  },

  /**
   * Auto-refund when the seller doesn't ship within the deadline.
   * Called by the shipping-deadline-refund job.
   */
  async autoRefundShippingTimeout(settlementId: string): Promise<void> {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "AuctionSettlement" WHERE id = ${settlementId} FOR UPDATE`;

      const settlement = await tx.auctionSettlement.findUnique({
        where: { id: settlementId },
        include: { auction: true, currentWinnerBid: true, transactions: true },
      });
      if (!settlement) return;
      // Only auto-refund if still in ESCROW_HOLD and not yet shipped.
      if (settlement.status !== 'ESCROW_HOLD') return;
      if (settlement.shippedAt) return; // Already shipped.

      const paymentTxn = settlement.transactions.find((t) => t.status === 'COMPLETED');
      if (!paymentTxn) return;

      // Refund the buyer.
      if (settlement.currentWinnerBid) {
        await walletService.credit(
          {
            userId: settlement.currentWinnerBid.bidderId,
            amountDecimal: paymentTxn.amount,
            type: 'REFUND_CREDIT',
            reference: settlementId,
            idempotencyKey: `shipping-refund:${settlementId}`,
            description: `Auto-refund: seller did not ship "${settlement.auction.title}" within ${env.SHIPPING_DEADLINE_DAYS} days`,
          },
          tx,
        );
      }

      await tx.auctionSettlement.update({
        where: { id: settlementId },
        data: { status: 'REFUNDED', releasedAt: new Date() },
      });

      // Notify both parties.
      if (settlement.currentWinnerBid) {
        await notificationService.notify(tx, {
          userId: settlement.currentWinnerBid.bidderId,
          type: 'SHIPPING_DEADLINE',
          payload: {
            auctionId: settlement.auctionId,
            title: settlement.auction.title,
            message: `Seller did not ship within ${env.SHIPPING_DEADLINE_DAYS} days. You have been refunded ₹${paymentTxn.amount.toFixed(2)}.`,
          },
        });
      }
      await notificationService.notify(tx, {
        userId: settlement.auction.sellerId,
        type: 'SHIPPING_DEADLINE',
        payload: {
          auctionId: settlement.auctionId,
          title: settlement.auction.title,
          message: `You did not ship "${settlement.auction.title}" within the ${env.SHIPPING_DEADLINE_DAYS}-day deadline. The payment has been refunded to the buyer.`,
        },
      });
    });
  },

  async getById(settlementId: string, viewerId: string) {
    const s = await prisma.auctionSettlement.findUnique({
      where: { id: settlementId },
      include: {
        auction: { include: { seller: { select: { id: true, name: true } } } },
        currentWinnerBid: { include: { bidder: { select: { id: true, name: true } } } },
        dispute: true,
      },
    });
    if (!s) throw notFound();
    if (s.currentWinnerBid?.bidderId !== viewerId && s.auction.sellerId !== viewerId) {
      // Allow admin access
      const viewer = await prisma.user.findUnique({ where: { id: viewerId } });
      if (viewer?.role !== 'ADMIN') {
        throw forbidden('Not your settlement');
      }
    }
    return s;
  },

  /**
   * Reconcile any overdue settlements across all stages:
   * 1. Awaiting payment past paymentDeadline -> forfeit and promote (or expire)
   * 2. Delivered pending past inspectionDeadline -> auto-release escrow to seller
   * 3. Escrow hold past shippingDeadline without tracking -> auto-refund buyer
   */
  async reconcileOverdue(): Promise<void> {
    const now = new Date();

    // 1. Overdue payment settlements
    const overdueSettlements = await prisma.auctionSettlement.findMany({
      where: {
        status: 'AWAITING_PAYMENT',
        paymentDeadline: { lte: now },
      },
      select: { id: true },
    });

    for (const s of overdueSettlements) {
      try {
        await this.forfeitAndPromote(s.id);
      } catch (err) {
        logger.error({ err, settlementId: s.id }, 'Error forfeiting overdue settlement');
      }
    }

    // 2. Overdue inspection periods (auto-release)
    const overdueInspections = await prisma.auctionSettlement.findMany({
      where: {
        status: 'DELIVERED_PENDING',
        inspectionDeadline: { lte: now },
      },
      select: { id: true },
    });

    for (const s of overdueInspections) {
      try {
        await this.confirmAndRelease(s.id, 'auto');
      } catch (err) {
        logger.error({ err, settlementId: s.id }, 'Error auto-releasing escrow');
      }
    }

    // 3. Overdue shipping deadlines (auto-refund)
    const overdueShipping = await prisma.auctionSettlement.findMany({
      where: {
        status: 'ESCROW_HOLD',
        shippingDeadline: { lte: now },
        shippedAt: null,
      },
      select: { id: true },
    });

    for (const s of overdueShipping) {
      try {
        await this.autoRefundShippingTimeout(s.id);
      } catch (err) {
        logger.error({ err, settlementId: s.id }, 'Error auto-refunding shipping timeout');
      }
    }
  },
};

// ── Scheduling helpers ────────────────────────────────────────────────────

const schedulePaymentTimeout = async (settlementId: string, deadline: Date): Promise<void> => {
  try {
    const delay = Math.max(0, deadline.getTime() - Date.now());
    await settlementQueue.add(
      JOB_NAMES.paymentTimeout,
      { settlementId },
      {
        delay,
        jobId: `${JOB_NAMES.paymentTimeout}_${settlementId}_${deadline.getTime()}`,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  } catch (err) {
    // Non-blocking
  }
};

const cancelPaymentTimeout = async (settlementId: string): Promise<void> => {
  try {
    const jobs = await settlementQueue.getJobs(['delayed', 'waiting']);
    for (const job of (jobs || [])) {
      if (job?.id?.startsWith(`${JOB_NAMES.paymentTimeout}_${settlementId}_`)) {
        await job.remove();
      }
    }
  } catch (err) {
    // Non-blocking
  }
};

const scheduleShippingDeadline = async (settlementId: string): Promise<void> => {
  try {
    const delay = env.SHIPPING_DEADLINE_DAYS * 24 * 60 * 60 * 1000;
    await settlementQueue.add(
      JOB_NAMES.shippingDeadlineRefund,
      { settlementId },
      {
        delay,
        jobId: `${JOB_NAMES.shippingDeadlineRefund}_${settlementId}`,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  } catch (err) {
    // Non-blocking
  }
};

const cancelShippingDeadline = async (settlementId: string): Promise<void> => {
  try {
    const jobs = await settlementQueue.getJobs(['delayed', 'waiting']);
    for (const job of (jobs || [])) {
      if (job?.id?.startsWith(`${JOB_NAMES.shippingDeadlineRefund}_${settlementId}`)) {
        await job.remove();
      }
    }
  } catch (err) {
    // Non-blocking
  }
};

const scheduleInspectionAutoRelease = async (settlementId: string): Promise<void> => {
  try {
    const delay = env.INSPECTION_WINDOW_HOURS * 60 * 60 * 1000;
    await settlementQueue.add(
      JOB_NAMES.inspectionAutoRelease,
      { settlementId },
      {
        delay,
        jobId: `${JOB_NAMES.inspectionAutoRelease}_${settlementId}`,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  } catch (err) {
    // Non-blocking
  }
};

const cancelInspectionAutoRelease = async (settlementId: string): Promise<void> => {
  try {
    const jobs = await settlementQueue.getJobs(['delayed', 'waiting']);
    for (const job of (jobs || [])) {
      if (job?.id?.startsWith(`${JOB_NAMES.inspectionAutoRelease}_${settlementId}`)) {
        await job.remove();
      }
    }
  } catch (err) {
    // Non-blocking
  }
};
