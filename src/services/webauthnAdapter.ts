/**
 * WebAuthn (FIDO2) adapter — ID-17 (operator step-up factor).
 *
 * v1.0 (sandbox): `createStubWebauthnAdapter()`.
 *
 *   - `createChallenge()` mints 32 random bytes, base64url-encoded. Stored
 *     verbatim on `auth_challenges.factor_data.challenge_b64`.
 *
 *   - `verifyRegistration()` accepts the attestation envelope as opaque and
 *     records `attestation_format='stub'`. The credential public key is
 *     stored as the placeholder JWK `{kty: 'stub', credentialIdB64}` so
 *     production can detect and refuse stub creds on the path that flips
 *     `WEBAUTHN_STUB_MODE=false`.
 *
 *   - `verifyAssertion()` checks structural shape only:
 *       * referenced credential exists for the user
 *       * client_data_json parses, `type === 'webauthn.get'`, `challenge`
 *         matches the stored challenge, `origin` matches `WEBAUTHN_ORIGIN`
 *       * `signature` field is non-empty
 *     No CBOR parsing, no signature verification.
 *
 * The real adapter (post-v1.0) preserves this interface and wires
 * `@simplewebauthn/server` (or an equivalent) behind it. The route layer
 * is identical either way; only the adapter changes when
 * `WEBAUTHN_STUB_MODE=false`.
 *
 * Production guard: `buildApp` rejects boot if `WEBAUTHN_STUB_MODE=false`
 * but the stub adapter is what's wired (no real adapter shipped yet).
 */

import { randomBytes } from 'node:crypto';

export interface WebauthnChallenge {
  /** base64url-encoded 32-byte random server challenge. */
  challengeB64: string;
}

export interface WebauthnRegistrationInput {
  userId: string;
  /** Client-supplied authenticator response (we treat as opaque in stub). */
  attestationResponse: {
    /** Base64url of authenticator-emitted rawId; becomes the credential PK. */
    credentialIdB64: string;
    /** Base64url-encoded attestation object; opaque in stub. */
    attestationObjectB64?: string;
    /** Base64url-encoded clientDataJSON; opaque in stub. */
    clientDataJsonB64?: string;
    /** Optional informational transports list. */
    transports?: readonly string[];
  };
  /** Server-side challenge minted at /register/options time. */
  serverChallengeB64: string;
}

export interface WebauthnRegistrationOutcome {
  credentialIdB64: string;
  publicKeyJwk: Record<string, unknown>;
  attestationFormat: string;
  transports: readonly string[] | null;
}

export interface WebauthnAssertionInput {
  /** Base64url credentialId from the authenticator. */
  credentialIdB64: string;
  /** Base64url clientDataJSON. The adapter parses challenge + origin out of this. */
  clientDataJsonB64: string;
  /** Base64url authenticatorData. */
  authenticatorDataB64: string;
  /** Base64url signature. */
  signatureB64: string;
  /** Server challenge minted at /v1/stepup/challenges time. */
  serverChallengeB64: string;
  /** Stored credential against which to verify. */
  storedPublicKeyJwk: Record<string, unknown>;
  /** Stored signature counter; assertion counter must be >= this in real mode. */
  storedSignatureCounter: number;
}

export type WebauthnAssertionVerdict =
  | { ok: true; newSignatureCounter: number }
  | { ok: false; reason: string };

export interface WebauthnAdapter {
  mode: 'stub' | 'real';
  createChallenge(): WebauthnChallenge;
  verifyRegistration(
    input: WebauthnRegistrationInput,
  ): Promise<{ ok: true; outcome: WebauthnRegistrationOutcome } | { ok: false; reason: string }>;
  verifyAssertion(input: WebauthnAssertionInput): Promise<WebauthnAssertionVerdict>;
}

export interface StubAdapterOptions {
  origin: string;
}

interface ParsedClientDataJson {
  type: string;
  challenge: string;
  origin: string;
}

function parseClientDataJson(b64: string): ParsedClientDataJson | null {
  try {
    const json = Buffer.from(b64, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as Partial<ParsedClientDataJson>;
    if (
      typeof parsed.type !== 'string' ||
      typeof parsed.challenge !== 'string' ||
      typeof parsed.origin !== 'string'
    ) {
      return null;
    }
    return { type: parsed.type, challenge: parsed.challenge, origin: parsed.origin };
  } catch {
    return null;
  }
}

export function createStubWebauthnAdapter(opts: StubAdapterOptions): WebauthnAdapter {
  return {
    mode: 'stub',

    createChallenge() {
      const bytes = randomBytes(32);
      return { challengeB64: bytes.toString('base64url') };
    },

    async verifyRegistration(input) {
      const credId = input.attestationResponse.credentialIdB64;
      if (!credId || typeof credId !== 'string' || credId.length === 0) {
        return { ok: false, reason: 'webauthn_registration_missing_credential_id' };
      }
      // If clientDataJSON is provided, sanity-check it. Optional in stub.
      if (input.attestationResponse.clientDataJsonB64) {
        const cdj = parseClientDataJson(input.attestationResponse.clientDataJsonB64);
        if (!cdj) {
          return { ok: false, reason: 'webauthn_registration_client_data_invalid' };
        }
        if (cdj.type !== 'webauthn.create') {
          return { ok: false, reason: 'webauthn_registration_wrong_type' };
        }
        if (cdj.challenge !== input.serverChallengeB64) {
          return { ok: false, reason: 'webauthn_registration_challenge_mismatch' };
        }
        if (cdj.origin !== opts.origin) {
          return { ok: false, reason: 'webauthn_registration_origin_mismatch' };
        }
      }
      return {
        ok: true,
        outcome: {
          credentialIdB64: credId,
          publicKeyJwk: { kty: 'stub', credentialIdB64: credId },
          attestationFormat: 'stub',
          transports: input.attestationResponse.transports
            ? [...input.attestationResponse.transports]
            : null,
        },
      };
    },

    async verifyAssertion(input) {
      if (
        !input.credentialIdB64 ||
        !input.clientDataJsonB64 ||
        !input.authenticatorDataB64 ||
        !input.signatureB64
      ) {
        return { ok: false, reason: 'webauthn_assertion_missing_field' };
      }
      const cdj = parseClientDataJson(input.clientDataJsonB64);
      if (!cdj) return { ok: false, reason: 'webauthn_assertion_client_data_invalid' };
      if (cdj.type !== 'webauthn.get') {
        return { ok: false, reason: 'webauthn_assertion_wrong_type' };
      }
      if (cdj.challenge !== input.serverChallengeB64) {
        return { ok: false, reason: 'webauthn_assertion_challenge_mismatch' };
      }
      if (cdj.origin !== opts.origin) {
        return { ok: false, reason: 'webauthn_assertion_origin_mismatch' };
      }
      // The stored JWK must mark itself as a stub-issued credential. If it
      // doesn't, we are about to accept a presumed real credential without
      // verifying its signature — fail closed.
      if ((input.storedPublicKeyJwk['kty'] ?? '') !== 'stub') {
        return { ok: false, reason: 'webauthn_assertion_non_stub_credential' };
      }
      // No signature check in stub mode. Counter monotonic-bump preserved
      // so production swap-in produces an identical state diff.
      return { ok: true, newSignatureCounter: input.storedSignatureCounter + 1 };
    },
  };
}
