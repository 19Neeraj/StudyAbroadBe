import { Schema, model, type InferSchemaType, type Types } from 'mongoose';
import { tenantField, tenantPlugin } from '../../database/plugins/tenant.plugin.js';

export const EVENT_STATUSES = ['draft', 'published', 'completed', 'cancelled'] as const;
export const EVENT_MODES = ['in_person', 'online', 'hybrid'] as const;

/** Education fairs, webinars, seminars, spot admissions… (type = lookup event_type). */
const eventSchema = new Schema(
  {
    ...tenantField,
    eventNumber: { type: Number, required: true },
    name: { type: String, required: true, trim: true },
    eventType: { type: String, required: true },
    description: { type: String, trim: true },
    status: { type: String, enum: EVENT_STATUSES, default: 'draft' },
    mode: { type: String, enum: EVENT_MODES, default: 'in_person' },
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    venue: { name: String, address: String, city: String },
    onlineUrl: { type: String, trim: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch' },
    /** Lookup keys (country) and universities taking part. */
    countries: { type: [String], default: [] },
    universityIds: { type: [{ type: Schema.Types.ObjectId, ref: 'University' }], default: [] },
    capacity: { type: Number, min: 1 },
    /** Total cost, for cost per lead / ROI. Unset = unknown (never treated as zero). */
    cost: { amount: { type: Number, min: 0 }, currency: { type: String, uppercase: true } },
    /** Public registration link token (null = no public registration). */
    publicSlug: { type: String, default: null },
    registrationOpen: { type: Boolean, default: false },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User' },
    deletedAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
eventSchema.index({ organizationId: 1, eventNumber: 1 }, { unique: true });
eventSchema.index({ organizationId: 1, startAt: -1 });
eventSchema.index({ organizationId: 1, status: 1, startAt: -1 });
eventSchema.index({ publicSlug: 1 }, { unique: true, partialFilterExpression: { publicSlug: { $type: 'string' } } });
eventSchema.plugin(tenantPlugin);
export type CrmEvent = InferSchemaType<typeof eventSchema> & { _id: Types.ObjectId };
export const EventModel = model('Event', eventSchema);

export const REGISTRATION_STATUSES = ['registered', 'attended', 'no_show', 'cancelled'] as const;
export const REGISTRATION_SOURCES = ['staff', 'public_form', 'walk_in'] as const;

/** One person at one event; always linked to a lead (created or matched by the duplicate rules). */
const registrationSchema = new Schema(
  {
    ...tenantField,
    eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true },
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true },
    /** Snapshot for check-in lists (the lead holds the real data). */
    fullName: { type: String, trim: true },
    phone: { type: String },
    email: { type: String },
    status: { type: String, enum: REGISTRATION_STATUSES, default: 'registered' },
    source: { type: String, enum: REGISTRATION_SOURCES, default: 'staff' },
    /** True when the event created the lead (vs. an existing lead registering). */
    newLead: { type: Boolean, default: false },
    registeredAt: { type: Date, default: () => new Date() },
    checkedInAt: { type: Date },
    checkedInBy: { type: Schema.Types.ObjectId, ref: 'User' },
    notes: { type: String, trim: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
registrationSchema.index({ organizationId: 1, eventId: 1, leadId: 1 }, { unique: true });
registrationSchema.index({ organizationId: 1, eventId: 1, status: 1 });
registrationSchema.index({ organizationId: 1, leadId: 1 });
registrationSchema.plugin(tenantPlugin);
export type EventRegistration = InferSchemaType<typeof registrationSchema> & { _id: Types.ObjectId };
export const EventRegistrationModel = model('EventRegistration', registrationSchema);
