import { Types, type PipelineStage } from 'mongoose';
import { COMMUNICATION_TYPES } from '../../constants/activities.js';
import { DEFAULT_MILESTONE_STAGES, STAGE_MILESTONES, type StageMilestone } from '../../constants/lookups.js';
import type { ServiceContext } from '../../types/auth.js';
import { recordScope } from '../../utils/access.js';
import { compileFilterTree } from '../../utils/filterTree.js';
import { addDays, localParts, resolvePeriod, startOfDayInTz, startOfLocalDate, type PeriodRange } from '../../utils/time.js';
import { ActivityModel } from '../activities/activity.model.js';
import { BranchModel } from '../branches/branch.model.js';
import { OPEN_FOLLOWUP_STATUSES, FollowUpModel } from '../followups/followup.model.js';
import { followUpScope } from '../followups/followup.service.js';
import { scopedLeadFilter } from '../leads/lead.access.js';
import { LEAD_FILTER_FIELDS } from '../leads/lead.filters.js';
import { LeadModel } from '../leads/lead.model.js';
import { getOrgSettings } from '../organizations/orgSettings.js';
import { listLookups } from '../settings/lookup.service.js';
import { UserModel } from '../users/user.model.js';
import { PaymentModel } from '../payments/payment.model.js';
import { ownershipScope } from '../../utils/access.js';
import type { DashboardQuery } from './dashboard.validation.js';

type Filter = Record<string, unknown>;
type Granularity = 'day' | 'week' | 'month';
type Milestones = Record<StageMilestone, number>;

const MILESTONE_LABELS: Record<StageMilestone, string> = {
  contacted: 'Contact rate',
  meeting: 'Meeting rate',
  shortlisting: 'Shortlisting rate',
  application: 'Application rate',
  offer: 'Offer rate',
  payment: 'Payment rate',
  visa: 'Visa rate',
  enrolment: 'Enrolment rate',
};

const pct = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 1000) / 10 : 0);

interface StageInfo {
  key: string;
  label: string;
  color: string | null;
}

/** Stage keys in pipeline order and the index of the stage that counts as each milestone. */
async function stageModel(ctx: ServiceContext) {
  const lookups = await listLookups(ctx, 'lead_stage', false);
  const stages: StageInfo[] = lookups.map((s) => ({ key: s.key, label: s.label, color: s.color ?? null }));
  const keys = stages.map((s) => s.key);
  const milestoneIdx = {} as Record<StageMilestone, number>;
  for (const m of STAGE_MILESTONES) {
    const marked = lookups.findIndex((s) => (s.meta as { milestone?: string } | undefined)?.milestone === m);
    milestoneIdx[m] = marked >= 0 ? marked : keys.indexOf(DEFAULT_MILESTONE_STAGES[m]);
  }
  return { stages, keys, milestoneIdx };
}

async function closedStatusKeys(ctx: ServiceContext): Promise<string[]> {
  const statuses = await listLookups(ctx, 'lead_status', true);
  return statuses.filter((s) => (s.meta as { isClosed?: boolean } | undefined)?.isClosed === true).map((s) => s.key);
}

/** Lead-level dimension filters shared by every lead aggregation (not date-bounded). */
function dimensionFilters(q: DashboardQuery): Filter[] {
  const and: Filter[] = [];
  if (q.branchId) and.push({ branchId: new Types.ObjectId(q.branchId) });
  if (q.counsellor) and.push({ assignedCounsellor: q.counsellor === 'unassigned' ? null : new Types.ObjectId(q.counsellor) });
  if (q.manager) and.push({ assignedManager: new Types.ObjectId(q.manager) });
  if (q.source?.length) and.push({ leadSource: { $in: q.source } });
  if (q.campaign) and.push({ campaign: q.campaign });
  if (q.country) and.push({ countryInterested: q.country });
  if (q.course) and.push({ courseInterested: q.course });
  if (q.intake) and.push({ intake: q.intake });
  if (q.filter) and.push(compileFilterTree(q.filter, LEAD_FILTER_FIELDS));
  return and;
}

function granularityFor(range: PeriodRange): Granularity {
  if (!range.from) return 'month';
  const days = (range.to.getTime() - range.from.getTime()) / 86_400_000;
  return days <= 62 ? 'day' : days <= 366 ? 'week' : 'month';
}

