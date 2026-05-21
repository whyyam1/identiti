/**
 * Rider insurance verification — Itafika §15.1.4 (Sprint 2+).
 *
 * v1.0: stub. Validates that a policy number is present and the expiry
 * is in the future. Real adapter (per-vendor API or document OCR) is a
 * Sprint 2+ Track A item; insurance is OPTIONAL in the MVP submission
 * shape, so a submission without insurance simply lands as
 * `rider_tier_1` (vs. `rider_tier_2` when insurance is included and
 * verified).
 */

export interface InsuranceCheck {
  policyNumber: string;
  expiry: Date;
}

export type InsuranceVerdict =
  | { ok: true; vendorRef: string | null }
  | { ok: false; reason: string };

export interface InsuranceService {
  verify(input: InsuranceCheck): Promise<InsuranceVerdict>;
}

export function createStubInsuranceService(): InsuranceService {
  return {
    async verify({ policyNumber, expiry }) {
      if (!policyNumber || policyNumber.trim().length < 4) {
        return { ok: false, reason: 'insurance_policy_format' };
      }
      if (expiry.getTime() <= Date.now()) {
        return { ok: false, reason: 'insurance_expired' };
      }
      return { ok: true, vendorRef: null };
    },
  };
}
