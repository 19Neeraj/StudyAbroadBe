import { Types } from 'mongoose';
import { z } from '../../docs/zod.js';
import type { ServiceContext } from '../../types/auth.js';
import { ownershipScope } from '../../utils/access.js';
import { ApiError } from '../../utils/ApiError.js';
import { idParams, objectIdString } from '../../utils/objectId.js';
import { buildPagination, paginationQuery, sortQuery, toPaging, toSort } from '../../utils/pagination.js';
import { createModuleRouter } from '../../utils/router.js';
import { addDays } from '../../utils/time.js';
import { logActivity } from '../activities/activity.service.js';
import { recordAudit } from '../audit/audit.service.js';
import { ApplicationModel, VISA_STATUSES } from '../applications/application.model.js';
import { resolveAssignee } from '../leads/lead.assignment.js';
import { advanceLeadToMilestone } from '../leads/lead.progress.js';
import { VisaModel } from './visa.model.js';

const date = z.coerce.date();
const fields = {
  visaType: z.string().trim().max(100).optional(),
  submissionDate: date.optional(),
  appointmentDate: date.optional(),
  appointmentLocation: z.string().trim().max(200).optional(),
  decisionDate: date.optional(),
  visaExpiryDate: date.optional(),
  rejectionReason: z.string().trim().max(2000).optional(),
  remarks: z.string().trim().max(5000).optional(),
  assignedTo: objectIdString.optional(),
};
const createVisaBody = z.object({ applicationId: objectIdString, status: z.enum(VISA_STATUSES).optional(), ...fields }).openapi('CreateVisaCaseRequest');
const updateVisaBody = z.object({ status: z.enum(VISA_STATUSES).optional(), ...fields }).openapi('UpdateVisaCaseRequest');
const visaListQuery = paginationQuery.extend({
  sortBy: sortQuery(['updatedAt', 'appointmentDate', 'createdAt'], 'updatedAt'),
  status: z.string().transform((v) => v.split(',').filter(Boolean)).optional(),
  studentId: objectIdString.optional(),
  applicationId: objectIdString.optional(),
  assignedTo: z.union([objectIdString, z.literal('me')]).optional(),
  appointmentWithinDays: z.coerce.number().int().min(0).max(365).optional(),
});

const populate = (ctx: ServiceContext) => {
  const match = { organizationId: ctx.organizationId };
  return [
    { path: 'studentId', select: 'fullName studentNumber', match },
    { path: 'applicationId', select: 'applicationNumber courseName intake universityId', match, populate: { path: 'universityId', select: 'name', match } },
    { path: 'assignedTo', select: 'fullName', match },
  ];
};
const dto = ({ studentId, applicationId, __v: _v, ...v }: Record<string, unknown>) => ({ ...v, student: studentId ?? null, application: applicationId ?? null });

async function getVisa(ctx: ServiceContext, id: string | Types.ObjectId) {
  if (!Types.ObjectId.isValid(id)) throw ApiError.notFound('Visa case');
  const v = await VisaModel.findOne(ownershipScope(ctx, { _id: new Types.ObjectId(id) })).populate(populate(ctx)).lean();
  if (!v) throw ApiError.notFound('Visa case');
  return dto(v as never);
}

const TITLES: Record<string, string> = {
  documents_pending: 'Visa documents pending',
  submitted: 'Visa application submitted',
  appointment_scheduled: 'Visa appointment scheduled',
  under_process: 'Visa under process',
  approved: 'Visa approved',
  rejected: 'Visa rejected',
  withdrawn: 'Visa application withdrawn',
};

async function afterStatus(ctx: ServiceContext, v: { _id: Types.ObjectId; leadId: Types.ObjectId; studentId: Types.ObjectId; applicationId: Types.ObjectId; status: string }, previous: string | null) {
  await ApplicationModel.updateOne({ organizationId: ctx.organizationId, _id: v.applicationId }, { visaStatus: v.status });
  if (previous !== v.status) {
    await logActivity(ctx, { leadId: v.leadId, studentId: v.studentId, type: 'visa_updated', title: TITLES[v.status] ?? 'Visa updated', previousValue: previous, newValue: v.status, metadata: { visaCaseId: v._id.toString() } });
  }
  if (['submitted', 'appointment_scheduled', 'under_process', 'approved'].includes(v.status)) await advanceLeadToMilestone(ctx, v.leadId, 'visa', TITLES[v.status] ?? 'Visa in progress');
}

const m = createModuleRouter('/visa', 'Visa');

