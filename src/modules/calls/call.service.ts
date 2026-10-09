import { Types } from 'mongoose';
import type { z } from '../../docs/zod.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { hasPermissions } from '../../middlewares/auth.middleware.js';
import { storage } from '../../integrations/storage/index.js';
import type { CallEvent } from '../../integrations/calling/index.js';
import { enqueue } from '../../jobs/queue.js';
import { emitTo, rooms } from '../../sockets/index.js';
import type { AuthContext, ServiceContext } from '../../types/auth.js';
import { hasOrgScope } from '../../utils/access.js';
import { ApiError } from '../../utils/ApiError.js';
import { buildPagination, toPaging, toSort } from '../../utils/pagination.js';
import { ActivityModel } from '../activities/activity.model.js';
import { logActivity } from '../activities/activity.service.js';
import { recordAudit } from '../audit/audit.service.js';
import { createFollowUp } from '../followups/followup.service.js';
import { getCommunicationPolicy } from '../integrations/communicationPolicy.model.js';
import { activeCalling, markIntegrationEvent } from '../integrations/integration.service.js';
import { loadLead } from '../leads/lead.access.js';
import { markContacted } from '../leads/lead.contact.js';
import { LeadModel } from '../leads/lead.model.js';
import { getOrgSettings } from '../organizations/orgSettings.js';
import { assertLookupValues } from '../settings/lookup.service.js';
import { UserModel } from '../users/user.model.js';
import { normalizePhone } from '../../utils/normalize.js';
import { AiSummaryModel } from './aiSummary.model.js';
import { CallModel, TERMINAL_CALL_STATUSES, type Call } from './call.model.js';
import { CallRecordingModel } from './recording.model.js';
import { TranscriptModel } from './transcript.model.js';
import type { CallListQuery, completeCallBody, editSummaryBody, initiateCallBody, logCallBody, outcomeBody } from './call.validation.js';

type Filter = Record<string, unknown>;
type CallDoc = InstanceType<typeof CallModel>;
/** Who an automated action is attributed to (the counsellor on the call). */
type Actor = Pick<ServiceContext, 'organizationId' | 'userId' | 'meta'>;

const isTerminal = (s: string) => (TERMINAL_CALL_STATUSES as readonly string[]).includes(s);
export const isConnected = (c: { status: string; duration?: number | null }) => c.status === 'answered' || (c.status === 'completed' && (c.duration ?? 0) > 0);

/** organization → all calls; branch → my branches or mine; own → calls I made/received. */
export function callScopeFilter(ctx: AuthContext): Filter {
  const base: Filter = { organizationId: ctx.organizationId };
  if (hasOrgScope(ctx)) return base;
  if (ctx.dataScope === 'branch') return { ...base, $or: [{ branchId: { $in: ctx.branchIds } }, { counsellorId: ctx.userId }] };
  return { ...base, counsellorId: ctx.userId };
}

async function loadCall(ctx: ServiceContext, id: string, select = '') {
  if (!Types.ObjectId.isValid(id)) throw ApiError.notFound('Call');
  const call = await CallModel.findOne({ ...callScopeFilter(ctx), _id: new Types.ObjectId(id) }).select(select);
  if (!call) throw ApiError.notFound('Call');
  return call;
}

function consentStatusFor(mode: string): 'not_required' | 'announced' | 'unknown' {
  return mode === 'none' ? 'not_required' : mode === 'announcement' ? 'announced' : 'unknown';
}

const fmtDuration = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

function emitCall(event: string, call: Pick<Call, '_id' | 'organizationId' | 'counsellorId' | 'leadId' | 'status'>) {
  if (!call.counsellorId) return;
  emitTo([rooms.user(call.counsellorId.toString())], event, { callId: call._id.toString(), leadId: call.leadId?.toString() ?? null, status: call.status });
}

function leadSnapshot(lead: { _id: Types.ObjectId; studentId?: Types.ObjectId | null; branchId?: Types.ObjectId | null; leadSource?: string | null; campaign?: string | null; countryInterested?: string | null; courseInterested?: string | null }) {
  return {
    leadId: lead._id,
    studentId: lead.studentId ?? undefined,
    branchId: lead.branchId ?? undefined,
    leadSource: lead.leadSource ?? undefined,
    campaign: lead.campaign ?? undefined,
    countryInterested: lead.countryInterested ?? undefined,
    courseInterested: lead.courseInterested ?? undefined,
  };
}

