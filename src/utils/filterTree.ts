import { Types } from 'mongoose';
import { z } from '../docs/zod.js';
import { ApiError } from './ApiError.js';
import { escapeRegex } from './pagination.js';

/**
 * Advanced (nested) filters: a tree of AND/OR groups whose leaves are `field operator value` rules.
 *
 *   { "op": "and", "rules": [
 *       { "field": "leadSource", "operator": "in", "value": ["meta", "google"] },
 *       { "op": "or", "rules": [
 *           { "field": "ieltsScore", "operator": "gte", "value": 6.5 },
 *           { "field": "pteScore", "operator": "gte", "value": 58 } ] } ] }
 *
 * Only whitelisted fields compile, each with operators that suit its type; values are coerced
 * (ids → ObjectId, dates → Date), so nothing user-supplied reaches MongoDB as an operator.
 * Text matching is anchored-prefix only (spec §31). Callers AND the result with their scope filter.
 */

export const FIELD_TYPES = ['text', 'lookup', 'reference', 'number', 'date', 'boolean'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const OPERATORS = [
  'eq', 'neq', 'in', 'nin', 'startsWith',
  'gt', 'gte', 'lt', 'lte', 'between',
  'inLastDays', 'inNextDays', 'olderThanDays',
  'isEmpty', 'isNotEmpty',
] as const;
export type Operator = (typeof OPERATORS)[number];

export const OPERATORS_BY_TYPE: Record<FieldType, readonly Operator[]> = {
  text: ['eq', 'neq', 'in', 'nin', 'startsWith', 'isEmpty', 'isNotEmpty'],
  lookup: ['eq', 'neq', 'in', 'nin', 'isEmpty', 'isNotEmpty'],
  reference: ['eq', 'neq', 'in', 'nin', 'isEmpty', 'isNotEmpty'],
  number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'isEmpty', 'isNotEmpty'],
  date: ['gte', 'lte', 'between', 'inLastDays', 'inNextDays', 'olderThanDays', 'isEmpty', 'isNotEmpty'],
  boolean: ['eq'],
};

export interface FilterFieldDef {
  label: string;
  type: FieldType;
  /** Document path when it differs from the field name. */
  path?: string;
  /** For `lookup` fields: which settings list the values come from. */
  lookupType?: string;
  /** For `reference` fields: what the id points at, so clients can offer the right picker. */
  refType?: 'user' | 'branch' | 'university';
  group?: string;
}
export type FilterFieldCatalog = Record<string, FilterFieldDef>;

export const MAX_FILTER_DEPTH = 4;
export const MAX_FILTER_RULES = 40;
const MAX_IN_VALUES = 100;

const scalar = z.union([z.string().max(200), z.number(), z.boolean(), z.null()]);

export interface FilterRule {
  field: string;
  operator: Operator;
  value?: z.infer<typeof scalar> | z.infer<typeof scalar>[];
}
export interface FilterGroup {
  op: 'and' | 'or';
  /** Negates the whole group (NOT (a AND b)). */
  not?: boolean;
  rules: (FilterRule | FilterGroup)[];
}

export const filterRuleSchema = z.object({
  field: z.string().min(1).max(64),
  operator: z.enum(OPERATORS),
  value: z.union([scalar, z.array(scalar).max(MAX_IN_VALUES)]).optional(),
});

export const filterGroupSchema: z.ZodType<FilterGroup> = z.lazy(() =>
  z.object({
    op: z.enum(['and', 'or']),
    not: z.boolean().optional(),
    rules: z.array(z.union([filterGroupSchema, filterRuleSchema])).max(MAX_FILTER_RULES),
  }),
);

/** Query-string form: the tree as JSON. Invalid JSON surfaces as a normal 422 field error. */
export const filterQueryParam = z
  .string()
  .max(10_000)
  .transform((raw, ctx) => {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      ctx.addIssue({ code: 'custom', message: 'filter must be valid JSON' });
      return z.NEVER;
    }
  })
  .pipe(filterGroupSchema)
  .openapi({
    type: 'string',
    description:
      'Nested AND/OR filter as JSON: `{"op":"and","rules":[{"field":"leadSource","operator":"in","value":["meta"]},' +
      '{"op":"or","rules":[…]}]}`. See the `/filter-fields` endpoint for fields and operators.',
  });

type Mongo = Record<string, unknown>;
const isGroup = (n: FilterRule | FilterGroup): n is FilterGroup => 'op' in n;

function fail(path: string, message: string): never {
  throw ApiError.validation([{ field: `filter.${path}`, message }]);
}

function coerce(def: FilterFieldDef, raw: unknown, path: string): unknown {
  if (raw === null || raw === undefined || raw === '') fail(path, 'A value is required');
  switch (def.type) {
    case 'reference':
      if (typeof raw !== 'string' || !Types.ObjectId.isValid(raw) || raw.length !== 24) fail(path, 'Invalid id');
      return new Types.ObjectId(raw);
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(n)) fail(path, 'Must be a number');
      return n;
    }
    case 'date': {
      const d = new Date(raw as string | number);
      if (Number.isNaN(d.getTime())) fail(path, 'Must be a date');
      return d;
    }
    case 'boolean':
      if (typeof raw === 'boolean') return raw;
      if (raw === 'true' || raw === 'false') return raw === 'true';
      return fail(path, 'Must be true or false');
    default:
      if (typeof raw !== 'string' && typeof raw !== 'number') fail(path, 'Must be text');
      return String(raw);
  }
}

