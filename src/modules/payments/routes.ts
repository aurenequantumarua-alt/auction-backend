import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { requireAuth } from '../../middleware/auth.js';
import { settlementService } from '../auctions/settlement.service.js';
import { razorpayService } from './razorpay.service.js';
import { walletService } from '../wallet/service.js';
import { logger } from '../../lib/logger.js';
import { badRequest, conflict, forbidden, notFound } from '../../utils/http-error.js';

/** Decimal rupees -> integer paise for Razorpay. Exact Decimal arithmetic (no
 * float) so there's never a paise-level drift vs the stored ledger amount. */
const toPaise = (amount: Prisma.Decimal): number => amount.mul(100).toDecimalPlaces(0).toNumber();

/**
 * Payment routes. The settlement state machine + Transaction table are the
 * source of truth; this module only bridges to Razorpay. The payable amount is
 * ALWAYS derived from the obligated winning bid on the server — never trusted
 * from the client.
 */
export const registerPaymentRoutes = async (app: FastifyInstance): Promise<void> => {
  // Begin checkout. Razorpay mode -> create an order + PENDING transaction and
  // return Checkout params. Mock mode -> return a stub so the dev simulate flow runs.
  app.post('/payments/checkout/:settlementId', { preHandler: requireAuth }, async (req) => {
    const { settlementId } = req.params as { settlementId: string };
    const settlement = await prisma.auctionSettlement.findUnique({
      where: { id: settlementId },
      include: { currentWinnerBid: true, auction: { select: { title: true } } },
    });
    if (!settlement || !settlement.currentWinnerBid) throw notFound('Settlement not found');
    if (settlement.currentWinnerBid.bidderId !== req.user!.sub) {
      throw forbidden('Only the current winner can initiate payment');
    }
    if (settlement.status !== 'AWAITING_PAYMENT') {
      throw conflict('This settlement is not awaiting payment');
    }

    const amount = settlement.currentWinnerBid.amount;

    // Save shipping address if supplied with checkout request
    const ShippingPayload = z.object({
      shippingName: z.string().min(2).max(100).optional(),
      shippingPhone: z.string().min(10).max(15).optional(),
      shippingAddress: z.string().min(5).max(300).optional(),
      shippingCity: z.string().min(2).max(100).optional(),
      shippingState: z.string().min(2).max(100).optional(),
      shippingPostalCode: z.string().min(5).max(10).optional(),
    }).optional();

    const parsedShipping = req.body ? ShippingPayload.safeParse(req.body) : null;
    if (parsedShipping?.success && parsedShipping.data && Object.keys(parsedShipping.data).length > 0) {
      await prisma.auctionSettlement.update({
        where: { id: settlementId },
        data: parsedShipping.data,
      });
    }

    if (!razorpayService.isConfigured()) {
      return {
        provider: 'mock' as const,
        message:
          'Payments are in mock mode. Use “Simulate paid”, or set PAYMENT_PROVIDER=razorpay with test keys.',
        settlementId,
        amountDue: amount.toFixed(2),
      };
    }

    const order = await razorpayService.createOrder({
      amountPaise: toPaise(amount),
      receipt: `aurene_${settlementId}`.slice(0, 40),
      notes: { settlementId, auctionId: settlement.auctionId },
    });

    // Record/refresh a PENDING transaction keyed by the Razorpay order id so the
    // webhook can resolve the settlement later.
    const existing = await prisma.transaction.findFirst({
      where: { settlementId, status: 'PENDING' },
    });
    if (existing) {
      await prisma.transaction.update({
        where: { id: existing.id },
        data: { provider: 'RAZORPAY', externalRef: order.id, amount },
      });
    } else {
      await prisma.transaction.create({
        data: { settlementId, amount, status: 'PENDING', provider: 'RAZORPAY', externalRef: order.id },
      });
    }

    return {
      provider: 'razorpay' as const,
      keyId: razorpayService.keyId(),
      orderId: order.id,
      amount: order.amount, // paise
      currency: order.currency,
      settlementId,
      name: 'Aurene',
      description: settlement.auction.title,
    };
  });

  // Verify a Checkout success and mark paid. Amount is server-derived.
  const VerifyBody = z.object({
    razorpayOrderId: z.string().min(1),
    razorpayPaymentId: z.string().min(1),
    razorpaySignature: z.string().min(1),
  });
  app.post('/payments/verify/:settlementId', { preHandler: requireAuth }, async (req) => {
    const { settlementId } = req.params as { settlementId: string };
    const body = VerifyBody.parse(req.body);

    const settlement = await prisma.auctionSettlement.findUnique({
      where: { id: settlementId },
      include: { currentWinnerBid: true },
    });
    if (!settlement || !settlement.currentWinnerBid) throw notFound('Settlement not found');
    if (settlement.currentWinnerBid.bidderId !== req.user!.sub) {
      throw forbidden('Only the current winner can confirm payment');
    }

    const ok = razorpayService.verifyCheckoutSignature({
      orderId: body.razorpayOrderId,
      paymentId: body.razorpayPaymentId,
      signature: body.razorpaySignature,
    });
    if (!ok) throw badRequest('Payment signature verification failed');

    // Attempt capture if not auto-captured by Razorpay (idempotent / safe)
    await razorpayService.capturePayment(
      body.razorpayPaymentId,
      toPaise(new Prisma.Decimal(settlement.currentWinnerBid.amount)),
    );

    await settlementService.markPaid(
      settlementId,
      req.user!.sub,
      new Prisma.Decimal(settlement.currentWinnerBid.amount),
      { provider: 'RAZORPAY', externalRef: body.razorpayPaymentId },
    );
    return { ok: true };
  });

  // Dev convenience: simulate a successful payment. Disabled once real payments
  // are configured in production.
  app.post('/payments/mock-complete/:settlementId', { preHandler: requireAuth }, async (req) => {
    if (razorpayService.isConfigured()) {
      throw forbidden('Mock completion is disabled — live Razorpay is active');
    }
    const { settlementId } = req.params as { settlementId: string };
    const settlement = await prisma.auctionSettlement.findUnique({
      where: { id: settlementId },
      include: { currentWinnerBid: true },
    });
    if (!settlement || !settlement.currentWinnerBid) throw notFound('Settlement not found');
    if (settlement.currentWinnerBid.bidderId !== req.user!.sub) {
      throw forbidden('Only the current winner can complete this');
    }

    const ShippingPayload = z.object({
      shippingName: z.string().min(2).max(100).optional(),
      shippingPhone: z.string().min(10).max(15).optional(),
      shippingAddress: z.string().min(5).max(300).optional(),
      shippingCity: z.string().min(2).max(100).optional(),
      shippingState: z.string().min(2).max(100).optional(),
      shippingPostalCode: z.string().min(5).max(10).optional(),
    }).optional();

    const parsedShipping = req.body ? ShippingPayload.safeParse(req.body) : null;
    if (parsedShipping?.success && parsedShipping.data && Object.keys(parsedShipping.data).length > 0) {
      await prisma.auctionSettlement.update({
        where: { id: settlementId },
        data: parsedShipping.data,
      });
    }

    await settlementService.markPaid(
      settlementId,
      req.user!.sub,
      new Prisma.Decimal(settlement.currentWinnerBid.amount),
      { provider: 'MOCK' },
    );
    return { ok: true };
  });
};

