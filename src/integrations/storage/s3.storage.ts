import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../../config/env.js';
import type { PutObjectInput, StorageProvider } from './storage.provider.js';

/** AWS S3 or any S3-compatible store (MinIO, R2, Wasabi via S3_ENDPOINT). Objects stay private. */
export class S3Storage implements StorageProvider {
  readonly name = 's3' as const;
  private readonly client = new S3Client({
    region: env.AWS_REGION,
    ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT, forcePathStyle: true } : {}),
    ...(env.AWS_ACCESS_KEY && env.AWS_SECRET_KEY ? { credentials: { accessKeyId: env.AWS_ACCESS_KEY, secretAccessKey: env.AWS_SECRET_KEY } } : {}),
  });
  private readonly bucket = env.AWS_BUCKET!;

  async putObject({ key, body, contentType }: PutObjectInput) {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType, ServerSideEncryption: 'AES256' }));
    return { key, size: body.length };
  }

  async getSignedUrl(key: string, opts: { expiresInSeconds?: number; fileName?: string; inline?: boolean } = {}) {
    const disposition = opts.fileName ? `${opts.inline ? 'inline' : 'attachment'}; filename="${opts.fileName.replace(/"/g, '')}"` : undefined;
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key, ResponseContentDisposition: disposition }), {
      expiresIn: opts.expiresInSeconds ?? env.SIGNED_URL_TTL_SECONDS,
    });
  }

  async getObject(key: string) {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return Buffer.from(await res.Body!.transformToByteArray());
  }

  async deleteObject(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
