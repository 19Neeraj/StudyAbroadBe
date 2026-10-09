import type { Types } from 'mongoose';
import { defaultLookups, LOOKUP_TYPES, type LookupType } from '../../constants/lookups.js';
import type { z } from '../../docs/zod.js';
import { zodToFieldErrors } from '../../middlewares/error.middleware.js';
import type { ServiceContext } from '../../types/auth.js';
import { ApiError } from '../../utils/ApiError.js';
import { slugify } from '../../utils/normalize.js';
import { diffFields, recordAudit } from '../audit/audit.service.js';
import { LookupModel } from './lookup.model.js';
import {
  LOOKUP_META_SCHEMAS,
  type createLookupBody,
  type updateLookupBody,
} from './lookup.validation.js';

const PUBLIC_FIELDS = 'type key label order color isActive isSystem meta';

function validateMeta(type: LookupType, meta: Record<string, unknown> | undefined) {
  const schema = LOOKUP_META_SCHEMAS[type];
  if (!schema) return meta ?? {};
  const result = schema.safeParse(meta ?? {});
  if (!result.success) throw ApiError.validation(zodToFieldErrors(result.error, 'body.meta'));
  return result.data;
}

/** Seeds every lookup type for a new organization. */
export async function seedLookups(organizationId: Types.ObjectId): Promise<void> {
  const defaults = defaultLookups();
  const docs = LOOKUP_TYPES.flatMap((type) =>
    defaults[type].map((item, index) => ({
      organizationId,
      type,
      key: item.key ?? slugify(item.label),
      label: item.label,
      order: (index + 1) * 10,
      color: item.color,
      isSystem: item.system ?? false,
      meta: validateMeta(type, item.meta),
    })),
  );
  await LookupModel.insertMany(docs, { ordered: false });
}

/** Adds the default values of a lookup type an organization doesn't have yet (used by migrations). */
export async function seedMissingLookupType(organizationId: Types.ObjectId, type: LookupType): Promise<number> {
  if (await LookupModel.exists({ organizationId, type })) return 0;
  const items = defaultLookups()[type];
  await LookupModel.insertMany(
    items.map((item, index) => ({
      organizationId,
      type,
      key: item.key ?? slugify(item.label),
      label: item.label,
      order: (index + 1) * 10,
      color: item.color,
      isSystem: item.system ?? false,
      meta: validateMeta(type, item.meta),
    })),
    { ordered: false },
  );
  return items.length;
}

export async function listLookups(ctx: ServiceContext, type: LookupType, includeInactive: boolean) {
  return LookupModel.find({
    organizationId: ctx.organizationId,
    type,
    ...(includeInactive ? {} : { isActive: true }),
  })
    .select(PUBLIC_FIELDS)
    .sort({ order: 1, label: 1 })
    .lean();
}

/** All requested types in one round trip, grouped by type — used by clients to populate forms. */
export async function listLookupGroups(
  ctx: ServiceContext,
  types: LookupType[] | undefined,
  includeInactive: boolean,
) {
  const wanted = types?.length ? types : [...LOOKUP_TYPES];
  const items = await LookupModel.find({
    organizationId: ctx.organizationId,
    type: { $in: wanted },
    ...(includeInactive ? {} : { isActive: true }),
  })
    .select(PUBLIC_FIELDS)
    .sort({ type: 1, order: 1, label: 1 })
    .lean();
  const groups = Object.fromEntries(wanted.map((t) => [t, [] as typeof items]));
  for (const item of items) groups[item.type]?.push(item);
  return groups;
}

async function getLookup(ctx: ServiceContext, type: LookupType, id: string) {
  const item = await LookupModel.findOne({ organizationId: ctx.organizationId, type, _id: id })
    .select(PUBLIC_FIELDS)
    .lean();
  if (!item) throw ApiError.notFound('Setting value');
  return item;
}

