/**
 * Integration smoke tests for idempotency wiring. Deep coverage of the
 * plugin's behaviour is in @kmv/platform-shared. Here we verify that within
 * Identiti the plugin runs after auth and persists/replays correctly.
 *
 * Phase 1 has no POST endpoints yet, so the test registers a temporary
 * /v1/_test/echo route to exercise the plugin.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCanonicalString, sha256Hex, signRequest } from '@kmv/platform-shared/hmac';
import { buildApp, type App } from '../src/app.js';
import { makeTestDeps, TEST_APP_ID, TEST_HMAC_SECRET } from './helpers.js';

function signed(body: string, url: string, method = 'POST'): Record<string, string> {
  const ts = new Date().toISOString();
  const contentType = 'application/json; charset=utf-8';
  const canonical = buildCanonicalString({
    method,
    pathAndQuery: url,
    contentType,
    timestamp: ts,
    bodySha256Hex: sha256Hex(body),
  });
  const sig = signRequest(canonical, TEST_HMAC_SECRET);
  return {
    authorization: `Identiti-HMAC-SHA256 app_id=${TEST_APP_ID}, signature=${sig}`,
    'x-identiti-timestamp': ts,
    'content-type': contentType,
  };
}

describe('idempotency wiring (Identiti)', () => {
  let app: App;
  let counter: number;

  beforeEach(async () => {
    counter = 0;
    app = await buildApp(makeTestDeps());
    app.post('/v1/_test/echo', async (req) => {
      counter += 1;
      return { count: counter, body: req.body };
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it('rejects POST without X-Idempotency-Key', async () => {
    const body = JSON.stringify({ a: 1 });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/_test/echo',
      headers: signed(body, '/v1/_test/echo'),
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('REQ_IDEMPOTENCY_KEY_MISSING');
  });

  it('replays on identical retry', async () => {
    const body = JSON.stringify({ a: 1 });
    const headers1 = { ...signed(body, '/v1/_test/echo'), 'x-idempotency-key': 'idem-1' };
    const r1 = await app.inject({
      method: 'POST',
      url: '/v1/_test/echo',
      headers: headers1,
      payload: body,
    });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().count).toBe(1);

    const headers2 = { ...signed(body, '/v1/_test/echo'), 'x-idempotency-key': 'idem-1' };
    const r2 = await app.inject({
      method: 'POST',
      url: '/v1/_test/echo',
      headers: headers2,
      payload: body,
    });
    expect(r2.statusCode).toBe(200);
    expect(r2.json().count).toBe(1);
    expect(r2.headers['x-idempotency-replayed']).toBe('true');
  });

  it('returns 409 on key reuse with different body', async () => {
    const bodyA = JSON.stringify({ a: 1 });
    const headersA = { ...signed(bodyA, '/v1/_test/echo'), 'x-idempotency-key': 'idem-2' };
    await app.inject({
      method: 'POST',
      url: '/v1/_test/echo',
      headers: headersA,
      payload: bodyA,
    });

    const bodyB = JSON.stringify({ a: 2 });
    const headersB = { ...signed(bodyB, '/v1/_test/echo'), 'x-idempotency-key': 'idem-2' };
    const conflict = await app.inject({
      method: 'POST',
      url: '/v1/_test/echo',
      headers: headersB,
      payload: bodyB,
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('REQ_IDEMPOTENCY_KEY_CONFLICT');
  });
});
