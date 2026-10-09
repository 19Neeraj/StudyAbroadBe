import { Types } from 'mongoose';
import { ActivityModel } from '../modules/activities/activity.model.js';
import { BranchModel } from '../modules/branches/branch.model.js';
import { CallModel } from '../modules/calls/call.model.js';
import { StudentModel } from '../modules/students/student.model.js';
import { CounterModel } from '../modules/counters/counter.model.js';
import { FollowUpModel } from '../modules/followups/followup.model.js';
import { LeadModel } from '../modules/leads/lead.model.js';
import { RoleModel } from '../modules/roles/role.model.js';
import { UserModel } from '../modules/users/user.model.js';
import { hashPassword } from '../utils/password.js';

/**
 * Sample data for demos and dashboard checks: branches, a team and ~600 leads over 14 months
 * with realistic stage progression, follow-ups and logged calls. Never runs in production.
 * Deterministic (seeded PRNG) so demos look the same each time.
 */

let state = 42;
const rand = () => {
  state = (state * 1_103_515_245 + 12_345) % 2 ** 31;
  return state / 2 ** 31;
};
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
const weighted = <T>(xs: readonly [T, number][]): T => {
  const total = xs.reduce((s, [, w]) => s + w, 0);
  let r = rand() * total;
  for (const [x, w] of xs) if ((r -= w) <= 0) return x;
  return xs[0]![0];
};

const FIRST = ['Aarav', 'Vivaan', 'Aditya', 'Ishaan', 'Riya', 'Ananya', 'Diya', 'Kabir', 'Meera', 'Saanvi', 'Arjun', 'Zoya', 'Rohan', 'Priya', 'Karan', 'Neha', 'Siddharth', 'Tanvi', 'Yash', 'Pooja'];
const LAST = ['Sharma', 'Verma', 'Mehta', 'Gupta', 'Singh', 'Kapoor', 'Reddy', 'Iyer', 'Nair', 'Joshi', 'Malhotra', 'Bansal', 'Chopra', 'Das'];
const STAGES = ['new_lead', 'contacted', 'meeting_pending', 'meeting_done', 'shortlisting_pending', 'shortlisted', 'application', 'offer_received', 'payment_pending', 'visa', 'enrolled'];
const CAMPAIGNS: Record<string, string[]> = {
  meta: ['UK Sep Intake', 'Canada PG Diploma', 'Australia Masters'],
  google: ['Study in UK - Search', 'MBA Abroad - Search', 'Brand Search'],
  website: ['Organic Landing Page'],
  event: ['Delhi Education Fair'],
};

