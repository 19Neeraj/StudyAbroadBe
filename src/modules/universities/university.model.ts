import { Schema, model, type InferSchemaType, type Types } from 'mongoose';
import { tenantField, tenantPlugin } from '../../database/plugins/tenant.plugin.js';

const tokens = (s: string) => [...new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean))];

/** Entry requirements shared by universities (defaults) and courses (overrides). */
const requirementsSchema = new Schema(
  {
    minIelts: Number,
    minPte: Number,
    minToefl: Number,
    minDuolingo: Number,
    /** Minimum previous-qualification percentage. */
    minPercentage: Number,
    maxBacklogs: Number,
    minWorkExperienceMonths: Number,
    notes: { type: String, trim: true },
  },
  { _id: false },
);

/** University catalog (spec §18). Organization-wide, configurable by admins; no developer changes. */
const universitySchema = new Schema(
  {
    ...tenantField,
    name: { type: String, required: true, trim: true },
    nameTokens: { type: [String], default: [], select: false },
    /** Lookup key (type country). */
    country: { type: String, required: true },
    city: { type: String, trim: true },
    website: { type: String, trim: true },
    ranking: { type: Number, min: 1 },
    type: { type: String, enum: ['public', 'private', 'college', 'other'], default: 'public' },
    applicationFee: { type: Number, min: 0 },
    currency: { type: String, default: 'GBP', uppercase: true, trim: true },
    requirements: { type: requirementsSchema, default: {} },
    /** Partner/commission notes etc. */
    notes: { type: String, trim: true },
    isActive: { type: Boolean, default: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
universitySchema.pre('validate', function () {
  this.nameTokens = tokens(this.name);
});
universitySchema.index({ organizationId: 1, name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });
universitySchema.index({ organizationId: 1, nameTokens: 1 });
universitySchema.index({ organizationId: 1, country: 1, isActive: 1, ranking: 1 });
universitySchema.plugin(tenantPlugin);

export type University = InferSchemaType<typeof universitySchema> & { _id: Types.ObjectId };
export const UniversityModel = model('University', universitySchema);

/** A programme at a university. Course-level requirements override the university defaults. */
const courseSchema = new Schema(
  {
    ...tenantField,
    universityId: { type: Schema.Types.ObjectId, ref: 'University', required: true },
    /** Denormalized from the university so course search needs no join. */
    country: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    nameTokens: { type: [String], default: [], select: false },
    /** Lookup keys. */
    degreeLevel: { type: String },
    courseArea: { type: String },
    durationMonths: { type: Number, min: 1 },
    tuitionFee: { type: Number, min: 0 },
    currency: { type: String, uppercase: true, trim: true },
    /** Lookup keys (type intake) with optional application deadlines. */
    intakes: { type: [{ intake: String, deadline: Date, _id: false }], default: [] },
    requirements: { type: requirementsSchema, default: {} },
    applicationFee: { type: Number, min: 0 },
    scholarshipAvailable: { type: Boolean, default: false },
    courseUrl: { type: String, trim: true },
    isActive: { type: Boolean, default: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
courseSchema.pre('validate', function () {
  this.nameTokens = tokens(this.name);
});
courseSchema.index({ organizationId: 1, universityId: 1, name: 1 });
courseSchema.index({ organizationId: 1, nameTokens: 1 });
courseSchema.index({ organizationId: 1, country: 1, degreeLevel: 1, isActive: 1, tuitionFee: 1 });
courseSchema.index({ organizationId: 1, 'intakes.intake': 1 });
courseSchema.plugin(tenantPlugin);

export type Course = InferSchemaType<typeof courseSchema> & { _id: Types.ObjectId };
export const CourseModel = model('Course', courseSchema);
