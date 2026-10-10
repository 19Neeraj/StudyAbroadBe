import { Types } from 'mongoose';
import type { z } from '../../docs/zod.js';
import { hasPermissions } from '../../middlewares/auth.middleware.js';
import type { ServiceContext } from '../../types/auth.js';
import { canAccessBranch } from '../../utils/access.js';
import { ApiError } from '../../utils/ApiError.js';
import { buildPagination, toPaging, toSort } from '../../utils/pagination.js';
import { addDays, startOfDayInTz } from '../../utils/time.js';
import { ActivityModel } from '../activities/activity.model.js';
import { logActivities, logActivity } from '../activities/activity.service.js';
import type { logActivityBody } from '../activities/activity.validation.js';
import { recordAudit } from '../audit/audit.service.js';
import { BranchModel } from '../branches/branch.model.js';
import { nextSequence } from '../counters/counter.model.js';
import { FollowUpModel, OPEN_FOLLOWUP_STATUSES, refreshNextFollowUp } from '../followups/followup.model.js';
import { getOrgSettings } from '../organizations/orgSettings.js';
import { assertLookupValues, listLookups, lookupMetaByKey } from '../settings/lookup.service.js';
import { compileFilterTree } from '../../utils/filterTree.js';
import { buildLeadSearch, loadLead, scopedLeadFilter } from './lead.access.js';
import { markContacted } from './lead.contact.js';
import { LEAD_FILTER_FIELDS } from './lead.filters.js';
import { inquiryAndAttributionFilters } from './lead.query.js';
import { defaultAssignee, resolveAssignee } from './lead.assignment.js';
import { duplicateConflict, findDuplicates, normalizeContact } from './lead.duplicates.js';
import { emitLeadEvent } from './lead.events.js';
import { ATTRIBUTION_FIELDS, LeadModel, MERGEABLE_FIELDS } from './lead.model.js';
import { leadAssigned as notifyAssigned } from '../notifications/triggers.js';
import { assertAttributionPath, moveTouchpoints, recordTouchpoint, touchFromLeadFields, type TouchpointInput } from '../marketing/attribution.service.js';
import type { AttributionSnapshot } from '../marketing/attributionNode.model.js';
import { findInquiryByKey, mergeInquiries, recordFirstInquiry, recordReinquiry } from './lead.inquiries.js';
import type {
  bulkStageBody,
  changeStageBody,
  changeStatusBody,
  createLeadBody,
  LeadListQuery,
  PipelineQuery,
  updateLeadBody,
} from './lead.validation.js';

type Filter = Record<string, unknown>;
const DEFAULT_STAGE = 'new_lead';
const DEFAULT_STATUS = 'active';
const DUPLICATE_STATUS = 'duplicate';

const LIST_FIELDS =
  'leadNumber firstName lastName fullName phone whatsappNumber email leadStage leadStatus leadSource campaign ' +
  'branchId assignedCounsellor assignedManager nextFollowUpAt countryInterested courseInterested intake ' +
  'inquiryCount firstInquiryAt lastInquiryAt lastInquiryChannel createdAt updatedAt';

function populateRefs(ctx: ServiceContext) {
  const match = { organizationId: ctx.organizationId };
  return [
    { path: 'branchId', select: 'name code', match },
    { path: 'assignedCounsellor', select: 'fullName', match },
    { path: 'assignedManager', select: 'fullName', match },
  ];
}

/** Renames populated refs to readable keys: branchId → branch (keeps API field names stable). */
function toDto<T extends { branchId?: unknown; __v?: unknown }>(lead: T) {
  const { branchId, __v: _v, ...rest } = lead;
  return { ...rest, branch: branchId ?? null };
}

const LOOKUP_FIELDS = {
  leadSource: 'lead_source',
  countryInterested: 'country',
  courseInterested: 'course',
  degreeLevel: 'degree_level',
  intake: 'intake',
} as const;

function lookupChecks(input: Partial<Record<keyof typeof LOOKUP_FIELDS, string | null | undefined>>) {
  return Object.fromEntries(
    Object.entries(LOOKUP_FIELDS).map(([field, type]) => [field, { type, value: input[field as keyof typeof LOOKUP_FIELDS] }]),
  );
}

