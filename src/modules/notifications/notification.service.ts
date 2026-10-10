import { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import type { z } from '../../docs/zod.js';
import { emailProvider } from '../../integrations/email/index.js';
import { pushProvider } from '../../integrations/push/index.js';
import { enqueue } from '../../jobs/queue.js';
import { emitTo, rooms } from '../../sockets/index.js';
import type { ServiceContext } from '../../types/auth.js';
import { ApiError } from '../../utils/ApiError.js';
import { buildPagination, toPaging } from '../../utils/pagination.js';
import { recordAudit } from '../audit/audit.service.js';
import { SessionModel } from '../auth/session.model.js';
import { UserModel } from '../users/user.model.js';
import { DEFAULT_CHANNELS, NOTIFICATION_TYPES, NotificationModel, NotificationPreferenceModel, type NotificationType } from './notification.model.js';
import type { broadcastBody, listQuery, preferencesBody } from './notification.validation.js';

export interface NotifyInput {
  type: NotificationType;
  title: string;
  body?: string;
  data?: Record<string, string | undefined>;
  /** Same key for the same user is stored and sent only once. */
  dedupeKey?: string;
  sentBy?: Types.ObjectId;
}

type Recipient = Types.ObjectId | string | null | undefined;

/**
 * Creates in-app notifications, pushes them live (Socket.IO) and queues push/email delivery.
 * Never throws: a notification problem must not break the business action that caused it.
 */
export async function notify(organizationId: Types.ObjectId, recipients: Recipient[], input: NotifyInput, opts: { exclude?: Recipient } = {}): Promise<number> {
  const ids = [...new Set(recipients.filter(Boolean).map(String))].filter((id) => id !== String(opts.exclude ?? ''));
  let created = 0;
  for (const userId of ids) {
    try {
      const data = Object.fromEntries(Object.entries(input.data ?? {}).filter(([, v]) => v !== undefined)) as Record<string, string>;
      const doc = await NotificationModel.create({ organizationId, userId: new Types.ObjectId(userId), type: input.type, title: input.title, body: input.body, data, dedupeKey: input.dedupeKey, sentBy: input.sentBy, push: { status: 'queued' } });
      created++;
      emitTo([rooms.user(userId)], 'notification.created', { id: doc._id.toString(), type: input.type, title: input.title, body: input.body ?? null, data });
      await enqueue('notifications.deliver', { organizationId: organizationId.toString(), notificationId: doc._id.toString() }, { jobId: `notify:${doc._id.toString()}` });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) continue; // already notified (dedupeKey)
      logger.warn({ err, type: input.type }, 'Could not create notification');
    }
  }
  return created;
}

async function channelsFor(organizationId: Types.ObjectId, userId: Types.ObjectId) {
  const pref = await NotificationPreferenceModel.findOne({ organizationId, userId }).lean();
  const saved = (pref?.channels ?? {}) as Partial<Record<NotificationType, { push?: boolean; email?: boolean }>>;
  return Object.fromEntries(NOTIFICATION_TYPES.map((t) => [t, { ...DEFAULT_CHANNELS[t], ...(saved[t] ?? {}) }])) as Record<NotificationType, { push: boolean; email: boolean }>;
}

/** Background delivery to every signed-in device of the user (push) and email, per their choices. */
export async function deliver(organizationId: Types.ObjectId, notificationId: Types.ObjectId) {
  const n = await NotificationModel.findOne({ organizationId, _id: notificationId }).lean();
  if (!n) return;
  const channels = (await channelsFor(organizationId, n.userId))[n.type as NotificationType];
  if (channels.push) {
    const sessions = await SessionModel.find({ userId: n.userId, revokedAt: null, expiresAt: { $gt: new Date() }, pushToken: { $type: 'string' }, platform: { $in: ['android', 'ios'] } })
      .select('pushToken platform')
      .setOptions({ skipTenantGuard: true })
      .lean();
    const unread = await NotificationModel.countDocuments({ organizationId, userId: n.userId, readAt: null });
    const data = { ...(n.data as Record<string, string>), type: n.type, notificationId: n._id.toString() };
    const errors: string[] = [];
    let sent = 0;
    for (const s of sessions) {
      const r = await pushProvider.send(s.pushToken!, s.platform as 'android' | 'ios', { title: n.title, body: n.body ?? '', data, badge: unread });
      if (r.ok) sent++;
      else {
        errors.push(r.error ?? 'failed');
        if (r.invalidToken) await SessionModel.updateOne({ _id: s._id }, { $unset: { pushToken: 1 } }).setOptions({ skipTenantGuard: true });
      }
    }
    await NotificationModel.updateOne({ organizationId, _id: n._id }, { push: sessions.length === 0 ? { status: 'skipped', at: new Date(), error: 'No device with notifications enabled' } : sent ? { status: 'sent', at: new Date() } : { status: 'failed', at: new Date(), error: errors.join('; ').slice(0, 300) } });
  } else {
    await NotificationModel.updateOne({ organizationId, _id: n._id }, { push: { status: 'skipped', at: new Date(), error: 'Turned off by the user' } });
  }
  if (channels.email && !n.emailed) {
    const user = await UserModel.findOne({ organizationId, _id: n.userId, isActive: true }).select('email firstName').lean();
    if (user?.email) {
      const link = n.data && (n.data as Record<string, string>).leadId ? `${env.APP_URL}/leads/${(n.data as Record<string, string>).leadId}` : env.APP_URL;
      await emailProvider.send({ to: user.email, subject: n.title, text: `Hi ${user.firstName ?? ''},\n\n${n.title}${n.body ? `\n\n${n.body}` : ''}\n\nOpen the CRM: ${link}\n` });
      await NotificationModel.updateOne({ organizationId, _id: n._id }, { emailed: true });
    }
  }
}

