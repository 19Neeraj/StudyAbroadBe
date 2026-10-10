import type { Types } from 'mongoose';
import type { Permission } from '../../constants/permissions.js';
import type { LookupType } from '../../constants/lookups.js';
import type { ServiceContext } from '../../types/auth.js';
import type { Cell, Sheet } from '../../utils/spreadsheet.js';
import { listApplications } from '../applications/application.service.js';
import { applicationListQuery } from '../applications/application.validation.js';
import { callAnalytics } from '../calls/call.analytics.js';
import { listCalls } from '../calls/call.service.js';
import { callAnalyticsQuery, callListQuery } from '../calls/call.validation.js';
import { dashboardOverview } from '../dashboard/dashboard.service.js';
import { dashboardQuery } from '../dashboard/dashboard.validation.js';
import { listFollowUps } from '../followups/followup.service.js';
import { followUpListQuery } from '../followups/followup.validation.js';
import { LeadModel } from '../leads/lead.model.js';
import { listFilter } from '../leads/lead.service.js';
import { AttributionNodeModel } from '../marketing/attributionNode.model.js';
import { leadListQuery } from '../leads/lead.validation.js';
import { listPayments, paymentListQuery } from '../payments/payment.service.js';
import { listLookups } from '../settings/lookup.service.js';
import { listStudents } from '../students/student.service.js';
import { studentListQuery } from '../students/student.validation.js';
import { UserModel } from '../users/user.model.js';
import { BranchModel } from '../branches/branch.model.js';

/** Rows above this are not exported (the file says so). */
export const MAX_ROWS = 50_000;

type Params = Record<string, string>;
export interface ReportDefinition {
  key: string;
  label: string;
  description: string;
  /** Needed to export (in addition to being able to see the data). */
  permissions: Permission[];
  build: (ctx: ServiceContext, params: Params) => Promise<Sheet & { truncated: boolean }>;
}

const d = (v: unknown) => (v ? new Date(v as string) : null);
const name = (v: unknown) => (v && typeof v === 'object' && 'fullName' in v ? String((v as { fullName?: string }).fullName ?? '') : '');

async function labels(ctx: ServiceContext, ...types: LookupType[]) {
  const maps = new Map<string, Map<string, string>>();
  for (const t of types) maps.set(t, new Map((await listLookups(ctx, t, true)).map((l) => [l.key, l.label])));
  return (t: LookupType, key: unknown) => (key ? (maps.get(t)?.get(String(key)) ?? String(key)) : '');
}

/** Pages through a module's own list function so scope, filters and shaping match the screen. */
async function collect<T>(page: (p: number) => Promise<{ items: T[]; pagination: { totalPages: number } }>) {
  const out: T[] = [];
  for (let p = 1; ; p++) {
    const r = await page(p);
    out.push(...r.items);
    if (p >= r.pagination.totalPages || out.length >= MAX_ROWS) return { items: out.slice(0, MAX_ROWS), truncated: out.length > MAX_ROWS || p < r.pagination.totalPages };
  }
}

const parse = <S extends { parse: (v: unknown) => unknown }>(schema: S, params: Params, extra: Record<string, unknown> = {}) => schema.parse({ ...params, ...extra }) as ReturnType<S['parse']>;

