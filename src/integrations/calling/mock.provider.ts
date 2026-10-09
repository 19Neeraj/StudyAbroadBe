import type { CallEvent, CallingProvider } from './calling.provider.js';

/**
 * Deterministic cloud provider for tests and demos. Webhook body:
 *   { CallSid, Status, CustomField?, Direction?, From?, To?, Duration?, RecordingUrl? }
 * Recordings are served as a small fake audio buffer.
 */
export const mockCalls: { to: string; agentNumber: string; callId: string }[] = [];

export const mockProvider: CallingProvider = {
  name: 'mock',
  family: 'cloud',
  async makeCall(input) {
    mockCalls.push({ to: input.to, agentNumber: input.agentNumber, callId: input.callId });
    return { providerCallId: `MOCK-${input.callId}`, status: 'ringing' };
  },
  async getRecording() {
    return { body: Buffer.from('ID3-mock-audio'), contentType: 'audio/mpeg' };
  },
  verifyWebhook(req) {
    if (req.headers['x-mock-signature'] === 'bad') throw new Error('Bad signature');
  },
  parseWebhook(req) {
    const b = req.body as Record<string, string | undefined>;
    if (!b.CallSid || !b.Status) return [];
    const event: CallEvent = {
      eventKey: `${b.CallSid}:${b.Status}`,
      providerCallId: b.CallSid,
      direction: b.Direction === 'incoming' ? 'incoming' : 'outgoing',
      status: b.Status as CallEvent['status'],
      raw: b,
    };
    if (b.CustomField) event.callId = b.CustomField;
    if (b.From) event.from = b.From;
    if (b.To) event.to = b.To;
    if (b.Duration) event.durationSeconds = Number(b.Duration);
    if (b.RecordingUrl) event.recordingUrl = b.RecordingUrl;
    if (b.StartTime) event.startedAt = new Date(b.StartTime);
    if (b.EndTime) event.endedAt = new Date(b.EndTime);
    return [event];
  },
};
