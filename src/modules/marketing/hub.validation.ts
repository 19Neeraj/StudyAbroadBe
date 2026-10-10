import { z } from '../../docs/zod.js';
import { objectIdString } from '../../utils/objectId.js';
import { paginationQuery } from '../../utils/pagination.js';
import { EXTERNAL_LEAD_STATUSES } from './externalLeadReference.model.js';
import { MAPPABLE_FIELDS } from './fieldMapping.model.js';
import { DUPLICATE_POLICIES } from './leadImport.service.js';
import { SYNC_TYPES } from './syncLog.model.js';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const csv = z.string().transform((v) => v.split(',').filter(Boolean));

export const providerParams = z.object({ provider: z.string().min(1).max(40) });

export const settingsBody = z
  .object({
    leadSource: z.string().trim().min(1).max(64).nullable().optional().openapi({ description: 'Lookup key (type lead_source) for imported leads; default meta/google' }),
    duplicatePolicy: z.enum(DUPLICATE_POLICIES).optional().openapi({ description: 'keep_existing (default): add the enquiry to the existing lead' }),
    defaultBranchId: objectIdString.nullable().optional(),
    defaultCounsellorId: objectIdString.nullable().optional(),
    defaultStage: z.string().trim().min(1).max(64).nullable().optional(),
  })
  .openapi('IntegrationImportSettings');

export const connectBody = z
  .object({
    secrets: z.record(z.string().max(60), z.string().max(2000)).optional().openapi({ description: 'Write-only credentials, e.g. Meta { accessToken, appSecret, verifyToken }. Empty string removes a key.' }),
    config: z.record(z.string().max(60), z.union([z.string().max(200), z.number(), z.boolean()])).optional().openapi({ description: 'Non-secret settings, e.g. { apiVersion: "v26.0" }' }),
    settings: settingsBody.optional(),
  })
  .openapi('ConnectIntegrationRequest');

export const accountsBody = z.object({ accounts: z.array(z.object({ id: objectIdString, selected: z.boolean() })).min(1).max(500) });

export const syncBody = z.object({ type: z.enum([...SYNC_TYPES, 'all']).default('all'), from: day.optional(), to: day.optional() });

export const syncLogQuery = paginationQuery.extend({
  provider: z.string().max(40).optional(),
  syncType: z.enum(SYNC_TYPES).optional(),
  result: z.enum(['running', 'success', 'partial', 'failed']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export const importedLeadsQuery = paginationQuery.extend({
  provider: z.string().max(40).optional(),
  status: csv.pipe(z.array(z.enum(EXTERNAL_LEAD_STATUSES))).optional(),
  campaignExternalId: z.string().max(64).optional(),
});

export const campaignsQuery = z.object({ from: day.optional(), to: day.optional(), status: z.string().max(40).optional() });

export const fieldMappingBody = z.object({
  formExternalId: z.string().max(64).nullable().optional().openapi({ description: 'Omit for the provider-wide default mapping' }),
  rules: z.array(z.object({ externalField: z.string().trim().min(1).max(120), crmField: z.enum(MAPPABLE_FIELDS) })).max(100),
});
