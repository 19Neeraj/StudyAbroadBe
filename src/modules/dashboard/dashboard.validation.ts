import { STAGE_MILESTONES } from '../../constants/lookups.js';
import { z } from '../../docs/zod.js';
import { filterQueryParam } from '../../utils/filterTree.js';
import { objectIdString } from '../../utils/objectId.js';
import { PERIOD_PRESETS } from '../../utils/time.js';

const key = z.string().trim().min(1).max(64);
const csv = z.string().transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean));

export const dashboardQuery = z.object({
  period: z.enum(PERIOD_PRESETS).default('this_month').openapi({
    description: 'Lead cohort: leads *created* in this period. `all_time` covers every lead. Custom uses dateFrom/dateTo (inclusive days).',
  }),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  branchId: objectIdString.optional(),
  counsellor: z.union([objectIdString, z.literal('unassigned')]).optional(),
  manager: objectIdString.optional(),
  source: csv.optional().openapi({ description: 'Comma-separated source keys' }),
  campaign: z.string().trim().max(200).optional(),
  country: key.optional(),
  course: key.optional(),
  intake: key.optional(),
  filter: filterQueryParam.optional(),
});
export type DashboardQuery = z.infer<typeof dashboardQuery>;

const count2 = z.object({ current: z.number(), previous: z.number().nullable() });
const milestoneCounts = z.object(Object.fromEntries(STAGE_MILESTONES.map((m) => [m, z.number()])) as Record<(typeof STAGE_MILESTONES)[number], z.ZodNumber>);

const breakdownRow = z.object({
  key: z.string().nullable(),
  label: z.string().nullable().openapi({ description: 'Display name for user/branch rows; lookup rows return keys for clients to label' }),
  leads: z.number(),
  active: z.number(),
  closed: z.number(),
  milestones: milestoneCounts,
  conversionRate: z.number().openapi({ description: 'Enrolments / leads × 100' }),
});

export const dashboardDto = z
  .object({
    range: z.object({
      period: z.enum(PERIOD_PRESETS),
      from: z.string().nullable(),
      to: z.string(),
      previous: z.object({ from: z.string(), to: z.string() }).nullable(),
      timezone: z.string(),
      granularity: z.enum(['day', 'week', 'month']),
    }),
    kpis: z.object({
      totalLeads: z.number().openapi({ description: 'All leads matching the filters, any date' }),
      activeLeads: z.number(),
      unassignedLeads: z.number(),
      newLeads: count2,
      closedLeads: count2,
      milestones: z.object(Object.fromEntries(STAGE_MILESTONES.map((m) => [m, count2])) as Record<(typeof STAGE_MILESTONES)[number], typeof count2>),
      conversionRate: z.object({ current: z.number(), previous: z.number().nullable() }),
      revenue: z.array(z.object({ currency: z.string(), current: z.number(), previous: z.number().nullable() })).openapi({ description: 'Successful payments by payment date; organization currency first' }),
    }),
    rates: z.array(z.object({ milestone: z.enum(STAGE_MILESTONES), label: z.string(), stage: z.string().nullable(), reached: z.number(), rate: z.number() })),
    funnel: z.array(z.object({ stage: z.string(), label: z.string(), color: z.string().nullable(), reached: z.number(), current: z.number(), conversionFromPrevious: z.number(), conversionFromTop: z.number() })),
    pipeline: z.array(z.object({ stage: z.string(), label: z.string(), color: z.string().nullable(), count: z.number() })),
    statuses: z.array(z.object({ key: z.string(), count: z.number() })),
    trend: z.array(z.object({ bucket: z.string(), leads: z.number(), enrolled: z.number(), previousLeads: z.number().nullable() })),
    monthly: z.array(z.object({ month: z.string(), leads: z.number(), meetings: z.number(), applications: z.number(), enrolled: z.number() })),
    breakdowns: z.object({
      source: z.array(breakdownRow),
      campaign: z.array(breakdownRow),
      country: z.array(breakdownRow),
      course: z.array(breakdownRow),
      branch: z.array(breakdownRow),
      counsellor: z.array(breakdownRow.extend({ overdueFollowUps: z.number(), completedFollowUps: z.number(), activities: z.number(), revenue: z.record(z.string(), z.number()) })),
    }),
    followUps: z.object({
      dueToday: z.number(),
      overdue: z.number(),
      upcoming7Days: z.number(),
      completedInPeriod: z.number(),
      scheduledInPeriod: z.number(),
      completionRate: z.number(),
      appliesFilters: z.array(z.string()).openapi({ description: 'Follow-up figures honour only these filters' }),
    }),
    activities: z.array(z.object({ type: z.string(), count: z.number() })),
  })
  .openapi('DashboardOverview');