/**
 * Razorpay webhook handler. Invoked from the raw-body route registered in app.ts
 * (the signature must be verified against the exact bytes). Idempotent via
 * settlementService.markPaid and walletService.credit idempotencyKey.
 *
 * Handles both:
 * 1. Settlement payments (auction winning bids)
 * 2. Wallet deposit orders (wallet top-ups)
 */
export const handleRazorpayWebhook = async (
  rawBody: Buffer,
  signature: string | undefined,
): Promise<{ ok: boolean }> => {
  if (!razorpayService.verifyWebhookSignature(rawBody, signature)) {
    throw badRequest('Invalid webhook signature');
  }

  const event = JSON.parse(rawBody.toString('utf8')) as {
    event?: string;
    payload?: {
      payment?: { entity?: { id?: string; order_id?: string; amount?: number; notes?: Record<string, string> } };
      order?: { entity?: { id?: string; notes?: Record<string, string> } };
    };
  };

  if (event.event === 'payment.captured' || event.event === 'order.paid') {
    const orderId = event.payload?.payment?.entity?.order_id ?? event.payload?.order?.entity?.id;
    const paymentId = event.payload?.payment?.entity?.id;
    if (!orderId) return { ok: true };

    // ── 1. Check if this is a settlement payment ──────────────────────────
    const txn = await prisma.transaction.findFirst({
      where: { externalRef: orderId },
      include: { settlement: { include: { currentWinnerBid: true } } },
    });
    const winnerBid = txn?.settlement?.currentWinnerBid;
    if (txn && winnerBid) {
      await settlementService
        .markPaid(txn.settlementId, winnerBid.bidderId, new Prisma.Decimal(winnerBid.amount), {
          provider: 'RAZORPAY',
          externalRef: paymentId ?? orderId,
        })
        .catch((e) => logger.error({ err: (e as Error).message, orderId }, 'webhook markPaid failed'));
      return { ok: true };
    }

    // ── 2. Check if this is a wallet deposit ──────────────────────────────
    const depositOrder = await prisma.walletDepositOrder.findUnique({
      where: { razorpayOrderId: orderId },
    });
    if (depositOrder && depositOrder.status === 'PENDING') {
      try {
        await walletService.credit({
          userId: depositOrder.userId,
          amountDecimal: new Prisma.Decimal(depositOrder.amount),
          type: 'DEPOSIT_CREDIT',
          reference: paymentId ?? orderId,
          idempotencyKey: `deposit:${orderId}`,
          description: 'Funds deposited via Razorpay',
        });
        await prisma.walletDepositOrder.update({
          where: { id: depositOrder.id },
          data: { status: 'COMPLETED' },
        });
        logger.info({ orderId, userId: depositOrder.userId }, 'webhook: wallet deposit credited');
      } catch (e) {
        logger.error({ err: (e as Error).message, orderId }, 'webhook wallet deposit credit failed');
      }
      return { ok: true };
    }

    // If the deposit was already completed (idempotent), still return ok.
    if (depositOrder && depositOrder.status === 'COMPLETED') {
      return { ok: true };
    }

    if (!txn && !depositOrder) {
      logger.warn({ orderId }, 'razorpay webhook: no matching settlement or deposit order');
    }
  }

  // ── 3. RazorpayX Payout webhooks ─────────────────────────────────────────
  if (event.event === 'payout.processed') {
    const payoutEntity = (event.payload as any)?.payout?.entity;
    const payoutId = payoutEntity?.id;
    const referenceId = payoutEntity?.reference_id as string | undefined;
    const withdrawalId = referenceId?.startsWith('w_') ? referenceId.slice(2) : undefined;

    const w = await prisma.withdrawal.findFirst({
      where: {
        OR: [
          ...(payoutId ? [{ externalRef: payoutId }] : []),
          ...(withdrawalId ? [{ id: withdrawalId }] : []),
        ],
      },
    });

    if (w && w.status !== 'COMPLETED') {
      await prisma.withdrawal.update({
        where: { id: w.id },
        data: { status: 'COMPLETED', completedAt: new Date(), externalRef: payoutId ?? w.externalRef },
      });
      logger.info({ withdrawalId: w.id, payoutId }, 'webhook: withdrawal payout processed (COMPLETED)');
    }
    return { ok: true };
  }

  if (event.event === 'payout.reversed' || event.event === 'payout.failed') {
    const payoutEntity = (event.payload as any)?.payout?.entity;
    const payoutId = payoutEntity?.id;
    const referenceId = payoutEntity?.reference_id as string | undefined;
    const failureReason = payoutEntity?.status_details?.description ?? payoutEntity?.failure_reason ?? 'Payout failed';
    const withdrawalId = referenceId?.startsWith('w_') ? referenceId.slice(2) : undefined;

    const w = await prisma.withdrawal.findFirst({
      where: {
        OR: [
          ...(payoutId ? [{ externalRef: payoutId }] : []),
          ...(withdrawalId ? [{ id: withdrawalId }] : []),
        ],
      },
    });

    if (w && w.status !== 'FAILED') {
      await prisma.$transaction(async (tx) => {
        await tx.withdrawal.update({
          where: { id: w.id },
          data: { status: 'FAILED', failureReason },
        });
        // Refund funds back to seller wallet
        await walletService.credit(
          {
            userId: w.userId,
            amountDecimal: w.amount,
            type: 'ADJUSTMENT',
            reference: w.id,
            idempotencyKey: `payout_fail_refund:${w.id}`,
            description: `Refund: withdrawal failed (${failureReason})`,
          },
          tx,
        );
      });
      logger.warn({ withdrawalId: w.id, payoutId, failureReason }, 'webhook: withdrawal payout failed — refunded wallet');
    }
    return { ok: true };
  }

  return { ok: true };
};
