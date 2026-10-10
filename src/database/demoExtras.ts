import { randomBytes } from 'node:crypto';
import type { Types } from 'mongoose';
import { generateSecret } from 'otplib';
import { storage } from '../integrations/storage/index.js';
import { drainJobs } from '../jobs/queue.js';
import { registerJobs } from '../jobs/index.js';
import { AiSummaryModel } from '../modules/calls/aiSummary.model.js';
import { CallModel } from '../modules/calls/call.model.js';
import { CallRecordingModel } from '../modules/calls/recording.model.js';
import { TranscriptModel } from '../modules/calls/transcript.model.js';
import { CommunicationPolicyModel } from '../modules/integrations/communicationPolicy.model.js';
import { LeadModel } from '../modules/leads/lead.model.js';
import { integrationActor } from '../modules/marketing/actor.js';
import { requestExport as requestMarketingExport } from '../modules/marketing/export.service.js';
import { ExternalLeadReferenceModel } from '../modules/marketing/externalLeadReference.model.js';
import { IntegrationFieldMappingModel } from '../modules/marketing/fieldMapping.model.js';
import { WebsiteKeyModel } from '../modules/marketing/websiteKey.model.js';
import { NotificationModel, NotificationPreferenceModel } from '../modules/notifications/notification.model.js';
import { SessionModel } from '../modules/auth/session.model.js';
import { requestExport as requestReportExport } from '../modules/reports/report.service.js';
import { PlatformSettingModel } from '../modules/security/platformSetting.model.js';
import { TwoFactorChallengeModel } from '../modules/security/twoFactorChallenge.model.js';
import { UserModel } from '../modules/users/user.model.js';
import { WebhookEventModel } from '../modules/webhooks/webhookEvent.model.js';
import { encryptSecret, hashToken, randomToken } from '../utils/crypto.js';

const DAY = 86_400_000;

/** One second of 8 kHz mono 16-bit silence: a real, playable WAV for demo recordings. */
function silentWav(seconds = 1): Buffer {
  const rate = 8000;
  const data = rate * 2 * seconds;
  const b = Buffer.alloc(44 + data);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + data, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(data, 40);
  return b;
}

const COUNTRY: Record<string, string> = { uk: 'United Kingdom', canada: 'Canada', australia: 'Australia', usa: 'USA', ireland: 'Ireland', germany: 'Germany' };

/**
 * The rest of the demo: call recordings with transcripts and AI summaries, communication policy,
 * Meta lead-form references and webhook deliveries, field mapping, website API keys, notification
 * preferences, finished report exports (real files, built by the real export jobs), the platform
 * security settings and one user with 2FA turned on. Everything is synthetic and references real
 * demo records. Secrets/keys generated here are discarded (nobody can use them).
 */