export async function seedDemoData(organizationId: Types.ObjectId, adminId: Types.ObjectId): Promise<{ leads: number }> {
  if (process.env.NODE_ENV === 'production') throw new Error('Demo data is not allowed in production');
  if (await LeadModel.exists({ organizationId })) return { leads: 0 };

  const branches = await BranchModel.insertMany(
    [
      { organizationId, name: 'Delhi', code: 'DEL', city: 'New Delhi' },
      { organizationId, name: 'Noida', code: 'NOI', city: 'Noida' },
      { organizationId, name: 'Mumbai', code: 'BOM', city: 'Mumbai' },
    ],
  );
  const role = async (key: string) => (await RoleModel.findOne({ organizationId, key }).select('_id').lean())!._id;
  const [counsellorRole, managerRole] = await Promise.all([role('counsellor'), role('manager')]);
  const passwordHash = await hashPassword('DemoUser123');
  const team = [
    { firstName: 'Manav', lastName: 'Khanna', roleId: managerRole, branchIds: [branches[0]!._id, branches[1]!._id], email: 'manager@demo.local' },
    { firstName: 'Simran', lastName: 'Kaur', roleId: counsellorRole, branchIds: [branches[0]!._id], email: 'simran@demo.local' },
    { firstName: 'Rahul', lastName: 'Bhatia', roleId: counsellorRole, branchIds: [branches[0]!._id], email: 'rahul@demo.local' },
    { firstName: 'Fatima', lastName: 'Sheikh', roleId: counsellorRole, branchIds: [branches[1]!._id], email: 'fatima@demo.local' },
    { firstName: 'Vikram', lastName: 'Rao', roleId: counsellorRole, branchIds: [branches[2]!._id], email: 'vikram@demo.local' },
  ];
  const users = await UserModel.insertMany(team.map((u) => ({ ...u, organizationId, passwordHash, isActive: true })));
  const manager = users[0]!;
  const counsellors = users.slice(1);

  const now = Date.now();
  const DAY = 86_400_000;
  const leads = [];
  const followUps = [];
  const activities = [];
  const calls = [];
  const students = [];
  const OUTCOMES = ['interested', 'call_back', 'meeting_required', 'documents_required', 'not_interested', 'no_response'];
  const total = 620;
  for (let i = 0; i < total; i++) {
    // More recent months get more leads (growth), spread across ~14 months.
    const ageDays = Math.floor(Math.pow(rand(), 1.4) * 425);
    const createdAt = new Date(now - ageDays * DAY - Math.floor(rand() * DAY));
    const source = weighted<string>([['meta', 38], ['google', 24], ['website', 14], ['event', 8], ['referral', 7], ['walk_in', 5], ['organic', 4]]);
    const counsellor = rand() < 0.08 ? null : counsellors[Math.floor(rand() * counsellors.length)]!;
    const branchId = counsellor ? counsellor.branchIds[0] : pick(branches)._id;
    // Older leads have had more time to progress.
    const maturity = Math.min(1, ageDays / 120);
    let stageIdx = 0;
    while (stageIdx < STAGES.length - 1 && rand() < 0.55 + 0.3 * maturity - stageIdx * 0.025) stageIdx++;
    const closed = stageIdx < 6 && rand() < 0.12 + 0.25 * maturity;
    const first = pick(FIRST);
    const last = pick(LAST);
    const n = 9_000_000_000 + i * 7919;
    const leadId = new Types.ObjectId();
    const campaign = CAMPAIGNS[source] ? pick(CAMPAIGNS[source]!) : undefined;
    const nextDue = !closed && stageIdx < 10 && rand() < 0.7 ? new Date(now + (rand() * 10 - 3) * DAY) : null;

    leads.push({
      _id: leadId,
      organizationId,
      leadNumber: 1001 + i,
      branchId,
      firstName: first,
      lastName: last,
      fullName: `${first} ${last}`,
      nameTokens: [first.toLowerCase(), last.toLowerCase()],
      phone: `+91${n}`,
      email: `${first}.${last}.${i}@example.com`.toLowerCase(),
      countryInterested: weighted<string>([['uk', 35], ['canada', 22], ['australia', 18], ['usa', 12], ['ireland', 6], ['germany', 7]]),
      courseInterested: pick(['business_management', 'mba', 'computer_science_it', 'data_science_analytics', 'engineering', 'health_medicine']),
      degreeLevel: weighted<string>([['masters', 60], ['bachelors', 30], ['diploma', 10]]),
      ieltsScore: rand() < 0.6 ? 5.5 + Math.floor(rand() * 6) * 0.5 : undefined,
      budget: Math.round((15 + rand() * 35) * 100_000),
      leadSource: source,
      campaign,
      platform: source === 'meta' ? pick(['facebook', 'instagram']) : source === 'google' ? 'google_ads' : undefined,
      utmSource: source === 'meta' ? 'facebook' : source === 'google' ? 'google' : undefined,
      utmMedium: source === 'meta' || source === 'google' ? 'cpc' : undefined,
      sourceHistory: [{ leadSource: source, campaign, at: createdAt }],
      assignedCounsellor: counsellor?._id,
      assignedManager: counsellor && counsellor.branchIds[0]!.equals(branches[0]!._id) ? manager._id : undefined,
      assignedAt: counsellor ? createdAt : undefined,
      leadStage: STAGES[stageIdx],
      leadStatus: closed ? weighted<string>([['not_interested', 45], ['lost', 30], ['invalid', 15], ['dummy', 10]]) : 'active',
      stageChangedAt: new Date(createdAt.getTime() + Math.min(ageDays, stageIdx * 6) * DAY),
      nextFollowUpAt: nextDue,
      firstContactAt: undefined as Date | undefined,
      lastContactedAt: undefined as Date | undefined,
      studentId: undefined as Types.ObjectId | undefined,
      convertedAt: undefined as Date | undefined,
      lastActivityAt: new Date(createdAt.getTime() + Math.min(ageDays, stageIdx * 6) * DAY),
      createdBy: adminId,
      updatedBy: adminId,
      deletedAt: null,
      createdAt,
      updatedAt: createdAt,
    });

    activities.push({ organizationId, leadId, type: 'lead_created', title: 'Lead created', newValue: { leadSource: source, campaign: campaign ?? null }, userId: adminId, occurredAt: createdAt });
    let firstContactAt: Date | undefined;
    if (counsellor) {
      // First response: minutes to a day after creation, faster for some counsellors.
      const responseMs = (5 + rand() * (counsellors.indexOf(counsellor) + 1) * 240) * 60_000;
      const callCount = Math.min(stageIdx + 1 + Math.floor(rand() * 2), 7);
      for (let c = 0; c < callCount; c++) {
        const at = new Date(Math.min(now - 60_000, createdAt.getTime() + (c === 0 ? responseMs : c * 3 * DAY + rand() * DAY)));
        const connected = rand() < 0.72;
        const duration = connected ? Math.round(60 + rand() * (stageIdx >= 6 ? 900 : 420)) : 0;
        const callId = new Types.ObjectId();
        const activityId = new Types.ObjectId();
        if (connected) firstContactAt ??= at;
        calls.push({
          _id: callId, organizationId, provider: 'device', source: 'device', leadId, branchId, counsellorId: counsellor._id,
          leadSource: source, campaign, countryInterested: undefined as string | undefined, courseInterested: undefined as string | undefined,
          direction: rand() < 0.12 ? 'incoming' : 'outgoing', status: connected ? 'completed' : pick(['no_answer', 'busy', 'no_answer']),
          phoneNumber: `+91${n}`, startedAt: at, answeredAt: connected ? at : undefined, endedAt: new Date(at.getTime() + duration * 1000), duration,
          callOutcome: connected ? pick(OUTCOMES.slice(0, 5)) : 'no_response', recordingConsent: { status: 'not_required' },
          activityId, finalizedAt: at, createdBy: counsellor._id, createdAt: at, updatedAt: at,
        });
        const mm = `${String(Math.floor(duration / 60)).padStart(2, '0')}:${String(duration % 60).padStart(2, '0')}`;
        activities.push({
          _id: activityId, organizationId, leadId, type: connected ? 'call_completed' : 'call_missed', title: connected ? `Outgoing call · ${mm}` : 'Call not connected (no answer)',
          newValue: { duration, status: connected ? 'completed' : 'no_answer', direction: 'outgoing' }, metadata: { callId: callId.toString(), provider: 'device' }, userId: counsellor._id, occurredAt: at,
        });
        if (rand() < 0.4) activities.push({ organizationId, leadId, type: pick(['whatsapp', 'email', 'meeting'] as const), title: 'Logged', notes: 'Shared details', userId: counsellor._id, occurredAt: new Date(at.getTime() + 3600_000) });
      }
      for (let f = 0; f < Math.min(stageIdx, 3); f++) {
        const dueAt = new Date(Math.min(now - DAY, createdAt.getTime() + (f * 4 + 2) * DAY));
        followUps.push({ organizationId, leadId, branchId, assignedTo: counsellor._id, dueAt, followUpType: 'call', status: 'completed', completedAt: dueAt, completedBy: counsellor._id, createdBy: counsellor._id });
      }
      const lead = leads[leads.length - 1]!;
      lead.firstContactAt = firstContactAt;
      lead.lastContactedAt = firstContactAt ? new Date(Math.max(...calls.filter((c) => c.leadId.equals(leadId) && c.duration > 0).map((c) => c.startedAt.getTime()))) : undefined;
      for (const c of calls) if (c.leadId.equals(leadId)) Object.assign(c, { countryInterested: lead.countryInterested, courseInterested: lead.courseInterested });
      if (stageIdx >= 5 && !closed) {
        const studentId = new Types.ObjectId();
        const convertedAt = new Date(createdAt.getTime() + Math.min(ageDays, 20) * DAY);
        lead.studentId = studentId;
        lead.convertedAt = convertedAt;
        students.push({
          _id: studentId, organizationId, studentNumber: 1001 + students.length, leadId, branchId, assignedCounsellor: counsellor._id, assignedManager: lead.assignedManager,
          status: stageIdx === 10 ? 'enrolled' : 'active', firstName: first, lastName: last, fullName: `${first} ${last}`, nameTokens: lead.nameTokens,
          phone: lead.phone, email: lead.email, dateOfBirth: new Date(Date.UTC(1998 + Math.floor(rand() * 7), Math.floor(rand() * 12), 1 + Math.floor(rand() * 27))),
          gender: pick(['male', 'female'] as const), nationality: 'Indian', city: pick(['New Delhi', 'Noida', 'Mumbai', 'Gurgaon']),
          passport: rand() < 0.7 ? { number: `Z${Math.floor(1_000_000 + rand() * 8_999_999)}`, issueCountry: 'India', expiryDate: new Date(now + (rand() * 3000 - 200) * DAY) } : undefined,
          education: [{ _id: new Types.ObjectId(), level: "Bachelor's", qualification: pick(['B.Tech', 'B.Com', 'BBA', 'B.Sc']), institution: pick(['Delhi University', 'Amity University', 'Mumbai University', 'IP University']), passingYear: 2019 + Math.floor(rand() * 6), scoreType: 'percentage', score: Math.round(58 + rand() * 30) }],
          testScores: lead.ieltsScore ? [{ _id: new Types.ObjectId(), test: 'ielts', overall: lead.ieltsScore }] : [],
          workExperience: [], totalExperienceMonths: 0,
          preferredCountries: [lead.countryInterested], preferredCourses: [lead.courseInterested], degreeLevel: lead.degreeLevel, budget: lead.budget,
          convertedAt, deletedAt: null, createdBy: counsellor._id, updatedBy: counsellor._id, createdAt: convertedAt, updatedAt: convertedAt,
        });
        activities.push({ organizationId, leadId, studentId, type: 'student_converted', title: 'Converted to student', newValue: { studentNumber: students.length + 1000 }, userId: counsellor._id, occurredAt: convertedAt });
      }
      if (nextDue) followUps.push({ organizationId, leadId, branchId, assignedTo: counsellor._id, dueAt: nextDue, followUpType: pick(['call', 'whatsapp', 'meeting']), status: 'pending', nextAction: 'Check document status', createdBy: counsellor._id });
    }
  }

  // Raw inserts keep the historical createdAt values (Mongoose treats createdAt as immutable).
  await LeadModel.collection.insertMany(leads);
  await FollowUpModel.insertMany(followUps);
  await ActivityModel.insertMany(activities);
  await CallModel.collection.insertMany(calls);
  if (students.length) await StudentModel.collection.insertMany(students);
  await CounterModel.updateOne({ organizationId, key: 'student' }, { $set: { seq: 1000 + students.length } }, { upsert: true });
  await CounterModel.updateOne({ organizationId, key: 'lead' }, { $set: { seq: 1000 + total } }, { upsert: true });
  return { leads: total };
}
