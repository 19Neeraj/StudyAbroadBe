import { describe, expect, it } from 'vitest';
import { api, bearer, createLead, createOrgWithAdmin, createUserAs } from './helpers.js';

async function setup() {
  const { org, token } = await createOrgWithAdmin();
  const counsellor = await createUserAs(token, org._id, 'counsellor');
  const lead = (
    await createLead(token, {
      firstName: 'Riya',
      lastName: 'Sharma',
      phone: '9876501234',
      email: 'riya@example.com',
      countryInterested: 'uk',
      courseInterested: 'mba',
      intake: (await api().get('/api/v1/settings/lookups?types=intake').set(bearer(token))).body.data.intake[0].key,
      ieltsScore: 7,
      educationDetails: 'B.Com 2023, 72%',
      assignedCounsellor: counsellor.id,
    })
  ).body.data.lead;
  return { org, token, counsellor, lead };
}

describe('Students: conversion', () => {
  it('converts a lead into a linked student profile once', async () => {
    const { token, lead } = await setup();
    const res = await api().post(`/api/v1/leads/${lead._id}/convert`).set(bearer(token)).send({ notes: 'Serious about UK' });
    expect(res.status).toBe(201);
    const s = res.body.data;
    expect(s).toMatchObject({
      studentNumber: 1001,
      fullName: 'Riya Sharma',
      phone: '+919876501234',
      preferredCountries: ['uk'],
      preferredCourses: ['mba'],
      testScores: [expect.objectContaining({ test: 'ielts', overall: 7 })],
      assignedCounsellor: expect.objectContaining({ fullName: 'counsellor' }),
      lead: expect.objectContaining({ leadNumber: 1001, leadStage: 'new_lead' }),
    });
    expect(s.notes).toContain('B.Com 2023');
    expect(s.profileCompletion).toBe(50); // contact, tests, preference of 6 sections

    const again = await api().post(`/api/v1/leads/${lead._id}/convert`).set(bearer(token)).send({});
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: 'ALREADY_CONVERTED', details: { studentId: s._id } });

    const detail = await api().get(`/api/v1/leads/${lead._id}`).set(bearer(token));
    expect(detail.body.data.studentId).toBe(s._id);
    const timeline = await api().get(`/api/v1/students/${s._id}/activities`).set(bearer(token));
    expect(timeline.body.data[0]).toMatchObject({ type: 'student_converted' });
  });

  it('updates profile sections with validation and keeps ownership in sync with the lead', async () => {
    const { org, token, lead, counsellor } = await setup();
    const s = (await api().post(`/api/v1/leads/${lead._id}/convert`).set(bearer(token)).send({})).body.data;

    const bad = await api().patch(`/api/v1/students/${s._id}`).set(bearer(token)).send({ testScores: [{ test: 'ielts', testDate: '2026-05-01', expiryDate: '2025-01-01' }], preferredCountries: ['atlantis'] });
    expect(bad.status).toBe(422);

    const ok = await api()
      .patch(`/api/v1/students/${s._id}`)
      .set(bearer(token))
      .send({
        dateOfBirth: '2001-04-12',
        gender: 'female',
        passport: { number: 'z1234567', expiryDate: '2031-01-01' },
        education: [{ level: "Bachelor's", qualification: 'B.Com', institution: 'DU', passingYear: 2023, scoreType: 'percentage', score: 72 }],
        workExperience: [{ company: 'Acme', designation: 'Analyst', startDate: '2023-07-01', endDate: '2024-07-01' }],
      });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ passport: { number: 'Z1234567' }, profileCompletion: 100 });
    expect(ok.body.data.totalExperienceMonths).toBeGreaterThanOrEqual(11);

    // Reassigning the lead moves the student too: the old counsellor loses access.
    const other = await createUserAs(token, org._id, 'counsellor');
    expect((await api().get(`/api/v1/students/${s._id}`).set(bearer(counsellor.token))).status).toBe(200);
    await api().post(`/api/v1/leads/${lead._id}/assign`).set(bearer(token)).send({ counsellorId: other.id });
    expect((await api().get(`/api/v1/students/${s._id}`).set(bearer(counsellor.token))).status).toBe(404);
    expect((await api().get(`/api/v1/students/${s._id}`).set(bearer(other.token))).status).toBe(200);
  });

  it('lists with search, nested filters and scope; isolates tenants; enforces permissions', async () => {
    const { org, token, lead, counsellor } = await setup();
    const s = (await api().post(`/api/v1/leads/${lead._id}/convert`).set(bearer(token)).send({})).body.data;
    const other = (await createLead(token, { firstName: 'Kabir', phone: '9876509999', countryInterested: 'canada' })).body.data.lead;
    await api().post(`/api/v1/leads/${other._id}/convert`).set(bearer(token)).send({});

    const byName = await api().get('/api/v1/students?search=riy').set(bearer(token));
    expect(byName.body.data.map((x: { _id: string }) => x._id)).toEqual([s._id]);
    const byNumber = await api().get('/api/v1/students?search=%23' + s.studentNumber).set(bearer(token));
    expect(byNumber.body.pagination.total).toBe(1);
    const byPhone = await api().get('/api/v1/students?search=98765%2009999').set(bearer(token));
    expect(byPhone.body.data[0].fullName).toBe('Kabir');

    const tree = { op: 'and', rules: [{ field: 'preferredCountries', operator: 'in', value: ['canada', 'usa'] }] };
    const filtered = await api().get(`/api/v1/students?filter=${encodeURIComponent(JSON.stringify(tree))}`).set(bearer(token));
    expect(filtered.body.data.map((x: { fullName: string }) => x.fullName)).toEqual(['Kabir']);

    const mine = await api().get('/api/v1/students').set(bearer(counsellor.token));
    expect(mine.body.data.map((x: { _id: string }) => x._id)).toEqual([s._id]);

    const outsider = await createOrgWithAdmin('Other');
    expect((await api().get(`/api/v1/students/${s._id}`).set(bearer(outsider.token))).status).toBe(404);
    expect((await api().post(`/api/v1/leads/${lead._id}/convert`).set(bearer(outsider.token)).send({})).status).toBe(404);

    const marketing = await createUserAs(token, org._id, 'marketing');
    expect((await api().get('/api/v1/students').set(bearer(marketing.token))).status).toBe(403);
    expect((await api().post(`/api/v1/leads/${other._id}/convert`).set(bearer(marketing.token)).send({})).status).toBe(403);
  });
});
