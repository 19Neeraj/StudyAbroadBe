import { Types, type PipelineStage } from 'mongoose';
import { DEFAULT_MILESTONE_STAGES } from '../../constants/lookups.js';
import type { ServiceContext } from '../../types/auth.js';
import { hasOrgScope } from '../../utils/access.js';
import { compileFilterTree } from '../../utils/filterTree.js';
import { resolvePeriod } from '../../utils/time.js';
import { ActivityModel } from '../activities/activity.model.js';
import { scopedLeadFilter } from '../leads/lead.access.js';
import { LEAD_FILTER_FIELDS } from '../leads/lead.filters.js';
import { LeadModel } from '../leads/lead.model.js';
import { getOrgSettings } from '../organizations/orgSettings.js';
import { listLookups } from '../settings/lookup.service.js';
import { UserModel } from '../users/user.model.js';
import { callScopeFilter } from './call.service.js';
import { CallModel } from './call.model.js';
import type { CallAnalyticsQuery } from './call.validation.js';

type Filter = Record<string, unknown>;
const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);
const CONNECTED = { $or: [{ $eq: ['$status', 'answered'] }, { $and: [{ $eq: ['$status', 'completed'] }, { $gt: ['$duration', 0] }] }] };
const MISSED_STATUSES = ['missed', 'no_answer', 'busy', 'rejected', 'failed'];
const DURATION_BUCKETS = [
  { key: 'none', label: 'Not connected', max: 0 },
  { key: 'lt2', label: '< 2 min', max: 119 },
  { key: '2to5', label: '2–5 min', max: 299 },
  { key: '5to10', label: '5–10 min', max: 599 },
  { key: '10to20', label: '10–20 min', max: 1199 },
  { key: 'gt20', label: '20+ min', max: Number.POSITIVE_INFINITY },
];

/** Stage index of each milestone (configured via stage meta, else default keys). */
async function milestoneIndexes(ctx: ServiceContext) {
  const stages = await listLookups(ctx, 'lead_stage', false);
  const keys = stages.map((s) => s.key);
  const idx = (m: keyof typeof DEFAULT_MILESTONE_STAGES) => {
    const marked = stages.findIndex((s) => (s.meta as { milestone?: string } | undefined)?.milestone === m);
    return marked >= 0 ? marked : keys.indexOf(DEFAULT_MILESTONE_STAGES[m]);
  };
  return { keys, meeting: idx('meeting'), application: idx('application'), offer: idx('offer'), enrolment: idx('enrolment') };
}

const callGroup = {
  calls: { $sum: 1 },
  connected: { $sum: { $cond: [CONNECTED, 1, 0] } },
  missed: { $sum: { $cond: [{ $in: ['$status', MISSED_STATUSES] }, 1, 0] } },
  talkTime: { $sum: '$duration' },
  leads: { $addToSet: '$leadId' },
};

interface GroupRow {
  _id: unknown;
  calls: number;
  connected: number;
  missed: number;
  talkTime: number;
  leads: (Types.ObjectId | null)[];
}

