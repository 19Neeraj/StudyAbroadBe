import { Types } from 'mongoose';
import type { z } from '../../docs/zod.js';
import type { ServiceContext } from '../../types/auth.js';
import { canAccessBranch } from '../../utils/access.js';
import { ApiError } from '../../utils/ApiError.js';
import { randomToken } from '../../utils/crypto.js';
import { buildPagination, escapeRegex, toPaging } from '../../utils/pagination.js';
import { logActivity } from '../activities/activity.service.js';
import { recordAudit } from '../audit/audit.service.js';
import { BranchModel } from '../branches/branch.model.js';
import { nextSequence } from '../counters/counter.model.js';
import { markContacted } from '../leads/lead.contact.js';
import { createLead, getLead } from '../leads/lead.service.js';
import { createLeadBody } from '../leads/lead.validation.js';
import { getOrgSettings } from '../organizations/orgSettings.js';
import { assertLookupValues } from '../settings/lookup.service.js';
import { ActorUnavailableError, integrationActor } from '../marketing/actor.js';
import { outcomesForLeads } from '../marketing/reports.service.js';
import { EventModel, EventRegistrationModel } from './event.model.js';
import type { checkInBody, createEventBody, eventListQuery, publicRegisterBody, registerBody, registrationListQuery, updateEventBody } from './event.validation.js';

/** Organization-wide users see every event; others see their branches' events and org-wide ones. */
function scope(ctx: ServiceContext) {
  if (ctx.dataScope === 'organization' || ctx.isSuperAdmin) return {};
  return { $or: [{ branchId: null }, { branchId: { $in: ctx.branchIds } }] };
}

async function loadEvent(ctx: ServiceContext, id: string) {
  if (!Types.ObjectId.isValid(id)) throw ApiError.notFound('Event');
  const event = await EventModel.findOne({ organizationId: ctx.organizationId, _id: id, deletedAt: null, ...scope(ctx) });
  if (!event) throw ApiError.notFound('Event');
  return event;
}

async function assertRefs(ctx: ServiceContext, input: { eventType?: string | undefined; branchId?: string | null | undefined; countries?: string[] | undefined }) {
  if (input.eventType) await assertLookupValues(ctx, { eventType: { type: 'event_type', value: input.eventType } });
  for (const c of input.countries ?? []) await assertLookupValues(ctx, { countries: { type: 'country', value: c } });
  if (input.branchId) {
    if (!canAccessBranch(ctx, input.branchId)) throw ApiError.forbidden('You cannot use a branch outside your own branches');
    if (!(await BranchModel.exists({ organizationId: ctx.organizationId, _id: input.branchId, isActive: true }))) throw ApiError.validation([{ field: 'body.branchId', message: 'Branch not found' }]);
  }
}

async function counts(organizationId: Types.ObjectId, eventIds: Types.ObjectId[]) {
  const rows = await EventRegistrationModel.aggregate<{ _id: { e: Types.ObjectId; s: string }; n: number }>([
    { $match: { organizationId, eventId: { $in: eventIds } } },
    { $group: { _id: { e: '$eventId', s: '$status' }, n: { $sum: 1 } } },
  ]);
  return (id: Types.ObjectId) => {
    const of = (s: string) => rows.find((r) => r._id.e.equals(id) && r._id.s === s)?.n ?? 0;
    return { registered: of('registered') + of('attended') + of('no_show'), attended: of('attended'), noShow: of('no_show'), cancelled: of('cancelled') };
  };
}

function dto(e: Record<string, unknown>) {
  const { organizationId: _o, __v: _v, deletedAt: _d, ...rest } = e;
  return rest;
}

export async function listEvents(ctx: ServiceContext, q: z.infer<typeof eventListQuery>) {
  const filter: Record<string, unknown> = { organizationId: ctx.organizationId, deletedAt: null, ...scope(ctx) };
  if (q.status?.length) filter.status = { $in: q.status };
  if (q.eventType) filter.eventType = q.eventType;
  if (q.branchId) filter.branchId = new Types.ObjectId(q.branchId);
  const now = new Date();
  if (q.when === 'upcoming') filter.endAt = { $gte: now };
  if (q.when === 'past') filter.endAt = { $lt: now };
  if (q.search) filter.name = { $regex: escapeRegex(q.search), $options: 'i' };
  const { skip, limit } = toPaging(q);
  const sort = q.when === 'upcoming' ? { startAt: 1 as const, _id: 1 as const } : { startAt: -1 as const, _id: -1 as const };
  const [items, total] = await Promise.all([
    EventModel.find(filter).sort(sort).skip(skip).limit(limit).populate({ path: 'branchId', select: 'name', match: { organizationId: ctx.organizationId } }).lean(),
    EventModel.countDocuments(filter),
  ]);
  const c = await counts(ctx.organizationId, items.map((i) => i._id));
  return { items: items.map((i) => ({ ...dto(i as unknown as Record<string, unknown>), branch: i.branchId ?? null, counts: c(i._id) })), pagination: buildPagination(q.page, limit, total) };
}

