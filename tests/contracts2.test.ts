/**
 * Sprint 2 contract tests — auth + tier responses validated against the
 * Schema Appendix shapes.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCanonicalString, sha256Hex, signRequest } from '@kmv/platform-shared/hmac';
import { buildApp, type App } from '../src/app.js';
import { makeTestDeps, TEST_APP_ID, TEST_HMAC_SECRET, type TestDepsBundle } from './helpers.js';
import { createAjv } from '../src/lib/ajv.js';
import { createChallengeResponseSchema, customerTokenResponseSchema } from '../src/schemas/auth.js';
import { tierResponseSchema } from '../src/schemas/tier.js';

const ajv = createAjv();
const validateChallengeResponse = ajv.compile(createChallengeResponseSchema);
const validateTokenResponse = ajv.compile(customerTokenResponseSchema);
const validateTierResponse = ajv.compile(tierResponseSchema);

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

async function createCustomerAndChallenge(
  app: App,
  deps: TestDepsBundle,
  phone: string,
): Promise<{ accountUuid: string; challengeId: string; otp: string }> {
  const body = JSON.stringify({
    phone,
    name_first: 'A',
    name_last: 'B',
    consent: { dpa_consent: true, kyc_consent: true, captured_at: new Date().toISOString() },
    app_correlation: `corr_${Math.random().toString(36).slice(2)}`,
  });
  const created = await app.inject({
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
  const accountUuid = created.json().data.account_uuid as string;

  const challengeBody = JSON.stringify({ phone, factor: 'phone_otp', purpose: 'login' });
  const c = await app.inject({
    method: 'POST',
    url: '/v1/auth/challenges',
    headers: signed({
      method: 'POST',
      url: '/v1/auth/challenges',
      body: challengeBody,
      idempotencyKey: `idem_${Math.random().toString(36).slice(2)}`,
    }),
    payload: challengeBody,
  });
  const challengeId = c.json().data.challenge_id as string;
  const event = deps.eventProducer.events.find(
    (e) => e.type === 'AUTH_CHALLENGE_REQUIRED' && e.data.challenge_id === challengeId,
  );
  if (!event) throw new Error('challenge event missing');
  return { accountUuid, challengeId, otp: event.data.otp_plaintext as string };
}

describe('contract: POST /v1/auth/challenges (Schema Appendix §2.4)', () => {
  let app: App;
  let deps: TestDepsBundle;

  beforeEach(async () => {
    deps = makeTestDeps();
    app = await buildApp(deps);
  });

  afterEach(async () => {
    await app.close();
  });

  it('matches the JSON schema', async () => {
    const phone = '+254712345040';
    // Make a customer first
    const setupBody = JSON.stringify({
      phone,
      name_first: 'A',
      name_last: 'B',
      consent: { dpa_consent: true, kyc_consent: true, captured_at: new Date().toISOString() },
      app_correlation: 'cont-1',
    });
    await app.inject({
      method: 'POST',
      url: '/v1/customers',
      headers: signed({
        method: 'POST',
        url: '/v1/customers',
        body: setupBody,
        idempotencyKey: 'idem-setup-c',
      }),
      payload: setupBody,
    });

    const body = JSON.stringify({ phone, factor: 'phone_otp', purpose: 'login' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/challenges',
      headers: signed({
        method: 'POST',
        url: '/v1/auth/challenges',
        body,
        idempotencyKey: 'idem-cont-c',
      }),
      payload: body,
    });
    expect(res.statusCode).toBe(201);
    const valid = validateChallengeResponse(res.json().data);
    if (!valid) {
      throw new Error(JSON.stringify(validateChallengeResponse.errors));
    }
    expect(valid).toBe(true);
  });
});

describe('contract: POST /v1/auth/customer-token (Schema Appendix §2.6)', () => {
  let app: App;
  let deps: TestDepsBundle;

  beforeEach(async () => {
    deps = makeTestDeps();
    app = await buildApp(deps);
  });

  afterEach(async () => {
    await app.close();
  });

  it('matches the JSON schema', async () => {
    const { challengeId, otp } = await createCustomerAndChallenge(app, deps, '+254712345041');
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
        idempotencyKey: 'idem-cont-tok',
      }),
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    const valid = validateTokenResponse(res.json().data);
    if (!valid) {
      throw new Error(JSON.stringify(validateTokenResponse.errors));
    }
    expect(valid).toBe(true);
  });
});

describe('contract: GET /v1/customers/{uuid}/tier (Schema Appendix §6.1)', () => {
  let app: App;

  beforeEach(async () => {
    app = await buildApp(makeTestDeps());
  });

  afterEach(async () => {
    await app.close();
  });

  it('matches the JSON schema', async () => {
    const phone = '+254712345042';
    const setupBody = JSON.stringify({
      phone,
      name_first: 'A',
      name_last: 'B',
      consent: { dpa_consent: true, kyc_consent: true, captured_at: new Date().toISOString() },
      app_correlation: 'cont-tier',
    });
    const created = await app.inject({
      method: 'POST',
      url: '/v1/customers',
      headers: signed({
        method: 'POST',
        url: '/v1/customers',
        body: setupBody,
        idempotencyKey: 'idem-setup-tier',
      }),
      payload: setupBody,
    });
    const uuid = created.json().data.account_uuid as string;
    const url = `/v1/customers/${uuid}/tier`;
    const res = await app.inject({
      method: 'GET',
      url,
      headers: signed({ method: 'GET', url }),
    });
    expect(res.statusCode).toBe(200);
    const valid = validateTierResponse(res.json().data);
    if (!valid) {
      throw new Error(JSON.stringify(validateTierResponse.errors));
    }
    expect(valid).toBe(true);
  });
});
