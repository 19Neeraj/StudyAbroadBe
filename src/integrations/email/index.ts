import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import type { EmailMessage, EmailProvider } from './email.provider.js';
import { ConsoleEmailProvider, MemoryEmailProvider, SmtpEmailProvider } from './providers.js';

function createProvider(): EmailProvider {
  switch (env.EMAIL_PROVIDER) {
    case 'smtp':
      return new SmtpEmailProvider();
    case 'memory':
      return new MemoryEmailProvider();
    default:
      return new ConsoleEmailProvider();
  }
}

export const emailProvider: EmailProvider = createProvider();

/** Sends without failing the caller; email delivery moves to a BullMQ queue with retries in Phase 4. */
export async function sendEmailSafe(message: EmailMessage): Promise<boolean> {
  try {
    await emailProvider.send(message);
    return true;
  } catch (err) {
    logger.error({ err, to: message.to, subject: message.subject }, 'Email delivery failed');
    return false;
  }
}

export type { EmailMessage, EmailProvider };
