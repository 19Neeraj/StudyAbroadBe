import { Types } from 'mongoose';
import { z } from '../../docs/zod.js';
import type { ServiceContext } from '../../types/auth.js';
import { hasOrgScope } from '../../utils/access.js';
import { ApiError } from '../../utils/ApiError.js';
import { buildPagination, paginationQuery, toPaging } from '../../utils/pagination.js';
import { objectIdString } from '../../utils/objectId.js';
import { createModuleRouter } from '../../utils/router.js';
import { recordAudit } from '../audit/audit.service.js';
import { SessionModel } from '../auth/session.model.js';
import { UserModel } from '../users/user.model.js';

/**
 * Device management (spec §36). A device is a signed-in session plus what the mobile app reports
 * about itself. Admins/managers can see their team's active devices and sign them out remotely.
 */
const m = createModuleRouter('/devices', 'Devices');

const registerBody = z
  .object({
    deviceId: z.string().trim().min(4).max(128),
    platform: z.enum(['android', 'ios']),
    deviceName: z.string().trim().max(100).optional(),
    appVersion: z.string().trim().max(30).optional(),
    osVersion: z.string().trim().max(30).optional(),
    pushToken: z.string().trim().max(4096).nullable().optional().openapi({ description: 'FCM registration token; null clears it' }),
  })
  .openapi('RegisterDeviceRequest');

async function teamUserIds(ctx: ServiceContext): Promise<Types.ObjectId[] | null> {
  if (hasOrgScope(ctx)) return null;
  const users = await UserModel.find({ organizationId: ctx.organizationId, branchIds: { $in: ctx.branchIds } }).select('_id').lean();
  return [ctx.userId, ...users.map((u) => u._id)];
}

m.route({
  method: 'post',
  path: '/register',
  summary: 'Register this signed-in device (mobile app): id, versions and push token',
  body: registerBody,
  handler: async ({ ctx, body }) => {
    if (!Types.ObjectId.isValid(ctx.sessionId)) throw ApiError.unauthorized();
    // A push token belongs to one session at a time (re-login on the same phone).
    if (body.pushToken) {
      await SessionModel.updateMany({ pushToken: body.pushToken, _id: { $ne: new Types.ObjectId(ctx.sessionId) } }, { $unset: { pushToken: 1 } });
    }
    await SessionModel.updateOne(
      { _id: new Types.ObjectId(ctx.sessionId), userId: ctx.userId },
      { ...body, pushToken: body.pushToken ?? undefined, ...(body.pushToken === null ? { $unset: { pushToken: 1 } } : {}), lastUsedAt: new Date() },
    );
    return { message: 'Device registered', data: null };
  },
});

m.route({
  method: 'get',
  path: '/',
  summary: 'Active devices of your team (platform, app version, last active)',
  permissions: ['device.manage'],
  query: paginationQuery.extend({ platform: z.enum(['web', 'android', 'ios', 'other']).optional(), userId: objectIdString.optional() }),
  paginated: true,
  handler: async ({ ctx, query }) => {
    const team = await teamUserIds(ctx);
    const filter: Record<string, unknown> = { organizationId: ctx.organizationId, revokedAt: null, expiresAt: { $gt: new Date() } };
    if (team) filter.userId = { $in: team };
    if (query.userId) filter.userId = team && !team.some((t) => t.equals(query.userId)) ? null : new Types.ObjectId(query.userId);
    if (query.platform) filter.platform = query.platform;
    const { skip, limit } = toPaging(query);
    const [items, total] = await Promise.all([
      SessionModel.find(filter)
        .select('userId platform deviceName deviceId appVersion osVersion ipAddress lastUsedAt createdAt pushToken')
        .sort({ lastUsedAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate({ path: 'userId', select: 'fullName email', match: { organizationId: ctx.organizationId } })
        .lean(),
      SessionModel.countDocuments(filter),
    ]);
    return {
      data: items.map(({ userId, pushToken, ...s }) => ({ ...s, user: userId ?? null, pushEnabled: !!pushToken, current: s._id.toString() === ctx.sessionId })),
      pagination: buildPagination(query.page, query.limit, total),
    };
  },
});

m.route({
  method: 'delete',
  path: '/:id',
  summary: 'Sign a device out remotely (takes effect immediately)',
  permissions: ['device.manage'],
  params: z.object({ id: objectIdString }),
  handler: async ({ ctx, params }) => {
    const team = await teamUserIds(ctx);
    const session = await SessionModel.findOne({ _id: params.id, organizationId: ctx.organizationId, revokedAt: null, ...(team ? { userId: { $in: team } } : {}) }).lean();
    if (!session) throw ApiError.notFound('Device');
    await SessionModel.updateOne({ _id: session._id }, { revokedAt: new Date(), revokedReason: 'revoked_by_admin', $unset: { pushToken: 1 } });
    await recordAudit(ctx, { entityType: 'session', entityId: session._id, action: 'device.signed_out', metadata: { userId: session.userId.toString(), platform: session.platform } });
    return { message: 'Device signed out', data: null };
  },
});

export const deviceModule = m;
