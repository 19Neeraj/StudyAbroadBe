import { Types } from 'mongoose';
import type { z } from '../../docs/zod.js';
import type { AuthContext, ServiceContext } from '../../types/auth.js';
import { canAccessBranch, hasOrgScope } from '../../utils/access.js';
import { ApiError } from '../../utils/ApiError.js';
import { compileFilterTree } from '../../utils/filterTree.js';
import { buildPagination, toPaging, toSort } from '../../utils/pagination.js';
import { logActivity } from '../activities/activity.service.js';
import { diffFields, recordAudit } from '../audit/audit.service.js';
import { BranchModel } from '../branches/branch.model.js';
import { nextSequence } from '../counters/counter.model.js';
import { buildLeadSearch, loadLead } from '../leads/lead.access.js';
import { getOrgSettings } from '../organizations/orgSettings.js';
import { normalizeContact } from '../leads/lead.duplicates.js';
import { emitLeadEvent } from '../leads/lead.events.js';
import { LeadModel } from '../leads/lead.model.js';
import { assertLookupValues } from '../settings/lookup.service.js';
import { STUDENT_FILTER_FIELDS } from './student.filters.js';
import { StudentModel } from './student.model.js';
import { ApplicationModel, ShortlistModel } from '../applications/application.model.js';
import { DocumentModel } from '../documents/document.model.js';
import { PaymentModel } from '../payments/payment.model.js';
import { VisaModel } from '../visa/visa.model.js';
import type { convertLeadBody, StudentListQuery, updateStudentBody } from './student.validation.js';

type Filter = Record<string, unknown>;

/** Same rules as leads: organization → all; branch → my branches or assigned to me; own → assigned to me. */
export function studentScopeFilter(ctx: AuthContext): Filter {
  const base: Filter = { organizationId: ctx.organizationId, deletedAt: null };
  if (hasOrgScope(ctx)) return base;
  const mine = [{ assignedCounsellor: ctx.userId }, { assignedManager: ctx.userId }];
  if (ctx.dataScope === 'branch') return { ...base, $or: [{ branchId: { $in: ctx.branchIds } }, ...mine] };
  return { ...base, $or: mine };
}

export function scopedStudentFilter(ctx: AuthContext, ...conditions: Filter[]): Filter {
  const scope = studentScopeFilter(ctx);
  const and = conditions.filter((c) => Object.keys(c).length > 0);
  return and.length ? { ...scope, $and: and } : scope;
}

export async function loadStudent(ctx: ServiceContext, id: string | Types.ObjectId) {
  if (!Types.ObjectId.isValid(id)) throw ApiError.notFound('Student');
  const student = await StudentModel.findOne(scopedStudentFilter(ctx, { _id: new Types.ObjectId(id) }));
  if (!student) throw ApiError.notFound('Student');
  return student;
}

const LIST_FIELDS =
  'studentNumber leadId firstName middleName lastName fullName phone whatsappNumber email status branchId assignedCounsellor ' +
  'preferredCountries preferredCourses intake degreeLevel dateOfBirth passport.number education testScores createdAt updatedAt';

const populateRefs = (ctx: ServiceContext) => {
  const match = { organizationId: ctx.organizationId };
  return [
    { path: 'branchId', select: 'name code', match },
    { path: 'assignedCounsellor', select: 'fullName', match },
    { path: 'assignedManager', select: 'fullName', match },
  ];
};

interface Completable {
  phone?: string | null;
  email?: string | null;
  dateOfBirth?: Date | null;
  passport?: { number?: string | null } | null;
  education?: unknown[];
  testScores?: unknown[];
  preferredCountries?: unknown[];
  intake?: string | null;
}

/** Share of the key sections a counsellor needs before applying (personal, passport, education, tests, preference). */
export function profileCompletion(s: Completable): number {
  const checks = [
    !!(s.phone || s.email),
    !!s.dateOfBirth,
    !!s.passport?.number,
    (s.education?.length ?? 0) > 0,
    (s.testScores?.length ?? 0) > 0,
    (s.preferredCountries?.length ?? 0) > 0 && !!s.intake,
  ];
  return Math.round((checks.filter(Boolean).length / checks.length) * 100);
}

function toDto<T extends Completable & { branchId?: unknown; __v?: unknown; education?: unknown[]; testScores?: unknown[] }>(s: T, full = false) {
  const { branchId, __v: _v, ...rest } = s;
  const completion = profileCompletion(s);
  if (full) return { ...rest, branch: branchId ?? null, profileCompletion: completion };
  // List rows don't need the full sections.
  const { education: _e, testScores: _t, ...summary } = rest;
  return { ...summary, branch: branchId ?? null, profileCompletion: completion };
}

