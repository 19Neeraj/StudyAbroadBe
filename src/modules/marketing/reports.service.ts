import { Types, type PipelineStage } from 'mongoose';
import { DEFAULT_MILESTONE_STAGES, type StageMilestone } from '../../constants/lookups.js';
import type { z } from '../../docs/zod.js';
import type { ServiceContext } from '../../types/auth.js';
import { addDays, startOfDayInTz } from '../../utils/time.js';
import { scopedLeadFilter } from '../leads/lead.access.js';
import { LeadModel } from '../leads/lead.model.js';
import { getOrgSettings } from '../organizations/orgSettings.js';
import { listLookups } from '../settings/lookup.service.js';
import { AttributionNodeModel, type Dimension } from './attributionNode.model.js';
import { CampaignMappingModel } from './campaignMapping.model.js';
import { ExternalLeadReferenceModel } from './externalLeadReference.model.js';
import { MarketingCampaignModel } from './marketingCampaign.model.js';
import { MarketingDailyMetricModel } from './marketingDailyMetric.model.js';
import { fromMinor } from './money.js';
import { AttributionTouchpointModel } from './touchpoint.model.js';
import type { reportQuery } from './reports.validation.js';

/**
 * Marketing reports (spec §13, plan §5). Definitions shown to users live in METRIC_DEFINITIONS.
 *  - Cohort basis: leads first acquired in [from, to]; their outcomes count whenever they happen.
 *  - Attribution: first touch by default (plan D3), last touch on request.
 *  - Spend: provider daily rows in [from, to] in each ad account's timezone; only the report
 *    currency is summed (plan D4); other currencies are listed separately, never converted silently.
 *  - A ratio with a zero denominator is null (N/A); spend that wasn't synced is null (unavailable).
 */
export type ReportQuery = z.infer<typeof reportQuery>;

export const METRIC_DEFINITIONS = {
  spend: 'Sum of daily advertising spend reported by the provider for the date range (ad-account timezone), in the report currency.',
  providerLeads: 'Leads reported by the ad platform (e.g. Meta "lead" actions). Not the same as CRM leads.',
  leads: 'Unique CRM leads first acquired in the date range and attributed to the row (merged duplicates count once).',
  qualified: 'Leads that reached the stage marked "qualified" in CRM settings (default: the meeting-done milestone) or later.',
  contacted: 'Leads with at least one recorded contact (call, WhatsApp, email or meeting).',
  meetings: 'Leads that reached the meeting milestone stage or later.',
  applications: 'Leads with at least one university application.',
  admissions: 'Leads with at least one accepted offer.',
  enrolments: 'Leads with an enrolled application or at the enrolment milestone stage.',
  revenue: 'Successful payments (refunds excluded) from those leads, in the report currency, whenever paid.',
  cpl: 'Spend ÷ leads.',
  cpql: 'Spend ÷ qualified leads.',
  costPerApplication: 'Spend ÷ leads with an application.',
  costPerAdmission: 'Spend ÷ leads with an accepted offer.',
  costPerEnrolment: 'Spend ÷ enrolled leads.',
  roas: 'Revenue ÷ spend.',
} as const;

const ratio = (a: number | null, b: number | null) => (a === null || b === null || b === 0 ? null : a / b);
const pct = (a: number, b: number) => (b === 0 ? null : Math.round((a / b) * 1000) / 10);

async function window(ctx: ServiceContext, q: ReportQuery) {
  const { timezone, currency } = await getOrgSettings(ctx.organizationId);
  const fromDate = startOfDayInTz(timezone, new Date(`${q.from}T12:00:00Z`));
  const toDate = addDays(startOfDayInTz(timezone, new Date(`${q.to}T12:00:00Z`)), 1);
  return { timezone, currency: q.currency ?? currency, fromDate, toDate };
}

