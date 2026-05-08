import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/app.js';
import { makeTestDeps } from './helpers.js';

describe('GET /v1/health', () => {
  let app: App;

  beforeEach(async () => {
    app = await buildApp(makeTestDeps());
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns the standard envelope without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toMatchObject({
      status: 'ok',
      rail: 'identiti',
      version: '0.1.0-test',
      environment: 'test',
    });
    expect(body.meta.request_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(body.meta.schema_version).toBe('1.0');
    expect(body.meta.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('echoes a client-supplied X-Request-Id', async () => {
    const supplied = '01HKABCDEFGHJKMNPQRSTVWXYZ';
    const res = await app.inject({
      method: 'GET',
      url: '/v1/health',
      headers: { 'x-request-id': supplied },
    });
    expect(res.headers['x-request-id']).toBe(supplied);
    expect(res.json().meta.request_id).toBe(supplied);
  });

  it('emits a Traceparent header', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/health' });
    expect(res.headers['traceparent']).toMatch(
      /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/
    );
  });

  it('preserves a valid incoming Traceparent', async () => {
    const tp = `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`;
    const res = await app.inject({
      method: 'GET',
      url: '/v1/health',
      headers: { traceparent: tp },
    });
    expect(res.headers['traceparent']).toBe(tp);
  });
});

describe('not-found behaviour', () => {
  let app: App;

  beforeEach(async () => {
    app = await buildApp(makeTestDeps());
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 401 (not 404) on unknown protected path — auth runs before routing', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/does-not-exist' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('AUTH_HMAC_INVALID');
  });
});
