import type { Types } from 'mongoose';
import { FollowUpModel } from '../followups/followup.model.js';
import { LeadModel } from '../leads/lead.model.js';
import { notify } from './notification.service.js';

/**
 * Business events → notifications (mobile spec §33). Callers fire-and-forget: notify() never
 * throws, and the person who caused the event isn't notified about their own action.
 */
type Id = Types.ObjectId | null | undefined;

export async function leadAssigned(organizationId: Types.ObjectId, lead: { _id: Types.ObjectId; leadNumber?: number | null; fullName?: string | null }, to: { counsellor?: Id; manager?: Id }, actor: Id) {
  const title = `New lead assigned: ${lead.fullName ?? 'Lead'}${lead.leadNumber ? ` (#${lead.leadNumber})` : ''}`;
  const data = { leadId: lead._id.toString() };
  if (to.counsellor) await notify(organizationId, [to.counsellor], { type: 'lead_assigned', title, body: 'You are the counsellor for this lead.', data }, { exclude: actor });
  if (to.manager && !to.manager.equals(to.counsellor ?? '')) await notify(organizationId, [to.manager], { type: 'lead_assigned', title, body: 'You are the manager for this lead.', data }, { exclude: actor });
}

/** A known contact enquired again: tell the owner (counsellor, and manager when different). */
export async function leadReinquired(organizationId: Types.ObjectId, lead: { _id: Types.ObjectId; leadNumber?: number | null; fullName?: string | null }, to: { counsellor?: Id; manager?: Id }, detail: { channel: string; count: number }, actor: Id) {
  const title = `Re-inquiry: ${lead.fullName ?? 'Lead'}${lead.leadNumber ? ` (#${lead.leadNumber})` : ''}`;
  const body = `Enquired again via ${detail.channel.replace(/_/g, ' ')} (inquiry ${detail.count}).`;
  await notify(organizationId, [to.counsellor, to.manager], { type: 'lead_reinquiry', title, body, data: { leadId: lead._id.toString() } }, { exclude: actor });
}

export async function leadsBulkAssigned(organizationId: Types.ObjectId, count: number, to: { counsellor?: Id; manager?: Id }, actor: Id) {
  if (!count) return;
  const title = `${count} lead${count === 1 ? '' : 's'} assigned to you`;
  await notify(organizationId, [to.counsellor, to.manager], { type: 'lead_assigned', title, data: { screen: 'Leads' } }, { exclude: actor });
}

export async function incomingCall(organizationId: Types.ObjectId, call: { _id: Types.ObjectId; leadId?: Id; counsellorId?: Id; phoneNumber?: string | null }) {
  if (!call.counsellorId) return;
  const lead = call.leadId ? await LeadModel.findOne({ organizationId, _id: call.leadId }).select('fullName').lean() : null;
  await notify(organizationId, [call.counsellorId], { type: 'incoming_call', title: `Incoming call: ${lead?.fullName ?? call.phoneNumber ?? 'Unknown number'}`, data: { leadId: call.leadId?.toString(), callId: call._id.toString() }, dedupeKey: `incoming:${call._id.toString()}` });
}

export async function missedCall(organizationId: Types.ObjectId, call: { _id: Types.ObjectId; leadId?: Id; counsellorId?: Id; phoneNumber?: string | null }) {
  if (!call.counsellorId) return;
  const lead = call.leadId ? await LeadModel.findOne({ organizationId, _id: call.leadId }).select('fullName').lean() : null;
  await notify(organizationId, [call.counsellorId], { type: 'missed_call', title: `Missed call from ${lead?.fullName ?? call.phoneNumber ?? 'unknown number'}`, body: 'Call back from the lead page.', data: { leadId: call.leadId?.toString(), callId: call._id.toString() }, dedupeKey: `missed:${call._id.toString()}` });
}

interface AppRef {
  _id: Types.ObjectId;
  applicationNumber?: number | null;
  studentName?: string | null;
  studentId?: Id;
  leadId?: Id;
  assignedCounsellor?: Id;
  assignedTo?: Id;
}

export async function applicationUpdated(organizationId: Types.ObjectId, app: AppRef, statusLabel: string, actor: Id) {
  await notify(organizationId, [app.assignedCounsellor, app.assignedTo], { type: 'application_update', title: `A-${app.applicationNumber} (${app.studentName ?? 'student'}): ${statusLabel}`, data: { applicationId: app._id.toString(), studentId: app.studentId?.toString(), leadId: app.leadId?.toString() } }, { exclude: actor });
}

export async function offerReceived(organizationId: Types.ObjectId, app: AppRef, offerLabel: string, actor: Id) {
  await notify(organizationId, [app.assignedCounsellor, app.assignedTo], { type: 'offer_received', title: `${offerLabel}: ${app.studentName ?? 'student'} (A-${app.applicationNumber})`, data: { applicationId: app._id.toString(), studentId: app.studentId?.toString(), leadId: app.leadId?.toString() } }, { exclude: actor });
}

export async function paymentReceived(organizationId: Types.ObjectId, p: { _id: Types.ObjectId; amount: number; currency: string; studentId?: Id; leadId?: Id; assignedCounsellor?: Id }, studentName: string | null | undefined, actor: Id) {
  await notify(organizationId, [p.assignedCounsellor], { type: 'payment_received', title: `Payment received: ${p.currency} ${p.amount.toLocaleString('en-IN')}`, body: studentName ? `From ${studentName}` : undefined, data: { studentId: p.studentId?.toString(), leadId: p.leadId?.toString(), paymentId: p._id.toString() }, dedupeKey: `payment:${p._id.toString()}` }, { exclude: actor });
}

export async function documentRejected(organizationId: Types.ObjectId, doc: { _id: Types.ObjectId; studentId?: Id; leadId?: Id; assignedCounsellor?: Id }, label: string, reason: string | null | undefined, actor: Id) {
  await notify(organizationId, [doc.assignedCounsellor], { type: 'document_rejected', title: `Document needs attention: ${label}`, body: reason ?? undefined, data: { studentId: doc.studentId?.toString(), leadId: doc.leadId?.toString(), documentId: doc._id.toString() } }, { exclude: actor });
}

/**
 * Every few minutes (cross-tenant): "due in the next 15 minutes" and "now overdue" reminders, each
 * sent once per follow-up. Overdue reminders only for follow-ups that became overdue in the last
 * two days, so turning this on doesn't flood people with historic items.
 */
export async function followUpReminders(now = new Date()) {
  const soon = new Date(now.getTime() + 15 * 60_000);
  const due = await FollowUpModel.find({ status: 'pending', dueAt: { $gte: now, $lte: soon }, remindedAt: null, assignedTo: { $ne: null } }).setOptions({ skipTenantGuard: true }).limit(1000).lean();
  const overdue = await FollowUpModel.find({ status: 'pending', dueAt: { $lt: now, $gte: new Date(now.getTime() - 2 * 86_400_000) }, overdueNotifiedAt: null, assignedTo: { $ne: null } }).setOptions({ skipTenantGuard: true }).limit(1000).lean();
  const leadName = async (f: { organizationId: Types.ObjectId; leadId: Types.ObjectId }) => (await LeadModel.findOne({ organizationId: f.organizationId, _id: f.leadId }).select('fullName').lean())?.fullName ?? 'a lead';
  for (const f of due) {
    const mins = Math.max(1, Math.round((f.dueAt.getTime() - now.getTime()) / 60_000));
    await notify(f.organizationId, [f.assignedTo], { type: 'followup_due', title: `Follow-up in ${mins} min: ${await leadName(f)}`, body: f.nextAction ?? undefined, data: { leadId: f.leadId.toString(), followUpId: f._id.toString(), type: 'followup_due' }, dedupeKey: `followup_due:${f._id.toString()}` });
    await FollowUpModel.updateOne({ organizationId: f.organizationId, _id: f._id }, { remindedAt: now });
  }
  for (const f of overdue) {
    await notify(f.organizationId, [f.assignedTo], { type: 'followup_overdue', title: `Overdue follow-up: ${await leadName(f)}`, body: f.nextAction ?? undefined, data: { leadId: f.leadId.toString(), followUpId: f._id.toString(), type: 'followup_overdue' }, dedupeKey: `followup_overdue:${f._id.toString()}` });
    await FollowUpModel.updateOne({ organizationId: f.organizationId, _id: f._id }, { overdueNotifiedAt: now });
  }
  return { due: due.length, overdue: overdue.length };
}