async function assertBranch(ctx: ServiceContext, branchId: string) {
  if (!canAccessBranch(ctx, branchId)) throw ApiError.forbidden('You cannot use a branch outside your own branches');
  const exists = await BranchModel.exists({ organizationId: ctx.organizationId, _id: branchId, isActive: true });
  if (!exists) throw ApiError.validation([{ field: 'body.branchId', message: 'Branch not found' }]);
}

async function closedStatuses(ctx: ServiceContext): Promise<string[]> {
  const meta = await lookupMetaByKey(ctx, 'lead_status');
  return [...meta].filter(([, m]) => m.meta.isClosed === true).map(([key]) => key);
}

export async function getLead(ctx: ServiceContext, id: string | Types.ObjectId) {
  const lead = await LeadModel.findOne(scopedLeadFilter(ctx, { _id: new Types.ObjectId(id) }))
    .select('-deletedAt -deletedBy')
    .populate([
      ...populateRefs(ctx),
      { path: 'createdBy', select: 'fullName', match: { organizationId: ctx.organizationId } },
    ])
    .lean();
  if (!lead) throw ApiError.notFound('Lead');
  return toDto(lead);
}

function pickDefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== '')) as Partial<T>;
}

export type CreateLeadResult =
  | { outcome: 'created'; leadId: Types.ObjectId; lead: Awaited<ReturnType<typeof getLead>>; inquiryId?: Types.ObjectId }
  | {
      outcome: 'added_to_existing';
      leadId: Types.ObjectId;
      lead: Awaited<ReturnType<typeof getLead>> | null;
      /** True when the submission was recorded as a re-inquiry of the existing lead. */
      reinquiry: true;
      inquiryId: Types.ObjectId;
      inquiryCount: number;
    }
  | { outcome: 'duplicate_event'; leadId: Types.ObjectId; lead: Awaited<ReturnType<typeof getLead>> | null };

/**
 * `touchpoints` lets integrations record what they actually received (provider IDs, UTMs, click IDs,
 * first/last website touch). Without it, one touchpoint is derived from the lead's attribution fields.
 * `inquiry.idempotencyKey` (provider event ID / Idempotency-Key header) makes retries harmless.
 */
export interface CreateLeadOptions {
  touchpoints?: TouchpointInput[];
  inquiry?: { idempotencyKey?: string | undefined; externalLeadId?: string | undefined; provider?: string | undefined };
}

const isDuplicateKeyOn = (err: unknown, field: string) =>
  typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000 && JSON.stringify((err as { keyPattern?: unknown }).keyPattern ?? {}).includes(field);

async function visibleLead(ctx: ServiceContext, id: Types.ObjectId) {
  try {
    return await getLead(ctx, id);
  } catch {
    return null; // Exists, but outside the caller's scope.
  }
}

/** The active lead that owns this normalized phone number in the organization, if any. */
async function leadWithPhone(ctx: ServiceContext, phone: string | null | undefined) {
  if (!phone) return null;
  return LeadModel.findOne({ organizationId: ctx.organizationId, phone, deletedAt: null, mergedInto: null })
    .sort({ createdAt: 1 })
    .select('_id')
    .lean();
}

/**
 * Creates a lead — or, when the organization already has an active lead with the same normalized
 * phone number, records a re-inquiry on that lead instead (never a second lead document).
 *  - Phone match → always a re-inquiry, whatever `duplicateAction` says.
 *  - Email / WhatsApp-only match → 409 DUPLICATE_LEAD unless `duplicateAction` resolves it.
 *  - Concurrent submissions are safe: the unique { organizationId, normalizedPhone } index rejects
 *    the loser, which then records a re-inquiry on the winner.
 */
