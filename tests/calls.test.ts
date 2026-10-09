import { describe, expect, it } from 'vitest';
import { drainJobs } from '../src/jobs/queue.js';
import { mockCalls } from '../src/integrations/calling/mock.provider.js';
import { CallModel } from '../src/modules/calls/call.model.js';
import { CallRecordingModel } from '../src/modules/calls/recording.model.js';
import { sweepExpiredRecordings } from '../src/modules/calls/call.pipeline.js';
import { IntegrationModel } from '../src/modules/integrations/integration.model.js';
import { LeadModel } from '../src/modules/leads/lead.model.js';
import { api, bearer, createLead, createOrgWithAdmin, createUserAs } from './helpers.js';

const iso = (d: Date) => d.toISOString();

async function setup() {
  const { org, token } = await createOrgWithAdmin();
  const counsellor = await createUserAs(token, org._id, 'counsellor');
  const lead = (await createLead(token, { firstName: 'Meera', phone: '9123456780', leadSource: 'meta', campaign: 'UK Sep', assignedCounsellor: counsellor.id })).body.data.lead;
  return { org, token, counsellor, lead };
}

async function connectMock(token: string) {
  await api().patch('/api/v1/auth/me').set(bearer(token)).send({ phone: '9000011111' });
  const res = await api().put('/api/v1/communication/calling').set(bearer(token)).send({ provider: 'mock', config: { region: 'in' }, secrets: { apiKey: 'k-secret', apiToken: 't-secret' } });
  expect(res.status).toBe(200);
  return res.body.data.integration.webhookUrl.replace(/^https?:\/\/[^/]+/, '') as string;
}

