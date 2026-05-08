/**
 * HS256 phone-token signer.
 *
 * Phone tokens are opaque JWTs apps pass to Todoku for SMS sends. They are
 * NOT verified locally by Todoku — it calls /v1/phone-tokens/resolve and
 * treats Identiti's response as authoritative (INTEGRATION_MAP §7.2). The
 * signature is defence-in-depth: any tampering with the JTI between issuance
 * and resolve will fail signature verification at /resolve.
 *
 * v1.0 uses a single master signing key. v1.1 hardening: per-account-per-
 * audience derived key (Instruction Pack §6.4) — `HMAC(master, sub|aud)` —
 * so a leaked one-customer key cannot forge tokens for another.
 */

import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import type { PhoneTokenAudience } from '../repositories/types.js';

export const PHONE_TOKEN_TTL_SECONDS = 15 * 60; // 15 minutes per ID-D-05

export interface PhoneTokenClaims {
  sub: string; // Account UUID
  jti: string; // pht_<ULID>; same as DB primary key
  audience: PhoneTokenAudience;
  issuer: string;
  expiresInSeconds?: number; // defaults to PHONE_TOKEN_TTL_SECONDS
}

export interface SignedPhoneToken {
  token: string;
  jti: string;
  issuedAt: Date;
  expiresAt: Date;
}

export interface PhoneTokenSigner {
  sign(claims: PhoneTokenClaims): Promise<SignedPhoneToken>;
  /**
   * Verify signature + claims. Does NOT check revocation or DB-side jti
   * existence — the resolve handler does that as a separate step.
   */
  verify(token: string, expectedAudience: PhoneTokenAudience): Promise<JWTPayload>;
}

export interface PhoneTokenSignerOptions {
  /** Master HMAC key bytes. >= 32 bytes recommended. */
  signingKey: Uint8Array;
  /** Identiti issuer URL — must match phoneTokenClaims.issuer. */
  issuer: string;
}

export function createPhoneTokenSigner(opts: PhoneTokenSignerOptions): PhoneTokenSigner {
  return {
    async sign(claims) {
      const issuedAt = new Date();
      const ttl = claims.expiresInSeconds ?? PHONE_TOKEN_TTL_SECONDS;
      const expiresAt = new Date(issuedAt.getTime() + ttl * 1000);
      const token = await new SignJWT({})
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setIssuer(claims.issuer)
        .setSubject(claims.sub)
        .setAudience(claims.audience)
        .setIssuedAt(Math.floor(issuedAt.getTime() / 1000))
        .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
        .setJti(claims.jti)
        .sign(opts.signingKey);
      return { token, jti: claims.jti, issuedAt, expiresAt };
    },
    async verify(token, expectedAudience) {
      const { payload } = await jwtVerify(token, opts.signingKey, {
        issuer: opts.issuer,
        audience: expectedAudience,
      });
      return payload;
    },
  };
}