export async function createLead(ctx: ServiceContext, input: z.infer<typeof createLeadBody>, opts: CreateLeadOptions = {}): Promise<CreateLeadResult> {
  const details = {
    idempotencyKey: opts.inquiry?.idempotencyKey,
    externalLeadId: opts.inquiry?.externalLeadId,
    provider: opts.inquiry?.provider,
  };
  const replay = await findInquiryByKey(ctx.organizationId, details.idempotencyKey);
  if (replay) return { outcome: 'duplicate_event', leadId: replay.leadId, lead: await visibleLead(ctx, replay.leadId) };

  const derived = touchFromLeadFields(input, input.leadSource === 'manual' ? 'manual' : 'api');
  const touches = (opts.touchpoints?.length ? opts.touchpoints : [derived]).map((t, i, all) =>
    // A person-chosen P/S/T path applies to the latest touch of this submission.
    input.attribution && i === all.length - 1 ? { ...t, attribution: input.attribution } : t,
  );
  const contact = await normalizeContact(ctx, input);
  const stage = input.leadStage ?? DEFAULT_STAGE;
  await assertLookupValues(ctx, { ...lookupChecks(input), leadStage: { type: 'lead_stage', value: stage } });
  await assertAttributionPath(ctx, input.attribution);

  let branchId = input.branchId;
  if (branchId) await assertBranch(ctx, branchId);
  else if (ctx.dataScope !== 'organization' && ctx.branchIds[0]) branchId = ctx.branchIds[0].toString();

  // Explicit assignment needs lead.assign; otherwise the default strategy applies.
  if ((input.assignedCounsellor || input.assignedManager) && !hasPermissions(ctx, ['lead.assign'])) {
    throw ApiError.forbidden('You do not have permission to assign leads');
  }
  const counsellor = input.assignedCounsellor ? await resolveAssignee(ctx, input.assignedCounsellor, 'assignedCounsellor') : null;
  const manager = input.assignedManager ? await resolveAssignee(ctx, input.assignedManager, 'assignedManager') : null;
  const counsellorId = counsellor?._id ?? defaultAssignee(ctx);

  const attribution = pickDefined(Object.fromEntries(ATTRIBUTION_FIELDS.map((f) => [f, input[f]])));
  const touch = { ...attribution, at: new Date() };
  const enquiry = { input, contact, touch, touches, details, incomingAssignee: counsellorId };

  // Same phone in this organization → re-inquiry on the existing lead.
  const samePhone = await leadWithPhone(ctx, contact.phone);
  if (samePhone) return recordEnquiryOnExisting(ctx, samePhone._id, enquiry);

  const duplicates = await findDuplicates(ctx, contact);
  // (A concurrent submission may have created the phone's lead since the lookup above.)
  const racedPhone = duplicates.find((d) => d.samePhone);
  if (racedPhone) return recordEnquiryOnExisting(ctx, racedPhone._id, enquiry);
  let duplicateOf: Types.ObjectId | undefined;
  if (duplicates.length) {
    if (!input.duplicateAction) throw duplicateConflict(duplicates);
    const target = input.duplicateOfId ? duplicates.find((d) => d._id.equals(input.duplicateOfId)) : duplicates[0];
    if (!target) throw ApiError.validation([{ field: 'body.duplicateOfId', message: 'Not one of the matching leads' }]);

    if (input.duplicateAction === 'keep_existing') return recordEnquiryOnExisting(ctx, target._id, enquiry);
    if (!hasPermissions(ctx, ['lead.merge'])) {
      throw ApiError.forbidden('Only users who can resolve duplicates may create a separate or duplicate lead');
    }
    if (input.duplicateAction === 'mark_duplicate') duplicateOf = target._id;
  }

  const { duplicateAction: _a, duplicateOfId: _b, leadStage: _c, assignedCounsellor: _d, assignedManager: _e, attribution: _f, ...profile } = input;
  const now = new Date();
  let lead;
  try {
    lead = await LeadModel.create({
      ...pickDefined(profile),
      ...pickDefined(contact),
      organizationId: ctx.organizationId,
      leadNumber: await nextSequence(ctx.organizationId, 'lead'),
      branchId,
      leadStage: stage,
      leadStatus: duplicateOf ? DUPLICATE_STATUS : DEFAULT_STATUS,
      stageChangedAt: now,
      sourceHistory: [touch],
      assignedCounsellor: counsellorId,
      assignedManager: manager?._id,
      assignedAt: counsellorId || manager ? now : undefined,
      duplicateOf,
      inquiryCount: 1,
      firstInquiryAt: now,
      lastInquiryAt: now,
      lastActivityAt: now,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
    });
  } catch (err) {
    // Lost a race against a concurrent submission with the same phone: that lead wins.
    if (isDuplicateKeyOn(err, 'normalizedPhone')) {
      const winner = await leadWithPhone(ctx, contact.phone);
      if (winner) return recordEnquiryOnExisting(ctx, winner._id, enquiry);
    }
    throw err;
  }

  await logActivities(ctx, [
    {
      leadId: lead._id,
      type: 'lead_created',
      title: 'Lead created',
      notes: input.notes,
      newValue: { leadSource: lead.leadSource, campaign: lead.campaign ?? null },
      metadata: duplicateOf ? { duplicateOf: duplicateOf.toString(), duplicateAction: input.duplicateAction } : {},
    },
    ...(counsellorId
      ? [{ leadId: lead._id, type: 'lead_assigned' as const, title: 'Counsellor assigned', newValue: { id: counsellorId.toString(), name: counsellor?.fullName ?? null }, metadata: { role: 'counsellor' } }]
      : []),
    ...(manager
      ? [{ leadId: lead._id, type: 'lead_assigned' as const, title: 'Manager assigned', newValue: { id: manager._id.toString(), name: manager.fullName }, metadata: { role: 'manager' } }]
      : []),
  ]);
  if (duplicates.length) {
    await recordAudit(ctx, {
      entityType: 'lead',
      entityId: lead._id,
      action: input.duplicateAction === 'mark_duplicate' ? 'lead.created_as_duplicate' : 'lead.created_despite_duplicate',
      metadata: { matches: duplicates.map((d) => d.leadNumber) },
    });
  }
  const recorded = [];
  for (const t of touches) recorded.push(await recordTouchpoint(ctx.organizationId, lead._id, t));
  const inquiry = await recordFirstInquiry(ctx, lead, { channel: touches.at(-1)?.origin ?? 'manual', occurredAt: touches.at(-1)?.occurredAt ?? now, leadSource: input.leadSource, campaignName: input.campaign, ...details }, recorded);
  if (counsellorId || manager) await notifyAssigned(ctx.organizationId, lead, { counsellor: counsellorId, manager: manager?._id }, ctx.userId);
  emitLeadEvent('lead.created', lead, { leadNumber: lead.leadNumber, fullName: lead.fullName });
  return { outcome: 'created', leadId: lead._id, lead: await getLead(ctx, lead._id), ...(inquiry ? { inquiryId: inquiry._id } : {}) };
}

