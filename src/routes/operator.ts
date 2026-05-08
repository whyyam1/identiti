/**
 * Operator endpoints — Sprint 1 essentials.
 *   POST /v1/operator/customers/{uuid}/suspend     active → frozen_aml
 *   POST /v1/operator/customers/{uuid}/reactivate  frozen_aml → active
 *
 * Both publish to identiti.account.events (ACCOUNT_SUSPENDED /
 * ACCOUNT_REACTIVATED per Reboot Pack §16.8). Both append an audit_log
 * entry. Scope: `identiti:operator` (sandbox model — Stage 2 swaps to
 * FIDO2/WebAuthn-backed operator console per Reboot Pack §10).
 *
 * State-machine note. Schema Appendix §17.1 lists `frozen_kyc → active` as a
 * valid transition, but it is NOT operator-driven — it is the consequence of
 * KYC artefact verification (ID-4). The operator reactivate endpoint is
 * deliberately AML-only: it accepts `frozen_aml → active` and rejects every
 * other starting state with `state_invalid_for_action` (409). When that error
 * is returned for a `frozen_kyc` account, the response detail names the
 * `current_state` so the operator console can route to the KYC workflow.
 */

import type { FastifyPluginAsync } from 'fastify';
import { errorResponse, successResponse } from '@kmv/platform-shared';
import { createAjv } from '../lib/ajv.js';
import { operatorActionRequestSchema } from '../schemas/operator.js';
import { tierOverrideRequestSchema } from '../schemas/tier.js';
import { isAccountUuid } from '../domain/accountUuid.js';
import type { AccountState, CustomersRepo, Tier } from '../repositories/types.js';
import type { EventProducer } from '../services/eventProducer.js';
import type { AuditLogger } from '../services/auditLogger.js';
import { requireScope } from '../plugins/scope.js';

const ajv = createAjv();
const validateActionBody = ajv.compile(operatorActionRequestSchema);
const validateTierOverrideBody = ajv.compile(tierOverrideRequestSchema);

interface ActionBody {
  reason: string;
}

export interface OperatorRouteDeps {
  customersRepo: CustomersRepo;
  eventProducer: EventProducer;
  auditLogger: AuditLogger;
}

interface TransitionConfig {
  routePath: string;
  action: 'suspend' | 'reactivate';
  fromStates: readonly AccountState[];
  toState: AccountState;
  eventType: 'ACCOUNT_SUSPENDED' | 'ACCOUNT_REACTIVATED';
}

function buildTransitionHandler(
  deps: OperatorRouteDeps,
  cfg: TransitionConfig
) {
  return async (
    request: import('fastify').FastifyRequest<{
      Params: { uuid: string };
    }>,
    reply: import('fastify').FastifyReply
  ) => {
    const rid = request.requestId;
    const appId = request.appId!;
    const { uuid } = request.params;

    if (!isAccountUuid(uuid)) {
      return reply
        .code(400)
        .send(
          errorResponse('validation_account_uuid_invalid', 'Account UUID is malformed', rid, {
            field: 'uuid',
          })
        );
    }

    if (!validateActionBody(request.body)) {
      return reply
        .code(400)
        .send(
          errorResponse('validation_request_invalid', 'Request body does not match schema', rid, {
            detail: { errors: validateActionBody.errors ?? [] },
          })
        );
    }
    const data = request.body as ActionBody;

    const result = await deps.customersRepo.changeState(uuid, cfg.fromStates, cfg.toState);

    if (!result) {
      const existing = await deps.customersRepo.findById(uuid);
      // Schema Appendix §3.9: refused state transitions surface as
      // state_invalid_for_action (409). Reused verbatim from Kipkiren Pay.
      const code = existing ? 'state_invalid_for_action' : 'customer_not_found';
      const status = existing ? 409 : 404;
      await deps.auditLogger.append({
        appId,
        actorType: 'operator',
        actorId: appId,
        action: `operator.customer.${cfg.action}.rejected`,
        resourceType: 'platform_account',
        resourceId: uuid,
        requestId: rid,
        traceparent: request.traceparent,
        outcome: 'failure',
        detail: {
          reason: data.reason,
          current_state: existing?.state ?? null,
          allowed_from: cfg.fromStates,
        },
      });
      return reply.code(status).send(
        existing
          ? errorResponse(
              code,
              `Cannot ${cfg.action} account in state ${existing.state}`,
              rid,
              {
                detail: {
                  current_state: existing.state,
                  allowed_from_states: cfg.fromStates,
                },
              }
            )
          : errorResponse(code, 'No account with that UUID', rid)
      );
    }

    const occurredAt = new Date().toISOString();
    await deps.eventProducer.publish({
      topic: 'identiti.account.events',
      key: uuid,
      type: cfg.eventType,
      occurredAt,
      data: {
        account_uuid: uuid,
        from_state: result.fromState,
        to_state: result.toState,
        reason: data.reason,
        operator_app_id: appId,
      },
    });

    await deps.auditLogger.append({
      appId,
      actorType: 'operator',
      actorId: appId,
      action: `operator.customer.${cfg.action}`,
      resourceType: 'platform_account',
      resourceId: uuid,
      requestId: rid,
      traceparent: request.traceparent,
      outcome: 'success',
      detail: {
        reason: data.reason,
        from_state: result.fromState,
        to_state: result.toState,
      },
    });

    return reply.code(200).send(
      successResponse(
        {
          account_uuid: uuid,
          from_state: result.fromState,
          to_state: result.toState,
          changed_at: occurredAt,
        },
        rid
      )
    );
  };
}

