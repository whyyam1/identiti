/**
 * Tier endpoints — Rail Contract Schema Appendix §6.
 *   GET /v1/customers/{uuid}/tier          §6.1 — current tier signal
 *   GET /v1/customers/{uuid}/tier/history  §6.4 — paginated assignment history
 *
 * The tier signal is consumed by Kipkiren Pay (cached for 60 s on KP side;
 * invalidated by Kafka TIER_CHANGED). Short response, no PII. The rail emits
 * a matching `Cache-Control: private, max-age=60` so the cache behaviour is
 * contract-driven, not consumer-coded.
 *
 * Tier history is customer-facing: one row per assignment (period at a
 * given tier). The current assignment carries no `ended_at`.
 */

import type { FastifyPluginAsync } from 'fastify';
import { errorResponse, successResponse } from '@kmv/platform-shared';
import { isAccountUuid } from '../domain/accountUuid.js';
import { requireScope } from '../plugins/scope.js';
import type { CustomersRepo, TierAssignment } from '../repositories/types.js';

/** Tier-2 evidence is re-screened on a 12-month cadence; tier_0 / tier_1 are evergreen. */
const TIER_2_REVIEW_INTERVAL_MS = 365 * 24 * 60 * 60 * 1000;

const TIER_ASSIGNMENT_ID_PATTERN = /^tas_[0-9A-HJKMNP-TV-Z]{26}$/;

export interface TierRouteDeps {
  customersRepo: CustomersRepo;
}

interface TierHistoryQuery {
  limit?: string;
  cursor?: string;
}

function serialiseAssignment(a: TierAssignment): Record<string, unknown> {
  const out: Record<string, unknown> = {
    assignment_id: a.assignmentId,
    tier: a.tier,
    assigned_at: a.assignedAt.toISOString(),
    reason: a.reason,
  };
  if (a.endedAt) out.ended_at = a.endedAt.toISOString();
  return out;
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

    fastify.get<{ Params: { uuid: string }; Querystring: TierHistoryQuery }>(
      '/v1/customers/:uuid/tier/history',
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
        // ?limit=N (1-200, default 50). Reject anything non-numeric or out of
        // range with a precise error so a caller's bad pagination is obvious.
        let limit: number | undefined;
        if (request.query.limit !== undefined) {
          const n = Number.parseInt(request.query.limit, 10);
          if (!Number.isFinite(n) || n < 1 || n > 200) {
            return reply
              .code(400)
              .send(
                errorResponse(
                  'validation_request_invalid',
                  'limit must be an integer between 1 and 200',
                  rid,
                  { field: 'limit' },
                ),
              );
          }
          limit = n;
        }
        // ?cursor=tas_<ULID> from a previous page.
        const cursor = request.query.cursor;
        if (cursor !== undefined && !TIER_ASSIGNMENT_ID_PATTERN.test(cursor)) {
          return reply.code(400).send(
            errorResponse('validation_request_invalid', 'cursor is malformed', rid, {
              field: 'cursor',
            }),
          );
        }
        const page = await deps.customersRepo.getTierHistory(uuid, {
          ...(limit !== undefined ? { limit } : {}),
          ...(cursor !== undefined ? { cursor } : {}),
        });
        if (!page) {
          return reply
            .code(404)
            .send(errorResponse('customer_not_found', 'No account with that UUID', rid));
        }
        return reply.code(200).send(
          successResponse(
            {
              items: page.items.map(serialiseAssignment),
              cursor: page.cursor,
            },
            rid,
          ),
        );
      },
    );
  };
}