interface Enquiry {
  input: z.infer<typeof createLeadBody>;
  contact: Awaited<ReturnType<typeof normalizeContact>>;
  touch: Record<string, unknown>;
  touches: TouchpointInput[];
  details: { idempotencyKey?: string | undefined; externalLeadId?: string | undefined; provider?: string | undefined };
  incomingAssignee?: Types.ObjectId | undefined;
}

/**
 * Re-inquiry: the submission is recorded on the existing lead (inquiry history, latest source,
 * touchpoints, timeline entry with everything that was submitted) and empty profile fields are filled.
 * Lead ID, stage, owner, notes, tasks and the original attribution are never overwritten.
 */
async function recordEnquiryOnExisting(ctx: ServiceContext, leadId: Types.ObjectId, e: Enquiry): Promise<CreateLeadResult> {
  const existing = await LeadModel.findOne({ organizationId: ctx.organizationId, _id: leadId });
  if (!existing) throw ApiError.notFound('Lead');
  const submitted = pickDefined({ ...e.input, ...e.contact, duplicateAction: undefined, duplicateOfId: undefined, attribution: undefined }) as Record<string, unknown>;
  const previousAttribution = (existing.latestAttribution ?? existing.attribution) as unknown as AttributionSnapshot | undefined;

  const filled: Record<string, unknown> = {};
  for (const f of MERGEABLE_FIELDS) {
    const current = existing.get(f) as unknown;
    if ((current === undefined || current === null || current === '') && submitted[f] !== undefined && f !== 'branchId' && f !== 'phone') {
      filled[f] = submitted[f];
    }
  }
  const channel = e.touches.at(-1)?.origin ?? 'manual';
  // The inquiry is reserved first (idempotency key): a replayed provider event changes nothing.
  const result = await recordReinquiry(
    ctx,
    existing._id,
    { channel, occurredAt: e.touches.at(-1)?.occurredAt, leadSource: e.input.leadSource, campaignName: e.input.campaign, notes: e.input.notes, ...e.details },
    async () => {
      // Atomic: concurrent re-inquiries of one lead must not conflict on the document version.
      await LeadModel.updateOne(
        { organizationId: ctx.organizationId, _id: existing._id },
        { $set: { ...filled, updatedBy: ctx.userId }, $push: { sourceHistory: e.touch } },
      );
      const recorded = [];
      for (const t of e.touches) recorded.push(await recordTouchpoint(ctx.organizationId, existing._id, t));
      return recorded;
    },
    { incomingAssignee: e.incomingAssignee, previousAttribution },
  );
  if (!result) return { outcome: 'duplicate_event', leadId: existing._id, lead: await visibleLead(ctx, existing._id) };

  await logActivity(ctx, {
    leadId: existing._id,
    type: 'duplicate_enquiry',
    title: `Re-inquiry received (inquiry ${result.sequence})`,
    notes: e.input.notes,
    newValue: submitted,
    metadata: {
      filledFields: Object.keys(filled),
      leadSource: e.input.leadSource,
      channel,
      inquiryId: result.inquiryId.toString(),
      assignment: result.decision.action,
    },
  });
  emitLeadEvent('lead.updated', existing);
  return {
    outcome: 'added_to_existing',
    leadId: existing._id,
    lead: await visibleLead(ctx, existing._id),
    reinquiry: true,
    inquiryId: result.inquiryId,
    inquiryCount: result.sequence,
  };
}