describe('Calls: device mode (native dialler)', () => {
  it('starts a call, completes it with outcome + follow-up, and updates the timeline and contact times', async () => {
    const { org, counsellor, lead } = await setup();
    const start = await api().post('/api/v1/calls').set(bearer(counsellor.token)).send({ leadId: lead._id });
    expect(start.status).toBe(201);
    expect(start.body.data).toMatchObject({ mode: 'device', dial: '+919123456780', call: { status: 'initiated', direction: 'outgoing', counsellor: { _id: counsellor.id }, lead: { _id: lead._id } } });
    const callId = start.body.data.call._id;

    const done = await api()
      .post(`/api/v1/calls/${callId}/complete`)
      .set(bearer(counsellor.token))
      .send({ durationSeconds: 512, callOutcome: 'interested', nextAction: 'Send UK shortlist', followUp: { dueAt: iso(new Date(Date.now() + 2 * 86_400_000)), followUpType: 'call' } });
    expect(done.status).toBe(200);
    expect(done.body.data).toMatchObject({ status: 'completed', duration: 512, connected: true, callOutcome: 'interested', nextAction: 'Send UK shortlist' });
    expect(done.body.data.followUpId).toBeTruthy();

    const timeline = await api().get(`/api/v1/leads/${lead._id}/activities`).set(bearer(counsellor.token));
    const callAct = timeline.body.data.find((a: { type: string }) => a.type === 'call_completed');
    expect(callAct).toMatchObject({ title: 'Outgoing call · 08:32', outcome: 'interested', metadata: { callId, nextAction: 'Send UK shortlist' } });
    expect(timeline.body.data.some((a: { type: string }) => a.type === 'followup_created')).toBe(true);

    const l = await LeadModel.findOne({ organizationId: org._id, _id: lead._id }).lean();
    expect(l?.firstContactAt).toBeTruthy();
    expect(l?.lastContactedAt).toBeTruthy();

    // Completing again (e.g. outcome change) does not duplicate the activity.
    await api().patch(`/api/v1/calls/${callId}/outcome`).set(bearer(counsellor.token)).send({ callOutcome: 'meeting_required' });
    const again = await api().get(`/api/v1/leads/${lead._id}/activities?types=call_completed`).set(bearer(counsellor.token));
    expect(again.body.data).toHaveLength(1);
    expect(again.body.data[0].outcome).toBe('meeting_required');
  });

  it('validates outcomes and durations; logs unanswered and after-the-fact calls', async () => {
    const { org, counsellor, lead } = await setup();
    const callId = (await api().post('/api/v1/calls').set(bearer(counsellor.token)).send({ leadId: lead._id })).body.data.call._id;
    expect((await api().post(`/api/v1/calls/${callId}/complete`).set(bearer(counsellor.token)).send({ status: 'completed', durationSeconds: 0 })).status).toBe(422);
    expect((await api().post(`/api/v1/calls/${callId}/complete`).set(bearer(counsellor.token)).send({ durationSeconds: 30, callOutcome: 'telepathy' })).status).toBe(422);

    const missed = await api().post(`/api/v1/calls/${callId}/complete`).set(bearer(counsellor.token)).send({ status: 'no_answer', callOutcome: 'no_response' });
    expect(missed.body.data).toMatchObject({ connected: false, status: 'no_answer' });
    expect((await LeadModel.findOne({ organizationId: org._id, _id: lead._id }).lean())?.firstContactAt).toBeFalsy();

    const logged = await api().post('/api/v1/calls/log').set(bearer(counsellor.token)).send({ leadId: lead._id, startedAt: iso(new Date(Date.now() - 3600_000)), durationSeconds: 95 });
    expect(logged.status).toBe(201);
    expect(logged.body.data).toMatchObject({ source: 'manual_log', connected: true });

    const list = await api().get(`/api/v1/leads/${lead._id}/calls`).set(bearer(counsellor.token));
    expect(list.body.data).toHaveLength(2);
  });

  it('enforces scope, permissions and tenant isolation', async () => {
    const { org, token, counsellor, lead } = await setup();
    const callId = (await api().post('/api/v1/calls').set(bearer(counsellor.token)).send({ leadId: lead._id })).body.data.call._id;
    const other = await createUserAs(token, org._id, 'counsellor');
    expect((await api().get(`/api/v1/calls/${callId}`).set(bearer(other.token))).status).toBe(404);
    expect((await api().post('/api/v1/calls').set(bearer(other.token)).send({ leadId: lead._id })).status).toBe(404);
    expect((await api().get(`/api/v1/calls/${callId}`).set(bearer(token))).status).toBe(200);
    const marketing = await createUserAs(token, org._id, 'marketing');
    expect((await api().post('/api/v1/calls').set(bearer(marketing.token)).send({ leadId: lead._id })).status).toBe(403);
    expect((await api().put('/api/v1/communication/calling').set(bearer(counsellor.token)).send({ provider: 'mock' })).status).toBe(403);
    const outsider = await createOrgWithAdmin('Other');
    expect((await api().get(`/api/v1/calls/${callId}`).set(bearer(outsider.token))).status).toBe(404);
  });
});

