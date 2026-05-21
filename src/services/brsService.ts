/**
 * Business Registration Service (BRS / e-Citizen) adapter — Kenya.
 *
 * v1.0 (sandbox): stub. Real BRS / e-Citizen API access is Track A
 * (newdocs §13.3-style procurement) and lands in Sprint 2+. The stub
 * validates the format of the business registration number + KRA PIN
 * only, no upstream call. A production guard rejects boot if
 * `BRS_STUB_MODE=false` in production without a real adapter wired —
 * same shape as IPRS / NTSA.
 *
 * Kenyan formats:
 *   - Business registration number: BRS-issued, 6-12 digits typically
 *     prefixed by registration type (CR-... / BN-... / LLP-...).
 *   - KRA PIN: `[PA][0-9]{9}[A-Z]` — P (personal) or A (corporate) +
 *     9 digits + 1 letter checksum.
 */

const BUSINESS_REGISTRATION_RE = /^(CR|BN|LLP|PVT)[0-9]{5,10}$/;
const KRA_PIN_RE = /^[PA][0-9]{9}[A-Z]$/;

export interface BrsCheck {
  businessRegistrationNumber: string;
  kraPin: string;
  businessType: 'sole_proprietor' | 'partnership' | 'company' | 'llp';
}

export type BrsVerdict =
  | { ok: true; vendorRef: string | null }
  | { ok: false; reason: string };

export interface BrsService {
  verify(input: BrsCheck): Promise<BrsVerdict>;
}

export function createStubBrsService(): BrsService {
  return {
    async verify({ businessRegistrationNumber, kraPin }) {
      const reg = normalise(businessRegistrationNumber);
      const pin = normalise(kraPin);
      if (!BUSINESS_REGISTRATION_RE.test(reg)) {
        return { ok: false, reason: 'business_registration_format' };
      }
      if (!KRA_PIN_RE.test(pin)) {
        return { ok: false, reason: 'kra_pin_format' };
      }
      return { ok: true, vendorRef: null };
    },
  };
}

function normalise(value: string): string {
  return value.replace(/[\s.\-/]/g, '').toUpperCase();
}
