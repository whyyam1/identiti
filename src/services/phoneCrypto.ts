/**
 * Phone-record cryptography.
 * Per Instruction Pack §6.2 / §9.2.
 *
 * - phone_hash: PBKDF2-SHA256(normalised_msisdn, PHONE_HASH_SALT, 100k, 32 bytes).
 *   Deterministic so we can enforce a UNIQUE constraint and look up by phone
 *   without storing or transmitting plaintext.
 * - phone_encrypted: AES-256-GCM with PHONE_ENCRYPTION_KEY. Random 96-bit IV per
 *   record. Layout = IV(12) || tag(16) || ciphertext, base64-encoded.
 *   Decryption is rail-internal only (Phase 6 phone-token resolution).
 */

import {
  createCipheriv,
  createDecipheriv,
  pbkdf2Sync,
  randomBytes,
} from 'node:crypto';

const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_KEYLEN = 32;
const AES_KEY_LEN = 32;
const AES_IV_LEN = 12;
const AES_TAG_LEN = 16;

export interface PhoneCryptoConfig {
  encryptionKeyHex: string; // 64 hex chars (32 bytes)
  hashSaltHex: string; // any-length hex; recommend 32 bytes (64 hex chars)
}

export interface PhoneCrypto {
  hash(normalisedMsisdn: string): string;
  encrypt(normalisedMsisdn: string): string;
  decrypt(envelope: string): string;
}

function decodeKey(keyHex: string): Buffer {
  const buf = Buffer.from(keyHex, 'hex');
  if (buf.length !== AES_KEY_LEN) {
    throw new Error(
      `PHONE_ENCRYPTION_KEY must decode to ${AES_KEY_LEN} bytes; got ${buf.length}`
    );
  }
  return buf;
}

export function createPhoneCrypto(cfg: PhoneCryptoConfig): PhoneCrypto {
  const key = decodeKey(cfg.encryptionKeyHex);
  const salt = Buffer.from(cfg.hashSaltHex, 'hex');
  if (salt.length === 0) {
    throw new Error('PHONE_HASH_SALT must decode to at least 1 byte of hex');
  }

  return {
    hash(normalisedMsisdn) {
      return pbkdf2Sync(
        normalisedMsisdn,
        salt,
        PBKDF2_ITERATIONS,
        PBKDF2_KEYLEN,
        'sha256'
      ).toString('hex');
    },

    encrypt(normalisedMsisdn) {
      const iv = randomBytes(AES_IV_LEN);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([
        cipher.update(normalisedMsisdn, 'utf8'),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();
      return Buffer.concat([iv, tag, ct]).toString('base64');
    },

    decrypt(envelope) {
      const buf = Buffer.from(envelope, 'base64');
      if (buf.length < AES_IV_LEN + AES_TAG_LEN + 1) {
        throw new Error('phone_encrypted envelope too short');
      }
      const iv = buf.subarray(0, AES_IV_LEN);
      const tag = buf.subarray(AES_IV_LEN, AES_IV_LEN + AES_TAG_LEN);
      const ct = buf.subarray(AES_IV_LEN + AES_TAG_LEN);
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    },
  };
}
