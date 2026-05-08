/**
 * Sprint 6 (Phase 4) — KYC + IPRS verification end-to-end.
 *   POST /v1/customers/:uuid/kyc/iprs
 *   GET  /v1/customers/:uuid/kyc/artefacts
 *   GET  /v1/customers/:uuid/kyc/artefacts/:id
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

function signedAsApp(opts: {
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
    name_first: 'Wanjiru',
    name_last: 'Kamau',
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

async function postIprs(
  app: App,
  uuid: string,
  body: Record<string, unknown>,
  idem = `idem_${Math.random().toString(36).slice(2)}`
) {
  const url = `/v1/customers/${uuid}/kyc/iprs`;
  const payload = JSON.stringify(body);
  return app.inject({
    method: 'POST',
    url,
    headers: signedAsApp({
      method: 'POST',
      url,
      body: payload,
      idempotencyKey: idem,
    }),
    payload,
  });
}

describe('POST /v1/customers/:uuid/kyc/iprs', () => {
  let app: App;
  let deps: TestDepsBundle;

  beforeEach(async () => {
    deps = makeTestDeps();
    app = await buildApp(deps);
  });

  afterEach(async () => {
    await app.close();
  });

  it('verifies a full_match, promotes tier_0 → tier_1, publishes KYC_APPROVED + TIER_CHANGED', async () => {
    const account = await createCustomer(app, '+254712370001');
    const eventCountBefore = deps.eventProducer.events.length;

    const r = await postIprs(app, account, {
      national_id: '12345678',
      name_first: 'Wanjiru',
      name_last: 'Kamau',
      date_of_birth: '1992-04-15',
    });

    expect(r.statusCode).toBe(201);
    const env = r.json();
    expect(env.data.artefact_id).toMatch(/^ver_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(env.data.state).toBe('verified');
    expect(env.data.iprs_summary).toMatchObject({
      match: 'full_match',
      confidence_band: 'high',
    });
    expect(env.data.tier_promoted_to).toBe('tier_1');

    // Account tier flipped.
    const tier = await deps.customersRepo.getTier(account);
    expect(tier?.tier).toBe('tier_1');
    expect(tier?.reason).toBe('iprs_verified');

    // Both events published.
    const newEvents = deps.eventProducer.events.slice(eventCountBefore);
    const kindByType = Object.fromEntries(newEvents.map((e) => [e.type, e]));
    expect(kindByType['KYC_APPROVED']).toBeDefined();
    expect(kindByType['KYC_APPROVED']!.topic).toBe('identiti.kyc.events');
    expect(kindByType['KYC_APPROVED']!.data).toMatchObject({
      account_uuid: account,
      kind: 'iprs_lookup',
      tier: 'tier_1',
    });
    expect(kindByType['TIER_CHANGED']).toBeDefined();
    expect(kindByType['TIER_CHANGED']!.topic).toBe('identiti.account.events');
    expect(kindByType['TIER_CHANGED']!.data).toMatchObject({
      account_uuid: account,
      from_tier: 'tier_0',
      to_tier: 'tier_1',
      reason: 'iprs_verified',
    });

    expect(deps.auditLogger.entries.some((e) => e.action === 'kyc.iprs.verified')).toBe(true);
  });

  it('returns 422 kyc_iprs_no_match for an unknown national_id', async () => {
    const account = await createCustomer(app, '+254712370002');
    deps.iprsService.register('99999999', { match: 'no_match', confidenceBand: 'low' });

    const r = await postIprs(app, account, {
      national_id: '99999999',
      name_first: 'Test',
      name_last: 'User',
      date_of_birth: '1990-01-01',
    });

    expect(r.statusCode).toBe(422);
    const env = r.json();
    expect(env.error.code).toBe('kyc_iprs_no_match');
    expect(env.error.detail.lookup_at).toBeDefined();

    // A failed kyc_records row still gets persisted for audit.
    const records = await deps.kycRecordsRepo.listByAccount(account);
    expect(records).toHaveLength(1);
    expect(records[0]!.status).toBe('failed');
    expect(records[0]!.failureReason).toBe('kyc_iprs_no_match');

    // Tier did NOT change.
    const tier = await deps.customersRepo.getTier(account);
    expect(tier?.tier).toBe('tier_0');
  });

  it('returns 422 kyc_iprs_document_mismatch for a partial_match', async () => {
    const account = await createCustomer(app, '+254712370003');
    deps.iprsService.register('22222222', { match: 'partial_match', confidenceBand: 'medium' });

    const r = await postIprs(app, account, {
      national_id: '22222222',
      name_first: 'Wrong',
      name_last: 'Name',
      date_of_birth: '1985-06-12',
    });

    expect(r.statusCode).toBe(422);
    const env = r.json();
    expect(env.error.code).toBe('kyc_iprs_document_mismatch');
    expect(env.error.detail.mismatch_fields).toEqual([
      'name_first',
      'name_last',
      'date_of_birth',
    ]);
  });

  it('returns 502 upstream_iprs_unavailable when IPRS is down', async () => {
    const account = await createCustomer(app, '+254712370004');
    deps.iprsService.setUnavailable('33333333');

    const r = await postIprs(app, account, {
      national_id: '33333333',
      name_first: 'Test',
      name_last: 'User',
      date_of_birth: '1990-01-01',
    });

    expect(r.statusCode).toBe(502);
    expect(r.json().error.code).toBe('upstream_iprs_unavailable');
    expect(r.json().error.detail.retry_after_seconds).toBe(30);

    // No kyc_records row should be written when IPRS never responded.
    const records = await deps.kycRecordsRepo.listByAccount(account);
    expect(records).toHaveLength(0);
  });

  it('returns 409 kyc_artefact_already_submitted when the same account already verified IPRS', async () => {
    const account = await createCustomer(app, '+254712370005');
    const first = await postIprs(app, account, {
      national_id: '44444401',
      name_first: 'A',
      name_last: 'B',
      date_of_birth: '1990-01-01',
    });
    expect(first.statusCode).toBe(201);

    const second = await postIprs(app, account, {
      national_id: '44444402',
      name_first: 'A',
      name_last: 'B',
      date_of_birth: '1990-01-01',
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('kyc_artefact_already_submitted');
  });

  it('returns 422 kyc_iprs_no_match when another account already verified the same national_id', async () => {
    const a1 = await createCustomer(app, '+254712370006');
    const a2 = await createCustomer(app, '+254712370007');

    const first = await postIprs(app, a1, {
      national_id: '55555555',
      name_first: 'A',
      name_last: 'B',
      date_of_birth: '1990-01-01',
    });
    expect(first.statusCode).toBe(201);

    const second = await postIprs(app, a2, {
      national_id: '55555555',
      name_first: 'A',
      name_last: 'B',
      date_of_birth: '1990-01-01',
    });
    expect(second.statusCode).toBe(422);
    expect(second.json().error.code).toBe('kyc_iprs_no_match');
  });

  it('rejects an unknown account with 404', async () => {
    const r = await postIprs(app, 'acc_00000000-0000-4000-8000-000000000000', {
      national_id: '12345678',
      name_first: 'A',
      name_last: 'B',
      date_of_birth: '1990-01-01',
    });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe('customer_not_found');
  });

  it('rejects malformed national_id with validation_request_invalid', async () => {
    const account = await createCustomer(app, '+254712370008');
    const r = await postIprs(app, account, {
      national_id: 'NOT-DIGITS',
      name_first: 'A',
      name_last: 'B',
      date_of_birth: '1990-01-01',
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('validation_request_invalid');
  });
});

describe('GET /v1/customers/:uuid/kyc/artefacts(/:id)', () => {
  let app: App;
  let deps: TestDepsBundle;

  beforeEach(async () => {
    deps = makeTestDeps();
    app = await buildApp(deps);
  });

  afterEach(async () => {
    await app.close();
  });

  it('lists the account-specific artefacts and reads one by id', async () => {
    const account = await createCustomer(app, '+254712380001');
    const submission = await postIprs(app, account, {
      national_id: '88888888',
      name_first: 'A',
      name_last: 'B',
      date_of_birth: '1990-01-01',
    });
    expect(submission.statusCode).toBe(201);
    const artefactId = submission.json().data.artefact_id as string;

    const list = await app.inject({
      method: 'GET',
      url: `/v1/customers/${account}/kyc/artefacts`,
      headers: signedAsApp({
        method: 'GET',
        url: `/v1/customers/${account}/kyc/artefacts`,
      }),
    });
    expect(list.statusCode).toBe(200);
    const items = list.json().data.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]!.artefact_id).toBe(artefactId);
    expect(items[0]!.state).toBe('verified');
    expect(items[0]!.kind).toBe('iprs_lookup');

    const read = await app.inject({
      method: 'GET',
      url: `/v1/customers/${account}/kyc/artefacts/${artefactId}`,
      headers: signedAsApp({
        method: 'GET',
        url: `/v1/customers/${account}/kyc/artefacts/${artefactId}`,
      }),
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().data.artefact_id).toBe(artefactId);
  });

  it('returns 404 reading an artefact that belongs to a different account', async () => {
    const a1 = await createCustomer(app, '+254712380002');
    const a2 = await createCustomer(app, '+254712380003');
    const submission = await postIprs(app, a1, {
      national_id: '77777771',
      name_first: 'A',
      name_last: 'B',
      date_of_birth: '1990-01-01',
    });
    const artefactId = submission.json().data.artefact_id as string;

    const r = await app.inject({
      method: 'GET',
      url: `/v1/customers/${a2}/kyc/artefacts/${artefactId}`,
      headers: signedAsApp({
        method: 'GET',
        url: `/v1/customers/${a2}/kyc/artefacts/${artefactId}`,
      }),
    });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe('kyc_artefact_not_found');
  });
});