// ── Click-to-call ────────────────────────────────────────────────────────

/**
 * CRM call button (spec §9). Creates the call session linked to lead, student and counsellor, then
 * either asks the provider to bridge the call (cloud) or tells the app which number to dial (device).
 */
export async function initiateCall(ctx: ServiceContext, input: z.infer<typeof initiateCallBody>) {
  const lead = await loadLead(ctx, input.leadId);
  const number = (input.numberType === 'whatsapp' ? lead.whatsappNumber : lead.phone) ?? lead.phone ?? lead.whatsappNumber;
  if (!number) throw ApiError.badRequest('This lead has no phone number');
  const [{ provider, integration, creds }, policy] = await Promise.all([activeCalling(ctx.organizationId), getCommunicationPolicy(ctx.organizationId)]);

  const call = await CallModel.create({
    organizationId: ctx.organizationId,
    provider: provider.name,
    source: provider.family === 'device' ? 'device' : 'click_to_call',
    ...leadSnapshot(lead),
    counsellorId: ctx.userId,
    direction: 'outgoing',
    status: 'initiated',
    phoneNumber: number,
    startedAt: new Date(),
    recordingConsent: { status: provider.family === 'device' ? 'not_required' : consentStatusFor(policy.consentMode), method: policy.consentMode },
    createdBy: ctx.userId,
  });

  if (provider.family === 'cloud' && integration) {
    const me = await UserModel.findOne({ organizationId: ctx.organizationId, _id: ctx.userId }).select('phone').lean();
    const { defaultCountryCode } = await getOrgSettings(ctx.organizationId);
    const agentNumber = me?.phone ? normalizePhone(me.phone, defaultCountryCode) : null;
    if (!agentNumber) {
      call.status = 'failed';
      await call.save();
      throw ApiError.badRequest('Add your phone number to your profile to place calls through the calling provider');
    }
    try {
      const result = await provider.makeCall(
        {
          callId: call._id.toString(),
          to: number,
          agentNumber,
          record: policy.recordingEnabled,
          statusCallbackUrl: `${env.API_PUBLIC_URL}/api/v1/webhooks/calling/${provider.name}/${integration.webhookToken}`,
        },
        creds,
      );
      call.providerCallId = result.providerCallId;
      call.status = result.status;
      await call.save();
    } catch (err) {
      call.status = 'failed';
      await call.save();
      await markIntegrationEvent(ctx.organizationId, 'calling', (err as Error).message);
      logger.warn({ err, provider: provider.name }, 'Calling provider rejected the call');
      throw new ApiError(502, 'The calling provider could not place this call. Please try again or dial manually.', [], 'PROVIDER_ERROR');
    }
  }
  emitCall('call.started', call);
  return {
    call: await getCall(ctx, call._id.toString()),
    mode: provider.family,
    dial: provider.family === 'device' ? number : null,
    consentMessage: provider.family === 'cloud' && policy.recordingEnabled && policy.consentMode !== 'none' ? policy.consentMessage : null,
  };
}

// ── Completion, outcome and the timeline ─────────────────────────────────

/**
 * Timeline + contact side effects of a finished call (spec §13). Idempotent: re-running (a late
 * webhook with the final duration) updates the existing activity instead of adding another.
 */
export async function finalizeCall(actor: Actor, call: CallDoc): Promise<void> {
  if (!isTerminal(call.status) || !call.leadId) return;
  const connected = isConnected(call);
  const label = call.direction === 'incoming' ? 'Incoming call' : 'Outgoing call';
  const title = connected ? `${label} · ${fmtDuration(call.duration)}` : call.direction === 'incoming' ? 'Missed incoming call' : `Call not connected (${call.status.replace('_', ' ')})`;
  const fields = {
    type: connected ? ('call_completed' as const) : ('call_missed' as const),
    title,
    newValue: { duration: call.duration, status: call.status, direction: call.direction },
    metadata: { callId: call._id.toString(), provider: call.provider },
    occurredAt: call.startedAt,
  };
  if (call.activityId) {
    await ActivityModel.updateOne({ organizationId: call.organizationId, _id: call.activityId }, fields);
  } else {
    const activity = await logActivity({ organizationId: call.organizationId, userId: call.counsellorId ?? actor.userId }, { leadId: call.leadId, studentId: call.studentId ?? undefined, ...fields });
    call.activityId = activity._id;
  }
  const firstTime = !call.finalizedAt;
  call.finalizedAt ??= new Date();
  await call.save();
  if (connected) await markContacted(call.organizationId, call.leadId, call.answeredAt ?? call.startedAt);
  else await LeadModel.updateOne({ organizationId: call.organizationId, _id: call.leadId }, { lastActivityAt: new Date() });
  if (firstTime) emitCall(connected ? 'call.completed' : 'call.missed', call);
  await maybeQueueRecording(call);
}

