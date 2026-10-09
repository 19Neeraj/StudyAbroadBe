import { describe, expect, it } from 'vitest';
import { addDays, startOfDayInTz } from '../src/utils/time.js';
import { api, bearer, createLead, createOrgWithAdmin, createUserAs } from './helpers.js';

const iso = (d: Date) => d.toISOString();

describe('time zone helpers', () => {
  it('computes local midnight', () => {
    // 01:30 IST on 9 Oct → midnight IST 9 Oct = 18:30Z on 8 Oct.
    expect(startOfDayInTz('Asia/Kolkata', new Date('2026-10-08T20:00:00Z')).toISOString()).toBe('2026-10-08T18:30:00.000Z');
    expect(startOfDayInTz('UTC', new Date('2026-10-08T20:00:00Z')).toISOString()).toBe('2026-10-08T00:00:00.000Z');
    // New York in summer (EDT, UTC-4) and winter (EST, UTC-5).
    expect(startOfDayInTz('America/New_York', new Date('2026-07-01T12:00:00Z')).toISOString()).toBe('2026-07-01T04:00:00.000Z');
    expect(startOfDayInTz('America/New_York', new Date('2026-12-01T12:00:00Z')).toISOString()).toBe('2026-12-01T05:00:00.000Z');
  });
});

