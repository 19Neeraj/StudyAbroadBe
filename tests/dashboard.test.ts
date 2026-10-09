import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { LeadModel } from '../src/modules/leads/lead.model.js';
import { compileFilterTree, type FilterGroup } from '../src/utils/filterTree.js';
import { LEAD_FILTER_FIELDS } from '../src/modules/leads/lead.filters.js';
import { resolvePeriod } from '../src/utils/time.js';
import { api, bearer, createLead, createOrgWithAdmin, createUserAs } from './helpers.js';

const enc = (tree: FilterGroup) => encodeURIComponent(JSON.stringify(tree));

describe('filter tree compiler', () => {
  it('compiles nested AND/OR/NOT groups with typed values', () => {
    const now = new Date('2026-10-08T12:00:00Z');
    const branch = new Types.ObjectId().toString();
    const out = compileFilterTree(
      {
        op: 'and',
        rules: [
          { field: 'leadSource', operator: 'in', value: ['meta', 'google'] },
          { field: 'branchId', operator: 'eq', value: branch },
          {
            op: 'or',
            not: true,
            rules: [
              { field: 'ieltsScore', operator: 'gte', value: '6.5' },
              { field: 'createdAt', operator: 'inLastDays', value: 7 },
            ],
          },
          { op: 'or', rules: [] },
        ],
      },
      LEAD_FILTER_FIELDS,
      now,
    );
    expect(out).toEqual({
      $and: [
        { leadSource: { $in: ['meta', 'google'] } },
        { branchId: new Types.ObjectId(branch) },
        { $nor: [{ $or: [{ ieltsScore: { $gte: 6.5 } }, { createdAt: { $gte: new Date('2026-10-01T12:00:00Z'), $lte: now } }] }] },
      ],
    });
  });

  it('rejects unknown fields, wrong operators, bad values and deep nesting', () => {
    const run = (tree: FilterGroup) => () => compileFilterTree(tree, LEAD_FILTER_FIELDS);
    expect(run({ op: 'and', rules: [{ field: 'passwordHash', operator: 'eq', value: 'x' }] })).toThrow(/Validation/);
    expect(run({ op: 'and', rules: [{ field: 'leadStage', operator: 'gt', value: 'x' }] })).toThrow();
    expect(run({ op: 'and', rules: [{ field: 'branchId', operator: 'eq', value: 'nope' }] })).toThrow();
    expect(run({ op: 'and', rules: [{ field: 'toString', operator: 'eq', value: 'x' }] })).toThrow();
    const deep: FilterGroup = { op: 'and', rules: [{ op: 'or', rules: [{ op: 'and', rules: [{ op: 'or', rules: [{ op: 'and', rules: [] }] }] }] }] };
    expect(run(deep)).toThrow();
  });

  it('only builds anchored, escaped prefix regexes', () => {
    expect(compileFilterTree({ op: 'and', rules: [{ field: 'campaign', operator: 'startsWith', value: 'UK (Sep' }] }, LEAD_FILTER_FIELDS)).toEqual({
      campaign: { $regex: '^UK \\(Sep', $options: 'i' },
    });
  });
});

