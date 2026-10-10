import { idParams } from '../../utils/objectId.js';
import { createModuleRouter } from '../../utils/router.js';
import * as service from './notification.service.js';
import { broadcastBody, listQuery, preferencesBody } from './notification.validation.js';

const m = createModuleRouter('/notifications', 'Notifications');

m.route({ method: 'get', path: '/', summary: 'My notifications (newest first)', query: listQuery, paginated: true, handler: async ({ ctx, query }) => { const r = await service.listMine(ctx, query); return { data: r.items, pagination: r.pagination, message: `${r.unread} unread` }; } });
m.route({ method: 'get', path: '/unread-count', summary: 'Number of unread notifications', handler: async ({ ctx }) => ({ data: await service.unreadCount(ctx) }) });
m.route({ method: 'post', path: '/read-all', summary: 'Mark all as read', handler: async ({ ctx }) => ({ data: await service.markRead(ctx) }) });
m.route({ method: 'post', path: '/:id/read', summary: 'Mark one as read', params: idParams, handler: async ({ ctx, params }) => ({ data: await service.markRead(ctx, params.id) }) });
m.route({ method: 'get', path: '/preferences', summary: 'My push/email choices per notification type', handler: async ({ ctx }) => ({ data: await service.getPreferences(ctx) }) });
m.route({ method: 'put', path: '/preferences', summary: 'Change my push/email choices (in-app always on)', body: preferencesBody, handler: async ({ ctx, body }) => ({ message: 'Preferences saved', data: await service.savePreferences(ctx, body) }) });
m.route({ method: 'post', path: '/broadcast', summary: 'Send a team message to users, roles or branches', permissions: ['notification.send'], body: broadcastBody, handler: async ({ ctx, body }) => ({ message: 'Message sent', data: await service.broadcast(ctx, body) }) });

export const notificationModule = m;