function list(def: FilterFieldDef, value: FilterRule['value'], path: string): unknown[] {
  const values = Array.isArray(value) ? value : [value];
  if (!values.length) fail(path, 'Choose at least one value');
  return values.map((v) => coerce(def, v, path));
}

function days(value: FilterRule['value'], path: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 3650) fail(path, 'Must be a whole number of days (0–3650)');
  return n;
}

function compileRule(rule: FilterRule, catalog: FilterFieldCatalog, path: string, now: Date): Mongo {
  const def = Object.hasOwn(catalog, rule.field) ? catalog[rule.field] : undefined;
  if (!def) fail(`${path}.field`, `Unknown field "${rule.field}"`);
  if (!OPERATORS_BY_TYPE[def.type].includes(rule.operator)) {
    fail(`${path}.operator`, `"${rule.operator}" cannot be used with ${def.label}`);
  }
  const key = def.path ?? rule.field;
  const at = `${path}.value`;
  const v = rule.value;
  const one = () => coerce(def, Array.isArray(v) ? v[0] : v, at);
  const textual = def.type === 'text' || def.type === 'lookup';

  switch (rule.operator) {
    case 'eq':
      return { [key]: one() };
    case 'neq':
      return { [key]: { $ne: one() } };
    case 'in':
      return { [key]: { $in: list(def, v, at) } };
    case 'nin':
      return { [key]: { $nin: list(def, v, at) } };
    case 'startsWith': {
      const s = String(one()).trim();
      if (!s) fail(at, 'A value is required');
      return { [key]: { $regex: `^${escapeRegex(s)}`, $options: 'i' } };
    }
    case 'gt':
      return { [key]: { $gt: one() } };
    case 'gte':
      return { [key]: { $gte: one() } };
    case 'lt':
      return { [key]: { $lt: one() } };
    case 'lte':
      return { [key]: { $lte: one() } };
    case 'between': {
      if (!Array.isArray(v) || v.length !== 2) fail(at, 'Provide [from, to]');
      const [from, to] = [v[0], v[1]].map((x) => (x === null || x === '' ? undefined : coerce(def, x, at)));
      if (from === undefined && to === undefined) fail(at, 'Provide at least one bound');
      return { [key]: { ...(from !== undefined ? { $gte: from } : {}), ...(to !== undefined ? { $lte: to } : {}) } };
    }
    case 'inLastDays':
      return { [key]: { $gte: new Date(now.getTime() - days(v, at) * 86_400_000), $lte: now } };
    case 'inNextDays':
      return { [key]: { $gte: now, $lte: new Date(now.getTime() + days(v, at) * 86_400_000) } };
    case 'olderThanDays':
      return { [key]: { $lt: new Date(now.getTime() - days(v, at) * 86_400_000) } };
    // Empty strings only exist on text-like fields; ids, numbers and dates are either set or missing.
    case 'isEmpty':
      return textual ? { $or: [{ [key]: null }, { [key]: '' }] } : { [key]: null };
    case 'isNotEmpty':
      return textual ? { [key]: { $nin: [null, ''] } } : { [key]: { $ne: null } };
  }
}

/**
 * Compiles a validated tree to a MongoDB filter. Empty groups compile to `{}` (match all),
 * so a half-built filter in the UI never hides everything.
 */
export function compileFilterTree(tree: FilterGroup | undefined, catalog: FilterFieldCatalog, now = new Date()): Mongo {
  if (!tree) return {};
  let rules = 0;

  const walk = (group: FilterGroup, path: string, depth: number): Mongo => {
    if (depth > MAX_FILTER_DEPTH) fail(path, `Groups can be nested at most ${MAX_FILTER_DEPTH} levels deep`);
    const parts = group.rules
      .map((node, i) => {
        const p = `${path}.rules.${i}`;
        if (isGroup(node)) return walk(node, p, depth + 1);
        if (++rules > MAX_FILTER_RULES) fail(path, `At most ${MAX_FILTER_RULES} conditions are allowed`);
        return compileRule(node, catalog, p, now);
      })
      .filter((m) => Object.keys(m).length > 0);
    if (!parts.length) return {};
    const combined = parts.length === 1 ? parts[0]! : { [group.op === 'and' ? '$and' : '$or']: parts };
    return group.not ? { $nor: [combined] } : combined;
  };

  return walk(tree, 'root', 1);
}

/** Field catalog as served to clients (UI builds the filter builder from it). */
export function describeCatalog(catalog: FilterFieldCatalog) {
  return Object.entries(catalog).map(([field, def]) => ({
    field,
    label: def.label,
    type: def.type,
    group: def.group ?? null,
    lookupType: def.lookupType ?? null,
    refType: def.refType ?? null,
    operators: OPERATORS_BY_TYPE[def.type],
  }));
}

export const filterFieldDto = z
  .object({
    field: z.string(),
    label: z.string(),
    type: z.enum(FIELD_TYPES),
    group: z.string().nullable(),
    lookupType: z.string().nullable(),
    refType: z.enum(['user', 'branch', 'university']).nullable(),
    operators: z.array(z.enum(OPERATORS)),
  })
  .openapi('FilterField');
