import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { resolveAuthContext } from '../modules/auth/authContext.service.js';
import type { AuthContext } from '../types/auth.js';

let io: Server | undefined;

export const rooms = {
  organization: (id: string) => `organization:${id}`,
  user: (id: string) => `user:${id}`,
  branch: (id: string) => `branch:${id}`,
};

/**
 * Socket.IO with the same JWT as the REST API. Clients join only their own
 * organization/user/branch rooms; nothing is ever broadcast globally.
 */
export function initSockets(server: HttpServer): Server {
  io = new Server(server, {
    cors: { origin: env.CORS_ORIGINS, credentials: true },
    path: '/socket.io',
  });

  io.use(async (socket, next) => {
    try {
      const token =
        typeof socket.handshake.auth.token === 'string' ? socket.handshake.auth.token : undefined;
      if (!token) return next(new Error('Authentication required'));
      socket.data.auth = await resolveAuthContext(token);
      next();
    } catch {
      next(new Error('Authentication failed'));
    }
  });

  io.on('connection', (socket) => {
    const auth = socket.data.auth as AuthContext;
    void socket.join([
      rooms.organization(auth.organizationId.toString()),
      rooms.user(auth.userId.toString()),
      ...auth.branchIds.map((b) => rooms.branch(b.toString())),
    ]);
    logger.debug({ userId: auth.userId.toString() }, 'Socket connected');
  });

  return io;
}

/** Emits to rooms; a no-op when sockets are not initialised (tests, scripts). */
export function emitTo(roomNames: string[], event: string, payload: unknown): void {
  if (!io || roomNames.length === 0) return;
  io.to(roomNames).emit(event, payload);
}

export async function closeSockets(): Promise<void> {
  await io?.close();
  io = undefined;
}
