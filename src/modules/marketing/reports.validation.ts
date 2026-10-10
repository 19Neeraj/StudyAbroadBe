import { z } from '../../docs/zod.js';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const iso = (d: Date) => d.toISOString().slice(0, 10);

export const GROUP_BY = ['none', 'campaign', 'utm_campaign', 'leadSource', 'country', 'course', 'intake', 'counsellor', 'branch', 'source_l1', 'source_l2', 'source_l3', 'medium_l1', 'medium_l2', 'medium_l3', 'campaign_l1', 'campaign_l2', 'campaign_l3'] as const;

export const reportQuery = z
  .object({
    from: day.default(() => iso(new Date(Date.now() - 29 * 86_400_000))),
    to: day.default(() => iso(new Date())),
    model: z.enum(['first', 'last']).default('first').openapi({ description: 'Attribution model: first touch (default) or last touch' }),
    groupBy: z.enum(GROUP_BY).default('campaign'),
    provider: z.string().max(40).optional(),
    campaignExternalId: z.string().max(200).optional(),
    currency: z.string().length(3).toUpperCase().optional().openapi({ description: 'Report currency; defaults to the organization currency' }),
    interval: z.enum(['day', 'week', 'month']).default('day'),
  })
  .refine((v) => v.to >= v.from, { message: '"to" must not be before "from"', path: ['to'] })
  .refine((v) => (new Date(`${v.to}T00:00:00Z`).getTime() - new Date(`${v.from}T00:00:00Z`).getTime()) / 86_400_000 <= 731, { message: 'Ranges are limited to two years', path: ['from'] });

export const EXPORT_REPORTS = ['campaigns', 'overview', 'funnel', 'trend', 'data-quality'] as const;
export const exportBody = z.object({ report: z.enum(EXPORT_REPORTS), format: z.enum(['csv', 'xlsx']).default('xlsx'), params: z.record(z.string(), z.string()).default({}) });