async function maybeQueueRecording(call: CallDoc) {
  const withUrl = await CallModel.findOne({ organizationId: call.organizationId, _id: call._id }).select('+providerRecordingUrl recordingId recordingConsent').lean();
  if (!withUrl?.providerRecordingUrl || withUrl.recordingId) return;
  const policy = await getCommunicationPolicy(call.organizationId);
  const consent = withUrl.recordingConsent?.status ?? 'unknown';
  if (!policy.recordingEnabled || !['not_required', 'announced', 'granted'].includes(consent)) return;
  await enqueue('call.recording.ingest', { organizationId: call.organizationId.toString(), callId: call._id.toString() }, { jobId: `rec:${call._id.toString()}` });
}

/** Validates outcome/follow-up input up front so a rejected request changes nothing. */
async function validateOutcome(ctx: ServiceContext, input: z.infer<typeof outcomeBody>) {
  await assertLookupValues(ctx, {
    callOutcome: { type: 'call_outcome', value: input.callOutcome },
    'followUp.followUpType': { type: 'followup_type', value: input.followUp?.followUpType },
  });
}

async function applyOutcome(ctx: ServiceContext, call: CallDoc, input: z.infer<typeof outcomeBody>) {
  if (input.callOutcome !== undefined) call.callOutcome = input.callOutcome;
  if (input.notes !== undefined) call.outcomeNotes = input.notes;
  if (input.nextAction !== undefined) call.nextAction = input.nextAction;
  if (input.followUp && call.leadId) {
    const followUp = await createFollowUp(ctx, call.leadId.toString(), { ...input.followUp, nextAction: input.followUp.nextAction ?? input.nextAction });
    call.followUpId = followUp._id as Types.ObjectId;
  }
  await call.save();
  if (call.activityId && (input.callOutcome !== undefined || input.notes !== undefined || input.nextAction !== undefined)) {
    await ActivityModel.updateOne(
      { organizationId: ctx.organizationId, _id: call.activityId },
      { outcome: call.callOutcome, notes: call.outcomeNotes, 'metadata.nextAction': call.nextAction, 'metadata.followUpId': call.followUpId?.toString() },
    );
  }
}

/** Ends a device call (the app reports status/duration) and/or records the outcome. */
export async function completeCall(ctx: ServiceContext, id: string, input: z.infer<typeof completeCallBody>) {
  const call = await loadCall(ctx, id);
  await validateOutcome(ctx, input);
  if (call.counsellorId && !call.counsellorId.equals(ctx.userId) && !hasPermissions(ctx, ['lead.assign'])) {
    throw ApiError.forbidden('Only the counsellor on this call can complete it');
  }
  if (call.source === 'device' || call.source === 'manual_log') {
    if (input.status) call.status = input.status;
    else if (!isTerminal(call.status)) call.status = (input.durationSeconds ?? 0) > 0 ? 'completed' : 'no_answer';
    if (input.durationSeconds !== undefined) call.duration = input.durationSeconds;
    call.endedAt = input.endedAt ?? call.endedAt ?? new Date();
    if (call.status === 'completed' && call.duration === 0) throw ApiError.validation([{ field: 'body.durationSeconds', message: 'A completed call needs a duration' }]);
    if (isConnected(call)) call.answeredAt ??= call.startedAt;
  }
  if (input.recordingConsent && call.recordingConsent?.status === 'unknown') {
    call.set('recordingConsent', { status: input.recordingConsent, at: new Date(), method: 'explicit' });
    await recordAudit(ctx, { entityType: 'call', entityId: call._id, action: `call.recording_consent_${input.recordingConsent}` });
  }
  await call.save();
  await finalizeCall(ctx, call);
  await applyOutcome(ctx, call, input);
  return getCall(ctx, call._id.toString());
}

export async function setOutcome(ctx: ServiceContext, id: string, input: z.infer<typeof outcomeBody>) {
  const call = await loadCall(ctx, id);
  await validateOutcome(ctx, input);
  await applyOutcome(ctx, call, input);
  return getCall(ctx, call._id.toString());
}

