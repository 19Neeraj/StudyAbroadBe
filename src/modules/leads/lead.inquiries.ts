import { Types } from 'mongoose';
import type { ServiceContext } from '../../types/auth.js';
import { ApiError } from '../../utils/ApiError.js';
import { logActivity } from '../activities/activity.service.js';
import { FollowUpModel, OPEN_FOLLOWUP_STATUSES, refreshNextFollowUp } from '../followups/followup.model.js';
import { AttributionNodeModel, DIMENSIONS, type AttributionSnapshot } from '../marketing/attributionNode.model.js';
import type { AttributionTouchpoint, TouchOrigin } from '../marketing/touchpoint.model.js';
import { leadAssigned as notifyAssigned, leadReinquired } from '../notifications/triggers.js';
import { getOrgSettings } from '../organizations/orgSettings.js';
import { UserModel } from '../users/user.model.js';
import { loadLead } from './lead.access.js';
import { LeadInquiryModel, type ReinquiryPolicy } from './inquiry.model.js';
import { LeadModel } from './lead.model.js';

type Snapshot = AttributionSnapshot;
type Owner = { counsellor?: Types.ObjectId | null; manager?: Types.ObjectId | null };

export interface InquiryDetails {
  channel: TouchOrigin;
  occurredAt?: Date | undefined;
  leadSource?: string | undefined;
  campaignName?: string | undefined;
  provider?: string | undefined;
  externalLeadId?: string | undefined;
  idempotencyKey?: string | undefined;
  notes?: string | undefined;
}

const isDuplicateKey = (err: unknown) => typeof err === 'object' && err !== null && 'code' in err && (err as { code?: number }).code === 11000;

/** Idempotency: an inquiry already recorded under this key (provider event ID, Idempotency-Key header). */
export async function findInquiryByKey(organizationId: Types.ObjectId, idempotencyKey: string | undefined) {
  if (!idempotencyKey) return null;
  return LeadInquiryModel.findOne({ organizationId, idempotencyKey }).select('leadId sequence isReinquiry').lean();
}

/** Copies the facts of the touchpoints that came with this inquiry (the latest one carries the attribution). */
function fromTouches(touches: AttributionTouchpoint[]) {
  const last = touches[touches.length - 1];
  const raw = (last?.raw ?? {}) as Record<string, string | undefined>;
  const snap = Object.fromEntries(DIMENSIONS.map((d) => [d, { l1: last?.[d]?.l1 ?? undefined, l2: last?.[d]?.l2 ?? undefined, l3: last?.[d]?.l3 ?? undefined }])) as Snapshot;
  return {
    ...snap,
    touchpointIds: touches.map((t) => t._id),
    campaignExternalId: last?.campaignExternalId ?? undefined,
    adsetExternalId: last?.adsetExternalId ?? undefined,
    adExternalId: last?.adExternalId ?? undefined,
    formExternalId: last?.leadFormExternalId ?? undefined,
    provider: last?.provider ?? undefined,
    utm: { source: raw.utm_source, medium: raw.utm_medium, campaign: raw.utm_campaign, term: raw.utm_term, content: raw.utm_content },
    landingPage: raw.landing_url ?? raw.page_url,
    referrer: raw.referrer,
  };
}

/**
 * Records the inquiry that created a lead (sequence 1). Returns null when the idempotency key was
 * already used (a concurrent retry recorded it first).
 */
