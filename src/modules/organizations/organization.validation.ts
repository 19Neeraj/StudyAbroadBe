import { z } from '../../docs/zod.js';
import { REINQUIRY_POLICIES } from '../leads/inquiry.model.js';
import { passwordSchema } from '../auth/auth.validation.js';
import { paginationQuery, sortQuery } from '../../utils/pagination.js';

const settingsSchema = z.object({
  timezone: z
    .string()
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, 'Unknown time zone')
    .optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/, 'Use a 3-letter ISO currency code')
    .optional(),
  defaultCountryCode: z
    .string()
    .regex(/^\d{1,4}$/, 'Digits only, e.g. 91')
    .optional(),
  dateFormat: z.string().max(20).optional(),
  reinquiryPolicy: z.enum(REINQUIRY_POLICIES).optional().openapi({
    description:
      'When a known phone number enquires again: keep_owner (notify the owner), follow_up_owner (also create a follow-up), ' +
      'review_queue (flag for review), reassign_if_unavailable (assign to the incoming default only if the owner is missing or inactive).',
  }),
});

const profileFields = {
  name: z.string().trim().min(2).max(120),
  email: z.email().optional(),
  phone: z.string().trim().max(20).optional(),
  website: z.url().optional(),
  address: z.string().trim().max(300).optional(),
  logoUrl: z.url().optional(),
};

export const createOrganizationBody = z
  .object({
    ...profileFields,
    slug: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9-]{1,48}$/, 'Lower-case letters, digits and "-"')
      .optional(),
    settings: settingsSchema.optional(),
    admin: z.object({
      firstName: z.string().trim().min(1).max(60),
      lastName: z.string().trim().max(60).default(''),
      email: z.email(),
      password: passwordSchema
        .optional()
        .openapi({ description: 'When omitted, an invite email is sent' }),
    }),
  })
  .openapi('CreateOrganizationRequest');

export const updateOrganizationBody = z
  .object({
    ...profileFields,
    name: profileFields.name.optional(),
    settings: settingsSchema.optional(),
  })
  .openapi('UpdateOrganizationRequest');

export const organizationStatusBody = z.object({ isActive: z.boolean() });

export const organizationListQuery = paginationQuery.extend({
  sortBy: sortQuery(['name', 'createdAt'], 'createdAt'),
  isActive: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});
export type OrganizationListQuery = z.infer<typeof organizationListQuery>;

export const organizationDto = z
  .object({
    _id: z.string(),
    name: z.string(),
    slug: z.string(),
    email: z.string().optional(),
    phone: z.string().optional(),
    website: z.string().optional(),
    address: z.string().optional(),
    logoUrl: z.string().optional(),
    isActive: z.boolean(),
    settings: z.object({
      timezone: z.string(),
      currency: z.string(),
      defaultCountryCode: z.string(),
      dateFormat: z.string(),
      reinquiryPolicy: z.enum(REINQUIRY_POLICIES).optional(),
    }),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi('Organization');