describe('Calls: cloud provider + webhooks + recording pipeline', () => {
  it('bridges via the provider, stays idempotent on webhooks and stores the recording securely', async () => {
    const { org, token, lead } = await setup();
    const webhook = await connectMock(token);
    // Secrets are write-only.
    const settings = await api().get('/api/v1/communication/calling').set(bearer(token));
    expect(settings.body.data.integration).toMatchObject({ provider: 'mock', secretsSet: ['apiKey', 'apiToken'] });
    expect(JSON.stringify(settings.body.data)).not.toContain('k-secret');
    expect((await IntegrationModel.findOne({ organizationId: org._id }).select('+secrets').lean())?.secrets).not.toContain('k-secret');

    await api().patch('/api/v1/communication/policy').set(bearer(token)).send({ recordingEnabled: true, consentMode: 'announcement', retentionDays: 30, transcriptionEnabled: true, aiSummaryEnabled: true });
    await IntegrationModel.create({ organizationId: org._id, kind: 'transcription', provider: 'mock', webhookToken: 'tr-token-123456789012345' });
    await IntegrationModel.create({ organizationId: org._id, kind: 'ai', provider: 'mock', webhookToken: 'ai-token-123456789012345' });

    const start = await api().post('/api/v1/calls').set(bearer(token)).send({ leadId: lead._id });
    expect(start.body.data).toMatchObject({ mode: 'cloud', dial: null, consentMessage: 'Calls may be recorded for quality and training purposes.', call: { status: 'ringing', recordingConsent: { status: 'announced' } } });
    expect(mockCalls.at(-1)).toMatchObject({ to: '+919123456780', agentNumber: '+919000011111' });
    const callId = start.body.data.call._id;

    const event = { CallSid: `MOCK-${callId}`, Status: 'completed', Duration: '185', RecordingUrl: 'https://provider.example/rec/1.mp3' };
    expect((await api().post(webhook).set('x-mock-signature', 'bad').send(event)).status).toBe(401);
    expect((await api().post(webhook.replace(/[^/]+$/, 'x'.repeat(32))).send(event)).status).toBe(404);
    const first = await api().post(webhook).send(event);
    expect(first.status).toBe(200);
    expect(first.body.data.results).toEqual(['updated']);
    const dup = await api().post(webhook).send(event);
    expect(dup.body.data.results).toEqual(['duplicate']);
    await drainJobs();

    const call = (await api().get(`/api/v1/calls/${callId}`).set(bearer(token))).body.data;
    expect(call, JSON.stringify(call)).toMatchObject({ status: 'completed', duration: 185, connected: true, hasRecording: true, hasTranscript: true, hasSummary: true });
    expect(JSON.stringify(call)).not.toContain('provider.example');
    const acts = await api().get(`/api/v1/leads/${lead._id}/activities?types=call_completed`).set(bearer(token));
    expect(acts.body.data).toHaveLength(1);

    const rec = await api().get(`/api/v1/calls/${callId}/recording`).set(bearer(token));
    expect(rec.status).toBe(200);
    const file = await api().get(rec.body.data.url.replace(/^https?:\/\/[^/]+/, ''));
    expect(file.status).toBe(200);
    expect(file.headers['cache-control']).toContain('no-store');
    // Tampered link is refused.
    expect((await api().get(rec.body.data.url.replace(/^https?:\/\/[^/]+/, '').replace(/s=[^&]+/, 's=bad'))).status).toBe(403);

    const intel = await api().get(`/api/v1/calls/${callId}/intelligence`).set(bearer(token));
    expect(intel.body.data.summary).toMatchObject({ aiGenerated: true, countryPreference: 'Germany', model: 'mock:mock-1' });
    expect(intel.body.data.transcript.segments).toHaveLength(3);
    const edited = await api().patch(`/api/v1/calls/${callId}/summary`).set(bearer(token)).send({ summary: 'Prefers Germany, MSc DS' });
    expect(edited.body.data.summary).toMatchObject({ editedSummary: 'Prefers Germany, MSc DS', summary: expect.stringContaining('data science') });

    const search = await api().get('/api/v1/calls/transcripts/search?q=budget').set(bearer(token));
    expect(search.body.data[0]).toMatchObject({ lead: { _id: lead._id } });
    expect(search.body.data[0].snippet).toContain('budget');

    const audit = await api().get('/api/v1/audit-logs?entityType=call_recording').set(bearer(token));
    expect(audit.body.data.some((a: { action: string }) => a.action === 'recording.played')).toBe(true);

    // Counsellors may play but not download.
    const counsellor = await createUserAs(token, org._id, 'counsellor');
    await CallModel.updateOne({ organizationId: org._id, _id: callId }, { counsellorId: counsellor.id });
    expect((await api().get(`/api/v1/calls/${callId}/recording?download=true`).set(bearer(counsellor.token))).status).toBe(403);

    // Retention: expired recordings are deleted, transcript kept per policy, audit retained.
    await CallRecordingModel.updateOne({ organizationId: org._id, callId }, { retentionUntil: new Date(Date.now() - 1000) });
    expect(await sweepExpiredRecordings()).toBe(1);
    const after = (await api().get(`/api/v1/calls/${callId}`).set(bearer(token))).body.data;
    expect(after).toMatchObject({ hasRecording: false, hasTranscript: true });
    expect((await api().get(`/api/v1/calls/${callId}/recording`).set(bearer(token))).status).toBe(404);
  });

  it('matches unknown incoming calls to the lead by phone and records missed calls', async () => {
    const { token, lead, counsellor } = await setup();
    const webhook = await connectMock(token);
    const res = await api().post(webhook).send({ CallSid: 'IN-1', Status: 'no_answer', Direction: 'incoming', From: '09123456780' });
    expect(res.body.data.results).toEqual(['created']);
    const calls = await api().get('/api/v1/calls?direction=incoming').set(bearer(counsellor.token));
    expect(calls.body.data[0]).toMatchObject({ direction: 'incoming', status: 'no_answer', lead: { _id: lead._id }, counsellor: { _id: counsellor.id } });
    const acts = await api().get(`/api/v1/leads/${lead._id}/activities?types=call_missed`).set(bearer(token));
    expect(acts.body.data[0].title).toBe('Missed incoming call');
  });
});

