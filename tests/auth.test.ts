/**
 * Integration smoke tests for auth wiring on Identiti. Deep coverage of the
 * verification logic lives in @kmv/platform-shared's authPlugin tests; here we
 * verify Identiti's wiring (rail prefix, exempt paths, attached request fields).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCanonicalString, sha256Hex, signRequest } from '@kmv/platform-shared/hmac';
import { buildApp, type App } from '../src/app.js';
import { makeTestDeps, TEST_APP_ID, TEST_HMAC_SECRET } from './helpers.js';

function signedHeaders(opts: {
  method: string;
  url: string;
  body?: string;
  contentType?: string;
}): Record<string, string> {
  const body = opts.body ?? '';
  const contentType = opts.contentType ?? (body ? 'application/json; charset=utf-8' : '');
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
  return headers;
}

describe('auth wiring (Identiti)', () => {
  let app: App;

  beforeEach(async () => {
    app = await buildApp(makeTestDeps());
    app.get('/v1/_test/protected', async (req) => ({
      appId: req.appId,
      tenant: req.tenantRecord?.app_name,
    }));
  });

  afterEach(async () => {
    await app.close();
  });

  it('exempts /v1/health from auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/health' });
    expect(res.statusCode).toBe(200);
  });

  it('rejects unauthenticated request to a protected route', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/_test/protected' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('AUTH_HMAC_INVALID');
  });

  it('accepts a properly signed Identiti request and attaches tenant', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/_test/protected',
      headers: signedHeaders({ method: 'GET', url: '/v1/_test/protected' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ appId: TEST_APP_ID, tenant: 'Test app' });
  });

  it('rejects a request signed with the wrong rail prefix', async () => {
    const ts = new Date().toISOString();
    const canonical = buildCanonicalString({
      method: 'GET',
      pathAndQuery: '/v1/_test/protected',
      contentType: '',
      timestamp: ts,
      bodySha256Hex: sha256Hex(''),
    });
    const sig = signRequest(canonical, TEST_HMAC_SECRET);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/_test/protected',
      headers: {
        authorization: `KipkirenPay-HMAC-SHA256 app_id=${TEST_APP_ID}, signature=${sig}`,
        'x-identiti-timestamp': ts,
      },
    });
    expect(res.statusCode).toBe(401);
  });
});
