import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default('0.0.0.0'),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173,https://auction-frontend-five-rose.vercel.app')
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(30),
  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SECURE: z
    .string()
    .optional()
    .transform((v) => (v !== undefined ? v.toLowerCase() === 'true' : process.env.NODE_ENV === 'production')),

  PAYMENT_WINDOW_HOURS: z.coerce.number().int().positive().default(24),
  ANTI_SNIPE_WINDOW_SECONDS: z.coerce.number().int().nonnegative().default(30),
  ANTI_SNIPE_EXTEND_SECONDS: z.coerce.number().int().nonnegative().default(30),

  // Payments. "mock" keeps the dev simulate-paid flow; "razorpay" enables the
  // real gateway. Keys are optional so the app always boots — if provider is
  // razorpay but keys are missing we fall back to mock at runtime (with a warn).
  PAYMENT_PROVIDER: z.enum(['mock', 'razorpay']).default('mock'),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),

  // Platform economics + payouts.
  // Commission the platform keeps on each sale (basis points; 1000 = 10%).
  PLATFORM_COMMISSION_BPS: z.coerce.number().int().min(0).max(10000).default(1000),
  // Minimum wallet withdrawal (rupees).
  WITHDRAWAL_MIN: z.coerce.number().nonnegative().default(100),
  // "mock" settles withdrawals instantly; "manual" keeps pending for admin transfer; "razorpayx" uses RazorpayX API.
  PAYOUT_PROVIDER: z.enum(['mock', 'razorpayx', 'manual']).default('mock'),
  // 64-hex-char key to encrypt stored bank account numbers. If unset, a key is
  // derived from JWT_ACCESS_SECRET so the app still works out of the box.
  BANK_ENCRYPTION_KEY: z.string().optional(),

  // Escrow & delivery verification.
  // Hours the buyer has to inspect the item after delivery before auto-release.
  INSPECTION_WINDOW_HOURS: z.coerce.number().int().positive().default(48),
  // Days the seller has to ship before auto-refund to buyer.
  SHIPPING_DEADLINE_DAYS: z.coerce.number().int().positive().default(5),
  // User ID of the platform owner; platform profit (commission) is credited to
  // this user's wallet on escrow release. If unset, commission is recorded in
  // the Transaction.commissionAmount column but NOT credited to any wallet.
  PLATFORM_OWNER_USER_ID: z.string().optional(),
  // Automated UPI ID to which the 10% platform commission is automatically paid out
  PLATFORM_COMMISSION_UPI_ID: z.string().optional(),
  // RazorpayX virtual account number (from RazorpayX dashboard)
  RAZORPAYX_ACCOUNT_NUMBER: z.string().optional(),

  // Phone OTP verification (for linking a UPI/phone payout method).
  // "mock" doesn't send a real SMS — in non-production the code is returned to
  // the client so the flow is testable. Set a provider + key to send real SMS.
  SMS_PROVIDER: z.enum(['mock', 'msg91', 'twilio']).default('mock'),
  SMS_API_KEY: z.string().optional(),
  SMS_SENDER_ID: z.string().optional(),
  OTP_TTL_MINUTES: z.coerce.number().int().positive().default(5),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  RESEND_API_KEY: z.string().optional(),
  FIREBASE_API_KEY: z.string().optional(),

  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  UPLOADS_DIR: z.string().default('./uploads'),
  PUBLIC_UPLOADS_BASE_URL: z.string().default('http://localhost:4000/uploads'),
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET_NAME: z.string().optional(),
  R2_PUBLIC_URL: z.string().optional(),

  RATE_LIMIT_AUTH_MAX: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_AUTH_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_BID_MAX: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_BID_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment configuration:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;

// ── Secrets / provider-consistency hardening ───────────────────────────────
// Fail fast on unsafe or half-configured secrets. In production these are
// fatal; in development they are warnings so local work isn't blocked.
{
  const isProd = env.NODE_ENV === 'production';
  const fatal: string[] = [];
  const warn: string[] = [];

  // A configured BANK_ENCRYPTION_KEY must be exactly 32 bytes (64 hex chars).
  if (env.BANK_ENCRYPTION_KEY && !/^[0-9a-fA-F]{64}$/.test(env.BANK_ENCRYPTION_KEY)) {
    fatal.push('BANK_ENCRYPTION_KEY must be 64 hex characters (32 bytes).');
  }

  // Payments enabled but keys missing -> would silently fall back to mock.
  if (env.PAYMENT_PROVIDER === 'razorpay' && !(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET)) {
    (isProd ? fatal : warn).push('PAYMENT_PROVIDER=razorpay but RAZORPAY_KEY_ID/SECRET are missing.');
  }
  // Keys present but no webhook secret -> the durable settlement path is off.
  if (env.RAZORPAY_KEY_SECRET && !env.RAZORPAY_WEBHOOK_SECRET) {
    warn.push(
      'RAZORPAY_KEY_SECRET is set but RAZORPAY_WEBHOOK_SECRET is missing — webhook settlement is disabled.',
    );
  }
  if (env.PAYOUT_PROVIDER === 'razorpayx' && !(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET)) {
    (isProd ? fatal : warn).push('PAYOUT_PROVIDER=razorpayx but Razorpay keys are missing.');
  }
  if (env.SMS_PROVIDER !== 'mock' && !env.SMS_API_KEY) {
    (isProd ? fatal : warn).push(`SMS_PROVIDER=${env.SMS_PROVIDER} but SMS_API_KEY is missing.`);
  }

  // Production-only invariants.
  if (isProd) {
    if (!env.COOKIE_SECURE) fatal.push('COOKIE_SECURE must be true in production (HTTPS).');
    if (env.PAYOUT_PROVIDER === 'mock') {
      warn.push('PAYOUT_PROVIDER=mock in production — set PAYOUT_PROVIDER=manual so withdrawals wait for admin approval.');
    }
    if (!env.BANK_ENCRYPTION_KEY)
      warn.push('BANK_ENCRYPTION_KEY is unset in production — deriving fallback key from JWT_ACCESS_SECRET.');
    if (env.CORS_ORIGINS.some((o) => o.includes('localhost')))
      warn.push('CORS_ORIGINS contains localhost in production.');
  }

  for (const w of warn) console.warn('WARN(config):', w);
  if (fatal.length) {
    console.error('FATAL(config):\n  - ' + fatal.join('\n  - '));
    process.exit(1);
  }
}
