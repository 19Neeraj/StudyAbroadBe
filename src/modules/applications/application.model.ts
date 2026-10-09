import { Schema, model, type InferSchemaType, type Types } from 'mongoose';
import { tenantField, tenantPlugin } from '../../database/plugins/tenant.plugin.js';

/** Ownership copied from the student; kept in sync on reassignment (scope = same as the student). */
export const ownershipFields = {
  studentId: { type: Schema.Types.ObjectId, ref: 'Student', required: true },
  leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true },
  branchId: { type: Schema.Types.ObjectId, ref: 'Branch' },
  assignedCounsellor: { type: Schema.Types.ObjectId, ref: 'User' },
  assignedManager: { type: Schema.Types.ObjectId, ref: 'User' },
} as const;

export const SHORTLIST_STATUSES = ['shortlisted', 'interested', 'application_started', 'applied', 'offer_received', 'rejected', 'withdrawn', 'enrolled'] as const;

/** A university/course a student is considering (spec §19). */
const shortlistSchema = new Schema(
  {
    ...tenantField,
    ...ownershipFields,
    universityId: { type: Schema.Types.ObjectId, ref: 'University', required: true },
    courseId: { type: Schema.Types.ObjectId, ref: 'Course' },
    country: { type: String },
    intake: { type: String },
    status: { type: String, enum: SHORTLIST_STATUSES, default: 'shortlisted' },
    priority: { type: Number, min: 1, max: 10 },
    notes: { type: String, trim: true },
    applicationId: { type: Schema.Types.ObjectId, ref: 'Application' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
shortlistSchema.index({ organizationId: 1, studentId: 1, createdAt: -1 });
shortlistSchema.index({ organizationId: 1, studentId: 1, universityId: 1, courseId: 1, intake: 1 }, { unique: true });
shortlistSchema.plugin(tenantPlugin);
export type Shortlist = InferSchemaType<typeof shortlistSchema> & { _id: Types.ObjectId };
export const ShortlistModel = model('Shortlist', shortlistSchema);

export const OFFER_STATUSES = ['none', 'conditional', 'unconditional', 'rejected', 'accepted', 'declined'] as const;
export const PAYMENT_STATUSES = ['not_due', 'pending', 'partially_paid', 'paid', 'refunded'] as const;
export const VISA_STATUSES = ['not_started', 'documents_pending', 'submitted', 'appointment_scheduled', 'under_process', 'approved', 'rejected', 'withdrawn'] as const;
export const ENROLMENT_STATUSES = ['not_started', 'enrolled', 'deferred', 'withdrawn'] as const;

/** A university application (spec §20). Status values are configurable (lookup application_status). */
const applicationSchema = new Schema(
  {
    ...tenantField,
    ...ownershipFields,
    applicationNumber: { type: Number, required: true },
    /** Snapshot for lists/search; refreshed when the student's name changes. */
    studentName: { type: String, trim: true },
    studentNumber: { type: Number },
    universityId: { type: Schema.Types.ObjectId, ref: 'University', required: true },
    courseId: { type: Schema.Types.ObjectId, ref: 'Course' },
    /** Free text when the course isn't in the catalog. */
    courseName: { type: String, trim: true },
    country: { type: String },
    intake: { type: String },
    shortlistId: { type: Schema.Types.ObjectId, ref: 'Shortlist' },
    /** Application team member handling it. */
    assignedTo: { type: Schema.Types.ObjectId, ref: 'User' },

    applicationDate: { type: Date },
    applicationDeadline: { type: Date },
    /** The university's own reference. */
    universityApplicationId: { type: String, trim: true },
    status: { type: String, required: true },
    statusChangedAt: { type: Date },

    offer: {
      status: { type: String, enum: OFFER_STATUSES, default: 'none' },
      date: { type: Date },
      conditions: { type: String, trim: true },
      expiryDate: { type: Date },
      depositAmount: { type: Number, min: 0 },
      depositDeadline: { type: Date },
    },
    currency: { type: String, uppercase: true, trim: true },
    tuitionFee: { type: Number, min: 0 },
    scholarship: { type: Number, min: 0 },
    applicationFee: { type: Number, min: 0 },

    paymentStatus: { type: String, enum: PAYMENT_STATUSES, default: 'not_due' },
    visaStatus: { type: String, enum: VISA_STATUSES, default: 'not_started' },
    enrolmentStatus: { type: String, enum: ENROLMENT_STATUSES, default: 'not_started' },
    notes: { type: String, trim: true },
    deletedAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
applicationSchema.index({ organizationId: 1, applicationNumber: 1 }, { unique: true });
applicationSchema.index({ organizationId: 1, studentId: 1, createdAt: -1 });
applicationSchema.index({ organizationId: 1, status: 1, updatedAt: -1 });
applicationSchema.index({ organizationId: 1, assignedCounsellor: 1, status: 1 });
applicationSchema.index({ organizationId: 1, branchId: 1, status: 1 });
applicationSchema.index({ organizationId: 1, assignedTo: 1, status: 1 });
applicationSchema.index({ organizationId: 1, applicationDeadline: 1 });
applicationSchema.index({ organizationId: 1, universityId: 1 });
applicationSchema.index({ organizationId: 1, intake: 1 });
applicationSchema.index({ organizationId: 1, universityApplicationId: 1 });
applicationSchema.plugin(tenantPlugin);
export type Application = InferSchemaType<typeof applicationSchema> & { _id: Types.ObjectId };
export const ApplicationModel = model('Application', applicationSchema);