async function stageIndexes(ctx: ServiceContext) {
  const stages = await listLookups(ctx, 'lead_stage', false);
  const keys = stages.map((s) => s.key);
  const idx = (m: StageMilestone) => {
    const marked = stages.findIndex((s) => (s.meta as { milestone?: string } | undefined)?.milestone === m);
    return marked >= 0 ? marked : keys.indexOf(DEFAULT_MILESTONE_STAGES[m]);
  };
  const qualifiedMarked = stages.findIndex((s) => (s.meta as { qualified?: boolean } | undefined)?.qualified === true);
  return { keys, meeting: idx('meeting'), enrolment: idx('enrolment'), qualified: qualifiedMarked >= 0 ? qualifiedMarked : idx('meeting') };
}

type GroupBy = ReportQuery['groupBy'];
const HIERARCHY = /^(source|medium|campaign)_l([123])$/;

/** Expression for the row key of a lead under the chosen attribution model. */
function keyExpr(groupBy: GroupBy, model: 'first' | 'last'): unknown {
  const t = model === 'first' ? '$firstTouch' : '$_last';
  const h = HIERARCHY.exec(groupBy);
  if (h) return model === 'first' ? { $ifNull: [{ $toString: `$attribution.${h[1]}.l${h[2]}` }, 'unmapped'] } : { $ifNull: [{ $toString: `$_last.${h[1]}.l${h[2]}` }, 'unmapped'] };
  switch (groupBy) {
    case 'campaign':
      return { $cond: [{ $and: [`${t}.provider`, `${t}.campaignExternalId`] }, { $concat: [`${t}.provider`, ':', `${t}.campaignExternalId`] }, 'unattributed'] };
    case 'utm_campaign':
      return { $ifNull: [model === 'first' ? '$firstTouch.utmCampaign' : '$_last.normalized.utm_campaign', 'none'] };
    case 'leadSource':
      return '$leadSource';
    case 'country':
      return { $ifNull: ['$countryInterested', 'unknown'] };
    case 'course':
      return { $ifNull: ['$courseInterested', 'unknown'] };
    case 'intake':
      return { $ifNull: ['$intake', 'unknown'] };
    case 'counsellor':
      return { $ifNull: [{ $toString: '$assignedCounsellor' }, 'unassigned'] };
    case 'branch':
      return { $ifNull: [{ $toString: '$branchId' }, 'none'] };
    default:
      return 'all';
  }
}

