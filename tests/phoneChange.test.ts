/**
 * Sprint 7 (Phase 7) — phone-change end-to-end.
 *   POST /v1/customers/:uuid/profile/phone-change            initiate
 *   POST /v1/customers/:uuid/profile/phone-change/confirm    confirm
 *
 * Exercises both verification methods, the X-Stepup-Token verifier (signature,
 * audience, subject, operation_kind, replay), the cooldown gate, the
 * cross-account uniqueness check on new_phone, OTP failure paths, and the
 * PHONE_CHANGED Kafka emission.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCanonicalString, sha256Hex, signRequest } from '@kmv/platform-shared/hmac';
import { buildApp, type App } from '../src/app.js';
import {
  makeTestDeps,
  TEST_APP_ID,
  TEST_HMAC_SECRET,
  type TestDepsBundle,
} from './helpers.js';

const IDENTITI_AUDIENCE = 'https://api.id.identiti.co.ke';

function signedAsApp(opts: {
  method: string;
  url: string;
  body?: string;
  idempotencyKey?: string;
  stepupToken?: string;
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
  if (opts.stepupToken) headers['x-stepup-token'] = opts.stepupToken;
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
    headers: signedAsApp({
      method: 'POST',
      url: '/v1/customers',
      body,
      idempotencyKey: `idem_${Math.random().toString(36).slice(2)}`,
    }),
    payload: body,
  });
  if (r.statusCode !== 201) throw new Error(`createCustomer: ${r.statusCode} ${r.body}`);
  const accountUuid = r.json().data.account_uuid as string;
  const ok = await deps.customersRepo.changeState(accountUuid, ['pending_onboarding'], 'active');
  if (!ok) throw new Error('failed to activate test account');
  return accountUuid;
}

async function mintStepupTokenFor(
  app: App,
  deps: TestDepsBundle,
  account: string,
  opts: { operationKind?: string; audience?: string } = {}
): Promise<string> {
  const operationKind = opts.operationKind ?? 'identiti.phone_change';
  const audience = opts.audience ?? IDENTITI_AUDIENCE;

  const initiateBody = JSON.stringify({
    account_uuid: account,
    operation_audience: audience,
    operation_kind: operationKind,
    operation_risk_tier: 'high',
    factor: 'phone_otp',
  });
  const initiate = await app.inject({
    method: 'POST',
    url: '/v1/stepup/challenges',
    headers: signedAsApp({
      method: 'POST',
      url: '/v1/stepup/challenges',
      body: initiateBody,
      idempotencyKey: `idem_${Math.random().toString(36).slice(2)}`,
    }),
    payload: initiateBody,
  });
  if (initiate.statusCode !== 201) {
    throw new Error(`stepup initiate: ${initiate.statusCode} ${initiate.body}`);
  }
  const challengeId = initiate.json().data.challenge_id as string;
  const event = deps.eventProducer.events.find(
    (e) => e.type === 'STEP_UP_REQUIRED' && e.data.challenge_id === challengeId
  );
  if (!event) throw new Error('expected STEP_UP_REQUIRED event for stepup mint');
  const otp = event.data.otp_plaintext as string;

  const verifyBody = JSON.stringify({ challenge_id: challengeId, response: otp });
  const verify = await app.inject({
    method: 'POST',
    url: '/v1/stepup/verify',
    headers: signedAsApp({
      method: 'POST',
      url: '/v1/stepup/verify',
      body: verifyBody,
      idempotencyKey: `idem_${Math.random().toString(36).slice(2)}`,
    }),
    payload: verifyBody,
  });
  if (verify.statusCode !== 200) {
    throw new Error(`stepup verify: ${verify.statusCode} ${verify.body}`);
  }
  return verify.json().data.stepup_token as string;
}

describe('POST /v1/customers/:uuid/profile/phone-change', () => {
  let app: App;
  let deps: TestDepsBundle;

  beforeEach(async () => {
    deps = makeTestDeps();
    app = await buildApp(deps);
  });

  afterEach(async () => {
    await app.close();
  });

  it('method otp_to_old_phone: completes synchronously, swaps phone, publishes PHONE_CHANGED', async () => {
    const oldPhone = '+254712390001';
    const newPhone = '+254712390101';
    const account = await createActiveCustomer(app, deps, oldPhone);
    const stepupToken = await mintStepupTokenFor(app, deps, account);

    const eventCountBefore = deps.eventProducer.events.length;
    const url = `/v1/customers/${account}/profile/phone-change`;
    const body = JSON.stringify({
      new_phone: newPhone,
      verification_method: 'otp_to_old_phone',
    });
    const r = await app.inject({
      method: 'POST',
      url,
      headers: signedAsApp({
        method: 'POST',
        url,
        body,
        idempotencyKey: 'idem-pc-1a',
        stepupToken,
      }),
      payload: body,
    });

    expect(r.statusCode).toBe(201);
    const env = r.json();
    expect(env.data.change_state).toBe('completed');
    expect(env.data.delivery_status).toBe('n/a');
    expect(env.data.change_id).toMatch(/^pch_[0-9A-HJKMNP-TV-Z]{26}$/);

    // Phone record is swapped — looking up by new phone hash returns this account.
    const newHash = deps.phoneCrypto.hash(newPhone);
    const collision = await deps.customersRepo.findByPhoneHash(newHash);
    expect(collision?.accountUuid).toBe(account);

    // Cooldown is set 24h ahead (within tolerance).
    const record = await deps.customersRepo.getPhoneRecord(account);
    const expectedCooldownMs = 24 * 60 * 60 * 1000;
    expect(record!.cooldownUntil!.getTime() - Date.now()).toBeGreaterThan(expectedCooldownMs - 5_000);

    // PHONE_CHANGED event published.
    const newEvents = deps.eventProducer.events.slice(eventCountBefore);
    const phoneChanged = newEvents.find((e) => e.type === 'PHONE_CHANGED');
    expect(phoneChanged).toBeDefined();
    expect(phoneChanged!.topic).toBe('identiti.phone.events');
    expect(phoneChanged!.data).toMatchObject({
      account_uuid: account,
      verification_method: 'otp_to_old_phone',
      new_phone_hash: newHash,
    });
  });

  it('method otp_to_new_phone_with_step_up_to_old: returns cooldown_active, publishes STEP_UP_REQUIRED to new phone', async () => {
    const oldPhone = '+254712390002';
    const newPhone = '+254712390102';
    const account = await createActiveCustomer(app, deps, oldPhone);
    const stepupToken = await mintStepupTokenFor(app, deps, account);

    const eventCountBefore = deps.eventProducer.events.length;
    const url = `/v1/customers/${account}/profile/phone-change`;
    const body = JSON.stringify({
      new_phone: newPhone,
      verification_method: 'otp_to_new_phone_with_step_up_to_old',
    });
    const r = await app.inject({
      method: 'POST',
      url,
      headers: signedAsApp({
        method: 'POST',
        url,
        body,
        idempotencyKey: 'idem-pc-2a',
        stepupToken,
      }),
      payload: body,
    });

    expect(r.statusCode).toBe(201);
    const env = r.json();
    expect(env.data.change_state).toBe('cooldown_active');
    expect(env.data.delivery_status).toBe('dispatched');

    // Phone is NOT yet swapped.
    const oldHash = deps.phoneCrypto.hash(oldPhone);
    const stillOld = await deps.customersRepo.findByPhoneHash(oldHash);
    expect(stillOld?.accountUuid).toBe(account);

    // STEP_UP_REQUIRED published with target.kind='new_phone'.
    const newEvents = deps.eventProducer.events.slice(eventCountBefore);
    const stepupReq = newEvents.find(
      (e) => e.type === 'STEP_UP_REQUIRED' && e.data.operation_kind === 'identiti.phone_change'
    );
    expect(stepupReq).toBeDefined();
    expect(stepupReq!.data.target).toMatchObject({
      kind: 'new_phone',
      phone_plaintext: newPhone,
    });
  });

  it('rejects when X-Stepup-Token header is missing', async () => {
    const account = await createActiveCustomer(app, deps, '+254712390003');
    const url = `/v1/customers/${account}/profile/phone-change`;
    const body = JSON.stringify({
      new_phone: '+254712390103',
      verification_method: 'otp_to_old_phone',
    });
    const r = await app.inject({
      method: 'POST',
      url,
      headers: signedAsApp({
        method: 'POST',
        url,
        body,
        idempotencyKey: 'idem-pc-no-stepup',
      }),
      payload: body,
    });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe('auth_factor_required');
  });

  it('rejects a step-up token issued for a different operation_kind', async () => {
    const account = await createActiveCustomer(app, deps, '+254712390004');
    // Mint a token for kipkiren_pay.redemption — wrong operation for phone-change.
    const wrongToken = await mintStepupTokenFor(app, deps, account, {
      operationKind: 'kipkiren_pay.redemption',
      audience: 'https://api.pay.kipkiren.com',
    });

    const url = `/v1/customers/${account}/profile/phone-change`;
    const body = JSON.stringify({
      new_phone: '+254712390104',
      verification_method: 'otp_to_old_phone',
    });
    const r = await app.inject({
      method: 'POST',
      url,
      headers: signedAsApp({
        method: 'POST',
        url,
        body,
        idempotencyKey: 'idem-pc-wrong-op',
        stepupToken: wrongToken,
      }),
      payload: body,
    });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe('stepup_token_invalid');
    // Reason here is wrong_audience because we expect IDENTITI_AUDIENCE; the
    // token's aud is kipkiren. Either reason is contract-acceptable.
    expect(['wrong_audience', 'wrong_operation_kind']).toContain(
      r.json().error.detail.reason
    );
  });

  it('rejects a step-up token issued for a different subject', async () => {
    const a1 = await createActiveCustomer(app, deps, '+254712390005');
    const a2 = await createActiveCustomer(app, deps, '+254712390006');
    const tokenForA2 = await mintStepupTokenFor(app, deps, a2);

    const url = `/v1/customers/${a1}/profile/phone-change`;
    const body = JSON.stringify({
      new_phone: '+254712390105',
      verification_method: 'otp_to_old_phone',
    });
    const r = await app.inject({
      method: 'POST',
      url,
      headers: signedAsApp({
        method: 'POST',
        url,
        body,
        idempotencyKey: 'idem-pc-wrong-sub',
        stepupToken: tokenForA2,
      }),
      payload: body,
    });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe('stepup_token_invalid');
    expect(r.json().error.detail.reason).toBe('wrong_subject');
  });

  it('rejects step-up token replay (already consumed)', async () => {
    const account = await createActiveCustomer(app, deps, '+254712390007');
    const stepupToken = await mintStepupTokenFor(app, deps, account);

    const url = `/v1/customers/${account}/profile/phone-change`;
    const body1 = JSON.stringify({
      new_phone: '+254712390107',
      verification_method: 'otp_to_old_phone',
    });
    const r1 = await app.inject({
      method: 'POST',
      url,
      headers: signedAsApp({
        method: 'POST',
        url,
        body: body1,
        idempotencyKey: 'idem-pc-replay-1',
        stepupToken,
      }),
      payload: body1,
    });
    expect(r1.statusCode).toBe(201);

    // Second use of the same step-up token must fail.
    const body2 = JSON.stringify({
      new_phone: '+254712390108',
      verification_method: 'otp_to_old_phone',
    });
    const r2 = await app.inject({
      method: 'POST',
      url,
      headers: signedAsApp({
        method: 'POST',
        url,
        body: body2,
        idempotencyKey: 'idem-pc-replay-2',
        stepupToken,
      }),
      payload: body2,
    });
    expect(r2.statusCode).toBe(401);
    expect(r2.json().error.code).toBe('stepup_token_invalid');
    expect(r2.json().error.detail.reason).toBe('replay_detected');
  });

  it('rejects when phone is in cooldown from a recent change', async () => {
    const account = await createActiveCustomer(app, deps, '+254712390008');
    const t1 = await mintStepupTokenFor(app, deps, account);
    const url = `/v1/customers/${account}/profile/phone-change`;
    const body1 = JSON.stringify({
      new_phone: '+254712390108',
      verification_method: 'otp_to_old_phone',
    });
    const r1 = await app.inject({
      method: 'POST',
      url,
      headers: signedAsApp({
        method: 'POST',
        url,
        body: body1,
        idempotencyKey: 'idem-pc-cd-1',
        stepupToken: t1,
      }),
      payload: body1,
    });
    expect(r1.statusCode).toBe(201);

    // Try again immediately — cooldown is now active.
    const t2 = await mintStepupTokenFor(app, deps, account);
    const body2 = JSON.stringify({
      new_phone: '+254712390109',
      verification_method: 'otp_to_old_phone',
    });
    const r2 = await app.inject({
      method: 'POST',
      url,
      headers: signedAsApp({
        method: 'POST',
        url,
        body: body2,
        idempotencyKey: 'idem-pc-cd-2',
        stepupToken: t2,
      }),
      payload: body2,
    });
    expect(r2.statusCode).toBe(422);
    expect(r2.json().error.code).toBe('phone_change_cooldown_active');
    expect(r2.json().error.detail.cooldown_until).toBeDefined();
  });

  it('rejects when new_phone is the same as the current phone', async () => {
    const phone = '+254712390009';
    const account = await createActiveCustomer(app, deps, phone);
    const stepupToken = await mintStepupTokenFor(app, deps, account);

    const url = `/v1/customers/${account}/profile/phone-change`;
    const body = JSON.stringify({ new_phone: phone, verification_method: 'otp_to_old_phone' });
    const r = await app.inject({
      method: 'POST',
      url,
      headers: signedAsApp({
        method: 'POST',
        url,
        body,
        idempotencyKey: 'idem-pc-same',
        stepupToken,
      }),
      payload: body,
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('validation_request_invalid');
  });

  it('rejects when new_phone is already registered to another account', async () => {
    const a1 = await createActiveCustomer(app, deps, '+254712390010');
    const collision = '+254712390110';
    await createActiveCustomer(app, deps, collision);
    const stepupToken = await mintStepupTokenFor(app, deps, a1);

    const url = `/v1/customers/${a1}/profile/phone-change`;
    const body = JSON.stringify({
      new_phone: collision,
      verification_method: 'otp_to_old_phone',
    });
    const r = await app.inject({
      method: 'POST',
      url,
      headers: signedAsApp({
        method: 'POST',
        url,
        body,
        idempotencyKey: 'idem-pc-collide',
        stepupToken,
      }),
      payload: body,
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('validation_phone_already_registered');
  });
});

describe('POST /v1/customers/:uuid/profile/phone-change/confirm', () => {
  let app: App;
  let deps: TestDepsBundle;

  beforeEach(async () => {
    deps = makeTestDeps();
    app = await buildApp(deps);
  });

  afterEach(async () => {
    await app.close();
  });

  async function initiateMethod2(
    account: string,
    newPhone: string
  ): Promise<{ changeId: string; otp: string }> {
    const stepupToken = await mintStepupTokenFor(app, deps, account);
    const url = `/v1/customers/${account}/profile/phone-change`;
    const body = JSON.stringify({
      new_phone: newPhone,
      verification_method: 'otp_to_new_phone_with_step_up_to_old',
    });
    const r = await app.inject({
      method: 'POST',
      url,
      headers: signedAsApp({
        method: 'POST',
        url,
        body,
        idempotencyKey: `idem_${Math.random().toString(36).slice(2)}`,
        stepupToken,
      }),
      payload: body,
    });
    if (r.statusCode !== 201) throw new Error(`initiate: ${r.statusCode} ${r.body}`);
    const changeId = r.json().data.change_id as string;
    const stepupReq = deps.eventProducer.events.find((e) => {
      if (e.type !== 'STEP_UP_REQUIRED') return false;
      if (e.data.operation_kind !== 'identiti.phone_change') return false;
      const target = e.data.target as { kind?: string } | undefined;
      return target?.kind === 'new_phone';
    });
    if (!stepupReq) throw new Error('expected new-phone STEP_UP_REQUIRED');
    return { changeId, otp: stepupReq.data.otp_plaintext as string };
  }

  it('completes the change on a correct OTP, swaps phone, publishes PHONE_CHANGED', async () => {
    const oldPhone = '+254712391001';
    const newPhone = '+254712391101';
    const account = await createActiveCustomer(app, deps, oldPhone);
    const { changeId, otp } = await initiateMethod2(account, newPhone);

    const eventCountBefore = deps.eventProducer.events.length;
    const url = `/v1/customers/${account}/profile/phone-change/confirm`;
    const body = JSON.stringify({ change_id: changeId, otp_response: otp });
    const r = await app.inject({
      method: 'POST',
      url,
      headers: signedAsApp({
        method: 'POST',
        url,
        body,
        idempotencyKey: 'idem-confirm-1',
      }),
      payload: body,
    });

    expect(r.statusCode).toBe(200);
    const env = r.json();
    expect(env.data.change_id).toBe(changeId);
    expect(env.data.change_state).toBe('completed');

    // Phone swapped.
    const newHash = deps.phoneCrypto.hash(newPhone);
    const lookup = await deps.customersRepo.findByPhoneHash(newHash);
    expect(lookup?.accountUuid).toBe(account);

    // PHONE_CHANGED published with verification_method='otp_to_new_phone_with_step_up_to_old'.
    const newEvents = deps.eventProducer.events.slice(eventCountBefore);
    const phoneChanged = newEvents.find((e) => e.type === 'PHONE_CHANGED');
    expect(phoneChanged).toBeDefined();
    expect(phoneChanged!.data.verification_method).toBe(
      'otp_to_new_phone_with_step_up_to_old'
    );
  });

  it('rejects a wrong OTP with auth_factor_failed and decrements attempts', async () => {
    const account = await createActiveCustomer(app, deps, '+254712391002');
    const { changeId } = await initiateMethod2(account, '+254712391102');

    const url = `/v1/customers/${account}/profile/phone-change/confirm`;
    const body = JSON.stringify({ change_id: changeId, otp_response: '000000' });
    const r = await app.inject({
      method: 'POST',
      url,
      headers: signedAsApp({
        method: 'POST',
        url,
        body,
        idempotencyKey: 'idem-confirm-wrong',
      }),
      payload: body,
    });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe('auth_factor_failed');
    expect(r.json().error.detail.attempts_remaining).toBe(2);
  });

  it('cancels the change after MAX_OTP_ATTEMPTS failures', async () => {
    const account = await createActiveCustomer(app, deps, '+254712391003');
    const { changeId } = await initiateMethod2(account, '+254712391103');

    const url = `/v1/customers/${account}/profile/phone-change/confirm`;
    const wrongBody = JSON.stringify({ change_id: changeId, otp_response: '000000' });
    for (let i = 0; i < 3; i++) {
      await app.inject({
        method: 'POST',
        url,
        headers: signedAsApp({
          method: 'POST',
          url,
          body: wrongBody,
          idempotencyKey: `idem-fail-${i}`,
        }),
        payload: wrongBody,
      });
    }
    // Phone-change row should now be cancelled.
    const change = await deps.phoneChangesRepo.findById(changeId);
    expect(change!.state).toBe('cancelled');
    expect(change!.cancelReason).toBe('max_otp_attempts');
  });

  it('rejects an unknown change_id with 404', async () => {
    const account = await createActiveCustomer(app, deps, '+254712391004');
    const url = `/v1/customers/${account}/profile/phone-change/confirm`;
    const body = JSON.stringify({
      change_id: 'pch_00000000000000000000000000',
      otp_response: '123456',
    });
    const r = await app.inject({
      method: 'POST',
      url,
      headers: signedAsApp({
        method: 'POST',
        url,
        body,
        idempotencyKey: 'idem-confirm-404',
      }),
      payload: body,
    });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe('phone_change_not_found');
  });

  it('rejects confirm on the wrong customer (path mismatch)', async () => {
    const a1 = await createActiveCustomer(app, deps, '+254712391005');
    const a2 = await createActiveCustomer(app, deps, '+254712391006');
    const { changeId, otp } = await initiateMethod2(a1, '+254712391105');

    const url = `/v1/customers/${a2}/profile/phone-change/confirm`;
    const body = JSON.stringify({ change_id: changeId, otp_response: otp });
    const r = await app.inject({
      method: 'POST',
      url,
      headers: signedAsApp({
        method: 'POST',
        url,
        body,
        idempotencyKey: 'idem-confirm-mismatch',
      }),
      payload: body,
    });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe('phone_change_not_found');
  });
});
