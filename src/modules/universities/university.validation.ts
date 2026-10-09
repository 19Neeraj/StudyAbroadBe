import { z } from '../../docs/zod.js';
import { objectIdString } from '../../utils/objectId.js';
import { paginationQuery, sortQuery } from '../../utils/pagination.js';

const key = z.string().trim().min(1).max(64);
const money = z.number().min(0).max(1e9);
const requirements = z
  .object({
    minIelts: z.number().min(0).max(9).optional(),
    minPte: z.number().min(10).max(90).optional(),
    minToefl: z.number().min(0).max(120).optional(),
    minDuolingo: z.number().min(10).max(160).optional(),
    minPercentage: z.number().min(0).max(100).optional(),
    maxBacklogs: z.number().int().min(0).max(99).optional(),
    minWorkExperienceMonths: z.number().int().min(0).max(600).optional(),
    notes: z.string().trim().max(2000).optional(),
  })
  .openapi('EntryRequirements');

export const universityBody = z
  .object({
    name: z.string().trim().min(2).max(200),
    country: key.openapi({ description: 'Lookup key (type country)' }),
    city: z.string().trim().max(100).optional(),
    website: z.url().max(300).optional(),
    ranking: z.number().int().min(1).max(10000).optional(),
    type: z.enum(['public', 'private', 'college', 'other']).optional(),
    applicationFee: money.optional(),
    currency: z.string().trim().length(3).toUpperCase().optional(),
    requirements: requirements.optional(),
    notes: z.string().trim().max(5000).optional(),
  })
  .openapi('UniversityRequest');
export const updateUniversityBody = universityBody.partial().extend({ isActive: z.boolean().optional() }).openapi('UpdateUniversityRequest');

export const courseBody = z
  .object({
    name: z.string().trim().min(2).max(200),
    degreeLevel: key.optional().openapi({ description: 'Lookup key (type degree_level)' }),
    courseArea: key.optional().openapi({ description: 'Lookup key (type course)' }),
    durationMonths: z.number().int().min(1).max(120).optional(),
    tuitionFee: money.optional(),
    currency: z.string().trim().length(3).toUpperCase().optional(),
    intakes: z.array(z.object({ intake: key, deadline: z.coerce.date().optional() })).max(12).optional(),
    requirements: requirements.optional(),
    applicationFee: money.optional(),
    scholarshipAvailable: z.boolean().optional(),
    courseUrl: z.url().max(500).optional(),
  })
  .openapi('CourseRequest');
export const updateCourseBody = courseBody.partial().extend({ isActive: z.boolean().optional() }).openapi('UpdateCourseRequest');

export const universityListQuery = paginationQuery.extend({
  sortBy: sortQuery(['name', 'ranking', 'createdAt'], 'name'),
  country: key.optional(),
  isActive: z.enum(['true', 'false']).optional(),
});

export const courseSearchQuery = paginationQuery.extend({
  sortBy: sortQuery(['name', 'tuitionFee', 'createdAt'], 'name'),
  universityId: objectIdString.optional(),
  country: z.string().transform((v) => v.split(',').filter(Boolean)).optional(),
  degreeLevel: key.optional(),
  courseArea: key.optional(),
  intake: key.optional(),
  maxTuition: z.coerce.number().min(0).optional(),
  /** Eligibility: only courses whose minimum is at or below the student's score. */
  ielts: z.coerce.number().min(0).max(9).optional(),
  pte: z.coerce.number().min(10).max(90).optional(),
  percentage: z.coerce.number().min(0).max(100).optional(),
  forStudent: objectIdString.optional().openapi({ description: 'Fill eligibility filters (scores, budget, preferences) from this student' }),
  includeInactive: z.enum(['true', 'false']).optional(),
});
export type CourseSearchQuery = z.infer<typeof courseSearchQuery>;