export const REPORTS: ReportDefinition[] = [
  {
    key: 'leads',
    label: 'Leads',
    description: 'Every lead you can see, with the same filters as the lead list, attribution and next follow-up.',
    permissions: ['lead.export'],
    async build(ctx, params) {
      const q = parse(leadListQuery, params, { page: 1, limit: 100 });
      const filter = await listFilter(ctx, q);
      const total = await LeadModel.countDocuments(filter);
      const leads = await LeadModel.find(filter).sort({ createdAt: -1, _id: -1 }).limit(MAX_ROWS).lean();
      const userIds = [...new Set(leads.flatMap((l) => [l.assignedCounsellor, l.assignedManager]).filter(Boolean).map(String))];
      const branchIds = [...new Set(leads.map((l) => l.branchId).filter(Boolean).map(String))];
      const nodeIds = leads.flatMap((l) => (['attribution', 'latestAttribution'] as const).flatMap((k) => (['source', 'medium', 'campaign'] as const).flatMap((d) => [l[k]?.[d]?.l1, l[k]?.[d]?.l2, l[k]?.[d]?.l3]))).filter(Boolean);
      const [users, branches, lbl, nodes] = await Promise.all([
        UserModel.find({ organizationId: ctx.organizationId, _id: { $in: userIds } }).select('fullName').lean(),
        BranchModel.find({ organizationId: ctx.organizationId, _id: { $in: branchIds } }).select('name').lean(),
        labels(ctx, 'lead_stage', 'lead_status', 'lead_source', 'country', 'course', 'intake', 'degree_level'),
        AttributionNodeModel.find({ organizationId: ctx.organizationId, _id: { $in: nodeIds } }).select('label').lean(),
      ]);
      const nodeName = new Map(nodes.map((n) => [n._id.toString(), n.label]));
      const path = (h?: { l1?: unknown; l2?: unknown; l3?: unknown } | null) => [h?.l1, h?.l2, h?.l3].map((id) => (id ? nodeName.get(String(id)) : undefined)).filter(Boolean).join(' > ');
      const u = (id: unknown) => users.find((x) => x._id.equals(id as Types.ObjectId))?.fullName ?? '';
      const b = (id: unknown) => branches.find((x) => x._id.equals(id as Types.ObjectId))?.name ?? '';
      return {
        headers: ['Lead #', 'Name', 'Phone', 'WhatsApp', 'Email', 'City', 'Source', 'Campaign', 'Platform', 'Stage', 'Status', 'Country', 'Course', 'Degree', 'Intake', 'Budget', 'IELTS', 'Counsellor', 'Manager', 'Branch', 'Created', 'First contact', 'Last contacted', 'Next follow-up', 'utm_source', 'utm_medium', 'utm_campaign', 'First-touch platform', 'First-touch campaign ID',
          'Inquiries', 'Re-inquiries', 'First inquiry', 'Last inquiry', 'Original source (P > S > T)', 'Original medium', 'Original campaign', 'Latest source (P > S > T)', 'Latest medium', 'Latest campaign'],
        rows: leads.map((l) => [
          l.leadNumber, l.fullName, l.phone, l.whatsappNumber, l.email, l.city, lbl('lead_source', l.leadSource), l.campaign, l.platform,
          lbl('lead_stage', l.leadStage), lbl('lead_status', l.leadStatus), lbl('country', l.countryInterested), lbl('course', l.courseInterested), lbl('degree_level', l.degreeLevel), lbl('intake', l.intake),
          l.budget, l.ieltsScore, u(l.assignedCounsellor), u(l.assignedManager), b(l.branchId), l.createdAt, l.firstContactAt, l.lastContactedAt, l.nextFollowUpAt,
          l.utmSource, l.utmMedium, l.utmCampaign, l.firstTouch?.provider, l.firstTouch?.campaignExternalId,
          l.inquiryCount ?? 1, Math.max(0, (l.inquiryCount ?? 1) - 1), l.firstInquiryAt ?? l.createdAt, l.lastInquiryAt ?? l.createdAt,
          path(l.attribution?.source), path(l.attribution?.medium), path(l.attribution?.campaign),
          path(l.latestAttribution?.source), path(l.latestAttribution?.medium), path(l.latestAttribution?.campaign),
        ] as Cell[]),
        truncated: total > MAX_ROWS,
      };
    },
  },
  {
    key: 'students',
    label: 'Students',
    description: 'Students with profile completion, preferences and counsellor.',
    permissions: ['student.view', 'report.export'],
    async build(ctx, params) {
      const lbl = await labels(ctx, 'country', 'course', 'intake', 'degree_level');
      const { items, truncated } = await collect((page) => listStudents(ctx, parse(studentListQuery, params, { page, limit: 100 })) as never);
      return {
        headers: ['Student #', 'Name', 'Phone', 'Email', 'Status', 'Countries', 'Courses', 'Degree', 'Intake', 'Profile %', 'Counsellor', 'Branch', 'Converted'],
        rows: (items as Record<string, unknown>[]).map((s) => [
          s.studentNumber as number, s.fullName as string, s.phone as string, s.email as string, s.status as string,
          ((s.preferredCountries as string[]) ?? []).map((c) => lbl('country', c)).join(', '), ((s.preferredCourses as string[]) ?? []).map((c) => lbl('course', c)).join(', '),
          lbl('degree_level', s.degreeLevel), lbl('intake', s.intake), s.profileCompletion as number, name(s.assignedCounsellor), name(s.branch), d(s.createdAt),
        ]),
        truncated,
      };
    },
  },
  {
    key: 'applications',
    label: 'Applications',
    description: 'University applications with status, offer, deadline, visa and payment state.',
    permissions: ['application.view', 'report.export'],
    async build(ctx, params) {
      const lbl = await labels(ctx, 'application_status', 'intake', 'country');
      const { items, truncated } = await collect((page) => listApplications(ctx, parse(applicationListQuery, params, { page, limit: 100 })) as never);
      return {
        headers: ['Application #', 'Student', 'University', 'Course', 'Country', 'Intake', 'Status', 'Offer', 'Deadline', 'Applied on', 'University ref', 'Tuition', 'Scholarship', 'Currency', 'Payment', 'Visa', 'Counsellor'],
        rows: (items as Record<string, unknown>[]).map((a) => [
          a.applicationNumber as number, a.studentName as string, (a.university as { name?: string } | null)?.name, (a.course as { name?: string } | null)?.name ?? (a.courseName as string),
          lbl('country', a.country), lbl('intake', a.intake), lbl('application_status', a.status), (a.offer as { status?: string } | undefined)?.status, d(a.applicationDeadline), d(a.applicationDate),
          a.universityApplicationId as string, a.tuitionFee as number, a.scholarship as number, a.currency as string, a.paymentStatus as string, a.visaStatus as string, name(a.assignedCounsellor),
        ]),
        truncated,
      };
    },
  },
  {
    key: 'payments',
    label: 'Payments',
    description: 'Payments with purpose, status, dates and references.',
    permissions: ['payment.view', 'report.export'],
    async build(ctx, params) {
      const { items, truncated } = await collect((page) => listPayments(ctx, parse(paymentListQuery, params, { page, limit: 100 })) as never);
      return {
        headers: ['Payment #', 'Student', 'Application', 'Purpose', 'Amount', 'Currency', 'Status', 'Method', 'Transaction ID', 'Due', 'Paid on', 'Remarks', 'Recorded by', 'Recorded'],
        rows: (items as Record<string, unknown>[]).map((p) => [
          p.paymentNumber as number, name(p.student), (p.application as { applicationNumber?: number } | null)?.applicationNumber, p.purpose as string, p.amount as number, p.currency as string,
          p.paymentStatus as string, p.paymentMethod as string, p.transactionId as string, d(p.dueDate), d(p.paymentDate), p.remarks as string, name(p.createdBy), d(p.createdAt),
        ]),
        truncated,
      };
    },
  },
  {
    key: 'followups',
    label: 'Follow-ups',
    description: 'Follow-ups with lead, owner, due date, status and outcome.',
    permissions: ['followup.view', 'report.export'],
    async build(ctx, params) {
      const lbl = await labels(ctx, 'followup_type', 'lead_stage');
      const { items, truncated } = await collect((page) => listFollowUps(ctx, parse(followUpListQuery, params, { page, limit: 100 })) as never);
      return {
        headers: ['Due', 'Type', 'Status', 'Overdue', 'Lead #', 'Lead', 'Phone', 'Lead stage', 'Assigned to', 'Next action', 'Completed', 'Outcome'],
        rows: (items as Record<string, unknown>[]).map((f) => {
          const lead = (f.lead ?? {}) as { leadNumber?: number; fullName?: string; phone?: string; leadStage?: string };
          return [d(f.dueAt), lbl('followup_type', f.followUpType), f.status as string, f.isOverdue ? 'yes' : '', lead.leadNumber, lead.fullName, lead.phone, lbl('lead_stage', lead.leadStage), name(f.assignedTo), f.nextAction as string, d(f.completedAt), f.outcome as string];
        }),
        truncated,
      };
    },
  },
  {
    key: 'calls',
    label: 'Call log',
    description: 'Calls with counsellor, lead, duration, status and outcome.',
    permissions: ['call.view', 'report.export'],
    async build(ctx, params) {
      const lbl = await labels(ctx, 'call_outcome', 'lead_source');
      const { items, truncated } = await collect((page) => listCalls(ctx, parse(callListQuery, params, { page, limit: 100 })) as never);
      return {
        headers: ['Started', 'Direction', 'Status', 'Connected', 'Duration (s)', 'Counsellor', 'Lead #', 'Lead', 'Phone', 'Outcome', 'Next action', 'Source', 'Campaign', 'Recording'],
        rows: (items as Record<string, unknown>[]).map((c) => {
          const lead = (c.lead ?? {}) as { leadNumber?: number; fullName?: string };
          return [d(c.startedAt), c.direction as string, c.status as string, c.connected ? 'yes' : 'no', c.duration as number, name(c.counsellor), lead.leadNumber, lead.fullName, c.phoneNumber as string, lbl('call_outcome', c.callOutcome), c.nextAction as string, lbl('lead_source', c.leadSource), c.campaign as string, c.hasRecording ? 'yes' : ''];
        }),
        truncated,
      };
    },
  },
  {
    key: 'counsellor_performance',
    label: 'Counsellor performance',
    description: 'Per counsellor: leads, contact and conversion milestones, calls, talk time, follow-ups and revenue.',
    permissions: ['report.view', 'report.export'],
    async build(ctx, params) {
      const r = await counsellorPerformance(ctx, params);
      return {
        headers: ['Counsellor', 'Leads', 'Contacted', 'Meetings', 'Applications', 'Offers', 'Enrolments', 'Conversion %', 'Calls', 'Connected', 'Connect %', 'Talk time (min)', 'Avg call (s)', 'Calls per application', 'Follow-ups done', 'Overdue follow-ups', ...r.currencies.map((c) => `Revenue (${c})`)],
        rows: r.rows.map((x) => [x.label, x.leads, x.contacted, x.meetings, x.applications, x.offers, x.enrolments, x.conversionRate, x.calls, x.connected, x.connectRate, x.talkMinutes, x.avgDuration, x.callsPerApplication, x.completedFollowUps, x.overdueFollowUps, ...r.currencies.map((c) => x.revenue[c] ?? 0)]),
        truncated: false,
      };
    },
  },
];

