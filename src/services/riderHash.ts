/**
 * Deterministic hashes for rider-KYC identifiers (driving licence number,
 * bike registration, M-Pesa MSISDN). Same PBKDF2 construction as the
 * national-ID hash in src/services/kycHash.ts — different "context" string
 * so a value that happens to match across the two surfaces doesn't collide
 * by accident.
 */

import { pbkdf2Sync } from 'node:crypto';

const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_KEYLEN = 32;

export interface RiderHasher {
  hashLicenceNumber(value: string): string;
  hashBikeRegistration(value: string): string;
  hashMpesaMsisdn(value: string): string;
}

export function createRiderHasher(saltHex: string): RiderHasher {
  const salt = Buffer.from(saltHex, 'hex');
  if (salt.length === 0) {
    throw new Error('KYC_HASH_SALT must decode to at least 1 byte of hex');
  }
  const hash = (context: string, value: string): string =>
    pbkdf2Sync(
      `${context}:${normalise(value)}`,
      salt,
      PBKDF2_ITERATIONS,
      PBKDF2_KEYLEN,
      'sha256',
    ).toString('hex');
  return {
    hashLicenceNumber: (v) => hash('rider_licence', v),
    hashBikeRegistration: (v) => hash('rider_bike_reg', v),
    hashMpesaMsisdn: (v) => hash('rider_mpesa', v),
  };
}

/** Uppercase + strip whitespace + strip dashes/dots. Stable across operator entry variants. */
function normalise(value: string): string {
  return value.replace(/[\s.\-/]/g, '').toUpperCase();
}
