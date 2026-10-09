import { z } from '../../docs/zod.js';
import { filterQueryParam } from '../../utils/filterTree.js';
import { objectIdString } from '../../utils/objectId.js';
import { paginationQuery, sortQuery } from '../../utils/pagination.js';
import { GENDERS, SCORE_TYPES, STUDENT_STATUSES, TEST_TYPES } from './student.model.js';

const text = (max: number) => z.string().trim().max(max);
const nText = (max: number) => text(max).nullable().optional();
const key = z.string().trim().min(1).max(64);
const date = z.coerce.date();
const email = z.string().trim().toLowerCase().pipe(z.email('Invalid email').max(254));
const band = z.number().min(0).max(990);

const education = z.object({
  level: text(60).min(1, 'Level is required'),
  qualification: text(120).optional(),
  institution: text(200).optional(),
  board: text(200).optional(),
  specialization: text(120).optional(),
  passingYear: z.number().int().min(1950).max(2100).optional(),
  scoreType: z.enum(SCORE_TYPES).optional(),
  score: z.number().min(0).max(100).optional(),
  backlogs: z.number().int().min(0).max(99).optional(),
});

const testScore = z
  .object({
    test: z.enum(TEST_TYPES),
    overall: band.optional(),
    listening: band.optional(),
    reading: band.optional(),
    writing: band.optional(),
    speaking: band.optional(),
    testDate: date.optional(),
    expiryDate: date.optional(),
    remarks: text(200).optional(),
  })
  .refine((t) => !t.testDate || !t.expiryDate || t.expiryDate >= t.testDate, { message: 'Expiry must be after the test date', path: ['expiryDate'] });

const work = z
  .object({
    company: text(200).min(1, 'Company is required'),
    designation: text(120).optional(),
    startDate: date.optional(),
    endDate: date.optional(),
    isCurrent: z.boolean().optional(),
    description: text(1000).optional(),
  })
  .refine((w) => !w.startDate || !w.endDate || w.endDate >= w.startDate, { message: 'End date must be after the start date', path: ['endDate'] });

/** Every section is optional; arrays replace the whole list (the UI edits a section at a time). */
export const updateStudentBody = z
  .object({
    firstName: text(60).min(1).optional(),
    middleName: nText(60),
    lastName: nText(60),
    phone: nText(20),
    whatsappNumber: nText(20),
    email: email.nullable().optional(),
    dateOfBirth: date.nullable().optional(),
    gender: z.enum(GENDERS).nullable().optional(),
    nationality: nText(100),
    maritalStatus: nText(40),
    address: nText(500),
    city: nText(100),
    state: nText(100),
    country: nText(100),
    postalCode: nText(20),
    emergencyContact: z.object({ name: text(100).optional(), relation: text(60).optional(), phone: text(20).optional() }).nullable().optional(),
    passport: z
      .object({ number: text(20).optional(), issueCountry: text(100).optional(), issueDate: date.optional(), expiryDate: date.optional() })
      .nullable()
      .optional(),
    education: z.array(education).max(20).optional(),
    testScores: z.array(testScore).max(20).optional(),
    workExperience: z.array(work).max(20).optional(),
    preferredCountries: z.array(key).max(10).optional().openapi({ description: 'Lookup keys (type country)' }),
    preferredCourses: z.array(key).max(10).optional().openapi({ description: 'Lookup keys (type course)' }),
    degreeLevel: key.nullable().optional(),
    intake: key.nullable().optional(),
    budget: z.number().min(0).max(1e10).nullable().optional(),
    fundingSource: nText(200),
    status: z.enum(STUDENT_STATUSES).optional(),
    branchId: objectIdString.nullable().optional(),
    notes: nText(5000),
  })
  .openapi('UpdateStudentRequest');

export const convertLeadBody = z
  .object({ notes: text(1000).optional() })
  .openapi('ConvertLeadRequest');

export const studentListQuery = paginationQuery.extend({
  sortBy: sortQuery(['createdAt', 'updatedAt', 'fullName', 'studentNumber'], 'createdAt'),
  status: z.enum(STUDENT_STATUSES).optional(),
  branchId: objectIdString.optional(),
  assignedUser: objectIdString.optional(),
  country: key.optional(),
  intake: key.optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  filter: filterQueryParam.optional(),
});
export type StudentListQuery = z.infer<typeof studentListQuery>;

const ref = z.object({ _id: z.string(), fullName: z.string() }).nullable();
export const studentDto = z
  .object({
    _id: z.string(),
    studentNumber: z.number(),
    leadId: z.string(),
    fullName: z.string(),
    phone: z.string().optional(),
    email: z.string().optional(),
    status: z.enum(STUDENT_STATUSES),
    branch: z.object({ _id: z.string(), name: z.string(), code: z.string() }).nullable(),
    assignedCounsellor: ref,
    preferredCountries: z.array(z.string()),
    intake: z.string().optional(),
    profileCompletion: z.number().openapi({ description: 'Percent of key profile sections filled' }),
    createdAt: z.string(),
  })
  .catchall(z.unknown())
  .openapi('Student', { description: 'Detail responses add every profile section and `lead` (stage, status, source).' });
