import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../../config/env.js';
import { signPayload } from '../../utils/crypto.js';
import type { PutObjectInput, StorageProvider } from './storage.provider.js';

/**
 * Development storage on local disk. Downloads go through GET /api/v1/files/local with an
 * HMAC-signed, expiring token, so the behaviour matches S3 signed URLs.
 */
export class LocalStorage implements StorageProvider {
  readonly name = 'local' as const;
  private readonly root = path.resolve(env.STORAGE_LOCAL_DIR);

  private resolve(key: string) {
    const full = path.resolve(this.root, key);
    if (!full.startsWith(this.root + path.sep)) throw new Error('Invalid storage key');
    return full;
  }

  async putObject({ key, body }: PutObjectInput) {
    const full = this.resolve(key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body);
    return { key, size: body.length };
  }

  async getSignedUrl(key: string, opts: { expiresInSeconds?: number; fileName?: string; inline?: boolean } = {}) {
    const exp = Math.floor(Date.now() / 1000) + (opts.expiresInSeconds ?? env.SIGNED_URL_TTL_SECONDS);
    const payload = JSON.stringify({ k: key, e: exp, n: opts.fileName ?? null, i: opts.inline ?? false });
    const token = Buffer.from(payload).toString('base64url');
    return `${env.API_PUBLIC_URL}/api/v1/files/local?t=${token}&s=${signPayload(token)}`;
  }

  async getObject(key: string) {
    return readFile(this.resolve(key));
  }

  async deleteObject(key: string) {
    await rm(this.resolve(key), { force: true });
  }
}
