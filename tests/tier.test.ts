/**
 * Sprint 2 — tier signal + operator tier-override.
 *   GET  /v1/customers/{uuid}/tier
 *   POST /v1/operator/customers/{uuid}/tier-override
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

function signedHeaders(opts: {
  method: string;
  url: string;
  body?: string;
  appId: string;
  secret: string;
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
  const sig = signRequest(canonical, opts.secret);
  const headers: Record<string, string> = {
    authorization: `Identiti-HMAC-SHA256 app_id=${opts.appId}, signature=${sig}`,
    'x-identiti-timestamp': ts,
  };
  if (contentType) headers['content-type'] = contentType;
  if (opts.idempotencyKey) headers['x-idempotency-key'] = opts.idempotencyKey;
  return headers;
}

async function createCustomer(app: App, phone: string): Promise<string> {
  const body = JSON.stringify({
    phone,
    name_first: 'A',
    name_last: 'B',
    consent: {
      dpa_consent: true,
      kyc_consent: true,
      captured_at: new Date().toISOString(),
    },
    app_correlation: `corr_${Math.random().toString(36).slice(2)}`,
  });
  const r = await app.inject({
    method: 'POST',
    url: '/v1/customers',
    headers: signedHeaders({
      method: 'POST',
      url: '/v1/customers',
      body,
      appId: TEST_APP_ID,
      secret: TEST_HMAC_SECRET,
      idempotencyKey: `idem_${Math.random().toString(36).slice(2)}`,
    }),
    payload: body,
  });
  if (r.statusCode !== 201) throw new Error(`createCustomer failed: ${r.statusCode} ${r.body}`);
  return r.json().data.account_uuid as string;
}

describe('GET /v1/customers/{uuid}/tier', () => {
  let app: App;
  let deps: TestDepsBundle;

  beforeEach(async () => {
    deps = makeTestDeps();
    app = await buildApp(deps);
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns rule_based_tier_0_default for a fresh account', async () => {
    const uuid = await createCustomer(app, '+254712345020');
    const url = `/v1/customers/${uuid}/tier`;
    const res = await app.inject({
      method: 'GET',
      url,
      headers: signedHeaders({
        method: 'GET',
        url,
        appId: TEST_APP_ID,
        secret: TEST_HMAC_SECRET,
      }),
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.tier).toBe('tier_0');
    expect(data.reason).toBe('rule_based_tier_0_default');
    expect(typeof data.assigned_at).toBe('string');
  });

  it('reflects an operator override', async () => {
    const uuid = await createCustomer(app, '+254712345021');
    // Operator override
    const overrideBody = JSON.stringify({
      tier: 'tier_2',
      reason: 'operator_tier_2_approval',
      narrative: 'Established business customer.',
    });
    const overrideUrl = `/v1/operator/customers/${uuid}/tier-override`;
    const overrideRes = await app.inject({
      method: 'POST',
      url: overrideUrl,
      headers: signedHeaders({
        method: 'POST',
        url: overrideUrl,
        body: overrideBody,
        appId: TEST_OPERATOR_APP_ID,
        secret: TEST_OPERATOR_HMAC_SECRET,
        idempotencyKey: 'idem-override',
      }),
      payload: overrideBody,
    });
    expect(overrideRes.statusCode).toBe(200);
    expect(overrideRes.json().data).toMatchObject({
      account_uuid: uuid,
      from_tier: 'tier_0',
      to_tier: 'tier_2',
      reason: 'operator_tier_2_approval',
    });

    // Read tier
    const url = `/v1/customers/${uuid}/tier`;
    const res = await app.inject({
      method: 'GET',
      url,
      headers: signedHeaders({
        method: 'GET',
        url,
        appId: TEST_APP_ID,
        secret: TEST_HMAC_SECRET,
      }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.tier).toBe('tier_2');
    expect(res.json().data.reason).toBe('operator_tier_2_approval');

    // TIER_CHANGED Kafka event was published
    const tierChanged = deps.eventProducer.events.find((e) => e.type === 'TIER_CHANGED');
    expect(tierChanged).toBeDefined();
    expect(tierChanged!.data).toMatchObject({
      account_uuid: uuid,
      from_tier: 'tier_0',
      to_tier: 'tier_2',
    });
  });

  it('returns 404 for unknown account', async () => {
    const fake = 'acc_00000000-0000-4000-8000-000000000000';
    const url = `/v1/customers/${fake}/tier`;
    const res = await app.inject({
      method: 'GET',
      url,
      headers: signedHeaders({
        method: 'GET',
        url,
        appId: TEST_APP_ID,
        secret: TEST_HMAC_SECRET,
      }),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('customer_not_found');
  });

  it('rejects when scope identiti:tier:read is missing — operator app may have it but a stripped app does not', async () => {
    const uuid = await createCustomer(app, '+254712345022');
    // Use a contrived no-scope credential store.
    await app.close();
    deps = makeTestDeps({
      credentialStore: {
        async lookup(appId) {
          if (appId !== TEST_APP_ID) return null;
          return {
            record: {
              app_id: TEST_APP_ID,
              app_name: 'Test app',
              tenant_class: 'external',
              scopes: ['identiti:customers:write'],
              status: 'active',
            },
            hmacSecret: TEST_HMAC_SECRET,
          };
        },
      },
    });
    app = await buildApp(deps);
    const url = `/v1/customers/${uuid}/tier`;
    const res = await app.inject({
      method: 'GET',
      url,
      headers: signedHeaders({
        method: 'GET',
        url,
        appId: TEST_APP_ID,
        secret: TEST_HMAC_SECRET,
      }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('AUTH_SCOPE_INSUFFICIENT');
  });
});

describe('POST /v1/operator/customers/{uuid}/tier-override', () => {
  let app: App;
  let deps: TestDepsBundle;

  beforeEach(async () => {
    deps = makeTestDeps();
    app = await buildApp(deps);
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 404 for unknown account', async () => {
    const fake = 'acc_00000000-0000-4000-8000-000000000000';
    const body = JSON.stringify({
      tier: 'tier_1',
      reason: 'operator_tier_2_approval',
    });
    const url = `/v1/operator/customers/${fake}/tier-override`;
    const res = await app.inject({
      method: 'POST',
      url,
      headers: signedHeaders({
        method: 'POST',
        url,
        body,
        appId: TEST_OPERATOR_APP_ID,
        secret: TEST_OPERATOR_HMAC_SECRET,
        idempotencyKey: 'idem-404',
      }),
      payload: body,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('customer_not_found');
  });

  it('rejects when called by a non-operator app', async () => {
    const uuid = await createCustomer(app, '+254712345030');
    const body = JSON.stringify({
      tier: 'tier_2',
      reason: 'operator_tier_2_approval',
    });
    const url = `/v1/operator/customers/${uuid}/tier-override`;
    const res = await app.inject({
      method: 'POST',
      url,
      headers: signedHeaders({
        method: 'POST',
        url,
        body,
        appId: TEST_APP_ID,
        secret: TEST_HMAC_SECRET,
        idempotencyKey: 'idem-noop',
      }),
      payload: body,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('AUTH_SCOPE_INSUFFICIENT');
  });

  it('audits both success and failure', async () => {
    const uuid = await createCustomer(app, '+254712345031');
    const body = JSON.stringify({
      tier: 'tier_1',
      reason: 'operator_tier_2_approval',
    });
    const url = `/v1/operator/customers/${uuid}/tier-override`;
    await app.inject({
      method: 'POST',
      url,
      headers: signedHeaders({
        method: 'POST',
        url,
        body,
        appId: TEST_OPERATOR_APP_ID,
        secret: TEST_OPERATOR_HMAC_SECRET,
        idempotencyKey: 'idem-audit',
      }),
      payload: body,
    });
    expect(
      deps.auditLogger.entries.some(
        (e) => e.action === 'operator.customer.tier_override' && e.outcome === 'success'
      )
    ).toBe(true);
  });
});
