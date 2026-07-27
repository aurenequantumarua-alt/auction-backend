import { env } from '../config/env.js';
import { logger } from './logger.js';

/**
 * SMS provider seam. In "mock" mode (or with no API key) nothing is actually
 * sent — the OTP service surfaces the code to the client in non-production so
 * the flow is testable. Plug in msg91/twilio by implementing `send` below and
 * setting SMS_PROVIDER + SMS_API_KEY.
 */
export const smsService = {
  isConfigured(): boolean {
    return env.SMS_PROVIDER !== 'mock' && Boolean(env.SMS_API_KEY);
  },

  async send(phone: string, _message: string): Promise<void> {
    if (!this.isConfigured()) {
      // Never log the message body — it contains the OTP. In dev the code is
      // surfaced to the client via `devCode`, not via logs.
      logger.debug({ phone }, '[sms:mock] no real SMS sent');
      return;
    }
    // Real provider integration goes here (msg91 / twilio). Until implemented we
    // log a warning rather than silently dropping a "real" send.
    logger.warn({ provider: env.SMS_PROVIDER, phone }, 'SMS provider configured but send() not implemented yet');
  },
};
