import { Schema, model, type InferSchemaType, type Types } from 'mongoose';

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
    },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

export type Organization = InferSchemaType<typeof organizationSchema> & { _id: Types.ObjectId };
export const OrganizationModel = model('Organization', organizationSchema);
