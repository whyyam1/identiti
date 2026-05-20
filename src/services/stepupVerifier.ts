/**
 * Step-up token verifier — local consumption.
 *
 * For Identiti consuming its OWN step-up tokens (e.g. operation_kind=
 * 'identiti.phone_change'), the verification path follows Schema Appendix
 * §16.3 steps 1-13 directly:
 *
 *   1. Decode header, find key by kid (we hold the keys; iterate through them).
 *   2. Verify signature with the matching public key.
 *   3-9. iss / aud / sub / iat-exp / nbf checks (jose handles iss + aud + exp + nbf).
 *   10. operation_kind matches the expected value.
 *   11. env matches our env (informational at v1.0; we check sub/aud are right).
 *   12. jti has not been seen before — atomically markConsumed in step_up_tokens.
 *   13. Mark consumed (done by step 12 success).
 *
 * Cross-rail consumers (KP, Todoku) maintain their own jti caches; this
 * verifier is for self-consumed tokens only.
 */

import { jwtVerify, type JWTPayload } from 'jose';
import type { JwtKeyPair } from './jwtKeys.js';
import type { StepUpTokensRepo } from '../repositories/types.js';

export interface StepupVerifierOptions {
  jwtKeys: readonly JwtKeyPair[];
  stepUpTokensRepo: StepUpTokensRepo;
  issuer: string;
}

export interface StepupVerificationRequest {
  token: string;
  expectedAudience: string;
  expectedSubject: string;
  expectedOperationKind: string;
}

export type StepupInvalidReason =
  | 'signature_invalid'
  | 'wrong_audience'
  | 'wrong_subject'
  | 'wrong_operation_kind'
  | 'replay_detected'
  | 'malformed';

export type StepupVerificationResult =
  | { kind: 'valid'; jti: string; claims: JWTPayload }
  | { kind: 'invalid'; reason: StepupInvalidReason }
  | { kind: 'expired' };

export interface StepupVerifier {
  /**
   * Full verification with single-use enforcement: verifies the token AND
   * atomically marks the JTI consumed. Use when the step-up token authorises
   * an action (e.g. phone change). A replayed JTI returns `replay_detected`.
   */
  verify(req: StepupVerificationRequest): Promise<StepupVerificationResult>;
  /**
   * Non-consuming verification — signature + iss/aud/exp/nbf + sub +
   * operation_kind, but NOT the single-use check. Use for the diagnostic
   * `POST /v1/stepup/tokens/validate` endpoint (Scaffold §14.4: a query, not
   * a guard). Never returns `replay_detected`.
   */
  inspect(req: StepupVerificationRequest): Promise<StepupVerificationResult>;
}

export function createStepupVerifier(opts: StepupVerifierOptions): StepupVerifier {
  /** Steps 1-11: signature + claim checks, no JTI consumption. */
  async function inspect(req: StepupVerificationRequest): Promise<StepupVerificationResult> {
    let payload: JWTPayload | null = null;
    let lastErr: { code?: string } | null = null;
    for (const k of opts.jwtKeys) {
      try {
        const result = await jwtVerify(req.token, k.publicKey, {
          issuer: opts.issuer,
          audience: req.expectedAudience,
        });
        payload = result.payload;
        break;
      } catch (e) {
        lastErr = e as { code?: string };
      }
    }
    if (!payload) {
      const code = lastErr?.code ?? '';
      if (code === 'ERR_JWT_EXPIRED') return { kind: 'expired' };
      if (code === 'ERR_JWT_CLAIM_VALIDATION_FAILED') {
        // jose throws this for issuer / audience mismatches and missing
        // required claims. We can't easily distinguish wrong_audience from
        // signature_invalid here, but audience mismatch is far more common
        // for a token that did pass signature.
        return { kind: 'invalid', reason: 'wrong_audience' };
      }
      return { kind: 'invalid', reason: 'signature_invalid' };
    }
    if (payload.sub !== req.expectedSubject) {
      return { kind: 'invalid', reason: 'wrong_subject' };
    }
    if ((payload as Record<string, unknown>).operation_kind !== req.expectedOperationKind) {
      return { kind: 'invalid', reason: 'wrong_operation_kind' };
    }
    const jti = typeof payload.jti === 'string' ? payload.jti : null;
    if (!jti) {
      return { kind: 'invalid', reason: 'malformed' };
    }
    return { kind: 'valid', jti, claims: payload };
  }

  return {
    inspect,
    async verify(req) {
      const result = await inspect(req);
      if (result.kind !== 'valid') return result;
      // Step 12-13: atomic single-use enforcement.
      const fresh = await opts.stepUpTokensRepo.markConsumed(result.jti, new Date());
      if (!fresh) {
        return { kind: 'invalid', reason: 'replay_detected' };
      }
      return result;
    },
  };
}