export function operatorRoutes(deps: OperatorRouteDeps): FastifyPluginAsync {
  return async (fastify) => {
    fastify.post<{ Params: { uuid: string } }>(
      '/v1/operator/customers/:uuid/suspend',
      { preHandler: requireScope('identiti:operator') },
      buildTransitionHandler(deps, {
        routePath: '/v1/operator/customers/:uuid/suspend',
        action: 'suspend',
        fromStates: ['active'],
        toState: 'frozen_aml',
        eventType: 'ACCOUNT_SUSPENDED',
      })
    );

    fastify.post<{ Params: { uuid: string } }>(
      '/v1/operator/customers/:uuid/reactivate',
      { preHandler: requireScope('identiti:operator') },
      buildTransitionHandler(deps, {
        routePath: '/v1/operator/customers/:uuid/reactivate',
        action: 'reactivate',
        fromStates: ['frozen_aml'],
        toState: 'active',
        eventType: 'ACCOUNT_REACTIVATED',
      })
    );

    fastify.post<{ Params: { uuid: string } }>(
      '/v1/operator/customers/:uuid/tier-override',
      { preHandler: requireScope('identiti:operator') },
      async (request, reply) => {
        const rid = request.requestId;
        const appId = request.appId!;
        const { uuid } = request.params;
        if (!isAccountUuid(uuid)) {
          return reply.code(400).send(
            errorResponse('validation_account_uuid_invalid', 'Account UUID is malformed', rid, {
              field: 'uuid',
            })
          );
        }
        if (!validateTierOverrideBody(request.body)) {
          return reply.code(400).send(
            errorResponse(
              'validation_request_invalid',
              'Request body does not match schema',
              rid,
              { detail: { errors: validateTierOverrideBody.errors ?? [] } }
            )
          );
        }
        const data = request.body as {
          tier: Tier;
          reason: string;
          narrative?: string;
        };

        const result = await deps.customersRepo.setTier(uuid, data.tier, data.reason);
        if (!result) {
          await deps.auditLogger.append({
            appId,
            actorType: 'operator',
            actorId: appId,
            action: 'operator.customer.tier_override.rejected',
            resourceType: 'platform_account',
            resourceId: uuid,
            requestId: rid,
            traceparent: request.traceparent,
            outcome: 'failure',
            detail: { reason: data.reason, target_tier: data.tier },
          });
          return reply
            .code(404)
            .send(errorResponse('customer_not_found', 'No account with that UUID', rid));
        }

        const occurredAt = result.assignedAt.toISOString();
        await deps.eventProducer.publish({
          topic: 'identiti.account.events',
          key: uuid,
          type: 'TIER_CHANGED',
          occurredAt,
          data: {
            account_uuid: uuid,
            from_tier: result.fromTier,
            to_tier: result.toTier,
            reason: result.reason,
            operator_app_id: appId,
            ...(data.narrative ? { narrative: data.narrative } : {}),
          },
        });

        await deps.auditLogger.append({
          appId,
          actorType: 'operator',
          actorId: appId,
          action: 'operator.customer.tier_override',
          resourceType: 'platform_account',
          resourceId: uuid,
          requestId: rid,
          traceparent: request.traceparent,
          outcome: 'success',
          detail: {
            from_tier: result.fromTier,
            to_tier: result.toTier,
            reason: result.reason,
            ...(data.narrative ? { narrative: data.narrative } : {}),
          },
        });

        return reply.code(200).send(
          successResponse(
            {
              account_uuid: uuid,
              from_tier: result.fromTier,
              to_tier: result.toTier,
              assigned_at: occurredAt,
              reason: result.reason,
            },
            rid
          )
        );
      }
    );
  };
}
