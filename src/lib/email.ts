import { Resend } from 'resend';
import { env } from '../config/env.js';
import { logger } from './logger.js';

const resend = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null;

/** Escape user-supplied strings before interpolating into HTML email templates. */
const esc = (str: string): string =>
  str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

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

  async sendNotificationEmail(email: string, subject: string, body: string): Promise<void> {
    if (!resend) {
      logger.warn('[email] No RESEND_API_KEY — notification email not sent.');
      return;
    }

    try {
      const result = await resend.emails.send({
        from: 'Aurene <noreply@aurenefashions.in>',
        to: email,
        subject,
        html: `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 32px; background: #ffffff;">
            <h2 style="margin: 0 0 8px; color: #111827;">${esc(subject)}</h2>
            <p style="color: #6b7280; margin: 0 0 24px;">${esc(body)}</p>
            <p style="color: #6b7280; font-size: 14px; margin: 0;">— Aurene</p>
          </div>
        `,
      });

      if (result.error) {
        logger.error({ error: result.error, email }, 'Failed to send notification email');
      } else {
        logger.info({ email, id: result.data?.id }, 'Notification email sent via Resend');
      }
    } catch (err) {
      logger.error({ err, email }, 'Failed to send notification email via Resend');
    }
  },

  async sendOutbidEmail(params: {
    to: string;
    recipientName?: string;
    auctionTitle: string;
    auctionId: string;
    previousAmount: string;
    newAmount: string;
    isRunnerUp?: boolean;
    appUrl?: string;
  }): Promise<void> {
    if (!resend) {
      logger.warn('[email] No RESEND_API_KEY — outbid email not sent.');
      return;
    }

    const appUrl = params.appUrl || 'https://aurenefashions.in';
    const auctionUrl = `${appUrl}/auctions/${params.auctionId}`;
    const isRunnerUp = Boolean(params.isRunnerUp);
    const safeTitle = esc(params.auctionTitle);
    const subject = isRunnerUp
      ? `🥈 You're Next in Line for "${params.auctionTitle}" · Aurene`
      : `You've been outbid on "${params.auctionTitle}" · Aurene`;

    const html = isRunnerUp
      ? `
        <div style="font-family: 'Georgia', serif, -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 24px; background: #FAF9F5; border: 1px solid #E8E2D6; border-radius: 8px;">
          <div style="text-align: center; margin-bottom: 24px;">
            <span style="font-size: 11px; letter-spacing: 0.25em; text-transform: uppercase; color: #8E764E; font-weight: 600;">Auréne</span>
            <h2 style="font-size: 24px; color: #0E1622; margin: 12px 0 6px; font-weight: normal;">You Placed 2nd · Next in Line</h2>
          </div>
          <div style="background: #ffffff; border: 1px solid #E0DAD0; border-radius: 6px; padding: 24px; margin-bottom: 24px;">
            <p style="font-size: 14px; color: #131C2A; line-height: 1.6; margin: 0 0 16px;">
              Bidding for <strong>"${safeTitle}"</strong> has concluded. The winning bidder now has 24 hours to complete payment into escrow.
            </p>
            <div style="background: #F4EFE6; border-left: 3px solid #B89C6F; padding: 12px 16px; margin-bottom: 16px;">
              <p style="font-size: 13px; color: #5C4A30; margin: 0; line-height: 1.5;">
                <strong>Backup Winner:</strong> If the winning bidder forfeits or fails to pay within 24 hours, this item will immediately be offered to you at your highest bid of <strong>₹${Number(params.previousAmount || params.newAmount).toLocaleString('en-IN')}</strong>.
              </p>
            </div>
            <p style="font-size: 13px; color: #6E7C91; margin: 0;">
              No action is required right now. Keep an eye on your notifications — if promoted, you will be given 24 hours to complete your purchase.
            </p>
          </div>
          <div style="text-align: center; margin-bottom: 24px;">
            <a href="${auctionUrl}" style="display: inline-block; background: #0E1622; color: #FBFBF9; padding: 12px 28px; font-size: 12px; text-decoration: none; border-radius: 4px; text-transform: uppercase; letter-spacing: 0.15em; font-weight: 600;">
              View Details
            </a>
          </div>
          <p style="text-align: center; font-size: 11px; color: #9AA6B8; margin: 0;">
            Auréne — Authenticity & Protected Escrow
          </p>
        </div>
      `
      : `
        <div style="font-family: 'Georgia', serif, -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 24px; background: #FAF9F5; border: 1px solid #E8E2D6; border-radius: 8px;">
          <div style="text-align: center; margin-bottom: 24px;">
            <span style="font-size: 11px; letter-spacing: 0.25em; text-transform: uppercase; color: #8E764E; font-weight: 600;">Auréne</span>
            <h2 style="font-size: 24px; color: #0E1622; margin: 12px 0 6px; font-weight: normal;">You Have Been Outbid</h2>
          </div>
          <div style="background: #ffffff; border: 1px solid #E0DAD0; border-radius: 6px; padding: 24px; margin-bottom: 24px;">
            <p style="font-size: 14px; color: #131C2A; line-height: 1.6; margin: 0 0 16px;">
              Another bidder has placed a higher bid on <strong>"${safeTitle}"</strong>.
            </p>
            <table style="width: 100%; border-collapse: collapse; margin-bottom: 16px; font-size: 13px;">
              <tr>
                <td style="padding: 8px 0; color: #6E7C91;">Your Previous Bid:</td>
                <td style="padding: 8px 0; text-align: right; font-weight: 600; color: #6E7C91; text-decoration: line-through;">
                  ₹${Number(params.previousAmount).toLocaleString('en-IN')}
                </td>
              </tr>
              <tr style="border-top: 1px solid #F0ECE1;">
                <td style="padding: 8px 0; color: #0E1622; font-weight: 600;">Current Highest Bid:</td>
                <td style="padding: 8px 0; text-align: right; font-weight: 700; color: #0E1622; font-size: 15px;">
                  ₹${Number(params.newAmount).toLocaleString('en-IN')}
                </td>
              </tr>
            </table>
            <p style="font-size: 13px; color: #5C6675; margin: 0;">
              Place a higher bid now to reclaim your position as leading bidder before the auction ends.
            </p>
          </div>
          <div style="text-align: center; margin-bottom: 24px;">
            <a href="${auctionUrl}" style="display: inline-block; background: #0E1622; color: #FBFBF9; padding: 12px 28px; font-size: 12px; text-decoration: none; border-radius: 4px; text-transform: uppercase; letter-spacing: 0.15em; font-weight: 600;">
              Increase Your Bid
            </a>
          </div>
          <p style="text-align: center; font-size: 11px; color: #9AA6B8; margin: 0;">
            Auréne — Authenticity & Protected Escrow
          </p>
        </div>
      `;

    try {
      const result = await resend.emails.send({
        from: 'Aurene <noreply@aurenefashions.in>',
        to: params.to,
        subject,
        html,
      });

      if (result.error) {
        logger.error({ error: result.error, email: params.to }, 'Resend API error sending outbid email');
      } else {
        logger.info({ email: params.to, id: result.data?.id }, 'Outbid email sent via Resend');
      }
    } catch (err) {
      logger.error({ err, email: params.to }, 'Failed to send outbid email via Resend');
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
