/**
 * KYC identifier hashing (national_id and similar small-keyspace numeric
 * identifiers). PBKDF2-SHA256 with a platform salt — same construction as
 * phone_hash so search-by-hash without storing plaintext is possible while
 * a leaked DB doesn't yield rainbow-table-able IDs.
 *
 * Mirrors the phone_hash pattern in src/services/phoneCrypto.ts intentionally;
 * a future hardening pass may rotate to per-tenant or HKDF-derived keys.
 */

import { pbkdf2Sync } from 'node:crypto';

const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_KEYLEN = 32;

export interface KycHasher {
  hashNationalId(nationalId: string): string;
}

export function createKycHasher(saltHex: string): KycHasher {
  const salt = Buffer.from(saltHex, 'hex');
  if (salt.length === 0) {
    throw new Error('KYC_HASH_SALT must decode to at least 1 byte of hex');
  }
  return {
    hashNationalId(nationalId) {
      return pbkdf2Sync(
        nationalId,
        salt,
        PBKDF2_ITERATIONS,
        PBKDF2_KEYLEN,
        'sha256'
      ).toString('hex');
    },
  };
}