export async function listFilter(ctx: ServiceContext, q: Partial<LeadListQuery>): Promise<Filter> {
  const and: Filter[] = [];
  const settings = await getOrgSettings(ctx.organizationId);
  if (q.search) and.push(buildLeadSearch(q.search, settings.defaultCountryCode));
  if (q.dateFrom || q.dateTo) {
    and.push({ createdAt: { ...(q.dateFrom ? { $gte: q.dateFrom } : {}), ...(q.dateTo ? { $lte: q.dateTo } : {}) } });
  }
  if (q.branchId) and.push({ branchId: new Types.ObjectId(q.branchId) });
  if (q.assignedUser) and.push({ assignedCounsellor: q.assignedUser === 'unassigned' ? null : new Types.ObjectId(q.assignedUser) });
  if (q.assignedManager) and.push({ assignedManager: new Types.ObjectId(q.assignedManager) });
  if (q.stage?.length) and.push({ leadStage: { $in: q.stage } });
  if (q.status?.length) and.push({ leadStatus: { $in: q.status } });
  else if (q.includeClosed === false) and.push({ leadStatus: { $nin: await closedStatuses(ctx) } });
  if (q.source?.length) and.push({ leadSource: { $in: q.source } });
  if (q.campaign) and.push({ campaign: q.campaign });
  if (q.country) and.push({ countryInterested: q.country });
  if (q.course) and.push({ courseInterested: q.course });
  if (q.intake) and.push({ intake: q.intake });
  if (q.followUp) {
    const now = new Date();
    const today = startOfDayInTz(settings.timezone, now);
    const tomorrow = addDays(today, 1);
    const ranges: Record<string, Filter> = {
      overdue: { nextFollowUpAt: { $lt: now } },
      today: { nextFollowUpAt: { $gte: today, $lt: tomorrow } },
      upcoming: { nextFollowUpAt: { $gte: tomorrow } },
      none: { nextFollowUpAt: null },
    };
    and.push(ranges[q.followUp]!);
  }
  // Advanced filter tree; simple filters above and the scope are ANDed with it.
  if (q.filter) and.push(compileFilterTree(q.filter, LEAD_FILTER_FIELDS));
  and.push(...(await inquiryAndAttributionFilters(ctx, q)));
  return scopedLeadFilter(ctx, ...and);
}

