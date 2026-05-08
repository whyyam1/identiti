/**
 * E.164 Kenyan MSISDN normalisation.
 * Pattern per Rail Contract §1.1: `+254[17][0-9]{8}`.
 *
 * Inputs we accept and normalise:
 *   +254712345678 → +254712345678
 *   254712345678  → +254712345678
 *   0712345678    → +254712345678
 *   +254 712 345 678 → +254712345678
 *
 * Anything else returns null (caller maps to validation_phone_invalid).
 */

const E164_KE_RE = /^\+254[17][0-9]{8}$/;

export function normalisePhone(input: string): string | null {
  let v = input.trim().replace(/[\s\-()]/g, '');
  if (v.startsWith('00')) v = '+' + v.slice(2);
  if (v.startsWith('0')) v = '+254' + v.slice(1);
  else if (/^254\d/.test(v)) v = '+' + v;
  if (!E164_KE_RE.test(v)) return null;
  return v;
}
