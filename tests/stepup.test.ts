/**
 * Sprint 4 (Phase 5) — step-up tokens end-to-end.
 *   POST /v1/stepup/challenges  — initiate
 *   POST /v1/stepup/verify      — consume OTP, mint RS256 step-up JWT
 *
 * Verifies the wire contract that KP-4 will consume: claim shape per Schema
 * Appendix §16.2, JTI = challenge_id, JWKS-verifiable, audience-bound,
 * operation-kind-bound, env-bound, nbf=iat, single-use enforced.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { jwtVerify, createLocalJWKSet } from 'jose';
import { buildCanonicalString, sha256Hex, signRequest } from '@kmv/platform-shared/hmac';
import { buildApp, type App } from '../src/app.js';
import { buildJwks } from '../src/services/jwtKeys.js';
import { STEPUP_TTL_BY_RISK } from '../src/schemas/stepup.js';
import {
  makeTestDeps,
  TEST_APP_ID,
  TEST_HMAC_SECRET,
  type TestDepsBundle,
} from './helpers.js';

const KP_AUDIENCE = 'https://api.pay.kipkiren.com';
const ISSUER = 'https://api.id.identiti.co.ke';

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
  phone: string
): Promise<string> {
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
    headers: signed({
      method: 'POST',
      url: '/v1/customers',
      body,
      idempotencyKey: `idem_${Math.random().toString(36).slice(2)}`,
    }),
    payload: body,
  });
  if (r.statusCode !== 201) throw new Error(`createCustomer failed: ${r.statusCode} ${r.body}`);
  const accountUuid = r.json().data.account_uuid as string;
  const ok = await deps.customersRepo.changeState(accountUuid, ['pending_onboarding'], 'active');
  if (!ok) throw new Error('failed to activate test account');
  return accountUuid;
}

async function initiateStepup(
  app: App,
  account: string,
  overrides: Partial<{
    operation_kind: string;
    operation_risk_tier: 'low' | 'medium' | 'high' | 'very_high';
    operation_audience: string;
    factor: 'phone_otp' | 'hardware_key' | 'passive_biometric';
  }> = {}
) {
  const body = JSON.stringify({
    account_uuid: account,
    operation_audience: overrides.operation_audience ?? KP_AUDIENCE,
    operation_kind: overrides.operation_kind ?? 'kipkiren_pay.redemption',
    operation_risk_tier: overrides.operation_risk_tier ?? 'medium',
    factor: overrides.factor ?? 'phone_otp',
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

describe('POST /v1/stepup/challenges', () => {
  let app: App;
  let deps: TestDepsBundle;

  beforeEach(async () => {
    deps = makeTestDeps();
    app = await buildApp(deps);
  });

  afterEach(async () => {
    await app.close();
  });

  it('creates a stepup challenge, publishes STEP_UP_REQUIRED, audits', async () => {
    const account = await createActiveCustomer(app, deps, '+254712346001');
    const eventCountBefore = deps.eventProducer.events.length;

    const res = await initiateStepup(app, account);

    expect(res.statusCode).toBe(201);
    const env = res.json();
    expect(env.data.challenge_id).toMatch(/^stp_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(env.data.factor).toBe('phone_otp');
    expect(env.data.delivery_status).toBe('dispatched');
    expect(typeof env.data.expires_at).toBe('string');

    const newEvents = deps.eventProducer.events.slice(eventCountBefore);
    expect(newEvents).toHaveLength(1);
    const event = newEvents[0]!;
    expect(event.type).toBe('STEP_UP_REQUIRED');
    expect(event.topic).toBe('identiti.step_up.events');
    expect(event.key).toBe(account);
    expect(event.data).toMatchObject({
      account_uuid: account,
      challenge_id: env.data.challenge_id,
      operation_kind: 'kipkiren_pay.redemption',
      operation_risk_tier: 'medium',
      operation_audience: KP_AUDIENCE,
      factor: 'phone_otp',
    });
    expect(typeof event.data.otp_plaintext).toBe('string');
    expect((event.data.otp_plaintext as string)).toMatch(/^[0-9]{6}$/);

    expect(deps.auditLogger.entries.some((e) => e.action === 'stepup.challenge.create')).toBe(
      true
    );
  });

  it('rejects malformed account_uuid', async () => {
    const body = JSON.stringify({
      account_uuid: 'not-a-uuid',
      operation_audience: KP_AUDIENCE,
      operation_kind: 'kipkiren_pay.redemption',
      operation_risk_tier: 'medium',
      factor: 'phone_otp',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/stepup/challenges',
      headers: signed({
        method: 'POST',
        url: '/v1/stepup/challenges',
        body,
        idempotencyKey: 'idem-bad-uuid',
      }),
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_request_invalid');
  });

  it('rejects unknown account with customer_not_found', async () => {
    const body = JSON.stringify({
      account_uuid: 'acc_00000000-0000-4000-8000-000000000000',
      operation_audience: KP_AUDIENCE,
      operation_kind: 'kipkiren_pay.redemption',
      operation_risk_tier: 'medium',
      factor: 'phone_otp',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/stepup/challenges',
      headers: signed({
        method: 'POST',
        url: '/v1/stepup/challenges',
        body,
        idempotencyKey: 'idem-unknown',
      }),
      payload: body,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('customer_not_found');
  });

  it('rejects non-active account with state_invalid_for_action', async () => {
    // Create but don't activate — stays at pending_onboarding.
    const setupBody = JSON.stringify({
      phone: '+254712346002',
      name_first: 'A',
      name_last: 'B',
      consent: { dpa_consent: true, kyc_consent: true, captured_at: new Date().toISOString() },
      app_correlation: 'pending',
    });
    const created = await app.inject({
      method: 'POST',
      url: '/v1/customers',
      headers: signed({
        method: 'POST',
        url: '/v1/customers',
        body: setupBody,
        idempotencyKey: 'idem-pending',
      }),
      payload: setupBody,
    });
    const account = created.json().data.account_uuid as string;

    const res = await initiateStepup(app, account);
    expect(res.statusCode).toBe(409);
    const env = res.json();
    expect(env.error.code).toBe('state_invalid_for_action');
    expect(env.error.detail).toMatchObject({
      current_state: 'pending_onboarding',
      required_state: 'active',
    });
  });

  it('rejects unsupported factor (hardware_key) at this phase', async () => {
    const account = await createActiveCustomer(app, deps, '+254712346003');
    const res = await initiateStepup(app, account, { factor: 'hardware_key' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('auth_factor_unsupported');
  });

  it('rejects when scope identiti:stepup:request is missing', async () => {
    const account = await createActiveCustomer(app, deps, '+254712346004');
    // Override the credential store to drop the scope.
    await app.close();
    const baseStore = (await import('./helpers.js')).makeMemCredStore();
    deps = makeTestDeps({
      credentialStore: {
        async lookup(appId) {
          const r = await baseStore.lookup(appId);
          if (!r) return null;
          return {
            ...r,
            record: {
              ...r.record,
              scopes: r.record.scopes.filter((s) => s !== 'identiti:stepup:request'),
            },
          };
        },
      },
      // Reuse the existing customer DB by NOT swapping the customers repo.
      // (makeTestDeps will create a fresh one — but for this test we just need
      // the scope check to fail; account existence isn't reached.)
    });
    app = await buildApp(deps);

    const body = JSON.stringify({
      account_uuid: account,
      operation_audience: KP_AUDIENCE,
      operation_kind: 'kipkiren_pay.redemption',
      operation_risk_tier: 'medium',
      factor: 'phone_otp',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/stepup/challenges',
      headers: signed({
        method: 'POST',
        url: '/v1/stepup/challenges',
        body,
        idempotencyKey: 'idem-noscope',
      }),
      payload: body,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('AUTH_SCOPE_INSUFFICIENT');
  });
});

describe('POST /v1/stepup/verify', () => {
  let app: App;
  let deps: TestDepsBundle;

  beforeEach(async () => {
    deps = makeTestDeps();
    app = await buildApp(deps);
  });

  afterEach(async () => {
    await app.close();
  });

  async function runStepupChallenge(
    phone: string,
    riskTier: 'low' | 'medium' | 'high' | 'very_high' = 'medium'
  ): Promise<{
    accountUuid: string;
    challengeId: string;
    otp: string;
  }> {
    const accountUuid = await createActiveCustomer(app, deps, phone);
    const r = await initiateStepup(app, accountUuid, { operation_risk_tier: riskTier });
    if (r.statusCode !== 201) throw new Error(`initiate failed: ${r.statusCode} ${r.body}`);
    const challengeId = r.json().data.challenge_id as string;
    const event = deps.eventProducer.events.find(
      (e) => e.type === 'STEP_UP_REQUIRED' && e.data.challenge_id === challengeId
    );
    if (!event) throw new Error('expected STEP_UP_REQUIRED event');
    return { accountUuid, challengeId, otp: event.data.otp_plaintext as string };
  }

  it('issues a JWKS-verifiable RS256 step-up JWT with the §16.2 claim shape', async () => {
    const { accountUuid, challengeId, otp } = await runStepupChallenge('+254712347001');

    const body = JSON.stringify({ challenge_id: challengeId, response: otp });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/stepup/verify',
      headers: signed({
        method: 'POST',
        url: '/v1/stepup/verify',
        body,
        idempotencyKey: 'idem-verify-1',
      }),
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    const env = res.json();
    expect(typeof env.data.stepup_token).toBe('string');
    expect(env.data.expires_in).toBe(STEPUP_TTL_BY_RISK.medium);

    // Verify against JWKS with the audience the customer authorised against.
    const jwks = await buildJwks(deps.jwtKeys);
    const keyset = createLocalJWKSet(jwks as unknown as Parameters<typeof createLocalJWKSet>[0]);
    const verified = await jwtVerify(env.data.stepup_token as string, keyset, {
      issuer: ISSUER,
      audience: KP_AUDIENCE,
    });

    // Schema Appendix §16.2 claim shape.
    expect(verified.payload.iss).toBe(ISSUER);
    expect(verified.payload.aud).toEqual([KP_AUDIENCE]);
    expect(verified.payload.sub).toBe(accountUuid);
    expect(verified.payload.jti).toBe(challengeId); // §14.5: jti = challenge_id
    expect(verified.payload.operation_kind).toBe('kipkiren_pay.redemption');
    expect(verified.payload.operation_risk_tier).toBe('medium');
    expect(verified.payload.factor).toBe('phone_otp');
    expect(verified.payload.challenge_id).toBe(challengeId);
    expect(verified.payload.env).toBe('test');
    // nbf must equal iat (no negative time-skew window).
    expect(verified.payload.nbf).toBe(verified.payload.iat);
    // exp - iat must equal the risk-tier TTL.
    expect(
      (verified.payload.exp as number) - (verified.payload.iat as number)
    ).toBe(STEPUP_TTL_BY_RISK.medium);

    // Persisted in step_up_tokens.
    const persisted = await deps.stepUpTokensRepo.findByJti(challengeId);
    expect(persisted).not.toBeNull();
    expect(persisted!.accountUuid).toBe(accountUuid);
    expect(persisted!.audience).toBe(KP_AUDIENCE);

    // Audit entry written.
    expect(deps.auditLogger.entries.some((e) => e.action === 'stepup.token.issued')).toBe(true);
  });

  it.each([
    ['low', 600] as const,
    ['medium', 300] as const,
    ['high', 180] as const,
    ['very_high', 60] as const,
  ])('honours risk-tier TTL for %s', async (tier, ttl) => {
    const { challengeId, otp } = await runStepupChallenge(
      `+25471234710${tier === 'low' ? 0 : tier === 'medium' ? 1 : tier === 'high' ? 2 : 3}`,
      tier
    );
    const body = JSON.stringify({ challenge_id: challengeId, response: otp });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/stepup/verify',
      headers: signed({
        method: 'POST',
        url: '/v1/stepup/verify',
        body,
        idempotencyKey: `idem-ttl-${tier}`,
      }),
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.expires_in).toBe(ttl);
  });

  it('rejects an unknown challenge_id with auth_factor_failed (no leak)', async () => {
    const body = JSON.stringify({
      challenge_id: 'stp_00000000000000000000000000',
      response: '123456',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/stepup/verify',
      headers: signed({
        method: 'POST',
        url: '/v1/stepup/verify',
        body,
        idempotencyKey: 'idem-no-chal',
      }),
      payload: body,
    });
    expect(res.statusCode).toBe(401);
    const env = res.json();
    expect(env.error.code).toBe('auth_factor_failed');
    expect(env.error.detail.attempts_remaining).toBe(0);
  });

  it('rejects a login-purpose challenge with auth_factor_failed', async () => {
    // Create a login challenge via /v1/auth/challenges and try to consume it
    // at /v1/stepup/verify.
    const phone = '+254712348001';
    await createActiveCustomer(app, deps, phone);
    const challengeBody = JSON.stringify({ phone, factor: 'phone_otp', purpose: 'login' });
    const c = await app.inject({
      method: 'POST',
      url: '/v1/auth/challenges',
      headers: signed({
        method: 'POST',
        url: '/v1/auth/challenges',
        body: challengeBody,
        idempotencyKey: 'idem-wrong-flow',
      }),
      payload: challengeBody,
    });
    const challengeId = c.json().data.challenge_id as string;

    const body = JSON.stringify({ challenge_id: challengeId, response: '123456' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/stepup/verify',
      headers: signed({
        method: 'POST',
        url: '/v1/stepup/verify',
        body,
        idempotencyKey: 'idem-wrong-purpose',
      }),
      payload: body,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('auth_factor_failed');
  });

  it('rejects a wrong OTP with auth_factor_failed and decrements attempts_remaining', async () => {
    const { challengeId } = await runStepupChallenge('+254712349001');
    const body = JSON.stringify({ challenge_id: challengeId, response: '000000' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/stepup/verify',
      headers: signed({
        method: 'POST',
        url: '/v1/stepup/verify',
        body,
        idempotencyKey: 'idem-wrong-otp',
      }),
      payload: body,
    });
    expect(res.statusCode).toBe(401);
    const env = res.json();
    expect(env.error.code).toBe('auth_factor_failed');
    expect(env.error.detail).toMatchObject({
      challenge_id: challengeId,
      attempts_remaining: 2, // 3 max - 1 used
    });
  });

  it('locks the challenge after MAX_OTP_ATTEMPTS failures', async () => {
    const { challengeId } = await runStepupChallenge('+254712349002');
    const wrongBody = JSON.stringify({ challenge_id: challengeId, response: '000001' });
    for (let i = 0; i < 3; i++) {
      await app.inject({
        method: 'POST',
        url: '/v1/stepup/verify',
        headers: signed({
          method: 'POST',
          url: '/v1/stepup/verify',
          body: wrongBody,
          idempotencyKey: `idem-fail-${i}`,
        }),
        payload: wrongBody,
      });
    }
    // 4th attempt — challenge already locked.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/stepup/verify',
      headers: signed({
        method: 'POST',
        url: '/v1/stepup/verify',
        body: wrongBody,
        idempotencyKey: 'idem-fail-final',
      }),
      payload: wrongBody,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('auth_factor_failed');
    expect(res.json().error.detail.attempts_remaining).toBe(0);
  });

  it('cannot verify the same challenge twice (single-use)', async () => {
    const { challengeId, otp } = await runStepupChallenge('+254712349003');
    const body = JSON.stringify({ challenge_id: challengeId, response: otp });
    const r1 = await app.inject({
      method: 'POST',
      url: '/v1/stepup/verify',
      headers: signed({
        method: 'POST',
        url: '/v1/stepup/verify',
        body,
        idempotencyKey: 'idem-su-1',
      }),
      payload: body,
    });
    expect(r1.statusCode).toBe(200);

    const r2 = await app.inject({
      method: 'POST',
      url: '/v1/stepup/verify',
      headers: signed({
        method: 'POST',
        url: '/v1/stepup/verify',
        body,
        idempotencyKey: 'idem-su-2',
      }),
      payload: body,
    });
    // Challenge is consumed; second attempt rejected.
    expect(r2.statusCode).toBe(401);
    expect(r2.json().error.code).toBe('auth_factor_failed');
    expect(r2.json().error.detail.attempts_remaining).toBe(0);
  });
});
