import { Types } from 'mongoose';
import type { z } from '../../docs/zod.js';
import type { ServiceContext } from '../../types/auth.js';
import { ownershipScope } from '../../utils/access.js';
import { ApiError } from '../../utils/ApiError.js';
import { buildPagination, toPaging, toSort } from '../../utils/pagination.js';
import { addDays } from '../../utils/time.js';
import { logActivity } from '../activities/activity.service.js';
import { recordAudit } from '../audit/audit.service.js';
import { nextSequence } from '../counters/counter.model.js';
import { resolveAssignee } from '../leads/lead.assignment.js';
import { advanceLeadToMilestone } from '../leads/lead.progress.js';
import { assertLookupValues, listLookups } from '../settings/lookup.service.js';
import { loadStudent } from '../students/student.service.js';
import { StudentModel } from '../students/student.model.js';
import { CourseModel, UniversityModel } from '../universities/university.model.js';
import { ApplicationModel, ShortlistModel, type SHORTLIST_STATUSES } from './application.model.js';
import type {
  addShortlistBody,
  ApplicationListQuery,
  applicationStatusBody,
  applyFromShortlistBody,
  createApplicationBody,
  offerBody,
  updateApplicationBody,
  updateShortlistBody,
} from './application.validation.js';

type Filter = Record<string, unknown>;
type StudentDoc = Awaited<ReturnType<typeof loadStudent>>;

/** Fallback for organizations whose status values predate the `meta` fields. */
const DEFAULT_STATUS_META: Record<string, { leadMilestone?: 'application' | 'offer' | 'enrolment'; isFinal?: boolean }> = {
  submitted: { leadMilestone: 'application' },
  under_review: { leadMilestone: 'application' },
  conditional_offer: { leadMilestone: 'offer' },
  unconditional_offer: { leadMilestone: 'offer' },
  rejected: { isFinal: true },
  withdrawn: { isFinal: true },
  enrolled: { leadMilestone: 'enrolment', isFinal: true },
};

/** Shortlist entry status implied by an application status. */
const SHORTLIST_FOR_STATUS: Record<string, (typeof SHORTLIST_STATUSES)[number]> = {
  draft: 'application_started',
  documents_pending: 'application_started',
  submitted: 'applied',
  under_review: 'applied',
  conditional_offer: 'offer_received',
  unconditional_offer: 'offer_received',
  rejected: 'rejected',
  withdrawn: 'withdrawn',
  enrolled: 'enrolled',
};

async function statusMeta(ctx: ServiceContext) {
  const items = await listLookups(ctx, 'application_status', true);
  return new Map(items.map((i) => [i.key, { ...DEFAULT_STATUS_META[i.key], ...(i.meta as object) } as { leadMilestone?: 'application' | 'offer' | 'enrolment'; isFinal?: boolean }]));
}

const ownership = (s: StudentDoc) => ({
  studentId: s._id,
  leadId: s.leadId,
  branchId: s.branchId ?? undefined,
  assignedCounsellor: s.assignedCounsellor ?? undefined,
  assignedManager: s.assignedManager ?? undefined,
});

async function loadUniversity(ctx: ServiceContext, universityId: string, courseId?: string | null) {
  const uni = await UniversityModel.findOne({ organizationId: ctx.organizationId, _id: universityId }).lean();
  if (!uni) throw ApiError.validation([{ field: 'body.universityId', message: 'University not found' }]);
  let course = null;
  if (courseId) {
    course = await CourseModel.findOne({ organizationId: ctx.organizationId, _id: courseId, universityId: uni._id }).lean();
    if (!course) throw ApiError.validation([{ field: 'body.courseId', message: 'Course not found at this university' }]);
  }
  return { uni, course };
}

// ── Shortlist ────────────────────────────────────────────────────────────

const shortlistPopulate = (ctx: ServiceContext) => [
  { path: 'universityId', select: 'name city country ranking', match: { organizationId: ctx.organizationId } },
  { path: 'courseId', select: 'name degreeLevel tuitionFee currency intakes requirements durationMonths', match: { organizationId: ctx.organizationId } },
];
const shortlistDto = ({ universityId, courseId, ...r }: Record<string, unknown>) => ({ ...r, university: universityId ?? null, course: courseId ?? null });

