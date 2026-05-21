/**
 * Demo landing page — `GET /` and `GET /demo` serve the static HTML and
 * bypass HMAC auth. Used as the investor-facing surface on the Railway
 * sandbox URL.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/app.js';
import { makeTestDeps } from './helpers.js';

describe('Demo landing page', () => {
  let app: App;

  beforeEach(async () => {
    app = await buildApp(makeTestDeps());
  });

  afterEach(async () => {
    await app.close();
  });

  it('serves the demo HTML at GET / without authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    // The page is honest about what it shows — a few canonical strings
    // anchor the test to actual content, not just any 200.
    expect(res.body).toContain('Identiti');
    expect(res.body).toContain('Live system snapshot');
    expect(res.body).toContain('/v1/health');
  });

  it('serves the same page at GET /demo', async () => {
    const res = await app.inject({ method: 'GET', url: '/demo' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  it('sets a sensible cache-control on the demo page', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.headers['cache-control']).toMatch(/max-age=\d+/);
  });
});