export async function getStudent(ctx: ServiceContext, id: string | Types.ObjectId) {
  const student = await StudentModel.findOne(scopedStudentFilter(ctx, { _id: new Types.ObjectId(id) }))
    .select('-deletedAt')
    .populate([...populateRefs(ctx), { path: 'createdBy', select: 'fullName', match: { organizationId: ctx.organizationId } }])
    .lean();
  if (!student) throw ApiError.notFound('Student');
  const lead = await LeadModel.findOne({ organizationId: ctx.organizationId, _id: student.leadId })
    .select('leadNumber leadStage leadStatus leadSource campaign nextFollowUpAt')
    .lean();
  return { ...toDto(student, true), lead };
}

export async function getStudentByLead(ctx: ServiceContext, leadId: Types.ObjectId) {
  return StudentModel.findOne(scopedStudentFilter(ctx, { leadId })).select('_id studentNumber').lean();
}

/**
 * Lead → student (spec §17). Copies contact, interest and test scores into the profile and links both
 * records. One student per lead; a second conversion answers 409 with the existing student id.
 */
export async function convertLead(ctx: ServiceContext, leadId: string, input: z.infer<typeof convertLeadBody>) {
  const lead = await loadLead(ctx, leadId);
  const existing = await StudentModel.findOne({ organizationId: ctx.organizationId, leadId: lead._id }).select('_id').lean();
  if (existing) throw new ApiError(409, 'This lead is already a student', [], 'ALREADY_CONVERTED', { studentId: existing._id.toString() });

  const testScores = [
    lead.ieltsScore != null ? { test: 'ielts', overall: lead.ieltsScore } : null,
    lead.pteScore != null ? { test: 'pte', overall: lead.pteScore } : null,
    lead.toeflScore != null ? { test: 'toefl', overall: lead.toeflScore } : null,
    lead.otherTestScore ? { test: 'other', remarks: lead.otherTestScore } : null,
  ].filter(Boolean);

  let student;
  try {
    student = await StudentModel.create({
      organizationId: ctx.organizationId,
      studentNumber: await nextSequence(ctx.organizationId, 'student'),
      leadId: lead._id,
      branchId: lead.branchId,
      assignedCounsellor: lead.assignedCounsellor,
      assignedManager: lead.assignedManager,
      firstName: lead.firstName,
      lastName: lead.lastName,
      phone: lead.phone,
      whatsappNumber: lead.whatsappNumber,
      email: lead.email,
      city: lead.city,
      state: lead.state,
      country: lead.country,
      preferredCountries: lead.countryInterested ? [lead.countryInterested] : [],
      preferredCourses: lead.courseInterested ? [lead.courseInterested] : [],
      degreeLevel: lead.degreeLevel,
      intake: lead.intake,
      budget: lead.budget,
      testScores,
      notes: [lead.educationDetails ? `Education (from lead): ${lead.educationDetails}` : null, input.notes].filter(Boolean).join('\n\n') || undefined,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
    });
  } catch (err) {
    if (typeof err === 'object' && err && 'code' in err && err.code === 11000) throw ApiError.conflict('This lead is already a student');
    throw err;
  }

  await LeadModel.updateOne({ organizationId: ctx.organizationId, _id: lead._id }, { studentId: student._id, convertedAt: new Date(), lastActivityAt: new Date() });
  await logActivity(ctx, {
    leadId: lead._id,
    studentId: student._id,
    type: 'student_converted',
    title: 'Converted to student',
    notes: input.notes,
    newValue: { studentNumber: student.studentNumber },
  });
  await recordAudit(ctx, { entityType: 'student', entityId: student._id, action: 'student.converted', metadata: { leadId: lead._id.toString(), leadNumber: lead.leadNumber } });
  emitLeadEvent('lead.updated', lead);
  return getStudent(ctx, student._id);
}

function renameKey(value: unknown, from: string, to: string): Filter {
  const walk = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(walk) : v && typeof v === 'object' && v.constructor === Object
      ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k === from ? to : k, walk(x)]))
      : v;
  return walk(value) as Filter;
}

