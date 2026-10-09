import { env } from '../../config/env.js';
import { LocalStorage } from './local.storage.js';
import { S3Storage } from './s3.storage.js';
import type { StorageProvider } from './storage.provider.js';

export const storage: StorageProvider = env.STORAGE_DRIVER === 's3' ? new S3Storage() : new LocalStorage();
export { assertTenantKey, type StorageProvider } from './storage.provider.js';
