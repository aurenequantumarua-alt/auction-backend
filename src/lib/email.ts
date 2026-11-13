import { Resend } from 'resend';
import { env } from '../config/env.js';
import { logger } from './logger.js';

const resend = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null;

export const emailService = {
  async sendOtp(email: string, code: string): Promise<void> {
    if (!resend) {
      logger.warn('[email] No RESEND_API_KEY — email not sent.');
      throw new Error('Email service is not configured');
    }

    try {
      const result = await resend.emails.send({
        from: 'Aurene <noreply@aurenefashions.in>',
        to: email,
        subject: 'Your Aurene Verification Code',
        html: `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 32px; background: #ffffff;">
            <h2 style="margin: 0 0 8px; color: #111827;">Your verification code</h2>
            <p style="color: #6b7280; margin: 0 0 24px;">Enter this code to verify your Aurene account.</p>
            <div style="background: #f4f4f5; border-radius: 12px; padding: 24px; text-align: center; margin-bottom: 24px;">
              <span style="font-size: 40px; font-weight: 700; letter-spacing: 0.4em; color: #111827;">${code}</span>
            </div>
            <p style="color: #6b7280; font-size: 14px; margin: 0;">This code expires in ${env.OTP_TTL_MINUTES} minutes. If you didn't request this, ignore this email.</p>
          </div>
        `,
      });

      if (result.error) {
        logger.error({ error: result.error, email }, 'Resend API returned an error');
        throw new Error('Failed to send verification email');
      }

      logger.info({ email, id: result.data?.id }, 'Email OTP sent via Resend');
    } catch (err) {
      logger.error({ err, email }, 'Failed to send email via Resend');
      throw new Error('Failed to send verification email');
    }
  },

  async sendPasswordResetOtp(email: string, code: string): Promise<void> {
    if (!resend) {
      logger.warn('[email] No RESEND_API_KEY — reset email not sent.');
      return;
    }

    try {
      const result = await resend.emails.send({
        from: 'Aurene <noreply@aurenefashions.in>',
        to: email,
        subject: 'Reset your Aurene password',
        html: `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 32px; background: #ffffff;">
            <h2 style="margin: 0 0 8px; color: #111827;">Reset your password</h2>
            <p style="color: #6b7280; margin: 0 0 24px;">Enter this code to set a new password for your Aurene account.</p>
            <div style="background: #f4f4f5; border-radius: 12px; padding: 24px; text-align: center; margin-bottom: 24px;">
              <span style="font-size: 40px; font-weight: 700; letter-spacing: 0.4em; color: #111827;">${code}</span>
            </div>
            <p style="color: #6b7280; font-size: 14px; margin: 0;">This code expires in ${env.OTP_TTL_MINUTES} minutes. If you did not request a password reset, you can safely ignore this email.</p>
          </div>
        `,
      });

      if (result.error) {
        logger.error({ error: result.error, email }, 'Resend API returned an error');
      } else {
        logger.info({ email, id: result.data?.id }, 'Password reset email sent via Resend');
      }
    } catch (err) {
      logger.error({ err, email }, 'Failed to send password reset email via Resend');
    }
  },
};
