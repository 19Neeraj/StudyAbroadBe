import { ACTIVITY_TYPES, MANUAL_ACTIVITY_TYPES } from '../../constants/activities.js';
import { z } from '../../docs/zod.js';

export const logActivityBody = z
  .object({
    type: z.enum(MANUAL_ACTIVITY_TYPES),
    notes: z.string().trim().min(1, 'Add a short note').max(5000),
    outcome: z.string().trim().max(500).optional(),
    occurredAt: z.coerce
      .date()
      .refine((d) => d.getTime() <= Date.now() + 5 * 60_000, 'Cannot be in the future')
      .optional(),
  })
  .openapi('LogActivityRequest');

const typesCsv = z
  .string()
  .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean))
  .pipe(z.array(z.enum(ACTIVITY_TYPES)));

export const activityListQuery = z.object({
  types: typesCsv.optional().openapi({ description: 'Comma-separated activity types', example: 'call,whatsapp,note' }),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type ActivityListQuery = z.infer<typeof activityListQuery>;

export const activityDto = z
  .object({
    _id: z.string(),
    leadId: z.string(),
    type: z.enum(ACTIVITY_TYPES),
    title: z.string(),
    notes: z.string().optional(),
    outcome: z.string().optional(),
    previousValue: z.unknown(),
    newValue: z.unknown(),
    metadata: z.unknown(),
    occurredAt: z.string(),
    createdAt: z.string(),
    user: z.object({ _id: z.string(), fullName: z.string() }).nullable(),
  })
  .openapi('Activity');
