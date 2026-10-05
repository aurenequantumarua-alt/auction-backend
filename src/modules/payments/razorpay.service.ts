import crypto from 'node:crypto';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

/**
 * Razorpay provider. Uses the REST API directly (no SDK) so it stays a clean
 * ESM/TS dependency-light module. All money crosses the wire to Razorpay in
 * INR paise (integer); our DB stores Decimal rupees.
 *
 * The app boots fine without keys — `isConfigured()` is false and the payment
 * routes fall back to the mock flow.
 */

const RZP_API = 'https://api.razorpay.com/v1';

export const razorpayService = {
  isConfigured(): boolean {
    return (
      env.PAYMENT_PROVIDER === 'razorpay' &&
      Boolean(env.RAZORPAY_KEY_ID) &&
      Boolean(env.RAZORPAY_KEY_SECRET)
    );
  },

  keyId(): string | undefined {
    return env.RAZORPAY_KEY_ID;
  },

  webhookConfigured(): boolean {
    return Boolean(env.RAZORPAY_WEBHOOK_SECRET);
  },

  /** Create a Razorpay order. `amountPaise` must be an integer number of paise. */
  async createOrder(params: {
    amountPaise: number;
    receipt: string;
    notes?: Record<string, string>;
  }): Promise<{ id: string; amount: number; currency: string; status: string }> {
    if (!this.isConfigured()) throw new Error('Razorpay is not configured');
    const auth = Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64');
    const res = await fetch(`${RZP_API}/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify({
        amount: params.amountPaise,
        currency: 'INR',
        receipt: params.receipt,
        payment_capture: 1,
        notes: params.notes ?? {},
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      logger.error({ status: res.status, text }, 'Razorpay order creation failed');
      throw new Error(`Razorpay order creation failed (${res.status})`);
    }
    return (await res.json()) as { id: string; amount: number; currency: string; status: string };
  },

  /** Capture an authorized payment if it wasn't auto-captured. Safe to fail if already captured. */
  async capturePayment(paymentId: string, amountPaise: number): Promise<void> {
    if (!this.isConfigured()) return;
    try {
      const auth = Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64');
      const res = await fetch(`${RZP_API}/payments/${paymentId}/capture`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${auth}`,
        },
        body: JSON.stringify({ amount: amountPaise, currency: 'INR' }),
      });
      if (!res.ok) {
        const text = await res.text();
        logger.debug({ status: res.status, text, paymentId }, 'Razorpay capture note (often already captured)');
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message, paymentId }, 'Razorpay capture attempt failed');
    }
  },

  /** Verify the Checkout success signature: HMAC_SHA256(orderId|paymentId, keySecret). */
  verifyCheckoutSignature(params: {
    orderId: string;
    paymentId: string;
    signature: string;
  }): boolean {
    if (!env.RAZORPAY_KEY_SECRET) return false;
    const expected = crypto
      .createHmac('sha256', env.RAZORPAY_KEY_SECRET)
      .update(`${params.orderId}|${params.paymentId}`)
      .digest('hex');
    return timingSafeEqualHex(expected, params.signature);
  },

  /** Verify a webhook payload: HMAC_SHA256(rawBody, webhookSecret) vs the header.
   *  Hashes the exact bytes — a string is treated as UTF-8 for safety. */
  verifyWebhookSignature(rawBody: Buffer | string, signature: string | undefined): boolean {
    if (!env.RAZORPAY_WEBHOOK_SECRET || !signature) return false;
    const bytes = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
    const expected = crypto
      .createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET)
      .update(bytes)
      .digest('hex');
    return timingSafeEqualHex(expected, signature);
  },
};

/** Constant-time hex comparison that never throws on length mismatch. */
function timingSafeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ab.length === 0 || ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