export async function listLeads(ctx: ServiceContext, q: LeadListQuery) {
  const filter = await listFilter(ctx, q);
  const { skip, limit } = toPaging(q);
  const [items, total] = await Promise.all([
    LeadModel.find(filter).select(LIST_FIELDS).sort(toSort(q.sortBy, q.sortOrder)).skip(skip).limit(limit).populate(populateRefs(ctx)).lean(),
    LeadModel.countDocuments(filter),
  ]);
  return { items: items.map(toDto), pagination: buildPagination(q.page, q.limit, total) };
}

/** Visual pipeline (spec §12): count + most recently updated leads per stage. One indexed query per stage. */
export async function leadPipeline(ctx: ServiceContext, q: PipelineQuery) {
  const [stages, base] = await Promise.all([listLookups(ctx, 'lead_stage', false), listFilter(ctx, { ...q, includeClosed: false })]);
  return Promise.all(
    stages.map(async (s) => {
      const filter = { ...base, leadStage: s.key };
      const [count, leads] = await Promise.all([
        LeadModel.countDocuments(filter),
        LeadModel.find(filter).select(LIST_FIELDS).sort({ updatedAt: -1, _id: -1 }).limit(q.perStage).populate(populateRefs(ctx)).lean(),
      ]);
      return { stage: s.key, label: s.label, color: s.color ?? null, category: (s.meta as { category?: string }).category ?? 'open', count, leads: leads.map(toDto) };
    }),
  );
}

const UPDATABLE = [
  'firstName', 'lastName', 'phone', 'whatsappNumber', 'email', 'city', 'state', 'country',
  'countryInterested', 'courseInterested', 'degreeLevel', 'intake', 'educationDetails',
  'ieltsScore', 'pteScore', 'toeflScore', 'otherTestScore', 'budget', 'expectedPaymentDate',
  'branchId', 'campaign', 'notes',
] as const;

export async function updateLead(ctx: ServiceContext, id: string, input: z.infer<typeof updateLeadBody>) {
  const lead = await loadLead(ctx, id);
  const contact = await normalizeContact(ctx, input);
  const changes: Record<string, unknown> = { ...pickUpdatable(input), ...contact };

  const newContact = Object.fromEntries(
    Object.entries(contact).filter(([k, v]) => v && v !== lead.get(k)),
  );
  if (Object.keys(newContact).length) {
    const duplicates = await findDuplicates(ctx, newContact, lead._id);
    // A phone number can belong to only one active lead per organization: allowDuplicate can't override it.
    const phoneOwner = newContact.phone ? duplicates.filter((d) => d.samePhone) : [];
    if (phoneOwner.length) {
      throw new ApiError(409, 'Another lead already uses this phone number; merge the leads instead', [], 'DUPLICATE_PHONE', { duplicates: phoneOwner });
    }
    if (duplicates.length && !input.allowDuplicate) throw duplicateConflict(duplicates);
  }
  await assertLookupValues(ctx, lookupChecks(input));
  if (input.branchId) await assertBranch(ctx, input.branchId);

  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(changes)) {
    if (v === undefined) continue;
    const current = lead.get(k) as unknown;
    const same = JSON.stringify(current ?? null) === JSON.stringify(v ?? null);
    if (same) continue;
    before[k] = current ?? null;
    after[k] = v;
    lead.set(k, v === null ? undefined : v);
  }
  if (!Object.keys(after).length) return getLead(ctx, lead._id);

  lead.updatedBy = ctx.userId;
  await lead.save();
  await logActivity(ctx, { leadId: lead._id, type: 'lead_updated', title: 'Details updated', previousValue: before, newValue: after });
  emitLeadEvent('lead.updated', lead);
  return getLead(ctx, lead._id);
}