describe('period resolver', () => {
  const now = new Date('2026-10-08T06:00:00Z'); // Thu 8 Oct, 11:30 IST
  it('resolves calendar presets in the org time zone with previous periods', () => {
    const month = resolvePeriod('this_month', 'Asia/Kolkata', {}, now);
    expect(month.from?.toISOString()).toBe('2026-09-30T18:30:00.000Z');
    expect(month.to.toISOString()).toBe('2026-10-08T18:30:00.000Z');
    expect(month.previous?.from.toISOString()).toBe('2026-08-31T18:30:00.000Z');

    const prevMonth = resolvePeriod('previous_month', 'Asia/Kolkata', {}, now);
    expect(prevMonth.from?.toISOString()).toBe('2026-08-31T18:30:00.000Z');
    expect(prevMonth.to.toISOString()).toBe('2026-09-30T18:30:00.000Z');

    const week = resolvePeriod('this_week', 'UTC', {}, now);
    expect(week.from?.toISOString()).toBe('2026-10-05T00:00:00.000Z'); // Monday
    expect(resolvePeriod('all_time', 'UTC', {}, now)).toMatchObject({ from: null, previous: null });

    const custom = resolvePeriod('custom', 'UTC', { from: new Date('2026-09-01'), to: new Date('2026-09-10') }, now);
    expect(custom.from?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(custom.to.toISOString()).toBe('2026-09-11T00:00:00.000Z');
    expect(custom.previous?.from.toISOString()).toBe('2026-08-22T00:00:00.000Z');
  });
});

async function seed() {
  const { org, token } = await createOrgWithAdmin();
  const counsellor = await createUserAs(token, org._id, 'counsellor');
  const mk = async (body: Record<string, unknown>, stage?: string) => {
    const res = await createLead(token, body);
    const lead = res.body.data.lead;
    if (stage) await api().patch(`/api/v1/leads/${lead._id}/stage`).set(bearer(token)).send({ stage });
    return lead._id as string;
  };
  const ids = {
    a: await mk({ phone: '9000000001', leadSource: 'meta', countryInterested: 'uk', ieltsScore: 7, campaign: 'UK Sep', assignedCounsellor: counsellor.id }, 'enrolled'),
    b: await mk({ phone: '9000000002', leadSource: 'meta', countryInterested: 'canada', ieltsScore: 6, campaign: 'UK Sep' }, 'meeting_done'),
    c: await mk({ phone: '9000000003', leadSource: 'google', countryInterested: 'uk', pteScore: 65, assignedCounsellor: counsellor.id }, 'application'),
    d: await mk({ phone: '9000000004', leadSource: 'website', countryInterested: 'australia' }),
  };
  return { org, token, counsellor, ids };
}

describe('Leads: nested filters', () => {
  it('applies AND/OR groups on top of simple filters and data scope', async () => {
    const { token, counsellor, ids } = await seed();
    // source = meta AND (ielts >= 6.5 OR country = canada)  → a, b
    const tree: FilterGroup = {
      op: 'and',
      rules: [
        { field: 'leadSource', operator: 'eq', value: 'meta' },
        { op: 'or', rules: [{ field: 'ieltsScore', operator: 'gte', value: 6.5 }, { field: 'countryInterested', operator: 'eq', value: 'canada' }] },
      ],
    };
    const both = await api().get(`/api/v1/leads?filter=${enc(tree)}`).set(bearer(token));
    expect(both.status).toBe(200);
    expect(both.body.data.map((l: { _id: string }) => l._id).sort()).toEqual([ids.a, ids.b].sort());

    // Simple filters AND with the tree.
    const narrowed = await api().get(`/api/v1/leads?country=uk&filter=${enc(tree)}`).set(bearer(token));
    expect(narrowed.body.data.map((l: { _id: string }) => l._id)).toEqual([ids.a]);

    // (ielts >= 6.5 OR pte >= 58) seen by the counsellor → only their own a, c.
    const english: FilterGroup = { op: 'or', rules: [{ field: 'ieltsScore', operator: 'gte', value: 6.5 }, { field: 'pteScore', operator: 'gte', value: 58 }] };
    const mine = await api().get(`/api/v1/leads?filter=${enc(english)}`).set(bearer(counsellor.token));
    expect(mine.body.data.map((l: { _id: string }) => l._id).sort()).toEqual([ids.a, ids.c].sort());

    // NOT group and isEmpty.
    const notMeta: FilterGroup = { op: 'and', rules: [{ op: 'or', not: true, rules: [{ field: 'leadSource', operator: 'eq', value: 'meta' }] }, { field: 'assignedCounsellor', operator: 'isEmpty' }] };
    const res = await api().get(`/api/v1/leads?filter=${enc(notMeta)}`).set(bearer(token));
    expect(res.body, JSON.stringify(res.body)).toMatchObject({ success: true });
    expect(res.body.data.map((l: { _id: string }) => l._id)).toEqual([ids.d]);
  });

  it('validates the filter and serves the field catalog', async () => {
    const { token } = await createOrgWithAdmin();
    const bad = await api().get('/api/v1/leads?filter=%7Bnot-json').set(bearer(token));
    expect(bad.status).toBe(422);
    const unknown = await api().get(`/api/v1/leads?filter=${enc({ op: 'and', rules: [{ field: 'passwordHash', operator: 'eq', value: 'x' }] })}`).set(bearer(token));
    expect(unknown.status).toBe(422);
    expect(unknown.body.errors[0].field).toBe('filter.root.rules.0.field');
    // Operator injection through the value is impossible: values are coerced scalars.
    const inj = await api().get(`/api/v1/leads?filter=${enc({ op: 'and', rules: [{ field: 'campaign', operator: 'eq', value: { $ne: null } as never }] })}`).set(bearer(token));
    expect(inj.status).toBe(422);

    const fields = await api().get('/api/v1/leads/filter-fields').set(bearer(token));
    expect(fields.status).toBe(200);
    expect(fields.body.data.find((f: { field: string }) => f.field === 'leadStage')).toMatchObject({ type: 'lookup', lookupType: 'lead_stage' });
  });
});

describe('Dashboard overview', () => {
  it('computes KPIs, funnel, rates and breakdowns with aggregation', async () => {
    const { token, counsellor } = await seed();
    const res = await api().get('/api/v1/dashboard/overview?period=this_month').set(bearer(token));
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.kpis.totalLeads).toBe(4);
    expect(d.kpis.newLeads).toEqual({ current: 4, previous: 0 });
    expect(d.kpis.milestones.meeting.current).toBe(3); // a (enrolled), b (meeting_done), c (application)
    expect(d.kpis.milestones.application.current).toBe(2);
    expect(d.kpis.milestones.enrolment.current).toBe(1);
    expect(d.kpis.conversionRate.current).toBe(25);

    const funnel = Object.fromEntries(d.funnel.map((f: { stage: string; reached: number }) => [f.stage, f.reached]));
    expect(funnel).toMatchObject({ new_lead: 4, contacted: 3, meeting_done: 3, application: 2, enrolled: 1 });
    // Each rate is relative to the previous milestone: contacted 3/4, application 2/2 shortlisted.
    const rate = (m: string) => d.rates.find((r: { milestone: string }) => r.milestone === m).rate;
    expect(rate('contacted')).toBe(75);
    expect(rate('application')).toBe(100);
    expect(rate('enrolment')).toBe(100); // 1 enrolled of 1 that reached visa

    const meta = d.breakdowns.source.find((r: { key: string }) => r.key === 'meta');
    expect(meta).toMatchObject({ leads: 2, conversionRate: 50 });
    const c = d.breakdowns.counsellor.find((r: { key: string }) => r.key === counsellor.id);
    expect(c).toMatchObject({ label: 'counsellor', leads: 2 });
    expect(d.breakdowns.counsellor.find((r: { key: string | null }) => r.key === null)).toMatchObject({ label: 'Unassigned', leads: 2 });
    expect(d.trend.reduce((s: number, t: { leads: number }) => s + t.leads, 0)).toBe(4);
    expect(d.monthly).toHaveLength(12);
    expect(d.monthly.at(-1).leads).toBe(4);
  });

  it('includes historical data (all time) and compares with the previous period', async () => {
    const { org, token } = await seed();
    // Back-date one lead to 2 years ago.
    // createdAt is immutable in Mongoose, so back-date through the driver.
    await LeadModel.collection.updateOne({ organizationId: org._id, phone: '+919000000004' }, { $set: { createdAt: new Date(Date.now() - 730 * 86_400_000) } });
    const month = (await api().get('/api/v1/dashboard/overview?period=this_month').set(bearer(token))).body.data;
    expect(month.kpis.newLeads.current).toBe(3);
    expect(month.kpis.totalLeads).toBe(4);
    const all = (await api().get('/api/v1/dashboard/overview?period=all_time').set(bearer(token))).body.data;
    expect(all.kpis.newLeads).toEqual({ current: 4, previous: null });
    expect(all.range.granularity).toBe('month');
    expect(all.trend.length).toBeGreaterThanOrEqual(24);
  });

  it('respects data scope, filters and tenant isolation', async () => {
    const { token, counsellor } = await seed();
    const mine = (await api().get('/api/v1/dashboard/overview?period=all_time').set(bearer(counsellor.token))).body.data;
    expect(mine.kpis.totalLeads).toBe(2);

    const tree: FilterGroup = { op: 'or', rules: [{ field: 'countryInterested', operator: 'eq', value: 'canada' }, { field: 'leadSource', operator: 'eq', value: 'website' }] };
    const filtered = (await api().get(`/api/v1/dashboard/overview?period=all_time&filter=${enc(tree)}`).set(bearer(token))).body.data;
    expect(filtered.kpis.totalLeads).toBe(2);
    const simple = (await api().get('/api/v1/dashboard/overview?period=all_time&source=meta,google').set(bearer(token))).body.data;
    expect(simple.kpis.totalLeads).toBe(3);

    const other = await createOrgWithAdmin('Other Org');
    const empty = (await api().get('/api/v1/dashboard/overview?period=all_time').set(bearer(other.token))).body.data;
    expect(empty.kpis.totalLeads).toBe(0);

    expect((await api().get('/api/v1/dashboard/overview?period=bogus').set(bearer(token))).status).toBe(422);
    expect((await api().get('/api/v1/dashboard/overview')).status).toBe(401);
  });
});
