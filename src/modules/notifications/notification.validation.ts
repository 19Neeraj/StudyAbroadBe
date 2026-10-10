import { z } from '../../docs/zod.js';
import { objectIdString } from '../../utils/objectId.js';
import { paginationQuery } from '../../utils/pagination.js';
import { NOTIFICATION_TYPES } from './notification.model.js';

export const listQuery = paginationQuery.extend({ unread: z.enum(['true', 'false']).optional() });

export const preferencesBody = z.partialRecord(z.enum(NOTIFICATION_TYPES), z.object({ push: z.boolean(), email: z.boolean() })).openapi('NotificationPreferences');

export const broadcastBody = z
  .object({
    title: z.string().trim().min(1).max(120),
    message: z.string().trim().min(1).max(2000),
    userIds: z.array(objectIdString).max(500).optional(),
    roleIds: z.array(objectIdString).max(50).optional(),
    branchIds: z.array(objectIdString).max(50).optional(),
    leadId: objectIdString.optional().openapi({ description: 'Optional lead the message is about (tap opens it)' }),
  })
  .openapi('TeamMessageRequest');