/** Leads, outcomes, follow-ups and revenue (dashboard) joined with calling (call analytics) per counsellor. */
export async function counsellorPerformance(ctx: ServiceContext, params: Params) {
  const [dash, calls] = await Promise.all([dashboardOverview(ctx, dashboardQuery.parse(params)), callAnalytics(ctx, callAnalyticsQuery.parse(params))]);
  type DashRow = { key: string | null; label: string; leads: number; milestones: Record<string, number>; conversionRate: number | null; overdueFollowUps?: number; completedFollowUps?: number; activities?: number; revenue?: Record<string, number> };
  type CallRow = { key: string | null; label: string; calls: number; connected: number; connectRate: number | null; talkTime: number; avgDuration: number; callsPerApplication: number | null };
  const dashRows = (dash.breakdowns.counsellor as unknown as DashRow[]).filter((r) => r.key);
  const callRows = ((calls as unknown as { byCounsellor: CallRow[] }).byCounsellor ?? []).filter((r) => r.key);
  const keys = [...new Set([...dashRows.map((r) => r.key!), ...callRows.map((r) => r.key!)])];
  const currencies = [...new Set(dashRows.flatMap((r) => Object.keys(r.revenue ?? {})))].sort();
  const rows = keys.map((key) => {
    const a = dashRows.find((r) => r.key === key);
    const c = callRows.find((r) => r.key === key);
    return {
      key,
      label: a?.label ?? c?.label ?? '',
      leads: a?.leads ?? 0,
      contacted: a?.milestones.contacted ?? 0,
      meetings: a?.milestones.meeting ?? 0,
      applications: a?.milestones.application ?? 0,
      offers: a?.milestones.offer ?? 0,
      enrolments: a?.milestones.enrolment ?? 0,
      conversionRate: a?.conversionRate ?? null,
      calls: c?.calls ?? 0,
      connected: c?.connected ?? 0,
      connectRate: c?.connectRate ?? null,
      talkMinutes: c ? Math.round(c.talkTime / 60) : 0,
      avgDuration: c?.avgDuration ?? null,
      callsPerApplication: c?.callsPerApplication ?? null,
      completedFollowUps: a?.completedFollowUps ?? 0,
      overdueFollowUps: a?.overdueFollowUps ?? 0,
      revenue: a?.revenue ?? {},
    };
  });
  rows.sort((x, y) => y.enrolments - x.enrolments || y.applications - x.applications || y.leads - x.leads);
  return { range: dash.range, currencies, rows };
}
