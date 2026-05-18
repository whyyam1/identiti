/**
 * Sprint 8 (Phase 9) — operator console additions.
 *   GET  /v1/operator/customers/:uuid/audit       audit-trail read
 *   GET  /v1/operator/kyc/pending                 pending KYC list
 *   POST /v1/operator/kyc/:id/approve             approve a pending record
 *   POST /v1/operator/kyc/:id/reject              reject a pending record
 *
 * Pending records are seeded via the in-memory KycRecordsRepo directly
 * because the IPRS path always completes synchronously to verified/failed —
 * actual pending records will appear only when document/selfie/address-proof
 * routes ship (KYC vendor Track A).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateUlid } from '@kmv/platform-shared';
import { buildCanonicalString, sha256Hex, signRequest } from '@kmv/platform-shared/hmac';
import { buildApp, type App } from '../src/app.js';
import {
  makeTestDeps,
  TEST_APP_ID,
  TEST_HMAC_SECRET,
  TEST_OPERATOR_APP_ID,
  TEST_OPERATOR_HMAC_SECRET,
  type TestDepsBundle,
} from './helpers.js';

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

async function seedPendingKyc(
  deps: TestDepsBundle,
  accountId: string,
  tier: 'tier_1' | 'tier_2' = 'tier_1',
): Promise<string> {
  const id = `ver_${generateUlid()}`;
  await deps.kycRecordsRepo.create({
    id,
    accountId,
    kind: tier === 'tier_1' ? 'national_id_front' : 'address_proof_utility',
    tier,
    verificationMethod: 'document_scan',
    status: 'pending',
  });
  return id;
}

describe('GET /v1/operator/customers/:uuid/audit', () => {
  let app: App;
  let deps: TestDepsBundle;

  beforeEach(async () => {
    deps = makeTestDeps();
    app = await buildApp(deps);
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns audit entries for a platform_account, newest first', async () => {
    const account = await createCustomer(app, '+254712400001');
    // Trigger an operator suspend → reactivate to generate audit entries.
    await app.inject({
      method: 'POST',
      url: `/v1/operator/customers/${account}/suspend`,
      // First need to activate the account.
      headers: signedAsOperator({
        method: 'POST',
        url: `/v1/operator/customers/${account}/suspend`,
        body: JSON.stringify({ reason: 'AML hit' }),
        idempotencyKey: 'idem-aud-suspend',
      }),
      payload: JSON.stringify({ reason: 'AML hit' }),
    });
    // The suspend will fail because the account is pending_onboarding, but
    // that still writes a failure audit entry. Combined with the customer-create
    // success audit, we have two entries on this account.

    const url = `/v1/operator/customers/${account}/audit`;
    const r = await app.inject({
      method: 'GET',
      url,
      headers: signedAsOperator({ method: 'GET', url }),
    });
    expect(r.statusCode).toBe(200);
    const env = r.json();
    expect(env.data.account_uuid).toBe(account);
    expect(Array.isArray(env.data.items)).toBe(true);
    expect(env.data.items.length).toBeGreaterThanOrEqual(2);
    // Newest first.
    const actions = (env.data.items as Array<{ action: string }>).map((i) => i.action);
    expect(actions[0]).toContain('operator.customer.suspend');
  });

  it('rejects when scope identiti:operator is missing', async () => {
    const account = await createCustomer(app, '+254712400002');
    const url = `/v1/operator/customers/${account}/audit`;
    const r = await app.inject({
      method: 'GET',
      url,
      headers: signedAsApp({ method: 'GET', url }),
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('AUTH_SCOPE_INSUFFICIENT');
  });

  it('rejects malformed account UUID', async () => {
    const url = `/v1/operator/customers/not-a-uuid/audit`;
    const r = await app.inject({
      method: 'GET',
      url,
      headers: signedAsOperator({ method: 'GET', url }),
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('validation_account_uuid_invalid');
  });
});

describe('GET /v1/operator/kyc/pending', () => {
  let app: App;
  let deps: TestDepsBundle;

  beforeEach(async () => {
    deps = makeTestDeps();
    app = await buildApp(deps);
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns the pending records, newest first', async () => {
    const a1 = await createCustomer(app, '+254712401001');
    const a2 = await createCustomer(app, '+254712401002');
    const id1 = await seedPendingKyc(deps, a1);
    const id2 = await seedPendingKyc(deps, a2, 'tier_2');

    const url = `/v1/operator/kyc/pending`;
    const r = await app.inject({
      method: 'GET',
      url,
      headers: signedAsOperator({ method: 'GET', url }),
    });
    expect(r.statusCode).toBe(200);
    const items = r.json().data.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    const ids = items.map((i) => i.artefact_id);
    expect(ids).toContain(id1);
    expect(ids).toContain(id2);
  });

  it('rejects when scope identiti:operator is missing', async () => {
    const url = `/v1/operator/kyc/pending`;
    const r = await app.inject({
      method: 'GET',
      url,
      headers: signedAsApp({ method: 'GET', url }),
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('AUTH_SCOPE_INSUFFICIENT');
  });
});

describe('POST /v1/operator/kyc/:id/approve', () => {
  let app: App;
  let deps: TestDepsBundle;

  beforeEach(async () => {
    deps = makeTestDeps();
    app = await buildApp(deps);
  });

  afterEach(async () => {
    await app.close();
  });

  it('approves a pending record, promotes tier_0 → tier_1, publishes KYC_APPROVED + TIER_CHANGED', async () => {
    const account = await createCustomer(app, '+254712402001');
    const id = await seedPendingKyc(deps, account, 'tier_1');
    const eventCountBefore = deps.eventProducer.events.length;

    const url = `/v1/operator/kyc/${id}/approve`;
    const body = JSON.stringify({ narrative: 'Manual review passed' });
    const r = await app.inject({
      method: 'POST',
      url,
      headers: signedAsOperator({
        method: 'POST',
        url,
        body,
        idempotencyKey: 'idem-kyc-approve-1',
      }),
      payload: body,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().data.state).toBe('verified');
    expect(r.json().data.tier_promoted_to).toBe('tier_1');

    const tier = await deps.customersRepo.getTier(account);
    expect(tier?.tier).toBe('tier_1');

    const newEvents = deps.eventProducer.events.slice(eventCountBefore);
    const types = newEvents.map((e) => e.type);
    expect(types).toContain('KYC_APPROVED');
    expect(types).toContain('TIER_CHANGED');
  });

  it('approving a tier_2 record on a tier_0 account does NOT promote (tier_1 prerequisite)', async () => {
    const account = await createCustomer(app, '+254712402002');
    const id = await seedPendingKyc(deps, account, 'tier_2');
    const url = `/v1/operator/kyc/${id}/approve`;
    const body = JSON.stringify({});
    const r = await app.inject({
      method: 'POST',
      url,
      headers: signedAsOperator({
        method: 'POST',
        url,
        body,
        idempotencyKey: 'idem-kyc-approve-2',
      }),
      payload: body,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().data.tier_promoted_to).toBeUndefined();
    // Account is still tier_0.
    const tier = await deps.customersRepo.getTier(account);
    expect(tier?.tier).toBe('tier_0');
  });

  it('rejects approving an already-verified record', async () => {
    const account = await createCustomer(app, '+254712402003');
    const id = await seedPendingKyc(deps, account);
    const url = `/v1/operator/kyc/${id}/approve`;
    await app.inject({
      method: 'POST',
      url,
      headers: signedAsOperator({
        method: 'POST',
        url,
        body: '{}',
        idempotencyKey: 'idem-kyc-approve-3a',
      }),
      payload: '{}',
    });
    const r2 = await app.inject({
      method: 'POST',
      url,
      headers: signedAsOperator({
        method: 'POST',
        url,
        body: '{}',
        idempotencyKey: 'idem-kyc-approve-3b',
      }),
      payload: '{}',
    });
    expect(r2.statusCode).toBe(409);
    expect(r2.json().error.code).toBe('state_invalid_for_action');
  });

  it('returns 404 for an unknown artefact', async () => {
    const url = `/v1/operator/kyc/ver_00000000000000000000000000/approve`;
    const r = await app.inject({
      method: 'POST',
      url,
      headers: signedAsOperator({
        method: 'POST',
        url,
        body: '{}',
        idempotencyKey: 'idem-kyc-approve-404',
      }),
      payload: '{}',
    });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe('kyc_artefact_not_found');
  });

  it('rejects when scope identiti:operator is missing', async () => {
    const account = await createCustomer(app, '+254712402004');
    const id = await seedPendingKyc(deps, account);
    const url = `/v1/operator/kyc/${id}/approve`;
    const r = await app.inject({
      method: 'POST',
      url,
      headers: signedAsApp({
        method: 'POST',
        url,
        body: '{}',
        idempotencyKey: 'idem-kyc-approve-noscope',
      }),
      payload: '{}',
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('AUTH_SCOPE_INSUFFICIENT');
  });
});

describe('POST /v1/operator/kyc/:id/reject', () => {
  let app: App;
  let deps: TestDepsBundle;

  beforeEach(async () => {
    deps = makeTestDeps();
    app = await buildApp(deps);
  });

  afterEach(async () => {
    await app.close();
  });

  it('rejects a pending record, publishes KYC_REJECTED, no tier change', async () => {
    const account = await createCustomer(app, '+254712403001');
    const id = await seedPendingKyc(deps, account);
    const eventCountBefore = deps.eventProducer.events.length;

    const url = `/v1/operator/kyc/${id}/reject`;
    const body = JSON.stringify({ reason: 'Document quality insufficient' });
    const r = await app.inject({
      method: 'POST',
      url,
      headers: signedAsOperator({
        method: 'POST',
        url,
        body,
        idempotencyKey: 'idem-kyc-reject-1',
      }),
      payload: body,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().data.state).toBe('failed');
    expect(r.json().data.failure_reason).toBe('Document quality insufficient');

    const newEvents = deps.eventProducer.events.slice(eventCountBefore);
    const kycRejected = newEvents.find((e) => e.type === 'KYC_REJECTED');
    expect(kycRejected).toBeDefined();
    expect(kycRejected!.topic).toBe('identiti.kyc.events');
    expect(kycRejected!.data).toMatchObject({
      account_uuid: account,
      artefact_id: id,
      reason: 'Document quality insufficient',
    });

    // Account tier unchanged.
    const tier = await deps.customersRepo.getTier(account);
    expect(tier?.tier).toBe('tier_0');
  });

  it('rejects with 400 if reason is missing', async () => {
    const account = await createCustomer(app, '+254712403002');
    const id = await seedPendingKyc(deps, account);
    const url = `/v1/operator/kyc/${id}/reject`;
    const body = JSON.stringify({});
    const r = await app.inject({
      method: 'POST',
      url,
      headers: signedAsOperator({
        method: 'POST',
        url,
        body,
        idempotencyKey: 'idem-kyc-reject-no-reason',
      }),
      payload: body,
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('validation_request_invalid');
  });

  it('rejects re-rejection of an already-failed record', async () => {
    const account = await createCustomer(app, '+254712403003');
    const id = await seedPendingKyc(deps, account);
    const url = `/v1/operator/kyc/${id}/reject`;
    const body = JSON.stringify({ reason: 'first reject' });
    await app.inject({
      method: 'POST',
      url,
      headers: signedAsOperator({
        method: 'POST',
        url,
        body,
        idempotencyKey: 'idem-rej-1',
      }),
      payload: body,
    });
    const body2 = JSON.stringify({ reason: 'second reject' });
    const r = await app.inject({
      method: 'POST',
      url,
      headers: signedAsOperator({
        method: 'POST',
        url,
        body: body2,
        idempotencyKey: 'idem-rej-2',
      }),
      payload: body2,
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('state_invalid_for_action');
  });
});