export async function recordFirstInquiry(
  ctx: ServiceContext,
  lead: { _id: Types.ObjectId; assignedCounsellor?: Types.ObjectId | null; assignedManager?: Types.ObjectId | null },
  details: InquiryDetails,
  touches: AttributionTouchpoint[],
) {
  const occurredAt = details.occurredAt ?? new Date();
  try {
    const inquiry = await LeadInquiryModel.create({
      organizationId: ctx.organizationId,
      leadId: lead._id,
      sequence: 1,
      isReinquiry: false,
      status: 'handled',
      ...fromTouches(touches),
      ...details,
      provider: details.provider ?? fromTouches(touches).provider,
      occurredAt,
      currentOwner: { counsellor: lead.assignedCounsellor ?? undefined, manager: lead.assignedManager ?? undefined },
      assignment: { action: 'none', reason: 'New lead' },
      requestId: ctx.meta.requestId,
      createdBy: ctx.userId,
    });
    await LeadModel.updateOne(
      { organizationId: ctx.organizationId, _id: lead._id },
      { $set: { inquiryCount: 1, firstInquiryAt: occurredAt, lastInquiryAt: occurredAt, lastInquiryChannel: details.channel } },
    );
    return inquiry;
  } catch (err) {
    if (isDuplicateKey(err)) return null;
    throw err;
  }
}

async function isActiveUser(organizationId: Types.ObjectId, id: Types.ObjectId | null | undefined) {
  return !!id && !!(await UserModel.exists({ organizationId, _id: id, isActive: true }));
}

/**
 * Applies the organization's re-inquiry policy. Stage, notes, tasks and history are never touched;
 * ownership only changes under `reassign_if_unavailable` when the current owner is missing or inactive.
 */
async function applyPolicy(
  ctx: ServiceContext,
  lead: { _id: Types.ObjectId; leadNumber: number; fullName?: string | null; branchId?: Types.ObjectId | null; assignedCounsellor?: Types.ObjectId | null; assignedManager?: Types.ObjectId | null },
  policy: ReinquiryPolicy,
  incomingAssignee: Types.ObjectId | undefined,
): Promise<{ action: 'kept' | 'follow_up_created' | 'queued' | 'reassigned'; reason: string; owner: Owner; status: 'new' | 'pending_review' }> {
  const owner: Owner = { counsellor: lead.assignedCounsellor ?? null, manager: lead.assignedManager ?? null };
  const ownerActive = await isActiveUser(ctx.organizationId, owner.counsellor);

  if (policy === 'reassign_if_unavailable' && !ownerActive) {
    if (incomingAssignee && (await isActiveUser(ctx.organizationId, incomingAssignee))) {
      await LeadModel.updateOne({ organizationId: ctx.organizationId, _id: lead._id }, { assignedCounsellor: incomingAssignee, assignedAt: new Date(), updatedBy: ctx.userId });
      await FollowUpModel.updateMany({ organizationId: ctx.organizationId, leadId: lead._id, status: { $in: OPEN_FOLLOWUP_STATUSES } }, { assignedTo: incomingAssignee });
      await logActivity(ctx, {
        leadId: lead._id,
        type: owner.counsellor ? 'lead_reassigned' : 'lead_assigned',
        title: 'Counsellor assigned (re-inquiry rule)',
        previousValue: owner.counsellor ? { id: owner.counsellor.toString() } : null,
        newValue: { id: incomingAssignee.toString() },
        metadata: { role: 'counsellor', rule: 'reassign_if_unavailable' },
      });
      await notifyAssigned(ctx.organizationId, lead, { counsellor: incomingAssignee }, ctx.userId);
      return { action: 'reassigned', reason: owner.counsellor ? 'Previous counsellor is inactive' : 'Lead had no counsellor', owner: { ...owner, counsellor: incomingAssignee }, status: 'new' };
    }
    return { action: 'queued', reason: 'Owner unavailable and no default assignee configured', owner, status: 'pending_review' };
  }
  if (policy === 'review_queue') return { action: 'queued', reason: 'Organization routes re-inquiries to the review queue', owner, status: 'pending_review' };
  if (policy === 'follow_up_owner' && ownerActive && owner.counsellor) {
    await FollowUpModel.create({
      organizationId: ctx.organizationId,
      leadId: lead._id,
      branchId: lead.branchId ?? undefined,
      assignedTo: owner.counsellor,
      dueAt: new Date(),
      followUpType: 'call',
      status: 'pending',
      nextAction: 'Contact again: new enquiry received',
      createdBy: ctx.userId,
    });
    await refreshNextFollowUp(ctx.organizationId, lead._id);
    return { action: 'follow_up_created', reason: 'Follow-up created for the existing counsellor', owner, status: 'new' };
  }
  return { action: 'kept', reason: ownerActive ? 'Kept with the existing counsellor' : 'Kept; lead has no active counsellor', owner, status: ownerActive ? 'new' : 'pending_review' };
}