/** `$sum` expressions counting leads whose current stage is at or beyond each milestone stage. */
function milestoneSums(milestoneIdx: Record<StageMilestone, number>) {
  return Object.fromEntries(
    STAGE_MILESTONES.map((m) => [
      `m_${m}`,
      { $sum: milestoneIdx[m] < 0 ? 0 : { $cond: [{ $gte: ['$_stageIdx', milestoneIdx[m]] }, 1, 0] } },
    ]),
  );
}

const readMilestones = (row: Record<string, unknown> | undefined): Milestones =>
  Object.fromEntries(STAGE_MILESTONES.map((m) => [m, Number(row?.[`m_${m}`] ?? 0)])) as Milestones;

function annotate(keys: string[], closed: string[]): PipelineStage[] {
  return [
    {
      $addFields: {
        _stageIdx: { $indexOfArray: [keys, '$leadStage'] },
        _closed: { $in: ['$leadStatus', closed] },
      },
    },
  ];
}

function breakdownGroup(idExpr: unknown, sums: Record<string, unknown>, limit: number): PipelineStage.FacetPipelineStage[] {
  return [
    { $group: { _id: idExpr, leads: { $sum: 1 }, closed: { $sum: { $cond: ['$_closed', 1, 0] } }, ...sums } },
    { $sort: { leads: -1, _id: 1 } },
    { $limit: limit },
  ];
}

interface RawBreakdown {
  _id: unknown;
  leads: number;
  closed: number;
  [k: string]: unknown;
}

function toBreakdown(rows: RawBreakdown[], labels?: Map<string, string>) {
  return rows.map((r) => {
    const key = r._id === null || r._id === undefined || r._id === '' ? null : String(r._id);
    const milestones = readMilestones(r);
    return {
      key,
      label: key && labels ? (labels.get(key) ?? 'Unknown') : null,
      leads: r.leads,
      active: r.leads - r.closed,
      closed: r.closed,
      milestones,
      conversionRate: pct(milestones.enrolment, r.leads),
    };
  });
}

/** Local bucket starts between `from` and `to`, so charts show empty days/weeks/months as zero. */
function bucketStarts(timeZone: string, from: Date, to: Date, unit: Granularity): Date[] {
  const out: Date[] = [];
  const p = localParts(timeZone, from);
  let i = 0;
  let cursor: Date;
  const first =
    unit === 'month'
      ? startOfLocalDate(timeZone, p.year, p.month, 1)
      : unit === 'week'
        ? startOfLocalDate(timeZone, p.year, p.month, p.day - ((p.weekday + 6) % 7))
        : startOfLocalDate(timeZone, p.year, p.month, p.day);
  const fp = localParts(timeZone, first);
  do {
    cursor =
      unit === 'month'
        ? startOfLocalDate(timeZone, fp.year, fp.month + i, 1)
        : startOfLocalDate(timeZone, fp.year, fp.month, fp.day + i * (unit === 'week' ? 7 : 1));
    if (cursor < to) out.push(cursor);
    i++;
  } while (cursor < to && i < 400);
  return out;
}

