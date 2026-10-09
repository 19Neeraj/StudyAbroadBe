import { Schema, model, type InferSchemaType, type Types } from 'mongoose';
import { tenantField, tenantPlugin } from '../../database/plugins/tenant.plugin.js';

export const STUDENT_STATUSES = ['active', 'on_hold', 'enrolled', 'withdrawn'] as const;
export const GENDERS = ['male', 'female', 'other', 'undisclosed'] as const;
export const TEST_TYPES = ['ielts', 'pte', 'toefl', 'duolingo', 'gre', 'gmat', 'sat', 'other'] as const;
export const SCORE_TYPES = ['percentage', 'cgpa', 'gpa', 'grade'] as const;

const educationSchema = new Schema(
  {
    /** Lookup-free, e.g. "12th", "Bachelor's". */
    level: { type: String, required: true, trim: true },
    qualification: { type: String, trim: true },
    institution: { type: String, trim: true },
    board: { type: String, trim: true },
    specialization: { type: String, trim: true },
    passingYear: { type: Number },
    scoreType: { type: String, enum: SCORE_TYPES },
    score: { type: Number },
    backlogs: { type: Number },
  },
  { _id: true },
);

const testScoreSchema = new Schema(
  {
    test: { type: String, enum: TEST_TYPES, required: true },
    overall: { type: Number },
    listening: { type: Number },
    reading: { type: Number },
    writing: { type: Number },
    speaking: { type: Number },
    testDate: { type: Date },
    expiryDate: { type: Date },
    /** Free text for "other" tests or remarks. */
    remarks: { type: String, trim: true },
  },
  { _id: true },
);

const workSchema = new Schema(
  {
    company: { type: String, required: true, trim: true },
    designation: { type: String, trim: true },
    startDate: { type: Date },
    endDate: { type: Date },
    isCurrent: { type: Boolean, default: false },
    description: { type: String, trim: true },
  },
  { _id: true },
);

/**
 * A serious prospect, converted from a lead (spec §17). The lead keeps the pipeline, attribution and
 * timeline; the student holds the full profile used for shortlisting, applications and visa.
 * Ownership (branch / counsellor / manager) mirrors the lead and is kept in sync on reassignment.
 */
const studentSchema = new Schema(
  {
    ...tenantField,
    studentNumber: { type: Number, required: true },
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch' },
    assignedCounsellor: { type: Schema.Types.ObjectId, ref: 'User' },
    assignedManager: { type: Schema.Types.ObjectId, ref: 'User' },
    status: { type: String, enum: STUDENT_STATUSES, default: 'active' },

    // Personal
    firstName: { type: String, required: true, trim: true },
    middleName: { type: String, trim: true },
    lastName: { type: String, trim: true, default: '' },
    fullName: { type: String, trim: true },
    nameTokens: { type: [String], default: [], select: false },
    phone: { type: String, trim: true },
    whatsappNumber: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    dateOfBirth: { type: Date },
    gender: { type: String, enum: GENDERS },
    nationality: { type: String, trim: true },
    maritalStatus: { type: String, trim: true },
    address: { type: String, trim: true },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    country: { type: String, trim: true },
    postalCode: { type: String, trim: true },
    emergencyContact: {
      name: { type: String, trim: true },
      relation: { type: String, trim: true },
      phone: { type: String, trim: true },
    },

    passport: {
      number: { type: String, trim: true, uppercase: true },
      issueCountry: { type: String, trim: true },
      issueDate: { type: Date },
      expiryDate: { type: Date },
    },

    education: { type: [educationSchema], default: [] },
    testScores: { type: [testScoreSchema], default: [] },
    workExperience: { type: [workSchema], default: [] },
    /** Derived from workExperience on save. */
    totalExperienceMonths: { type: Number, default: 0 },

    // Study preference (lookup keys)
    preferredCountries: { type: [String], default: [] },
    preferredCourses: { type: [String], default: [] },
    degreeLevel: { type: String },
    intake: { type: String },
    budget: { type: Number, min: 0 },
    fundingSource: { type: String, trim: true },

    notes: { type: String, trim: true },
    convertedAt: { type: Date, default: () => new Date() },
    deletedAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

studentSchema.pre('validate', function () {
  this.fullName = [this.firstName, this.middleName, this.lastName].filter(Boolean).join(' ');
  this.nameTokens = [...new Set(this.fullName.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean))];
  const now = Date.now();
  this.totalExperienceMonths = this.workExperience.reduce((sum, w) => {
    if (!w.startDate) return sum;
    const end = w.isCurrent || !w.endDate ? now : w.endDate.getTime();
    return sum + Math.max(0, Math.round((end - w.startDate.getTime()) / (30.44 * 86_400_000)));
  }, 0);
});

studentSchema.index({ organizationId: 1, studentNumber: 1 }, { unique: true });
studentSchema.index({ organizationId: 1, leadId: 1 }, { unique: true });
studentSchema.index({ organizationId: 1, phone: 1 });
studentSchema.index({ organizationId: 1, email: 1 });
studentSchema.index({ organizationId: 1, nameTokens: 1 });
studentSchema.index({ organizationId: 1, deletedAt: 1, createdAt: -1 });
studentSchema.index({ organizationId: 1, assignedCounsellor: 1, createdAt: -1 });
studentSchema.index({ organizationId: 1, branchId: 1, createdAt: -1 });
studentSchema.index({ organizationId: 1, status: 1, createdAt: -1 });
studentSchema.index({ organizationId: 1, intake: 1 });
studentSchema.index({ organizationId: 1, 'passport.expiryDate': 1 });
studentSchema.plugin(tenantPlugin);

export type Student = InferSchemaType<typeof studentSchema> & { _id: Types.ObjectId };
export const StudentModel = model('Student', studentSchema);
