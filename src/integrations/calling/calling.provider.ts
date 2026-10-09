import type { Request } from 'express';

/**
 * Calling provider abstraction (spec §8–10). CRM business logic depends only on this interface,
 * so Exotel, Twilio, FreJun or others plug in without touching leads/calls code.
 *
 * Two families:
 *  - "device": the counsellor's phone dials natively (tel: link); the app reports the result.
 *    Works everywhere but carries no recording and relies on the user for duration/status.
 *  - "cloud": the provider bridges counsellor ↔ student, so status, duration and (where enabled
 *    and lawful) recordings arrive by webhook on both Android and iOS.
 */
export type CallStatus = 'initiated' | 'ringing' | 'answered' | 'completed' | 'missed' | 'rejected' | 'failed' | 'busy' | 'no_answer';
export type CallDirection = 'outgoing' | 'incoming';

export interface MakeCallInput {
  /** CRM call id; providers echo it back (custom field) so webhooks can be matched. */
  callId: string;
  to: string;
  /** Counsellor's phone (bridged first). */
  agentNumber: string;
  statusCallbackUrl: string;
  record: boolean;
}

export interface MakeCallResult {
  providerCallId: string;
  status: CallStatus;
}

/** Provider event normalized for the CRM. */
export interface CallEvent {
  /** Stable per event, for idempotency (e.g. CallSid + status). */
  eventKey: string;
  providerCallId: string;
  callId?: string;
  direction: CallDirection;
  status: CallStatus;
  from?: string;
  to?: string;
  startedAt?: Date;
  answeredAt?: Date;
  endedAt?: Date;
  durationSeconds?: number;
  recordingUrl?: string;
  raw: Record<string, unknown>;
}

export interface ProviderCredentials {
  config: Record<string, unknown>;
  secrets: Record<string, string>;
}

export interface CallingProvider {
  readonly name: string;
  readonly family: 'device' | 'cloud';
  makeCall(input: MakeCallInput, creds: ProviderCredentials): Promise<MakeCallResult>;
  getCallStatus?(providerCallId: string, creds: ProviderCredentials): Promise<Partial<CallEvent>>;
  /** Downloads the recording (provider URLs usually need the account credentials). */
  getRecording?(recordingUrl: string, creds: ProviderCredentials): Promise<{ body: Buffer; contentType: string }>;
  /** Validates authenticity (signature, token, IP rules) — throws on failure. */
  verifyWebhook?(req: Request, creds: ProviderCredentials): void;
  /** Parses a webhook request into zero or more normalized events. */
  parseWebhook(req: Request): CallEvent[];
}
