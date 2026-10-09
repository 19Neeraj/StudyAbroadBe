import { z } from '../../docs/zod.js';
import { objectIdString } from '../../utils/objectId.js';
import { paginationQuery } from '../../utils/pagination.js';

export const auditListQuery = paginationQuery.extend({
  entityType: z.string().max(50).optional(),
  entityId: objectIdString.optional(),
  userId: objectIdString.optional(),
  action: z.string().max(50).optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
});
export type AuditListQuery = z.infer<typeof auditListQuery>;

export const auditLogDto = z
  .object({
    _id: z.string(),
    userId: z.object({ _id: z.string(), fullName: z.string(), email: z.string() }).nullable(),
    entityType: z.string(),
    entityId: z.string().optional(),
    action: z.string(),
    oldValue: z.unknown(),
    newValue: z.unknown(),
    metadata: z.unknown(),
    ipAddress: z.string().optional(),
    createdAt: z.string(),
  })
  .openapi('AuditLog');
