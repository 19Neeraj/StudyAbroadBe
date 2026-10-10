import { Types } from 'mongoose';
import { ActivityModel } from '../modules/activities/activity.model.js';
import { BranchModel } from '../modules/branches/branch.model.js';
import { CallModel } from '../modules/calls/call.model.js';
import { StudentModel } from '../modules/students/student.model.js';
import { ApplicationModel, ShortlistModel } from '../modules/applications/application.model.js';
import { DocumentModel } from '../modules/documents/document.model.js';
import { PaymentModel } from '../modules/payments/payment.model.js';
import { CourseModel, UniversityModel } from '../modules/universities/university.model.js';
import { VisaModel } from '../modules/visa/visa.model.js';
import { IntegrationModel } from '../modules/integrations/integration.model.js';
import { AttributionNodeModel } from '../modules/marketing/attributionNode.model.js';
import { recordTouchpoint, type TouchpointInput } from '../modules/marketing/attribution.service.js';
import { CampaignMappingModel } from '../modules/marketing/campaignMapping.model.js';
import { runSync } from '../modules/marketing/sync.service.js';
import { encryptSecret, randomToken } from '../utils/crypto.js';
import { EventModel, EventRegistrationModel } from '../modules/events/event.model.js';
import { CounterModel } from '../modules/counters/counter.model.js';
import { FollowUpModel } from '../modules/followups/followup.model.js';
import { LeadModel } from '../modules/leads/lead.model.js';
import { LeadInquiryModel } from '../modules/leads/inquiry.model.js';
import { AuditLogModel } from '../modules/audit/audit.model.js';
import { seedDemoExtras } from './demoExtras.js';
import { NotificationModel } from '../modules/notifications/notification.model.js';
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