export async function listShortlist(ctx: ServiceContext, studentId: string) {
  const student = await loadStudent(ctx, studentId);
  const items = await ShortlistModel.find({ organizationId: ctx.organizationId, studentId: student._id }).sort({ priority: 1, createdAt: 1 }).populate(shortlistPopulate(ctx)).lean();
  return items.map((i) => shortlistDto(i as never));
}

export async function addToShortlist(ctx: ServiceContext, studentId: string, input: z.infer<typeof addShortlistBody>) {
  const student = await loadStudent(ctx, studentId);
  const { uni, course } = await loadUniversity(ctx, input.universityId, input.courseId);
  if (input.intake) await assertLookupValues(ctx, { intake: { type: 'intake', value: input.intake } });
  let entry;
  try {
    entry = await ShortlistModel.create({ ...input, ...ownership(student), organizationId: ctx.organizationId, country: uni.country, intake: input.intake ?? student.intake ?? undefined, createdBy: ctx.userId });
  } catch (err) {
    if (typeof err === 'object' && err && 'code' in err && err.code === 11000) throw ApiError.conflict('Already shortlisted for this intake');
    throw err;
  }
  await logActivity(ctx, { leadId: student.leadId, studentId: student._id, type: 'shortlist_added', title: 'University shortlisted', newValue: { university: uni.name, course: course?.name ?? null, intake: entry.intake ?? null } });
  await advanceLeadToMilestone(ctx, student.leadId, 'shortlisting', `Shortlisted ${uni.name}`);
  const populated = await ShortlistModel.findOne({ organizationId: ctx.organizationId, _id: entry._id }).populate(shortlistPopulate(ctx)).lean();
  return shortlistDto(populated as never);
}

async function loadShortlistEntry(ctx: ServiceContext, id: string) {
  if (!Types.ObjectId.isValid(id)) throw ApiError.notFound('Shortlist entry');
  const entry = await ShortlistModel.findOne(ownershipScope(ctx, { _id: new Types.ObjectId(id) }));
  if (!entry) throw ApiError.notFound('Shortlist entry');
  return entry;
}

export async function updateShortlist(ctx: ServiceContext, id: string, input: z.infer<typeof updateShortlistBody>) {
  const entry = await loadShortlistEntry(ctx, id);
  if (input.intake) await assertLookupValues(ctx, { intake: { type: 'intake', value: input.intake } });
  const before = entry.status;
  for (const [k, v] of Object.entries(input)) if (v !== undefined) entry.set(k, v === null ? undefined : v);
  await entry.save();
  if (input.status && input.status !== before) {
    await logActivity(ctx, { leadId: entry.leadId, studentId: entry.studentId, type: 'shortlist_updated', title: 'Shortlist status changed', previousValue: before, newValue: input.status });
  }
  const populated = await ShortlistModel.findOne({ organizationId: ctx.organizationId, _id: entry._id }).populate(shortlistPopulate(ctx)).lean();
  return shortlistDto(populated as never);
}

export async function removeFromShortlist(ctx: ServiceContext, id: string) {
  const entry = await loadShortlistEntry(ctx, id);
  if (entry.applicationId) throw ApiError.conflict('An application exists for this entry; withdraw the application instead');
  await ShortlistModel.deleteOne({ organizationId: ctx.organizationId, _id: entry._id });
  await logActivity(ctx, { leadId: entry.leadId, studentId: entry.studentId, type: 'shortlist_updated', title: 'Removed from shortlist' });
}

// ── Applications ─────────────────────────────────────────────────────────

const appPopulate = (ctx: ServiceContext) => {
  const match = { organizationId: ctx.organizationId };
  return [
    { path: 'universityId', select: 'name city country ranking', match },
    { path: 'courseId', select: 'name degreeLevel durationMonths', match },
    { path: 'assignedTo', select: 'fullName', match },
    { path: 'assignedCounsellor', select: 'fullName', match },
  ];
};
type AppDto = Record<string, unknown> & { _id: Types.ObjectId; status: string; university: unknown; course: unknown };
const appDto = ({ universityId, courseId, __v: _v, ...a }: Record<string, unknown>): AppDto => ({ ...(a as { _id: Types.ObjectId; status: string }), university: universityId ?? null, course: courseId ?? null });

