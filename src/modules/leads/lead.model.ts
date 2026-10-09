import { Schema, model, type InferSchemaType, type Types } from 'mongoose';
import { tenantField, tenantPlugin } from '../../database/plugins/tenant.plugin.js';

/** One marketing touch: where an enquiry came from. A lead keeps all of them (original + latest). */
const sourceTouchSchema = new Schema(
  {
    leadSource: String,
    campaign: String,
    platform: String,
    adSet: String,
    ad: String,
    leadForm: String,
    utmSource: String,
    utmMedium: String,
    utmCampaign: String,
    utmTerm: String,
    utmContent: String,
    at: { type: Date, default: () => new Date() },
  },
  { _id: false },
);

const leadSchema = new Schema(
  {
    ...tenantField,
    /** Human-friendly number per organization, e.g. 1001. */
    leadNumber: { type: Number, required: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch' },

    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, trim: true, default: '' },
    fullName: { type: String, trim: true },
    /** Lower-cased name words; prefix-searchable through a multikey index. */
    nameTokens: { type: [String], default: [], select: false },

    /** E.164, normalized (spec §13). */
    phone: { type: String, trim: true },
    whatsappNumber: { type: String, trim: true },
    /** Lower-cased. */
    email: { type: String, trim: true, lowercase: true },

    city: { type: String, trim: true },
    state: { type: String, trim: true },
    country: { type: String, trim: true },

    // Interest (lookup keys)
    countryInterested: { type: String },
    courseInterested: { type: String },
    degreeLevel: { type: String },
    intake: { type: String },

    educationDetails: { type: String, trim: true },
    ieltsScore: { type: Number, min: 0, max: 9 },
    pteScore: { type: Number, min: 10, max: 90 },
    toeflScore: { type: Number, min: 0, max: 120 },
    otherTestScore: { type: String, trim: true },
    budget: { type: Number, min: 0 },

    // Attribution of the original enquiry (spec §23). Later enquiries are in sourceHistory.
    leadSource: { type: String, required: true },
    campaign: { type: String, trim: true },
    platform: { type: String, trim: true },
    adSet: { type: String, trim: true },
    ad: { type: String, trim: true },
    leadForm: { type: String, trim: true },
    utmSource: { type: String, trim: true },
    utmMedium: { type: String, trim: true },
    utmCampaign: { type: String, trim: true },
    utmTerm: { type: String, trim: true },
    utmContent: { type: String, trim: true },
    sourceHistory: { type: [sourceTouchSchema], default: [] },

    assignedCounsellor: { type: Schema.Types.ObjectId, ref: 'User' },
    assignedManager: { type: Schema.Types.ObjectId, ref: 'User' },
    assignedAt: { type: Date },

    leadStage: { type: String, required: true },
    leadStatus: { type: String, required: true },
    stageChangedAt: { type: Date },

    /** Earliest pending follow-up; maintained by the follow-up service. */
    nextFollowUpAt: { type: Date },
    lastActivityAt: { type: Date },
    expectedPaymentDate: { type: Date },
    notes: { type: String, trim: true },

    /** Set once the lead is converted (spec §17). */
    studentId: { type: Schema.Types.ObjectId, ref: 'Student' },
    convertedAt: { type: Date },
    /** First call/WhatsApp/email/meeting after creation: drives response-time analytics. */
    firstContactAt: { type: Date },
    lastContactedAt: { type: Date },

    duplicateOf: { type: Schema.Types.ObjectId, ref: 'Lead' },
    mergedInto: { type: Schema.Types.ObjectId, ref: 'Lead' },

    deletedAt: { type: Date, default: null },
    deletedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

leadSchema.pre('validate', function () {
  this.fullName = [this.firstName, this.lastName].filter(Boolean).join(' ');
  this.nameTokens = [...new Set(this.fullName.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean))];
});

// Compound indexes follow the list/search/duplicate query patterns (spec §39).
leadSchema.index({ organizationId: 1, leadNumber: 1 }, { unique: true });
leadSchema.index({ organizationId: 1, phone: 1 });
leadSchema.index({ organizationId: 1, whatsappNumber: 1 });
leadSchema.index({ organizationId: 1, email: 1 });
leadSchema.index({ organizationId: 1, nameTokens: 1 });
leadSchema.index({ organizationId: 1, deletedAt: 1, createdAt: -1 });
leadSchema.index({ organizationId: 1, assignedCounsellor: 1, createdAt: -1 });
leadSchema.index({ organizationId: 1, assignedManager: 1, createdAt: -1 });
leadSchema.index({ organizationId: 1, branchId: 1, createdAt: -1 });
leadSchema.index({ organizationId: 1, leadStage: 1, updatedAt: -1 });
leadSchema.index({ organizationId: 1, leadStatus: 1, createdAt: -1 });
leadSchema.index({ organizationId: 1, leadSource: 1, createdAt: -1 });
leadSchema.index({ organizationId: 1, campaign: 1, createdAt: -1 });
leadSchema.index({ organizationId: 1, nextFollowUpAt: 1 });
leadSchema.plugin(tenantPlugin);

export type Lead = InferSchemaType<typeof leadSchema> & { _id: Types.ObjectId };
export const LeadModel = model('Lead', leadSchema);

/** Fields copied into a source touch. */
export const ATTRIBUTION_FIELDS = [
  'leadSource', 'campaign', 'platform', 'adSet', 'ad', 'leadForm',
  'utmSource', 'utmMedium', 'utmCampaign', 'utmTerm', 'utmContent',
] as const;

/** Profile fields a merge may fill on the kept lead when it has no value. */
export const MERGEABLE_FIELDS = [
  'lastName', 'phone', 'whatsappNumber', 'email', 'city', 'state', 'country',
  'countryInterested', 'courseInterested', 'degreeLevel', 'intake', 'educationDetails',
  'ieltsScore', 'pteScore', 'toeflScore', 'otherTestScore', 'budget', 'expectedPaymentDate', 'branchId',
] as const;
