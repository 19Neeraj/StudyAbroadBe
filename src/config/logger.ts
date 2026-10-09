import { pino } from 'pino';
import { env } from './env.js';

/** Never let credentials or tokens reach log storage. */
const redact = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.currentPassword',
  '*.newPassword',
  '*.refreshToken',
  '*.accessToken',
  '*.token',
];

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: { paths: redact, censor: '[REDACTED]' },
  ...((env.LOG_PRETTY ?? env.NODE_ENV === 'development')
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss' },
        },
      }
    : {}),
});