describe('Calls: analytics', () => {
  it('reports volume, connect rate, talk time, counsellor comparison, outcomes and response time', async () => {
    const { token, counsellor, lead } = await setup();
    const lead2 = (await createLead(token, { firstName: 'Kabir', phone: '9123456781', leadSource: 'google', assignedCounsellor: counsellor.id })).body.data.lead;
    const log = (leadId: string, durationSeconds: number, status = 'completed', callOutcome?: string) =>
      api().post('/api/v1/calls/log').set(bearer(counsellor.token)).send({ leadId, startedAt: iso(new Date(Date.now() - 60_000)), durationSeconds, status, callOutcome });
    await log(lead._id, 300, 'completed', 'interested');
    await log(lead._id, 0, 'no_answer');
    await log(lead2._id, 60, 'completed', 'call_back');
    await api().patch(`/api/v1/leads/${lead._id}/stage`).set(bearer(token)).send({ stage: 'application' });

    const res = await api().get('/api/v1/calls/analytics?period=this_month').set(bearer(token));
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.totals).toMatchObject({ calls: 3, connected: 2, missed: 1, talkTime: 360, avgDuration: 180, uniqueLeads: 2, connectRate: 66.7, interestedLeads: 1, applications: 1 });
    expect(d.byCounsellor[0]).toMatchObject({ key: counsellor.id, calls: 3, applications: 1, callsPerApplication: 3 });
    expect(d.byOutcome.find((o: { key: string }) => o.key === 'interested').calls).toBe(1);
    expect(d.bySource.map((s: { key: string }) => s.key).sort()).toEqual(['google', 'meta']);
    expect(d.durationConversion.find((b: { key: string }) => b.key === '5to10')).toMatchObject({ leads: 1, applications: 1, applicationRate: 100 });
    expect(d.firstResponse).toMatchObject({ leadsCreated: 2, contacted: 2, notContacted: 0 });
    expect(d.funnel.map((f: { value: number }) => f.value)).toEqual([3, 2, 2, 1, 1, 1, 0]);

    const mine = await api().get('/api/v1/calls/analytics?period=this_month').set(bearer(counsellor.token));
    expect(mine.body.data.totals.calls).toBe(3);
  });
});

describe('Devices', () => {
  it('registers a mobile device, lists team devices and signs one out immediately', async () => {
    const { org, token, counsellor } = await setup();
    const reg = await api().post('/api/v1/devices/register').set(bearer(counsellor.token)).send({ deviceId: 'pixel-8-abc', platform: 'android', appVersion: '1.0.0', osVersion: '15', pushToken: 'fcm-token-1' });
    expect(reg.status).toBe(200);
    const list = await api().get('/api/v1/devices?platform=android').set(bearer(token));
    expect(list.body.data[0]).toMatchObject({ deviceId: 'pixel-8-abc', appVersion: '1.0.0', pushEnabled: true, user: { _id: counsellor.id } });
    expect(JSON.stringify(list.body.data)).not.toContain('fcm-token-1');
    expect((await api().get('/api/v1/devices').set(bearer(counsellor.token))).status).toBe(403);

    expect((await api().get('/api/v1/auth/me').set(bearer(counsellor.token))).status).toBe(200);
    expect((await api().delete(`/api/v1/devices/${list.body.data[0]._id}`).set(bearer(token))).status).toBe(200);
    // The access token stops working right away, not after it expires.
    expect((await api().get('/api/v1/auth/me').set(bearer(counsellor.token))).status).toBe(401);
    void org;
  });
});
