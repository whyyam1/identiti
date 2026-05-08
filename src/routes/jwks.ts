/**
 * GET /.well-known/jwks.json — public key set used by consuming rails to verify
 * customer-token (Phase 3) and step-up token (Phase 5) signatures.
 *
 * No auth (path is in authPlugin's exemptPaths). Returns RFC 7517 JWKS shape.
 * Cached in memory; rebuilt only on key rotation (Phase 5+).
 */

import type { FastifyPluginAsync } from 'fastify';
import { buildJwks, type JwtKeyPair, type JwksDocument } from '../services/jwtKeys.js';

export interface JwksRouteDeps {
  keys: readonly JwtKeyPair[];
}

export function jwksRoutes(deps: JwksRouteDeps): FastifyPluginAsync {
  return async (fastify) => {
    let cached: JwksDocument | null = null;

    fastify.get('/.well-known/jwks.json', async (_request, reply) => {
      if (!cached) {
        cached = await buildJwks(deps.keys);
      }
      return reply
        .code(200)
        .header('cache-control', 'public, max-age=3600')
        .header('content-type', 'application/jwk-set+json; charset=utf-8')
        .send(cached);
    });
  };
}
