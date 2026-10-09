/**
 * Normalization used for login, uniqueness and duplicate detection.
 * Stored "normalized" fields must always be produced by these functions.
 */

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Normalizes a phone number to E.164-like digits with a leading "+".
 *  "+91 98765-43210" → "+919876543210"
 *  "098765 43210"    → "+919876543210" (with default country code 91)
 *  "0091 9876543210" → "+919876543210"
 * Returns null when the input has too few digits to be a phone number.
 */
export function normalizePhone(phone: string, defaultCountryCode = '91'): string | null {
  const trimmed = phone.trim();
  const hasPlus = trimmed.startsWith('+');
  let digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;

  if (!hasPlus) {
    if (digits.startsWith('00')) {
      digits = digits.slice(2);
    } else {
      // Drop trunk prefix "0" used for national dialling.
      digits = digits.replace(/^0+/, '');
      // A bare national number gets the organization's default country code.
      if (digits.length <= 10) digits = `${defaultCountryCode}${digits}`;
    }
  }

  if (digits.length < 8 || digits.length > 15) return null;
  return `+${digits}`;
}

export function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

export function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
}