/**
 * Records a re-inquiry on an existing lead: the lead keeps its identity, stage, owner, notes and
 * tasks; a new inquiry (with its own attribution snapshot and the previous latest attribution) is
 * added; counters are updated atomically; the owner is notified. Returns null for a replayed key.
 */
export async function recordReinquiry(
  ctx: ServiceContext,
  leadId: Types.ObjectId,
  details: InquiryDetails,
  /** Runs only after the inquiry is reserved (so a replayed key changes nothing); returns the recorded touchpoints. */
  applyChanges: () => Promise<AttributionTouchpoint[]>,
  opts: { incomingAssignee?: Types.ObjectId | undefined; previousAttribution?: Snapshot | undefined },
) {
  const lead = await LeadModel.findOne({ organizationId: ctx.organizationId, _id: leadId })
    .select('leadNumber fullName branchId assignedCounsellor assignedManager inquiryCount firstInquiryAt createdAt')
    .lean();
  if (!lead) throw ApiError.notFound('Lead');
  const occurredAt = details.occurredAt ?? new Date();
  const { reinquiryPolicy } = await getOrgSettings(ctx.organizationId);
  const previousOwner: Owner = { counsellor: lead.assignedCounsellor ?? undefined, manager: lead.assignedManager ?? undefined };

  // Reserve the inquiry first: if the idempotency key was used, nothing else happens.
  let inquiry;
  try {
    inquiry = await LeadInquiryModel.create({
      organizationId: ctx.organizationId,
      leadId,
      sequence: 0, // set below from the atomic counter
      isReinquiry: true,
      ...details,
      occurredAt,
      previousAttribution: opts.previousAttribution,
      previousOwner,
      requestId: ctx.meta.requestId,
      createdBy: ctx.userId,
    });
  } catch (err) {
    if (isDuplicateKey(err)) return null;
    throw err;
  }

  const touches = await applyChanges();
  const facts = fromTouches(touches);
  const updated = await LeadModel.findOneAndUpdate(
    { organizationId: ctx.organizationId, _id: leadId },
    {
      $inc: { inquiryCount: 1 },
      $max: { lastInquiryAt: occurredAt },
      $min: { firstInquiryAt: lead.firstInquiryAt ?? lead.createdAt ?? occurredAt },
      $set: { lastInquiryChannel: details.channel, lastActivityAt: new Date(), updatedBy: ctx.userId },
    },
    { returnDocument: 'after', projection: { inquiryCount: 1 } },
  );
  const sequence = updated?.inquiryCount ?? (lead.inquiryCount ?? 1) + 1;

  const decision = await applyPolicy(ctx, lead, reinquiryPolicy, opts.incomingAssignee);
  await LeadInquiryModel.updateOne(
    { organizationId: ctx.organizationId, _id: inquiry._id },
    {
      $set: {
        ...facts,
        provider: details.provider ?? facts.provider,
        sequence,
        status: decision.status,
        currentOwner: { counsellor: decision.owner.counsellor ?? undefined, manager: decision.owner.manager ?? undefined },
        assignment: { policy: reinquiryPolicy, action: decision.action, reason: decision.reason },
      },
    },
  );
  await leadReinquired(ctx.organizationId, lead, { counsellor: decision.owner.counsellor, manager: decision.owner.manager }, { channel: details.channel, count: sequence }, ctx.userId);
  return { inquiryId: inquiry._id, sequence, decision };
}

/**
 * Merge: the kept lead takes the duplicate's inquiries; sequences and counters are rebuilt in time
 * order (the merged-in contact's earlier enquiries count as re-inquiries of the kept lead).
 */
