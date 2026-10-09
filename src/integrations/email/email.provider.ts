export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** Provider-agnostic email interface; swap SMTP for SES/SendGrid/etc. without touching callers. */
export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<void>;
}