export async function seedDemoExtras(organizationId: Types.ObjectId, adminId: Types.ObjectId) {
  const now = Date.now();

  // --- calling: policy, recordings → transcripts → AI summaries on longer connected calls
  await CommunicationPolicyModel.updateOne(
    { organizationId },
    { $setOnInsert: { organizationId, recordingEnabled: true, consentMode: 'announcement', retentionDays: 180, transcriptionEnabled: true, aiSummaryEnabled: true, transcriptionLanguages: ['en-IN', 'hi-IN'], updatedBy: adminId } },
    { upsert: true },
  );
  const calls = await CallModel.find({ organizationId, status: 'completed', duration: { $gte: 240 } }).sort({ startedAt: -1 }).limit(10).lean();
  const wav = silentWav();
  for (const call of calls) {
    const lead = call.leadId ? await LeadModel.findOne({ organizationId, _id: call.leadId }).select('firstName countryInterested courseInterested budget intake').lean() : null;
    const country = COUNTRY[lead?.countryInterested ?? ''] ?? 'the UK';
    const course = (lead?.courseInterested ?? 'masters').replace(/_/g, ' ');
    const name = lead?.firstName ?? 'there';
    const key = `${organizationId.toString()}/calls/${call._id.toString()}/recording.wav`;
    const stored = await storage.putObject({ key, body: wav, contentType: 'audio/wav' });
    const rec = await CallRecordingModel.create({
      organizationId, callId: call._id, provider: 'mock', externalRecordingId: `demo-rec-${call._id.toString().slice(-6)}`, fileKey: key, mimeType: 'audio/wav', fileSize: stored.size,
      duration: call.duration, consentStatus: 'not_required', status: 'stored', retentionUntil: new Date(now + 180 * DAY),
    });
    const lines: [string, string][] = [
      ['counsellor', `Hi ${name}, this is your counsellor from Demo Overseas Education. Is this a good time to talk?`],
      ['student', 'Yes, I filled the form for studying abroad.'],
      ['counsellor', `Great. You were interested in ${course} in ${country}. Which intake are you aiming for?`],
      ['student', 'September next year if possible. My budget is around 25 to 30 lakh including living costs.'],
      ['counsellor', 'That works for several universities. Have you taken IELTS yet?'],
      ['student', 'Not yet, I am planning to book it next month. I am a little worried about the visa process.'],
      ['counsellor', 'We will guide you through it. I will share a shortlist and we can book a meeting on Saturday.'],
    ];
    const segments = lines.map(([speaker, text], i) => ({ speaker, startTime: i * 12, endTime: i * 12 + 11, text }));
    const transcript = await TranscriptModel.create({
      organizationId, callId: call._id, leadId: call.leadId, counsellorId: call.counsellorId, branchId: call.branchId, provider: 'mock', language: 'en-IN', status: 'completed',
      segments, fullText: segments.map((s) => `${s.speaker}: ${s.text}`).join('\n'), duration: call.duration,
    });
    const summary = await AiSummaryModel.create({
      organizationId, callId: call._id, transcriptId: transcript._id, leadId: call.leadId,
      summary: `${name} wants to study ${course} in ${country} for the September intake, budget about 25–30 lakh. IELTS not taken yet; concerned about the visa process.`,
      studentRequirements: `${course} in ${country}`, countryPreference: country, coursePreference: course, budget: '25–30 lakh', intake: 'September',
      concerns: ['Visa process'], objections: [], nextAction: 'Share a university shortlist and book a Saturday meeting', recommendedFollowUp: 'Meeting in 3 days',
      sentiment: 'positive', intent: ['application', 'meeting'], model: 'mock-summary-v1',
    });
    await CallModel.updateOne({ organizationId, _id: call._id }, { recordingId: rec._id, transcriptId: transcript._id, summaryId: summary._id });
  }

  // --- Meta lead forms: field mapping, imported-lead references, webhook deliveries
  await IntegrationFieldMappingModel.create([
    { organizationId, provider: 'mock', formExternalId: null, rules: [{ externalField: 'full_name', crmField: 'fullName' }, { externalField: 'phone_number', crmField: 'phone' }, { externalField: 'email', crmField: 'email' }, { externalField: 'city', crmField: 'city' }], updatedBy: adminId },
    { organizationId, provider: 'mock', formExternalId: 'form-demo-1', rules: [{ externalField: 'which_country_do_you_want_to_study_in', crmField: 'countryInterested' }, { externalField: 'preferred_intake', crmField: 'intake' }, { externalField: 'highest_qualification', crmField: 'educationDetails' }], updatedBy: adminId },
  ]);
  const metaLeads = await LeadModel.find({ organizationId, 'firstTouch.provider': 'mock' }).select('fullName phone email city countryInterested createdAt firstTouch').sort({ createdAt: -1 }).limit(25).lean();
  const refs = metaLeads.map((l, i) => ({
    organizationId, provider: 'mock', externalLeadId: `demo-fb-lead-${1000 + i}`, formExternalId: 'form-demo-1', adExternalId: l.firstTouch?.adExternalId, adsetExternalId: l.firstTouch?.adsetExternalId,
    campaignExternalId: l.firstTouch?.campaignExternalId, pageExternalId: 'page-demo-1', submittedAt: l.createdAt, status: 'created', leadId: l._id, attempts: 1, receivedVia: i % 3 === 0 ? 'poll' : 'webhook',
    answers: { full_name: l.fullName, phone_number: l.phone, email: l.email, city: l.city ?? 'New Delhi', which_country_do_you_want_to_study_in: COUNTRY[l.countryInterested ?? ''] ?? 'UK', preferred_intake: 'September' },
    processedAt: new Date(l.createdAt.getTime() + 60_000), createdAt: l.createdAt, updatedAt: l.createdAt,
  }));
  // Two that failed validation stay visible for retry (nothing is dropped).
  refs.push(
    { organizationId, provider: 'mock', externalLeadId: 'demo-fb-lead-0901', formExternalId: 'form-demo-1', campaignExternalId: 'c-100', submittedAt: new Date(now - 2 * DAY), status: 'failed', attempts: 3, receivedVia: 'webhook', answers: { full_name: 'Test Entry', phone_number: '123' }, lastError: 'Cannot import: phone: Invalid phone number', createdAt: new Date(now - 2 * DAY), updatedAt: new Date(now - 2 * DAY) } as never,
    { organizationId, provider: 'mock', externalLeadId: 'demo-fb-lead-0902', formExternalId: 'form-demo-1', campaignExternalId: 'c-200', submittedAt: new Date(now - DAY), status: 'failed', attempts: 1, receivedVia: 'poll', answers: { full_name: 'No Contact' }, lastError: 'Cannot import: phone: Provide a phone number, WhatsApp number or email', createdAt: new Date(now - DAY), updatedAt: new Date(now - DAY) } as never,
  );
  await ExternalLeadReferenceModel.collection.insertMany(refs);
  await WebhookEventModel.collection.insertMany(
    refs.filter((r) => r.receivedVia === 'webhook').map((r) => ({
      organizationId, kind: 'meta_ads', provider: 'mock', eventKey: `leadgen:${r.externalLeadId}`, status: r.status === 'failed' ? 'failed' : 'processed', attempts: r.attempts,
      error: r.status === 'failed' ? (r as { lastError?: string }).lastError : undefined, payload: { leadgen_id: r.externalLeadId, form_id: r.formExternalId, page_id: 'page-demo-1' },
      processedAt: r.createdAt, createdAt: r.createdAt, updatedAt: r.createdAt,
    })),
  );

  // --- website lead API keys (plain keys are discarded, as in production)
  const [counsellor] = await UserModel.find({ organizationId, email: 'simran@demo.local' }).select('_id branchIds').lean();
  await WebsiteKeyModel.create([
    { organizationId, name: 'Main website contact form', keyHash: hashToken(randomToken(24)), prefix: `crm_live_${randomToken(4).slice(0, 5)}`, leadSource: 'website', defaultCounsellorId: counsellor?._id, defaultBranchId: counsellor?.branchIds[0], lastUsedAt: new Date(now - 3 * 3600_000), submissions: 42, createdBy: adminId },
    { organizationId, name: 'Old landing page (2025)', keyHash: hashToken(randomToken(24)), prefix: `crm_live_${randomToken(4).slice(0, 5)}`, leadSource: 'website', submissions: 118, lastUsedAt: new Date(now - 200 * DAY), revokedAt: new Date(now - 180 * DAY), createdBy: adminId },
  ]);
  const websiteLeads = await LeadModel.find({ organizationId, leadSource: 'website' }).select('createdAt').limit(10).lean();
  await WebhookEventModel.collection.insertMany(
    websiteLeads.map((l, i) => ({ organizationId, kind: 'website', provider: 'website', eventKey: `demo-website-${i}`, status: 'processed', attempts: 1, payload: { leadId: l._id.toString(), outcome: 'created' }, processedAt: l.createdAt, createdAt: l.createdAt, updatedAt: l.createdAt })),
  );

  // --- notification preferences for a few people
  const people = await UserModel.find({ organizationId }).select('_id email').lean();
  await NotificationPreferenceModel.create(
    people.slice(0, 3).map((u, i) => ({
      organizationId, userId: u._id,
      channels: i === 0 ? { application_update: { push: true, email: true }, team_message: { push: true, email: false } } : i === 1 ? { lead_reinquiry: { push: true, email: true } } : { followup_due: { push: false, email: false } },
    })),
  );

  // --- signed-in devices (Devices page). Refresh-token hashes are random, so these sessions can't be used.
  const devices = ['Pixel 8', 'iPhone 15', 'Galaxy S24', 'OnePlus 12', 'iPhone 13', 'Redmi Note 13', 'Galaxy A55', 'iPad Air'];
  await SessionModel.insertMany(
    people.map((u, i) => {
      const mobile = u.email !== 'admin@demo.local';
      return {
        userId: u._id, organizationId, refreshTokenHash: hashToken(randomToken()), platform: mobile ? (i % 2 ? 'ios' : 'android') : 'web',
        deviceName: mobile ? devices[i % devices.length] : 'Chrome on macOS', deviceId: mobile ? `demo-device-${i}` : undefined, appVersion: mobile ? '1.0.0' : undefined,
        lastUsedAt: new Date(now - (i + 1) * 3 * 3600_000), expiresAt: new Date(now + 25 * DAY),
        ...(i === people.length - 1 ? { revokedAt: new Date(now - DAY), revokedReason: 'revoked_by_admin' } : {}),
      };
    }),
  );

  // --- a few more notifications (assignments and due follow-ups)
  const recent = await LeadModel.find({ organizationId, assignedCounsellor: { $ne: null } }).select('fullName leadNumber assignedCounsellor createdAt').sort({ createdAt: -1 }).limit(12).lean();
  await NotificationModel.insertMany(
    recent.map((l, i) => ({
      organizationId, userId: l.assignedCounsellor, type: i % 3 === 2 ? 'followup_due' : 'lead_assigned',
      title: i % 3 === 2 ? `Follow-up due: ${l.fullName}` : `New lead assigned: ${l.fullName} (#${l.leadNumber})`,
      body: i % 3 === 2 ? 'Call scheduled for today.' : 'You are the counsellor for this lead.', data: { leadId: l._id.toString() },
      readAt: i % 2 ? new Date(l.createdAt.getTime() + 3600_000) : null, push: { status: 'sent', at: l.createdAt }, createdAt: l.createdAt, updatedAt: l.createdAt,
    })),
  );

  // --- platform security defaults (platform-wide; only created when missing)
  await PlatformSettingModel.updateOne({ _id: 'security' }, { $setOnInsert: { twoFactor: { enabled: true, mode: 'optional', allowOrganizationOverride: true, gracePeriodDays: 7 } } }, { upsert: true });

  // --- one counsellor with 2FA on (not a demo persona), and the challenge from their last sign-in
  const rahul = await UserModel.findOne({ organizationId, email: 'rahul@demo.local' }).select('_id').lean();
  if (rahul) {
    const codes = Array.from({ length: 10 }, () => randomBytes(5).toString('hex').toUpperCase());
    await UserModel.updateOne(
      { organizationId, _id: rahul._id },
      {
        $set: {
          'twoFactor.enabled': true, 'twoFactor.enabledAt': new Date(now - 20 * DAY), 'twoFactor.secretEnc': encryptSecret(`${rahul._id.toString()}:${generateSecret()}`),
          'twoFactor.recoveryCodes': codes.map((c, i) => ({ hash: hashToken(c), usedAt: i === 0 ? new Date(now - 5 * DAY) : null })), 'twoFactor.recoveryCodesGeneratedAt': new Date(now - 20 * DAY),
        },
      },
    );
    // Already used, so inert; MongoDB removes it after its expiry (TTL).
    await TwoFactorChallengeModel.create({ tokenHash: hashToken(randomToken(32)), userId: rahul._id, organizationId, purpose: 'verify', platform: 'android', deviceName: 'Pixel 8', attempts: 1, usedAt: new Date(), expiresAt: new Date(now + DAY) });
  }

  // --- finished exports, built by the real export jobs from the demo data
  registerJobs();
  const actor = await integrationActor(organizationId, adminId);
  await requestReportExport(actor, { report: 'leads', format: 'xlsx', params: { includeClosed: 'true' } });
  await requestReportExport(actor, { report: 'followups', format: 'csv', params: {} });
  await requestMarketingExport(actor, { report: 'campaigns', format: 'xlsx', params: { from: new Date(now - 90 * DAY).toISOString().slice(0, 10), to: new Date(now).toISOString().slice(0, 10) } });
  await drainJobs();

  return { recordings: calls.length, externalLeads: refs.length };
}