/** A call made outside the CRM (or before it existed), logged afterwards. */
export async function logCall(ctx: ServiceContext, input: z.infer<typeof logCallBody>) {
  const lead = await loadLead(ctx, input.leadId);
  const number = lead.phone ?? lead.whatsappNumber;
  if (!number) throw ApiError.badRequest('This lead has no phone number');
  await validateOutcome(ctx, input);
  const connected = input.status === 'completed' && input.durationSeconds > 0;
  const call = await CallModel.create({
    organizationId: ctx.organizationId,
    provider: 'manual',
    source: 'manual_log',
    ...leadSnapshot(lead),
    counsellorId: ctx.userId,
    direction: input.direction,
    status: input.status,
    phoneNumber: number,
    startedAt: input.startedAt,
    answeredAt: connected ? input.startedAt : undefined,
    endedAt: new Date(input.startedAt.getTime() + input.durationSeconds * 1000),
    duration: input.durationSeconds,
    recordingConsent: { status: 'not_required' },
    createdBy: ctx.userId,
  });
  await finalizeCall(ctx, call);
  await applyOutcome(ctx, call, input);
  return getCall(ctx, call._id.toString());
}

// ── Provider events (webhooks) ───────────────────────────────────────────

/**
 * Applies one normalized provider event. Matches by provider call id, then by our call id
 * (echoed custom field); unknown incoming calls are matched to a lead by phone number and
 * attributed to that lead's counsellor.
 */
export async function applyProviderEvent(organizationId: Types.ObjectId, providerName: string, event: CallEvent): Promise<'updated' | 'created' | 'ignored'> {
  let call =
    (await CallModel.findOne({ organizationId, provider: providerName, providerCallId: event.providerCallId })) ??
    (event.callId && Types.ObjectId.isValid(event.callId) ? await CallModel.findOne({ organizationId, _id: new Types.ObjectId(event.callId) }) : null);
  let created = false;

  if (!call) {
    if (event.direction !== 'incoming') return 'ignored';
    const { defaultCountryCode } = await getOrgSettings(organizationId);
    const from = event.from ? normalizePhone(event.from, defaultCountryCode) : null;
    if (!from) return 'ignored';
    const lead = await LeadModel.findOne({ organizationId, deletedAt: null, $or: [{ phone: from }, { whatsappNumber: from }] })
      .sort({ updatedAt: -1 })
      .lean();
    call = new CallModel({
      organizationId,
      provider: providerName,
      providerCallId: event.providerCallId,
      source: 'webhook',
      ...(lead ? leadSnapshot(lead) : {}),
      counsellorId: lead?.assignedCounsellor ?? undefined,
      direction: 'incoming',
      status: event.status,
      phoneNumber: from,
      startedAt: event.startedAt ?? new Date(),
      recordingConsent: { status: 'unknown' },
    });
    created = true;
  }

  call.providerCallId ||= event.providerCallId;
  // Never move a finished call back to an in-progress status (events can arrive out of order).
  if (!(isTerminal(call.status) && !isTerminal(event.status))) call.status = event.status;
  if (event.startedAt) call.startedAt = event.startedAt;
  if (event.answeredAt) call.answeredAt = event.answeredAt;
  if (event.endedAt) call.endedAt = event.endedAt;
  if (event.durationSeconds !== undefined) call.duration = event.durationSeconds;
  if (call.status === 'completed' && !call.duration) call.status = 'no_answer';
  if (isConnected(call)) call.answeredAt ??= call.startedAt;
  if (event.recordingUrl) call.set('providerRecordingUrl', event.recordingUrl);
  await call.save();

  if (call.status === 'answered') emitCall('call.answered', call);
  if (isTerminal(call.status) && call.leadId) {
    await finalizeCall({ organizationId, userId: call.counsellorId ?? new Types.ObjectId(), meta: {} }, call);
  }
  return created ? 'created' : 'updated';
}

// ── Reading ──────────────────────────────────────────────────────────────

const populate = (ctx: Pick<ServiceContext, 'organizationId'>) => [
  { path: 'leadId', select: 'leadNumber fullName', match: { organizationId: ctx.organizationId } },
  { path: 'counsellorId', select: 'fullName', match: { organizationId: ctx.organizationId } },
];

