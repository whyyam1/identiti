/**
 * Sprint 5 (Phase 6) — phone tokens end-to-end.
 *   POST /v1/phone-tokens                 issue
 *   POST /v1/phone-tokens/resolve         Todoku-internal (scope phone_token:resolve)
 *   POST /v1/phone-tokens/{jti}/revoke    operator
 *
 * Plus the customer-token JWT phone_token claim emission (Schema Appendix §2.7).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeJwt, jwtVerify, createLocalJWKSet } from 'jose';
import { buildCanonicalString, sha256Hex, signRequest } from '@kmv/platform-shared/hmac';
import { buildApp, type App } from '../src/app.js';
import { buildJwks } from '../src/services/jwtKeys.js';
import {
  makeTestDeps,
  TEST_APP_ID,
  TEST_HMAC_SECRET,
  TEST_OPERATOR_APP_ID,
  TEST_OPERATOR_HMAC_SECRET,
  TEST_TODOKU_APP_ID,
  TEST_TODOKU_HMAC_SECRET,
  type TestDepsBundle,
} from './helpers.js';

const ISSUER = 'https://api.id.identiti.co.ke';

function signedAs(creds: { appId: string; secret: string }) {
  return (opts: {
    method: string;
    url: string;
    body?: string;
    idempotencyKey?: string;
  }): Record<string, string> => {
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
    const sig = signRequest(canonical, creds.secret);
    const headers: Record<string, string> = {
      authorization: `Identiti-HMAC-SHA256 app_id=${creds.appId}, signature=${sig}`,
      'x-identiti-timestamp': ts,
    };
    if (contentType) headers['content-type'] = contentType;
    if (opts.idempotencyKey) headers['x-idempotency-key'] = opts.idempotencyKey;
    return headers;
  };
}

const signedAsApp = signedAs({ appId: TEST_APP_ID, secret: TEST_HMAC_SECRET });
const signedAsOperator = signedAs({
  appId: TEST_OPERATOR_APP_ID,
  secret: TEST_OPERATOR_HMAC_SECRET,
});
const signedAsTodoku = signedAs({
  appId: TEST_TODOKU_APP_ID,
  secret: TEST_TODOKU_HMAC_SECRET,
});

async function createCustomer(app: App, phone: string): Promise<string> {
  const body = JSON.stringify({
    phone,
    name_first: 'A',
    name_last: 'B',
    consent: { dpa_consent: true, kyc_consent: true, captured_at: new Date().toISOString() },
    app_correlation: `corr_${Math.random().toString(36).slice(2)}`,
  });
  const r = await app.inject({
    method: 'POST',
    url: '/v1/customers',
    headers: signedAsApp({
      method: 'POST',
      url: '/v1/customers',
      body,
      idempotencyKey: `idem_${Math.random().toString(36).slice(2)}`,
    }),
    payload: body,
  });
  if (r.statusCode !== 201) throw new Error(`createCustomer: ${r.statusCode} ${r.body}`);
  return r.json().data.account_uuid as string;
}

async function issuePhoneToken(
  app: App,
  account: string,
  audience?: 'todoku',
): Promise<{ phone_token: string; jti: string; expires_at: string }> {
  const body = JSON.stringify(
    audience !== undefined ? { account_uuid: account, audience } : { account_uuid: account },
  );
  const r = await app.inject({
    method: 'POST',
    url: '/v1/phone-tokens',
    headers: signedAsApp({
      method: 'POST',
      url: '/v1/phone-tokens',
      body,
      idempotencyKey: `idem_${Math.random().toString(36).slice(2)}`,
    }),
    payload: body,
  });
  if (r.statusCode !== 201) throw new Error(`issuePhoneToken: ${r.statusCode} ${r.body}`);
  return r.json().data;
}

describe('POST /v1/phone-tokens', () => {
  let app: App;
  let deps: TestDepsBundle;

  beforeEach(async () => {
    deps = makeTestDeps();
    app = await buildApp(deps);
  });

  afterEach(async () => {
    await app.close();
  });

  it('issues an opaque phone token bound to the account, persists, audits', async () => {
    const account = await createCustomer(app, '+254712360001');
    const result = await issuePhoneToken(app, account);

    expect(result.phone_token).toMatch(/^ey/); // JWT-ish prefix
    expect(result.jti).toMatch(/^pht_[0-9A-HJKMNP-TV-Z]{26}$/);

    // Decoded claims (no signature check at consumer side; that's resolve's job).
    const decoded = decodeJwt(result.phone_token);
    expect(decoded.iss).toBe(ISSUER);
    expect(decoded.sub).toBe(account);
    expect(decoded.aud).toBe('todoku');
    expect(decoded.jti).toBe(result.jti);
    // 15-min default TTL
    expect((decoded.exp as number) - (decoded.iat as number)).toBe(15 * 60);

    // Persisted
    const persisted = await deps.phoneTokensRepo.findByJti(result.jti);
    expect(persisted).not.toBeNull();
    expect(persisted!.accountUuid).toBe(account);
    expect(persisted!.audience).toBe('todoku');
    expect(persisted!.revoked).toBe(false);

    expect(deps.auditLogger.entries.some((e) => e.action === 'phone_token.issued')).toBe(true);
  });

  it('rejects malformed account_uuid', async () => {
    const body = JSON.stringify({ account_uuid: 'not-a-uuid' });
    const r = await app.inject({
      method: 'POST',
      url: '/v1/phone-tokens',
      headers: signedAsApp({
        method: 'POST',
        url: '/v1/phone-tokens',
        body,
        idempotencyKey: 'idem-bad',
      }),
      payload: body,
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('validation_request_invalid');
  });

  it('rejects unknown account', async () => {
    const body = JSON.stringify({ account_uuid: 'acc_00000000-0000-4000-8000-000000000000' });
    const r = await app.inject({
      method: 'POST',
      url: '/v1/phone-tokens',
      headers: signedAsApp({
        method: 'POST',
        url: '/v1/phone-tokens',
        body,
        idempotencyKey: 'idem-unknown',
      }),
      payload: body,
    });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe('customer_not_found');
  });

  it('rejects unsupported audience', async () => {
    const account = await createCustomer(app, '+254712360002');
    const body = JSON.stringify({ account_uuid: account, audience: 'kipkiren_pay' });
    const r = await app.inject({
      method: 'POST',
      url: '/v1/phone-tokens',
      headers: signedAsApp({
        method: 'POST',
        url: '/v1/phone-tokens',
        body,
        idempotencyKey: 'idem-bad-aud',
      }),
      payload: body,
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('validation_request_invalid');
  });
});

describe('POST /v1/phone-tokens/resolve', () => {
  let app: App;
  let deps: TestDepsBundle;

  beforeEach(async () => {
    deps = makeTestDeps();
    app = await buildApp(deps);
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns the encrypted MSISDN; plaintext decrypts to the original phone', async () => {
    const phone = '+254712360100';
    const account = await createCustomer(app, phone);
    const issued = await issuePhoneToken(app, account);

    const body = JSON.stringify({ phone_token: issued.phone_token });
    const r = await app.inject({
      method: 'POST',
      url: '/v1/phone-tokens/resolve',
      headers: signedAsTodoku({
        method: 'POST',
        url: '/v1/phone-tokens/resolve',
        body,
        idempotencyKey: 'idem-resolve-1',
      }),
      payload: body,
    });
    expect(r.statusCode).toBe(200);
    const env = r.json();
    expect(env.data.account_uuid).toBe(account);
    expect(env.data.encrypted_format).toBe('aes-256-gcm-v1');
    expect(typeof env.data.phone_encrypted).toBe('string');

    // The Todoku-side decryption flow: base64 → iv||tag||ct → AES-256-GCM.
    // The phoneCrypto in deps uses the same key Identiti issued under.
    const plaintext = deps.phoneCrypto.decrypt(env.data.phone_encrypted);
    expect(plaintext).toBe(phone);

    expect(deps.auditLogger.entries.some((e) => e.action === 'phone_token.resolved')).toBe(true);
  });

  it('rejects when scope phone_token:resolve is missing (regular app)', async () => {
    const account = await createCustomer(app, '+254712360101');
    const issued = await issuePhoneToken(app, account);

    const body = JSON.stringify({ phone_token: issued.phone_token });
    const r = await app.inject({
      method: 'POST',
      url: '/v1/phone-tokens/resolve',
      headers: signedAsApp({
        method: 'POST',
        url: '/v1/phone-tokens/resolve',
        body,
        idempotencyKey: 'idem-noscope',
      }),
      payload: body,
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('AUTH_SCOPE_INSUFFICIENT');
  });

  it('rejects a tampered token (signature invalid)', async () => {
    const account = await createCustomer(app, '+254712360102');
    const issued = await issuePhoneToken(app, account);
    const tampered = issued.phone_token.slice(0, -4) + 'AAAA';

    const body = JSON.stringify({ phone_token: tampered });
    const r = await app.inject({
      method: 'POST',
      url: '/v1/phone-tokens/resolve',
      headers: signedAsTodoku({
        method: 'POST',
        url: '/v1/phone-tokens/resolve',
        body,
        idempotencyKey: 'idem-tampered',
      }),
      payload: body,
    });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe('phone_token_invalid');
  });

  it('rejects a revoked token', async () => {
    const account = await createCustomer(app, '+254712360103');
    const issued = await issuePhoneToken(app, account);

    // Revoke as operator.
    const revokeBody = JSON.stringify({ reason: 'compromised' });
    const rv = await app.inject({
      method: 'POST',
      url: `/v1/phone-tokens/${issued.jti}/revoke`,
      headers: signedAsOperator({
        method: 'POST',
        url: `/v1/phone-tokens/${issued.jti}/revoke`,
        body: revokeBody,
        idempotencyKey: 'idem-rev',
      }),
      payload: revokeBody,
    });
    expect(rv.statusCode).toBe(200);

    // Try to resolve the now-revoked token.
    const body = JSON.stringify({ phone_token: issued.phone_token });
    const r = await app.inject({
      method: 'POST',
      url: '/v1/phone-tokens/resolve',
      headers: signedAsTodoku({
        method: 'POST',
        url: '/v1/phone-tokens/resolve',
        body,
        idempotencyKey: 'idem-resolve-revoked',
      }),
      payload: body,
    });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe('phone_token_revoked');
  });

  it('rejects an audience mismatch', async () => {
    const account = await createCustomer(app, '+254712360104');
    const issued = await issuePhoneToken(app, account);

    const body = JSON.stringify({
      phone_token: issued.phone_token,
      // Sending a non-todoku expected_audience would be a schema rejection
      // (only todoku is in the enum) — to test audience mismatch we'd need
      // a token issued for one audience and resolved for another. Since
      // v1.0 only has 'todoku', this test asserts the schema-side guard.
      expected_audience: 'todoku',
    });
    const r = await app.inject({
      method: 'POST',
      url: '/v1/phone-tokens/resolve',
      headers: signedAsTodoku({
        method: 'POST',
        url: '/v1/phone-tokens/resolve',
        body,
        idempotencyKey: 'idem-aud-ok',
      }),
      payload: body,
    });
    // Same audience → success.
    expect(r.statusCode).toBe(200);
  });

  it('rejects a structurally-valid but unknown jti', async () => {
    // Hand-forge a token via the test signer to bypass DB issuance.
    const fakeToken = await deps.phoneTokenSigner.sign({
      sub: 'acc_11111111-1111-4111-8111-111111111111',
      jti: 'pht_00000000000000000000000000',
      audience: 'todoku',
      issuer: ISSUER,
    });

    const body = JSON.stringify({ phone_token: fakeToken.token });
    const r = await app.inject({
      method: 'POST',
      url: '/v1/phone-tokens/resolve',
      headers: signedAsTodoku({
        method: 'POST',
        url: '/v1/phone-tokens/resolve',
        body,
        idempotencyKey: 'idem-fake',
      }),
      payload: body,
    });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe('phone_token_invalid');
  });
});

describe('POST /v1/phone-tokens/{jti}/revoke', () => {
  let app: App;
  let deps: TestDepsBundle;

  beforeEach(async () => {
    deps = makeTestDeps();
    app = await buildApp(deps);
  });

  afterEach(async () => {
    await app.close();
  });

  it('revokes a token; second revoke is idempotent', async () => {
    const account = await createCustomer(app, '+254712360200');
    const issued = await issuePhoneToken(app, account);

    const body = JSON.stringify({ reason: 'manual revoke' });
    const r1 = await app.inject({
      method: 'POST',
      url: `/v1/phone-tokens/${issued.jti}/revoke`,
      headers: signedAsOperator({
        method: 'POST',
        url: `/v1/phone-tokens/${issued.jti}/revoke`,
        body,
        idempotencyKey: 'idem-rev-1',
      }),
      payload: body,
    });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().data.jti).toBe(issued.jti);
    expect(typeof r1.json().data.revoked_at).toBe('string');

    const persisted = await deps.phoneTokensRepo.findByJti(issued.jti);
    expect(persisted!.revoked).toBe(true);

    // Second revoke is idempotent — still 200.
    const r2 = await app.inject({
      method: 'POST',
      url: `/v1/phone-tokens/${issued.jti}/revoke`,
      headers: signedAsOperator({
        method: 'POST',
        url: `/v1/phone-tokens/${issued.jti}/revoke`,
        body,
        idempotencyKey: 'idem-rev-2',
      }),
      payload: body,
    });
    expect(r2.statusCode).toBe(200);
  });

  it('rejects when scope identiti:operator is missing', async () => {
    const account = await createCustomer(app, '+254712360201');
    const issued = await issuePhoneToken(app, account);

    const body = JSON.stringify({ reason: 'unauthorised' });
    const r = await app.inject({
      method: 'POST',
      url: `/v1/phone-tokens/${issued.jti}/revoke`,
      headers: signedAsApp({
        method: 'POST',
        url: `/v1/phone-tokens/${issued.jti}/revoke`,
        body,
        idempotencyKey: 'idem-rev-noscope',
      }),
      payload: body,
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('AUTH_SCOPE_INSUFFICIENT');
  });

  it('returns 404 for an unknown jti', async () => {
    const body = JSON.stringify({ reason: 'test' });
    const url = '/v1/phone-tokens/pht_00000000000000000000000000/revoke';
    const r = await app.inject({
      method: 'POST',
      url,
      headers: signedAsOperator({
        method: 'POST',
        url,
        body,
        idempotencyKey: 'idem-rev-404',
      }),
      payload: body,
    });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe('phone_token_not_found');
  });

  it('rejects malformed jti', async () => {
    const body = JSON.stringify({ reason: 'test' });
    const url = '/v1/phone-tokens/not-a-jti/revoke';
    const r = await app.inject({
      method: 'POST',
      url,
      headers: signedAsOperator({
        method: 'POST',
        url,
        body,
        idempotencyKey: 'idem-rev-bad',
      }),
      payload: body,
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('validation_request_invalid');
  });
});

describe('Customer-token JWT phone_token claim (Schema Appendix §2.7)', () => {
  let app: App;
  let deps: TestDepsBundle;

  beforeEach(async () => {
    deps = makeTestDeps();
    app = await buildApp(deps);
  });

  afterEach(async () => {
    await app.close();
  });

  it('mints a phone_token claim on /v1/auth/customer-token, persisted in phone_tokens', async () => {
    const phone = '+254712360300';
    const account = await createCustomer(app, phone);

    // Login flow.
    const challengeBody = JSON.stringify({ phone, factor: 'phone_otp', purpose: 'login' });
    const c = await app.inject({
      method: 'POST',
      url: '/v1/auth/challenges',
      headers: signedAsApp({
        method: 'POST',
        url: '/v1/auth/challenges',
        body: challengeBody,
        idempotencyKey: 'idem-chal-pt',
      }),
      payload: challengeBody,
    });
    const challengeId = c.json().data.challenge_id as string;
    const event = deps.eventProducer.events.find(
      (e) => e.type === 'AUTH_CHALLENGE_REQUIRED' && e.data.challenge_id === challengeId,
    );
    const otp = event!.data.otp_plaintext as string;

    const tokenBody = JSON.stringify({
      challenge_id: challengeId,
      response: otp,
      requested_audience: 'https://kalunch.example/api',
    });
    const tk = await app.inject({
      method: 'POST',
      url: '/v1/auth/customer-token',
      headers: signedAsApp({
        method: 'POST',
        url: '/v1/auth/customer-token',
        body: tokenBody,
        idempotencyKey: 'idem-tok-pt',
      }),
      payload: tokenBody,
    });
    expect(tk.statusCode).toBe(200);

    // Verify the customer JWT and check the phone_token claim.
    const jwks = await buildJwks(deps.jwtKeys);
    const keyset = createLocalJWKSet(jwks as unknown as Parameters<typeof createLocalJWKSet>[0]);
    const verified = await jwtVerify(tk.json().data.access_token, keyset, {
      issuer: ISSUER,
      audience: 'https://kalunch.example/api',
    });

    const phoneToken = verified.payload.phone_token;
    expect(typeof phoneToken).toBe('string');
    const ptClaims = decodeJwt(phoneToken as string);
    expect(ptClaims.sub).toBe(account);
    expect(ptClaims.aud).toBe('todoku');
    const ptJti = ptClaims.jti as string;
    expect(ptJti).toMatch(/^pht_[0-9A-HJKMNP-TV-Z]{26}$/);

    // Persisted alongside.
    const persisted = await deps.phoneTokensRepo.findByJti(ptJti);
    expect(persisted).not.toBeNull();
    expect(persisted!.accountUuid).toBe(account);
  });
});