export async function getApplication(ctx: ServiceContext, id: string | Types.ObjectId) {
  if (!Types.ObjectId.isValid(id)) throw ApiError.notFound('Application');
  const app = await ApplicationModel.findOne(ownershipScope(ctx, { _id: new Types.ObjectId(id), deletedAt: null })).populate(appPopulate(ctx)).lean();
  if (!app) throw ApiError.notFound('Application');
  return appDto(app as never);
}

async function loadApplicationDoc(ctx: ServiceContext, id: string) {
  if (!Types.ObjectId.isValid(id)) throw ApiError.notFound('Application');
  const app = await ApplicationModel.findOne(ownershipScope(ctx, { _id: new Types.ObjectId(id), deletedAt: null }));
  if (!app) throw ApiError.notFound('Application');
  return app;
}

async function applyStatusSideEffects(ctx: ServiceContext, app: InstanceType<typeof ApplicationModel>, status: string, uniName: string) {
  const meta = (await statusMeta(ctx)).get(status);
  if (meta?.leadMilestone) await advanceLeadToMilestone(ctx, app.leadId, meta.leadMilestone, `Application #${app.applicationNumber} (${uniName}): ${status.replace(/_/g, ' ')}`);
  if (app.shortlistId && SHORTLIST_FOR_STATUS[status]) {
    await ShortlistModel.updateOne({ organizationId: ctx.organizationId, _id: app.shortlistId }, { status: SHORTLIST_FOR_STATUS[status] });
  }
  if (meta?.leadMilestone === 'enrolment') {
    await ApplicationModel.updateOne({ organizationId: ctx.organizationId, _id: app._id }, { enrolmentStatus: 'enrolled' });
    await StudentModel.updateOne({ organizationId: ctx.organizationId, _id: app.studentId }, { status: 'enrolled' });
  }
}

export async function createApplication(ctx: ServiceContext, input: z.infer<typeof createApplicationBody> & { shortlistId?: Types.ObjectId }) {
  const student = await loadStudent(ctx, input.studentId);
  const { uni, course } = await loadUniversity(ctx, input.universityId, input.courseId);
  const status = input.status ?? 'draft';
  await assertLookupValues(ctx, { status: { type: 'application_status', value: status }, intake: { type: 'intake', value: input.intake } });
  const assignedTo = input.assignedTo ? (await resolveAssignee(ctx, input.assignedTo, 'assignedTo'))._id : undefined;
  const intake = input.intake ?? student.intake ?? undefined;
  const deadline = input.applicationDeadline ?? course?.intakes.find((i) => i.intake === intake)?.deadline ?? undefined;

  const app = await ApplicationModel.create({
    ...ownership(student),
    organizationId: ctx.organizationId,
    applicationNumber: await nextSequence(ctx.organizationId, 'application'),
    studentName: student.fullName,
    studentNumber: student.studentNumber,
    universityId: uni._id,
    courseId: course?._id,
    courseName: input.courseName ?? course?.name,
    country: uni.country,
    intake,
    shortlistId: input.shortlistId,
    assignedTo,
    applicationDate: input.applicationDate ?? (status === 'draft' ? undefined : new Date()),
    applicationDeadline: deadline,
    universityApplicationId: input.universityApplicationId,
    status,
    statusChangedAt: new Date(),
    currency: input.currency ?? course?.currency ?? uni.currency,
    tuitionFee: input.tuitionFee ?? course?.tuitionFee ?? undefined,
    scholarship: input.scholarship,
    applicationFee: input.applicationFee ?? course?.applicationFee ?? uni.applicationFee ?? undefined,
    notes: input.notes,
    createdBy: ctx.userId,
    updatedBy: ctx.userId,
  });
  await logActivity(ctx, {
    leadId: student.leadId,
    studentId: student._id,
    type: 'application_created',
    title: `Application #${app.applicationNumber} created`,
    newValue: { university: uni.name, course: app.courseName ?? null, intake: intake ?? null, status },
    metadata: { applicationId: app._id.toString() },
  });
  await recordAudit(ctx, { entityType: 'application', entityId: app._id, action: 'application.created', newValue: { university: uni.name, status } });
  // Starting an application = the lead is in the application stage, whatever the initial status.
  await advanceLeadToMilestone(ctx, student.leadId, 'application', `Application #${app.applicationNumber} to ${uni.name}`);
  await applyStatusSideEffects(ctx, app, status, uni.name);
  return getApplication(ctx, app._id);
}

