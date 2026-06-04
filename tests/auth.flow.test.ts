/**
 * Sprint 2 — full authentication flow:
 *   POST /v1/auth/challenges   → OTP delivered via Kafka (intercepted in tests)
 *   POST /v1/auth/customer-token → RS256 customer JWT issued
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { jwtVerify, createLocalJWKSet } from 'jose';
import { buildCanonicalString, sha256Hex, signRequest } from '@kmv/platform-shared/hmac';
import { buildApp, type App } from '../src/app.js';
import { buildJwks } from '../src/services/jwtKeys.js';
import { makeTestDeps, TEST_APP_ID, TEST_HMAC_SECRET, type TestDepsBundle } from './helpers.js';

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

async function createCustomer(app: App, phone: string): Promise<string> {
  const body = JSON.stringify({
    phone,
    name_first: 'A',
    name_last: 'B',
    consent: {
      dpa_consent: true,
      kyc_consent: true,
      captured_at: new Date().toISOString(),
    },
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
  if (r.statusCode !== 201) throw new Error(`createCustomer failed: ${r.statusCode} ${r.body}`);
  return r.json().data.account_uuid as string;
}

describe('POST /v1/auth/challenges', () => {
  let app: App;
  let deps: TestDepsBundle;

  beforeEach(async () => {
    deps = makeTestDeps();
    app = await buildApp(deps);
  });

  afterEach(async () => {
    await app.close();
  });

  it('creates a phone_otp challenge, publishes AUTH_CHALLENGE_REQUIRED, and audits', async () => {
    const phone = '+254712345001';
    await createCustomer(app, phone);

    const beforeEvents = deps.eventProducer.events.length;

    const body = JSON.stringify({ phone, factor: 'phone_otp', purpose: 'login' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/challenges',
      headers: signed({
        method: 'POST',
        url: '/v1/auth/challenges',
        body,
        idempotencyKey: 'idem-chal-1',
      }),
      payload: body,
    });
    expect(res.statusCode).toBe(201);
    const env = res.json();
    expect(env.data.challenge_id).toMatch(/^stp_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(env.data.factor).toBe('phone_otp');
    expect(env.data.delivery_status).toBe('dispatched');

    const newEvents = deps.eventProducer.events.slice(beforeEvents);
    expect(newEvents).toHaveLength(1);
    expect(newEvents[0]!.type).toBe('AUTH_CHALLENGE_REQUIRED');
    expect(newEvents[0]!.topic).toBe('identiti.step_up.events');
    expect(newEvents[0]!.data).toMatchObject({
      challenge_id: env.data.challenge_id,
      purpose: 'login',
      factor: 'phone_otp',
    });
    expect(typeof newEvents[0]!.data.otp_plaintext).toBe('string');
  });

  it('returns 404 when no account is registered for the phone', async () => {
    const body = JSON.stringify({
      phone: '+254799999999',
      factor: 'phone_otp',
      purpose: 'login',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/challenges',
      headers: signed({
        method: 'POST',
        url: '/v1/auth/challenges',
        body,
        idempotencyKey: 'idem-chal-404',
      }),
      payload: body,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('customer_not_found');
  });

  it('rejects unsupported factors (hardware_key) at this phase', async () => {
    const phone = '+254712345002';
    await createCustomer(app, phone);
    const body = JSON.stringify({
      phone,
      factor: 'hardware_key',
      purpose: 'login',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/challenges',
      headers: signed({
        method: 'POST',
        url: '/v1/auth/challenges',
        body,
        idempotencyKey: 'idem-hk',
      }),
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('auth_factor_unsupported');
  });
});

describe('POST /v1/auth/customer-token', () => {
  let app: App;
  let deps: TestDepsBundle;

  beforeEach(async () => {
    deps = makeTestDeps();
    app = await buildApp(deps);
  });

  afterEach(async () => {
    await app.close();
  });

  async function startChallenge(phone: string): Promise<{
    challengeId: string;
    accountUuid: string;
    otp: string;
  }> {
    const accountUuid = await createCustomer(app, phone);
    const body = JSON.stringify({ phone, factor: 'phone_otp', purpose: 'login' });
    const r = await app.inject({
      method: 'POST',
      url: '/v1/auth/challenges',
      headers: signed({
        method: 'POST',
        url: '/v1/auth/challenges',
        body,
        idempotencyKey: `idem_${Math.random().toString(36).slice(2)}`,
      }),
      payload: body,
    });
    const challengeId = r.json().data.challenge_id as string;
    const event = deps.eventProducer.events
      .filter((e) => e.type === 'AUTH_CHALLENGE_REQUIRED')
      .find((e) => e.data.challenge_id === challengeId);
    if (!event) throw new Error('expected AUTH_CHALLENGE_REQUIRED event');
    const otp = event.data.otp_plaintext as string;
    return { challengeId, accountUuid, otp };
  }

  it('issues a verifiable RS256 customer token on a correct OTP', async () => {
    const { challengeId, accountUuid, otp } = await startChallenge('+254712345010');
    const body = JSON.stringify({
      challenge_id: challengeId,
      response: otp,
      requested_audience: 'https://lunchdrop.example/api',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/customer-token',
      headers: signed({
        method: 'POST',
        url: '/v1/auth/customer-token',
        body,
        idempotencyKey: 'idem-token-1',
      }),
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    const env = res.json();
    expect(env.data.token_type).toBe('bearer');
    expect(env.data.account_uuid).toBe(accountUuid);
    expect(env.data.session_id).toMatch(/^ses_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(env.data.expires_in).toBe(1800);

    // Verify the JWT against our JWKS.
    const jwks = await buildJwks(deps.jwtKeys);
    const keyset = createLocalJWKSet(jwks as unknown as Parameters<typeof createLocalJWKSet>[0]);
    const verified = await jwtVerify(env.data.access_token as string, keyset, {
      issuer: 'https://api.id.identiti.co.ke',
      audience: 'https://lunchdrop.example/api',
    });
    expect(verified.payload.sub).toBe(accountUuid);
    expect(verified.payload.session_kind).toBe('primary');
    expect(verified.payload.tier).toBe('tier_0');
    expect(verified.payload.auth_factors).toEqual(['phone_otp']);
  });

  it('rejects a wrong OTP with auth_factor_failed and increments attempts', async () => {
    const { challengeId } = await startChallenge('+254712345011');
    const body = JSON.stringify({
      challenge_id: challengeId,
      response: '000000',
      requested_audience: 'https://lunchdrop.example/api',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/customer-token',
      headers: signed({
        method: 'POST',
        url: '/v1/auth/customer-token',
        body,
        idempotencyKey: 'idem-bad-otp',
      }),
      payload: body,
    });
    expect(res.statusCode).toBe(401);
    const env = res.json();
    expect(env.error.code).toBe('auth_factor_failed');
    // Schema Appendix §3.1 mandates challenge_id + attempts_remaining in the
    // error detail. After one wrong attempt of MAX_OTP_ATTEMPTS=3, two remain.
    expect(env.error.detail).toMatchObject({
      challenge_id: challengeId,
      attempts_remaining: 2,
    });
  });

  it('locks the challenge after MAX_OTP_ATTEMPTS failures', async () => {
    const { challengeId } = await startChallenge('+254712345012');
    const wrongBody = JSON.stringify({
      challenge_id: challengeId,
      response: '000001',
      requested_audience: 'https://lunchdrop.example/api',
    });
    // 3 wrong attempts.
    for (let i = 0; i < 3; i++) {
      await app.inject({
        method: 'POST',
        url: '/v1/auth/customer-token',
        headers: signed({
          method: 'POST',
          url: '/v1/auth/customer-token',
          body: wrongBody,
          idempotencyKey: `idem-fail-${i}`,
        }),
        payload: wrongBody,
      });
    }
    // 4th attempt — challenge already in 'failed' state.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/customer-token',
      headers: signed({
        method: 'POST',
        url: '/v1/auth/customer-token',
        body: wrongBody,
        idempotencyKey: 'idem-fail-final',
      }),
      payload: wrongBody,
    });
    // Schema Appendix §3.1: locked challenges + final-attempt failures both
    // surface as auth_factor_failed (401) with attempts_remaining=0.
    expect(res.statusCode).toBe(401);
    const env = res.json();
    expect(env.error.code).toBe('auth_factor_failed');
    expect(env.error.detail).toMatchObject({
      challenge_id: challengeId,
      attempts_remaining: 0,
    });
  });

  it('rejects an unknown challenge_id', async () => {
    const body = JSON.stringify({
      challenge_id: 'stp_00000000000000000000000000',
      response: '123456',
      requested_audience: 'https://lunchdrop.example/api',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/customer-token',
      headers: signed({
        method: 'POST',
        url: '/v1/auth/customer-token',
        body,
        idempotencyKey: 'idem-no-chal',
      }),
      payload: body,
    });
    // Schema Appendix §3.1: there is no auth_challenge_not_found code.
    // Unknown challenge IDs surface as auth_factor_failed (401) with
    // attempts_remaining=0. Avoids leaking challenge-id existence to a
    // probing app.
    expect(res.statusCode).toBe(401);
    const env = res.json();
    expect(env.error.code).toBe('auth_factor_failed');
    expect(env.error.detail).toMatchObject({
      challenge_id: 'stp_00000000000000000000000000',
      attempts_remaining: 0,
    });
  });
});
