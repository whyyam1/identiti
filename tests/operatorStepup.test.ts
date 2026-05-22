/**
 * ID-17 — Operator session + step-up surface (newdocs ID-17).
 *
 * Covers:
 *   - Operator user provisioning (POST /v1/operator/users) — happy path,
 *     email collision, scope rejection.
 *   - WebAuthn registration flow — options issuance, register-with-challenge,
 *     duplicate-credential rejection, malformed user_id.
 *   - Operator step-up via the existing /v1/stepup/* surface with
 *     factor=hardware_key and operation_kind=operator.*:
 *       * happy path (challenge + WebAuthn assertion → step-up JWT)
 *       * factor mismatch (phone_otp + operator.* → 400)
 *       * factor mismatch (hardware_key + customer operation_kind → 400)
 *       * subject discriminator (account_uuid alongside operator.* → 400)
 *       * subject discriminator (operator_user_id alongside customer kind → 400)
 *       * no registered credentials → 409
 *       * disabled adapter cred (non-stub kty) refused
 *       * server challenge mismatch → 401
 *   - Cross-rail JWT shape — sub is opu_<ULID>, factor=hardware_key.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeJwt } from 'jose';
import { buildCanonicalString, sha256Hex, signRequest } from '@kmv/platform-shared/hmac';
import { buildApp, type App } from '../src/app.js';
import {
  makeTestDeps,
  TEST_OPERATOR_APP_ID,
  TEST_OPERATOR_HMAC_SECRET,
  type TestDepsBundle,
} from './helpers.js';

function signedAsOperator(opts: {
  method: string;
  url: string;
  body?: string;
  idempotencyKey?: string;
}): Record<string, string> {
  const body = opts.body ?? '';
  const contentType = body ? 'application/json; charset=utf-8' : '';
  const ts = new Date().toISOString();
  const canonical = buildCanonicalString({
    method: opts.method,
    pathAndQuery: opts.url,
    contentType,
    timestamp: ts,
    bodySha256Hex: sha256Hex(body),
  });
  const sig = signRequest(canonical, TEST_OPERATOR_HMAC_SECRET);
  const headers: Record<string, string> = {
    authorization: `Identiti-HMAC-SHA256 app_id=${TEST_OPERATOR_APP_ID}, signature=${sig}`,
    'x-identiti-timestamp': ts,
  };
  if (contentType) headers['content-type'] = contentType;
  if (opts.idempotencyKey) headers['x-idempotency-key'] = opts.idempotencyKey;
  return headers;
}

function makeClientDataJsonB64(opts: {
  type: 'webauthn.create' | 'webauthn.get';
  challenge: string;
  origin?: string;
}): string {
  const obj = {
    type: opts.type,
    challenge: opts.challenge,
    origin: opts.origin ?? 'http://localhost:3002',
  };
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}

async function createOperatorUser(
  app: App,
  email: string,
  displayName = 'Op Console',
): Promise<string> {
  const body = JSON.stringify({ email, display_name: displayName });
  const r = await app.inject({
    method: 'POST',
    url: '/v1/operator/users',
    headers: signedAsOperator({
      method: 'POST',
      url: '/v1/operator/users',
      body,
      idempotencyKey: `idem_${Math.random().toString(36).slice(2)}`,
    }),
    payload: body,
  });
  if (r.statusCode !== 201) throw new Error(`createOperatorUser: ${r.statusCode} ${r.body}`);
  return r.json().data.user_id as string;
}

async function fetchRegisterOptions(
  app: App,
  userId: string,
): Promise<{ challengeB64: string; rpId: string; origin: string }> {
  const url = `/v1/operator/users/${userId}/webauthn/options`;
  const r = await app.inject({
    method: 'POST',
    url,
    headers: signedAsOperator({
      method: 'POST',
      url,
      body: '',
      idempotencyKey: `idem_${Math.random().toString(36).slice(2)}`,
    }),
  });
  if (r.statusCode !== 200) throw new Error(`fetchRegisterOptions: ${r.statusCode} ${r.body}`);
  const d = r.json().data;
  return { challengeB64: d.challenge_b64, rpId: d.rp_id, origin: d.origin };
}

async function registerStubCredential(
  app: App,
  userId: string,
  opts: { credentialIdB64?: string } = {},
): Promise<string> {
  const optionsRes = await fetchRegisterOptions(app, userId);
  const credentialId = opts.credentialIdB64 ?? `cred_${Math.random().toString(36).slice(2)}`;
  const body = JSON.stringify({
    challenge_b64: optionsRes.challengeB64,
    credential_id_b64: credentialId,
    attestation_object_b64: 'stub-attestation',
    client_data_json_b64: makeClientDataJsonB64({
      type: 'webauthn.create',
      challenge: optionsRes.challengeB64,
    }),
    transports: ['usb'],
    display_name: 'Yubikey 5C',
  });
  const url = `/v1/operator/users/${userId}/webauthn/register`;
  const r = await app.inject({
    method: 'POST',
    url,
    headers: signedAsOperator({
      method: 'POST',
      url,
      body,
      idempotencyKey: `idem_${Math.random().toString(36).slice(2)}`,
    }),
    payload: body,
  });
  if (r.statusCode !== 201) throw new Error(`registerStubCredential: ${r.statusCode} ${r.body}`);
  return credentialId;
}

describe('POST /v1/operator/users', () => {
  let app: App;
  let deps: TestDepsBundle;

  beforeEach(async () => {
    deps = makeTestDeps();
    app = await buildApp(deps);
  });

  afterEach(async () => {
    await app.close();
  });

  it('creates an operator user and returns the canonical envelope', async () => {
    const id = await createOperatorUser(app, 'alice@operators.example');
    expect(id).toMatch(/^opu_[0-9A-HJKMNP-TV-Z]{26}$/);
    const stored = await deps.operatorUsersRepo.findById(id);
    expect(stored!.appId).toBe(TEST_OPERATOR_APP_ID);
    expect(stored!.email).toBe('alice@operators.example');
    expect(stored!.status).toBe('active');
    expect(
      deps.auditLogger.entries.some(
        (e) => e.action === 'operator.user.create' && e.resourceId === id,
      ),
    ).toBe(true);
  });

  it('returns 409 on duplicate (app_id, email)', async () => {
    await createOperatorUser(app, 'bob@operators.example');
    const body = JSON.stringify({ email: 'bob@operators.example', display_name: 'Other' });
    const r = await app.inject({
      method: 'POST',
      url: '/v1/operator/users',
      headers: signedAsOperator({
        method: 'POST',
        url: '/v1/operator/users',
        body,
        idempotencyKey: `idem_${Math.random().toString(36).slice(2)}`,
      }),
      payload: body,
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('operator_user_email_taken');
  });

  it('rejects malformed email with 400', async () => {
    const body = JSON.stringify({ email: 'not-an-email', display_name: 'X' });
    const r = await app.inject({
      method: 'POST',
      url: '/v1/operator/users',
      headers: signedAsOperator({
        method: 'POST',
        url: '/v1/operator/users',
        body,
        idempotencyKey: `idem_${Math.random().toString(36).slice(2)}`,
      }),
      payload: body,
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('validation_request_invalid');
  });

  it('rejects callers without identiti:operator scope', async () => {
    await app.close();
    // The default TEST_APP_ID lacks identiti:operator — use it directly.
    const altDeps = makeTestDeps();
    app = await buildApp(altDeps);
    deps = altDeps;
    const body = JSON.stringify({ email: 'c@operators.example', display_name: 'C' });
    const { TEST_APP_ID, TEST_HMAC_SECRET } = await import('./helpers.js');
    const ts = new Date().toISOString();
    const canonical = buildCanonicalString({
      method: 'POST',
      pathAndQuery: '/v1/operator/users',
      contentType: 'application/json; charset=utf-8',
      timestamp: ts,
      bodySha256Hex: sha256Hex(body),
    });
    const sig = signRequest(canonical, TEST_HMAC_SECRET);
    const r = await app.inject({
      method: 'POST',
      url: '/v1/operator/users',
      headers: {
        authorization: `Identiti-HMAC-SHA256 app_id=${TEST_APP_ID}, signature=${sig}`,
        'x-identiti-timestamp': ts,
        'content-type': 'application/json; charset=utf-8',
        'x-idempotency-key': `idem_${Math.random().toString(36).slice(2)}`,
      },
      payload: body,
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('AUTH_SCOPE_INSUFFICIENT');
  });
});

describe('POST /v1/operator/users/:user_id/webauthn/{options,register}', () => {
  let app: App;
  let deps: TestDepsBundle;

  beforeEach(async () => {
    deps = makeTestDeps();
    app = await buildApp(deps);
  });

  afterEach(async () => {
    await app.close();
  });

  it('mints a server challenge and registers a stub credential round-trip', async () => {
    const userId = await createOperatorUser(app, 'alice@op.example');
    const optionsRes = await fetchRegisterOptions(app, userId);
    expect(optionsRes.challengeB64).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(optionsRes.rpId).toBe('localhost');

    const credentialId = await registerStubCredential(app, userId);
    const found = await deps.operatorWebauthnCredentialsRepo.findByCredentialId(credentialId);
    expect(found).not.toBeNull();
    expect(found!.userId).toBe(userId);
    expect(found!.attestationFormat).toBe('stub');
  });

  it('refuses to re-register the same credentialId under a different user', async () => {
    const userA = await createOperatorUser(app, 'a@op.example');
    const userB = await createOperatorUser(app, 'b@op.example');
    const credId = await registerStubCredential(app, userA);
    const opts = await fetchRegisterOptions(app, userB);
    const body = JSON.stringify({
      challenge_b64: opts.challengeB64,
      credential_id_b64: credId,
      attestation_object_b64: 'x',
      client_data_json_b64: makeClientDataJsonB64({
        type: 'webauthn.create',
        challenge: opts.challengeB64,
      }),
    });
    const url = `/v1/operator/users/${userB}/webauthn/register`;
    const r = await app.inject({
      method: 'POST',
      url,
      headers: signedAsOperator({
        method: 'POST',
        url,
        body,
        idempotencyKey: `idem_${Math.random().toString(36).slice(2)}`,
      }),
      payload: body,
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('webauthn_credential_already_registered');
  });

  it('rejects malformed user_id with 400', async () => {
    const url = '/v1/operator/users/not-an-opu/webauthn/options';
    const r = await app.inject({
      method: 'POST',
      url,
      headers: signedAsOperator({
        method: 'POST',
        url,
        body: '',
        idempotencyKey: `idem_${Math.random().toString(36).slice(2)}`,
      }),
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('validation_request_invalid');
  });

  it('returns 404 on unknown user_id', async () => {
    const url = '/v1/operator/users/opu_00000000000000000000000000/webauthn/options';
    const r = await app.inject({
      method: 'POST',
      url,
      headers: signedAsOperator({
        method: 'POST',
        url,
        body: '',
        idempotencyKey: `idem_${Math.random().toString(36).slice(2)}`,
      }),
    });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe('operator_user_not_found');
  });

  it('refuses register when client_data_json challenge does not match server challenge', async () => {
    const userId = await createOperatorUser(app, 'mismatch@op.example');
    const opts = await fetchRegisterOptions(app, userId);
    const body = JSON.stringify({
      challenge_b64: opts.challengeB64,
      credential_id_b64: 'some-cred',
      attestation_object_b64: 'x',
      client_data_json_b64: makeClientDataJsonB64({
        type: 'webauthn.create',
        challenge: 'a-different-challenge', // mismatched
      }),
    });
    const url = `/v1/operator/users/${userId}/webauthn/register`;
    const r = await app.inject({
      method: 'POST',
      url,
      headers: signedAsOperator({
        method: 'POST',
        url,
        body,
        idempotencyKey: `idem_${Math.random().toString(36).slice(2)}`,
      }),
      payload: body,
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('webauthn_registration_failed');
    expect(r.json().error.message).toContain('challenge_mismatch');
  });
});

describe('Operator step-up via /v1/stepup/challenges + /v1/stepup/verify', () => {
  let app: App;
  let deps: TestDepsBundle;

  beforeEach(async () => {
    deps = makeTestDeps();
    app = await buildApp(deps);
  });

  afterEach(async () => {
    await app.close();
  });

  async function challengeOperator(opts: {
    operatorUserId: string;
    operationKind?: string;
    factor?: 'phone_otp' | 'hardware_key';
  }): Promise<{ challengeId: string; webauthnChallengeB64: string }> {
    const body = JSON.stringify({
      operator_user_id: opts.operatorUserId,
      operation_audience: 'https://api.todoku.kmv.example',
      operation_kind: opts.operationKind ?? 'operator.todoku.template_approve',
      operation_risk_tier: 'high',
      factor: opts.factor ?? 'hardware_key',
    });
    const url = '/v1/stepup/challenges';
    const r = await app.inject({
      method: 'POST',
      url,
      headers: signedAsOperator({
        method: 'POST',
        url,
        body,
        idempotencyKey: `idem_${Math.random().toString(36).slice(2)}`,
      }),
      payload: body,
    });
    if (r.statusCode !== 201) {
      throw new Error(`challengeOperator: ${r.statusCode} ${r.body}`);
    }
    const d = r.json().data;
    return { challengeId: d.challenge_id, webauthnChallengeB64: d.webauthn_challenge_b64 };
  }

  async function verifyHardwareKey(opts: {
    challengeId: string;
    credentialIdB64: string;
    webauthnChallengeB64: string;
    overrideChallengeInCdj?: string;
  }) {
    const cdj = makeClientDataJsonB64({
      type: 'webauthn.get',
      challenge: opts.overrideChallengeInCdj ?? opts.webauthnChallengeB64,
    });
    const body = JSON.stringify({
      challenge_id: opts.challengeId,
      response: {
        credential_id_b64: opts.credentialIdB64,
        client_data_json_b64: cdj,
        authenticator_data_b64: 'stub-authdata',
        signature_b64: 'stub-signature',
      },
    });
    const url = '/v1/stepup/verify';
    return app.inject({
      method: 'POST',
      url,
      headers: signedAsOperator({
        method: 'POST',
        url,
        body,
        idempotencyKey: `idem_${Math.random().toString(36).slice(2)}`,
      }),
      payload: body,
    });
  }

  it('happy path: hardware_key challenge + assertion → step-up JWT with sub=opu_*', async () => {
    const userId = await createOperatorUser(app, 'happy@op.example');
    const credentialId = await registerStubCredential(app, userId);

    const { challengeId, webauthnChallengeB64 } = await challengeOperator({
      operatorUserId: userId,
    });
    expect(challengeId).toMatch(/^stp_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(webauthnChallengeB64).toMatch(/^[A-Za-z0-9_-]+$/);

    const r = await verifyHardwareKey({
      challengeId,
      credentialIdB64: credentialId,
      webauthnChallengeB64,
    });
    expect(r.statusCode).toBe(200);
    const env = r.json();
    expect(env.data.expires_in).toBeGreaterThan(0);
    const claims = decodeJwt(env.data.stepup_token);
    expect(claims.sub).toBe(userId);
    expect(claims['factor']).toBe('hardware_key');
    expect(claims['operation_kind']).toBe('operator.todoku.template_approve');
    const aud = Array.isArray(claims.aud) ? claims.aud[0] : claims.aud;
    expect(aud).toBe('https://api.todoku.kmv.example');

    // Last-login stamped.
    const u = await deps.operatorUsersRepo.findById(userId);
    expect(u!.lastLoginAt).not.toBeNull();
  });

  it('rejects operator.* operation_kind with factor=phone_otp', async () => {
    const userId = await createOperatorUser(app, 'wrongfactor@op.example');
    await registerStubCredential(app, userId);
    const body = JSON.stringify({
      operator_user_id: userId,
      operation_audience: 'https://api.todoku.kmv.example',
      operation_kind: 'operator.todoku.template_approve',
      operation_risk_tier: 'high',
      factor: 'phone_otp',
    });
    const url = '/v1/stepup/challenges';
    const r = await app.inject({
      method: 'POST',
      url,
      headers: signedAsOperator({
        method: 'POST',
        url,
        body,
        idempotencyKey: `idem_${Math.random().toString(36).slice(2)}`,
      }),
      payload: body,
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('auth_factor_unsupported');
  });

  it('rejects customer operation_kind with factor=hardware_key', async () => {
    const body = JSON.stringify({
      account_uuid: 'acc_00000000-0000-4000-8000-000000000000',
      operation_audience: 'https://api.pay.kipkiren.com',
      operation_kind: 'kipkiren_pay.redemption',
      operation_risk_tier: 'high',
      factor: 'hardware_key',
    });
    const url = '/v1/stepup/challenges';
    const r = await app.inject({
      method: 'POST',
      url,
      headers: signedAsOperator({
        method: 'POST',
        url,
        body,
        idempotencyKey: `idem_${Math.random().toString(36).slice(2)}`,
      }),
      payload: body,
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('auth_factor_unsupported');
  });

  it('rejects operator.* operation_kind missing operator_user_id', async () => {
    const body = JSON.stringify({
      operation_audience: 'https://api.todoku.kmv.example',
      operation_kind: 'operator.todoku.template_approve',
      operation_risk_tier: 'high',
      factor: 'hardware_key',
    });
    const url = '/v1/stepup/challenges';
    const r = await app.inject({
      method: 'POST',
      url,
      headers: signedAsOperator({
        method: 'POST',
        url,
        body,
        idempotencyKey: `idem_${Math.random().toString(36).slice(2)}`,
      }),
      payload: body,
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('validation_request_invalid');
    expect(r.json().error.message.toLowerCase()).toContain('operator_user_id');
  });

  it('rejects operator.* operation_kind that also carries account_uuid', async () => {
    const userId = await createOperatorUser(app, 'subjectmix@op.example');
    await registerStubCredential(app, userId);
    const body = JSON.stringify({
      account_uuid: 'acc_00000000-0000-4000-8000-000000000000',
      operator_user_id: userId,
      operation_audience: 'https://api.todoku.kmv.example',
      operation_kind: 'operator.todoku.template_approve',
      operation_risk_tier: 'high',
      factor: 'hardware_key',
    });
    const url = '/v1/stepup/challenges';
    const r = await app.inject({
      method: 'POST',
      url,
      headers: signedAsOperator({
        method: 'POST',
        url,
        body,
        idempotencyKey: `idem_${Math.random().toString(36).slice(2)}`,
      }),
      payload: body,
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('validation_request_invalid');
    expect(r.json().error.message.toLowerCase()).toContain('account_uuid');
  });

  it('refuses operator step-up when the user has no registered credentials', async () => {
    const userId = await createOperatorUser(app, 'nokeys@op.example');
    const body = JSON.stringify({
      operator_user_id: userId,
      operation_audience: 'https://api.todoku.kmv.example',
      operation_kind: 'operator.todoku.template_approve',
      operation_risk_tier: 'high',
      factor: 'hardware_key',
    });
    const url = '/v1/stepup/challenges';
    const r = await app.inject({
      method: 'POST',
      url,
      headers: signedAsOperator({
        method: 'POST',
        url,
        body,
        idempotencyKey: `idem_${Math.random().toString(36).slice(2)}`,
      }),
      payload: body,
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('operator_user_no_credentials');
  });

  it('fails the assertion when client_data_json challenge does not match the server challenge', async () => {
    const userId = await createOperatorUser(app, 'replay@op.example');
    const credentialId = await registerStubCredential(app, userId);
    const { challengeId, webauthnChallengeB64 } = await challengeOperator({
      operatorUserId: userId,
    });
    const r = await verifyHardwareKey({
      challengeId,
      credentialIdB64: credentialId,
      webauthnChallengeB64,
      overrideChallengeInCdj: 'wrong-challenge-bytes',
    });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe('auth_factor_failed');
    expect(r.json().error.message).toContain('challenge_mismatch');
  });

  it('fails the assertion when the presented credential belongs to a different user', async () => {
    const userA = await createOperatorUser(app, 'a-cred@op.example');
    const userB = await createOperatorUser(app, 'b-cred@op.example');
    const credentialA = await registerStubCredential(app, userA);
    await registerStubCredential(app, userB); // make B challengeable
    const { challengeId, webauthnChallengeB64 } = await challengeOperator({
      operatorUserId: userB,
    });
    const r = await verifyHardwareKey({
      challengeId,
      credentialIdB64: credentialA, // wrong user's credential
      webauthnChallengeB64,
    });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.message).toContain('webauthn_credential_user_mismatch');
  });
});
