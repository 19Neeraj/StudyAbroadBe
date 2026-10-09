import { describe, expect, it } from 'vitest';
import { api, bearer, createLead, createOrgWithAdmin, createUserAs } from './helpers.js';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
const EXE = Buffer.from('MZ\x90\x00fake-executable');

async function setup() {
  const { org, token } = await createOrgWithAdmin();
  const counsellor = await createUserAs(token, org._id, 'counsellor');
  const intakes = (await api().get('/api/v1/settings/lookups?types=intake').set(bearer(token))).body.data.intake;
  const intake = intakes[0].key as string;
  const lead = (await createLead(token, { firstName: 'Riya', phone: '9876501111', countryInterested: 'uk', intake, ieltsScore: 6.5, assignedCounsellor: counsellor.id })).body.data.lead;
  const student = (await api().post(`/api/v1/leads/${lead._id}/convert`).set(bearer(token)).send({})).body.data;
  const uni = (await api().post('/api/v1/universities').set(bearer(token)).send({ name: 'University of Leeds', country: 'uk', city: 'Leeds', currency: 'GBP', applicationFee: 50, requirements: { minIelts: 6.5 } })).body.data;
  const course = (await api().post(`/api/v1/universities/${uni._id}/courses`).set(bearer(token)).send({ name: 'MSc Data Science', degreeLevel: 'masters', tuitionFee: 28000, intakes: [{ intake, deadline: '2027-06-30' }] })).body.data;
  return { org, token, counsellor, lead, student, uni, course, intake };
}

describe('Universities & course finder', () => {
  it('manages the catalog and filters courses by eligibility from the student profile', async () => {
    const { token, uni, course, student } = await setup();
    expect(course).toMatchObject({ currency: 'GBP', applicationFee: 50, requirements: { minIelts: 6.5 }, country: 'uk' });
    const strict = (await api().post(`/api/v1/universities/${uni._id}/courses`).set(bearer(token)).send({ name: 'MSc AI', requirements: { minIelts: 7.5 } })).body.data;

    const dup = await api().post('/api/v1/universities').set(bearer(token)).send({ name: 'university of leeds', country: 'uk' });
    expect(dup.status).toBe(409);

    const list = await api().get('/api/v1/universities?search=leed').set(bearer(token));
    expect(list.body.data[0]).toMatchObject({ name: 'University of Leeds', courseCount: 2 });

    // Student has IELTS 6.5: eligible for Data Science, not for AI (7.5).
    const finder = await api().get(`/api/v1/universities/courses/search?forStudent=${student._id}`).set(bearer(token));
    const names = finder.body.data.map((c: { name: string }) => c.name);
    expect(names).toContain('MSc Data Science');
    expect(names).not.toContain('MSc AI');
    expect(finder.body.data[0].university).toMatchObject({ name: 'University of Leeds' });
    expect(strict._id).toBeTruthy();
  });

  it('restricts catalog management to university.manage', async () => {
    const { org, token } = await setup();
    const counsellor = await createUserAs(token, org._id, 'counsellor');
    expect((await api().get('/api/v1/universities').set(bearer(counsellor.token))).status).toBe(200);
    expect((await api().post('/api/v1/universities').set(bearer(counsellor.token)).send({ name: 'X Uni', country: 'uk' })).status).toBe(403);
  });
});

