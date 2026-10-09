import { Schema, model, type InferSchemaType, type Types } from 'mongoose';
import { tenantField, tenantPlugin } from '../../database/plugins/tenant.plugin.js';
import { ownershipFields } from '../applications/application.model.js';

export const PAYMENT_PURPOSES = ['service_fee', 'application_fee', 'tuition_deposit', 'tuition_fee', 'visa_fee', 'other'] as const;
export const PAYMENT_METHODS = ['cash', 'upi', 'bank_transfer', 'card', 'cheque', 'online', 'other'] as const;
export const PAYMENT_STATES = ['pending', 'initiated', 'success', 'failed', 'refunded'] as const;

/** Payment record (spec §45). Gateway integrations update the same record via webhooks later. */
const paymentSchema = new Schema(
  {
    ...tenantField,
    ...ownershipFields,
    paymentNumber: { type: Number, required: true },
    applicationId: { type: Schema.Types.ObjectId, ref: 'Application' },
    purpose: { type: String, enum: PAYMENT_PURPOSES, required: true },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true, uppercase: true, trim: true },
    paymentMethod: { type: String, enum: PAYMENT_METHODS },
    paymentStatus: { type: String, enum: PAYMENT_STATES, default: 'pending' },
    transactionId: { type: String, trim: true },
    gateway: { type: String },
    dueDate: { type: Date },
    paymentDate: { type: Date },
    remarks: { type: String, trim: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
paymentSchema.index({ organizationId: 1, paymentNumber: 1 }, { unique: true });
paymentSchema.index({ organizationId: 1, studentId: 1, createdAt: -1 });
paymentSchema.index({ organizationId: 1, applicationId: 1 });
paymentSchema.index({ organizationId: 1, paymentStatus: 1, paymentDate: -1 });
paymentSchema.index({ organizationId: 1, paymentStatus: 1, dueDate: 1 });
paymentSchema.index({ organizationId: 1, assignedCounsellor: 1, paymentDate: -1 });
paymentSchema.index({ organizationId: 1, branchId: 1, paymentDate: -1 });
paymentSchema.index({ organizationId: 1, transactionId: 1 }, { sparse: true });
paymentSchema.plugin(tenantPlugin);

export type Payment = InferSchemaType<typeof paymentSchema> & { _id: Types.ObjectId };
export const PaymentModel = model('Payment', paymentSchema);