export async function applyFromShortlist(ctx: ServiceContext, shortlistId: string, input: z.infer<typeof applyFromShortlistBody>) {
  const entry = await loadShortlistEntry(ctx, shortlistId);
  if (entry.applicationId) throw ApiError.conflict('An application already exists for this shortlist entry');
  const app = await createApplication(ctx, {
    ...input,
    studentId: entry.studentId.toString(),
    universityId: entry.universityId.toString(),
    courseId: input.courseId ?? entry.courseId?.toString(),
    intake: input.intake ?? entry.intake ?? undefined,
    shortlistId: entry._id,
  });
  await ShortlistModel.updateOne(
    { organizationId: ctx.organizationId, _id: entry._id },
    { applicationId: app._id, ...(SHORTLIST_FOR_STATUS[app.status] ? {} : { status: 'application_started' }) },
  );
  return app;
}

export async function listApplications(ctx: ServiceContext, q: ApplicationListQuery) {
  const and: Filter[] = [];
  if (q.search) {
    const s = q.search.trim();
    const num = /^(?:#|a-?)?(\d{1,9})$/i.exec(s);
    and.push(num ? { applicationNumber: Number(num[1]) } : { $or: [{ universityApplicationId: s }, { studentName: { $regex: `^${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, $options: 'i' } }] });
  }
  if (q.status?.length) and.push({ status: { $in: q.status } });
  if (q.offerStatus?.length) and.push({ 'offer.status': { $in: q.offerStatus } });
  if (q.studentId) and.push({ studentId: new Types.ObjectId(q.studentId) });
  if (q.universityId) and.push({ universityId: new Types.ObjectId(q.universityId) });
  if (q.country) and.push({ country: q.country });
  if (q.intake) and.push({ intake: q.intake });
  if (q.counsellor) and.push({ assignedCounsellor: new Types.ObjectId(q.counsellor) });
  if (q.branchId) and.push({ branchId: new Types.ObjectId(q.branchId) });
  if (q.assignedTo) and.push({ assignedTo: q.assignedTo === 'me' ? ctx.userId : new Types.ObjectId(q.assignedTo) });
  if (q.deadlineWithinDays !== undefined) and.push({ applicationDeadline: { $gte: new Date(), $lte: addDays(new Date(), q.deadlineWithinDays) } });
  if (q.openOnly === 'true') {
    const finals = [...(await statusMeta(ctx))].filter(([, m]) => m.isFinal).map(([k]) => k);
    and.push({ status: { $nin: finals } });
  }
  const filter = ownershipScope(ctx, { deletedAt: null, ...(and.length ? { $and: and } : {}) });
  const { skip, limit } = toPaging(q);
  const [items, total] = await Promise.all([
    ApplicationModel.find(filter).sort(toSort(q.sortBy, q.sortOrder)).skip(skip).limit(limit).populate(appPopulate(ctx)).lean(),
    ApplicationModel.countDocuments(filter),
  ]);
  return { items: items.map((a) => appDto(a as never)), pagination: buildPagination(q.page, q.limit, total) };
}

/** Counts per status (board columns) within the caller's scope. */
export async function applicationBoard(ctx: ServiceContext) {
  const [statuses, counts] = await Promise.all([
    listLookups(ctx, 'application_status', false),
    ApplicationModel.aggregate<{ _id: string; count: number }>([{ $match: ownershipScope(ctx, { deletedAt: null }) }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
  ]);
  const byKey = new Map(counts.map((c) => [c._id, c.count]));
  return statuses.map((s) => ({ status: s.key, label: s.label, color: s.color ?? null, count: byKey.get(s.key) ?? 0 }));
}

export async function updateApplication(ctx: ServiceContext, id: string, input: z.infer<typeof updateApplicationBody>) {
  const app = await loadApplicationDoc(ctx, id);
  if (input.courseId) await loadUniversity(ctx, app.universityId.toString(), input.courseId);
  if (input.intake) await assertLookupValues(ctx, { intake: { type: 'intake', value: input.intake } });
  const changes: Record<string, unknown> = { ...input };
  if (input.assignedTo) changes.assignedTo = (await resolveAssignee(ctx, input.assignedTo, 'assignedTo'))._id;
  const changed: string[] = [];
  for (const [k, v] of Object.entries(changes)) {
    if (v === undefined) continue;
    if (JSON.stringify(app.get(k) ?? null) === JSON.stringify(v)) continue;
    app.set(k, v === null ? undefined : v);
    changed.push(k);
  }
  if (!changed.length) return getApplication(ctx, app._id);
  app.updatedBy = ctx.userId;
  await app.save();
  await logActivity(ctx, { leadId: app.leadId, studentId: app.studentId, type: 'application_updated', title: `Application #${app.applicationNumber} updated`, metadata: { applicationId: app._id.toString(), fields: changed } });
  await recordAudit(ctx, { entityType: 'application', entityId: app._id, action: 'application.updated', metadata: { fields: changed } });
  return getApplication(ctx, app._id);
}

export async function changeApplicationStatus(ctx: ServiceContext, id: string, input: z.infer<typeof applicationStatusBody>) {
  const app = await loadApplicationDoc(ctx, id);
  await assertLookupValues(ctx, { status: { type: 'application_status', value: input.status } });
  if (app.status === input.status) return getApplication(ctx, app._id);
  const previous = app.status;
  app.status = input.status;
  app.statusChangedAt = new Date();
  if (!app.applicationDate && input.status !== 'draft') app.applicationDate = new Date();
  app.updatedBy = ctx.userId;
  await app.save();
  const uni = await UniversityModel.findOne({ organizationId: ctx.organizationId, _id: app.universityId }).select('name').lean();
  await logActivity(ctx, {
    leadId: app.leadId,
    studentId: app.studentId,
    type: 'application_updated',
    title: `Application #${app.applicationNumber} status changed`,
    previousValue: previous,
    newValue: input.status,
    notes: input.note,
    metadata: { applicationId: app._id.toString(), university: uni?.name },
  });
  await recordAudit(ctx, { entityType: 'application', entityId: app._id, action: 'application.status_changed', oldValue: { status: previous }, newValue: { status: input.status } });
  await applyStatusSideEffects(ctx, app, input.status, uni?.name ?? 'university');
  return getApplication(ctx, app._id);
}

/** Offer details (spec §20). A conditional/unconditional offer moves the lead to the offer stage. */
export async function updateOffer(ctx: ServiceContext, id: string, input: z.infer<typeof offerBody>) {
  const app = await loadApplicationDoc(ctx, id);
  const previous = app.offer?.status ?? 'none';
  const { note, tuitionFee, scholarship, ...offer } = input;
  app.set('offer', { ...(app.toObject().offer ?? {}), ...offer, date: offer.date ?? app.offer?.date ?? (offer.status !== 'none' ? new Date() : undefined) });
  if (tuitionFee !== undefined) app.tuitionFee = tuitionFee;
  if (scholarship !== undefined) app.scholarship = scholarship;
  // Keep the workflow status in step with the offer when matching statuses exist.
  const statusKeys = new Set((await listLookups(ctx, 'application_status', false)).map((s) => s.key));
  const meta = await statusMeta(ctx);
  const target = { conditional: 'conditional_offer', unconditional: 'unconditional_offer', rejected: 'rejected' }[input.status as string];
  const statusChanged = !!target && statusKeys.has(target) && !meta.get(app.status)?.isFinal && app.status !== target;
  if (statusChanged) {
    app.status = target!;
    app.statusChangedAt = new Date();
  }
  app.updatedBy = ctx.userId;
  await app.save();
  const uni = await UniversityModel.findOne({ organizationId: ctx.organizationId, _id: app.universityId }).select('name').lean();
  await logActivity(ctx, {
    leadId: app.leadId,
    studentId: app.studentId,
    type: 'offer_updated',
    title: input.status === 'conditional' || input.status === 'unconditional' ? `Offer received from ${uni?.name ?? 'university'}` : `Offer ${input.status.replace('_', ' ')}`,
    previousValue: previous,
    newValue: input.status,
    notes: note ?? input.conditions,
    metadata: { applicationId: app._id.toString() },
  });
  await recordAudit(ctx, { entityType: 'application', entityId: app._id, action: 'application.offer_updated', oldValue: { offer: previous }, newValue: { offer: input.status } });
  if (statusChanged) await applyStatusSideEffects(ctx, app, app.status, uni?.name ?? 'university');
  else if (input.status === 'conditional' || input.status === 'unconditional') await advanceLeadToMilestone(ctx, app.leadId, 'offer', `Offer from ${uni?.name ?? 'university'}`);
  return getApplication(ctx, app._id);
}

