/**
 * Tier signal endpoint — Rail Contract Schema Appendix §6.1.
 *   GET /v1/customers/{uuid}/tier
 *
 * Consumed by Kipkiren Pay (cached for 60 s on KP side; invalidated by Kafka
 * TIER_CHANGED). Short response, no PII. The rail emits a matching
 * `Cache-Control: private, max-age=60` so the cache behaviour is
 * contract-driven, not consumer-coded.
 */

import type { FastifyPluginAsync } from 'fastify';
import { errorResponse, successResponse } from '@kmv/platform-shared';
import { isAccountUuid } from '../domain/accountUuid.js';
import { requireScope } from '../plugins/scope.js';
import type { CustomersRepo } from '../repositories/types.js';

/** Tier-2 evidence is re-screened on a 12-month cadence; tier_0 / tier_1 are evergreen. */
const TIER_2_REVIEW_INTERVAL_MS = 365 * 24 * 60 * 60 * 1000;

export interface TierRouteDeps {
  customersRepo: CustomersRepo;
}

export function tierRoutes(deps: TierRouteDeps): FastifyPluginAsync {
  return async (fastify) => {
    fastify.get<{ Params: { uuid: string } }>(
      '/v1/customers/:uuid/tier',
      { preHandler: requireScope('identiti:tier:read') },
      async (request, reply) => {
        const rid = request.requestId;
        const { uuid } = request.params;
        if (!isAccountUuid(uuid)) {
          return reply.code(400).send(
            errorResponse('validation_account_uuid_invalid', 'Account UUID is malformed', rid, {
              field: 'uuid',
            }),
          );
        }
        const tier = await deps.customersRepo.getTier(uuid);
        if (!tier) {
          return reply
            .code(404)
            .send(errorResponse('customer_not_found', 'No account with that UUID', rid));
        }
        const data: Record<string, unknown> = {
          tier: tier.tier,
          assigned_at: tier.assignedAt.toISOString(),
          reason: tier.reason,
        };
        if (tier.tier === 'tier_2') {
          data.next_review_at = new Date(
            tier.assignedAt.getTime() + TIER_2_REVIEW_INTERVAL_MS,
          ).toISOString();
        }
        return reply
          .code(200)
          .header('cache-control', 'private, max-age=60')
          .send(successResponse(data, rid));
      },
    );
  };
}
