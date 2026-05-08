/**
 * Tier signal endpoint — Rail Contract Schema Appendix §6.1.
 *   GET /v1/customers/{uuid}/tier
 *
 * Consumed by Kipkiren Pay (cached for 60 s on KP side; invalidated by Kafka
 * TIER_CHANGED). Short response, no PII.
 */

import type { FastifyPluginAsync } from 'fastify';
import { errorResponse, successResponse } from '@kmv/platform-shared';
import { isAccountUuid } from '../domain/accountUuid.js';
import { requireScope } from '../plugins/scope.js';
import type { CustomersRepo } from '../repositories/types.js';

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
            })
          );
        }
        const tier = await deps.customersRepo.getTier(uuid);
        if (!tier) {
          return reply
            .code(404)
            .send(errorResponse('customer_not_found', 'No account with that UUID', rid));
        }
        return reply.code(200).send(
          successResponse(
            {
              tier: tier.tier,
              assigned_at: tier.assignedAt.toISOString(),
              reason: tier.reason,
            },
            rid
          )
        );
      }
    );
  };
}
