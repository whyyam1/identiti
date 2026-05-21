/**
 * Hashes for KYB identifiers (business registration number, KRA PIN).
 * Same PBKDF2 construction as `riderHash` / `kycHash` with a different
 * context string so a value that happens to match across surfaces can't
 * collide by accident.
 */

import { pbkdf2Sync } from 'node:crypto';

const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_KEYLEN = 32;

export interface KybHasher {
  hashBusinessRegistration(value: string): string;
  hashKraPin(value: string): string;
}

export function createKybHasher(saltHex: string): KybHasher {
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
    hashBusinessRegistration: (v) => hash('kyb_biz_reg', v),
    hashKraPin: (v) => hash('kyb_kra_pin', v),
  };
}

function normalise(value: string): string {
  return value.replace(/[\s.\-/]/g, '').toUpperCase();
}