function pickUpdatable(input: z.infer<typeof updateLeadBody>) {
  return Object.fromEntries(UPDATABLE.filter((k) => input[k] !== undefined && !['phone', 'whatsappNumber', 'email'].includes(k)).map((k) => [k, input[k]]));
}

export async function changeStage(ctx: ServiceContext, id: string, input: z.infer<typeof changeStageBody>) {
  const lead = await loadLead(ctx, id);
  await assertLookupValues(ctx, { stage: { type: 'lead_stage', value: input.stage } });
  if (lead.leadStage !== input.stage) {
    const previous = lead.leadStage;
    lead.leadStage = input.stage;
    lead.stageChangedAt = new Date();
    lead.updatedBy = ctx.userId;
    await lead.save();
    await logActivity(ctx, { leadId: lead._id, type: 'stage_changed', title: 'Stage changed', previousValue: previous, newValue: input.stage, notes: input.note });
    emitLeadEvent('lead.stageChanged', lead, { stage: input.stage });
  }
  return getLead(ctx, lead._id);
}

export async function changeStatus(ctx: ServiceContext, id: string, input: z.infer<typeof changeStatusBody>) {
  const lead = await loadLead(ctx, id);
  await assertLookupValues(ctx, { status: { type: 'lead_status', value: input.status } });
  if (lead.leadStatus !== input.status) {
    const previous = lead.leadStatus;
    lead.leadStatus = input.status;
    lead.updatedBy = ctx.userId;
    await lead.save();
    await logActivity(ctx, { leadId: lead._id, type: 'status_changed', title: 'Status changed', previousValue: previous, newValue: input.status, notes: input.note });
    emitLeadEvent('lead.updated', lead);
  }
  return getLead(ctx, lead._id);
}

export async function bulkChangeStage(ctx: ServiceContext, input: z.infer<typeof bulkStageBody>) {
  await assertLookupValues(ctx, { stage: { type: 'lead_stage', value: input.stage } });
  const ids = [...new Set(input.leadIds)].map((i) => new Types.ObjectId(i));
  const leads = await LeadModel.find(scopedLeadFilter(ctx, { _id: { $in: ids } })).select('organizationId leadStage assignedCounsellor assignedManager').lean();
  const changed = leads.filter((l) => l.leadStage !== input.stage);
  if (changed.length) {
    await LeadModel.updateMany(
      { organizationId: ctx.organizationId, _id: { $in: changed.map((l) => l._id) } },
      { leadStage: input.stage, stageChangedAt: new Date(), updatedBy: ctx.userId },
    );
    await logActivities(
      ctx,
      changed.map((l) => ({ leadId: l._id, type: 'stage_changed' as const, title: 'Stage changed', previousValue: l.leadStage, newValue: input.stage, metadata: { bulk: true } })),
    );
    await recordAudit(ctx, { entityType: 'lead', action: 'lead.bulk_stage_changed', metadata: { count: changed.length, stage: input.stage } });
    for (const l of changed) emitLeadEvent('lead.stageChanged', l, { stage: input.stage });
  }
  return { updated: changed.length, unchanged: leads.length - changed.length, skipped: ids.length - leads.length };
}

/** Soft delete: the lead disappears from every list but its data and history are kept. */
export async function deleteLead(ctx: ServiceContext, id: string) {
  const lead = await loadLead(ctx, id);
  lead.deletedAt = new Date();
  lead.deletedBy = ctx.userId;
  await lead.save();
  await FollowUpModel.updateMany(
    { organizationId: ctx.organizationId, leadId: lead._id, status: { $in: OPEN_FOLLOWUP_STATUSES } },
    { status: 'cancelled', cancelledAt: new Date(), cancelReason: 'Lead deleted' },
  );
  await recordAudit(ctx, { entityType: 'lead', entityId: lead._id, action: 'lead.deleted', oldValue: { leadNumber: lead.leadNumber, fullName: lead.fullName } });
}

