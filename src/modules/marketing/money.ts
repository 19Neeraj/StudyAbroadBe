/** ISO 4217 currencies without minor units (Meta/Google report these as whole numbers). */
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'UGX', 'PYG', 'XAF', 'XOF']);

export const minorFactor = (currency?: string | null) => (currency && ZERO_DECIMAL.has(currency.toUpperCase()) ? 1 : 100);

/** Major units (e.g. 1234.56) → integer minor units; undefined stays undefined (unavailable). */
export function toMinor(amount: number | undefined | null, currency?: string | null): number | undefined {
  if (amount === undefined || amount === null || Number.isNaN(amount)) return undefined;
  return Math.round(amount * minorFactor(currency));
}

export function fromMinor(minor: number | null | undefined, currency?: string | null): number | null {
  return minor === undefined || minor === null ? null : minor / minorFactor(currency);
}

/** Removes anything that looks like a credential before an error is stored or shown. */
export function redact(message: string): string {
  return message
    .replace(/(access_token|token|secret|key|signature)=([^&\s]+)/gi, '$1=***')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer ***')
    .replace(/EAA[A-Za-z0-9]{20,}/g, '***')
    .slice(0, 500);
}
