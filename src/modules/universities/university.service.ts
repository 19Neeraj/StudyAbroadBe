import { Types } from 'mongoose';
import type { z } from '../../docs/zod.js';
import type { ServiceContext } from '../../types/auth.js';
import { ApiError } from '../../utils/ApiError.js';
import { buildPagination, escapeRegex, toPaging, toSort } from '../../utils/pagination.js';
import { diffFields, recordAudit } from '../audit/audit.service.js';
import { assertLookupValues } from '../settings/lookup.service.js';
import { loadStudent } from '../students/student.service.js';
import { CourseModel, UniversityModel } from './university.model.js';
import type { courseBody, CourseSearchQuery, universityBody, universityListQuery, updateCourseBody, updateUniversityBody } from './university.validation.js';

type Filter = Record<string, unknown>;

function nameSearch(search: string | undefined): Filter {
  const words = (search ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 5);
  return words.length ? { $and: words.map((w) => ({ nameTokens: { $regex: `^${escapeRegex(w)}` } })) } : {};
}

function duplicateName(err: unknown): never {
  if (typeof err === 'object' && err && 'code' in err && err.code === 11000) {
    throw ApiError.conflict('A university with this name already exists', [{ field: 'body.name', message: 'Already exists' }]);
  }
  throw err;
}

export async function listUniversities(ctx: ServiceContext, q: z.infer<typeof universityListQuery>) {
  const filter: Filter = { organizationId: ctx.organizationId, ...nameSearch(q.search) };
  if (q.country) filter.country = q.country;
  if (q.isActive) filter.isActive = q.isActive === 'true';
  const { skip, limit } = toPaging(q);
  const [items, total] = await Promise.all([
    UniversityModel.find(filter).sort(toSort(q.sortBy, q.sortOrder)).skip(skip).limit(limit).lean(),
    UniversityModel.countDocuments(filter),
  ]);
  // Course counts in one aggregation (no N+1).
  const counts = await CourseModel.aggregate<{ _id: Types.ObjectId; n: number }>([
    { $match: { organizationId: ctx.organizationId, universityId: { $in: items.map((u) => u._id) }, isActive: true } },
    { $group: { _id: '$universityId', n: { $sum: 1 } } },
  ]);
  const byId = new Map(counts.map((c) => [c._id.toString(), c.n]));
  return { items: items.map((u) => ({ ...u, courseCount: byId.get(u._id.toString()) ?? 0 })), pagination: buildPagination(q.page, q.limit, total) };
}

export async function getUniversity(ctx: ServiceContext, id: string) {
  if (!Types.ObjectId.isValid(id)) throw ApiError.notFound('University');
  const uni = await UniversityModel.findOne({ organizationId: ctx.organizationId, _id: new Types.ObjectId(id) }).lean();
  if (!uni) throw ApiError.notFound('University');
  const courses = await CourseModel.find({ organizationId: ctx.organizationId, universityId: uni._id }).sort({ isActive: -1, name: 1 }).lean();
  return { ...uni, courses };
}

export async function createUniversity(ctx: ServiceContext, input: z.infer<typeof universityBody>) {
  await assertLookupValues(ctx, { country: { type: 'country', value: input.country } });
  const uni = await UniversityModel.create({ ...input, organizationId: ctx.organizationId, createdBy: ctx.userId, updatedBy: ctx.userId }).catch(duplicateName);
  await recordAudit(ctx, { entityType: 'university', entityId: uni._id, action: 'university.created', newValue: { name: uni.name, country: uni.country } });
  return getUniversity(ctx, uni._id.toString());
}

export async function updateUniversity(ctx: ServiceContext, id: string, input: z.infer<typeof updateUniversityBody>) {
  const before = await getUniversity(ctx, id);
  if (input.country) await assertLookupValues(ctx, { country: { type: 'country', value: input.country } });
  const uni = await UniversityModel.findOne({ organizationId: ctx.organizationId, _id: before._id });
  uni!.set({ ...input, updatedBy: ctx.userId });
  await uni!.save().catch(duplicateName);
  // Courses carry the country for search.
  if (input.country && input.country !== before.country) await CourseModel.updateMany({ organizationId: ctx.organizationId, universityId: before._id }, { country: input.country });
  const diff = diffFields(before as Record<string, unknown>, input as Record<string, unknown>);
  if (diff) await recordAudit(ctx, { entityType: 'university', entityId: before._id, action: 'university.updated', ...diff });
  return getUniversity(ctx, id);
}

async function courseLookups(ctx: ServiceContext, input: Partial<z.infer<typeof courseBody>>) {
  await assertLookupValues(ctx, {
    degreeLevel: { type: 'degree_level', value: input.degreeLevel },
    courseArea: { type: 'course', value: input.courseArea },
    ...Object.fromEntries((input.intakes ?? []).map((i, n) => [`intakes.${n}.intake`, { type: 'intake' as const, value: i.intake }])),
  });
}

