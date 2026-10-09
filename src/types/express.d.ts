import type { AuthContext } from './auth.js';

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
      requestId?: string;
      /** Exact request bytes, kept for webhook signature checks. */
      rawBody?: Buffer;
    }
  }
}

export {};
