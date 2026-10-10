import { Schema, model, type InferSchemaType, type Types } from 'mongoose';
import { REINQUIRY_POLICIES } from '../leads/inquiry.model.js';

const organizationSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    email: { type: String, trim: true, lowercase: true },
    phone: { type: String, trim: true },
    website: { type: String, trim: true },
    address: { type: String, trim: true },
    logoUrl: { type: String, trim: true },
    isActive: { type: Boolean, default: true },
    /** The platform organization hosts Super Admins; it never holds CRM data. */
    isPlatform: { type: Boolean, default: false },
    settings: {
      timezone: { type: String, default: 'Asia/Kolkata' },
      currency: { type: String, default: 'INR' },
      /** Used to normalize phone numbers entered without a country code. */
      defaultCountryCode: { type: String, default: '91' },
      dateFormat: { type: String, default: 'DD MMM YYYY' },
      reinquiryPolicy: { type: String, enum: REINQUIRY_POLICIES, default: 'keep_owner' },
    },
    /** Demo tenants are read-only for every signed-in user and can be wiped by `npm run seed:demo:clean`. */
    isDemo: { type: Boolean, default: false },
    security: {
      /** inherit = follow the platform policy. Organizations may only make 2FA stricter (see security/policy.ts). */
      twoFactorMode: { type: String, enum: ['inherit', 'optional', 'mandatory'], default: 'inherit' },
      twoFactorMandatorySince: { type: Date },
    },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

export type Organization = InferSchemaType<typeof organizationSchema> & { _id: Types.ObjectId };
export const OrganizationModel = model('Organization', organizationSchema);
