import { LOOKUP_TYPES, STAGE_MILESTONES, type LookupType } from '../../constants/lookups.js';
import { z } from '../../docs/zod.js';
import { objectIdString } from '../../utils/objectId.js';

/** Per-type metadata that workflow logic depends on; other types accept free-form metadata. */
export const LOOKUP_META_SCHEMAS: Partial<Record<LookupType, z.ZodType<Record<string, unknown>>>> =
  {
    lead_stage: z.object({
      category: z.enum(['open', 'won']).default('open'),
      /** Which analytics milestone (spec §52) reaching this stage counts as. */
      milestone: z.enum(STAGE_MILESTONES).optional(),
    }),
    lead_status: z.object({ isClosed: z.boolean().default(false) }),
    application_status: z.object({
      /** Lead milestone reached when an application gets this status. */
      leadMilestone: z.enum(['application', 'offer', 'enrolment']).optional(),
      /** Final statuses close the application (rejected, withdrawn, enrolled). */
      isFinal: z.boolean().default(false),
    }),
    call_outcome: z.object({ isPositive: z.boolean().default(false), requiresFollowUp: z.boolean().default(false) }),
    country: z.object({
      isoCode: z
        .string()
        .regex(/^[A-Z]{2}$/, 'Use a 2-letter ISO code')
        .optional(),
    }),
  };
const freeMeta = z.record(
  z.string().max(40),
  z.union([z.string().max(300), z.number(), z.boolean(), z.null()]),
);

export const lookupTypeParams = z.object({ type: z.enum(LOOKUP_TYPES) });
export const lookupItemParams = lookupTypeParams.extend({ id: objectIdString });

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #1e88e5');

export const createLookupBody = z
  .object({
    label: z.string().trim().min(1).max(100).openapi({ example: 'Spring 2027' }),
    key: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9_]{0,63}$/, 'Key must be lower_snake_case')
      .optional()
      .openapi({
        description:
          'Stable identifier stored on records. Generated from the label when omitted; cannot be changed later.',
      }),
    color: color.optional(),
    order: z.number().int().min(0).max(10_000).optional(),
    meta: freeMeta.optional(),
  })
  .openapi('CreateLookupRequest');

export const updateLookupBody = z
  .object({
    label: z.string().trim().min(1).max(100).optional(),
    color: color.nullable().optional(),
    order: z.number().int().min(0).max(10_000).optional(),
    isActive: z.boolean().optional(),
    meta: freeMeta.optional(),
  })
  .openapi('UpdateLookupRequest');

export const reorderLookupsBody = z
  .object({ ids: z.array(objectIdString).min(1).max(500) })
  .openapi('ReorderLookupsRequest', { description: 'All ids of the type in the desired order' });

const typesCsv = z
  .string()
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.enum(LOOKUP_TYPES)));

export const lookupListQuery = z.object({
  includeInactive: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default(false),
});

export const lookupGroupsQuery = lookupListQuery.extend({
  types: typesCsv.optional().openapi({
    description: 'Comma-separated lookup types; all types when omitted',
    example: 'lead_stage,lead_source',
  }),
});

export const lookupDto = z
  .object({
    _id: z.string(),
    type: z.enum(LOOKUP_TYPES),
    key: z.string(),
    label: z.string(),
    order: z.number(),
    color: z.string().optional(),
    isActive: z.boolean(),
    isSystem: z.boolean(),
    meta: z.record(z.string(), z.unknown()),
  })
  .openapi('Lookup');
