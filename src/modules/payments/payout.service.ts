import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

export interface PayoutResult {
  /** COMPLETED for the mock provider (instant); PROCESSING when handed to a real PSP. */
  status: 'COMPLETED' | 'PROCESSING';
  provider: string;
  externalRef: string | null;
}

export interface CreatePayoutInput {
  withdrawalId: string;
  amount: string; // rupees, 2dp
  bankLast4: string;
}

/**
 * Payout seam. The mock provider settles instantly. RazorpayX is left as a
 * clean stub: it would create a real payout and return PROCESSING, with the
 * webhook later flipping the Withdrawal to COMPLETED/FAILED.
 */
export const payoutService = {
  async createPayout(input: CreatePayoutInput): Promise<PayoutResult> {
    if (env.PAYOUT_PROVIDER === 'razorpayx') {
      // Real integration would call the RazorpayX Payouts API here and return
      // PROCESSING. Until wired, fall through to a processing seam.
      logger.info({ withdrawalId: input.withdrawalId }, 'razorpayx payout (stub) -> PROCESSING');
      return { status: 'PROCESSING', provider: 'razorpayx', externalRef: null };
    }
    // Mock: settle immediately with a synthetic reference.
    return {
      status: 'COMPLETED',
      provider: 'MOCK',
      externalRef: `mock_payout_${randomUUID()}`,
    };
  },
};
