/**
 * RS256 key management for customer-token JWTs (and Phase 5 step-up tokens).
 *
 * In production, keys come from secrets manager mounted at the configured PEM
 * paths and loaded via env. In dev/test, if no keys are provided, an ephemeral
 * 2048-bit RSA pair is generated at startup (with a loud warning) — fine for
 * isolated tests, never acceptable in production because tokens won't survive
 * a process restart.
 *
 * The `kid` is the SHA-256 of the SPKI-DER public key, base64url, truncated to
 * 16 chars — short enough to not bloat tokens, long enough to be collision-free
 * for the small set of keys a rail will ever publish.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto';
import { exportJWK } from 'jose';
import type { Logger } from '../lib/logger.js';

export interface JwtKeyPair {
  privateKey: KeyObject;
  publicKey: KeyObject;
  kid: string;
}

export interface LoadKeysOptions {
  privatePem?: string | undefined;
  publicPem?: string | undefined;
  ephemeralAllowed: boolean;
  logger: Logger;
}

export function loadOrGenerateKeys(opts: LoadKeysOptions): JwtKeyPair {
  if (opts.privatePem && opts.publicPem) {
    const privateKey = createPrivateKey({ key: opts.privatePem, format: 'pem' });
    const publicKey = createPublicKey({ key: opts.publicPem, format: 'pem' });
    return { privateKey, publicKey, kid: deriveKid(publicKey) };
  }
  if (!opts.ephemeralAllowed) {
    throw new Error(
      'JWT_PRIVATE_KEY_PEM and JWT_PUBLIC_KEY_PEM are required outside development/test'
    );
  }
  opts.logger.warn(
    'JWT_PRIVATE_KEY_PEM/JWT_PUBLIC_KEY_PEM not provided — generating ephemeral RS256 keypair. Tokens will not survive process restart. Acceptable for dev/test only.'
  );
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { privateKey, publicKey, kid: deriveKid(publicKey) };
}

function deriveKid(publicKey: KeyObject): string {
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('base64url').slice(0, 16);
}

export interface JwksDocument {
  keys: Array<Record<string, unknown>>;
}

export async function buildJwks(keys: readonly JwtKeyPair[]): Promise<JwksDocument> {
  const out = await Promise.all(
    keys.map(async (k) => {
      const jwk = await exportJWK(k.publicKey);
      return { ...jwk, kid: k.kid, use: 'sig', alg: 'RS256' };
    })
  );
  return { keys: out };
}
