/**
 * Object storage abstraction (spec §21, §42; call recordings §14). Files never go into MongoDB;
 * records keep `fileKey` and clients get short-lived signed URLs. Keys are always tenant-prefixed:
 *   {organizationId}/students/{studentId}/documents/…   {organizationId}/calls/{callId}/recording.mp3
 */
export interface PutObjectInput {
  key: string;
  body: Buffer;
  contentType: string;
}

export interface StorageProvider {
  readonly name: 'local' | 's3';
  putObject(input: PutObjectInput): Promise<{ key: string; size: number }>;
  /** Time-limited download URL; `fileName` sets Content-Disposition. */
  getSignedUrl(key: string, opts?: { expiresInSeconds?: number; fileName?: string; inline?: boolean }): Promise<string>;
  deleteObject(key: string): Promise<void>;
  getObject(key: string): Promise<Buffer>;
}

export function assertTenantKey(organizationId: string, key: string): void {
  if (!key.startsWith(`${organizationId}/`) || key.includes('..')) throw new Error('Storage key outside the organization prefix');
}
