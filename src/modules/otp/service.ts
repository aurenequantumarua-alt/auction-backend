import crypto from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { smsService } from '../../lib/sms.js';
import { emailService } from '../../lib/email.js';
import { logger } from '../../lib/logger.js';
import { badRequest } from '../../utils/http-error.js';

// OTPs are short-lived; an HMAC of the code (keyed by the JWT secret) is stored,
// never the code itself.
const hashCode = (code: string): string =>
  crypto.createHmac('sha256', env.JWT_ACCESS_SECRET).update(code).digest('hex');

const REQUEST_WINDOW_MS = 15 * 60 * 1000;
const REQUEST_MAX = 5;

export const otpService = {
  /**
   * Generate + "send" a 6-digit OTP for a phone number. Rate-limited per
   * user+phone. In non-production the code is returned (devCode) so the flow is
   * testable without a real SMS provider.
   */
  async request(userId: string, phone: string): Promise<{ sent: boolean; devCode?: string }> {
    const since = new Date(Date.now() - REQUEST_WINDOW_MS);
    const recent = await prisma.phoneOtp.count({
      where: { userId, phone, createdAt: { gte: since } },
    });
    if (recent >= REQUEST_MAX) {
      throw badRequest('Too many OTP requests. Please try again in a few minutes.');
    }

    const code = String(crypto.randomInt(100000, 1000000)); // 6 digits
    await prisma.phoneOtp.create({
      data: {
        userId,
        phone,
        codeHash: hashCode(code),
        expiresAt: new Date(Date.now() + env.OTP_TTL_MINUTES * 60 * 1000),
      },
    });

    await smsService.send(
      phone,
      `Your Aurene verification code is ${code}. It expires in ${env.OTP_TTL_MINUTES} minutes.`,
    );

    return { sent: true, devCode: env.NODE_ENV === 'production' ? undefined : code };
  },

  /** Verify a code for a phone. Throws (400) on missing/expired/wrong/too-many. */
  async verify(userId: string, phone: string, code: string): Promise<void> {
    const otp = await prisma.phoneOtp.findFirst({
      where: { userId, phone, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (!otp) throw badRequest('Request a verification code first');
    if (otp.expiresAt < new Date()) throw badRequest('Code expired — request a new one');
    if (otp.attempts >= env.OTP_MAX_ATTEMPTS) {
      throw badRequest('Too many incorrect attempts — request a new code');
    }
    if (otp.codeHash !== hashCode(code)) {
      await prisma.phoneOtp.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
      throw badRequest('Incorrect code');
    }
    await prisma.phoneOtp.update({ where: { id: otp.id }, data: { consumedAt: new Date() } });
  },

  async requestEmail(userId: string, email: string): Promise<{ sent: boolean }> {
    const since = new Date(Date.now() - REQUEST_WINDOW_MS);
    const recent = await prisma.emailOtp.count({
      where: { userId, email, createdAt: { gte: since } },
    });
    if (recent >= REQUEST_MAX) {
      throw badRequest('Too many OTP requests. Please try again in a few minutes.');
    }

    const code = String(crypto.randomInt(100000, 1000000)); // 6 digits
    await prisma.emailOtp.create({
      data: {
        userId,
        email,
        codeHash: hashCode(code),
        expiresAt: new Date(Date.now() + env.OTP_TTL_MINUTES * 60 * 1000),
      },
    });

    await emailService.sendOtp(email, code);

    return { sent: true };
  },

  async verifyEmail(userId: string, email: string, code: string): Promise<void> {
    const otp = await prisma.emailOtp.findFirst({
      where: { userId, email, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (!otp) throw badRequest('Request a verification code first');
    if (otp.expiresAt < new Date()) throw badRequest('Code expired — request a new one');
    if (otp.attempts >= env.OTP_MAX_ATTEMPTS) {
      throw badRequest('Too many incorrect attempts — request a new code');
    }
    if (otp.codeHash !== hashCode(code)) {
      await prisma.emailOtp.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
      throw badRequest('Incorrect code');
    }
    await prisma.emailOtp.update({ where: { id: otp.id }, data: { consumedAt: new Date() } });
  },

  async requestPasswordReset(userId: string, email: string): Promise<{ sent: boolean; devCode?: string }> {
    const since = new Date(Date.now() - REQUEST_WINDOW_MS);
    const recent = await prisma.emailOtp.count({
      where: { userId, email, createdAt: { gte: since } },
    });
    if (recent >= REQUEST_MAX) {
      throw badRequest('Too many requests. Please try again in a few minutes.');
    }

    const code = String(crypto.randomInt(100000, 1000000));
    await prisma.emailOtp.create({
      data: {
        userId,
        email,
        codeHash: hashCode(code),
        expiresAt: new Date(Date.now() + env.OTP_TTL_MINUTES * 60 * 1000),
      },
    });

    await emailService.sendPasswordResetOtp(email, code);

    logger.info({ email, code: env.NODE_ENV !== 'production' ? code : undefined }, 'Password reset OTP requested');

    return {
      sent: true,
      devCode: env.NODE_ENV !== 'production' ? code : undefined,
    };
  },

  async verifyPasswordReset(userId: string, email: string, code: string): Promise<void> {
    return this.verifyEmail(userId, email, code);
  },
};
