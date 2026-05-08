/**
 * RS256 token signer — customer tokens (Phase 3) + step-up tokens (Phase 5).
 *
 * Customer-token claims: Schema Appendix §2.7 — iss, aud (multi: identiti +
 * consuming app), sub (account_uuid), iat, exp, jti, scope, tier, session_kind,
 * session_id, auth_factors, env, phone_token (Phase 6).
 *
 * Step-up token claims: Schema Appendix §16.2 — iss, aud (single-element:
 * operation_audience), sub, iat, exp, nbf=iat, jti (= challenge_id),
 * operation_kind, operation_risk_tier, factor, challenge_id, env. Plus
 * optional Amendment §A.1/§A.2 claims `actor` + `initiated_by` — emission
 * path is wired here; request-side population lands with ID-10 (H4 joint).
 */

import { SignJWT } from 'jose';
import type { JwtKeyPair } from './jwtKeys.js';
import type { ActorType, InitiatedBy, RiskTier, StepUpActor } from '../repositories/types.js';

export interface CustomerTokenClaims {
  sub: string;
  jti: string;
  audience: string[];
  scope: readonly string[];
  tier: 'tier_0' | 'tier_1' | 'tier_2';
  sessionKind: 'primary' | 'stepup';
  sessionId: string;
  authFactors: readonly string[];
  env: string;
  expiresInSeconds: number;
  phoneToken?: string;
}

export interface StepupTokenClaims {
  sub: string;
  /** Schema Appendix §14.5: jti = challenge_id. */
  jti: string;
  challengeId: string;
  audience: string;
  operationKind: string;
  operationRiskTier: RiskTier;
  factor: 'phone_otp' | 'hardware_key' | 'passive_biometric';
  env: string;
  expiresInSeconds: number;
  /** Amendment §A.1 — populated when a Helpan AI agent dispatched the step-up. */
  actor?: StepUpActor;
  /** Amendment §A.2 — originating intent class. Distinct from actor. */
  initiatedBy?: InitiatedBy;
}

export interface JwtSigner {
  signCustomerToken(claims: CustomerTokenClaims): Promise<{
    token: string;
    issuedAt: Date;
    expiresAt: Date;
  }>;
  signStepupToken(claims: StepupTokenClaims): Promise<{
    token: string;
    issuedAt: Date;
    expiresAt: Date;
  }>;
}

export interface JwtSignerOptions {
  keyPair: JwtKeyPair;
  issuer: string;
}

export function createJwtSigner(opts: JwtSignerOptions): JwtSigner {
  return {
    async signCustomerToken(claims) {
      const issuedAt = new Date();
      const expiresAt = new Date(issuedAt.getTime() + claims.expiresInSeconds * 1000);

      const payload: Record<string, unknown> = {
        sub: claims.sub,
        scope: [...claims.scope],
        tier: claims.tier,
        session_kind: claims.sessionKind,
        session_id: claims.sessionId,
        auth_factors: [...claims.authFactors],
        env: claims.env,
      };
      if (claims.phoneToken) {
        payload.phone_token = claims.phoneToken;
      }

      const token = await new SignJWT(payload)
        .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: opts.keyPair.kid })
        .setIssuer(opts.issuer)
        .setAudience(claims.audience)
        .setSubject(claims.sub)
        .setIssuedAt(Math.floor(issuedAt.getTime() / 1000))
        .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
        .setJti(claims.jti)
        .sign(opts.keyPair.privateKey);

      return { token, issuedAt, expiresAt };
    },

    async signStepupToken(claims) {
      const issuedAt = new Date();
      const expiresAt = new Date(issuedAt.getTime() + claims.expiresInSeconds * 1000);
      const iatSec = Math.floor(issuedAt.getTime() / 1000);

      const payload: Record<string, unknown> = {
        operation_kind: claims.operationKind,
        operation_risk_tier: claims.operationRiskTier,
        factor: claims.factor,
        challenge_id: claims.challengeId,
        env: claims.env,
      };
      if (claims.actor) {
        const actor: Record<string, unknown> = { type: claims.actor.type as ActorType };
        if (claims.actor.agentId) actor.agent_id = claims.actor.agentId;
        if (claims.actor.delegatedAuthorityJti) {
          actor.delegated_authority_jti = claims.actor.delegatedAuthorityJti;
        }
        payload.actor = actor;
      }
      if (claims.initiatedBy) {
        payload.initiated_by = claims.initiatedBy;
      }

      const token = await new SignJWT(payload)
        .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: opts.keyPair.kid })
        .setIssuer(opts.issuer)
        .setAudience([claims.audience])
        .setSubject(claims.sub)
        .setIssuedAt(iatSec)
        .setNotBefore(iatSec)
        .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
        .setJti(claims.jti)
        .sign(opts.keyPair.privateKey);

      return { token, issuedAt, expiresAt };
    },
  };
}
