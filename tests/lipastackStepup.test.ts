/**
 * ID-15 — LipaStack step-up audience + operation-kind catalogue.
 *
 * Per `docs/NEWDOCS_INSTRUCTION_PACK.md` ID-15 (LipaStack tech spec §A6/§A9):
 *   - `lipastack` is an accepted (non-URI) audience for /v1/stepup/challenges
 *   - new operation kinds: lipastack.payout.high_value,
 *     lipastack.admin.key_rotation, lipastack.merchant.dispute_decision
 *
 * No new tables, no new routes — pure enum + audience-list addition. These
 * tests pin the wire contract so a stray change to the enums is caught.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCanonicalString, sha256Hex, signRequest } from '@kmv/platform-shared/hmac';
import { buildApp, type App } from '../src/app.js';
import { makeTestDeps, TEST_APP_ID, TEST_HMAC_SECRET, type TestDepsBundle } from './helpers.js';

const LIPASTACK_AUDIENCE = 'lipastack';
const LIPASTACK_OPERATION_KINDS = [
  'lipastack.payout.high_value',
  'lipastack.admin.key_rotation',
  'lipastack.merchant.dispute_decision',
] as const;

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

describe('ID-15 — LipaStack stepup audience + operation kinds', () => {
  let app: App;
  let deps: TestDepsBundle;

  beforeEach(async () => {
    deps = makeTestDeps();
    app = await buildApp(deps);
  });

  afterEach(async () => {
    await app.close();
  });

  async function createActiveCustomer(phone: string): Promise<string> {
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
    if (r.statusCode !== 201) throw new Error(`createCustomer: ${r.statusCode} ${r.body}`);
    const accountUuid = r.json().data.account_uuid as string;
    await deps.customersRepo.changeState(accountUuid, ['pending_onboarding'], 'active');
    return accountUuid;
  }

  function initiate(account: string, operationKind: string) {
    const body = JSON.stringify({
      account_uuid: account,
      operation_audience: LIPASTACK_AUDIENCE,
      operation_kind: operationKind,
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

  it.each(LIPASTACK_OPERATION_KINDS)(
    'accepts the lipastack audience with %s',
    async (operationKind) => {
      const account = await createActiveCustomer(
        '+25471239' + Math.floor(1000 + Math.random() * 8999),
      );
      const res = await initiate(account, operationKind);
      expect(res.statusCode).toBe(201);
      // The STEP_UP_REQUIRED event carries the audience + operation kind so
      // Todoku (sending the OTP) and downstream audit can pin them.
      const event = deps.eventProducer.events.find(
        (e) =>
          e.type === 'STEP_UP_REQUIRED' && e.data.challenge_id === res.json().data.challenge_id,
      );
      expect(event).toBeDefined();
      expect(event!.data.operation_audience).toBe(LIPASTACK_AUDIENCE);
      expect(event!.data.operation_kind).toBe(operationKind);
    },
  );

  it('rejects an unknown operation_kind even with a valid lipastack audience', async () => {
    const account = await createActiveCustomer('+254712399999');
    const res = await initiate(account, 'lipastack.something_not_in_catalogue');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_request_invalid');
  });
});