export async function seedDemoData(organizationId: Types.ObjectId, adminId: Types.ObjectId, opts: { leads?: number } = {}): Promise<{ leads: number }> {
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
    { firstName: 'Ayesha', lastName: 'Menon', roleId: counsellorRole, branchIds: [branches[2]!._id], email: 'ayesha@demo.local' },
    { firstName: 'Kunal', lastName: 'Arora', roleId: counsellorRole, branchIds: [branches[1]!._id], email: 'kunal@demo.local' },
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
  const admitted: { studentId: Types.ObjectId; stageIdx: number; convertedAt: Date; counsellorId: Types.ObjectId }[] = [];
  const OUTCOMES = ['interested', 'call_back', 'meeting_required', 'documents_required', 'not_interested', 'no_response'];
  // A realistic single-office demo; `npm run seed:demo -- --leads=N` changes it (20–1000).
  const total = Math.min(1000, Math.max(20, Math.round(opts.leads ?? 90)));
  for (let i = 0; i < total; i++) {
    // More recent months get more leads (growth), spread across ~14 months.
    const ageDays = Math.floor(Math.pow(rand(), 1.3) * 425);
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
      normalizedPhone: `+91${n}`,
      inquiryCount: 1,
      firstInquiryAt: createdAt,
      lastInquiryAt: createdAt,
      lastInquiryChannel: source === 'meta' ? 'meta_lead_ad' : source === 'website' ? 'website_form' : source === 'event' ? 'event' : 'import',
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
        admitted.push({ studentId, stageIdx, convertedAt, counsellorId: counsellor._id });
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
  await seedAdmissions(organizationId, students, admitted, adminId);
  await seedMarketing(organizationId, adminId);
  await seedEvents(organizationId, adminId, branches[0]!._id);
  await seedDemoExtras(organizationId, adminId);
  await CounterModel.updateOne({ organizationId, key: 'student' }, { $set: { seq: 1000 + students.length } }, { upsert: true });
  await CounterModel.updateOne({ organizationId, key: 'lead' }, { $set: { seq: 1000 + total } }, { upsert: true });
  // A little audit history (sign-ins and a role review) so the audit log screen isn't empty.
  await AuditLogModel.insertMany(
    users.flatMap((u, i) =>
      [1, 3, 6].map((d) => ({ organizationId, userId: u._id, entityType: 'user', entityId: u._id, action: 'auth.login', metadata: { platform: i % 2 ? 'android' : 'web' }, userAgent: 'demo-seed', createdAt: new Date(now - (d + i) * DAY) })),
    ),
  );
  return { leads: total };
}

const UNIVERSITIES: { name: string; country: string; city: string; ranking: number; currency: string; fee: number; courses: [string, string, string, number][] }[] = [
  { name: 'University of Leeds', country: 'uk', city: 'Leeds', ranking: 82, currency: 'GBP', fee: 0, courses: [['MSc Data Science', 'masters', 'data_science_analytics', 31_000], ['MBA', 'masters', 'mba', 38_000]] },
  { name: 'University of Glasgow', country: 'uk', city: 'Glasgow', ranking: 76, currency: 'GBP', fee: 0, courses: [['MSc Computer Science', 'masters', 'computer_science_it', 32_000], ['MSc International Business', 'masters', 'business_management', 29_000]] },
  { name: 'Coventry University', country: 'uk', city: 'Coventry', ranking: 520, currency: 'GBP', fee: 0, courses: [['MSc Engineering Management', 'masters', 'engineering', 19_500], ['MSc Public Health', 'masters', 'health_medicine', 18_000]] },
  { name: 'University of Toronto', country: 'canada', city: 'Toronto', ranking: 21, currency: 'CAD', fee: 125, courses: [['MEng Electrical Engineering', 'masters', 'engineering', 62_000], ['MSc Applied Computing', 'masters', 'computer_science_it', 58_000]] },
  { name: 'Seneca Polytechnic', country: 'canada', city: 'Toronto', ranking: 900, currency: 'CAD', fee: 100, courses: [['PG Diploma Business Analytics', 'diploma', 'data_science_analytics', 19_000], ['PG Diploma Project Management', 'diploma', 'business_management', 18_000]] },
  { name: 'Monash University', country: 'australia', city: 'Melbourne', ranking: 37, currency: 'AUD', fee: 100, courses: [['Master of Data Science', 'masters', 'data_science_analytics', 52_000], ['Master of Business Administration', 'masters', 'mba', 61_000]] },
  { name: 'Deakin University', country: 'australia', city: 'Geelong', ranking: 233, currency: 'AUD', fee: 0, courses: [['Master of IT', 'masters', 'computer_science_it', 43_000], ['Master of Public Health', 'masters', 'health_medicine', 39_000]] },
  { name: 'Arizona State University', country: 'usa', city: 'Tempe', ranking: 200, currency: 'USD', fee: 115, courses: [['MS Computer Science', 'masters', 'computer_science_it', 34_000], ['MS Business Analytics', 'masters', 'data_science_analytics', 36_000]] },
  { name: 'University College Dublin', country: 'ireland', city: 'Dublin', ranking: 126, currency: 'EUR', fee: 50, courses: [['MSc Business Analytics', 'masters', 'data_science_analytics', 26_000], ['MSc Management', 'masters', 'business_management', 24_000]] },
  { name: 'TU Munich', country: 'germany', city: 'Munich', ranking: 28, currency: 'EUR', fee: 75, courses: [['MSc Informatics', 'masters', 'computer_science_it', 6_000], ['MSc Mechanical Engineering', 'masters', 'engineering', 6_000]] },
];
/** The student fields the admissions demo reads. */
interface DemoStudent {
  _id: Types.ObjectId;
  leadId: Types.ObjectId;
  branchId?: Types.ObjectId;
  assignedCounsellor?: Types.ObjectId;
  assignedManager?: Types.ObjectId;
  fullName: string;
  studentNumber: number;
  preferredCountries: (string | undefined)[];
  testScores: unknown[];
}
const RATE_TO_INR: Record<string, number> = { GBP: 107, CAD: 61, AUD: 55, USD: 84, EUR: 91 };

/**
 * Catalog, shortlists, applications, offers, payments, visa cases and document checklists that
 * follow each student's lead stage (application → offer → payment → visa → enrolled).
 */
async function seedAdmissions(
  organizationId: Types.ObjectId,
  students: DemoStudent[],
  admitted: { studentId: Types.ObjectId; stageIdx: number; convertedAt: Date; counsellorId: Types.ObjectId }[],
  adminId: Types.ObjectId,
) {
  if (!students.length) return;
  const DAY = 86_400_000;
  const now = Date.now();
  const year = new Date().getFullYear();
  const intakes = [`sep_${year + 1}`, `jan_${year + 2}`, `may_${year + 1}`];
  const unis = await UniversityModel.insertMany(
    UNIVERSITIES.map((u) => ({ organizationId, name: u.name, country: u.country, city: u.city, ranking: u.ranking, currency: u.currency, applicationFee: u.fee, requirements: { minIelts: u.ranking < 100 ? 6.5 : 6, minPercentage: u.ranking < 100 ? 60 : 55 }, createdBy: adminId })),
  );
  const courses = await CourseModel.insertMany(
    UNIVERSITIES.flatMap((u, i) =>
      u.courses.map(([name, degreeLevel, courseArea, tuitionFee]) => ({
        organizationId, universityId: unis[i]!._id, country: u.country, name, degreeLevel, courseArea, tuitionFee, currency: u.currency, durationMonths: degreeLevel === 'masters' ? 12 : 24,
        intakes: intakes.map((intake, k) => ({ intake, deadline: new Date(now + (30 + k * 60) * DAY) })), applicationFee: u.fee, scholarshipAvailable: u.ranking < 150, createdBy: adminId,
      })),
    ),
  );

  type Doc = Record<string, unknown>;
  const shortlists: Doc[] = [];
  const applications: Doc[] = [];
  const payments: Doc[] = [];
  const visas: Doc[] = [];
  const documents: Doc[] = [];
  let appNo = 0;
  let payNo = 0;
  for (const { studentId, stageIdx, convertedAt, counsellorId } of admitted) {
    const s = students.find((x) => x._id.equals(studentId))!;
    const own = { organizationId, studentId, leadId: s.leadId, branchId: s.branchId, assignedCounsellor: s.assignedCounsellor, assignedManager: s.assignedManager };
    const inCountry = courses.filter((c) => c.country === s.preferredCountries[0]);
    const options = (inCountry.length >= 2 ? inCountry : courses).slice().sort(() => rand() - 0.5).slice(0, 2 + Math.floor(rand() * 2));
    const intake = pick(intakes);
    const docTypes = ['passport', 'bachelors', 'mark_sheets', 'sop', 'cv', ...(s.testScores.length ? ['ielts'] : [])];
    for (const t of docTypes) documents.push({ ...own, documentType: t, status: 'required', dueDate: new Date(new Date(convertedAt.getTime() + 21 * DAY).setUTCHours(12, 0, 0, 0)), versions: [], createdBy: counsellorId, createdAt: convertedAt, updatedAt: convertedAt });

    options.forEach((c, k) => {
      const shortlistId = new Types.ObjectId();
      const applying = k === 0 && stageIdx >= 6;
      const at = new Date(convertedAt.getTime() + (3 + k) * DAY);
      const entry: Record<string, unknown> = { _id: shortlistId, ...own, universityId: c.universityId, courseId: c._id, country: c.country, intake, status: applying ? 'application_started' : k === 1 ? 'interested' : 'shortlisted', priority: k + 1, createdBy: counsellorId, createdAt: at, updatedAt: at };
      shortlists.push(entry);
      if (!applying) return;

      const applicationId = new Types.ObjectId();
      entry.applicationId = applicationId;
      const appliedAt = new Date(at.getTime() + 4 * DAY);
      const offer = stageIdx >= 7;
      const accepted = stageIdx >= 8;
      const enrolled = stageIdx === 10;
      const status = enrolled ? 'enrolled' : offer ? (rand() < 0.5 ? 'conditional_offer' : 'unconditional_offer') : pick(['documents_pending', 'submitted', 'under_review']);
      entry.status = enrolled ? 'enrolled' : offer ? 'offer_received' : 'applied';
      const deposit = Math.round((c.tuitionFee ?? 20_000) * 0.25);
      const visaStatus = enrolled ? 'approved' : stageIdx === 9 ? pick(['submitted', 'appointment_scheduled', 'under_process'] as const) : 'not_started';
      applications.push({
        _id: applicationId, ...own, applicationNumber: 1001 + appNo++, studentName: s.fullName, studentNumber: s.studentNumber, universityId: c.universityId, courseId: c._id, country: c.country, intake, shortlistId,
        applicationDate: status === 'documents_pending' ? undefined : appliedAt, applicationDeadline: c.intakes.find((x) => x.intake === intake)?.deadline, universityApplicationId: status === 'documents_pending' ? undefined : `UA${Math.floor(100_000 + rand() * 899_999)}`,
        status, statusChangedAt: appliedAt,
        offer: offer
          ? { status: accepted ? 'accepted' : status === 'conditional_offer' ? 'conditional' : 'unconditional', date: new Date(appliedAt.getTime() + 20 * DAY), conditions: status === 'conditional_offer' ? 'Final transcript and IELTS 6.5 overall' : undefined, depositAmount: deposit, depositDeadline: new Date(now + 25 * DAY), expiryDate: new Date(now + 60 * DAY) }
          : { status: 'none' },
        currency: c.currency, tuitionFee: c.tuitionFee, scholarship: offer && rand() < 0.3 ? Math.round((c.tuitionFee ?? 0) * 0.1) : undefined, applicationFee: c.applicationFee,
        paymentStatus: stageIdx >= 9 ? 'paid' : accepted ? 'pending' : 'not_due', visaStatus, enrolmentStatus: enrolled ? 'enrolled' : 'not_started',
        deletedAt: null, createdBy: counsellorId, updatedBy: counsellorId, createdAt: appliedAt, updatedAt: new Date(Math.min(now, appliedAt.getTime() + 25 * DAY)),
      });
      // Service fee once the application starts; tuition deposit after the offer is accepted.
      payments.push({ ...own, paymentNumber: 1001 + payNo++, applicationId, purpose: 'service_fee', amount: pick([25_000, 35_000, 50_000]), currency: 'INR', paymentMethod: pick(['upi', 'bank_transfer', 'card'] as const), paymentStatus: 'success', transactionId: `TXN${Math.floor(1e8 + rand() * 9e8)}`, paymentDate: appliedAt, createdBy: counsellorId, createdAt: appliedAt, updatedAt: appliedAt });
      if (accepted) {
        const paid = stageIdx >= 9;
        const due = new Date(now + (paid ? -10 : 5 + Math.floor(rand() * 25) - 8) * DAY);
        payments.push({ ...own, paymentNumber: 1001 + payNo++, applicationId, purpose: 'tuition_deposit', amount: Math.round(deposit * RATE_TO_INR[c.currency ?? 'GBP']!), currency: 'INR', paymentMethod: paid ? 'bank_transfer' : undefined, paymentStatus: paid ? 'success' : 'pending', transactionId: paid ? `TXN${Math.floor(1e8 + rand() * 9e8)}` : undefined, dueDate: due, paymentDate: paid ? due : undefined, remarks: `${c.currency} ${deposit.toLocaleString('en-IN')} deposit`, createdBy: counsellorId, createdAt: due, updatedAt: due });
      }
      if (visaStatus !== 'not_started') {
        const submitted = new Date(now - (enrolled ? 90 : 12) * DAY);
        visas.push({
          ...own, applicationId, country: c.country, visaType: { uk: 'Student visa', canada: 'Study permit', australia: 'Subclass 500', usa: 'F-1', ireland: 'Stamp 2', germany: 'National visa (D)' }[c.country] ?? 'Student visa', status: visaStatus,
          submissionDate: submitted, appointmentDate: visaStatus === 'submitted' ? undefined : visaStatus === 'appointment_scheduled' ? new Date(now + (3 + Math.floor(rand() * 20)) * DAY) : new Date(submitted.getTime() + 7 * DAY), appointmentLocation: visaStatus === 'submitted' ? undefined : pick(['VFS New Delhi', 'VFS Mumbai']),
          decisionDate: enrolled ? new Date(submitted.getTime() + 21 * DAY) : undefined, visaExpiryDate: enrolled ? new Date(now + 500 * DAY) : undefined, createdBy: counsellorId, createdAt: submitted, updatedAt: submitted,
        });
      }
    });
  }
  await ShortlistModel.collection.insertMany(shortlists);
  if (applications.length) await ApplicationModel.collection.insertMany(applications);
  if (payments.length) await PaymentModel.collection.insertMany(payments);
  if (visas.length) await VisaModel.collection.insertMany(visas);
  if (documents.length) await DocumentModel.collection.insertMany(documents);
  await CounterModel.updateOne({ organizationId, key: 'application' }, { $set: { seq: 1000 + appNo } }, { upsert: true });
  await CounterModel.updateOne({ organizationId, key: 'payment' }, { $set: { seq: 1000 + payNo } }, { upsert: true });
}

/** Demo ad campaign IDs (the mock ads provider's catalogue) behind the demo campaign names. */
const DEMO_CAMPAIGN_IDS: Record<string, { campaign: string; adset?: string; ad?: string }> = {
  'UK Sep Intake': { campaign: 'c-100', adset: 's-110', ad: 'a-111' },
  'Canada PG Diploma': { campaign: 'c-200', adset: 's-210', ad: 'a-211' },
  // Not in the provider catalogue and not mapped: shows up in the data-quality report.
  'Australia Masters': { campaign: 'c-300' },
};

/**
 * Integrations & attribution demo: a connected test ads account with 120 days of spend, a sample
 * Primary/Secondary/Tertiary hierarchy, campaign mappings and touchpoints for every demo lead.
 */
async function seedMarketing(organizationId: Types.ObjectId, adminId: Types.ObjectId) {
  const DAY = 86_400_000;
  const integration = await IntegrationModel.create({
    organizationId, kind: 'meta_ads', provider: 'mock', enabled: true, status: 'connected', config: {},
    secrets: encryptSecret(JSON.stringify({ accessToken: 'demo-token', appSecret: 'demo-secret', verifyToken: 'demo-verify' })),
    webhookToken: randomToken(32), connectedBy: adminId, connectedAccountName: 'Mock Business (demo)', grantedScopes: ['ads_read', 'leads_retrieval'], missingScopes: [],
  });
  const base = { organizationId, integrationId: integration._id, trigger: 'connect' as const, triggeredBy: adminId };
  await runSync({ ...base, type: 'accounts' });
  await runSync({ ...base, type: 'campaigns' });
  await runSync({ ...base, type: 'metrics', from: new Date(Date.now() - 120 * DAY).toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) });

  const node = async (dimension: 'source' | 'medium' | 'campaign', level: 1 | 2 | 3, label: string, parentId?: Types.ObjectId) =>
    (await AttributionNodeModel.create({ organizationId, dimension, level, label, parentId, key: label.toLowerCase().replace(/[^a-z0-9]+/g, '_'), createdBy: adminId }))._id;
  type Path = { source?: { l1?: Types.ObjectId; l2?: Types.ObjectId; l3?: Types.ObjectId }; medium?: { l1?: Types.ObjectId; l2?: Types.ObjectId; l3?: Types.ObjectId }; campaign?: { l1?: Types.ObjectId; l2?: Types.ObjectId; l3?: Types.ObjectId } };
  // Source: Primary → Secondary → Tertiary (sample values, editable in Marketing → Attribution hierarchy).
  const digital = await node('source', 1, 'Digital Marketing');
  const meta = await node('source', 2, 'Meta', digital);
  const leadAds = await node('source', 3, 'Meta Lead Ads Form', meta);
  const google = await node('source', 2, 'Google', digital);
  const searchAds = await node('source', 3, 'Google Search Ads', google);
  const organic = await node('source', 1, 'Organic');
  const website = await node('source', 2, 'Website', organic);
  const enquiryForm = await node('source', 3, 'Website Enquiry Form', website);
  const offline = await node('source', 1, 'Offline');
  const events = await node('source', 2, 'Events', offline);
  const fair = await node('source', 3, 'Education Fair', events);
  const walkIns = await node('source', 2, 'Walk-in', offline);
  const referral = await node('source', 1, 'Referral');
  const studentRef = await node('source', 2, 'Student Referral', referral);
  // Medium
  const mPaid = await node('medium', 1, 'Paid');
  const social = await node('medium', 2, 'Social', mPaid);
  const leadGen = await node('medium', 3, 'Lead Generation', social);
  const mSearch = await node('medium', 2, 'Search', mPaid);
  const cpc = await node('medium', 3, 'CPC', mSearch);
  const mOrganic = await node('medium', 1, 'Organic');
  const seo = await node('medium', 2, 'SEO', mOrganic);
  const mOffline = await node('medium', 1, 'Offline');
  const inPerson = await node('medium', 2, 'In person', mOffline);
  // Campaign
  const study = await node('campaign', 1, 'Study Abroad');
  const sept = await node('campaign', 2, 'September Intake', study);
  const ukMasters = await node('campaign', 3, 'UK Masters Leads', sept);
  const canadaPg = await node('campaign', 3, 'Canada PG Diploma', sept);
  const jan = await node('campaign', 2, 'January Intake', study);
  const ausMasters = await node('campaign', 3, 'Australia Masters', jan);
  const brand = await node('campaign', 1, 'Brand');
  await node('campaign', 2, 'Always-on', brand);
  const since = new Date(Date.now() - 730 * DAY);
  const mapping = (id: string, name: string, l3: Types.ObjectId) => ({
    organizationId, provider: 'mock', accountExternalId: 'act_1001', campaignExternalId: id, externalName: name, effectiveFrom: since, createdBy: adminId,
    source: { l1: digital, l2: meta, l3: leadAds }, medium: { l1: mPaid, l2: social, l3: leadGen }, campaign: { l1: study, l2: sept, l3 },
  });
  await CampaignMappingModel.insertMany([mapping('c-100', 'UK Sep Intake', ukMasters), mapping('c-200', 'Canada PG Diploma', canadaPg)]);

  /** What a person would pick in the lead form for sources without an ad-platform mapping. */
  const manualPath = (source: string, campaign?: string | null): Path | undefined => {
    const camp = campaign?.startsWith('Study in UK') ? { l1: study, l2: sept, l3: ukMasters } : campaign === 'Australia Masters' ? { l1: study, l2: jan, l3: ausMasters } : undefined;
    switch (source) {
      case 'google': return { source: { l1: digital, l2: google, l3: searchAds }, medium: { l1: mPaid, l2: mSearch, l3: cpc }, ...(camp ? { campaign: camp } : {}) };
      case 'website': return { source: { l1: organic, l2: website, l3: enquiryForm }, medium: { l1: mOrganic, l2: seo } };
      case 'organic': return { source: { l1: organic, l2: website }, medium: { l1: mOrganic, l2: seo } };
      case 'event': return { source: { l1: offline, l2: events, l3: fair }, medium: { l1: mOffline, l2: inPerson } };
      case 'walk_in': return { source: { l1: offline, l2: walkIns }, medium: { l1: mOffline, l2: inPerson } };
      case 'referral': return { source: { l1: referral, l2: studentRef } };
      // Meta campaign without a mapping (c-300): only the source is known — nothing is invented.
      case 'meta': return camp ? { source: { l1: digital, l2: meta, l3: leadAds }, campaign: camp } : undefined;
      default: return undefined;
    }
  };
  const str = (p?: Path) => (p ? Object.fromEntries(Object.entries(p).map(([d, h]) => [d, { l1: h?.l1?.toString(), l2: h?.l2?.toString(), l3: h?.l3?.toString() }])) : undefined);
  const originOf = (source: string) => (source === 'meta' ? 'meta_lead_ad' : source === 'website' ? 'website_form' : source === 'event' ? 'event' : 'import') as TouchpointInput['origin'];
  const touchFor = (leadId: Types.ObjectId, source: string, campaign: string | null | undefined, at: Date): TouchpointInput => {
    const ids = source === 'meta' && campaign ? DEMO_CAMPAIGN_IDS[campaign] : undefined;
    const mapped = !!ids && ids.campaign !== 'c-300';
    return {
      origin: originOf(source),
      occurredAt: at,
      leadSource: source,
      campaignName: campaign ?? undefined,
      provider: ids ? 'mock' : undefined,
      campaignExternalId: ids?.campaign,
      adsetExternalId: ids?.adset,
      adExternalId: ids?.ad,
      leadFormExternalId: ids ? 'form-demo-1' : undefined,
      raw:
        source === 'google'
          ? { utm_source: 'google', utm_medium: 'cpc', utm_campaign: (campaign ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-'), gclid: `demo-${leadId.toString().slice(-8)}`, landing_url: 'https://www.example.com/study-in-uk' }
          : source === 'meta'
            ? { utm_source: 'facebook', utm_medium: 'paid_social', utm_campaign: (campaign ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-') }
            : source === 'website'
              ? { landing_url: 'https://www.example.com/contact', referrer: 'https://www.google.com/' }
              : undefined,
      attribution: mapped ? undefined : str(manualPath(source, campaign)),
    };
  };

  const leads = await LeadModel.find({ organizationId }).select('leadSource campaign createdAt assignedCounsellor assignedManager fullName leadNumber').lean();
  const inquiries: Record<string, unknown>[] = [];
  const activities: Record<string, unknown>[] = [];
  const notifications: Record<string, unknown>[] = [];
  const now = Date.now();
  for (const l of leads) {
    const tp = await recordTouchpoint(organizationId, l._id, touchFor(l._id, l.leadSource, l.campaign, l.createdAt));
    const owner = { counsellor: l.assignedCounsellor ?? undefined, manager: l.assignedManager ?? undefined };
    inquiries.push({
      organizationId, leadId: l._id, sequence: 1, isReinquiry: false, channel: tp.origin, occurredAt: l.createdAt, status: 'handled', leadSource: l.leadSource, campaignName: l.campaign ?? undefined,
      provider: tp.provider, campaignExternalId: tp.campaignExternalId, adExternalId: tp.adExternalId, formExternalId: tp.leadFormExternalId,
      utm: { source: tp.normalized?.utm_source, medium: tp.normalized?.utm_medium, campaign: tp.normalized?.utm_campaign },
      source: tp.source, medium: tp.medium, campaign: tp.campaign, touchpointIds: [tp._id], currentOwner: owner, assignment: { action: 'none', reason: 'New lead' }, createdBy: adminId,
    });

    // About one lead in six enquires again later, often through a different channel (same lead, never a duplicate).
    const age = now - l.createdAt.getTime();
    if (age < 10 * DAY || rand() > 0.17) continue;
    const repeats = rand() < 0.3 ? 2 : 1;
    let previous = { source: tp.source, medium: tp.medium, campaign: tp.campaign };
    let last = l.createdAt;
    for (let k = 0; k < repeats; k++) {
      const at = new Date(last.getTime() + (0.25 + rand() * 0.6) * (now - last.getTime()));
      const source = weighted<string>([['meta', 45], ['google', 25], ['website', 20], ['event', 10]]);
      const campaign = CAMPAIGNS[source] ? pick(CAMPAIGNS[source]!) : undefined;
      const rt = await recordTouchpoint(organizationId, l._id, touchFor(l._id, source, campaign, at));
      const recent = now - at.getTime() < 14 * DAY;
      inquiries.push({
        organizationId, leadId: l._id, sequence: k + 2, isReinquiry: true, channel: rt.origin, occurredAt: at, status: recent && rand() < 0.5 ? 'pending_review' : 'handled', leadSource: source, campaignName: campaign,
        provider: rt.provider, campaignExternalId: rt.campaignExternalId, adExternalId: rt.adExternalId, formExternalId: rt.leadFormExternalId,
        utm: { source: rt.normalized?.utm_source, medium: rt.normalized?.utm_medium, campaign: rt.normalized?.utm_campaign },
        source: rt.source, medium: rt.medium, campaign: rt.campaign, previousAttribution: previous, touchpointIds: [rt._id],
        previousOwner: owner, currentOwner: owner, assignment: { policy: 'keep_owner', action: 'kept', reason: owner.counsellor ? 'Kept with the existing counsellor' : 'Kept; lead has no active counsellor' },
        idempotencyKey: `demo:${l._id.toString()}:${k + 2}`, createdBy: adminId,
      });
      activities.push({ organizationId, leadId: l._id, type: 'duplicate_enquiry', title: `Re-inquiry received (inquiry ${k + 2})`, newValue: { leadSource: source, campaign: campaign ?? null }, metadata: { channel: rt.origin }, userId: adminId, occurredAt: at });
      if (owner.counsellor && recent) {
        notifications.push({ organizationId, userId: owner.counsellor, type: 'lead_reinquiry', title: `Re-inquiry: ${l.fullName} (#${l.leadNumber})`, body: `Enquired again via ${source}.`, data: { leadId: l._id.toString() }, readAt: null, createdAt: at, updatedAt: at });
      }
      await LeadModel.updateOne(
        { organizationId, _id: l._id },
        { $inc: { inquiryCount: 1 }, $set: { lastInquiryAt: at, lastInquiryChannel: rt.origin, lastActivityAt: at }, $push: { sourceHistory: { leadSource: source, campaign, at } } },
      );
      previous = { source: rt.source, medium: rt.medium, campaign: rt.campaign };
      last = at;
    }
  }
  await LeadInquiryModel.insertMany(inquiries);
  if (activities.length) await ActivityModel.insertMany(activities);
  if (notifications.length) await NotificationModel.collection.insertMany(notifications);
}

/** A past education fair (registrations = the demo event leads), an upcoming fair and a webinar. */
async function seedEvents(organizationId: Types.ObjectId, adminId: Types.ObjectId, branchId: Types.ObjectId) {
  const DAY = 86_400_000;
  const now = Date.now();
  const at = (days: number, hour: number) => new Date(new Date(now + days * DAY).setHours(hour, 0, 0, 0));
  const [fair] = await EventModel.insertMany([
    { organizationId, eventNumber: 1001, name: 'Delhi Education Fair', eventType: 'education_fair', status: 'completed', mode: 'in_person', startAt: at(-40, 10), endAt: at(-40, 18), venue: { name: 'The Lalit', address: 'Barakhamba Avenue', city: 'New Delhi' }, branchId, countries: ['uk', 'canada', 'australia'], capacity: 400, cost: { amount: 350_000, currency: 'INR' }, createdBy: adminId, ownerId: adminId },
    { organizationId, eventNumber: 1002, name: 'UK Universities Spot Admission Day', eventType: 'spot_admission', status: 'published', mode: 'in_person', startAt: at(12, 11), endAt: at(12, 17), venue: { name: 'Demo Overseas office', city: 'New Delhi' }, branchId, countries: ['uk'], capacity: 80, cost: { amount: 60_000, currency: 'INR' }, publicSlug: randomToken(12), registrationOpen: true, createdBy: adminId, ownerId: adminId },
    { organizationId, eventNumber: 1003, name: 'Study in Canada: PG Diploma Webinar', eventType: 'webinar', status: 'published', mode: 'online', startAt: at(5, 18), endAt: at(5, 19), onlineUrl: 'https://meet.example.com/canada-webinar', countries: ['canada'], publicSlug: randomToken(12), registrationOpen: true, createdBy: adminId, ownerId: adminId },
  ]);
  const leads = await LeadModel.find({ organizationId, leadSource: 'event' }).select('fullName phone email createdAt').lean();
  await EventRegistrationModel.insertMany(
    leads.map((l, i) => ({
      organizationId, eventId: fair!._id, leadId: l._id, fullName: l.fullName, phone: l.phone, email: l.email, source: i % 3 === 0 ? 'walk_in' : 'public_form', newLead: true,
      status: i % 5 === 4 ? 'no_show' : 'attended', registeredAt: l.createdAt, checkedInAt: i % 5 === 4 ? undefined : fair!.startAt, checkedInBy: i % 5 === 4 ? undefined : adminId, createdBy: adminId,
    })),
  );
  await CounterModel.updateOne({ organizationId, key: 'event' }, { $set: { seq: 1003 } }, { upsert: true });
}
