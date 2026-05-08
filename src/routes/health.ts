/**
 * GET /v1/health — shallow health check. No auth (path is in authPlugin's
 * exemptPaths). Phase 1: returns rail metadata only; deeper checks (DB, Kafka,
 * IPRS) land in later phases via /v1/health/deep.
 *
 * Per Instruction Pack §6.3 Phase 1.
 */

import type { FastifyPluginAsync } from 'fastify';
import { successResponse } from '@kmv/platform-shared';
import type { Env } from '../config/env.js';

export function healthRoutes(env: Env): FastifyPluginAsync {
  return async (fastify) => {
    fastify.get('/v1/health', async (request) => {
      return successResponse(
        {
          status: 'ok',
          rail: 'identiti',
          version: env.RAIL_VERSION,
          environment: env.NODE_ENV,
        },
        request.requestId
      );
    });
  };
}