m.route({
  method: 'get',
  path: '/',
  summary: 'Visa cases (status, assignee, upcoming appointments)',
  permissions: ['visa.view'],
  query: visaListQuery,
  paginated: true,
  handler: async ({ ctx, query: q }) => {
    const and: Record<string, unknown>[] = [];
    if (q.status?.length) and.push({ status: { $in: q.status } });
    if (q.studentId) and.push({ studentId: new Types.ObjectId(q.studentId) });
    if (q.applicationId) and.push({ applicationId: new Types.ObjectId(q.applicationId) });
    if (q.assignedTo) and.push({ assignedTo: q.assignedTo === 'me' ? ctx.userId : new Types.ObjectId(q.assignedTo) });
    if (q.appointmentWithinDays !== undefined) and.push({ appointmentDate: { $gte: new Date(), $lte: addDays(new Date(), q.appointmentWithinDays) } });
    const filter = ownershipScope(ctx, and.length ? { $and: and } : {});
    const { skip, limit } = toPaging(q);
    const [items, total] = await Promise.all([
      VisaModel.find(filter).sort(toSort(q.sortBy, q.sortOrder)).skip(skip).limit(limit).populate(populate(ctx)).lean(),
      VisaModel.countDocuments(filter),
    ]);
    return { data: items.map((v) => dto(v as never)), pagination: buildPagination(q.page, q.limit, total) };
  },
});

m.route({
  method: 'post',
  path: '/',
  summary: 'Open a visa case for an application',
  permissions: ['visa.manage'],
  body: createVisaBody,
  successStatus: 201,
  handler: async ({ ctx, body }) => {
    const app = await ApplicationModel.findOne(ownershipScope(ctx, { _id: new Types.ObjectId(body.applicationId), deletedAt: null })).lean();
    if (!app) throw ApiError.validation([{ field: 'body.applicationId', message: 'Application not found' }]);
    const assignedTo = body.assignedTo ? (await resolveAssignee(ctx, body.assignedTo, 'assignedTo'))._id : undefined;
    let visa;
    try {
      visa = await VisaModel.create({
        ...body,
        assignedTo,
        organizationId: ctx.organizationId,
        studentId: app.studentId,
        leadId: app.leadId,
        branchId: app.branchId,
        assignedCounsellor: app.assignedCounsellor,
        assignedManager: app.assignedManager,
        country: app.country,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      });
    } catch (err) {
      if (typeof err === 'object' && err && 'code' in err && err.code === 11000) throw ApiError.conflict('This application already has a visa case');
      throw err;
    }
    await recordAudit(ctx, { entityType: 'visa', entityId: visa._id, action: 'visa.created', newValue: { status: visa.status } });
    await afterStatus(ctx, visa, null);
    return { message: 'Visa case opened', data: await getVisa(ctx, visa._id) };
  },
});

m.route({ method: 'get', path: '/:id', summary: 'Visa case details', permissions: ['visa.view'], params: idParams, handler: async ({ ctx, params }) => ({ data: await getVisa(ctx, params.id) }) });

m.route({
  method: 'patch',
  path: '/:id',
  summary: 'Update a visa case (status changes are logged on the student timeline)',
  permissions: ['visa.manage'],
  params: idParams,
  body: updateVisaBody,
  handler: async ({ ctx, params, body }) => {
    const visa = await VisaModel.findOne(ownershipScope(ctx, { _id: new Types.ObjectId(params.id) }));
    if (!visa) throw ApiError.notFound('Visa case');
    if (body.status === 'rejected' && !body.rejectionReason && !visa.rejectionReason) throw ApiError.validation([{ field: 'body.rejectionReason', message: 'Add the rejection reason' }]);
    const previous = visa.status;
    const changes: Record<string, unknown> = { ...body };
    if (body.assignedTo) changes.assignedTo = (await resolveAssignee(ctx, body.assignedTo, 'assignedTo'))._id;
    if ((body.status === 'approved' || body.status === 'rejected') && !body.decisionDate && !visa.decisionDate) changes.decisionDate = new Date();
    for (const [k, v] of Object.entries(changes)) if (v !== undefined) visa.set(k, v);
    visa.updatedBy = ctx.userId;
    await visa.save();
    await recordAudit(ctx, { entityType: 'visa', entityId: visa._id, action: 'visa.updated', oldValue: { status: previous }, newValue: { status: visa.status }, metadata: { fields: Object.keys(body) } });
    await afterStatus(ctx, visa, previous);
    return { message: 'Visa case updated', data: await getVisa(ctx, visa._id) };
  },
});

export const visaModule = m;
