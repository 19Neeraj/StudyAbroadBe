import * as triggers from '../notifications/triggers.js';
import { Types } from 'mongoose';
import { z } from '../../docs/zod.js';
import type { ServiceContext } from '../../types/auth.js';
import { ownershipScope } from '../../utils/access.js';
import { ApiError } from '../../utils/ApiError.js';
import { objectIdString } from '../../utils/objectId.js';
import { buildPagination, paginationQuery, sortQuery, toPaging, toSort } from '../../utils/pagination.js';
import { emitTo, rooms } from '../../sockets/index.js';
import { logActivity } from '../activities/activity.service.js';
import { recordAudit } from '../audit/audit.service.js';
import { ApplicationModel } from '../applications/application.model.js';
import { nextSequence } from '../counters/counter.model.js';
import { advanceLeadToMilestone } from '../leads/lead.progress.js';
import { getOrgSettings } from '../organizations/orgSettings.js';
import { loadStudent } from '../students/student.service.js';
import { PAYMENT_METHODS, PAYMENT_PURPOSES, PAYMENT_STATES, PaymentModel } from './payment.model.js';

const money = z.number().positive().max(1e10);
const csv = z.string().transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean));

export const createPaymentBody = z
  .object({
    studentId: objectIdString,
    applicationId: objectIdString.optional(),
    purpose: z.enum(PAYMENT_PURPOSES),
    amount: money,
    currency: z.string().trim().length(3).toUpperCase().optional().openapi({ description: 'Defaults to the organization currency' }),
    paymentMethod: z.enum(PAYMENT_METHODS).optional(),
    paymentStatus: z.enum(PAYMENT_STATES).default('pending'),
    transactionId: z.string().trim().max(100).optional(),
    dueDate: z.coerce.date().optional(),
    paymentDate: z.coerce.date().optional(),
    remarks: z.string().trim().max(2000).optional(),
  })
  .openapi('CreatePaymentRequest');

export const updatePaymentBody = z
  .object({
    amount: money.optional(),
    paymentMethod: z.enum(PAYMENT_METHODS).optional(),
    paymentStatus: z.enum(PAYMENT_STATES).optional(),
    transactionId: z.string().trim().max(100).nullable().optional(),
    dueDate: z.coerce.date().nullable().optional(),
    paymentDate: z.coerce.date().nullable().optional(),
    remarks: z.string().trim().max(2000).nullable().optional(),
  })
  .openapi('UpdatePaymentRequest');

export const paymentListQuery = paginationQuery.extend({
  sortBy: sortQuery(['createdAt', 'paymentDate', 'dueDate', 'amount'], 'createdAt'),
  studentId: objectIdString.optional(),
  applicationId: objectIdString.optional(),
  status: csv.optional(),
  purpose: csv.optional(),
  counsellor: objectIdString.optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  overdue: z.enum(['true']).optional(),
});

const populate = (ctx: ServiceContext) => [
  { path: 'studentId', select: 'fullName studentNumber', match: { organizationId: ctx.organizationId } },
  { path: 'applicationId', select: 'applicationNumber universityId courseName', match: { organizationId: ctx.organizationId }, populate: { path: 'universityId', select: 'name', match: { organizationId: ctx.organizationId } } },
  { path: 'createdBy', select: 'fullName', match: { organizationId: ctx.organizationId } },
];
const dto = ({ studentId, applicationId, __v: _v, ...p }: Record<string, unknown>) => ({ ...p, student: studentId ?? null, application: applicationId ?? null });

/** Application payment status from its payments: any success → paid; open ones → pending. */
async function refreshApplicationPaymentStatus(organizationId: Types.ObjectId, applicationId: Types.ObjectId | null | undefined) {
  if (!applicationId) return;
  const payments = await PaymentModel.find({ organizationId, applicationId }).select('paymentStatus').lean();
  const has = (s: string) => payments.some((p) => p.paymentStatus === s);
  const status = has('success') ? 'paid' : has('pending') || has('initiated') ? 'pending' : payments.length && payments.every((p) => p.paymentStatus === 'refunded') ? 'refunded' : 'not_due';
  await ApplicationModel.updateOne({ organizationId, _id: applicationId }, { paymentStatus: status });
}

export async function getPayment(ctx: ServiceContext, id: string | Types.ObjectId) {
  if (!Types.ObjectId.isValid(id)) throw ApiError.notFound('Payment');
  const p = await PaymentModel.findOne(ownershipScope(ctx, { _id: new Types.ObjectId(id) })).populate(populate(ctx)).lean();
  if (!p) throw ApiError.notFound('Payment');
  return dto(p as never);
}

