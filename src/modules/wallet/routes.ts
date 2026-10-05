import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../middleware/auth.js';
import { PaginationQuerySchema } from '../../utils/pagination.js';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { badRequest } from '../../utils/http-error.js';
import { razorpayService } from '../payments/razorpay.service.js';
import { walletService } from './service.js';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';

export const registerWalletRoutes = async (app: FastifyInstance): Promise<void> => {
  app.get('/wallet', { preHandler: requireAuth }, async (req) => {
    return walletService.getBalance(req.user!.sub);
  });

  app.get('/wallet/transactions', { preHandler: requireAuth }, async (req) => {
    const query = PaginationQuerySchema.parse(req.query);
    return walletService.listTransactions(req.user!.sub, query);
  });

  const DepositCheckoutSchema = z.object({
    amount: z.string().min(1),
  });

  app.post('/wallet/deposit/checkout', { preHandler: requireAuth }, async (req) => {
    const { amount } = DepositCheckoutSchema.parse(req.body);
    const amountNum = Number(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      throw badRequest('Invalid deposit amount');
    }
    
    if (!razorpayService.isConfigured()) {
      return {
        provider: 'mock' as const,
        message: 'Payments are in mock mode.',
        amountDue: amount,
      };
    }

    // Convert Decimal rupees to integer paise for Razorpay
    const amountPaise = new Prisma.Decimal(amount).mul(100).toDecimalPlaces(0).toNumber();

    const order = await razorpayService.createOrder({
      amountPaise,
      receipt: `deposit_${req.user!.sub}_${Date.now()}`.slice(0, 40),
      notes: { type: 'wallet_deposit', userId: req.user!.sub },
    });

    // Persist the deposit order so the webhook can credit the wallet
    // even when the frontend verify call fails (e.g. auth token expired).
    await prisma.walletDepositOrder.create({
      data: {
        userId: req.user!.sub,
        razorpayOrderId: order.id,
        amount: new Prisma.Decimal(amount),
        status: 'PENDING',
      },
    });

    logger.info(
      { userId: req.user!.sub, orderId: order.id, amount },
      'wallet deposit order created',
    );

    return {
      provider: 'razorpay' as const,
      keyId: razorpayService.keyId(),
      orderId: order.id,
      amount: order.amount, // paise
      currency: order.currency,
      name: 'Aurene',
      description: 'Wallet Deposit',
    };
  });

  const VerifyDepositSchema = z.object({
    amount: z.string().min(1),
    razorpayOrderId: z.string().min(1),
    razorpayPaymentId: z.string().min(1),
    razorpaySignature: z.string().min(1),
  });

  app.post('/wallet/deposit/verify', { preHandler: requireAuth }, async (req) => {
    const body = VerifyDepositSchema.parse(req.body);

    const ok = razorpayService.verifyCheckoutSignature({
      orderId: body.razorpayOrderId,
      paymentId: body.razorpayPaymentId,
      signature: body.razorpaySignature,
    });
    if (!ok) throw badRequest('Payment signature verification failed');

    // Attempt capture if not auto-captured by Razorpay (idempotent / safe)
    const amountPaise = new Prisma.Decimal(body.amount).mul(100).toDecimalPlaces(0).toNumber();
    await razorpayService.capturePayment(body.razorpayPaymentId, amountPaise);

    // Credit the wallet (idempotent due to razorpayOrderId)
    await walletService.credit({
      userId: req.user!.sub,
      amountDecimal: new Prisma.Decimal(body.amount),
      type: 'DEPOSIT_CREDIT',
      reference: body.razorpayPaymentId,
      idempotencyKey: `deposit:${body.razorpayOrderId}`,
      description: 'Funds deposited via Razorpay',
    });

    // Mark the deposit order as completed
    await prisma.walletDepositOrder.updateMany({
      where: { razorpayOrderId: body.razorpayOrderId, status: 'PENDING' },
      data: { status: 'COMPLETED' },
    }).catch((e) => logger.warn({ err: (e as Error).message }, 'deposit order status update failed'));

    return { ok: true };
  });
};
