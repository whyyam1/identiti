/**
 * Demo landing page — `GET /` and `GET /demo`.
 *
 * Serves `demo/index.html` from the repo root: a single-file, mobile-first
 * page that fetches `/v1/health` and the JWKS on load and tells the rail's
 * story for non-technical readers. Auth-exempt (paths are listed in
 * `app.ts` EXEMPT_PATHS).
 *
 * The HTML is read once at startup and held in memory. If the file is
 * missing at startup (e.g. a dist-only build without the demo dir), the
 * routes are silently skipped so the rest of the API is unaffected.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from '../lib/logger.js';

export interface DemoRouteDeps {
  logger: Logger;
}

export function demoRoutes(deps: DemoRouteDeps): FastifyPluginAsync {
  let html: string | null = null;
  try {
    // cwd is the repo root in dev (`pnpm dev`) and on Railway (`pnpm start`
    // runs from /app), so this relative path resolves the same in both.
    html = readFileSync(resolve(process.cwd(), 'demo', 'index.html'), 'utf8');
  } catch {
    deps.logger.warn(
      'demo/index.html not found — / and /demo will 404. Acceptable in non-demo deployments.',
    );
  }

  return async (fastify) => {
    if (html === null) return;
    const body = html;
    const handler = async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      reply
        .code(200)
        .header('content-type', 'text/html; charset=utf-8')
        .header('cache-control', 'public, max-age=300')
        .send(body);
    };
    fastify.get('/', handler);
    fastify.get('/demo', handler);
  };
}