function toDto(c: Record<string, unknown> & { leadId?: unknown; counsellorId?: unknown; status: string; duration?: number; recordingId?: unknown; transcriptId?: unknown; summaryId?: unknown }) {
  const { leadId, counsellorId, __v: _v, providerRecordingUrl: _p, ...rest } = c;
  return {
    ...rest,
    lead: leadId ?? null,
    counsellor: counsellorId ?? null,
    connected: isConnected(c),
    hasRecording: !!c.recordingId,
    hasTranscript: !!c.transcriptId,
    hasSummary: !!c.summaryId,
  };
}

export async function getCall(ctx: ServiceContext, id: string) {
  if (!Types.ObjectId.isValid(id)) throw ApiError.notFound('Call');
  const call = await CallModel.findOne({ ...callScopeFilter(ctx), _id: new Types.ObjectId(id) }).populate(populate(ctx)).lean();
  if (!call) throw ApiError.notFound('Call');
  return toDto(call as never);
}

export async function listCalls(ctx: ServiceContext, q: CallListQuery, extra: Filter = {}) {
  const and: Filter[] = [];
  if (q.dateFrom || q.dateTo) and.push({ startedAt: { ...(q.dateFrom ? { $gte: q.dateFrom } : {}), ...(q.dateTo ? { $lte: q.dateTo } : {}) } });
  if (q.counsellor) and.push({ counsellorId: new Types.ObjectId(q.counsellor) });
  if (q.branchId) and.push({ branchId: new Types.ObjectId(q.branchId) });
  if (q.leadId) and.push({ leadId: new Types.ObjectId(q.leadId) });
  if (q.direction) and.push({ direction: q.direction });
  if (q.status?.length) and.push({ status: { $in: q.status } });
  if (q.outcome?.length) and.push({ callOutcome: { $in: q.outcome } });
  if (q.connected === 'true') and.push({ $or: [{ status: 'answered' }, { status: 'completed', duration: { $gt: 0 } }] });
  if (q.connected === 'false') and.push({ status: { $nin: ['answered', 'completed'] } });
  if (q.hasRecording) and.push({ recordingId: q.hasRecording === 'true' ? { $ne: null } : null });
  if (q.minDuration !== undefined || q.maxDuration !== undefined) and.push({ duration: { ...(q.minDuration !== undefined ? { $gte: q.minDuration } : {}), ...(q.maxDuration !== undefined ? { $lte: q.maxDuration } : {}) } });
  if (q.source?.length) and.push({ leadSource: { $in: q.source } });
  if (q.campaign) and.push({ campaign: q.campaign });
  if (q.country) and.push({ countryInterested: q.country });
  if (q.course) and.push({ courseInterested: q.course });
  const filter = { ...callScopeFilter(ctx), ...extra, ...(and.length ? { $and: and } : {}) };
  const { skip, limit } = toPaging(q);
  const [items, total] = await Promise.all([
    CallModel.find(filter).sort(toSort(q.sortBy, q.sortOrder)).skip(skip).limit(limit).populate(populate(ctx)).lean(),
    CallModel.countDocuments(filter),
  ]);
  return { items: items.map((c) => toDto(c as never)), pagination: buildPagination(q.page, q.limit, total) };
}

/** All calls of a lead the caller can see (lead scope checked), regardless of who made them. */
export async function listLeadCalls(ctx: ServiceContext, leadId: string, q: CallListQuery) {
  const lead = await loadLead(ctx, leadId);
  const { items, pagination } = await listCalls({ ...ctx, dataScope: 'organization' }, { ...q, leadId: undefined }, { leadId: lead._id });
  return { items, pagination };
}

// ── Recording, transcript, AI summary (sensitive) ────────────────────────

/** Signed, short-lived recording URL. Every access is audited (spec §30). */
export async function recordingUrl(ctx: ServiceContext, callId: string, download: boolean) {
  if (download && !hasPermissions(ctx, ['recording.download'])) throw ApiError.forbidden('You cannot download recordings');
  const call = await loadCall(ctx, callId, 'recordingId');
  const rec = call.recordingId ? await CallRecordingModel.findOne({ organizationId: ctx.organizationId, _id: call.recordingId }).lean() : null;
  if (!rec || rec.status !== 'stored' || !rec.fileKey) throw ApiError.notFound('Recording');
  const ext = rec.mimeType?.includes('wav') ? 'wav' : 'mp3';
  const url = await storage.getSignedUrl(rec.fileKey, { fileName: `call-${callId}.${ext}`, inline: !download });
  await recordAudit(ctx, { entityType: 'call_recording', entityId: rec._id, action: download ? 'recording.downloaded' : 'recording.played', metadata: { callId } });
  return { url, expiresInSeconds: env.SIGNED_URL_TTL_SECONDS, mimeType: rec.mimeType ?? 'audio/mpeg', duration: rec.duration ?? null, retentionUntil: rec.retentionUntil };
}