/** Per-lead outcomes of the cohort, grouped by row key. */
async function cohortRows(ctx: ServiceContext, q: ReportQuery, fromDate: Date, toDate: Date, currency: string) {
  const s = await stageIndexes(ctx);
  // Lead-side figures follow the caller's lead visibility (data scope, assigned-only); spend is organization-wide.
  const match: Record<string, unknown> = scopedLeadFilter(ctx, { mergedInto: null, leadStatus: { $ne: 'duplicate' }, createdAt: { $gte: fromDate, $lt: toDate } });
  const model = q.model;
  const pre: PipelineStage[] = [{ $match: match }];
  if (model === 'last') {
    pre.push({ $lookup: { from: AttributionTouchpointModel.collection.name, localField: 'lastTouchId', foreignField: '_id', as: '_last' } }, { $set: { _last: { $first: '$_last' } } });
  }
  const touchPath = model === 'first' ? '$firstTouch' : '$_last';
  const after: Record<string, unknown> = {};
  if (q.provider) after[`${touchPath.slice(1)}.provider`] = q.provider;
  if (q.campaignExternalId) after[`${touchPath.slice(1)}.campaignExternalId`] = q.campaignExternalId;
  if (Object.keys(after).length) pre.push({ $match: after });
  const base: PipelineStage[] = [
    ...pre,
    { $set: { _key: keyExpr(q.groupBy, model), _stage: { $indexOfArray: [s.keys, '$leadStage'] } } },
    {
      $lookup: {
        from: 'applications',
        let: { lid: '$_id' },
        pipeline: [{ $match: { $expr: { $and: [{ $eq: ['$leadId', '$$lid'] }, { $eq: ['$organizationId', ctx.organizationId] }] }, deletedAt: null } }, { $project: { offer: '$offer.status', enrolmentStatus: 1 } }],
        as: '_apps',
      },
    },
  ];
  const [rows, revenue] = await Promise.all([
    LeadModel.aggregate<{ _id: string; leads: number; qualified: number; contacted: number; meetings: number; applications: number; admissions: number; enrolments: number }>([
      ...base,
      {
        $group: {
          _id: '$_key',
          leads: { $sum: 1 },
          qualified: { $sum: s.qualified < 0 ? 0 : { $cond: [{ $gte: ['$_stage', s.qualified] }, 1, 0] } },
          contacted: { $sum: { $cond: [{ $ifNull: ['$firstContactAt', false] }, 1, 0] } },
          meetings: { $sum: s.meeting < 0 ? 0 : { $cond: [{ $gte: ['$_stage', s.meeting] }, 1, 0] } },
          applications: { $sum: { $cond: [{ $gt: [{ $size: '$_apps' }, 0] }, 1, 0] } },
          admissions: { $sum: { $cond: [{ $in: ['accepted', '$_apps.offer'] }, 1, 0] } },
          enrolments: { $sum: { $cond: [{ $or: [{ $in: ['enrolled', '$_apps.enrolmentStatus'] }, s.enrolment < 0 ? false : { $gte: ['$_stage', s.enrolment] }] }, 1, 0] } },
        },
      },
    ]),
    LeadModel.aggregate<{ _id: { key: string; currency: string }; amount: number }>([
      ...base,
      {
        $lookup: {
          from: 'payments',
          let: { lid: '$_id' },
          pipeline: [{ $match: { $expr: { $and: [{ $eq: ['$leadId', '$$lid'] }, { $eq: ['$organizationId', ctx.organizationId] }] }, paymentStatus: 'success' } }, { $project: { amount: 1, currency: 1 } }],
          as: '_pay',
        },
      },
      { $unwind: '$_pay' },
      { $group: { _id: { key: '$_key', currency: '$_pay.currency' }, amount: { $sum: '$_pay.amount' } } },
    ]),
  ]);
  return rows.map((r) => ({
    ...r,
    revenue: revenue.filter((x) => x._id.key === r._id && x._id.currency === currency).reduce((sum, x) => sum + x.amount, 0),
    otherCurrencyRevenue: revenue.filter((x) => x._id.key === r._id && x._id.currency !== currency).map((x) => ({ currency: x._id.currency, amount: x.amount })),
  }));
}

/** Campaign-level spend per (provider, campaign) in range, split by currency. */
async function campaignSpend(ctx: ServiceContext, q: ReportQuery) {
  const match: Record<string, unknown> = { organizationId: ctx.organizationId, level: 'campaign', date: { $gte: q.from, $lte: q.to } };
  if (q.provider) match.provider = q.provider;
  if (q.campaignExternalId) match.externalId = q.campaignExternalId;
  return MarketingDailyMetricModel.aggregate<{ _id: { provider: string; id: string; currency: string; date?: string }; spendMinor: number; spendDays: number; providerLeads: number | null; leadDays: number }>([
    { $match: match },
    {
      $group: {
        _id: { provider: '$provider', id: '$externalId', currency: '$currency', ...(HIERARCHY.test(q.groupBy) ? { date: '$date' } : {}) },
        spendMinor: { $sum: '$spendMinor' },
        spendDays: { $sum: { $cond: [{ $eq: ['$spendMinor', null] }, 0, 1] } },
        providerLeads: { $sum: '$providerLeads' },
        leadDays: { $sum: { $cond: [{ $eq: ['$providerLeads', null] }, 0, 1] } },
      },
    },
  ]);
}

interface SpendCell {
  spend: number | null;
  providerLeads: number | null;
}

