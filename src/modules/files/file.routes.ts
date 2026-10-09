import { z } from '../../docs/zod.js';
import { storage } from '../../integrations/storage/index.js';
import { ApiError } from '../../utils/ApiError.js';
import { safeEqual, signPayload } from '../../utils/crypto.js';
import { createModuleRouter } from '../../utils/router.js';

const m = createModuleRouter('/files', 'Files');

/** Serves local-storage files behind expiring HMAC signatures (development/self-hosted storage). */
m.publicRoute({
  method: 'get',
  path: '/local',
  summary: 'Download a file via a signed, expiring link (local storage driver only)',
  query: z.object({ t: z.string().max(4000), s: z.string().max(200) }),
  handler: async ({ query, res }) => {
    if (storage.name !== 'local' || !safeEqual(signPayload(query.t), query.s)) throw ApiError.forbidden('Invalid link');
    const p = JSON.parse(Buffer.from(query.t, 'base64url').toString('utf8')) as { k: string; e: number; n: string | null; i: boolean };
    if (p.e < Date.now() / 1000) throw ApiError.forbidden('This link has expired');
    const body = await storage.getObject(p.k).catch(() => {
      throw ApiError.notFound('File');
    });
    res.setHeader('Cache-Control', 'private, no-store');
    if (p.n) res.setHeader('Content-Disposition', `${p.i ? 'inline' : 'attachment'}; filename="${p.n.replace(/"/g, '')}"`);
    res.type(p.n ?? p.k).send(body);
  },
});

export const fileModule = m;
