import { z } from '../../docs/zod.js';
import { objectIdString } from '../../utils/objectId.js';

const v = (max = 500) => z.string().trim().max(max).optional();
// Tracking values are kept exactly as received (no trimming or case changes); normalization happens separately.
const raw = (max: number) => z.string().max(max).optional();
const touch = z
  .object({
    utm_source: raw(200), utm_medium: raw(200), utm_campaign: raw(200), utm_term: raw(200), utm_content: raw(200),
    fbclid: raw(500), gclid: raw(500), gbraid: raw(500), wbraid: raw(500),
    landing_url: raw(2000), referrer: raw(2000),
    at: z.string().datetime({ offset: true }).optional().openapi({ description: 'When this touch happened (ISO 8601)' }),
  })
  .optional();

export const websiteLeadBody = z
  .object({
    lead: z.object({
      firstName: z.string().trim().min(1).max(60),
      lastName: v(60),
      phone: v(20),
      whatsappNumber: v(20),
      email: v(254),
      city: v(100),
      countryInterested: v(64),
      courseInterested: v(64),
      intake: v(64),
      degreeLevel: v(64),
      notes: v(2000),
    }),
    answers: z.record(z.string().max(120), z.string().max(1000)).optional().openapi({ description: 'Extra form questions; kept in the lead notes' }),
    formId: v(120),
    pageUrl: v(2000),
    submittedAt: z.coerce.date().optional(),
    attribution: z.object({ first: touch, last: touch }).optional().openapi({ description: 'first = original landing (from the first-party snippet), last = this visit' }),
    visitorId: v(100),
    consent: z.object({ analytics: z.boolean().optional(), ads: z.boolean().optional(), method: v(100) }).optional(),
  })
  .openapi('WebsiteLeadRequest');

export const createWebsiteKeyBody = z.object({
  name: z.string().trim().min(1).max(80),
  leadSource: z.string().trim().min(1).max(64).default('website'),
  defaultBranchId: objectIdString.optional(),
  defaultCounsellorId: objectIdString.optional(),
  duplicatePolicy: z.enum(['keep_existing', 'mark_duplicate', 'create_separate']).default('keep_existing'),
});
