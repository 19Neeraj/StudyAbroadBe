import { Schema, type Aggregate, type MongooseDefaultQueryMiddleware, type Query } from 'mongoose';

// Includes updateOne/deleteOne, which Mongoose registers as query (not document) middleware by default.
const GUARDED_QUERY_OPS: MongooseDefaultQueryMiddleware[] = [
  'find',
  'findOne',
  'countDocuments',
  'distinct',
  'findOneAndUpdate',
  'findOneAndDelete',
  'findOneAndReplace',
  'replaceOne',
  'updateMany',
  'deleteMany',
  'updateOne',
  'deleteOne',
];

export class TenantGuardError extends Error {
  constructor(model: string, op: string) {
    super(`Tenant guard: ${model}.${op}() was called without an organizationId filter`);
    this.name = 'TenantGuardError';
  }
}

/** Spread into every tenant-owned schema definition (kept explicit so types infer it). */
export const tenantField = {
  organizationId: {
    type: Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    immutable: true,
  },
} as const;

/**
 * Requires `organizationId` on a schema and refuses to run any query that does not filter on it.
 * This is a safety net: services must always scope by the organization from the auth context.
 * Deliberate cross-tenant queries (platform jobs) opt out with `.setOptions({ skipTenantGuard: true })`.
 */
export function tenantPlugin(schema: Schema): void {
  if (!schema.path('organizationId')) {
    throw new Error('tenantPlugin: schema must include ...tenantField');
  }

  function guard(this: Query<unknown, unknown>) {
    if (this.getOptions().skipTenantGuard) return;
    if (!this.getFilter().organizationId) {
      const op = (this as unknown as { op?: string }).op ?? 'query';
      throw new TenantGuardError(this.model.modelName, op);
    }
  }

  schema.pre(GUARDED_QUERY_OPS, guard);

  schema.pre('aggregate', function (this: Aggregate<unknown>) {
    if (this.options.skipTenantGuard) return;
    const first = this.pipeline()[0];
    const match = first && '$match' in first ? first.$match : undefined;
    if (!match?.organizationId) {
      throw new TenantGuardError(this.model()?.modelName ?? 'unknown', 'aggregate');
    }
  });
}