export async function listMine(ctx: ServiceContext, q: z.infer<typeof listQuery>) {
  const filter: Record<string, unknown> = { organizationId: ctx.organizationId, userId: ctx.userId };
  if (q.unread === 'true') filter.readAt = null;
  const { skip, limit } = toPaging(q);
  const [items, total, unread] = await Promise.all([
    NotificationModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).select('-organizationId -__v -dedupeKey -emailed').populate({ path: 'sentBy', select: 'fullName', match: { organizationId: ctx.organizationId } }).lean(),
    NotificationModel.countDocuments(filter),
    NotificationModel.countDocuments({ organizationId: ctx.organizationId, userId: ctx.userId, readAt: null }),
  ]);
  return { items, pagination: buildPagination(q.page, limit, total), unread };
}

export async function unreadCount(ctx: ServiceContext) {
  return { unread: await NotificationModel.countDocuments({ organizationId: ctx.organizationId, userId: ctx.userId, readAt: null }) };
}

export async function markRead(ctx: ServiceContext, id?: string) {
  const filter: Record<string, unknown> = { organizationId: ctx.organizationId, userId: ctx.userId, readAt: null };
  if (id) filter._id = new Types.ObjectId(id);
  const res = await NotificationModel.updateMany(filter, { readAt: new Date() });
  return { updated: res.modifiedCount, ...(await unreadCount(ctx)) };
}

export async function getPreferences(ctx: ServiceContext) {
  return channelsFor(ctx.organizationId, ctx.userId);
}

export async function savePreferences(ctx: ServiceContext, input: z.infer<typeof preferencesBody>) {
  await NotificationPreferenceModel.updateOne({ organizationId: ctx.organizationId, userId: ctx.userId }, { $set: Object.fromEntries(Object.entries(input).map(([t, c]) => [`channels.${t}`, c])), $setOnInsert: { organizationId: ctx.organizationId, userId: ctx.userId } }, { upsert: true });
  return getPreferences(ctx);
}

/**
 * Team message (spec §33 "Manager message"): to chosen users, a role, branches or everyone the
 * sender can manage. Branch-scoped senders only reach users in their own branches.
 */
export async function broadcast(ctx: ServiceContext, input: z.infer<typeof broadcastBody>) {
  const filter: Record<string, unknown> = { organizationId: ctx.organizationId, isActive: true, _id: { $ne: ctx.userId } };
  if (input.userIds?.length) filter._id = { $in: input.userIds.map((i) => new Types.ObjectId(i)), $ne: ctx.userId };
  if (input.branchIds?.length) filter.branchIds = { $in: input.branchIds.map((i) => new Types.ObjectId(i)) };
  if (input.roleIds?.length) filter.roleId = { $in: input.roleIds.map((i) => new Types.ObjectId(i)) };
  if (ctx.dataScope !== 'organization') {
    if (input.branchIds?.some((b) => !ctx.branchIds.some((x) => x.equals(b)))) throw ApiError.forbidden('You can only message your own branches');
    filter.branchIds = { $in: input.branchIds?.length ? input.branchIds.map((i) => new Types.ObjectId(i)) : ctx.branchIds };
  }
  const users = await UserModel.find(filter).select('_id').limit(2000).lean();
  if (!users.length) throw ApiError.validation([{ field: 'body', message: 'No active recipients match' }]);
  const sender = await UserModel.findOne({ organizationId: ctx.organizationId, _id: ctx.userId }).select('fullName').lean();
  const count = await notify(ctx.organizationId, users.map((u) => u._id), { type: 'team_message', title: input.title, body: `${input.message}\n— ${sender?.fullName ?? 'Manager'}`, data: input.leadId ? { leadId: input.leadId } : {}, sentBy: ctx.userId });
  await recordAudit(ctx, { entityType: 'notification', action: 'notification.broadcast', metadata: { title: input.title, recipients: count } });
  return { recipients: count };
}
