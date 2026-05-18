/**
 * RS256 key management for customer-token JWTs (Phase 3), step-up tokens
 * (Phase 5), and ID-10 delegated-authority tokens.
 *
 * In production, keys come from secrets manager mounted at the configured PEM
 * paths and loaded via env. In dev/test, if no keys are provided, an ephemeral
 * 2048-bit RSA pair is generated at startup (with a loud warning) — fine for
 * isolated tests, never acceptable in production because tokens won't survive
 * a process restart.
 *
 * Two `keyClass` values:
 *   - `step_up` — issues customer + step-up tokens. `kid` is derived from the
 *     SPKI-DER hash so rotation is automatic on key change.
 *   - `delegated_authority` — issues tokens via POST /v1/internal/sign for
 *     Helpan AI per Delegated Authority Contract §6.3 + §8.1. `kid` is
 *     supplied literally (e.g. `helpan-da-2026-q2`) since the relying-party
 *     verifier parses the rotation epoch out of the kid string.
 *
 * Both kinds are published in the same /.well-known/jwks.json document; the
 * `kid` header on each token discriminates at verification time.
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

export type JwtKeyClass = 'step_up' | 'delegated_authority';

export interface JwtKeyPair {
  privateKey: KeyObject;
  publicKey: KeyObject;
  kid: string;
  keyClass: JwtKeyClass;
}

export interface LoadKeysOptions {
  privatePem?: string | undefined;
  publicPem?: string | undefined;
  /** Required when keyClass='delegated_authority'; optional otherwise (derived kid is used when absent). */
  kidOverride?: string | undefined;
  keyClass?: JwtKeyClass;
  ephemeralAllowed: boolean;
  logger: Logger;
}

export function loadOrGenerateKeys(opts: LoadKeysOptions): JwtKeyPair {
  const keyClass: JwtKeyClass = opts.keyClass ?? 'step_up';
  if (opts.privatePem && opts.publicPem) {
    const privateKey = createPrivateKey({ key: opts.privatePem, format: 'pem' });
    const publicKey = createPublicKey({ key: opts.publicPem, format: 'pem' });
    const kid = resolveKid(keyClass, opts.kidOverride, publicKey);
    return { privateKey, publicKey, kid, keyClass };
  }
  if (!opts.ephemeralAllowed) {
    throw new Error(`JWT key PEMs are required outside development/test (keyClass=${keyClass})`);
  }
  opts.logger.warn(
    `JWT PEMs not provided for keyClass=${keyClass} — generating ephemeral RS256 keypair. Tokens will not survive process restart. Acceptable for dev/test only.`,
  );
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = resolveKid(keyClass, opts.kidOverride, publicKey);
  return { privateKey, publicKey, kid, keyClass };
}

function resolveKid(
  keyClass: JwtKeyClass,
  override: string | undefined,
  publicKey: KeyObject,
): string {
  if (override && override.length > 0) return override;
  if (keyClass === 'delegated_authority') {
    // Strawman names a literal like `helpan-da-2026-q2`; default to a
    // deterministic prefix so dev/test runs without explicit config still get
    // a stable, distinguishable kid.
    return `helpan-da-${deriveKid(publicKey).slice(0, 8)}`;
  }
  return deriveKid(publicKey);
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
    }),
  );
  return { keys: out };
}
