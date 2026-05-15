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
    // ID-10: two keys are published — the step-up key (customer + step-up
    // tokens) and the delegated-authority key (POST /v1/internal/sign). The
    // `kid` header on each token discriminates at verification time.
    expect(body.keys).toHaveLength(2);

    for (const key of body.keys) {
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
    }

    // The two kids are distinct, and the delegated-authority kid is present.
    const kids = body.keys.map((k) => k.kid as string);
    expect(new Set(kids).size).toBe(2);
    expect(kids).toContain('helpan-da-2026-q2-test');
  });

  it('sets a long cache-control header', async () => {
    const res = await app.inject({ method: 'GET', url: '/.well-known/jwks.json' });
    expect(res.headers['cache-control']).toMatch(/max-age=\d+/);
  });
});
