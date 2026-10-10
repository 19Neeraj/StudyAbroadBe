import { z } from '../../docs/zod.js';
import { objectIdString } from '../../utils/objectId.js';
import { DIMENSIONS } from './attributionNode.model.js';

const hierarchy = z.object({ l1: objectIdString.nullable().optional(), l2: objectIdString.nullable().optional(), l3: objectIdString.nullable().optional() }).optional();

export const createNodeBody = z
  .object({
    dimension: z.enum(DIMENSIONS),
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    parentId: objectIdString.nullable().optional(),
    label: z.string().trim().min(1).max(120),
    key: z.string().trim().regex(/^[a-z0-9_]{1,60}$/, 'Lower-case letters, digits and _').optional(),
    order: z.number().int().min(0).max(10_000).optional(),
  })
  .openapi('CreateAttributionNodeRequest');

export const updateNodeBody = z.object({ label: z.string().trim().min(1).max(120).optional(), parentId: objectIdString.nullable().optional(), order: z.number().int().min(0).max(10_000).optional(), isActive: z.boolean().optional() });

export const nodeListQuery = z.object({ dimension: z.enum(DIMENSIONS).optional() });

export const createMappingBody = z
  .object({
    provider: z.string().trim().min(1).max(40).openapi({ description: 'Ads provider key (meta, google_ads, …) or "utm" to map a utm_campaign value' }),
    accountExternalId: z.string().max(64).optional(),
    campaignExternalId: z.string().trim().min(1).max(200),
    adsetExternalId: z.string().max(64).nullable().optional(),
    adExternalId: z.string().max(64).nullable().optional(),
    externalName: z.string().max(300).optional(),
    source: hierarchy,
    medium: hierarchy,
    campaign: hierarchy,
    effectiveFrom: z.coerce.date().optional().openapi({ description: 'Defaults to now. The previous mapping for the same ID ends at this moment.' }),
    notes: z.string().trim().max(1000).optional(),
  })
  .refine((v) => !v.adExternalId || v.adsetExternalId, { message: 'An ad-level mapping needs its ad set', path: ['adsetExternalId'] })
  .openapi('CreateCampaignMappingRequest');

export const mappingListQuery = z.object({ provider: z.string().max(40).optional(), status: z.enum(['active', 'superseded']).optional(), campaignExternalId: z.string().max(200).optional() });

export const reapplyBody = z.object({ from: z.coerce.date(), to: z.coerce.date(), provider: z.string().max(40).optional(), campaignExternalId: z.string().max(200).optional() }).refine((v) => v.to >= v.from, { message: '"to" must be after "from"', path: ['to'] });

export const utmPreviewQuery = z.object({
  url: z.string().trim().min(8).max(2000),
  template: z.string().trim().max(2000).default('utm_source={{site_source_name}}&utm_medium=paid_social&utm_campaign={{campaign.name}}&utm_content={{ad.name}}'),
});