export async function listStudents(ctx: ServiceContext, q: StudentListQuery) {
  const and: Filter[] = [];
  if (q.search) {
    // Same index-friendly search as leads (#number, phone, email prefix, name-word prefixes).
    const { defaultCountryCode } = await getOrgSettings(ctx.organizationId);
    const numbered = /^(?:#|s-?)(\d{1,9})$/i.exec(q.search.trim());
    and.push(numbered ? { studentNumber: Number(numbered[1]) } : renameKey(buildLeadSearch(q.search, defaultCountryCode), 'leadNumber', 'studentNumber'));
  }
  if (q.status) and.push({ status: q.status });
  if (q.branchId) and.push({ branchId: new Types.ObjectId(q.branchId) });
  if (q.assignedUser) and.push({ assignedCounsellor: new Types.ObjectId(q.assignedUser) });
  if (q.country) and.push({ preferredCountries: q.country });
  if (q.intake) and.push({ intake: q.intake });
  if (q.dateFrom || q.dateTo) and.push({ createdAt: { ...(q.dateFrom ? { $gte: q.dateFrom } : {}), ...(q.dateTo ? { $lte: q.dateTo } : {}) } });
  if (q.filter) and.push(compileFilterTree(q.filter, STUDENT_FILTER_FIELDS));

  const filter = scopedStudentFilter(ctx, ...and);
  const { skip, limit } = toPaging(q);
  const [items, total] = await Promise.all([
    StudentModel.find(filter).select(LIST_FIELDS).sort(toSort(q.sortBy, q.sortOrder)).skip(skip).limit(limit).populate(populateRefs(ctx)).lean(),
    StudentModel.countDocuments(filter),
  ]);
  return { items: items.map((s) => toDto(s)), pagination: buildPagination(q.page, q.limit, total) };
}

export async function updateStudent(ctx: ServiceContext, id: string, input: z.infer<typeof updateStudentBody>) {
  const student = await loadStudent(ctx, id);
  const contact = await normalizeContact(ctx, input);
  await assertLookupValues(ctx, {
    degreeLevel: { type: 'degree_level', value: input.degreeLevel },
    intake: { type: 'intake', value: input.intake },
    ...Object.fromEntries((input.preferredCountries ?? []).map((v, i) => [`preferredCountries.${i}`, { type: 'country' as const, value: v }])),
    ...Object.fromEntries((input.preferredCourses ?? []).map((v, i) => [`preferredCourses.${i}`, { type: 'course' as const, value: v }])),
  });
  if (input.branchId) {
    if (!canAccessBranch(ctx, input.branchId)) throw ApiError.forbidden('You cannot use a branch outside your own branches');
    if (!(await BranchModel.exists({ organizationId: ctx.organizationId, _id: input.branchId, isActive: true }))) {
      throw ApiError.validation([{ field: 'body.branchId', message: 'Branch not found' }]);
    }
  }

  const changes: Record<string, unknown> = { ...input, ...contact };
  const before = student.toObject() as Record<string, unknown>;
  for (const [k, v] of Object.entries(changes)) {
    if (v === undefined) continue;
    student.set(k, v === null ? undefined : v);
  }
  if (!student.isModified()) return getStudent(ctx, student._id);
  student.updatedBy = ctx.userId;
  const nameChanged = student.isModified('firstName') || student.isModified('middleName') || student.isModified('lastName');
  await student.save();
  if (nameChanged) await ApplicationModel.updateMany({ organizationId: ctx.organizationId, studentId: student._id }, { studentName: student.fullName });

  const changed = Object.keys(changes).filter((k) => changes[k] !== undefined && JSON.stringify(before[k] ?? null) !== JSON.stringify(student.get(k) ?? null));
  if (changed.length) {
    await logActivity(ctx, {
      leadId: student.leadId,
      studentId: student._id,
      type: 'student_updated',
      title: 'Student profile updated',
      metadata: { fields: changed },
    });
    const diff = diffFields(before, Object.fromEntries(changed.map((k) => [k, student.get(k) as unknown])));
    // Passport numbers stay out of the audit trail; only the fact that they changed is recorded.
    if (diff) {
      for (const side of [diff.oldValue, diff.newValue] as Record<string, unknown>[]) if ('passport' in side) side.passport = '[changed]';
      await recordAudit(ctx, { entityType: 'student', entityId: student._id, action: 'student.updated', ...diff });
    }
  }
  return getStudent(ctx, student._id);
}

/** Keeps student ownership aligned with the lead after (bulk) reassignment. */
export async function syncStudentOwnership(organizationId: Types.ObjectId, leadIds: Types.ObjectId[], set: Record<string, unknown>) {
  const ownership = Object.fromEntries(Object.entries(set).filter(([k]) => k === 'assignedCounsellor' || k === 'assignedManager' || k === 'branchId'));
  if (!Object.keys(ownership).length || !leadIds.length) return;
  const filter = { organizationId, leadId: { $in: leadIds } };
  // Everything that belongs to the student follows the same owner, so scope stays consistent.
  await Promise.all([
    StudentModel.updateMany(filter, ownership),
    ShortlistModel.updateMany(filter, ownership),
    ApplicationModel.updateMany(filter, ownership),
    PaymentModel.updateMany(filter, ownership),
    VisaModel.updateMany(filter, ownership),
    DocumentModel.updateMany(filter, ownership),
  ]);
}