export async function createLookup(
  ctx: ServiceContext,
  type: LookupType,
  input: z.infer<typeof createLookupBody>,
) {
  const key = input.key ?? slugify(input.label);
  if (!key)
    throw ApiError.validation([
      { field: 'body.label', message: 'Label must contain letters or digits' },
    ]);
  let order = input.order;
  if (order === undefined) {
    const last = await LookupModel.findOne({ organizationId: ctx.organizationId, type })
      .sort({ order: -1 })
      .select('order')
      .lean();
    order = (last?.order ?? 0) + 10;
  }
  try {
    const item = await LookupModel.create({
      organizationId: ctx.organizationId,
      type,
      key,
      label: input.label,
      color: input.color,
      order,
      meta: validateMeta(type, input.meta),
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
    });
    await recordAudit(ctx, {
      entityType: 'setting',
      entityId: item._id,
      action: 'setting.created',
      newValue: { type, key, label: input.label },
    });
    return getLookup(ctx, type, item._id.toString());
  } catch (err) {
    if (typeof err === 'object' && err && 'code' in err && err.code === 11000) {
      throw ApiError.conflict(`A value with key "${key}" already exists`, [
        { field: 'body.key', message: 'Already exists' },
      ]);
    }
    throw err;
  }
}

export async function updateLookup(
  ctx: ServiceContext,
  type: LookupType,
  id: string,
  input: z.infer<typeof updateLookupBody>,
) {
  const before = await getLookup(ctx, type, id);
  if (before.isSystem && input.isActive === false) {
    throw ApiError.badRequest(
      'This value is used by CRM workflows and cannot be deactivated; you can rename it instead',
    );
  }
  const update: Record<string, unknown> = { ...input, updatedBy: ctx.userId };
  if (input.meta)
    update.meta = validateMeta(type, {
      ...(before.meta as Record<string, unknown>),
      ...input.meta,
    });
  if (input.color === null) {
    delete update.color;
    update.$unset = { color: 1 };
  }
  await LookupModel.updateOne({ organizationId: ctx.organizationId, type, _id: id }, update);
  const changes = diffFields(before, input);
  if (changes)
    await recordAudit(ctx, {
      entityType: 'setting',
      entityId: before._id,
      action: 'setting.updated',
      metadata: { type, key: before.key },
      ...changes,
    });
  return getLookup(ctx, type, id);
}

export async function reorderLookups(ctx: ServiceContext, type: LookupType, ids: string[]) {
  const count = await LookupModel.countDocuments({
    organizationId: ctx.organizationId,
    type,
    _id: { $in: ids },
  });
  if (count !== new Set(ids).size)
    throw ApiError.validation([
      { field: 'body.ids', message: 'One or more ids do not belong to this type' },
    ]);
  await LookupModel.bulkWrite(
    ids.map((id, index) => ({
      updateOne: {
        filter: { organizationId: ctx.organizationId, type, _id: id },
        update: { order: (index + 1) * 10, updatedBy: ctx.userId },
      },
    })),
  );
  await recordAudit(ctx, {
    entityType: 'setting',
    action: 'setting.reordered',
    metadata: { type },
    newValue: ids,
  });
  return listLookups(ctx, type, true);
}

/**
 * Validates that values reference active lookups of the organization.
 * `fields` maps a request field (for error messages) to its lookup type and value.
 */
export async function assertLookupValues(
  ctx: Pick<ServiceContext, 'organizationId'>,
  fields: Record<string, { type: LookupType; value: string | null | undefined }>,
): Promise<void> {
  const wanted = Object.entries(fields).filter(([, f]) => f.value);
  if (!wanted.length) return;
  const found = await LookupModel.find({
    organizationId: ctx.organizationId,
    isActive: true,
    $or: wanted.map(([, f]) => ({ type: f.type, key: f.value })),
  })
    .select('type key')
    .lean();
  const ok = new Set(found.map((l) => `${l.type}:${l.key}`));
  const errors = wanted
    .filter(([, f]) => !ok.has(`${f.type}:${f.value}`))
    .map(([field, f]) => ({ field: `body.${field}`, message: `Unknown or inactive ${f.type.replace(/_/g, ' ')} "${f.value}"` }));
  if (errors.length) throw ApiError.validation(errors);
}

/** Lookup metadata by key for one type (e.g. which statuses are closed). */
export async function lookupMetaByKey(ctx: Pick<ServiceContext, 'organizationId'>, type: LookupType) {
  const items = await LookupModel.find({ organizationId: ctx.organizationId, type }).select('key label meta').lean();
  return new Map(items.map((i) => [i.key, { label: i.label, meta: (i.meta ?? {}) as Record<string, unknown> }]));
}
