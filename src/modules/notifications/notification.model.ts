import { Schema, model, type InferSchemaType, type Types } from 'mongoose';
import { tenantField, tenantPlugin } from '../../database/plugins/tenant.plugin.js';

/** Mobile spec §33 (+ team messages). Each type can be switched per channel by the user. */
export const NOTIFICATION_TYPES = [
  'lead_assigned',
  'lead_reinquiry',
  'followup_due',
  'followup_overdue',
  'incoming_call',
  'missed_call',
  'application_update',
  'offer_received',
  'payment_received',
  'document_rejected',
  'team_message',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** Defaults: everything in-app; push for time-sensitive items; email only for team messages. */
export const DEFAULT_CHANNELS: Record<NotificationType, { push: boolean; email: boolean }> = {
  lead_assigned: { push: true, email: false },
  lead_reinquiry: { push: true, email: false },
  followup_due: { push: true, email: false },
  followup_overdue: { push: true, email: false },
  incoming_call: { push: true, email: false },
  missed_call: { push: true, email: false },
  application_update: { push: false, email: false },
  offer_received: { push: true, email: false },
  payment_received: { push: true, email: false },
  document_rejected: { push: true, email: false },
  team_message: { push: true, email: true },
};

const notificationSchema = new Schema(
  {
    ...tenantField,
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: NOTIFICATION_TYPES, required: true },
    title: { type: String, required: true, trim: true },
    body: { type: String, trim: true },
    /** Where a tap leads: { leadId | studentId | applicationId | eventId | url }. */
    data: { type: Schema.Types.Mixed, default: {} },
    /** Collapses repeats, e.g. "followup_due:<id>" is only ever sent once per user. */
    dedupeKey: { type: String },
    readAt: { type: Date, default: null },
    push: { status: { type: String, enum: ['skipped', 'queued', 'sent', 'failed'] }, at: Date, error: String },
    emailed: { type: Boolean, default: false },
    sentBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true, minimize: false },
);
notificationSchema.index({ organizationId: 1, userId: 1, createdAt: -1 });
notificationSchema.index({ organizationId: 1, userId: 1, readAt: 1 });
notificationSchema.index({ organizationId: 1, userId: 1, dedupeKey: 1 }, { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } });
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 120 * 86_400 });
notificationSchema.plugin(tenantPlugin);
export type CrmNotification = InferSchemaType<typeof notificationSchema> & { _id: Types.ObjectId };
export const NotificationModel = model('Notification', notificationSchema);

/** Per-user channel choices; missing types use DEFAULT_CHANNELS. */
const preferenceSchema = new Schema(
  {
    ...tenantField,
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    channels: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, minimize: false },
);
preferenceSchema.index({ organizationId: 1, userId: 1 }, { unique: true });
preferenceSchema.plugin(tenantPlugin);
export const NotificationPreferenceModel = model('NotificationPreference', preferenceSchema);
