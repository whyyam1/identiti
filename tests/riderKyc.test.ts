/**
 * ID-12 — Rider-KYC extension (Itafika §15).
 *
 * Covers: happy path (rider_tier_1 + rider_tier_2), the rejection paths for
 * each verifier (NTSA licence, NTSA bike, M-Pesa probe), cross-account
 * uniqueness on the licence + bike hashes, rider_class atomic promotion on
 * platform_accounts (Q1 orthogonal — financial tier untouched), the GET +
 * retry routes, malformed-input rejections, scope rejections, and the
 * `identiti.kyc.events` `rider.*` events.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCanonicalString, sha256Hex, signRequest } from '@kmv/platform-shared/hmac';
import { buildApp, type App } from '../src/app.js';
import {
  makeMemCredStore,
  makeTestDeps,
  TEST_APP_ID,
  TEST_HMAC_SECRET,
  type TestDepsBundle,
} from './helpers.js';

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

const FUTURE = () => new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

interface RiderSubmitInput {
  licenceNumber?: string;
  licenceClass?: string;
  licenceExpiry?: string;
  bikeNumber?: string;
  bikeMake?: string;
  bikeModel?: string;
  mpesa?: string;
  insurance?: { policyNumber: string; expiry: string };
}

function submitBody(accountUuid: string, override: RiderSubmitInput = {}) {
  return JSON.stringify({
    account_uuid: accountUuid,
    driving_licence: {
      number: override.licenceNumber ?? 'DL12345678',
      class: override.licenceClass ?? 'A',
      expiry: override.licenceExpiry ?? FUTURE(),
    },
    motorbike_registration: {
      number: override.bikeNumber ?? 'KMCA123A',
      make: override.bikeMake ?? 'Boxer',
      model: override.bikeModel ?? '150',
    },
    mpesa_msisdn: override.mpesa ?? '+254712345678',
    ...(override.insurance
      ? {
          insurance: {
            policy_number: override.insurance.policyNumber,
            expiry: override.insurance.expiry,
          },
        }
      : {}),
  });
}

describe('POST /v1/kyc/rider/submit', () => {
  let app: App;
  let deps: TestDepsBundle;

  beforeEach(async () => {
    deps = makeTestDeps();
    app = await buildApp(deps);
  });

  afterEach(async () => {
    await app.close();
  });

  async function createCustomer(phone: string): Promise<string> {
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
    if (r.statusCode !== 201) throw new Error(`createCustomer: ${r.statusCode}`);
    return r.json().data.account_uuid as string;
  }

  function submit(body: string) {
    return app.inject({
      method: 'POST',
      url: '/v1/kyc/rider/submit',
      headers: signed({
        method: 'POST',
        url: '/v1/kyc/rider/submit',
        body,
        idempotencyKey: `idem_${Math.random().toString(36).slice(2)}`,
      }),
      payload: body,
    });
  }

  it('verifies a complete submission and promotes the account to rider_tier_1', async () => {
    const uuid = await createCustomer('+254712401001');
    const res = await submit(submitBody(uuid));
    expect(res.statusCode).toBe(201);
    const env = res.json();
    expect(env.data.state).toBe('verified');
    expect(env.data.rider_class).toBe('rider_tier_1');
    expect(env.data.submission_id).toMatch(/^rks_[0-9A-HJKMNP-TV-Z]{26}$/);

    // Account's financial tier is untouched (Q1 orthogonal); rider_class is set.
    const acc = await deps.customersRepo.findById(uuid);
    expect(acc!.tier).toBe('tier_0');
    expect(acc!.riderClass).toBe('rider_tier_1');
  });

  it('promotes to rider_tier_2 when insurance is included and valid', async () => {
    const uuid = await createCustomer('+254712401002');
    const res = await submit(
      submitBody(uuid, {
        insurance: { policyNumber: 'POL-987654', expiry: FUTURE() },
      }),
    );
    expect(res.statusCode).toBe(201);
    expect(res.json().data.rider_class).toBe('rider_tier_2');
    const acc = await deps.customersRepo.findById(uuid);
    expect(acc!.riderClass).toBe('rider_tier_2');
  });

  it('publishes rider.kyc_verified on verified submissions', async () => {
    const uuid = await createCustomer('+254712401003');
    const before = deps.eventProducer.events.length;
    await submit(submitBody(uuid));
    const newEvents = deps.eventProducer.events.slice(before);
    const verified = newEvents.find((e) => e.type === 'rider.kyc_verified');
    expect(verified).toBeDefined();
    expect(verified!.topic).toBe('identiti.kyc.events');
    expect(verified!.data.account_uuid).toBe(uuid);
    expect(verified!.data.rider_class).toBe('rider_tier_1');
  });

  it('rejects an expired driving licence', async () => {
    const uuid = await createCustomer('+254712401004');
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const res = await submit(submitBody(uuid, { licenceExpiry: past }));
    expect(res.statusCode).toBe(201);
    const env = res.json();
    expect(env.data.state).toBe('rejected');
    expect(env.data.rider_class).toBe('none');
    expect(env.data.rejection_reason).toContain('licence:licence_expired');
    // rider_class on account is NOT promoted on rejection.
    const acc = await deps.customersRepo.findById(uuid);
    expect(acc!.riderClass).toBe('none');
  });

  it('rejects a malformed bike registration', async () => {
    const uuid = await createCustomer('+254712401005');
    const res = await submit(submitBody(uuid, { bikeNumber: '!!!INVALID!!!' }));
    expect(res.statusCode).toBe(201);
    expect(res.json().data.state).toBe('rejected');
    expect(res.json().data.rejection_reason).toContain('bike:');
  });

  it('rejects an M-Pesa MSISDN that is not E.164', async () => {
    const uuid = await createCustomer('+254712401006');
    const res = await submit(submitBody(uuid, { mpesa: '0712345678' }));
    expect(res.statusCode).toBe(201);
    expect(res.json().data.state).toBe('rejected');
    expect(res.json().data.rejection_reason).toContain('mpesa:');
  });

  it('enforces cross-account uniqueness on the driving-licence hash', async () => {
    const uuidA = await createCustomer('+254712401007');
    const uuidB = await createCustomer('+254712401008');
    // First submission verifies a unique licence number.
    const r1 = await submit(submitBody(uuidA, { licenceNumber: 'DL77777' }));
    expect(r1.json().data.state).toBe('verified');
    // Different account, same licence number → 409 cross_account_collision.
    const r2 = await submit(submitBody(uuidB, { licenceNumber: 'DL77777' }));
    expect(r2.statusCode).toBe(409);
    expect(r2.json().error.code).toBe('rider_kyc_cross_account_collision');
    expect(r2.json().error.detail.conflict_kind).toBe('driving_licence');
  });

  it('enforces cross-account uniqueness on the bike-registration hash', async () => {
    const uuidA = await createCustomer('+254712401009');
    const uuidB = await createCustomer('+254712401010');
    const r1 = await submit(
      submitBody(uuidA, { licenceNumber: 'DL11111', bikeNumber: 'KMAB888B' }),
    );
    expect(r1.json().data.state).toBe('verified');
    const r2 = await submit(
      submitBody(uuidB, { licenceNumber: 'DL22222', bikeNumber: 'KMAB888B' }),
    );
    expect(r2.statusCode).toBe(409);
    expect(r2.json().error.detail.conflict_kind).toBe('bike_registration');
  });

  it('returns 404 for an unknown account', async () => {
    const res = await submit(submitBody('acc_00000000-0000-4000-8000-000000000000'));
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('customer_not_found');
  });

  it('rejects a malformed request body with 400', async () => {
    const res = await submit(JSON.stringify({ account_uuid: 'not-a-uuid' }));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_request_invalid');
  });

  it('rejects a caller without identiti:customers:write with 403', async () => {
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
              scopes: r.record.scopes.filter((s) => s !== 'identiti:customers:write'),
            },
          };
        },
      },
    });
    app = await buildApp(deps);
    const res = await submit(submitBody('acc_00000000-0000-4000-8000-000000000000'));
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('AUTH_SCOPE_INSUFFICIENT');
  });
});

describe('GET /v1/kyc/rider/:submission_id', () => {
  let app: App;
  let deps: TestDepsBundle;

  beforeEach(async () => {
    deps = makeTestDeps();
    app = await buildApp(deps);
  });

  afterEach(async () => {
    await app.close();
  });

  async function createCustomerAndSubmit(): Promise<string> {
    const phone = '+254712402' + Math.floor(100 + Math.random() * 899);
    // Build the body ONCE — re-JSON.stringify-ing with Math.random() in it
    // would produce a different payload than the one we signed.
    const createBody = JSON.stringify({
      phone,
      name_first: 'A',
      name_last: 'B',
      consent: { dpa_consent: true, kyc_consent: true, captured_at: new Date().toISOString() },
      app_correlation: `corr_${Math.random().toString(36).slice(2)}`,
    });
    const createRes = await app.inject({
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
    const uuid = createRes.json().data.account_uuid as string;
    const body = submitBody(uuid);
    const submitRes = await app.inject({
      method: 'POST',
      url: '/v1/kyc/rider/submit',
      headers: signed({
        method: 'POST',
        url: '/v1/kyc/rider/submit',
        body,
        idempotencyKey: `idem_${Math.random().toString(36).slice(2)}`,
      }),
      payload: body,
    });
    return submitRes.json().data.submission_id as string;
  }

  function get(submissionId: string) {
    const url = `/v1/kyc/rider/${submissionId}`;
    return app.inject({ method: 'GET', url, headers: signed({ method: 'GET', url }) });
  }

  it('returns the submission with all artefacts', async () => {
    const sid = await createCustomerAndSubmit();
    const res = await get(sid);
    expect(res.statusCode).toBe(200);
    const env = res.json();
    expect(env.data.submission_id).toBe(sid);
    expect(env.data.state).toBe('verified');
    expect(env.data.rider_class).toBe('rider_tier_1');
    expect(env.data.artefacts).toHaveLength(3); // licence + bike + mpesa (no insurance)
    const kinds = (env.data.artefacts as Array<{ kind: string }>).map((a) => a.kind).sort();
    expect(kinds).toEqual([
      'rider_driving_licence',
      'rider_motorbike_registration',
      'rider_mpesa_ownership_probe',
    ]);
  });

  it('returns 404 for an unknown submission_id', async () => {
    const res = await get('rks_00000000000000000000000000');
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('rider_kyc_submission_not_found');
  });

  it('rejects a malformed submission_id with 400', async () => {
    const res = await get('not-a-submission-id');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_request_invalid');
  });

  it('retry returns 501 NOT_IMPLEMENTED (v1.0 stub) for a known submission', async () => {
    const sid = await createCustomerAndSubmit();
    const url = `/v1/kyc/rider/${sid}/retry`;
    const res = await app.inject({
      method: 'POST',
      url,
      headers: signed({
        method: 'POST',
        url,
        body: '',
        idempotencyKey: `idem_${Math.random().toString(36).slice(2)}`,
      }),
    });
    expect(res.statusCode).toBe(501);
    expect(res.json().error.code).toBe('NOT_IMPLEMENTED');
  });
});