export async function dashboardOverview(ctx: ServiceContext, q: DashboardQuery) {
  const settings = await getOrgSettings(ctx.organizationId);
  const tz = settings.timezone;
  const now = new Date();
  const range = resolvePeriod(q.period, tz, { from: q.dateFrom, to: q.dateTo }, now);
  const granularity = granularityFor(range);
  const [{ stages, keys, milestoneIdx }, closed] = await Promise.all([stageModel(ctx), closedStatusKeys(ctx)]);

  const dims = dimensionFilters(q);
  const allLeads = scopedLeadFilter(ctx, ...dims);
  const created = (from: Date | null, to: Date) => (from ? { createdAt: { $gte: from, $lt: to } } : { createdAt: { $lt: to } });
  const cohort = scopedLeadFilter(ctx, ...dims, created(range.from, range.to));
  const sums = milestoneSums(milestoneIdx);
  const wonIdx = milestoneIdx.enrolment;
  const wonExpr = wonIdx < 0 ? 0 : { $cond: [{ $gte: ['$_stageIdx', wonIdx] }, 1, 0] };
  const pre = annotate(keys, closed);

  // 1) Cohort of leads created in the period: funnel, statuses, breakdowns, trend.
  const cohortAgg = LeadModel.aggregate<Record<string, RawBreakdown[] & Record<string, unknown>[]>>([
    { $match: cohort },
    ...pre,
    {
      $facet: {
        totals: [{ $group: { _id: null, leads: { $sum: 1 }, closed: { $sum: { $cond: ['$_closed', 1, 0] } }, ...sums } }],
        byStage: [{ $group: { _id: '$_stageIdx', count: { $sum: 1 } } }],
        byStatus: [{ $group: { _id: '$leadStatus', count: { $sum: 1 } } }, { $sort: { count: -1 } }],
        source: breakdownGroup('$leadSource', sums, 50),
        campaign: breakdownGroup({ $ifNull: ['$campaign', null] }, sums, 20),
        country: breakdownGroup({ $ifNull: ['$countryInterested', null] }, sums, 25),
        course: breakdownGroup({ $ifNull: ['$courseInterested', null] }, sums, 25),
        branch: breakdownGroup({ $ifNull: ['$branchId', null] }, sums, 50),
        counsellor: breakdownGroup({ $ifNull: ['$assignedCounsellor', null] }, sums, 100),
        trend: [
          {
            $group: {
              _id: { $dateTrunc: { date: '$createdAt', unit: granularity, timezone: tz, ...(granularity === 'week' ? { startOfWeek: 'monday' } : {}) } },
              leads: { $sum: 1 },
              enrolled: { $sum: wonExpr },
            },
          },
          { $sort: { _id: 1 } },
        ],
      },
    },
  ]);

  // 2) Previous period totals for comparison.
  const previousAgg = range.previous
    ? LeadModel.aggregate<Record<string, unknown>>([
        { $match: scopedLeadFilter(ctx, ...dims, created(range.previous.from, range.previous.to)) },
        ...pre,
        { $group: { _id: null, leads: { $sum: 1 }, closed: { $sum: { $cond: ['$_closed', 1, 0] } }, ...sums } },
      ])
    : Promise.resolve([]);
  const previousTrendAgg =
    range.previous && granularity !== 'month'
      ? LeadModel.aggregate<{ _id: Date; leads: number }>([
          { $match: scopedLeadFilter(ctx, ...dims, created(range.previous.from, range.previous.to)) },
          { $group: { _id: { $dateTrunc: { date: '$createdAt', unit: granularity, timezone: tz, ...(granularity === 'week' ? { startOfWeek: 'monday' } : {}) } }, leads: { $sum: 1 } } },
          { $sort: { _id: 1 } },
        ])
      : Promise.resolve([]);

  // 3) Snapshot of every lead matching the filters (any date): totals and the live pipeline.
  const snapshotAgg = LeadModel.aggregate<{ totals: Record<string, number>[]; pipeline: { _id: number; count: number }[] }>([
    { $match: allLeads },
    ...pre,
    {
      $facet: {
        totals: [
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              active: { $sum: { $cond: ['$_closed', 0, 1] } },
              unassigned: { $sum: { $cond: [{ $and: [{ $not: ['$_closed'] }, { $eq: [{ $ifNull: ['$assignedCounsellor', null] }, null] }] }, 1, 0] } },
            },
          },
        ],
        pipeline: [{ $match: { _closed: false } }, { $group: { _id: '$_stageIdx', count: { $sum: 1 } } }],
      },
    },
  ]);

  // 4) Last 12 calendar months (monthly comparison), independent of the period.
  const p = localParts(tz, now);
  const monthsFrom = startOfLocalDate(tz, p.year, p.month - 11, 1);
  const monthlyAgg = LeadModel.aggregate<{ _id: Date; leads: number; m_meeting: number; m_application: number; m_enrolment: number }>([
    { $match: scopedLeadFilter(ctx, ...dims, { createdAt: { $gte: monthsFrom } }) },
    ...pre,
    { $group: { _id: { $dateTrunc: { date: '$createdAt', unit: 'month', timezone: tz } }, leads: { $sum: 1 }, ...sums } },
    { $sort: { _id: 1 } },
  ]);

  // 5) Follow-ups (scope + branch/counsellor filters; lead-level filters would need a join per row).
  const fuFilter: Filter = { ...followUpScope(ctx) };
  const fuAnd: Filter[] = [];
  if (q.branchId) fuAnd.push({ branchId: new Types.ObjectId(q.branchId) });
  if (q.counsellor && q.counsellor !== 'unassigned') fuAnd.push({ assignedTo: new Types.ObjectId(q.counsellor) });
  if (fuAnd.length) fuFilter.$and = fuAnd;
  const today = startOfDayInTz(tz, now);
  const tomorrow = addDays(today, 1);
  const periodFrom = range.from ?? new Date(0);
  const open = { $in: ['$status', OPEN_FOLLOWUP_STATUSES] };
  const followUpAgg = FollowUpModel.aggregate<{ totals: Record<string, number>[]; perUser: { _id: Types.ObjectId; overdue: number; completed: number }[] }>([
    { $match: fuFilter },
    {
      $facet: {
        totals: [
          {
            $group: {
              _id: null,
              dueToday: { $sum: { $cond: [{ $and: [open, { $gte: ['$dueAt', today] }, { $lt: ['$dueAt', tomorrow] }] }, 1, 0] } },
              overdue: { $sum: { $cond: [{ $and: [open, { $lt: ['$dueAt', now] }] }, 1, 0] } },
              upcoming: { $sum: { $cond: [{ $and: [open, { $gte: ['$dueAt', tomorrow] }, { $lt: ['$dueAt', addDays(tomorrow, 7)] }] }, 1, 0] } },
              completed: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'completed'] }, { $gte: ['$completedAt', periodFrom] }, { $lt: ['$completedAt', range.to] }] }, 1, 0] } },
              scheduled: { $sum: { $cond: [{ $and: [{ $gte: ['$dueAt', periodFrom] }, { $lt: ['$dueAt', range.to < now ? range.to : now] }, { $ne: ['$status', 'cancelled'] }] }, 1, 0] } },
            },
          },
        ],
        perUser: [
          {
            $group: {
              _id: '$assignedTo',
              overdue: { $sum: { $cond: [{ $and: [open, { $lt: ['$dueAt', now] }] }, 1, 0] } },
              completed: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'completed'] }, { $gte: ['$completedAt', periodFrom] }, { $lt: ['$completedAt', range.to] }] }, 1, 0] } },
            },
          },
        ],
      },
    },
  ]);

  // 6) Logged communications in the period (calls, WhatsApp, emails, meetings).
  const actFilter: Filter = { organizationId: ctx.organizationId, occurredAt: { $gte: periodFrom, $lt: range.to }, type: { $in: COMMUNICATION_TYPES } };
  if (recordScope(ctx) !== 'organization') {
    if (recordScope(ctx) === 'own') actFilter.userId = ctx.userId;
    else {
      const teammates = await UserModel.find({ organizationId: ctx.organizationId, branchIds: { $in: ctx.branchIds } }).select('_id').lean();
      actFilter.userId = { $in: [ctx.userId, ...teammates.map((u) => u._id)] };
    }
  }
  if (q.counsellor && q.counsellor !== 'unassigned') {
    actFilter.userId = recordScope(ctx) === 'own' && q.counsellor !== ctx.userId.toString() ? null : new Types.ObjectId(q.counsellor);
  }
  const activityAgg = ActivityModel.aggregate<{ _id: { type: string; user: Types.ObjectId }; count: number }>([
    { $match: actFilter },
    { $group: { _id: { type: '$type', user: '$userId' }, count: { $sum: 1 } } },
  ]);

  // 7) Revenue: successful payments by payment date (current vs previous period), per currency and counsellor.
  const payDims: Filter[] = [];
  if (q.branchId) payDims.push({ branchId: new Types.ObjectId(q.branchId) });
  if (q.counsellor && q.counsellor !== 'unassigned') payDims.push({ assignedCounsellor: new Types.ObjectId(q.counsellor) });
  const paid = (from: Date | null, to: Date) => ownershipScope(ctx, { paymentStatus: 'success', paymentDate: { ...(from ? { $gte: from } : {}), $lt: to }, ...(payDims.length ? { $and: payDims } : {}) });
  const revenueAgg = Promise.all([
    PaymentModel.aggregate<{ _id: { currency: string; counsellor: Types.ObjectId | null }; amount: number }>([
      { $match: paid(range.from, range.to) },
      { $group: { _id: { currency: '$currency', counsellor: { $ifNull: ['$assignedCounsellor', null] } }, amount: { $sum: '$amount' } } },
    ]),
    range.previous
      ? PaymentModel.aggregate<{ _id: string; amount: number }>([{ $match: paid(range.previous.from, range.previous.to) }, { $group: { _id: '$currency', amount: { $sum: '$amount' } } }])
      : Promise.resolve(null),
  ]);

  const [[c], [prev], prevTrend, [snap], monthly, [fu], acts, [revRows, revPrev]] = await Promise.all([
    cohortAgg, previousAgg, previousTrendAgg, snapshotAgg, monthlyAgg, followUpAgg, activityAgg, revenueAgg,
  ]);
  const revenueByCurrency = new Map<string, number>();
  const revenueByCounsellor = new Map<string, Record<string, number>>();
  for (const r of revRows) {
    revenueByCurrency.set(r._id.currency, (revenueByCurrency.get(r._id.currency) ?? 0) + r.amount);
    const k = r._id.counsellor ? String(r._id.counsellor) : 'none';
    const m = revenueByCounsellor.get(k) ?? {};
    m[r._id.currency] = (m[r._id.currency] ?? 0) + r.amount;
    revenueByCounsellor.set(k, m);
  }
  const prevRevenue = new Map((revPrev ?? []).map((r) => [r._id, r.amount]));
  const currencies = [...new Set([settings.currency, ...revenueByCurrency.keys(), ...prevRevenue.keys()])];
  const revenue = currencies.map((currency) => ({ currency, current: revenueByCurrency.get(currency) ?? 0, previous: range.previous ? (prevRevenue.get(currency) ?? 0) : null }));
  if (!c || !snap || !fu) throw new Error('Dashboard aggregation returned no result');

  // Names for user/branch rows: one query each (no N+1).
  const counsellorRows = c.counsellor as RawBreakdown[];
  const userIds = [...new Set([...counsellorRows.map((r) => r._id), ...fu.perUser.map((r) => r._id)].filter(Boolean).map(String))];
  const branchIds = (c.branch as RawBreakdown[]).map((r) => r._id).filter(Boolean);
  const [users, branches] = await Promise.all([
    UserModel.find({ organizationId: ctx.organizationId, _id: { $in: userIds } }).select('fullName').lean(),
    BranchModel.find({ organizationId: ctx.organizationId, _id: { $in: branchIds } }).select('name').lean(),
  ]);
  const userNames = new Map(users.map((u) => [u._id.toString(), u.fullName ?? '']));
  const branchNames = new Map(branches.map((b) => [b._id.toString(), b.name]));

  const fuByUser = new Map(fu.perUser.map((r) => [String(r._id), r]));
  const actsByUser = new Map<string, number>();
  const actsByType = new Map<string, number>();
  for (const a of acts) {
    actsByUser.set(String(a._id.user), (actsByUser.get(String(a._id.user)) ?? 0) + a.count);
    actsByType.set(a._id.type, (actsByType.get(a._id.type) ?? 0) + a.count);
  }

  // Funnel: a lead "reached" a stage if its current stage is that one or later.
  const stageCounts = new Map((c.byStage as unknown as { _id: number; count: number }[]).map((r) => [r._id, r.count]));
  const reached: number[] = [];
  for (let i = stages.length - 1, acc = 0; i >= 0; i--) {
    acc += stageCounts.get(i) ?? 0;
    reached[i] = acc;
  }
  const totals = (c.totals as unknown as Record<string, number>[])[0];
  const newLeads = totals?.leads ?? 0;
  const funnel = stages.map((s, i) => ({
    ...{ stage: s.key, label: s.label, color: s.color },
    reached: reached[i] ?? 0,
    current: stageCounts.get(i) ?? 0,
    conversionFromPrevious: i === 0 ? 100 : pct(reached[i] ?? 0, reached[i - 1] ?? 0),
    conversionFromTop: pct(reached[i] ?? 0, reached[0] ?? 0),
  }));

  const curM = readMilestones(totals);
  const prevM = range.previous ? readMilestones(prev) : null;
  const prevLeads = range.previous ? Number(prev?.leads ?? 0) : null;
  const rates = STAGE_MILESTONES.map((m, i) => {
    const before = i === 0 ? newLeads : curM[STAGE_MILESTONES[i - 1]!];
    const idx = milestoneIdx[m];
    return { milestone: m, label: MILESTONE_LABELS[m], stage: idx >= 0 ? (keys[idx] ?? null) : null, reached: curM[m], rate: pct(curM[m], before) };
  });

  const pipelineCounts = new Map(snap.pipeline.map((r) => [r._id, r.count]));
  const fuTotals = fu.totals[0] ?? {};
  const snapTotals = snap.totals[0] ?? {};

  // Trend with empty buckets filled; previous series aligned by position.
  const trendRows = new Map((c.trend as unknown as { _id: Date; leads: number; enrolled: number }[]).map((r) => [r._id.getTime(), r]));
  const trendFrom = range.from ?? ((c.trend as unknown as { _id: Date }[])[0]?._id ?? null);
  const buckets = trendFrom ? bucketStarts(tz, trendFrom, range.to, granularity) : [];
  const prevBuckets = range.previous && granularity !== 'month' ? bucketStarts(tz, range.previous.from, range.previous.to, granularity) : [];
  const prevByTime = new Map(prevTrend.map((r) => [r._id.getTime(), r.leads]));
  const trend = buckets.map((b, i) => {
    const row = trendRows.get(b.getTime());
    const pb = prevBuckets[i];
    return { bucket: b.toISOString(), leads: row?.leads ?? 0, enrolled: row?.enrolled ?? 0, previousLeads: pb ? (prevByTime.get(pb.getTime()) ?? 0) : null };
  });
  const monthRows = new Map(monthly.map((r) => [r._id.getTime(), r]));

  return {
    range: {
      period: q.period,
      from: range.from?.toISOString() ?? null,
      to: range.to.toISOString(),
      previous: range.previous ? { from: range.previous.from.toISOString(), to: range.previous.to.toISOString() } : null,
      timezone: tz,
      granularity,
    },
    kpis: {
      totalLeads: snapTotals.total ?? 0,
      activeLeads: snapTotals.active ?? 0,
      unassignedLeads: snapTotals.unassigned ?? 0,
      newLeads: { current: newLeads, previous: prevLeads },
      closedLeads: { current: totals?.closed ?? 0, previous: range.previous ? Number(prev?.closed ?? 0) : null },
      milestones: Object.fromEntries(STAGE_MILESTONES.map((m) => [m, { current: curM[m], previous: prevM ? prevM[m] : null }])) as Record<StageMilestone, { current: number; previous: number | null }>,
      conversionRate: { current: pct(curM.enrolment, newLeads), previous: prevM && prevLeads !== null ? pct(prevM.enrolment, prevLeads) : null },
      revenue,
    },
    rates,
    funnel,
    pipeline: stages.map((s, i) => ({ stage: s.key, label: s.label, color: s.color, count: pipelineCounts.get(i) ?? 0 })),
    statuses: (c.byStatus as unknown as { _id: string; count: number }[]).map((r) => ({ key: r._id, count: r.count })),
    trend,
    monthly: bucketStarts(tz, monthsFrom, addDays(now, 1), 'month').map((b) => {
      const r = monthRows.get(b.getTime());
      return { month: b.toISOString(), leads: r?.leads ?? 0, meetings: r?.m_meeting ?? 0, applications: r?.m_application ?? 0, enrolled: r?.m_enrolment ?? 0 };
    }),
    breakdowns: {
      source: toBreakdown(c.source as RawBreakdown[]),
      campaign: toBreakdown(c.campaign as RawBreakdown[]),
      country: toBreakdown(c.country as RawBreakdown[]),
      course: toBreakdown(c.course as RawBreakdown[]),
      branch: toBreakdown(c.branch as RawBreakdown[], branchNames),
      counsellor: toBreakdown(counsellorRows, userNames).map((r) => ({
        ...r,
        label: r.key ? r.label : 'Unassigned',
        overdueFollowUps: r.key ? (fuByUser.get(r.key)?.overdue ?? 0) : 0,
        completedFollowUps: r.key ? (fuByUser.get(r.key)?.completed ?? 0) : 0,
        activities: r.key ? (actsByUser.get(r.key) ?? 0) : 0,
        revenue: revenueByCounsellor.get(r.key ?? 'none') ?? {},
      })),
    },
    followUps: {
      dueToday: fuTotals.dueToday ?? 0,
      overdue: fuTotals.overdue ?? 0,
      upcoming7Days: fuTotals.upcoming ?? 0,
      completedInPeriod: fuTotals.completed ?? 0,
      scheduledInPeriod: fuTotals.scheduled ?? 0,
      completionRate: pct(fuTotals.completed ?? 0, fuTotals.scheduled ?? 0),
      appliesFilters: ['branch', 'counsellor'],
    },
    activities: COMMUNICATION_TYPES.map((type) => ({ type, count: actsByType.get(type) ?? 0 })),
  };
}
