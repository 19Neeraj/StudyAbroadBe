import { Schema, model, type InferSchemaType, type Types } from 'mongoose';
import { tenantField, tenantPlugin } from '../../database/plugins/tenant.plugin.js';
import { ownershipFields, VISA_STATUSES } from '../applications/application.model.js';

/** Visa case for an application (spec §46). One per application. */
const visaSchema = new Schema(
  {
    ...tenantField,
    ...ownershipFields,
    applicationId: { type: Schema.Types.ObjectId, ref: 'Application', required: true },
    visaType: { type: String, trim: true },
    /** Lookup key (type country). */
    country: { type: String },
    status: { type: String, enum: VISA_STATUSES, default: 'not_started' },
    submissionDate: { type: Date },
    appointmentDate: { type: Date },
    appointmentLocation: { type: String, trim: true },
    decisionDate: { type: Date },
    visaExpiryDate: { type: Date },
    rejectionReason: { type: String, trim: true },
    remarks: { type: String, trim: true },
    /** Visa team member handling the case. */
    assignedTo: { type: Schema.Types.ObjectId, ref: 'User' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
visaSchema.index({ organizationId: 1, applicationId: 1 }, { unique: true });
visaSchema.index({ organizationId: 1, studentId: 1 });
visaSchema.index({ organizationId: 1, status: 1, updatedAt: -1 });
visaSchema.index({ organizationId: 1, appointmentDate: 1 });
visaSchema.index({ organizationId: 1, assignedTo: 1, status: 1 });
visaSchema.index({ organizationId: 1, branchId: 1, status: 1 });
visaSchema.plugin(tenantPlugin);

export type VisaCase = InferSchemaType<typeof visaSchema> & { _id: Types.ObjectId };
export const VisaModel = model('VisaCase', visaSchema);
