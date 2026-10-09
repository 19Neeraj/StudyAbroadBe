import jwt, { type SignOptions } from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { ApiError } from '../../utils/ApiError.js';

const ISSUER = 'study-abroad-crm';
const AUDIENCE = 'crm-api';

export interface AccessTokenPayload {
  sub: string;
  org: string;
  sid: string;
  iat: number;
  exp: number;
}

export function signAccessToken(claims: {
  userId: string;
  organizationId: string;
  sessionId: string;
}): string {
  return jwt.sign({ org: claims.organizationId, sid: claims.sessionId }, env.JWT_ACCESS_SECRET, {
    subject: claims.userId,
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithm: 'HS256',
    expiresIn: env.ACCESS_TOKEN_TTL as SignOptions['expiresIn'],
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
    });
    if (
      typeof payload === 'string' ||
      !payload.sub ||
      typeof payload.org !== 'string' ||
      typeof payload.sid !== 'string'
    ) {
      throw new Error('Malformed token');
    }
    return payload as AccessTokenPayload;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError)
      throw new ApiError(401, 'Access token expired', [], 'TOKEN_EXPIRED');
    throw ApiError.unauthorized('Invalid access token');
  }
}

/** Seconds until an access token issued now expires (for clients scheduling refresh). */
export function accessTokenTtlSeconds(): number {
  const decoded = jwt.decode(signAccessToken({ userId: '0', organizationId: '0', sessionId: '0' }));
  if (!decoded || typeof decoded === 'string' || !decoded.exp || !decoded.iat) return 900;
  return decoded.exp - decoded.iat;
}
