/**
 * POST /v1/stepup/tokens/validate — Schema Appendix §7.5 / §7.6, Scaffold §14.4.
 *
 * Diagnostic endpoint: verifies a step-up JWT against the expected audience /
 * subject / operation kind WITHOUT consuming the JTI. Always 200 — `valid`
 * carries the verdict.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCanonicalString, sha256Hex, signRequest } from '@kmv/platform-shared/hmac';
import { buildApp, type App } from '../src/app.js';
import {
  makeTestDeps,
  makeMemCredStore,
  TEST_APP_ID,
  TEST_HMAC_SECRET,
  type TestDepsBundle,
} from './helpers.js';

const KP_AUDIENCE = 'https://api.pay.kipkiren.com';
const OPERATION_KIND = 'kipkiren_pay.redemption';

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

describe('POST /v1/stepup/tokens/validate', () => {
  let app: App;
  let deps: TestDepsBundle;

  beforeEach(async () => {
    deps = makeTestDeps();
    app = await buildApp(deps);
  });

  afterEach(async () => {
    await app.close();
  });

  /** Issue a genuine step-up token: create + activate a customer, run the
   * challenge, complete the verify. Returns the token, its account, and jti. */
  async function issueStepupToken(
    phone: string,
  ): Promise<{ token: string; accountUuid: string; jti: string }> {
    const createBody = JSON.stringify({
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
        body: createBody,
        idempotencyKey: `idem_${Math.random().toString(36).slice(2)}`,
      }),
      payload: createBody,
    });
    if (created.statusCode !== 201) throw new Error(`createCustomer: ${created.statusCode}`);
    const accountUuid = created.json().data.account_uuid as string;
    await deps.customersRepo.changeState(accountUuid, ['pending_onboarding'], 'active');

    const initBody = JSON.stringify({
      account_uuid: accountUuid,
      operation_audience: KP_AUDIENCE,
      operation_kind: OPERATION_KIND,
      operation_risk_tier: 'medium',
      factor: 'phone_otp',
    });
    const init = await app.inject({
      method: 'POST',
      url: '/v1/stepup/challenges',
      headers: signed({
        method: 'POST',
        url: '/v1/stepup/challenges',
        body: initBody,
        idempotencyKey: `idem_${Math.random().toString(36).slice(2)}`,
      }),
      payload: initBody,
    });
    if (init.statusCode !== 201) throw new Error(`challenge: ${init.statusCode}`);
    const challengeId = init.json().data.challenge_id as string;
    const event = deps.eventProducer.events.find(
      (e) => e.type === 'STEP_UP_REQUIRED' && e.data.challenge_id === challengeId,
    );
    const otp = event!.data.otp_plaintext as string;

    const verifyBody = JSON.stringify({ challenge_id: challengeId, response: otp });
    const verified = await app.inject({
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
    if (verified.statusCode !== 200) throw new Error(`verify: ${verified.statusCode}`);
    return { token: verified.json().data.stepup_token as string, accountUuid, jti: challengeId };
  }

  function validate(bodyObj: Record<string, unknown>) {
    const body = JSON.stringify(bodyObj);
    return app.inject({
      method: 'POST',
      url: '/v1/stepup/tokens/validate',
      headers: signed({
        method: 'POST',
        url: '/v1/stepup/tokens/validate',
        body,
        idempotencyKey: `idem_${Math.random().toString(36).slice(2)}`,
      }),
      payload: body,
    });
  }

  it('returns valid:true with claims for a correct token', async () => {
    const { token, accountUuid } = await issueStepupToken('+254712380001');
    const res = await validate({
      stepup_token: token,
      expected_audience: KP_AUDIENCE,
      expected_subject: accountUuid,
      expected_operation_kind: OPERATION_KIND,
    });
    expect(res.statusCode).toBe(200);
    const env = res.json();
    expect(env.ok).toBe(true);
    expect(env.data.valid).toBe(true);
    expect(env.data.claims.sub).toBe(accountUuid);
    expect(env.data.claims.operation_kind).toBe(OPERATION_KIND);
    expect(env.data.invalid_reason).toBeUndefined();
  });

  it('does NOT consume the token — the JTI stays unconsumed afterward', async () => {
    const { token, accountUuid, jti } = await issueStepupToken('+254712380002');
    const first = await validate({
      stepup_token: token,
      expected_audience: KP_AUDIENCE,
      expected_subject: accountUuid,
      expected_operation_kind: OPERATION_KIND,
    });
    expect(first.json().data.valid).toBe(true);
    // A second validate still passes — and markConsumed still succeeds,
    // proving validate left the JTI fresh (a guard would have consumed it).
    const second = await validate({
      stepup_token: token,
      expected_audience: KP_AUDIENCE,
      expected_subject: accountUuid,
      expected_operation_kind: OPERATION_KIND,
    });
    expect(second.json().data.valid).toBe(true);
    const firstConsume = await deps.stepUpTokensRepo.markConsumed(jti, new Date());
    expect(firstConsume).toBe(true);
  });

  it('returns valid:false for a wrong expected_subject', async () => {
    const { token } = await issueStepupToken('+254712380003');
    const res = await validate({
      stepup_token: token,
      expected_audience: KP_AUDIENCE,
      expected_subject: 'acc_00000000-0000-4000-8000-000000000000',
      expected_operation_kind: OPERATION_KIND,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.valid).toBe(false);
    expect(res.json().data.invalid_reason).toBe('wrong_subject');
  });

  it('returns valid:false for a wrong expected_operation_kind', async () => {
    const { token, accountUuid } = await issueStepupToken('+254712380004');
    const res = await validate({
      stepup_token: token,
      expected_audience: KP_AUDIENCE,
      expected_subject: accountUuid,
      expected_operation_kind: 'kipkiren_pay.reversal',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.valid).toBe(false);
    expect(res.json().data.invalid_reason).toBe('wrong_operation_kind');
  });

  it('returns valid:false for a wrong expected_audience', async () => {
    const { token, accountUuid } = await issueStepupToken('+254712380005');
    const res = await validate({
      stepup_token: token,
      expected_audience: 'https://api.todoku.co.ke',
      expected_subject: accountUuid,
      expected_operation_kind: OPERATION_KIND,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.valid).toBe(false);
    expect(typeof res.json().data.invalid_reason).toBe('string');
  });

  it('returns valid:false for a tampered token', async () => {
    const { token, accountUuid } = await issueStepupToken('+254712380006');
    const tampered = token.slice(0, -4) + 'AAAA';
    const res = await validate({
      stepup_token: tampered,
      expected_audience: KP_AUDIENCE,
      expected_subject: accountUuid,
      expected_operation_kind: OPERATION_KIND,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.valid).toBe(false);
  });

  it('rejects a malformed request body with 400', async () => {
    const res = await validate({ stepup_token: 'x' }); // missing required fields
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_request_invalid');
  });

  it('rejects a caller without identiti:stepup:verify with 403', async () => {
    await app.close();
    const base = makeMemCredStore();
    deps = makeTestDeps({
      credentialStore: {
        async lookup(appId) {
          const r = await base.lookup(appId);
          if (!r || appId !== TEST_APP_ID) return r;
          return {
            ...r,
            record: {
              ...r.record,
              scopes: r.record.scopes.filter((s) => s !== 'identiti:stepup:verify'),
            },
          };
        },
      },
    });
    app = await buildApp(deps);
    const res = await validate({
      stepup_token: 'irrelevant',
      expected_audience: KP_AUDIENCE,
      expected_subject: 'acc_00000000-0000-4000-8000-000000000000',
      expected_operation_kind: OPERATION_KIND,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('AUTH_SCOPE_INSUFFICIENT');
  });
});
