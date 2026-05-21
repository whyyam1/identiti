/**
 * ID-13 — KYB extension (LipaStack §A5.1 / newdocs pack ID-13).
 *
 * Covers: happy path (BRS-valid + all directors IPRS-verified → state=verified
 * + KYB_VERIFIED event), pending_info when a director has no IPRS, rejection
 * on BRS format failure, cross-account uniqueness on biz-reg + KRA-PIN,
 * signatory-missing 400, scope rejection, GET, retry stub.
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

/**
 * Create a customer and (optionally) verify them via IPRS. The IPRS stub
 * default-returns full_match for any unknown national_id, so the only
 * requirement here is uniqueness across accounts in a single test.
 */
async function createCustomer(
  app: App,
  phone: string,
  opts: { iprs?: { nationalId: string } } = {},
): Promise<string> {
  const createBody = JSON.stringify({
    phone,
    name_first: 'Wanjiru',
    name_last: 'Kamau',
    consent: { dpa_consent: true, kyc_consent: true, captured_at: new Date().toISOString() },
    app_correlation: `corr_${Math.random().toString(36).slice(2)}`,
  });
  const cRes = await app.inject({
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
  if (cRes.statusCode !== 201) throw new Error(`createCustomer: ${cRes.statusCode} ${cRes.body}`);
  const uuid = cRes.json().data.account_uuid as string;

  if (opts.iprs) {
    const iprsBody = JSON.stringify({
      national_id: opts.iprs.nationalId,
      name_first: 'Wanjiru',
      name_last: 'Kamau',
      date_of_birth: '1992-04-15',
    });
    const url = `/v1/customers/${uuid}/kyc/iprs`;
    const iRes = await app.inject({
      method: 'POST',
      url,
      headers: signed({
        method: 'POST',
        url,
        body: iprsBody,
        idempotencyKey: `idem_${Math.random().toString(36).slice(2)}`,
      }),
      payload: iprsBody,
    });
    if (iRes.statusCode !== 201) throw new Error(`postIprs: ${iRes.statusCode} ${iRes.body}`);
  }

  return uuid;
}

interface KybSubmitInput {
  businessName?: string;
  businessRegistrationNumber?: string;
  kraPin?: string;
  businessType?: 'sole_proprietor' | 'partnership' | 'company' | 'llp';
  directors: Array<{ account_uuid: string; is_signatory: boolean; ownership_pct?: number }>;
}

function initiateBody(input: KybSubmitInput): string {
  return JSON.stringify({
    business_name: input.businessName ?? 'Kamau Holdings Ltd',
    business_registration_number: input.businessRegistrationNumber ?? 'CR123456',
    kra_pin: input.kraPin ?? 'P012345678Q',
    business_type: input.businessType ?? 'company',
    directors: input.directors,
  });
}

function postInitiate(app: App, body: string) {
  return app.inject({
    method: 'POST',
    url: '/v1/kyb/initiate',
    headers: signed({
      method: 'POST',
      url: '/v1/kyb/initiate',
      body,
      idempotencyKey: `idem_${Math.random().toString(36).slice(2)}`,
    }),
    payload: body,
  });
}

describe('POST /v1/kyb/initiate', () => {
  let app: App;
  let deps: TestDepsBundle;

  beforeEach(async () => {
    deps = makeTestDeps();
    app = await buildApp(deps);
  });

  afterEach(async () => {
    await app.close();
  });

  it('verifies a complete submission with one IPRS-verified director', async () => {
    const dir = await createCustomer(app, '+254712500001', { iprs: { nationalId: '20000001' } });
    const before = deps.eventProducer.events.length;
    const res = await postInitiate(
      app,
      initiateBody({ directors: [{ account_uuid: dir, is_signatory: true, ownership_pct: 100 }] }),
    );
    expect(res.statusCode).toBe(201);
    const env = res.json();
    expect(env.data.state).toBe('verified');
    expect(env.data.kyb_id).toMatch(/^kyb_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(env.data.rejection_reason).toBeUndefined();
    expect(env.data.pending_info_reason).toBeUndefined();

    const newEvents = deps.eventProducer.events.slice(before);
    const verified = newEvents.find((e) => e.type === 'KYB_VERIFIED');
    expect(verified).toBeDefined();
    expect(verified!.topic).toBe('identiti.kyb.events');
    expect(verified!.data.state).toBe('verified');
    expect(verified!.data.director_account_uuids).toEqual([dir]);

    expect(deps.auditLogger.entries.some((e) => e.action === 'kyb.verified')).toBe(true);
  });

  it('returns state=pending_info when a director has no verified IPRS', async () => {
    const dirVerified = await createCustomer(app, '+254712500010', {
      iprs: { nationalId: '20000010' },
    });
    const dirNoKyc = await createCustomer(app, '+254712500011'); // no IPRS
    const before = deps.eventProducer.events.length;
    const res = await postInitiate(
      app,
      initiateBody({
        directors: [
          { account_uuid: dirVerified, is_signatory: true, ownership_pct: 60 },
          { account_uuid: dirNoKyc, is_signatory: false, ownership_pct: 40 },
        ],
      }),
    );
    expect(res.statusCode).toBe(201);
    const env = res.json();
    expect(env.data.state).toBe('pending_info');
    expect(env.data.pending_info_reason).toContain('director_iprs_missing');
    expect(env.data.pending_info_reason).toContain(dirNoKyc);

    const pending = deps.eventProducer.events
      .slice(before)
      .find((e) => e.type === 'KYB_PENDING_INFO');
    expect(pending).toBeDefined();
    expect(pending!.data.state).toBe('pending_info');

    expect(deps.auditLogger.entries.some((e) => e.action === 'kyb.pending_info')).toBe(true);
  });

  it('rejects on bad business_registration_number format with state=rejected', async () => {
    const dir = await createCustomer(app, '+254712500020', { iprs: { nationalId: '20000020' } });
    const before = deps.eventProducer.events.length;
    const res = await postInitiate(
      app,
      initiateBody({
        businessRegistrationNumber: 'NOT-A-REAL-BRN',
        directors: [{ account_uuid: dir, is_signatory: true, ownership_pct: 100 }],
      }),
    );
    expect(res.statusCode).toBe(201);
    const env = res.json();
    expect(env.data.state).toBe('rejected');
    expect(env.data.rejection_reason).toBe('business_registration_format');

    const rejected = deps.eventProducer.events
      .slice(before)
      .find((e) => e.type === 'KYB_REJECTED');
    expect(rejected).toBeDefined();
    expect(rejected!.data.rejection_reason).toBe('business_registration_format');
  });

  it('rejects on bad KRA PIN format with state=rejected', async () => {
    const dir = await createCustomer(app, '+254712500030', { iprs: { nationalId: '20000030' } });
    const res = await postInitiate(
      app,
      initiateBody({
        kraPin: 'BAD-PIN',
        directors: [{ account_uuid: dir, is_signatory: true, ownership_pct: 100 }],
      }),
    );
    expect(res.statusCode).toBe(201);
    expect(res.json().data.state).toBe('rejected');
    expect(res.json().data.rejection_reason).toBe('kra_pin_format');
  });

  it('enforces cross-account uniqueness on the business registration hash', async () => {
    const dirA = await createCustomer(app, '+254712500040', { iprs: { nationalId: '20000040' } });
    const dirB = await createCustomer(app, '+254712500041', { iprs: { nationalId: '20000041' } });
    const r1 = await postInitiate(
      app,
      initiateBody({
        businessRegistrationNumber: 'CR555555',
        kraPin: 'P111111111A',
        directors: [{ account_uuid: dirA, is_signatory: true, ownership_pct: 100 }],
      }),
    );
    expect(r1.json().data.state).toBe('verified');

    // Different directors + different KRA PIN, but SAME business registration.
    const r2 = await postInitiate(
      app,
      initiateBody({
        businessRegistrationNumber: 'CR555555',
        kraPin: 'P222222222B',
        directors: [{ account_uuid: dirB, is_signatory: true, ownership_pct: 100 }],
      }),
    );
    expect(r2.statusCode).toBe(409);
    expect(r2.json().error.code).toBe('kyb_cross_account_collision');
    expect(r2.json().error.detail.conflict_kind).toBe('business_registration');
  });

  it('enforces cross-account uniqueness on the KRA PIN hash', async () => {
    const dirA = await createCustomer(app, '+254712500050', { iprs: { nationalId: '20000050' } });
    const dirB = await createCustomer(app, '+254712500051', { iprs: { nationalId: '20000051' } });
    const r1 = await postInitiate(
      app,
      initiateBody({
        businessRegistrationNumber: 'CR600001',
        kraPin: 'P333333333C',
        directors: [{ account_uuid: dirA, is_signatory: true, ownership_pct: 100 }],
      }),
    );
    expect(r1.json().data.state).toBe('verified');

    // Different business + different directors, but SAME KRA PIN.
    const r2 = await postInitiate(
      app,
      initiateBody({
        businessRegistrationNumber: 'CR600002',
        kraPin: 'P333333333C',
        directors: [{ account_uuid: dirB, is_signatory: true, ownership_pct: 100 }],
      }),
    );
    expect(r2.statusCode).toBe(409);
    expect(r2.json().error.detail.conflict_kind).toBe('kra_pin');
  });

  it('rejects 400 when no director is marked is_signatory', async () => {
    const dir = await createCustomer(app, '+254712500060', { iprs: { nationalId: '20000060' } });
    const res = await postInitiate(
      app,
      initiateBody({ directors: [{ account_uuid: dir, is_signatory: false, ownership_pct: 100 }] }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_request_invalid');
    expect(res.json().error.message).toContain('signatory');
  });

  it('returns 404 when a director account_uuid does not exist', async () => {
    const res = await postInitiate(
      app,
      initiateBody({
        directors: [
          {
            account_uuid: 'acc_00000000-0000-4000-8000-000000000000',
            is_signatory: true,
            ownership_pct: 100,
          },
        ],
      }),
    );
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('director_account_not_found');
  });

  it('rejects a malformed request body with 400', async () => {
    const url = '/v1/kyb/initiate';
    const body = JSON.stringify({ business_name: 'X' }); // missing required fields
    const res = await app.inject({
      method: 'POST',
      url,
      headers: signed({
        method: 'POST',
        url,
        body,
        idempotencyKey: `idem_${Math.random().toString(36).slice(2)}`,
      }),
      payload: body,
    });
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
    const res = await postInitiate(
      app,
      initiateBody({
        directors: [
          {
            account_uuid: 'acc_00000000-0000-4000-8000-000000000000',
            is_signatory: true,
            ownership_pct: 100,
          },
        ],
      }),
    );
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('AUTH_SCOPE_INSUFFICIENT');
  });
});

describe('GET /v1/kyb/:kyb_id and retry stub', () => {
  let app: App;
  let deps: TestDepsBundle;

  beforeEach(async () => {
    deps = makeTestDeps();
    app = await buildApp(deps);
  });

  afterEach(async () => {
    await app.close();
  });

  async function createKyb(): Promise<string> {
    const dir = await createCustomer(app, '+254712510001', { iprs: { nationalId: '21000001' } });
    const res = await postInitiate(
      app,
      initiateBody({
        directors: [{ account_uuid: dir, is_signatory: true, ownership_pct: 100 }],
      }),
    );
    return res.json().data.kyb_id as string;
  }

  it('returns the KYB record with director links', async () => {
    const kybId = await createKyb();
    const url = `/v1/kyb/${kybId}`;
    const res = await app.inject({
      method: 'GET',
      url,
      headers: signed({ method: 'GET', url }),
    });
    expect(res.statusCode).toBe(200);
    const env = res.json();
    expect(env.data.kyb_id).toBe(kybId);
    expect(env.data.state).toBe('verified');
    expect(env.data.business_type).toBe('company');
    expect(env.data.directors).toHaveLength(1);
    expect(env.data.directors[0]!.is_signatory).toBe(true);
    expect(env.data.directors[0]!.kyc_verified_at_submit).toBe(true);
  });

  it('returns 404 for an unknown kyb_id', async () => {
    const url = '/v1/kyb/kyb_00000000000000000000000000';
    const res = await app.inject({
      method: 'GET',
      url,
      headers: signed({ method: 'GET', url }),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('kyb_record_not_found');
  });

  it('rejects a malformed kyb_id with 400', async () => {
    const url = '/v1/kyb/not-a-kyb-id';
    const res = await app.inject({
      method: 'GET',
      url,
      headers: signed({ method: 'GET', url }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_request_invalid');
  });

  it('retry returns 501 NOT_IMPLEMENTED for a known kyb_id (v1.0 stub)', async () => {
    const kybId = await createKyb();
    const url = `/v1/kyb/${kybId}/retry`;
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