describe('Follow-ups', () => {
  async function setup() {
    const { org, token } = await createOrgWithAdmin();
    const counsellor = await createUserAs(token, org._id, 'counsellor');
    const lead = (await createLead(token, { firstName: 'Meera', phone: '9111111111', assignedCounsellor: counsellor.id })).body.data.lead;
    return { org, token, counsellor, lead };
  }

  it('schedules for the lead’s counsellor and maintains the next follow-up date', async () => {
    const { counsellor, lead, token } = await setup();
    const later = new Date(Date.now() + 2 * 86_400_000);
    const sooner = new Date(Date.now() + 86_400_000);
    const a = await api().post(`/api/v1/leads/${lead._id}/followups`).set(bearer(token)).send({ dueAt: iso(later), followUpType: 'call', nextAction: 'Share UK shortlist' });
    expect(a.status).toBe(201);
    expect(a.body.data).toMatchObject({ status: 'pending', assignedTo: { _id: counsellor.id }, lead: { leadNumber: 1001 }, isOverdue: false });
    await api().post(`/api/v1/leads/${lead._id}/followups`).set(bearer(token)).send({ dueAt: iso(sooner), followUpType: 'whatsapp' });

    const detail = await api().get(`/api/v1/leads/${lead._id}`).set(bearer(token));
    expect(new Date(detail.body.data.nextFollowUpAt).getTime()).toBe(sooner.getTime());

    const badType = await api().post(`/api/v1/leads/${lead._id}/followups`).set(bearer(token)).send({ dueAt: iso(later), followUpType: 'telepathy' });
    expect(badType.status).toBe(422);
    const past = await api().post(`/api/v1/leads/${lead._id}/followups`).set(bearer(token)).send({ dueAt: iso(new Date(Date.now() - 3 * 86_400_000)), followUpType: 'call' });
    expect(past.status).toBe(422);
  });

  it('splits follow-ups into today, overdue, upcoming and completed views', async () => {
    const { counsellor, lead, token } = await setup();
    const now = Date.now();
    const tomorrow = addDays(startOfDayInTz('Asia/Kolkata'), 1).getTime();
    const dueToday = new Date(Math.min(now + 60_000, tomorrow - 1000));
    const create = (dueAt: Date) =>
      api().post(`/api/v1/leads/${lead._id}/followups`).set(bearer(counsellor.token)).send({ dueAt: iso(dueAt), followUpType: 'call' });

    const overdue = (await create(new Date(now - 30 * 60_000))).body.data;
    await create(dueToday);
    await create(new Date(now + 3 * 86_400_000));

    const view = async (v: string) => (await api().get(`/api/v1/followups?view=${v}`).set(bearer(counsellor.token))).body.data;
    expect((await view('overdue')).map((f: { _id: string }) => f._id)).toEqual([overdue._id]);
    expect((await view('overdue'))[0].isOverdue).toBe(true);
    expect((await view('today')).map((f: { dueAt: string }) => f.dueAt)).toContain(dueToday.toISOString());
    expect(await view('upcoming')).toHaveLength(1);

    const summary = await api().get('/api/v1/followups/summary').set(bearer(counsellor.token));
    expect(summary.body.data.overdue).toBe(1);
    expect(summary.body.data.upcoming).toBe(1);
    expect(summary.body.data.today).toBeGreaterThanOrEqual(1);

    // Admin's own summary is empty; the org-wide one is not.
    expect((await api().get('/api/v1/followups/summary').set(bearer(token))).body.data.upcoming).toBe(0);
    expect((await api().get('/api/v1/followups/summary?mine=false').set(bearer(token))).body.data.upcoming).toBe(1);
  });

  it('completes (scheduling the next), reschedules and cancels with timeline entries', async () => {
    const { counsellor, lead } = await setup();
    const t = counsellor.token;
    const first = (await api().post(`/api/v1/leads/${lead._id}/followups`).set(bearer(t)).send({ dueAt: iso(new Date(Date.now() + 3_600_000)), followUpType: 'call' })).body.data;

    const nextAt = new Date(Date.now() + 2 * 86_400_000);
    const done = await api()
      .post(`/api/v1/followups/${first._id}/complete`)
      .set(bearer(t))
      .send({ outcome: 'Interested in UK, sending brochure', next: { dueAt: iso(nextAt), followUpType: 'whatsapp', notes: 'Check brochure received' } });
    expect(done.status).toBe(200);
    expect(done.body.data.completed).toMatchObject({ status: 'completed', outcome: 'Interested in UK, sending brochure' });
    expect(done.body.data.next).toMatchObject({ status: 'pending', followUpType: 'whatsapp' });
    expect((await api().post(`/api/v1/followups/${first._id}/complete`).set(bearer(t)).send({ outcome: 'again' })).status).toBe(409);

    const movedTo = new Date(Date.now() + 4 * 86_400_000);
    const moved = await api().post(`/api/v1/followups/${done.body.data.next._id}/reschedule`).set(bearer(t)).send({ dueAt: iso(movedTo) });
    expect(moved.body.data).toMatchObject({ status: 'pending', followUpType: 'whatsapp', notes: 'Check brochure received' });

    const leadAfter = await api().get(`/api/v1/leads/${lead._id}`).set(bearer(t));
    expect(new Date(leadAfter.body.data.nextFollowUpAt).getTime()).toBe(movedTo.getTime());

    const cancelled = await api().post(`/api/v1/followups/${moved.body.data._id}/cancel`).set(bearer(t)).send({ reason: 'Student travelling' });
    expect(cancelled.body.data.status).toBe('cancelled');
    expect((await api().get(`/api/v1/leads/${lead._id}`).set(bearer(t))).body.data.nextFollowUpAt).toBeNull();

    const all = await api().get(`/api/v1/leads/${lead._id}/followups`).set(bearer(t));
    expect(all.body.data.map((f: { status: string }) => f.status).sort()).toEqual(['cancelled', 'completed', 'rescheduled']);

    const timeline = await api().get(`/api/v1/leads/${lead._id}/activities`).set(bearer(t));
    expect(timeline.body.data.map((a: { type: string }) => a.type)).toEqual(
      expect.arrayContaining(['followup_created', 'followup_completed', 'followup_rescheduled', 'followup_cancelled']),
    );
  });

  it('keeps counsellors to their own follow-ups', async () => {
    const { org, token, counsellor, lead } = await setup();
    const other = await createUserAs(token, org._id, 'counsellor');
    const f = (await api().post(`/api/v1/leads/${lead._id}/followups`).set(bearer(counsellor.token)).send({ dueAt: iso(new Date(Date.now() + 86_400_000)), followUpType: 'call' })).body.data;

    expect((await api().get('/api/v1/followups?view=all').set(bearer(other.token))).body.data).toEqual([]);
    expect((await api().get(`/api/v1/followups?view=all&assignedTo=${counsellor.id}`).set(bearer(other.token))).body.data).toEqual([]);
    expect((await api().post(`/api/v1/followups/${f._id}/complete`).set(bearer(other.token)).send({ outcome: 'x' })).status).toBe(404);
    expect((await api().post(`/api/v1/leads/${lead._id}/followups`).set(bearer(other.token)).send({ dueAt: iso(new Date(Date.now() + 86_400_000)), followUpType: 'call' })).status).toBe(404);

    // Counsellors cannot schedule for someone else.
    const forOther = await api().post(`/api/v1/leads/${lead._id}/followups`).set(bearer(counsellor.token)).send({ dueAt: iso(new Date(Date.now() + 86_400_000)), followUpType: 'call', assignedTo: other.id });
    expect(forOther.status).toBe(403);
  });
});
