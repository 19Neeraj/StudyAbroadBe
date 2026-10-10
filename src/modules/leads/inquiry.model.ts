import { Schema, model, type InferSchemaType, type Types } from 'mongoose';
import { tenantField, tenantPlugin } from '../../database/plugins/tenant.plugin.js';
import { attributionField } from '../marketing/attributionNode.model.js';
import { TOUCH_ORIGINS } from '../marketing/touchpoint.model.js';

export const REINQUIRY_POLICIES = ['keep_owner', 'follow_up_owner', 'review_queue', 'reassign_if_unavailable'] as const;
export type ReinquiryPolicy = (typeof REINQUIRY_POLICIES)[number];

/** new: just received · pending_review: waiting in the re-inquiry queue · handled: someone acted on it. */
export const INQUIRY_STATUSES = ['new', 'pending_review', 'handled'] as const;

const ownerSchema = new Schema(
  { counsellor: { type: Schema.Types.ObjectId, ref: 'User' }, manager: { type: Schema.Types.ObjectId, ref: 'User' } },
  { _id: false },
);

/**
 * One document per enquiry a contact made — the first one (lead creation) and every re-inquiry.
 * The lead itself is never duplicated: a known phone number in the same organization adds an
 * inquiry here instead. Attribution of each inquiry is a snapshot, so the original is never lost.
 */
const inquirySchema = new Schema(
  {
    ...tenantField,
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true },
    /** 1 for the enquiry that created the lead, 2+ for re-inquiries. */
    sequence: { type: Number, required: true },
    isReinquiry: { type: Boolean, required: true },
    channel: { type: String, enum: TOUCH_ORIGINS, required: true },
    occurredAt: { type: Date, required: true },
    status: { type: String, enum: INQUIRY_STATUSES, default: 'new' },

    leadSource: { type: String },
    campaignName: { type: String },
    provider: { type: String },
    externalLeadId: { type: String },
    campaignExternalId: { type: String },
    adsetExternalId: { type: String },
    adExternalId: { type: String },
    formExternalId: { type: String },
    utm: { source: String, medium: String, campaign: String, term: String, content: String },
    landingPage: { type: String },
    referrer: { type: String },

    /** P/S/T attribution of this inquiry, and the lead's latest attribution before it arrived. */
    ...attributionField,
    previousAttribution: attributionField,
    touchpointIds: { type: [{ type: Schema.Types.ObjectId, ref: 'AttributionTouchpoint' }], default: [] },

    previousOwner: ownerSchema,
    currentOwner: ownerSchema,
    assignment: {
      policy: { type: String, enum: REINQUIRY_POLICIES },
      action: { type: String, enum: ['none', 'kept', 'follow_up_created', 'queued', 'reassigned'] },
      reason: { type: String },
    },

    /** Provider event ID / Idempotency-Key: a retried delivery never counts twice. */
    idempotencyKey: { type: String },
    requestId: { type: String },
    notes: { type: String },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    handledBy: { type: Schema.Types.ObjectId, ref: 'User' },
    handledAt: { type: Date },
  },
  { timestamps: true },
);
inquirySchema.index({ organizationId: 1, leadId: 1, occurredAt: 1 });
inquirySchema.index({ organizationId: 1, occurredAt: -1 });
inquirySchema.index({ organizationId: 1, isReinquiry: 1, status: 1, occurredAt: -1 });
inquirySchema.index({ organizationId: 1, 'source.l1': 1, occurredAt: -1 });
inquirySchema.index({ organizationId: 1, 'campaign.l1': 1, occurredAt: -1 });
inquirySchema.index(
  { organizationId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
);
inquirySchema.plugin(tenantPlugin);

export type LeadInquiry = InferSchemaType<typeof inquirySchema> & { _id: Types.ObjectId };
export const LeadInquiryModel = model('LeadInquiry', inquirySchema);
