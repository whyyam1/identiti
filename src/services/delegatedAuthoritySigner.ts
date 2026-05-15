/**
 * Delegated-Authority RS256 signer (ID-10).
 *
 * Per Helpan AI Delegated Authority Contract v1.0 §2 (token format) + §6.3
 * (internal signing API):
 *
 *   Helpan AI POSTs /v1/internal/sign with {kid, claims}; Identiti signs the
 *   pre-formed claim set using its delegated-authority key (keyClass='delegated_authority')
 *   and returns {token, signed_at}.
 *
 * Identiti's role is signer + auditor — not claim-author. Helpan AI authors the
 * claim set per §3 (issuance flow) since it owns the agent registry, scope
 * catalogue, and per-scope limits. Identiti's job is to:
 *
 *   1. Verify the kid points at a known DA key.
 *   2. Enforce the server-side invariants in §2.4 — iss, token_class, exp/iat
 *      bounds — that the relying-party verifier will rely on.
 *   3. Sign with the matched key.
 *   4. Hand back the JWT and the signed_at timestamp.
 *
 * Per-scope-class exp bounds (§3.5):
 *   - Money scopes (kipkiren.write.*, chapaa.write.*, chapaa.mmf.*):     ≤3600s
 *   - Identity-sensitive scopes (identiti.write.*, chapaa.read.behavioural): ≤900s
 *   - Read-only scopes (*.read.aggregate, *.read.position):              ≤86400s
 *
 * The tightest matching bound across all scopes in the claim wins.
 */

import { SignJWT } from 'jose';
import type { JwtKeyPair } from './jwtKeys.js';
import type { DelegatedAuthorityScope } from '../repositories/types.js';

export const DA_TOKEN_CLASS = 'delegated_authority' as const;

export const DA_MAX_TTL_MONEY_SECONDS = 3600;
export const DA_MAX_TTL_IDENTITY_SECONDS = 900;
export const DA_MAX_TTL_READ_ONLY_SECONDS = 86_400;

export interface DelegatedAuthorityActor {
  type: 'agent';
  agent_id: string;
}

export interface DelegatedAuthorityClaimSet {
  iss: string;
  aud: readonly string[];
  sub: string;
  iat: number;
  exp: number;
  jti: string;
  token_class: typeof DA_TOKEN_CLASS;
  actor: DelegatedAuthorityActor;
  initiated_by: 'agent';
  scopes: readonly DelegatedAuthorityScope[];
  step_up_jti?: string;
  revocation_endpoint: string;
}

export interface DelegatedAuthoritySignRequest {
  kid: string;
  claims: DelegatedAuthorityClaimSet;
}

export interface DelegatedAuthoritySignResult {
  token: string;
  signedAt: Date;
  expiresAt: Date;
}

export type DelegatedAuthoritySignError =
  | { code: 'kid_unknown'; message: string }
  | { code: 'wrong_token_class'; message: string }
  | { code: 'issuer_mismatch'; message: string }
  | { code: 'expiry_out_of_bounds'; message: string }
  | { code: 'iat_in_future'; message: string }
  | { code: 'scopes_empty'; message: string };

export interface DelegatedAuthoritySigner {
  sign(
    req: DelegatedAuthoritySignRequest
  ): Promise<
    | { ok: true; result: DelegatedAuthoritySignResult }
    | { ok: false; error: DelegatedAuthoritySignError }
  >;
}

export interface DelegatedAuthoritySignerOptions {
  daKeys: readonly JwtKeyPair[];
  expectedIssuer: string;
  /** Allow `iat` up to this many seconds in the future to absorb clock skew. */
  clockSkewToleranceSeconds?: number;
}