describe('Shortlist → application → offer → payment → visa', () => {
  it('runs the full journey and advances the lead stage automatically', async () => {
    const { token, lead, student, uni, course, intake } = await setup();
    const stage = async () => (await api().get(`/api/v1/leads/${lead._id}`).set(bearer(token))).body.data.leadStage;

    const sl = await api().post(`/api/v1/shortlist/student/${student._id}`).set(bearer(token)).send({ universityId: uni._id, courseId: course._id });
    expect(sl.status).toBe(201);
    expect(sl.body.data).toMatchObject({ status: 'shortlisted', intake, university: { name: 'University of Leeds' }, course: { name: 'MSc Data Science' } });
    expect(await stage()).toBe('shortlisted');
    expect((await api().post(`/api/v1/shortlist/student/${student._id}`).set(bearer(token)).send({ universityId: uni._id, courseId: course._id })).status).toBe(409);

    const app = await api().post(`/api/v1/shortlist/${sl.body.data._id}/apply`).set(bearer(token)).send({});
    expect(app.status).toBe(201);
    expect(app.body.data).toMatchObject({ applicationNumber: 1001, status: 'draft', tuitionFee: 28000, currency: 'GBP', studentName: 'Riya', intake });
    expect(new Date(app.body.data.applicationDeadline).toISOString().slice(0, 10)).toBe('2027-06-30');
    expect(await stage()).toBe('application');
    const appId = app.body.data._id;

    const submitted = await api().patch(`/api/v1/applications/${appId}/status`).set(bearer(token)).send({ status: 'submitted' });
    expect(submitted.body.data.applicationDate).toBeTruthy();
    expect((await api().get(`/api/v1/shortlist/student/${student._id}`).set(bearer(token))).body.data[0].status).toBe('applied');
    expect((await api().patch(`/api/v1/applications/${appId}/status`).set(bearer(token)).send({ status: 'nonsense' })).status).toBe(422);

    const offer = await api().patch(`/api/v1/applications/${appId}/offer`).set(bearer(token)).send({ status: 'conditional', conditions: 'IELTS 7.0', depositAmount: 5000, scholarship: 2000 });
    expect(offer.body.data).toMatchObject({ status: 'conditional_offer', offer: { status: 'conditional', depositAmount: 5000 }, scholarship: 2000 });
    expect(await stage()).toBe('offer_received');

    const pay = await api().post('/api/v1/payments').set(bearer(token)).send({ studentId: student._id, applicationId: appId, purpose: 'tuition_deposit', amount: 5000, currency: 'GBP' });
    expect(pay.status).toBe(201);
    expect(pay.body.data).toMatchObject({ paymentNumber: 1001, paymentStatus: 'pending' });
    expect(await stage()).toBe('payment_pending');
    expect((await api().get(`/api/v1/applications/${appId}`).set(bearer(token))).body.data.paymentStatus).toBe('pending');
    await api().patch(`/api/v1/payments/${pay.body.data._id}`).set(bearer(token)).send({ paymentStatus: 'success', transactionId: 'TXN-1' });
    expect((await api().get(`/api/v1/applications/${appId}`).set(bearer(token))).body.data.paymentStatus).toBe('paid');
    const summary = await api().get(`/api/v1/payments/summary?studentId=${student._id}`).set(bearer(token));
    expect(summary.body.data).toEqual([{ status: 'success', currency: 'GBP', amount: 5000 }]);

    const visa = await api().post('/api/v1/visa').set(bearer(token)).send({ applicationId: appId, visaType: 'Student (Tier 4)', status: 'submitted' });
    expect(visa.status).toBe(201);
    expect(await stage()).toBe('visa');
    expect((await api().patch(`/api/v1/visa/${visa.body.data._id}`).set(bearer(token)).send({ status: 'rejected' })).status).toBe(422);
    const approved = await api().patch(`/api/v1/visa/${visa.body.data._id}`).set(bearer(token)).send({ status: 'approved' });
    expect(approved.body.data.decisionDate).toBeTruthy();
    expect((await api().get(`/api/v1/applications/${appId}`).set(bearer(token))).body.data.visaStatus).toBe('approved');

    await api().patch(`/api/v1/applications/${appId}/status`).set(bearer(token)).send({ status: 'enrolled' });
    expect(await stage()).toBe('enrolled');
    expect((await api().get(`/api/v1/students/${student._id}`).set(bearer(token))).body.data.status).toBe('enrolled');

    // Stage never moves backwards: a late status change does not demote the lead.
    await api().patch(`/api/v1/applications/${appId}/status`).set(bearer(token)).send({ status: 'submitted' });
    expect(await stage()).toBe('enrolled');

    const timeline = await api().get(`/api/v1/students/${student._id}/activities?limit=100`).set(bearer(token));
    const types = timeline.body.data.map((a: { type: string }) => a.type);
    for (const t of ['shortlist_added', 'application_created', 'application_updated', 'offer_updated', 'payment_recorded', 'payment_updated', 'visa_updated', 'stage_changed']) expect(types).toContain(t);
    const board = await api().get('/api/v1/applications/board').set(bearer(token));
    expect(board.body.data.find((b: { status: string }) => b.status === 'submitted').count).toBe(1);
  });

  it('keeps applications in the student’s scope and isolated per tenant', async () => {
    const { org, token, lead, student, uni, counsellor } = await setup();
    const app = (await api().post('/api/v1/applications').set(bearer(token)).send({ studentId: student._id, universityId: uni._id, courseName: 'Custom course' })).body.data;
    expect((await api().get(`/api/v1/applications/${app._id}`).set(bearer(counsellor.token))).status).toBe(200);
    const other = await createUserAs(token, org._id, 'counsellor');
    expect((await api().get(`/api/v1/applications/${app._id}`).set(bearer(other.token))).status).toBe(404);
    // Reassigning the lead moves the application with it.
    await api().post(`/api/v1/leads/${lead._id}/assign`).set(bearer(token)).send({ counsellorId: other.id });
    expect((await api().get(`/api/v1/applications/${app._id}`).set(bearer(other.token))).status).toBe(200);
    expect((await api().get(`/api/v1/applications/${app._id}`).set(bearer(counsellor.token))).status).toBe(404);

    const outsider = await createOrgWithAdmin('Other');
    expect((await api().get(`/api/v1/applications/${app._id}`).set(bearer(outsider.token))).status).toBe(404);
    expect((await api().post('/api/v1/applications').set(bearer(outsider.token)).send({ studentId: student._id, universityId: uni._id })).status).toBe(404);
    // Counsellors can't change visa cases.
    expect((await api().post('/api/v1/visa').set(bearer(other.token)).send({ applicationId: app._id })).status).toBe(403);
  });
});

