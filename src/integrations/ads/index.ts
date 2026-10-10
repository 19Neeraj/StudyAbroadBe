import { isProduction } from '../../config/env.js';
import type { AdsProvider } from './ads.provider.js';
import { metaAdsProvider } from './meta.ads.js';
import { mockAdsProvider } from './mock.ads.js';

/** Registered ads providers. Google Ads plugs in here (Stage E); nothing else changes. */
const PROVIDERS: Record<string, AdsProvider> = { meta: metaAdsProvider, mock: mockAdsProvider };

export function adsProviderKeys(): string[] {
  return Object.keys(PROVIDERS).filter((k) => k !== 'mock' || !isProduction);
}

export function adsProvider(key: string): AdsProvider {
  const p = PROVIDERS[key];
  if (!p || (key === 'mock' && isProduction)) throw new Error(`Unknown ads provider "${key}"`);
  return p;
}

export type * from './ads.provider.js';
export { ProviderAuthError, ProviderRateLimitError } from './ads.provider.js';
