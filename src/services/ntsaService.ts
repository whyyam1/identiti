/**
 * NTSA TIMS adapter — driving licence + motorbike registration verification.
 *
 * v1.0 (sandbox): stub only. NTSA TIMS API access is Track A (Itafika §15.1
 * marks the real adapter as optional Sprint 2+). The stub validates format
 * + future-expiry only; no upstream call. A production guard rejects boot
 * if `NTSA_STUB_MODE=false` in production without a real adapter wired —
 * same shape as IPRS.
 */

/** Kenyan driving licence number — uppercase letters + 5–9 digits is the common rendering. */
const LICENCE_NUMBER_RE = /^[A-Z]{1,3}[0-9]{4,9}$/;

/** Kenyan motorbike plate — KMC 123A, KMCA 1234, KBC 1234B, etc. */
const BIKE_REGISTRATION_RE = /^[A-Z]{2,4}[0-9]{3,5}[A-Z]?$/;

const RIDER_LICENCE_CLASSES = new Set(['A', 'A1', 'A2', 'A3', 'B', 'C', 'D', 'E']);

export interface NtsaLicenceCheck {
  licenceNumber: string;
  licenceClass: string;
  licenceExpiry: Date;
}

export interface NtsaBikeCheck {
  registrationNumber: string;
  make?: string;
  model?: string;
}

export type NtsaVerdict = { ok: true; vendorRef: string | null } | { ok: false; reason: string };

export interface NtsaService {
  verifyLicence(input: NtsaLicenceCheck): Promise<NtsaVerdict>;
  verifyBikeRegistration(input: NtsaBikeCheck): Promise<NtsaVerdict>;
}

export function createStubNtsaService(): NtsaService {
  return {
    async verifyLicence({ licenceNumber, licenceClass, licenceExpiry }) {
      const n = normalise(licenceNumber);
      if (!LICENCE_NUMBER_RE.test(n)) {
        return { ok: false, reason: 'licence_number_format' };
      }
      if (!RIDER_LICENCE_CLASSES.has(licenceClass.toUpperCase())) {
        return { ok: false, reason: 'licence_class_unsupported' };
      }
      if (licenceExpiry.getTime() <= Date.now()) {
        return { ok: false, reason: 'licence_expired' };
      }
      return { ok: true, vendorRef: null };
    },

    async verifyBikeRegistration({ registrationNumber }) {
      const n = normalise(registrationNumber);
      if (!BIKE_REGISTRATION_RE.test(n)) {
        return { ok: false, reason: 'bike_registration_format' };
      }
      return { ok: true, vendorRef: null };
    },
  };
}

function normalise(value: string): string {
  return value.replace(/[\s.\-/]/g, '').toUpperCase();
}