/** Event with registration counts and outcome/ROI figures for the people who registered. */
export async function getEvent(ctx: ServiceContext, id: string) {
  const event = await loadEvent(ctx, id);
  const match = { organizationId: ctx.organizationId };
  await event.populate([{ path: 'branchId', select: 'name', match }, { path: 'universityIds', select: 'name country', match }, { path: 'ownerId', select: 'fullName', match }]);
  const c = (await counts(ctx.organizationId, [event._id]))(event._id);
  const regs = await EventRegistrationModel.find({ organizationId: ctx.organizationId, eventId: event._id, status: { $ne: 'cancelled' } }).select('leadId newLead').lean();
  const { currency: orgCurrency } = await getOrgSettings(ctx.organizationId);
  const currency = event.cost?.currency ?? orgCurrency;
  const outcomes = await outcomesForLeads(ctx, regs.map((r) => r.leadId), currency);
  const newLeads = regs.filter((r) => r.newLead).length;
  const cost = typeof event.cost?.amount === 'number' ? event.cost.amount : null;
  const div = (a: number | null, b: number) => (a === null || b === 0 ? null : a / b);
  const obj = event.toObject() as unknown as Record<string, unknown>;
  return {
    ...dto(obj),
    branch: obj.branchId ?? null,
    universities: obj.universityIds ?? [],
    owner: obj.ownerId ?? null,
    counts: { ...c, newLeads, existingLeads: regs.length - newLeads },
    results: {
      currency,
      ...outcomes,
      attendanceRate: c.registered ? Math.round((c.attended / c.registered) * 1000) / 10 : null,
      cost,
      costPerRegistration: div(cost, c.registered),
      costPerNewLead: div(cost, newLeads),
      costPerApplication: div(cost, outcomes.applications),
      roas: cost === null || cost === 0 ? null : outcomes.revenue / cost,
    },
  };
}

export async function createEvent(ctx: ServiceContext, input: z.infer<typeof createEventBody>) {
  await assertRefs(ctx, input);
  if (input.endAt < input.startAt) throw ApiError.validation([{ field: 'body.endAt', message: 'The event must end after it starts' }]);
  const event = await EventModel.create({
    ...input,
    branchId: input.branchId ?? (ctx.dataScope !== 'organization' ? ctx.branchIds[0] : undefined),
    organizationId: ctx.organizationId,
    eventNumber: await nextSequence(ctx.organizationId, 'event'),
    ownerId: input.ownerId ?? ctx.userId,
    createdBy: ctx.userId,
    updatedBy: ctx.userId,
  });
  await recordAudit(ctx, { entityType: 'event', entityId: event._id, action: 'event.created', metadata: { name: event.name } });
  return getEvent(ctx, event._id.toString());
}

export async function updateEvent(ctx: ServiceContext, id: string, input: z.infer<typeof updateEventBody>) {
  const event = await loadEvent(ctx, id);
  await assertRefs(ctx, input);
  const start = input.startAt ?? event.startAt;
  const end = input.endAt ?? event.endAt;
  if (end < start) throw ApiError.validation([{ field: 'body.endAt', message: 'The event must end after it starts' }]);
  const before = event.toObject();
  event.set({ ...input, updatedBy: ctx.userId });
  await event.save();
  await recordAudit(ctx, { entityType: 'event', entityId: event._id, action: 'event.updated', oldValue: Object.fromEntries(Object.keys(input).map((k) => [k, (before as Record<string, unknown>)[k]])), newValue: input });
  return getEvent(ctx, id);
}

export async function deleteEvent(ctx: ServiceContext, id: string) {
  const event = await loadEvent(ctx, id);
  if (await EventRegistrationModel.exists({ organizationId: ctx.organizationId, eventId: event._id })) throw ApiError.conflict('This event has registrations; cancel it instead of deleting it');
  event.set({ deletedAt: new Date(), updatedBy: ctx.userId, publicSlug: null, registrationOpen: false });
  await event.save();
  await recordAudit(ctx, { entityType: 'event', entityId: event._id, action: 'event.deleted' });
}