/** Spend per row key, for the groupings where spend can be attributed (campaign and hierarchy). */
async function spendByKey(ctx: ServiceContext, q: ReportQuery, currency: string) {
  const out = new Map<string, SpendCell>();
  const other: { currency: string; spend: number }[] = [];
  const supported = q.groupBy === 'campaign' || q.groupBy === 'none' || HIERARCHY.test(q.groupBy);
  if (!supported) return { byKey: out, other, supported };
  const rows = await campaignSpend(ctx, q);
  const add = (key: string, cell: SpendCell) => {
    const cur = out.get(key) ?? { spend: null, providerLeads: null };
    out.set(key, { spend: cell.spend === null ? cur.spend : (cur.spend ?? 0) + cell.spend, providerLeads: cell.providerLeads === null ? cur.providerLeads : (cur.providerLeads ?? 0) + cell.providerLeads });
  };
  const h = HIERARCHY.exec(q.groupBy);
  // Hierarchy: each day's campaign spend goes to the campaign-level mapping valid on that day.
  const mappings = h ? await CampaignMappingModel.find({ organizationId: ctx.organizationId, adsetExternalId: null, adExternalId: null, campaignExternalId: { $in: [...new Set(rows.map((r) => r._id.id))] } }).lean() : [];
  for (const r of rows) {
    if (r._id.currency && r._id.currency !== currency) {
      if (r.spendDays) other.push({ currency: r._id.currency, spend: fromMinor(r.spendMinor, r._id.currency) ?? 0 });
      continue;
    }
    const cell = { spend: r.spendDays ? fromMinor(r.spendMinor, r._id.currency) : null, providerLeads: r.leadDays ? r.providerLeads : null };
    if (q.groupBy === 'campaign') add(`${r._id.provider}:${r._id.id}`, cell);
    else if (q.groupBy === 'none') add('all', cell);
    else if (h) {
      const day = new Date(`${r._id.date}T12:00:00Z`);
      const m = mappings.find((x) => x.provider === r._id.provider && x.campaignExternalId === r._id.id && x.effectiveFrom <= day && (!x.effectiveTo || x.effectiveTo > day));
      const node = m?.[h[1] as Dimension]?.[`l${h[2]}` as 'l1' | 'l2' | 'l3'];
      add(node ? node.toString() : 'unmapped', cell);
    }
  }
  const merged = new Map<string, number>();
  for (const o of other) merged.set(o.currency, (merged.get(o.currency) ?? 0) + o.spend);
  return { byKey: out, other: [...merged].map(([c, spend]) => ({ currency: c, spend })), supported };
}

function kpis(r: { leads: number; qualified: number; contacted: number; meetings: number; applications: number; admissions: number; enrolments: number; revenue: number }, spend: number | null) {
  return {
    ...r,
    spend,
    qualifiedRate: pct(r.qualified, r.leads),
    contactRate: pct(r.contacted, r.leads),
    meetingRate: pct(r.meetings, r.leads),
    applicationRate: pct(r.applications, r.leads),
    cpl: ratio(spend, r.leads),
    cpql: ratio(spend, r.qualified),
    costPerApplication: ratio(spend, r.applications),
    costPerAdmission: ratio(spend, r.admissions),
    costPerEnrolment: ratio(spend, r.enrolments),
    roas: spend === null || spend === 0 ? null : r.revenue / spend,
  };
}