export async function createPayment(ctx: ServiceContext, input: z.infer<typeof createPaymentBody>) {
  const student = await loadStudent(ctx, input.studentId);
  if (input.applicationId) {
    const ok = await ApplicationModel.exists({ organizationId: ctx.organizationId, _id: input.applicationId, studentId: student._id });
    if (!ok) throw ApiError.validation([{ field: 'body.applicationId', message: 'Application not found for this student' }]);
  }
  const currency = input.currency ?? (await getOrgSettings(ctx.organizationId)).currency;
  const payment = await PaymentModel.create({
    ...input,
    currency,
    organizationId: ctx.organizationId,
    paymentNumber: await nextSequence(ctx.organizationId, 'payment'),
    studentId: student._id,
    leadId: student.leadId,
    branchId: student.branchId,
    assignedCounsellor: student.assignedCounsellor,
    assignedManager: student.assignedManager,
    paymentDate: input.paymentDate ?? (input.paymentStatus === 'success' ? new Date() : undefined),
    createdBy: ctx.userId,
    updatedBy: ctx.userId,
  });
  await logActivity(ctx, {
    leadId: student.leadId,
    studentId: student._id,
    type: 'payment_recorded',
    title: input.paymentStatus === 'success' ? `Payment received · ${currency} ${input.amount.toLocaleString('en-IN')}` : `Payment ${input.paymentStatus} · ${currency} ${input.amount.toLocaleString('en-IN')}`,
    newValue: { amount: input.amount, currency, purpose: input.purpose, status: input.paymentStatus },
    metadata: { paymentId: payment._id.toString(), applicationId: input.applicationId ?? null },
  });
  await recordAudit(ctx, { entityType: 'payment', entityId: payment._id, action: 'payment.created', newValue: { amount: input.amount, currency, status: input.paymentStatus, purpose: input.purpose } });
  await refreshApplicationPaymentStatus(ctx.organizationId, payment.applicationId);
  if (['tuition_deposit', 'tuition_fee'].includes(input.purpose)) await advanceLeadToMilestone(ctx, student.leadId, 'payment', `Tuition payment recorded`);
  if (input.paymentStatus === 'success' && student.assignedCounsellor) emitTo([rooms.user(student.assignedCounsellor.toString())], 'payment.updated', { paymentId: payment._id.toString(), status: 'success' });
  if (input.paymentStatus === 'success') await triggers.paymentReceived(ctx.organizationId, payment, student.fullName, ctx.userId);
  return getPayment(ctx, payment._id);
}

export async function updatePayment(ctx: ServiceContext, id: string, input: z.infer<typeof updatePaymentBody>) {
  if (!Types.ObjectId.isValid(id)) throw ApiError.notFound('Payment');
  const payment = await PaymentModel.findOne(ownershipScope(ctx, { _id: new Types.ObjectId(id) }));
  if (!payment) throw ApiError.notFound('Payment');
  const before = { amount: payment.amount, paymentStatus: payment.paymentStatus, transactionId: payment.transactionId };
  for (const [k, v] of Object.entries(input)) if (v !== undefined) payment.set(k, v === null ? undefined : v);
  if (input.paymentStatus === 'success' && !payment.paymentDate) payment.paymentDate = new Date();
  payment.updatedBy = ctx.userId;
  await payment.save();
  if (input.paymentStatus && input.paymentStatus !== before.paymentStatus) {
    await logActivity(ctx, {
      leadId: payment.leadId,
      studentId: payment.studentId,
      type: 'payment_updated',
      title: input.paymentStatus === 'success' ? `Payment received · ${payment.currency} ${payment.amount.toLocaleString('en-IN')}` : `Payment ${input.paymentStatus}`,
      previousValue: before.paymentStatus,
      newValue: input.paymentStatus,
      metadata: { paymentId: payment._id.toString() },
    });
    if (payment.assignedCounsellor) emitTo([rooms.user(payment.assignedCounsellor.toString())], 'payment.updated', { paymentId: payment._id.toString(), status: input.paymentStatus });
    if (input.paymentStatus === 'success') await triggers.paymentReceived(ctx.organizationId, payment, null, ctx.userId);
  }
  // Financial records: every change is audited with before/after values.
  await recordAudit(ctx, { entityType: 'payment', entityId: payment._id, action: 'payment.updated', oldValue: before, newValue: { amount: payment.amount, paymentStatus: payment.paymentStatus, transactionId: payment.transactionId } });
  await refreshApplicationPaymentStatus(ctx.organizationId, payment.applicationId);
  return getPayment(ctx, payment._id);
}

export async function listPayments(ctx: ServiceContext, q: z.infer<typeof paymentListQuery>) {
  const and: Record<string, unknown>[] = [];
  if (q.studentId) and.push({ studentId: new Types.ObjectId(q.studentId) });
  if (q.applicationId) and.push({ applicationId: new Types.ObjectId(q.applicationId) });
  if (q.status?.length) and.push({ paymentStatus: { $in: q.status } });
  if (q.purpose?.length) and.push({ purpose: { $in: q.purpose } });
  if (q.counsellor) and.push({ assignedCounsellor: new Types.ObjectId(q.counsellor) });
  if (q.dateFrom || q.dateTo) and.push({ paymentDate: { ...(q.dateFrom ? { $gte: q.dateFrom } : {}), ...(q.dateTo ? { $lte: q.dateTo } : {}) } });
  if (q.overdue) and.push({ paymentStatus: { $in: ['pending', 'initiated'] }, dueDate: { $lt: new Date() } });
  const filter = ownershipScope(ctx, and.length ? { $and: and } : {});
  const { skip, limit } = toPaging(q);
  const [items, total, totals] = await Promise.all([
    PaymentModel.find(filter).sort(toSort(q.sortBy, q.sortOrder)).skip(skip).limit(limit).populate(populate(ctx)).lean(),
    PaymentModel.countDocuments(filter),
    PaymentModel.aggregate<{ _id: { status: string; currency: string }; amount: number }>([{ $match: filter }, { $group: { _id: { status: '$paymentStatus', currency: '$currency' }, amount: { $sum: '$amount' } } }]),
  ]);
  return {
    items: items.map((p) => dto(p as never)),
    pagination: buildPagination(q.page, q.limit, total),
    totals: totals.map((t) => ({ status: t._id.status, currency: t._id.currency, amount: t.amount })),
  };
}