export async function callAnalytics(ctx: ServiceContext, q: CallAnalyticsQuery) {
  const { timezone } = await getOrgSettings(ctx.organizationId);
  const range = resolvePeriod(q.period, timezone, { from: q.dateFrom, to: q.dateTo });
  const from = range.from ?? new Date(0);

  const and: Filter[] = [{ startedAt: { $gte: from, $lt: range.to } }];
  if (q.branchId) and.push({ branchId: new Types.ObjectId(q.branchId) });
  if (q.counsellor) and.push({ counsellorId: new Types.ObjectId(q.counsellor) });
  if (q.source?.length) and.push({ leadSource: { $in: q.source } });
  if (q.campaign) and.push({ campaign: q.campaign });
  if (q.country) and.push({ countryInterested: q.country });
  if (q.course) and.push({ courseInterested: q.course });
  if (q.filter) {
    const leadIds = await LeadModel.distinct('_id', scopedLeadFilter(ctx, compileFilterTree(q.filter, LEAD_FILTER_FIELDS)));
    and.push({ leadId: { $in: leadIds } });
  }
  const match = { ...callScopeFilter(ctx), $and: and };
  const days = (range.to.getTime() - from.getTime()) / 86_400_000;
  const unit = !range.from || days > 366 ? 'month' : days > 62 ? 'week' : 'day';

  const [outcomes, ms] = await Promise.all([listLookups(ctx, 'call_outcome', true), milestoneIndexes(ctx)]);
  const positive = outcomes.filter((o) => (o.meta as { isPositive?: boolean } | undefined)?.isPositive).map((o) => o.key);

  const [facet] = await CallModel.aggregate<Record<string, GroupRow[]>>([
    { $match: match },
    {
      $facet: {
        totals: [{ $group: { _id: null, ...callGroup, outgoing: { $sum: { $cond: [{ $eq: ['$direction', 'outgoing'] }, 1, 0] } }, incoming: { $sum: { $cond: [{ $eq: ['$direction', 'incoming'] }, 1, 0] } }, interestedLeads: { $addToSet: { $cond: [{ $in: ['$callOutcome', positive] }, '$leadId', '$$REMOVE'] } } } }],
        byDay: [{ $group: { _id: { $dateTrunc: { date: '$startedAt', unit, timezone, ...(unit === 'week' ? { startOfWeek: 'monday' } : {}) } }, ...callGroup } }, { $sort: { _id: 1 } }],
        byCounsellor: [{ $group: { _id: '$counsellorId', ...callGroup, positive: { $sum: { $cond: [{ $in: ['$callOutcome', positive] }, 1, 0] } } } }, { $sort: { calls: -1 } }, { $limit: 200 }],
        byOutcome: [{ $group: { _id: { $ifNull: ['$callOutcome', null] }, calls: { $sum: 1 } } }, { $sort: { calls: -1 } }],
        bySource: [{ $group: { _id: { $ifNull: ['$leadSource', null] }, ...callGroup } }, { $sort: { calls: -1 } }, { $limit: 30 }],
        byCampaign: [{ $group: { _id: { $ifNull: ['$campaign', null] }, ...callGroup } }, { $sort: { calls: -1 } }, { $limit: 30 }],
        byCountry: [{ $group: { _id: { $ifNull: ['$countryInterested', null] }, ...callGroup } }, { $sort: { calls: -1 } }, { $limit: 30 }],
        byCourse: [{ $group: { _id: { $ifNull: ['$courseInterested', null] }, ...callGroup } }, { $sort: { calls: -1 } }, { $limit: 30 }],
        byHour: [{ $group: { _id: { $hour: { date: '$startedAt', timezone } }, ...callGroup } }, { $sort: { _id: 1 } }],
        perLead: [{ $match: { leadId: { $ne: null } } }, { $group: { _id: '$leadId', talkTime: { $sum: '$duration' }, calls: { $sum: 1 } } }],
      },
    },
  ]);
  const f = facet ?? {};
  const totals = (f.totals?.[0] ?? { calls: 0, connected: 0, missed: 0, talkTime: 0, leads: [], outgoing: 0, incoming: 0, interestedLeads: [] }) as unknown as GroupRow & { outgoing: number; incoming: number; interestedLeads: Types.ObjectId[] };

  // Where are the called leads now? One aggregation over the distinct called leads (no N+1).
  const perLead = (f.perLead ?? []) as unknown as { _id: Types.ObjectId; talkTime: number; calls: number }[];
  const stageOf = new Map<string, number>();
  if (perLead.length) {
    const rows = await LeadModel.aggregate<{ _id: Types.ObjectId; idx: number }>([
      { $match: { organizationId: ctx.organizationId, _id: { $in: perLead.map((l) => l._id) } } },
      { $project: { idx: { $indexOfArray: [ms.keys, '$leadStage'] } } },
    ]);
    for (const r of rows) stageOf.set(r._id.toString(), r.idx);
  }
  const reached = (leads: (Types.ObjectId | null)[], milestone: number) =>
    milestone < 0 ? 0 : leads.filter((l) => l && (stageOf.get(l.toString()) ?? -1) >= milestone).length;
  const outcomesOf = (leads: (Types.ObjectId | null)[]) => {
    const set = leads.filter((l): l is Types.ObjectId => !!l);
    return { uniqueLeads: set.length, meetings: reached(set, ms.meeting), applications: reached(set, ms.application), offers: reached(set, ms.offer), enrolments: reached(set, ms.enrolment) };
  };
  const shape = (r: GroupRow) => ({
    key: r._id === null || r._id === undefined ? null : String(r._id),
    calls: r.calls,
    connected: r.connected,
    missed: r.missed,
    connectRate: pct(r.connected, r.calls),
    talkTime: r.talkTime,
    avgDuration: r.connected ? Math.round(r.talkTime / r.connected) : 0,
    ...outcomesOf(r.leads),
  });

  const counsellorRows = (f.byCounsellor ?? []) as (GroupRow & { positive: number })[];
  const users = await UserModel.find({ organizationId: ctx.organizationId, _id: { $in: counsellorRows.map((r) => r._id).filter(Boolean) } }).select('fullName').lean();
  const names = new Map(users.map((u) => [u._id.toString(), u.fullName ?? '']));

  // Conversion by talk time (spec §54): leads bucketed by their total talk time in the period.
  const buckets = DURATION_BUCKETS.map((b) => ({ key: b.key, label: b.label, leads: 0, applications: 0, enrolments: 0 }));
  for (const l of perLead) {
    const i = DURATION_BUCKETS.findIndex((b) => l.talkTime <= b.max);
    const bucket = buckets[i]!;
    bucket.leads++;
    const st = stageOf.get(l._id.toString()) ?? -1;
    if (ms.application >= 0 && st >= ms.application) bucket.applications++;
    if (ms.enrolment >= 0 && st >= ms.enrolment) bucket.enrolments++;
  }

  // First response time (spec §43) for leads created in the period.
  const leadMatch = scopedLeadFilter(ctx, { createdAt: { $gte: from, $lt: range.to } }, ...(q.branchId ? [{ branchId: new Types.ObjectId(q.branchId) }] : []), ...(q.counsellor ? [{ assignedCounsellor: new Types.ObjectId(q.counsellor) }] : []));
  const responseMinutes = { $divide: [{ $subtract: ['$firstContactAt', '$createdAt'] }, 60_000] };
  const [response] = await LeadModel.aggregate<{ overall: { avg: number | null; median: number[] | null; contacted: number; total: number }[]; perCounsellor: { _id: Types.ObjectId | null; avg: number; median: number[]; contacted: number }[] }>([
    { $match: leadMatch },
    {
      $facet: {
        overall: [{ $group: { _id: null, total: { $sum: 1 }, contacted: { $sum: { $cond: [{ $ifNull: ['$firstContactAt', false] }, 1, 0] } }, avg: { $avg: { $cond: [{ $ifNull: ['$firstContactAt', false] }, responseMinutes, null] } }, median: { $percentile: { input: { $cond: [{ $ifNull: ['$firstContactAt', false] }, responseMinutes, null] }, p: [0.5], method: 'approximate' } } } }],
        perCounsellor: [
          { $match: { firstContactAt: { $ne: null } } },
          { $group: { _id: '$assignedCounsellor', contacted: { $sum: 1 }, avg: { $avg: responseMinutes }, median: { $percentile: { input: responseMinutes, p: [0.5], method: 'approximate' } } } },
          { $sort: { avg: 1 } },
        ],
      },
    } as PipelineStage.Facet,
  ]);
  const ov = response?.overall[0];
  const responseUsers = await UserModel.find({ organizationId: ctx.organizationId, _id: { $in: (response?.perCounsellor ?? []).map((r) => r._id).filter(Boolean) } }).select('fullName').lean();
  const responseNames = new Map(responseUsers.map((u) => [u._id.toString(), u.fullName ?? '']));
  const round = (n: number | null | undefined) => (n === null || n === undefined ? null : Math.round(n * 10) / 10);

  // Other channels in the same period (unified communication KPIs).
  const actMatch: Filter = { organizationId: ctx.organizationId, occurredAt: { $gte: from, $lt: range.to }, type: { $in: ['whatsapp', 'email', 'meeting'] } };
  if (!hasOrgScope(ctx)) actMatch.userId = ctx.userId;
  if (q.counsellor) actMatch.userId = new Types.ObjectId(q.counsellor);
  const channels = await ActivityModel.aggregate<{ _id: string; count: number }>([{ $match: actMatch }, { $group: { _id: '$type', count: { $sum: 1 } } }]);

  const t = shape(totals);
  const interested = (totals.interestedLeads ?? []).length;
  return {
    range: { period: q.period, from: range.from?.toISOString() ?? null, to: range.to.toISOString(), timezone, granularity: unit },
    totals: { ...t, outgoing: totals.outgoing ?? 0, incoming: totals.incoming ?? 0, interestedLeads: interested },
    funnel: [
      { step: 'calls', label: 'Calls', value: t.calls },
      { step: 'leads_called', label: 'Students called', value: t.uniqueLeads },
      { step: 'connected', label: 'Connected', value: perLead.filter((l) => l.talkTime > 0).length },
      { step: 'interested', label: 'Interested', value: interested },
      { step: 'meetings', label: 'Meetings', value: t.meetings },
      { step: 'applications', label: 'Applications', value: t.applications },
      { step: 'enrolments', label: 'Enrolments', value: t.enrolments },
    ],
    trend: ((f.byDay ?? []) as GroupRow[]).map((r) => ({ bucket: (r._id as Date).toISOString(), calls: r.calls, connected: r.connected, talkTime: r.talkTime })),
    byHour: ((f.byHour ?? []) as GroupRow[]).map((r) => ({ hour: Number(r._id), calls: r.calls, connected: r.connected })),
    byCounsellor: counsellorRows.map((r) => ({
      ...shape(r),
      label: r._id ? (names.get(String(r._id)) ?? 'Unknown') : 'Unassigned',
      positiveOutcomes: r.positive,
      callsPerApplication: (() => {
        const apps = reached(r.leads, ms.application);
        return apps ? Math.round((r.calls / apps) * 10) / 10 : null;
      })(),
    })),
    byOutcome: ((f.byOutcome ?? []) as GroupRow[]).map((r) => ({ key: r._id === null ? null : String(r._id), calls: r.calls })),
    bySource: ((f.bySource ?? []) as GroupRow[]).map(shape),
    byCampaign: ((f.byCampaign ?? []) as GroupRow[]).map(shape),
    byCountry: ((f.byCountry ?? []) as GroupRow[]).map(shape),
    byCourse: ((f.byCourse ?? []) as GroupRow[]).map(shape),
    durationConversion: buckets.map((b) => ({ ...b, applicationRate: pct(b.applications, b.leads) })),
    firstResponse: {
      leadsCreated: ov?.total ?? 0,
      contacted: ov?.contacted ?? 0,
      notContacted: (ov?.total ?? 0) - (ov?.contacted ?? 0),
      avgMinutes: round(ov?.avg),
      medianMinutes: round(ov?.median?.[0]),
      byCounsellor: (response?.perCounsellor ?? []).map((r) => ({ key: r._id?.toString() ?? null, label: r._id ? (responseNames.get(r._id.toString()) ?? 'Unknown') : 'Unassigned', contacted: r.contacted, avgMinutes: round(r.avg), medianMinutes: round(r.median?.[0]) })),
    },
    channels: { whatsapp: 0, email: 0, meeting: 0, ...Object.fromEntries(channels.map((c) => [c._id, c.count])) },
  };
}
