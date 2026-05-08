/**
 * GET /.well-known/jwks.json — public key set, no auth.
 * Per Schema Appendix §16 + Reboot Pack §16.8.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/app.js';
import { makeTestDeps } from './helpers.js';

describe('GET /.well-known/jwks.json', () => {
  let app: App;

  beforeEach(async () => {
    app = await buildApp(makeTestDeps());
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns the JWKS document without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/.well-known/jwks.json' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/jwk-set\+json/);
    const body = res.json() as { keys: Array<Record<string, unknown>> };
    expect(Array.isArray(body.keys)).toBe(true);
    expect(body.keys).toHaveLength(1);
    const key = body.keys[0]!;
    expect(key.kty).toBe('RSA');
    expect(key.use).toBe('sig');
    expect(key.alg).toBe('RS256');
    expect(typeof key.kid).toBe('string');
    expect(typeof key.n).toBe('string');
    expect(typeof key.e).toBe('string');
    // No private key material must leak.
    expect(key).not.toHaveProperty('d');
    expect(key).not.toHaveProperty('p');
    expect(key).not.toHaveProperty('q');
  });

  it('sets a long cache-control header', async () => {
    const res = await app.inject({ method: 'GET', url: '/.well-known/jwks.json' });
    expect(res.headers['cache-control']).toMatch(/max-age=\d+/);
  });
});