export async function leadDuplicates(ctx: ServiceContext, id: string) {
  const lead = await loadLead(ctx, id);
  return findDuplicates(ctx, { phone: lead.phone, whatsappNumber: lead.whatsappNumber, email: lead.email }, lead._id);
}

/**
 * Merge `duplicateLeadId` into `id` (spec §13): empty fields on the kept lead are filled, every
 * source touch, follow-up and timeline entry moves over, and the duplicate is closed (not deleted).
 */
export async function mergeLeads(ctx: ServiceContext, id: string, duplicateLeadId: string) {
  if (id === duplicateLeadId) throw ApiError.badRequest('A lead cannot be merged into itself');
  const [target, source] = await Promise.all([loadLead(ctx, id), loadLead(ctx, duplicateLeadId)]);
  if (source.mergedInto) throw ApiError.conflict('That lead has already been merged');

  const filled: Record<string, unknown> = {};
  for (const f of MERGEABLE_FIELDS) {
    const current = target.get(f) as unknown;
    const incoming = source.get(f) as unknown;
    if ((current === undefined || current === null || current === '') && incoming !== undefined && incoming !== null && incoming !== '') {
      filled[f] = incoming;
      target.set(f, incoming);
    }
  }
  target.sourceHistory.push(...source.sourceHistory.map((t) => t.toObject()));
  target.sourceHistory.sort((a, b) => (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0));
  target.updatedBy = ctx.userId;
  target.lastActivityAt = new Date();

  // Close the duplicate first: it releases its phone number, which the kept lead may take over.
  source.leadStatus = DUPLICATE_STATUS;
  source.mergedInto = target._id;
  source.duplicateOf = target._id;
  source.nextFollowUpAt = undefined;
  source.updatedBy = ctx.userId;
  await source.save();
  await target.save();

  const scope = { organizationId: ctx.organizationId, leadId: source._id };
  await Promise.all([
    FollowUpModel.updateMany(scope, { leadId: target._id, branchId: target.branchId }),
    ActivityModel.updateMany(scope, {
      leadId: target._id,
      $set: { 'metadata.mergedFromLead': source.leadNumber },
    }),
  ]);

  await refreshNextFollowUp(ctx.organizationId, target._id);
  await moveTouchpoints(ctx.organizationId, source._id, target._id);
  await mergeInquiries(ctx.organizationId, source._id, target._id);
  await logActivities(ctx, [
    { leadId: target._id, type: 'lead_merged', title: `Merged lead #${source.leadNumber} into this lead`, newValue: filled, metadata: { sourceLeadId: source._id.toString(), sourceLeadNumber: source.leadNumber } },
    { leadId: source._id, type: 'merged_into', title: `Merged into lead #${target.leadNumber}`, metadata: { targetLeadId: target._id.toString(), targetLeadNumber: target.leadNumber } },
  ]);
  await recordAudit(ctx, {
    entityType: 'lead',
    entityId: target._id,
    action: 'lead.merged',
    metadata: { sourceLeadId: source._id.toString(), sourceLeadNumber: source.leadNumber, filledFields: Object.keys(filled) },
  });
  emitLeadEvent('lead.updated', target);
  return getLead(ctx, target._id);
}

export async function logLeadActivity(ctx: ServiceContext, id: string, input: z.infer<typeof logActivityBody>) {
  const lead = await loadLead(ctx, id);
  const titles = { call: 'Call', whatsapp: 'WhatsApp', email: 'Email', meeting: 'Meeting', note: 'Note added', other: 'Activity' } as const;
  const activity = await logActivity(ctx, { leadId: lead._id, studentId: lead.studentId ?? undefined, type: input.type, title: titles[input.type], notes: input.notes, outcome: input.outcome, occurredAt: input.occurredAt });
  if (input.type === 'note' || input.type === 'other') {
    await LeadModel.updateOne({ organizationId: ctx.organizationId, _id: lead._id }, { lastActivityAt: new Date() });
  } else {
    await markContacted(ctx.organizationId, lead._id, input.occurredAt ?? new Date());
  }
  return activity;
}