export function createDelegatedAuthoritySigner(
  opts: DelegatedAuthoritySignerOptions
): DelegatedAuthoritySigner {
  const tolerance = opts.clockSkewToleranceSeconds ?? 60;
  return {
    async sign(req) {
      const keyPair = opts.daKeys.find(
        (k) => k.keyClass === 'delegated_authority' && k.kid === req.kid
      );
      if (!keyPair) {
        return {
          ok: false,
          error: {
            code: 'kid_unknown',
            message: `No delegated-authority signing key with kid=${req.kid}`,
          },
        };
      }

      if (req.claims.token_class !== DA_TOKEN_CLASS) {
        return {
          ok: false,
          error: {
            code: 'wrong_token_class',
            message: `token_class must be '${DA_TOKEN_CLASS}'; got '${req.claims.token_class}'`,
          },
        };
      }

      if (req.claims.iss !== opts.expectedIssuer) {
        return {
          ok: false,
          error: {
            code: 'issuer_mismatch',
            message: `iss must be '${opts.expectedIssuer}'; got '${req.claims.iss}'`,
          },
        };
      }

      if (req.claims.scopes.length === 0) {
        return {
          ok: false,
          error: { code: 'scopes_empty', message: 'scopes must contain at least one entry' },
        };
      }

      const nowSec = Math.floor(Date.now() / 1000);
      if (req.claims.iat > nowSec + tolerance) {
        return {
          ok: false,
          error: {
            code: 'iat_in_future',
            message: `iat ${req.claims.iat} is more than ${tolerance}s in the future (now=${nowSec})`,
          },
        };
      }

      const ttl = req.claims.exp - req.claims.iat;
      const maxTtl = maxTtlForScopes(req.claims.scopes);
      if (ttl <= 0) {
        return {
          ok: false,
          error: {
            code: 'expiry_out_of_bounds',
            message: `exp (${req.claims.exp}) must be greater than iat (${req.claims.iat})`,
          },
        };
      }
      if (ttl > maxTtl) {
        return {
          ok: false,
          error: {
            code: 'expiry_out_of_bounds',
            message: `ttl ${ttl}s exceeds per-scope-class max ${maxTtl}s for the tightest scope in the request`,
          },
        };
      }

      const payload: Record<string, unknown> = {
        token_class: DA_TOKEN_CLASS,
        actor: { type: req.claims.actor.type, agent_id: req.claims.actor.agent_id },
        initiated_by: req.claims.initiated_by,
        scopes: req.claims.scopes.map((s) => ({ ...s })),
        revocation_endpoint: req.claims.revocation_endpoint,
      };
      if (req.claims.step_up_jti) {
        payload.step_up_jti = req.claims.step_up_jti;
      }

      const token = await new SignJWT(payload)
        .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: keyPair.kid })
        .setIssuer(req.claims.iss)
        .setAudience([...req.claims.aud])
        .setSubject(req.claims.sub)
        .setIssuedAt(req.claims.iat)
        .setExpirationTime(req.claims.exp)
        .setJti(req.claims.jti)
        .sign(keyPair.privateKey);

      return {
        ok: true,
        result: {
          token,
          signedAt: new Date(req.claims.iat * 1000),
          expiresAt: new Date(req.claims.exp * 1000),
        },
      };
    },
  };
}

/**
 * Return the tightest per-scope-class TTL (seconds) for the given scope list.
 * Walks each scope_id; if any falls into the money/identity-sensitive bucket,
 * the bound for that bucket caps the entire token (a token authorising both
 * a money scope and a read-only scope must respect the money bound).
 */
function maxTtlForScopes(scopes: readonly DelegatedAuthorityScope[]): number {
  let cap = DA_MAX_TTL_READ_ONLY_SECONDS;
  for (const s of scopes) {
    const c = scopeTtlCap(s.scope_id);
    if (c < cap) cap = c;
  }
  return cap;
}

function scopeTtlCap(scopeId: string): number {
  if (/^(kipkiren|chapaa)\.write\./.test(scopeId)) return DA_MAX_TTL_MONEY_SECONDS;
  if (/^chapaa\.mmf\./.test(scopeId)) return DA_MAX_TTL_MONEY_SECONDS;
  if (/^identiti\.write\./.test(scopeId)) return DA_MAX_TTL_IDENTITY_SECONDS;
  if (scopeId === 'chapaa.read.behavioural') return DA_MAX_TTL_IDENTITY_SECONDS;
  return DA_MAX_TTL_READ_ONLY_SECONDS;
}
