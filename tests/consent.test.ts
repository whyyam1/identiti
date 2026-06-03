/**
 * ID-14 — Hakken consent surface (newdocs pack ID-14).
 *
 * Covers: POST grant happy + duplicate-open 409 + customer-not-found 404 +
 * scope rejection 403, GET (open-only default + ?include=revoked +
 * Cache-Control) + scope rejection 403, POST revoke happy + already-revoked
 * 409 + not-found 404 + scope rejection 403, malformed body / id / uuid.
 * Confirms Kafka CONSENT_GRANTED + CONSENT_REVOKED on identiti.consent.events.
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
    headers: signed({
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

function grantBody(input: { account_uuid: string; app_id?: string; scope?: string }) {
  return JSON.stringify({
    account_uuid: input.account_uuid,
    app_id: input.app_id ?? 'hakken',
    scope: input.scope ?? 'profile:read',
  });
}

function postGrant(app: App, body: string) {
  return app.inject({
    method: 'POST',
    url: '/v1/consent/grants',
    headers: signed({
      method: 'POST',
      url: '/v1/consent/grants',
      body,
      idempotencyKey: `idem_${Math.random().toString(36).slice(2)}`,
    }),
    payload: body,
  });
}

function getConsent(app: App, accountUuid: string, query = '') {
  const url = `/v1/consent/${accountUuid}${query}`;
  return app.inject({ method: 'GET', url, headers: signed({ method: 'GET', url }) });
}

function postRevoke(app: App, grantId: string, reason: string) {
  const url = `/v1/consent/grants/${grantId}/revoke`;
  const body = JSON.stringify({ reason });
  return app.inject({
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
}

describe('POST /v1/consent/grants', () => {
  let app: App;
  let deps: TestDepsBundle;

  beforeEach(async () => {
    deps = makeTestDeps();
    app = await buildApp(deps);
  });

  afterEach(async () => {
    await app.close();
  });

  it('records a grant and publishes CONSENT_GRANTED on identiti.consent.events', async () => {
    const uuid = await createCustomer(app, '+254712600001');
    const before = deps.eventProducer.events.length;
    const r = await postGrant(app, grantBody({ account_uuid: uuid }));
    expect(r.statusCode).toBe(201);
    const env = r.json();
    expect(env.data.grant_id).toMatch(/^cgr_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(env.data.account_uuid).toBe(uuid);
    expect(env.data.app_id).toBe('hakken');
    expect(env.data.scope).toBe('profile:read');
    expect(env.data.granted_via_app_id).toBe(TEST_APP_ID);
    expect(env.data.revoked_at).toBeUndefined();

    const granted = deps.eventProducer.events
      .slice(before)
      .find((e) => e.type === 'CONSENT_GRANTED');
    expect(granted).toBeDefined();
    expect(granted!.topic).toBe('identiti.consent.events');
    expect(granted!.data.scope).toBe('profile:read');
    expect(deps.auditLogger.entries.some((e) => e.action === 'consent.granted')).toBe(true);
  });

  it('returns 409 consent_grant_already_open on a duplicate open grant', async () => {
    const uuid = await createCustomer(app, '+254712600010');
    const first = await postGrant(app, grantBody({ account_uuid: uuid }));
    expect(first.statusCode).toBe(201);
    const r = await postGrant(app, grantBody({ account_uuid: uuid }));
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('consent_grant_already_open');
    expect(r.json().error.detail.existing_grant_id).toBe(first.json().data.grant_id);
  });

  it('allows distinct scopes for the same (account, app) to coexist', async () => {
    const uuid = await createCustomer(app, '+254712600020');
    const r1 = await postGrant(app, grantBody({ account_uuid: uuid, scope: 'profile:read' }));
    const r2 = await postGrant(app, grantBody({ account_uuid: uuid, scope: 'phone:read' }));
    expect(r1.statusCode).toBe(201);
    expect(r2.statusCode).toBe(201);
    const open = await deps.consentGrantsRepo.listOpenByAccount(uuid);
    expect(open).toHaveLength(2);
  });

  it('returns 404 customer_not_found for an unknown account_uuid', async () => {
    const r = await postGrant(
      app,
      grantBody({ account_uuid: 'acc_00000000-0000-4000-8000-000000000000' }),
    );
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe('customer_not_found');
  });

  it('rejects a malformed scope with 400', async () => {
    const uuid = await createCustomer(app, '+254712600030');
    const r = await postGrant(app, grantBody({ account_uuid: uuid, scope: 'NOT a scope!' }));
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('validation_request_invalid');
  });

  it('rejects callers without identiti:consent:write with 403', async () => {
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
              scopes: r.record.scopes.filter((s) => s !== 'identiti:consent:write'),
            },
          };
        },
      },
    });
    app = await buildApp(deps);
    const r = await postGrant(
      app,
      grantBody({ account_uuid: 'acc_00000000-0000-4000-8000-000000000000' }),
    );
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('AUTH_SCOPE_INSUFFICIENT');
  });
});

describe('GET /v1/consent/:account_uuid', () => {
  let app: App;
  let deps: TestDepsBundle;

  beforeEach(async () => {
    deps = makeTestDeps();
    app = await buildApp(deps);
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns open grants only by default and sets private 60s Cache-Control', async () => {
    const uuid = await createCustomer(app, '+254712601001');
    await postGrant(app, grantBody({ account_uuid: uuid, scope: 'profile:read' }));
    const second = await postGrant(app, grantBody({ account_uuid: uuid, scope: 'phone:read' }));
    await postRevoke(app, second.json().data.grant_id, 'user-asked');

    const r = await getConsent(app, uuid);
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('private, max-age=60');
    const env = r.json();
    expect(env.data.account_uuid).toBe(uuid);
    // Only the still-open one (profile:read) — phone:read was revoked.
    expect(env.data.grants).toHaveLength(1);
    expect(env.data.grants[0].scope).toBe('profile:read');
  });

  it('returns full history with ?include=revoked', async () => {
    const uuid = await createCustomer(app, '+254712601010');
    await postGrant(app, grantBody({ account_uuid: uuid, scope: 'profile:read' }));
    const second = await postGrant(app, grantBody({ account_uuid: uuid, scope: 'phone:read' }));
    await postRevoke(app, second.json().data.grant_id, 'user-asked');

    const r = await getConsent(app, uuid, '?include=revoked');
    expect(r.statusCode).toBe(200);
    const grants = r.json().data.grants;
    expect(grants).toHaveLength(2);
    const phoneRow = grants.find((g: { scope: string }) => g.scope === 'phone:read');
    expect(phoneRow.revoked_at).toBeDefined();
    expect(phoneRow.revoke_reason).toBe('user-asked');
  });

  it('returns 404 for an unknown account_uuid', async () => {
    const r = await getConsent(app, 'acc_00000000-0000-4000-8000-000000000000');
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe('customer_not_found');
  });

  it('rejects malformed account_uuid with 400', async () => {
    const r = await getConsent(app, 'not-a-uuid');
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('validation_account_uuid_invalid');
  });

  it('rejects callers without identiti:consent:read with 403', async () => {
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
              scopes: r.record.scopes.filter((s) => s !== 'identiti:consent:read'),
            },
          };
        },
      },
    });
    app = await buildApp(deps);
    const r = await getConsent(app, 'acc_00000000-0000-4000-8000-000000000000');
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('AUTH_SCOPE_INSUFFICIENT');
  });
});

describe('POST /v1/consent/grants/:grant_id/revoke', () => {
  let app: App;
  let deps: TestDepsBundle;

  beforeEach(async () => {
    deps = makeTestDeps();
    app = await buildApp(deps);
  });

  afterEach(async () => {
    await app.close();
  });

  it('revokes an open grant and publishes CONSENT_REVOKED', async () => {
    const uuid = await createCustomer(app, '+254712602001');
    const create = await postGrant(app, grantBody({ account_uuid: uuid }));
    const grantId = create.json().data.grant_id as string;
    const before = deps.eventProducer.events.length;

    const r = await postRevoke(app, grantId, 'user request via /settings');
    expect(r.statusCode).toBe(200);
    expect(r.json().data.revoked_at).toBeDefined();
    expect(r.json().data.revoke_reason).toBe('user request via /settings');

    const revoked = deps.eventProducer.events
      .slice(before)
      .find((e) => e.type === 'CONSENT_REVOKED');
    expect(revoked).toBeDefined();
    expect(revoked!.data.grant_id).toBe(grantId);

    // Re-granting the same scope is now allowed.
    const reGrant = await postGrant(app, grantBody({ account_uuid: uuid }));
    expect(reGrant.statusCode).toBe(201);
  });

  it('returns 409 already_revoked on a second revoke', async () => {
    const uuid = await createCustomer(app, '+254712602010');
    const grantId = (await postGrant(app, grantBody({ account_uuid: uuid }))).json().data.grant_id;
    await postRevoke(app, grantId, 'first');
    const r = await postRevoke(app, grantId, 'second');
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('consent_grant_already_revoked');
  });

  it('returns 404 for an unknown grant_id', async () => {
    const r = await postRevoke(app, 'cgr_00000000000000000000000000', 'x');
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe('consent_grant_not_found');
  });

  it('rejects a malformed grant_id with 400', async () => {
    const r = await postRevoke(app, 'not-a-grant-id', 'x');
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('validation_request_invalid');
  });

  it('rejects a malformed body (missing reason) with 400', async () => {
    const uuid = await createCustomer(app, '+254712602020');
    const grantId = (await postGrant(app, grantBody({ account_uuid: uuid }))).json().data.grant_id;
    const url = `/v1/consent/grants/${grantId}/revoke`;
    const body = JSON.stringify({});
    const r = await app.inject({
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
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('validation_request_invalid');
  });
});
