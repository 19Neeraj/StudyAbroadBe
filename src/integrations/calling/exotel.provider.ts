import type { CallEvent, CallingProvider, CallStatus, ProviderCredentials } from './calling.provider.js';

/**
 * Exotel (India) click-to-call: "Connect two numbers" — Exotel rings the counsellor (From), then
 * bridges the student (To) from the organization's ExoPhone (CallerId). Status callbacks carry
 * CallSid, Status, durations and RecordingUrl. Exotel does not sign callbacks, so the callback URL
 * carries a per-organization secret token (verified by the webhook route) and, optionally, an IP allow-list.
 *
 * config:  { subdomain: "api.exotel.com" | "api.in.exotel.com", accountSid, callerId }
 * secrets: { apiKey, apiToken }
 * Not yet verified against a live Exotel account — run the provider checklist in docs before go-live.
 */
const STATUS: Record<string, CallStatus> = {
  queued: 'initiated',
  'in-progress': 'answered',
  ringing: 'ringing',
  completed: 'completed',
  busy: 'busy',
  failed: 'failed',
  'no-answer': 'no_answer',
  canceled: 'missed',
};

function auth(creds: ProviderCredentials) {
  const { apiKey, apiToken } = creds.secrets;
  if (!apiKey || !apiToken) throw new Error('Exotel API key/token are not configured');
  return `Basic ${Buffer.from(`${apiKey}:${apiToken}`).toString('base64')}`;
}

function base(creds: ProviderCredentials) {
  const { subdomain = 'api.exotel.com', accountSid } = creds.config as { subdomain?: string; accountSid?: string };
  if (!accountSid) throw new Error('Exotel account SID is not configured');
  return `https://${subdomain}/v1/Accounts/${encodeURIComponent(accountSid)}`;
}

export const exotelProvider: CallingProvider = {
  name: 'exotel',
  family: 'cloud',

  async makeCall(input, creds) {
    const { callerId } = creds.config as { callerId?: string };
    if (!callerId) throw new Error('Exotel caller id (ExoPhone) is not configured');
    const form = new URLSearchParams({
      From: input.agentNumber,
      To: input.to,
      CallerId: callerId,
      Record: input.record ? 'true' : 'false',
      StatusCallback: input.statusCallbackUrl,
      'StatusCallbackEvents[0]': 'terminal',
      StatusCallbackContentType: 'application/json',
      CustomField: input.callId,
    });
    const res = await fetch(`${base(creds)}/Calls/connect.json`, {
      method: 'POST',
      headers: { Authorization: auth(creds), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({}))) as { Call?: { Sid?: string; Status?: string }; RestException?: { Message?: string } };
    if (!res.ok || !json.Call?.Sid) throw new Error(json.RestException?.Message ?? `Exotel error ${res.status}`);
    return { providerCallId: json.Call.Sid, status: STATUS[json.Call.Status ?? 'queued'] ?? 'initiated' };
  },

  async getRecording(recordingUrl, creds) {
    const res = await fetch(recordingUrl, { headers: { Authorization: auth(creds) }, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`Recording download failed (${res.status})`);
    return { body: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') ?? 'audio/mpeg' };
  },

  parseWebhook(req) {
    const b = { ...(req.query as Record<string, unknown>), ...(req.body as Record<string, unknown>) } as Record<string, string | undefined>;
    const sid = b.CallSid;
    if (!sid) return [];
    const status = STATUS[(b.Status ?? b.CallStatus ?? '').toLowerCase()] ?? 'completed';
    const direction = (b.Direction ?? '').startsWith('inbound') || b.Direction === 'incoming' ? 'incoming' : 'outgoing';
    const event: CallEvent = { eventKey: `${sid}:${status}`, providerCallId: sid, direction, status, raw: b };
    if (b.CustomField) event.callId = b.CustomField;
    if (b.From) event.from = b.From;
    if (b.To) event.to = b.To;
    if (b.StartTime) event.startedAt = new Date(b.StartTime.replace(' ', 'T') + '+05:30');
    if (b.EndTime) event.endedAt = new Date(b.EndTime.replace(' ', 'T') + '+05:30');
    const talk = b.ConversationDuration ?? b.DialCallDuration ?? b.Duration;
    if (talk) event.durationSeconds = Number(talk);
    if (b.RecordingUrl) event.recordingUrl = b.RecordingUrl;
    return [event];
  },
};