async function labelsFor(ctx: ServiceContext, groupBy: GroupBy, keys: string[]) {
  const labels = new Map<string, string>();
  if (groupBy === 'campaign') {
    const ids = keys.filter((k) => k.includes(':')).map((k) => k.split(':').slice(1).join(':'));
    const camps = await MarketingCampaignModel.find({ organizationId: ctx.organizationId, level: 'campaign', externalId: { $in: ids } }).select('provider externalId name').lean();
    for (const c of camps) labels.set(`${c.provider}:${c.externalId}`, c.name ?? c.externalId);
    // Campaigns the provider doesn't list (deleted, other account): use the name the lead arrived with.
    const missing = ids.filter((id) => !camps.some((c) => c.externalId === id));
    if (missing.length) {
      const named = await AttributionTouchpointModel.aggregate<{ _id: { p: string; id: string }; name: string }>([
        { $match: { organizationId: ctx.organizationId, campaignExternalId: { $in: missing }, campaignName: { $ne: null } } },
        { $group: { _id: { p: '$provider', id: '$campaignExternalId' }, name: { $last: '$campaignName' } } },
      ]);
      for (const n of named) labels.set(`${n._id.p}:${n._id.id}`, `${n.name} (not in synced campaigns)`);
    }
    labels.set('unattributed', 'No ad campaign (organic, direct, manual or missing IDs)');
  } else if (HIERARCHY.test(groupBy)) {
    const nodes = await AttributionNodeModel.find({ organizationId: ctx.organizationId, _id: { $in: keys.filter((k) => Types.ObjectId.isValid(k)) } }).select('label').lean();
    for (const n of nodes) labels.set(n._id.toString(), n.label);
    labels.set('unmapped', 'Not mapped');
  } else if (groupBy === 'counsellor') {
    const users = await LeadModel.db.model('User').find({ organizationId: ctx.organizationId, _id: { $in: keys.filter((k) => Types.ObjectId.isValid(k)) } }).select('fullName').lean<{ _id: Types.ObjectId; fullName: string }[]>();
    for (const u of users) labels.set(u._id.toString(), u.fullName);
    labels.set('unassigned', 'Unassigned');
  } else if (groupBy === 'branch') {
    const branches = await LeadModel.db.model('Branch').find({ organizationId: ctx.organizationId, _id: { $in: keys.filter((k) => Types.ObjectId.isValid(k)) } }).select('name').lean<{ _id: Types.ObjectId; name: string }[]>();
    for (const b of branches) labels.set(b._id.toString(), b.name);
  } else if (['leadSource', 'country', 'course', 'intake'].includes(groupBy)) {
    const type = { leadSource: 'lead_source', country: 'country', course: 'course', intake: 'intake' }[groupBy as 'leadSource'] as 'lead_source';
    for (const l of await listLookups(ctx, type, true)) labels.set(l.key, l.label);
  }
  return labels;
}

/** Breakdown table: one row per group with spend, outcomes, costs and ROAS. */
export async function breakdown(ctx: ServiceContext, q: ReportQuery) {
  const { currency, fromDate, toDate } = await window(ctx, q);
  const [rows, spend] = await Promise.all([cohortRows(ctx, q, fromDate, toDate, currency), spendByKey(ctx, q, currency)]);
  const keys = [...new Set([...rows.map((r) => r._id), ...spend.byKey.keys()])];
  const labels = await labelsFor(ctx, q.groupBy, keys);
  const empty = { leads: 0, qualified: 0, contacted: 0, meetings: 0, applications: 0, admissions: 0, enrolments: 0, revenue: 0, otherCurrencyRevenue: [] as { currency: string; amount: number }[] };
  const items = keys.map((key) => {
    const r = rows.find((x) => x._id === key) ?? { _id: key, ...empty };
    const s = spend.byKey.get(key);
    const { _id: _drop, otherCurrencyRevenue, ...counts } = r;
    return { key, label: labels.get(key) ?? key, providerLeads: s?.providerLeads ?? null, otherCurrencyRevenue, ...kpis(counts, spend.supported ? (s?.spend ?? null) : null) };
  });
  items.sort((a, b) => (b.spend ?? -1) - (a.spend ?? -1) || b.leads - a.leads);
  return { currency, model: q.model, from: q.from, to: q.to, spendSupported: spend.supported, otherCurrencySpend: spend.other, items, definitions: METRIC_DEFINITIONS };
}

