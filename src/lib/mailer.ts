import { logger } from './logger.js';

export interface MailerMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface Mailer {
  send(message: MailerMessage): Promise<void>;
}

class ConsoleMailer implements Mailer {
  async send(message: MailerMessage): Promise<void> {
    logger.info({ mail: message }, '[mailer:stub] would send email');
  }
}

export const mailer: Mailer = new ConsoleMailer();