/** Turns the public registration page on (new link) or off. */
export async function setPublicRegistration(ctx: ServiceContext, id: string, open: boolean) {
  const event = await loadEvent(ctx, id);
  event.set({ registrationOpen: open, publicSlug: open ? (event.publicSlug ?? randomToken(12)) : event.publicSlug, updatedBy: ctx.userId });
  await event.save();
  await recordAudit(ctx, { entityType: 'event', entityId: event._id, action: open ? 'event.registration_opened' : 'event.registration_closed' });
  return getEvent(ctx, id);
}

async function assertCapacity(organizationId: Types.ObjectId, event: { _id: Types.ObjectId; capacity?: number | null }) {
  if (!event.capacity) return;
  const taken = await EventRegistrationModel.countDocuments({ organizationId, eventId: event._id, status: { $ne: 'cancelled' } });
  if (taken >= event.capacity) throw ApiError.conflict('This event is full');
}

/**
 * Registers a person: an existing lead (leadId) or contact details, which go through the normal
 * duplicate rules (an existing lead gets a repeat enquiry with source "event", never a duplicate).
 */
async function register(ctx: ServiceContext, event: Awaited<ReturnType<typeof loadEvent>> | InstanceType<typeof EventModel>, input: z.infer<typeof registerBody>, source: 'staff' | 'public_form' | 'walk_in', extra: { raw?: Record<string, string | undefined>; consent?: { analytics?: boolean | undefined; ads?: boolean | undefined; method?: string | undefined } } = {}) {
  if (event.status === 'cancelled') throw ApiError.conflict('This event was cancelled');
  let leadId: Types.ObjectId;
  let newLead = false;
  if (input.leadId) {
    const lead = await getLead(ctx, input.leadId);
    leadId = new Types.ObjectId(String(lead._id));
  } else {
    const parsed = createLeadBody.safeParse({
      ...input.contact,
      leadSource: 'event',
      campaign: event.name,
      leadForm: `Event #${event.eventNumber}`,
      branchId: event.branchId?.toString(),
      notes: input.notes,
      duplicateAction: 'keep_existing',
    });
    if (!parsed.success) throw ApiError.validation(parsed.error.issues.map((i) => ({ field: `body.contact.${i.path.join('.')}`, message: i.message })));
    const result = await createLead(ctx, parsed.data, { touchpoints: [{ origin: 'event', leadSource: 'event', campaignName: event.name, raw: extra.raw, consent: extra.consent }] });
    leadId = result.leadId;
    newLead = result.outcome === 'created';
  }
  const existing = await EventRegistrationModel.findOne({ organizationId: ctx.organizationId, eventId: event._id, leadId });
  if (existing && existing.status !== 'cancelled') return { registration: existing, alreadyRegistered: true };
  await assertCapacity(ctx.organizationId, event);
  const lead = await getLead(ctx, leadId).catch(() => null);
  const snapshot = { fullName: lead?.fullName ?? [input.contact?.firstName, input.contact?.lastName].filter(Boolean).join(' '), phone: lead?.phone ?? undefined, email: lead?.email ?? undefined };
  const attended = source === 'walk_in';
  const reg = existing
    ? Object.assign(existing, { status: attended ? 'attended' : 'registered', source, registeredAt: new Date(), ...(attended ? { checkedInAt: new Date(), checkedInBy: ctx.userId } : {}) })
    : new EventRegistrationModel({ organizationId: ctx.organizationId, eventId: event._id, leadId, ...snapshot, source, newLead, notes: input.notes, createdBy: ctx.userId, ...(attended ? { status: 'attended', checkedInAt: new Date(), checkedInBy: ctx.userId } : {}) });
  await reg.save();
  await logActivity(ctx, { leadId, type: 'event_registered', title: `Registered for ${event.name}`, metadata: { eventId: event._id.toString(), source } });
  if (attended) {
    await logActivity(ctx, { leadId, type: 'event_attended', title: `Attended ${event.name}`, metadata: { eventId: event._id.toString() } });
    await markContacted(ctx.organizationId, leadId);
  }
  return { registration: reg, alreadyRegistered: false };
}