/** Headline KPIs for the range and the same-length previous period. */
export async function overview(ctx: ServiceContext, q: ReportQuery) {
  const days = Math.round((new Date(`${q.to}T00:00:00Z`).getTime() - new Date(`${q.from}T00:00:00Z`).getTime()) / 86_400_000) + 1;
  const prevTo = new Date(new Date(`${q.from}T00:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10);
  const prevFrom = new Date(new Date(`${prevTo}T00:00:00Z`).getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const one = async (from: string, to: string) => {
    const r = await breakdown(ctx, { ...q, from, to, groupBy: 'none' });
    const all = r.items[0];
    // Paid leads: cohort leads whose attributed touch carries an ad campaign ID.
    const paid = await breakdown(ctx, { ...q, from, to, groupBy: 'campaign' });
    const paidLeads = paid.items.filter((i) => i.key !== 'unattributed').reduce((s, i) => s + i.leads, 0);
    const spend = all?.spend ?? null;
    return { ...(all ?? kpis({ leads: 0, qualified: 0, contacted: 0, meetings: 0, applications: 0, admissions: 0, enrolments: 0, revenue: 0 }, spend)), paidLeads, paidCpl: ratio(spend, paidLeads), providerLeads: all?.providerLeads ?? null, otherCurrencySpend: r.otherCurrencySpend };
  };
  const [current, previous] = await Promise.all([one(q.from, q.to), one(prevFrom, prevTo)]);
  const { currency } = await window(ctx, q);
  return { currency, model: q.model, period: { from: q.from, to: q.to }, previousPeriod: { from: prevFrom, to: prevTo }, current, previous, definitions: METRIC_DEFINITIONS };
}

/** Spend → leads → … → revenue for the filter (provider / campaign). */
export async function funnel(ctx: ServiceContext, q: ReportQuery) {
  const [r, s] = await Promise.all([breakdown(ctx, { ...q, groupBy: 'none' }), stageIndexes(ctx)]);
  const t = r.items[0];
  // Ordered so each step is (normally) a subset of the one before. "Qualified" is shown on its own
  // only when the organization marked a qualified stage different from the meeting milestone.
  const steps = t
    ? ([
        ['leads', t.leads],
        ['contacted', t.contacted],
        ...(s.qualified !== s.meeting ? [['qualified', t.qualified]] : []),
        ['meetings', t.meetings],
        ['applications', t.applications],
        ['admissions', t.admissions],
        ['enrolments', t.enrolments],
      ] as [string, number][])
    : [];
  return {
    currency: r.currency,
    spend: t?.spend ?? null,
    revenue: t?.revenue ?? 0,
    roas: t?.roas ?? null,
    steps: steps.map(([k, n], i) => ({ key: k, count: n as number, fromPrevious: i === 0 ? null : pct(n as number, steps[i - 1]![1] as number), fromTop: pct(n as number, steps[0]![1] as number), costPer: ratio(t?.spend ?? null, n as number) })),
  };
}

/** Daily / weekly / monthly spend and CRM leads. */
export async function trend(ctx: ServiceContext, q: ReportQuery) {
  const { timezone, currency, fromDate, toDate } = await window(ctx, q);
  const unit = q.interval;
  const spendMatch: Record<string, unknown> = { organizationId: ctx.organizationId, level: 'campaign', date: { $gte: q.from, $lte: q.to }, currency };
  if (q.provider) spendMatch.provider = q.provider;
  const bucket = (dateExpr: unknown) => ({ $dateToString: { date: { $dateTrunc: { date: dateExpr, unit, timezone, startOfWeek: 'monday' } }, format: '%Y-%m-%d', timezone } });
  const [spend, leads] = await Promise.all([
    MarketingDailyMetricModel.aggregate<{ _id: string; spendMinor: number; n: number }>([
      { $match: spendMatch },
      { $group: { _id: bucket({ $dateFromString: { dateString: '$date', timezone } }), spendMinor: { $sum: '$spendMinor' }, n: { $sum: { $cond: [{ $eq: ['$spendMinor', null] }, 0, 1] } } } },
    ]),
    LeadModel.aggregate<{ _id: string; leads: number; paid: number }>([
      { $match: scopedLeadFilter(ctx, { mergedInto: null, leadStatus: { $ne: 'duplicate' }, createdAt: { $gte: fromDate, $lt: toDate }, ...(q.provider ? { 'firstTouch.provider': q.provider } : {}) }) },
      { $group: { _id: bucket('$createdAt'), leads: { $sum: 1 }, paid: { $sum: { $cond: [{ $ifNull: ['$firstTouch.campaignExternalId', false] }, 1, 0] } } } },
    ]),
  ]);
  const keys = [...new Set([...spend.map((s) => s._id), ...leads.map((l) => l._id)])].sort();
  return {
    currency,
    interval: unit,
    points: keys.map((k) => {
      const s = spend.find((x) => x._id === k);
      const l = leads.find((x) => x._id === k);
      const amount = s && s.n ? fromMinor(s.spendMinor, currency) : null;
      return { period: k, spend: amount, leads: l?.leads ?? 0, paidLeads: l?.paid ?? 0, cpl: ratio(amount, l?.paid ?? 0) };
    }),
  };
}

/** Gaps that make reports unreliable (spec §13 reports 18–20). */
export async function dataQuality(ctx: ServiceContext, q: ReportQuery) {
  const { fromDate, toDate, currency } = await window(ctx, q);
  const leadConditions = { mergedInto: null, createdAt: { $gte: fromDate, $lt: toDate } };
  const [missingUtm, touchCampaigns, imports, flagged] = await Promise.all([
    LeadModel.aggregate<{ _id: string; n: number }>([{ $match: scopedLeadFilter(ctx, leadConditions, { $or: [{ 'firstTouch.isDirect': true }, { firstTouchId: null }] }) }, { $group: { _id: '$leadSource', n: { $sum: 1 } } }, { $sort: { n: -1 } }]),
    AttributionTouchpointModel.aggregate<{ _id: { provider: string; id: string }; n: number; mapped: number }>([
      { $match: { organizationId: ctx.organizationId, occurredAt: { $gte: fromDate, $lt: toDate }, campaignExternalId: { $ne: null } } },
      { $group: { _id: { provider: '$provider', id: '$campaignExternalId' }, n: { $sum: 1 }, mapped: { $sum: { $cond: [{ $ifNull: ['$mappingId', false] }, 1, 0] } } } },
    ]),
    ExternalLeadReferenceModel.aggregate<{ _id: string; n: number }>([{ $match: { organizationId: ctx.organizationId, createdAt: { $gte: fromDate, $lt: toDate } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    AttributionTouchpointModel.countDocuments({ organizationId: ctx.organizationId, occurredAt: { $gte: fromDate, $lt: toDate }, flags: 'earlier_than_first_touch' }),
  ]);
  const spend = await breakdown(ctx, { ...q, groupBy: 'campaign' });
  const unmappedSpend = await campaignSpend(ctx, { ...q, groupBy: 'campaign' });
  const activeMappings = await CampaignMappingModel.find({ organizationId: ctx.organizationId, status: 'active', adsetExternalId: null, adExternalId: null }).select('provider campaignExternalId').lean();
  const isMapped = (p: string, id: string) => activeMappings.some((m) => m.provider === p && m.campaignExternalId === id);
  const names = await MarketingCampaignModel.find({ organizationId: ctx.organizationId, level: 'campaign' }).select('provider externalId name').lean();
  const name = (p: string, id: string) => names.find((n) => n.provider === p && n.externalId === id)?.name ?? null;
  const unmapped = new Map<string, { provider: string; campaignExternalId: string; name: string | null; touchpoints: number; hasSpend: boolean }>();
  for (const t of touchCampaigns) if (t.mapped < t.n && !isMapped(t._id.provider, t._id.id)) unmapped.set(`${t._id.provider}:${t._id.id}`, { provider: t._id.provider, campaignExternalId: t._id.id, name: name(t._id.provider, t._id.id), touchpoints: t.n - t.mapped, hasSpend: false });
  for (const s of unmappedSpend) {
    if (!s.spendDays || isMapped(s._id.provider, s._id.id)) continue;
    const k = `${s._id.provider}:${s._id.id}`;
    unmapped.set(k, { ...(unmapped.get(k) ?? { provider: s._id.provider, campaignExternalId: s._id.id, name: name(s._id.provider, s._id.id), touchpoints: 0 }), hasSpend: true });
  }
  return {
    currency,
    leadsWithoutTracking: { total: missingUtm.reduce((s, x) => s + x.n, 0), bySource: missingUtm.map((x) => ({ leadSource: x._id, leads: x.n })) },
    unmappedCampaigns: [...unmapped.values()],
    importOutcomes: Object.fromEntries(imports.map((i) => [i._id, i.n])),
    spendWithoutLeads: spend.items.filter((i) => i.key !== 'unattributed' && (i.spend ?? 0) > 0 && i.leads === 0).map((i) => ({ key: i.key, label: i.label, spend: i.spend })),
    spendWithoutEnrolments: spend.items.filter((i) => i.key !== 'unattributed' && (i.spend ?? 0) > 0 && i.leads > 0 && i.enrolments === 0).map((i) => ({ key: i.key, label: i.label, spend: i.spend, leads: i.leads })),
    lateEarlierTouches: flagged,
  };
}

/** Outcomes of a fixed set of leads (events, campaigns): same rules as the cohort reports. */
export async function outcomesForLeads(ctx: ServiceContext, leadIds: Types.ObjectId[], currency: string) {
  if (!leadIds.length) return { leads: 0, contacted: 0, meetings: 0, applications: 0, admissions: 0, enrolments: 0, revenue: 0 };
  const s = await stageIndexes(ctx);
  const [row] = await LeadModel.aggregate<{ leads: number; contacted: number; meetings: number; applications: number; admissions: number; enrolments: number }>([
    { $match: scopedLeadFilter(ctx, { _id: { $in: leadIds } }) },
    { $set: { _stage: { $indexOfArray: [s.keys, '$leadStage'] } } },
    {
      $lookup: {
        from: 'applications',
        let: { lid: '$_id' },
        pipeline: [{ $match: { $expr: { $and: [{ $eq: ['$leadId', '$$lid'] }, { $eq: ['$organizationId', ctx.organizationId] }] }, deletedAt: null } }, { $project: { offer: '$offer.status', enrolmentStatus: 1 } }],
        as: '_apps',
      },
    },
    {
      $group: {
        _id: null,
        leads: { $sum: 1 },
        contacted: { $sum: { $cond: [{ $ifNull: ['$firstContactAt', false] }, 1, 0] } },
        meetings: { $sum: s.meeting < 0 ? 0 : { $cond: [{ $gte: ['$_stage', s.meeting] }, 1, 0] } },
        applications: { $sum: { $cond: [{ $gt: [{ $size: '$_apps' }, 0] }, 1, 0] } },
        admissions: { $sum: { $cond: [{ $in: ['accepted', '$_apps.offer'] }, 1, 0] } },
        enrolments: { $sum: { $cond: [{ $or: [{ $in: ['enrolled', '$_apps.enrolmentStatus'] }, s.enrolment < 0 ? false : { $gte: ['$_stage', s.enrolment] }] }, 1, 0] } },
      },
    },
  ]);
  const pay = await LeadModel.db.model('Payment').aggregate<{ amount: number }>([
    { $match: { organizationId: ctx.organizationId, leadId: { $in: leadIds }, paymentStatus: 'success', currency } },
    { $group: { _id: null, amount: { $sum: '$amount' } } },
  ]);
  return { ...(row ?? { leads: 0, contacted: 0, meetings: 0, applications: 0, admissions: 0, enrolments: 0 }), revenue: pay[0]?.amount ?? 0 };
}