describe('Documents', () => {
  it('requests, uploads (content-checked), versions, reviews and serves files securely', async () => {
    const { org, token, student, counsellor } = await setup();
    const checklist = await api().post('/api/v1/documents/checklist').set(bearer(token)).send({ studentId: student._id, documentTypes: ['passport', 'ielts'] });
    expect(checklist.status).toBe(201);
    expect(checklist.body.data.summary).toMatchObject({ total: 2, pending: 2 });
    const passport = checklist.body.data.items.find((d: { documentType: string }) => d.documentType === 'passport');

    const bad = await api().post('/api/v1/documents/upload').set(bearer(counsellor.token)).field('documentId', passport._id).attach('file', EXE, { filename: 'passport.pdf', contentType: 'application/pdf' });
    expect(bad.status).toBe(422);
    const missing = await api().post('/api/v1/documents/upload').set(bearer(counsellor.token)).field('documentId', passport._id);
    expect(missing.status).toBe(422);

    const up = await api().post('/api/v1/documents/upload').set(bearer(counsellor.token)).field('documentId', passport._id).attach('file', PDF, { filename: '../../etc/My Passport!.pdf', contentType: 'application/pdf' });
    expect(up.status).toBe(201);
    expect(up.body.data).toMatchObject({ status: 'uploaded', file: { fileName: 'My Passport.pdf', mimeType: 'application/pdf' } });
    expect(JSON.stringify(up.body.data)).not.toContain('fileKey');

    // Counsellor (no document.approve/reject) cannot review.
    expect((await api().patch(`/api/v1/documents/${passport._id}/review`).set(bearer(counsellor.token)).send({ decision: 'approve' })).status).toBe(403);
    expect((await api().patch(`/api/v1/documents/${passport._id}/review`).set(bearer(token)).send({ decision: 'reupload' })).status).toBe(422);
    await api().patch(`/api/v1/documents/${passport._id}/review`).set(bearer(token)).send({ decision: 'reupload', reason: 'Blurry scan' });

    const v2 = await api().post('/api/v1/documents/upload').set(bearer(counsellor.token)).field('documentId', passport._id).attach('file', PDF, 'passport-v2.pdf');
    expect(v2.body.data.versions).toHaveLength(1);
    expect(v2.body.data.versions[0]).toMatchObject({ status: 'reupload_required', rejectionReason: 'Blurry scan' });
    const ok = await api().patch(`/api/v1/documents/${passport._id}/review`).set(bearer(token)).send({ decision: 'approve' });
    expect(ok.body.data).toMatchObject({ status: 'approved', reviewedBy: { fullName: 'Org Admin' } });
    // Once approved, the counsellor can't silently replace it.
    expect((await api().post('/api/v1/documents/upload').set(bearer(counsellor.token)).field('documentId', passport._id).attach('file', PDF, 'x.pdf')).status).toBe(403);

    const dl = await api().get(`/api/v1/documents/${passport._id}/download`).set(bearer(counsellor.token));
    const file = await api().get(dl.body.data.url.replace(/^https?:\/\/[^/]+/, ''));
    expect(file.status).toBe(200);
    expect(Buffer.from(file.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');

    // Upload by type without a checklist item creates one.
    const ielts = await api().post('/api/v1/documents/upload').set(bearer(counsellor.token)).field('studentId', student._id).field('documentType', 'ielts').attach('file', PDF, 'ielts.pdf');
    expect(ielts.status).toBe(201);
    const list = await api().get(`/api/v1/documents?studentId=${student._id}`).set(bearer(token));
    expect(list.body.data.summary).toMatchObject({ total: 2, approved: 1, inReview: 1 });

    const outsider = await createOrgWithAdmin('Other');
    expect((await api().get(`/api/v1/documents/${passport._id}/download`).set(bearer(outsider.token))).status).toBe(404);
    const other = await createUserAs(token, org._id, 'counsellor');
    expect((await api().get(`/api/v1/documents/${passport._id}`).set(bearer(other.token))).status).toBe(404);
  });
});

describe('Dashboard revenue', () => {
  it('sums successful payments in the period per currency and counsellor', async () => {
    const { token, student, counsellor } = await setup();
    await api().post('/api/v1/payments').set(bearer(token)).send({ studentId: student._id, purpose: 'service_fee', amount: 50000, paymentStatus: 'success' });
    await api().post('/api/v1/payments').set(bearer(token)).send({ studentId: student._id, purpose: 'service_fee', amount: 999, paymentStatus: 'pending' });
    const d = (await api().get('/api/v1/dashboard/overview?period=this_month').set(bearer(token))).body.data;
    expect(d.kpis.revenue[0]).toEqual({ currency: 'INR', current: 50000, previous: 0 });
    expect(d.breakdowns.counsellor.find((r: { key: string }) => r.key === counsellor.id).revenue).toEqual({ INR: 50000 });
  });
});