export async function registerByStaff(ctx: ServiceContext, id: string, input: z.infer<typeof registerBody>) {
  const event = await loadEvent(ctx, id);
  const { registration, alreadyRegistered } = await register(ctx, event, input, input.walkIn ? 'walk_in' : 'staff');
  return { registration: registration.toObject(), alreadyRegistered };
}

export async function listRegistrations(ctx: ServiceContext, id: string, q: z.infer<typeof registrationListQuery>) {
  const event = await loadEvent(ctx, id);
  const filter: Record<string, unknown> = { organizationId: ctx.organizationId, eventId: event._id };
  if (q.status?.length) filter.status = { $in: q.status };
  if (q.search) {
    const s = escapeRegex(q.search);
    filter.$or = [{ fullName: { $regex: s, $options: 'i' } }, { phone: { $regex: s.replace(/\D/g, '') || s } }, { email: { $regex: s, $options: 'i' } }];
  }
  const { skip, limit } = toPaging(q);
  const [items, total] = await Promise.all([
    EventRegistrationModel.find(filter).sort({ status: 1, fullName: 1 }).skip(skip).limit(limit).populate([{ path: 'leadId', select: 'leadNumber leadStage', match: { organizationId: ctx.organizationId } }, { path: 'checkedInBy', select: 'fullName', match: { organizationId: ctx.organizationId } }]).lean(),
    EventRegistrationModel.countDocuments(filter),
  ]);
  return { items: items.map(({ organizationId: _o, __v: _v, leadId, ...r }) => ({ ...r, lead: leadId ?? null })), pagination: buildPagination(q.page, limit, total) };
}

export async function checkIn(ctx: ServiceContext, id: string, registrationId: string, input: z.infer<typeof checkInBody>) {
  const event = await loadEvent(ctx, id);
  const reg = await EventRegistrationModel.findOne({ organizationId: ctx.organizationId, eventId: event._id, _id: registrationId });
  if (!reg) throw ApiError.notFound('Registration');
  const was = reg.status;
  reg.set({ status: input.status, notes: input.notes ?? reg.notes, ...(input.status === 'attended' ? { checkedInAt: reg.checkedInAt ?? new Date(), checkedInBy: reg.checkedInBy ?? ctx.userId } : {}) });
  await reg.save();
  if (input.status === 'attended' && was !== 'attended') {
    await logActivity(ctx, { leadId: reg.leadId, type: 'event_attended', title: `Attended ${event.name}`, metadata: { eventId: event._id.toString() } });
    await markContacted(ctx.organizationId, reg.leadId);
  }
  return reg.toObject();
}

// ------------------------------------------------------------------ public registration page

async function publicEvent(slug: string) {
  if (!/^[A-Za-z0-9_-]{8,40}$/.test(slug)) return null;
  return EventModel.findOne({ publicSlug: slug, deletedAt: null }).setOptions({ skipTenantGuard: true });
}

/** What the public page shows (no internal data). */
export async function getPublicEvent(slug: string) {
  const e = await publicEvent(slug);
  if (!e || e.status === 'draft') throw ApiError.notFound('Event');
  const taken = e.capacity ? await EventRegistrationModel.countDocuments({ organizationId: e.organizationId, eventId: e._id, status: { $ne: 'cancelled' } }) : 0;
  return {
    name: e.name,
    description: e.description ?? null,
    startAt: e.startAt,
    endAt: e.endAt,
    mode: e.mode,
    venue: e.mode === 'online' ? null : e.venue,
    open: e.registrationOpen && e.status === 'published' && e.endAt > new Date() && (!e.capacity || taken < e.capacity),
    full: !!e.capacity && taken >= e.capacity,
  };
}

/** Public sign-up: runs as the event's creator; never reveals whether the person was already known. */
export async function registerPublic(slug: string, input: z.infer<typeof publicRegisterBody>) {
  const event = await publicEvent(slug);
  if (!event || event.status !== 'published' || !event.registrationOpen || event.endAt < new Date()) throw ApiError.notFound('Registration is not open');
  let ctx: ServiceContext;
  try {
    ctx = await integrationActor(event.organizationId as Types.ObjectId, event.createdBy);
  } catch (err) {
    if (err instanceof ActorUnavailableError) throw ApiError.conflict('Registration is temporarily unavailable');
    throw err;
  }
  await register(ctx, event, { contact: input.contact, notes: input.notes }, 'public_form', { raw: input.tracking, consent: input.consent });
  return { status: 'registered' as const, onlineUrl: event.mode !== 'in_person' ? (event.onlineUrl ?? null) : null };
}
