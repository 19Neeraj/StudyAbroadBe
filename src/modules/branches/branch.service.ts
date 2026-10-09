import type { ServiceContext } from '../../types/auth.js';
import { accessibleBranchIds } from '../../utils/access.js';
import { ApiError } from '../../utils/ApiError.js';
import { buildPagination, escapeRegex, toPaging, toSort } from '../../utils/pagination.js';
import { diffFields, recordAudit } from '../audit/audit.service.js';
import { BranchModel } from './branch.model.js';
import type { z } from '../../docs/zod.js';
import type { BranchListQuery, createBranchBody, updateBranchBody } from './branch.validation.js';

const PUBLIC_FIELDS = '-__v -organizationId -createdBy -updatedBy';

function scopedFilter(ctx: ServiceContext): Record<string, unknown> {
  const filter: Record<string, unknown> = { organizationId: ctx.organizationId };
  const allowed = accessibleBranchIds(ctx);
  if (allowed) filter._id = { $in: allowed };
  return filter;
}

export async function listBranches(ctx: ServiceContext, q: BranchListQuery) {
  const filter = scopedFilter(ctx);
  if (q.isActive !== undefined) filter.isActive = q.isActive;
  if (q.search) {
    const rx = new RegExp(escapeRegex(q.search), 'i');
    filter.$or = [{ name: rx }, { code: rx }, { city: rx }];
  }
  const { skip, limit } = toPaging(q);
  const [items, total] = await Promise.all([
    BranchModel.find(filter)
      .select(PUBLIC_FIELDS)
      .sort(toSort(q.sortBy, q.sortOrder))
      .skip(skip)
      .limit(limit)
      .lean(),
    BranchModel.countDocuments(filter),
  ]);
  return { items, pagination: buildPagination(q.page, q.limit, total) };
}

export async function getBranch(ctx: ServiceContext, id: string) {
  const branch = await BranchModel.findOne({ ...scopedFilter(ctx), _id: id })
    .select(PUBLIC_FIELDS)
    .lean();
  if (!branch) throw ApiError.notFound('Branch');
  return branch;
}

export async function createBranch(ctx: ServiceContext, input: z.infer<typeof createBranchBody>) {
  const branch = await BranchModel.create({
    ...input,
    organizationId: ctx.organizationId,
    createdBy: ctx.userId,
    updatedBy: ctx.userId,
  });
  await recordAudit(ctx, {
    entityType: 'branch',
    entityId: branch._id,
    action: 'branch.created',
    newValue: input,
  });
  return getBranch(ctx, branch._id.toString());
}

export async function updateBranch(
  ctx: ServiceContext,
  id: string,
  input: z.infer<typeof updateBranchBody>,
) {
  const before = await getBranch(ctx, id);
  const normalized = { ...input, ...(input.code ? { code: input.code.toUpperCase() } : {}) };
  await BranchModel.updateOne(
    { organizationId: ctx.organizationId, _id: id },
    { ...normalized, updatedBy: ctx.userId },
    { runValidators: true },
  );
  const changes = diffFields(before, normalized);
  if (changes)
    await recordAudit(ctx, {
      entityType: 'branch',
      entityId: before._id,
      action: 'branch.updated',
      ...changes,
    });
  return getBranch(ctx, id);
}

export async function setBranchActive(ctx: ServiceContext, id: string, isActive: boolean) {
  const before = await getBranch(ctx, id);
  if (before.isActive === isActive) return before;
  await BranchModel.updateOne(
    { organizationId: ctx.organizationId, _id: id },
    { isActive, updatedBy: ctx.userId },
  );
  await recordAudit(ctx, {
    entityType: 'branch',
    entityId: before._id,
    action: isActive ? 'branch.activated' : 'branch.deactivated',
    oldValue: { isActive: before.isActive },
    newValue: { isActive },
  });
  return getBranch(ctx, id);
}