export async function callIntelligence(ctx: ServiceContext, callId: string) {
  const call = await loadCall(ctx, callId, 'transcriptId summaryId');
  const [transcript, summary] = await Promise.all([
    call.transcriptId ? TranscriptModel.findOne({ organizationId: ctx.organizationId, _id: call.transcriptId }).select('language status segments fullText duration createdAt').lean() : null,
    call.summaryId ? AiSummaryModel.findOne({ organizationId: ctx.organizationId, _id: call.summaryId }).populate({ path: 'editedBy', select: 'fullName', match: { organizationId: ctx.organizationId } }).lean() : null,
  ]);
  if (transcript || summary) await recordAudit(ctx, { entityType: 'call', entityId: call._id, action: 'transcript.viewed' });
  return { transcript, summary: summary ? { ...summary, aiGenerated: true } : null };
}

export async function editSummary(ctx: ServiceContext, callId: string, input: z.infer<typeof editSummaryBody>) {
  const call = await loadCall(ctx, callId, 'summaryId');
  if (!call.summaryId) throw ApiError.notFound('AI summary');
  await AiSummaryModel.updateOne(
    { organizationId: ctx.organizationId, _id: call.summaryId },
    { ...(input.summary !== undefined ? { editedSummary: input.summary } : {}), ...(input.nextAction !== undefined ? { editedNextAction: input.nextAction } : {}), editedBy: ctx.userId, editedAt: new Date() },
  );
  await recordAudit(ctx, { entityType: 'call', entityId: call._id, action: 'ai_summary.edited' });
  return callIntelligence(ctx, callId);
}

/** Transcript Center (spec §40): org-bounded full-text search, limited to calls the caller can see. */
export async function searchTranscripts(ctx: ServiceContext, q: { q: string; page: number; limit: number; dateFrom?: Date | undefined; dateTo?: Date | undefined; counsellor?: string | undefined }) {
  const filter: Filter = { organizationId: ctx.organizationId, status: 'completed', $text: { $search: q.q } };
  if (!hasOrgScope(ctx)) {
    if (ctx.dataScope === 'branch') filter.$or = [{ branchId: { $in: ctx.branchIds } }, { counsellorId: ctx.userId }];
    else filter.counsellorId = ctx.userId;
  }
  if (q.counsellor) filter.counsellorId = new Types.ObjectId(q.counsellor);
  if (q.dateFrom || q.dateTo) filter.createdAt = { ...(q.dateFrom ? { $gte: q.dateFrom } : {}), ...(q.dateTo ? { $lte: q.dateTo } : {}) };
  const { skip, limit } = toPaging(q);
  const [items, total] = await Promise.all([
    TranscriptModel.find(filter, { score: { $meta: 'textScore' } })
      .select('callId leadId counsellorId language fullText createdAt')
      .sort({ score: { $meta: 'textScore' } })
      .skip(skip)
      .limit(limit)
      .populate([
        { path: 'leadId', select: 'leadNumber fullName', match: { organizationId: ctx.organizationId } },
        { path: 'counsellorId', select: 'fullName', match: { organizationId: ctx.organizationId } },
      ])
      .lean(),
    TranscriptModel.countDocuments(filter),
  ]);
  const terms = q.q.toLowerCase().replace(/"/g, '').split(/\s+/).filter(Boolean);
  await recordAudit(ctx, { entityType: 'transcript', action: 'transcript.searched', metadata: { query: q.q.slice(0, 100), results: total } });
  return {
    items: items.map(({ fullText, leadId, counsellorId, ...t }) => {
      const text = fullText ?? '';
      const at = Math.max(0, ...terms.map((w) => text.toLowerCase().indexOf(w)));
      return { ...t, lead: leadId ?? null, counsellor: counsellorId ?? null, snippet: (at > 60 ? '…' : '') + text.slice(Math.max(0, at - 60), at + 140) + (text.length > at + 140 ? '…' : '') };
    }),
    pagination: buildPagination(q.page, q.limit, total),
  };
}