export async function createCourse(ctx: ServiceContext, universityId: string, input: z.infer<typeof courseBody>) {
  const uni = await getUniversity(ctx, universityId);
  await courseLookups(ctx, input);
  const course = await CourseModel.create({
    ...input,
    organizationId: ctx.organizationId,
    universityId: uni._id,
    country: uni.country,
    currency: input.currency ?? uni.currency,
    applicationFee: input.applicationFee ?? uni.applicationFee,
    // Course requirements start from the university's defaults.
    requirements: { ...(uni.requirements ?? {}), ...(input.requirements ?? {}) },
    createdBy: ctx.userId,
    updatedBy: ctx.userId,
  });
  await recordAudit(ctx, { entityType: 'course', entityId: course._id, action: 'course.created', newValue: { name: course.name, university: uni.name } });
  return course.toObject();
}

export async function updateCourse(ctx: ServiceContext, id: string, input: z.infer<typeof updateCourseBody>) {
  if (!Types.ObjectId.isValid(id)) throw ApiError.notFound('Course');
  const course = await CourseModel.findOne({ organizationId: ctx.organizationId, _id: new Types.ObjectId(id) });
  if (!course) throw ApiError.notFound('Course');
  await courseLookups(ctx, input);
  const before = course.toObject() as Record<string, unknown>;
  course.set({ ...input, updatedBy: ctx.userId });
  await course.save();
  const diff = diffFields(before, input as Record<string, unknown>);
  if (diff) await recordAudit(ctx, { entityType: 'course', entityId: course._id, action: 'course.updated', ...diff });
  return course.toObject();
}

/** Highest overall score of a test on the student profile. */
const bestScore = (scores: { test: string; overall?: number | null }[], test: string) =>
  scores.filter((s) => s.test === test && s.overall != null).reduce<number | undefined>((m, s) => Math.max(m ?? 0, s.overall!), undefined);

/**
 * Course finder for shortlisting. With `forStudent`, eligibility (English scores, academic %,
 * budget) and preferences (countries, level, intake) come from the profile unless given explicitly.
 */
export async function searchCourses(ctx: ServiceContext, q: CourseSearchQuery) {
  const eff = { ...q };
  let applied: Record<string, unknown> | null = null;
  if (q.forStudent) {
    const s = await loadStudent(ctx, q.forStudent);
    const pct = s.education.filter((e) => e.scoreType === 'percentage' && e.score != null).map((e) => e.score!);
    eff.ielts ??= bestScore(s.testScores, 'ielts');
    eff.pte ??= bestScore(s.testScores, 'pte');
    eff.percentage ??= pct.length ? Math.max(...pct) : undefined;
    eff.country ??= s.preferredCountries.length ? s.preferredCountries : undefined;
    eff.degreeLevel ??= s.degreeLevel ?? undefined;
    eff.intake ??= s.intake ?? undefined;
    applied = { ielts: eff.ielts ?? null, pte: eff.pte ?? null, percentage: eff.percentage ?? null, country: eff.country ?? null, degreeLevel: eff.degreeLevel ?? null, intake: eff.intake ?? null, budget: s.budget ?? null };
  }
  const and: Filter[] = [];
  const atMost = (field: string, value: number | undefined) => value !== undefined && and.push({ $or: [{ [field]: null }, { [field]: { $lte: value } }] });
  atMost('requirements.minIelts', eff.ielts);
  atMost('requirements.minPte', eff.pte);
  atMost('requirements.minPercentage', eff.percentage);
  const filter: Filter = { organizationId: ctx.organizationId, ...nameSearch(q.search), ...(and.length ? { $and: and } : {}) };
  if (q.includeInactive !== 'true') filter.isActive = true;
  if (eff.universityId) filter.universityId = new Types.ObjectId(eff.universityId);
  if (eff.country?.length) filter.country = { $in: eff.country };
  if (eff.degreeLevel) filter.degreeLevel = eff.degreeLevel;
  if (eff.courseArea) filter.courseArea = eff.courseArea;
  if (eff.intake) filter['intakes.intake'] = eff.intake;
  if (eff.maxTuition !== undefined) filter.tuitionFee = { $lte: eff.maxTuition };

  const { skip, limit } = toPaging(q);
  const [items, total] = await Promise.all([
    CourseModel.find(filter)
      .sort(toSort(q.sortBy, q.sortOrder))
      .skip(skip)
      .limit(limit)
      .populate({ path: 'universityId', select: 'name city country ranking', match: { organizationId: ctx.organizationId } })
      .lean(),
    CourseModel.countDocuments(filter),
  ]);
  return {
    items: items.map(({ universityId, ...c }) => ({ ...c, university: universityId ?? null })),
    pagination: buildPagination(q.page, q.limit, total),
    appliedFilters: applied,
  };
}
