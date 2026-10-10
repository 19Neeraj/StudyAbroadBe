import { env, isTest } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { livePush } from './live.push.js';
import type { PushMessage, PushProvider } from './push.provider.js';

/** In tests: records what would have been sent. Tokens starting "invalid" simulate a dead token. */
export const memoryPush = {
  sent: [] as { token: string; platform: string; message: PushMessage }[],
  reset() {
    this.sent = [];
  },
};

const memory: PushProvider = {
  name: 'memory',
  async send(token, platform, message) {
    if (token.startsWith('invalid')) return { ok: false, invalidToken: true, error: 'Unregistered' };
    memoryPush.sent.push({ token, platform, message });
    return { ok: true };
  },
};

const log: PushProvider = {
  name: 'log',
  async send(_token, platform, message) {
    logger.info({ platform, title: message.title }, 'Push (log driver, not sent)');
    return { ok: true };
  },
};

export const pushProvider: PushProvider = isTest ? memory : env.PUSH_DRIVER === 'live' ? livePush : log;
export type { PushMessage, PushProvider, PushResult } from './push.provider.js';
