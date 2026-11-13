import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

export interface PayoutResult {
  /** COMPLETED for the mock provider (instant); PROCESSING when handed to a real PSP. */
  status: 'COMPLETED' | 'PROCESSING';
  provider: string;
  externalRef: string | null;
}

export type PayoutDestination =
  | {
      type: 'UPI';
      upiId: string;
      name: string;
    }
  | {
      type: 'BANK';
      accountNumber: string;
      ifsc: string;
      name: string;
    };

export interface CreatePayoutInput {
  withdrawalId: string;
  amount: string; // rupees, 2dp
  bankLast4: string;
  destination?: PayoutDestination;
}

export interface SendUpiPayoutInput {
  upiId: string;
  amount: number; // in rupees
  description: string;
  referenceId: string;
}

export interface UpiPayoutResult {
  success: boolean;
  provider: string;
  payoutId: string | null;
  status: string;
}

/**
 * Payout service. Supports both mock instant settlements for local dev/testing
 * and real RazorpayX automated Payouts to bank accounts or UPI VPAs.
 */
export const payoutService = {
  async createPayout(input: CreatePayoutInput): Promise<PayoutResult> {
    if (
      env.PAYOUT_PROVIDER === 'razorpayx' &&
      env.RAZORPAY_KEY_ID &&
      env.RAZORPAY_KEY_SECRET &&
      env.RAZORPAYX_ACCOUNT_NUMBER &&
      input.destination
    ) {
      const amountInPaise = Math.round(Number(input.amount) * 100);
      const fund_account =
        input.destination.type === 'UPI'
          ? {
              account_type: 'vpa',
              vpa: { address: input.destination.upiId },
              contact: { name: input.destination.name, type: 'vendor' },
            }
          : {
              account_type: 'bank_account',
              bank_account: {
                name: input.destination.name,
                ifsc: input.destination.ifsc,
                account_number: input.destination.accountNumber,
              },
              contact: { name: input.destination.name, type: 'vendor' },
            };

      const mode = input.destination.type === 'UPI' ? 'UPI' : 'IMPS';

      try {
        const auth = Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64');
        const response = await fetch('https://api.razorpay.com/v1/payouts', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Basic ${auth}`,
          },
          body: JSON.stringify({
            account_number: env.RAZORPAYX_ACCOUNT_NUMBER,
            fund_account,
            amount: amountInPaise,
            currency: 'INR',
            mode,
            purpose: 'payout',
            queue_if_low_balance: true,
            reference_id: `w_${input.withdrawalId}`,
            narration: 'Aurene Payout',
          }),
        });

        const data = (await response.json()) as any;
        if (!response.ok) {
          logger.error({ data }, 'RazorpayX seller payout API error');
          return { status: 'PROCESSING', provider: 'razorpayx', externalRef: null };
        }

        logger.info({ payoutId: data.id, amount: input.amount }, 'RazorpayX seller payout initiated');
        return {
          status: data.status === 'processed' ? 'COMPLETED' : 'PROCESSING',
          provider: 'razorpayx',
          externalRef: data.id,
        };
      } catch (err: any) {
        logger.error({ err: err?.message }, 'Error calling RazorpayX seller payout');
        return { status: 'PROCESSING', provider: 'razorpayx', externalRef: null };
      }
    }

    if (env.PAYOUT_PROVIDER === 'razorpayx') {
      logger.info({ withdrawalId: input.withdrawalId }, 'razorpayx payout (stub/missing credentials) -> PROCESSING');
      return { status: 'PROCESSING', provider: 'razorpayx', externalRef: null };
    }

    // Mock: settle immediately with a synthetic reference.
    return {
      status: 'COMPLETED',
      provider: 'MOCK',
      externalRef: `mock_payout_${randomUUID()}`,
    };
  },

  /**
   * Automated instant payout of the platform revenue directly to a UPI ID.
   * Can be configured via PLATFORM_COMMISSION_UPI_ID in .env.
   */
  async sendUpiPayout(input: SendUpiPayoutInput): Promise<UpiPayoutResult> {
    const { upiId, amount, description, referenceId } = input;
    const amountInPaise = Math.round(amount * 100);

    if (amountInPaise <= 0) {
      return { success: false, provider: 'NONE', payoutId: null, status: 'SKIPPED' };
    }

    // Real RazorpayX Payouts if configured
    if (
      env.PAYOUT_PROVIDER === 'razorpayx' &&
      env.RAZORPAY_KEY_ID &&
      env.RAZORPAY_KEY_SECRET &&
      env.RAZORPAYX_ACCOUNT_NUMBER
    ) {
      try {
        const auth = Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64');
        const response = await fetch('https://api.razorpay.com/v1/payouts', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Basic ${auth}`,
          },
          body: JSON.stringify({
            account_number: env.RAZORPAYX_ACCOUNT_NUMBER,
            fund_account: {
              account_type: 'vpa',
              vpa: { address: upiId },
              contact: {
                name: 'Platform Revenue',
                type: 'self',
              },
            },
            amount: amountInPaise,
            currency: 'INR',
            mode: 'UPI',
            purpose: 'payout',
            queue_if_low_balance: true,
            reference_id: referenceId,
            narration: description.slice(0, 30),
          }),
        });

        const data = (await response.json()) as any;
        if (!response.ok) {
          logger.error({ data }, 'RazorpayX UPI Payout API error');
          return { success: false, provider: 'razorpayx', payoutId: null, status: 'FAILED' };
        }

        logger.info(
          { payoutId: data.id, upiId, amount },
          'RazorpayX automated UPI payout initiated successfully',
        );

        return {
          success: true,
          provider: 'razorpayx',
          payoutId: data.id,
          status: data.status ?? 'PROCESSING',
        };
      } catch (err: any) {
        logger.error({ err: err?.message }, 'Error calling RazorpayX UPI Payout');
        return { success: false, provider: 'razorpayx', payoutId: null, status: 'ERROR' };
      }
    }

    // Default / Mock / Dev mode: simulate instant UPI credit
    const syntheticRef = `mock_upi_payout_${randomUUID()}`;
    logger.info(
      {
        amount: `₹${amount.toFixed(2)}`,
        upiId,
        ref: syntheticRef,
        referenceId,
      },
      '⚡ [AUTOMATED UPI PAYOUT] Platform commission credited to UPI ID',
    );

    return {
      success: true,
      provider: 'MOCK',
      payoutId: syntheticRef,
      status: 'COMPLETED',
    };
  },
};