export async function mergeInquiries(organizationId: Types.ObjectId, fromLeadId: Types.ObjectId, toLeadId: Types.ObjectId) {
  await LeadInquiryModel.updateMany({ organizationId, leadId: fromLeadId }, { leadId: toLeadId });
  const all = await LeadInquiryModel.find({ organizationId, leadId: toLeadId }).sort({ occurredAt: 1, _id: 1 }).select('occurredAt channel').lean();
  if (!all.length) return;
  await LeadInquiryModel.bulkWrite(
    all.map((inq, i) => ({ updateOne: { filter: { organizationId, _id: inq._id }, update: { $set: { sequence: i + 1, isReinquiry: i > 0 } } } })),
  );
  const last = all[all.length - 1]!;
  await LeadModel.updateOne(
    { organizationId, _id: toLeadId },
    { $set: { inquiryCount: all.length, firstInquiryAt: all[0]!.occurredAt, lastInquiryAt: last.occurredAt, lastInquiryChannel: last.channel } },
  );
}

// ---------------------------------------------------------------- views

async function labels(organizationId: Types.ObjectId, snaps: (Snapshot | undefined | null)[]) {
  const ids = snaps.flatMap((s) => DIMENSIONS.flatMap((d) => [s?.[d]?.l1, s?.[d]?.l2, s?.[d]?.l3])).filter((x): x is Types.ObjectId => !!x);
  const nodes = ids.length ? await AttributionNodeModel.find({ organizationId, _id: { $in: ids } }).select('label').lean() : [];
  const map = new Map(nodes.map((n) => [n._id.toString(), n.label]));
  return (s?: Snapshot | null) =>
    Object.fromEntries(DIMENSIONS.map((d) => [d, { primary: map.get(String(s?.[d]?.l1)) ?? null, secondary: map.get(String(s?.[d]?.l2)) ?? null, tertiary: map.get(String(s?.[d]?.l3)) ?? null }]));
}

/** Inquiry history of a lead the caller can see (scope enforced by loadLead). */
export async function listLeadInquiries(ctx: ServiceContext, leadId: string) {
  const lead = await loadLead(ctx, leadId);
  const items = await LeadInquiryModel.find({ organizationId: ctx.organizationId, leadId: lead._id })
    .sort({ occurredAt: -1, sequence: -1 })
    .limit(200)
    .populate([
      { path: 'previousOwner.counsellor currentOwner.counsellor createdBy handledBy', select: 'fullName', match: { organizationId: ctx.organizationId } },
    ])
    .select('-organizationId -__v -idempotencyKey')
    .lean();
  const label = await labels(ctx.organizationId, [...items.flatMap((i) => [i as unknown as Snapshot, i.previousAttribution as Snapshot]), lead.attribution as Snapshot, lead.latestAttribution as Snapshot]);
  return {
    summary: {
      totalInquiries: lead.inquiryCount ?? 1,
      reinquiryCount: Math.max(0, (lead.inquiryCount ?? 1) - 1),
      firstInquiryAt: lead.firstInquiryAt ?? lead.get('createdAt'),
      lastInquiryAt: lead.lastInquiryAt ?? lead.get('createdAt'),
      originalAttribution: label(lead.attribution as Snapshot),
      latestAttribution: label(lead.latestAttribution as Snapshot),
    },
    items: items.map((i) => ({
      ...i,
      hierarchy: label(i as unknown as Snapshot),
      previousHierarchy: i.previousAttribution ? label(i.previousAttribution as Snapshot) : null,
    })),
  };
}

/** Marks a queued re-inquiry as handled (anyone who can update the lead). */
export async function markInquiryHandled(ctx: ServiceContext, leadId: string, inquiryId: string) {
  const lead = await loadLead(ctx, leadId);
  if (!Types.ObjectId.isValid(inquiryId)) throw ApiError.notFound('Inquiry');
  const res = await LeadInquiryModel.updateOne(
    { organizationId: ctx.organizationId, leadId: lead._id, _id: new Types.ObjectId(inquiryId) },
    { status: 'handled', handledBy: ctx.userId, handledAt: new Date() },
  );
  if (!res.matchedCount) throw ApiError.notFound('Inquiry');
}
