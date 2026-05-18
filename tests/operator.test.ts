/**
 * Sprint 1 — operator suspend / reactivate.
 * Operator scope: `identiti:operator`. Sandbox model only — Stage 2 swaps to
 * FIDO2/WebAuthn (Reboot Pack §10).
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

async function createCustomer(app: App): Promise<string> {
  const body = JSON.stringify({
    phone: `+25471${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`,
    name_first: 'A',
    name_last: 'B',
    consent: {
      dpa_consent: true,
      kyc_consent: true,
      captured_at: new Date().toISOString(),
    },
    app_correlation: `corr_${Math.random().toString(36).slice(2)}`,
  });
  const res = await app.inject({
    method: 'POST',
    url: '/v1/customers',
    headers: signedHeaders({
      method: 'POST',
      url: '/v1/customers',
      body,
      appId: TEST_APP_ID,
      secret: TEST_HMAC_SECRET,
      idempotencyKey: `idem-${Math.random().toString(36).slice(2)}`,
    }),
    payload: body,
  });
  if (res.statusCode !== 201) {
    throw new Error(`createCustomer failed: ${res.statusCode} ${res.body}`);
  }
  return res.json().data.account_uuid as string;
}

async function activate(deps: TestDepsBundle, accountUuid: string): Promise<void> {
  // Repo is in-memory in tests — flip status directly to set up the suspend test.
  const r = await deps.customersRepo.changeState(accountUuid, ['pending_onboarding'], 'active');
  if (!r) throw new Error('failed to activate test account');
}

describe('POST /v1/operator/customers/{uuid}/suspend', () => {
  let app: App;
  let deps: TestDepsBundle;

  beforeEach(async () => {
    deps = makeTestDeps();
    app = await buildApp(deps);
  });

  afterEach(async () => {
    await app.close();
  });

  it('transitions active → frozen_aml, publishes ACCOUNT_SUSPENDED, audits', async () => {
    const uuid = await createCustomer(app);
    await activate(deps, uuid);

    const eventCountBefore = deps.eventProducer.events.length;
    const auditCountBefore = deps.auditLogger.entries.length;

    const body = JSON.stringify({ reason: 'AML hit on screening refresh' });
    const url = `/v1/operator/customers/${uuid}/suspend`;
    const res = await app.inject({
      method: 'POST',
      url,
      headers: signedHeaders({
        method: 'POST',
        url,
        body,
        appId: TEST_OPERATOR_APP_ID,
        secret: TEST_OPERATOR_HMAC_SECRET,
        idempotencyKey: 'idem-suspend',
      }),
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({
      account_uuid: uuid,
      from_state: 'active',
      to_state: 'frozen_aml',
    });

    const newEvents = deps.eventProducer.events.slice(eventCountBefore);
    expect(newEvents).toHaveLength(1);
    expect(newEvents[0]!.type).toBe('ACCOUNT_SUSPENDED');
    expect(newEvents[0]!.data).toMatchObject({
      account_uuid: uuid,
      from_state: 'active',
      to_state: 'frozen_aml',
    });

    const newAudit = deps.auditLogger.entries.slice(auditCountBefore);
    expect(
      newAudit.some((e) => e.action === 'operator.customer.suspend' && e.outcome === 'success'),
    ).toBe(true);
  });

  it('rejects when scope identiti:operator is missing (regular app)', async () => {
    const uuid = await createCustomer(app);
    await activate(deps, uuid);

    const body = JSON.stringify({ reason: 'unauthorised attempt' });
    const url = `/v1/operator/customers/${uuid}/suspend`;
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

  it('returns 404 for an unknown account', async () => {
    const fake = 'acc_00000000-0000-4000-8000-000000000000';
    const body = JSON.stringify({ reason: 'test' });
    const url = `/v1/operator/customers/${fake}/suspend`;
    const res = await app.inject({
      method: 'POST',
      url,
      headers: signedHeaders({
        method: 'POST',
        url,
        body,
        appId: TEST_OPERATOR_APP_ID,
        secret: TEST_OPERATOR_HMAC_SECRET,
        idempotencyKey: 'idem-unknown',
      }),
      payload: body,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('customer_not_found');
  });

  it('returns 409 when suspending an account already in frozen_aml', async () => {
    const uuid = await createCustomer(app);
    await activate(deps, uuid);
    // Suspend once
    const url = `/v1/operator/customers/${uuid}/suspend`;
    const body = JSON.stringify({ reason: 'first' });
    await app.inject({
      method: 'POST',
      url,
      headers: signedHeaders({
        method: 'POST',
        url,
        body,
        appId: TEST_OPERATOR_APP_ID,
        secret: TEST_OPERATOR_HMAC_SECRET,
        idempotencyKey: 'idem-1',
      }),
      payload: body,
    });

    // Try again
    const body2 = JSON.stringify({ reason: 'second' });
    const r2 = await app.inject({
      method: 'POST',
      url,
      headers: signedHeaders({
        method: 'POST',
        url,
        body: body2,
        appId: TEST_OPERATOR_APP_ID,
        secret: TEST_OPERATOR_HMAC_SECRET,
        idempotencyKey: 'idem-2',
      }),
      payload: body2,
    });
    expect(r2.statusCode).toBe(409);
    expect(r2.json().error.code).toBe('state_invalid_for_action');
  });
});

describe('POST /v1/operator/customers/{uuid}/reactivate', () => {
  let app: App;
  let deps: TestDepsBundle;

  beforeEach(async () => {
    deps = makeTestDeps();
    app = await buildApp(deps);
  });

  afterEach(async () => {
    await app.close();
  });

  it('transitions frozen_aml → active and publishes ACCOUNT_REACTIVATED', async () => {
    const uuid = await createCustomer(app);
    await activate(deps, uuid);
    // Move to frozen_aml first
    const r = await deps.customersRepo.changeState(uuid, ['active'], 'frozen_aml');
    expect(r).not.toBeNull();

    const body = JSON.stringify({ reason: 'AML cleared' });
    const url = `/v1/operator/customers/${uuid}/reactivate`;
    const res = await app.inject({
      method: 'POST',
      url,
      headers: signedHeaders({
        method: 'POST',
        url,
        body,
        appId: TEST_OPERATOR_APP_ID,
        secret: TEST_OPERATOR_HMAC_SECRET,
        idempotencyKey: 'idem-react',
      }),
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({
      account_uuid: uuid,
      from_state: 'frozen_aml',
      to_state: 'active',
    });
    const last = deps.eventProducer.events[deps.eventProducer.events.length - 1]!;
    expect(last.type).toBe('ACCOUNT_REACTIVATED');
  });

  it('returns 409 when reactivating an account that is already active', async () => {
    const uuid = await createCustomer(app);
    await activate(deps, uuid);

    const body = JSON.stringify({ reason: 'noop' });
    const url = `/v1/operator/customers/${uuid}/reactivate`;
    const res = await app.inject({
      method: 'POST',
      url,
      headers: signedHeaders({
        method: 'POST',
        url,
        body,
        appId: TEST_OPERATOR_APP_ID,
        secret: TEST_OPERATOR_HMAC_SECRET,
        idempotencyKey: 'idem-noop-react',
      }),
      payload: body,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('state_invalid_for_action');
  });
});
