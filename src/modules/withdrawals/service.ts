import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { badRequest } from '../../utils/http-error.js';
import { walletService } from '../wallet/service.js';
import { payoutDestinationLabel } from '../bankAccounts/service.js';
import { payoutService } from '../payments/payout.service.js';

const serialize = (w: {
  id: string;
  amount: Prisma.Decimal;
  status: string;
  bankLast4: string;
  provider: string;
  externalRef: string | null;
  failureReason: string | null;
  requestedAt: Date;
  completedAt: Date | null;
}) => ({
  id: w.id,
  amount: w.amount.toFixed(2),
  status: w.status,
  bankLast4: w.bankLast4,
  provider: w.provider,
  externalRef: w.externalRef,
  failureReason: w.failureReason,
  requestedAt: w.requestedAt.toISOString(),
  completedAt: w.completedAt ? w.completedAt.toISOString() : null,
});

export const withdrawalService = {
  /**
   * Request a withdrawal. Validates a VERIFIED bank account, the min amount and
   * sufficient balance, then atomically debits the wallet (ledger row, wallet
   * locked) and creates the Withdrawal row. With the mock provider the payout
   * settles instantly (COMPLETED + completedAt). The debit and the row are
   * created in a single $transaction so a withdrawal never exists without its
   * matching ledger debit.
   */
  async request(userId: string, amountInput: number | string) {
    const acct = await prisma.bankAccount.findUnique({ where: { userId } });
    if (!acct || acct.status !== 'VERIFIED') {
      throw badRequest('Add a verified payout method before withdrawing');
    }

    const amount = new Prisma.Decimal(amountInput);
    if (!amount.isFinite() || amount.lessThanOrEqualTo(0)) {
      throw badRequest('Withdrawal amount must be positive');
    }
    if (amount.lessThan(env.WITHDRAWAL_MIN)) {
      throw badRequest(`Minimum withdrawal is ${env.WITHDRAWAL_MIN}`);
    }

    // Pre-check balance before any write to reject overdraws early with a 400.
    const wallet = await walletService.getOrCreate(userId);
    if (amount.greaterThan(wallet.balance)) {
      throw badRequest('Withdrawal exceeds available balance');
    }

    const destination = payoutDestinationLabel(acct);
    const isAsync = env.PAYOUT_PROVIDER === 'razorpayx';

    // The wallet debit and the Withdrawal row are created together so a
    // withdrawal never exists without its matching ledger debit. With the mock
    // provider (synchronous settle) we mark it COMPLETED inside the same
    // transaction — no external call — so a crash can't leave it stuck.
    const withdrawal = await prisma.$transaction(async (tx) => {
      const created = await tx.withdrawal.create({
        data: {
          userId,
          amount,
          status: isAsync ? 'PROCESSING' : 'COMPLETED',
          provider: isAsync ? 'razorpayx' : 'MOCK',
          bankLast4: destination,
          externalRef: isAsync ? null : `mock_${userId.slice(-6)}`,
          completedAt: isAsync ? null : new Date(),
        },
      });

      await walletService.debit(
        {
          userId,
          amountDecimal: amount,
          type: 'WITHDRAWAL_DEBIT',
          reference: created.id,
          description: `Withdrawal to ${destination}`,
        },
        tx,
      );

      // Stamp a unique mock payout reference (tied to the row id).
      if (!isAsync) {
        return tx.withdrawal.update({
          where: { id: created.id },
          data: { externalRef: `mock_${created.id}` },
        });
      }
      return created;
    });

    // Async providers (RazorpayX): hand off after commit; a webhook flips
    // PROCESSING -> COMPLETED/FAILED later.
    if (isAsync) {
      const payout = await payoutService.createPayout({
        withdrawalId: withdrawal.id,
        amount: amount.toFixed(2),
        bankLast4: destination,
      });
      const finalized = await prisma.withdrawal.update({
        where: { id: withdrawal.id },
        data: {
          status: payout.status,
          provider: payout.provider,
          externalRef: payout.externalRef,
          completedAt: payout.status === 'COMPLETED' ? new Date() : null,
        },
      });
      return serialize(finalized);
    }

    return serialize(withdrawal);
  },

  async list(userId: string) {
    const rows = await prisma.withdrawal.findMany({
      where: { userId },
      orderBy: { requestedAt: 'desc' },
      take: 100,
    });
    return rows.map(serialize);
  },
};
