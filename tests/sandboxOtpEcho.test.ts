/**
 * Sandbox OTP echo (Lunch Drop integrator request, 22 May 2026).
 *
 * `POST /v1/stepup/challenges` echoes `otp_plaintext` in the response body
 * when `env != production` AND `factor=phone_otp`. Production strips the
 * field — the SMS gateway is then the only delivery path. The echoed value
 * MUST equal the OTP that subsequently verifies via `/v1/stepup/verify`,
 * AND MUST equal the `otp_plaintext` carried on the `STEP_UP_REQUIRED`
 * Kafka payload (the existing Todoku delivery channel).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { buildCanonicalString, sha256Hex, signRequest } from '@kmv/platform-shared/hmac';
import { buildApp, type App } from '../src/app.js';
import { makeTestDeps, TEST_APP_ID, TEST_HMAC_SECRET, type TestDepsBundle } from './helpers.js';

const KP_AUDIENCE = 'https://api.pay.kipkiren.com';

function signed(opts: {
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
  const sig = signRequest(canonical, TEST_HMAC_SECRET);
  const headers: Record<string, string> = {
    authorization: `Identiti-HMAC-SHA256 app_id=${TEST_APP_ID}, signature=${sig}`,
    'x-identiti-timestamp': ts,
  };
  if (contentType) headers['content-type'] = contentType;
  if (opts.idempotencyKey) headers['x-idempotency-key'] = opts.idempotencyKey;
  return headers;
}

async function createActiveCustomer(
  app: App,
  deps: TestDepsBundle,
  phone: string,
): Promise<string> {
  const body = JSON.stringify({
    phone,
    name_first: 'Lunch',
    name_last: 'Drop',
    consent: { dpa_consent: true, kyc_consent: true, captured_at: new Date().toISOString() },
    app_correlation: `corr_${Math.random().toString(36).slice(2)}`,
  });
  const r = await app.inject({
    method: 'POST',
    url: '/v1/customers',
    headers: signed({
      method: 'POST',
      url: '/v1/customers',
      body,
      idempotencyKey: `idem_${Math.random().toString(36).slice(2)}`,
    }),
    payload: body,
  });
  if (r.statusCode !== 201) throw new Error(`createCustomer: ${r.statusCode} ${r.body}`);
  const accountUuid = r.json().data.account_uuid as string;
  // Step-up requires state='active'; new customers land in 'pending_onboarding'.
  const ok = await deps.customersRepo.changeState(accountUuid, ['pending_onboarding'], 'active');
  if (!ok) throw new Error('failed to activate test account');
  return accountUuid;
}

async function challengeStepup(app: App, uuid: string) {
  const body = JSON.stringify({
    account_uuid: uuid,
    operation_audience: KP_AUDIENCE,
    operation_kind: 'kipkiren_pay.redemption',
    operation_risk_tier: 'high',
    factor: 'phone_otp',
  });
  return app.inject({
    method: 'POST',
    url: '/v1/stepup/challenges',
    headers: signed({
      method: 'POST',
      url: '/v1/stepup/challenges',
      body,
      idempotencyKey: `idem_${Math.random().toString(36).slice(2)}`,
    }),
    payload: body,
  });
}

describe('POST /v1/stepup/challenges — sandbox otp_plaintext echo', () => {
  let app: App;
  let deps: TestDepsBundle;

  afterEach(async () => {
    await app.close();
  });

  it('echoes otp_plaintext + sandbox_only=true when env=test (factor=phone_otp)', async () => {
    deps = makeTestDeps();
    app = await buildApp(deps);
    const uuid = await createActiveCustomer(app, deps,'+254712700001');

    const before = deps.eventProducer.events.length;
    const r = await challengeStepup(app, uuid);
    expect(r.statusCode).toBe(201);
    const env = r.json();

    expect(env.data.otp_plaintext).toMatch(/^[0-9]{6}$/);
    expect(env.data.sandbox_only).toBe(true);

    // The echo MUST match the OTP that ends up on the STEP_UP_REQUIRED
    // Kafka event — single source of truth for the Todoku delivery path.
    const required = deps.eventProducer.events
      .slice(before)
      .find((e) => e.type === 'STEP_UP_REQUIRED');
    expect(required).toBeDefined();
    expect(required!.data.otp_plaintext).toBe(env.data.otp_plaintext);
  });

  it('echoed OTP actually verifies against /v1/stepup/verify', async () => {
    deps = makeTestDeps();
    app = await buildApp(deps);
    const uuid = await createActiveCustomer(app, deps,'+254712700002');
    const challenge = await challengeStepup(app, uuid);
    const otp = challenge.json().data.otp_plaintext as string;
    const challengeId = challenge.json().data.challenge_id as string;

    const verifyBody = JSON.stringify({ challenge_id: challengeId, response: otp });
    const r = await app.inject({
      method: 'POST',
      url: '/v1/stepup/verify',
      headers: signed({
        method: 'POST',
        url: '/v1/stepup/verify',
        body: verifyBody,
        idempotencyKey: `idem_${Math.random().toString(36).slice(2)}`,
      }),
      payload: verifyBody,
    });
    expect(r.statusCode).toBe(200);
    expect(typeof r.json().data.stepup_token).toBe('string');
  });

  it('strips otp_plaintext + sandbox_only when env=production', async () => {
    deps = makeTestDeps();
    // Production stamp: only the env name is changed; everything else is
    // the same in-memory stack so we can isolate the strip behaviour.
    deps.env = { ...deps.env, NODE_ENV: 'production' };
    app = await buildApp(deps);
    const uuid = await createActiveCustomer(app, deps,'+254712700003');

    const r = await challengeStepup(app, uuid);
    expect(r.statusCode).toBe(201);
    const env = r.json();
    expect(env.data.otp_plaintext).toBeUndefined();
    expect(env.data.sandbox_only).toBeUndefined();
    // Sanity: the structural fields are still there.
    expect(env.data.challenge_id).toMatch(/^stp_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(env.data.factor).toBe('phone_otp');
  });

  it('does NOT echo otp_plaintext for factor=hardware_key (no OTP exists)', async () => {
    deps = makeTestDeps();
    app = await buildApp(deps);

    // Create an operator user + register a credential so the operator
    // step-up flow can fire.
    const createUserBody = JSON.stringify({
      email: 'op@lunchdrop.example',
      display_name: 'Op',
    });
    const operatorTs = new Date().toISOString();
    const operatorAppId = 'identiti_test_operator';
    const operatorSecret = 'operator-test-secret-32-bytes_xyz';
    const sigUser = signRequest(
      buildCanonicalString({
        method: 'POST',
        pathAndQuery: '/v1/operator/users',
        contentType: 'application/json; charset=utf-8',
        timestamp: operatorTs,
        bodySha256Hex: sha256Hex(createUserBody),
      }),
      operatorSecret,
    );
    const userRes = await app.inject({
      method: 'POST',
      url: '/v1/operator/users',
      headers: {
        authorization: `Identiti-HMAC-SHA256 app_id=${operatorAppId}, signature=${sigUser}`,
        'x-identiti-timestamp': operatorTs,
        'content-type': 'application/json; charset=utf-8',
        'x-idempotency-key': `idem_${Math.random().toString(36).slice(2)}`,
      },
      payload: createUserBody,
    });
    const userId = userRes.json().data.user_id as string;

    // Mint a registration challenge + register a stub credential.
    const opts2Ts = new Date().toISOString();
    const sigOpts = signRequest(
      buildCanonicalString({
        method: 'POST',
        pathAndQuery: `/v1/operator/users/${userId}/webauthn/options`,
        contentType: '',
        timestamp: opts2Ts,
        bodySha256Hex: sha256Hex(''),
      }),
      operatorSecret,
    );
    const optsRes = await app.inject({
      method: 'POST',
      url: `/v1/operator/users/${userId}/webauthn/options`,
      headers: {
        authorization: `Identiti-HMAC-SHA256 app_id=${operatorAppId}, signature=${sigOpts}`,
        'x-identiti-timestamp': opts2Ts,
        'x-idempotency-key': `idem_${Math.random().toString(36).slice(2)}`,
      },
    });
    const challengeB64 = optsRes.json().data.challenge_b64 as string;

    const credentialId = `cred_${Math.random().toString(36).slice(2)}`;
    const cdj = Buffer.from(
      JSON.stringify({
        type: 'webauthn.create',
        challenge: challengeB64,
        origin: 'http://localhost:3002',
      }),
      'utf8',
    ).toString('base64url');
    const regBody = JSON.stringify({
      challenge_b64: challengeB64,
      credential_id_b64: credentialId,
      attestation_object_b64: 'x',
      client_data_json_b64: cdj,
    });
    const regTs = new Date().toISOString();
    const sigReg = signRequest(
      buildCanonicalString({
        method: 'POST',
        pathAndQuery: `/v1/operator/users/${userId}/webauthn/register`,
        contentType: 'application/json; charset=utf-8',
        timestamp: regTs,
        bodySha256Hex: sha256Hex(regBody),
      }),
      operatorSecret,
    );
    await app.inject({
      method: 'POST',
      url: `/v1/operator/users/${userId}/webauthn/register`,
      headers: {
        authorization: `Identiti-HMAC-SHA256 app_id=${operatorAppId}, signature=${sigReg}`,
        'x-identiti-timestamp': regTs,
        'content-type': 'application/json; charset=utf-8',
        'x-idempotency-key': `idem_${Math.random().toString(36).slice(2)}`,
      },
      payload: regBody,
    });

    // Now fire a hardware_key challenge — should NOT carry otp_plaintext.
    const stepupBody = JSON.stringify({
      operator_user_id: userId,
      operation_audience: 'https://api.todoku.kmv.example',
      operation_kind: 'operator.todoku.template_approve',
      operation_risk_tier: 'high',
      factor: 'hardware_key',
    });
    const stepupTs = new Date().toISOString();
    const sigStepup = signRequest(
      buildCanonicalString({
        method: 'POST',
        pathAndQuery: '/v1/stepup/challenges',
        contentType: 'application/json; charset=utf-8',
        timestamp: stepupTs,
        bodySha256Hex: sha256Hex(stepupBody),
      }),
      operatorSecret,
    );
    const r = await app.inject({
      method: 'POST',
      url: '/v1/stepup/challenges',
      headers: {
        authorization: `Identiti-HMAC-SHA256 app_id=${operatorAppId}, signature=${sigStepup}`,
        'x-identiti-timestamp': stepupTs,
        'content-type': 'application/json; charset=utf-8',
        'x-idempotency-key': `idem_${Math.random().toString(36).slice(2)}`,
      },
      payload: stepupBody,
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().data.otp_plaintext).toBeUndefined();
    expect(r.json().data.sandbox_only).toBeUndefined();
    // But the WebAuthn challenge IS present.
    expect(r.json().data.webauthn_challenge_b64).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
