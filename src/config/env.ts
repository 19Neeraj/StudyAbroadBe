import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

const nodeEnv = process.env.NODE_ENV ?? 'development';
// Environment-specific file wins over the generic .env; neither is required (CI/containers inject vars).
loadDotenv({ path: [`.env.${nodeEnv}`, '.env'], quiet: true });

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const csv = z.string().transform((v) =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Human-readable logs (needs the pino-pretty dev dependency). Defaults to on in development only. */
  LOG_PRETTY: bool.optional(),

  MONGO_URI: z.string().min(1).default('mongodb://localhost:27017/study_abroad_crm'),
  MONGO_MAX_POOL_SIZE: z.coerce.number().int().positive().default(20),
  REDIS_URL: z.string().optional(),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  /** HMAC pepper for hashing opaque refresh tokens at rest. */
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().positive().default(30),
  CORS_ORIGINS: csv.default(['http://localhost:3000']),
  COOKIE_SECURE: bool.default(false),
  COOKIE_DOMAIN: z.string().optional(),
  /** Use "none" (with COOKIE_SECURE=true) only when web and API are on different sites. */
  COOKIE_SAMESITE: z.enum(['strict', 'lax', 'none']).default('strict'),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  /** Requests per window per signed-in session. */
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  /** Requests per window per IP (an office may share one IP). */
  RATE_LIMIT_IP_MAX: z.coerce.number().int().positive().default(3000),
  /** Login / password attempts per 15 min per IP + account. */
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
  /** Token refreshes per 15 min per refresh token. */
  REFRESH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),

  /** Product name shown in emails and authenticator apps (2FA issuer). */
  APP_NAME: z.string().min(1).max(60).default('Study Abroad CRM'),
  /**
   * Public read-only demo: POST /auth/demo signs visitors into the demo organization without a
   * password. Off by default; never enable it on a database that holds real customer data.
   */
  DEMO_ENABLED: bool.default(false),
  /** Demo organizations reject every write from signed-in users (set false only to rehearse a demo script locally). */
  DEMO_READ_ONLY: bool.default(true),
  /** Public URL of the web app, used to build links in emails. */
  APP_URL: z.url().default('http://localhost:3000'),
  EMAIL_PROVIDER: z.enum(['console', 'smtp', 'memory']).default('console'),
  EMAIL_FROM: z.string().default('Study Abroad CRM <no-reply@example.com>'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  /** Public base URL of this API (webhook callbacks, local signed file URLs). */
  API_PUBLIC_URL: z.url().default('http://localhost:4000'),
  /** 32+ chars; encrypts integration credentials at rest. Falls back to JWT_REFRESH_SECRET outside production. */
  ENCRYPTION_KEY: z.string().min(32).optional(),

  /** Background jobs: bullmq (needs REDIS_URL) or inline (in-process, dev/tests). */
  JOBS_DRIVER: z.enum(['bullmq', 'inline']).optional(),
  /** Object storage for documents and call recordings. */
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./storage'),
  AWS_REGION: z.string().optional(),
  AWS_BUCKET: z.string().optional(),
  AWS_ACCESS_KEY: z.string().optional(),
  AWS_SECRET_KEY: z.string().optional(),
  /** S3-compatible endpoint (MinIO, Wasabi, R2…); empty for AWS. */
  S3_ENDPOINT: z.string().optional(),
  /** Maximum document upload size. */
  DOCUMENT_MAX_MB: z.coerce.number().int().min(1).max(100).default(10),
  SIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(86_400).default(300),

  /**
   * Push notifications: "live" sends via FCM (Android) and APNs (iOS) with the credentials below;
   * "log" only logs (development). Tests always use an in-memory driver.
   */
  PUSH_DRIVER: z.enum(['live', 'log']).default('log'),
  /** Firebase service-account JSON (raw or base64) for FCM HTTP v1. */
  FCM_SERVICE_ACCOUNT: z.string().optional(),
  /** APNs auth key (.p8 contents, raw or base64), key id, team id and the app bundle id. */
  APNS_KEY: z.string().optional(),
  APNS_KEY_ID: z.string().optional(),
  APNS_TEAM_ID: z.string().optional(),
  APNS_BUNDLE_ID: z.string().default('com.studyabroadcrm.app'),
  APNS_PRODUCTION: z.coerce.boolean().default(false),

  SUPER_ADMIN_EMAIL: z.email().optional(),
  SUPER_ADMIN_PASSWORD: z.string().min(10).optional(),
});

const parsed = schema
  .superRefine((v, ctx) => {
    if (v.NODE_ENV === 'production' && !v.ENCRYPTION_KEY) ctx.addIssue({ code: 'custom', path: ['ENCRYPTION_KEY'], message: 'Required in production' });
    if (v.STORAGE_DRIVER === 's3' && (!v.AWS_BUCKET || !v.AWS_REGION)) ctx.addIssue({ code: 'custom', path: ['AWS_BUCKET'], message: 'AWS_BUCKET and AWS_REGION are required for s3 storage' });
    if (v.JOBS_DRIVER === 'bullmq' && !v.REDIS_URL) ctx.addIssue({ code: 'custom', path: ['REDIS_URL'], message: 'Required for the bullmq jobs driver' });
  })
  .safeParse(process.env);
if (!parsed.success) {
  // Logger depends on env, so report directly and fail fast.
  process.stderr.write(`Invalid environment configuration:\n${z.prettifyError(parsed.error)}\n`);
  process.exit(1);
}

export const env = parsed.data;
export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
