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
import {
  operatorActionRequestSchema,
  operatorKycApproveRequestSchema,
  operatorKycRejectRequestSchema,
} from '../schemas/operator.js';
import { tierOverrideRequestSchema } from '../schemas/tier.js';
import { isAccountUuid } from '../domain/accountUuid.js';
import type {
  AccountState,
  CustomersRepo,
  KycRecord,
  KycRecordsRepo,
  Tier,
} from '../repositories/types.js';
import type { EventProducer } from '../services/eventProducer.js';
import type { AuditLogger } from '../services/auditLogger.js';
import { requireScope } from '../plugins/scope.js';

const ajv = createAjv();
const validateActionBody = ajv.compile(operatorActionRequestSchema);
const validateTierOverrideBody = ajv.compile(tierOverrideRequestSchema);
const validateKycApproveBody = ajv.compile(operatorKycApproveRequestSchema);
const validateKycRejectBody = ajv.compile(operatorKycRejectRequestSchema);

const VERIFICATION_ARTEFACT_ID_PATTERN = /^ver_[0-9A-HJKMNP-TV-Z]{26}$/;

/** Operator-approved KYC artefacts also expire after 12 months, mirroring the IPRS path. */
const KYC_VALIDITY_MS = 365 * 24 * 60 * 60 * 1000;

interface ActionBody {
  reason: string;
}

export interface OperatorRouteDeps {
  customersRepo: CustomersRepo;
  kycRecordsRepo: KycRecordsRepo;
  eventProducer: EventProducer;
  auditLogger: AuditLogger;
}

function projectKycRecord(r: KycRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {
    artefact_id: r.id,
    account_uuid: r.accountId,
    kind: r.kind,
    state: r.status,
    tier: r.tier,
    verification_method: r.verificationMethod,
    created_at: r.createdAt.toISOString(),
  };
  if (r.verifiedAt) out.verified_at = r.verifiedAt.toISOString();
  if (r.expiresAt) out.expires_at = r.expiresAt.toISOString();
  if (r.failureReason) out.failure_reason = r.failureReason;
  return out;
}

interface TransitionConfig {
  routePath: string;
  action: 'suspend' | 'reactivate';
  fromStates: readonly AccountState[];
  toState: AccountState;
  eventType: 'ACCOUNT_SUSPENDED' | 'ACCOUNT_REACTIVATED';
}

function buildTransitionHandler(deps: OperatorRouteDeps, cfg: TransitionConfig) {
  return async (
    request: import('fastify').FastifyRequest<{
      Params: { uuid: string };
    }>,
    reply: import('fastify').FastifyReply,
  ) => {
    const rid = request.requestId;
    const appId = request.appId!;
    const { uuid } = request.params;

    if (!isAccountUuid(uuid)) {
      return reply.code(400).send(
        errorResponse('validation_account_uuid_invalid', 'Account UUID is malformed', rid, {
          field: 'uuid',
        }),
      );
    }

    if (!validateActionBody(request.body)) {
      return reply.code(400).send(
        errorResponse('validation_request_invalid', 'Request body does not match schema', rid, {
          detail: { errors: validateActionBody.errors ?? [] },
        }),
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
          ? errorResponse(code, `Cannot ${cfg.action} account in state ${existing.state}`, rid, {
              detail: {
                current_state: existing.state,
                allowed_from_states: cfg.fromStates,
              },
            })
          : errorResponse(code, 'No account with that UUID', rid),
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
        rid,
      ),
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
      }),
    );

    fastify.post<{ Params: { uuid: string } }>(
      '/v1/operator/customers/:uuid/reactivate',
      { preHandler: requireScope('identiti:operator') },
      buildTransitionHandler(deps, {
        routePath: '/v1/operator/customers/:uuid/reactivate',
        action: 'reactivate',
        // `pending_onboarding` included per App Integration Guide §21.11.4
        // GAP-1: nothing else in the rail could move a newly-created account
        // to `active`, so step-up (which requires `active`) was unreachable
        // for every app-created customer. Operator-scoped for now; a
        // self-serve activation path is a separate design decision.
        fromStates: ['frozen_aml', 'pending_onboarding'],
        toState: 'active',
        eventType: 'ACCOUNT_REACTIVATED',
      }),
    );

    // ── Phase 9: audit-trail read ───────────────────────────────────────────
    fastify.get<{ Params: { uuid: string }; Querystring: { limit?: string } }>(
      '/v1/operator/customers/:uuid/audit',
      { preHandler: requireScope('identiti:operator') },
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
        const limitRaw = request.query.limit;
        const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
        const entries = await deps.auditLogger.listByResource(
          'platform_account',
          uuid,
          limit !== undefined ? { limit } : undefined,
        );
        return reply.code(200).send(
          successResponse(
            {
              account_uuid: uuid,
              items: entries.map((e) => ({
                id: e.id,
                actor_type: e.actorType,
                actor_id: e.actorId,
                action: e.action,
                outcome: e.outcome,
                detail: e.detail ?? null,
                request_id: e.requestId,
                created_at: e.createdAt.toISOString(),
              })),
            },
            rid,
          ),
        );
      },
    );

    // ── Phase 9: KYC pending list ──────────────────────────────────────────
    fastify.get<{ Querystring: { limit?: string } }>(
      '/v1/operator/kyc/pending',
      { preHandler: requireScope('identiti:operator') },
      async (request, reply) => {
        const rid = request.requestId;
        const limitRaw = request.query.limit;
        const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
        const records = await deps.kycRecordsRepo.listByStatus('pending', limit);
        return reply.code(200).send(successResponse({ items: records.map(projectKycRecord) }, rid));
      },
    );

    // ── Phase 9: KYC approve ────────────────────────────────────────────────
    fastify.post<{ Params: { id: string } }>(
      '/v1/operator/kyc/:id/approve',
      { preHandler: requireScope('identiti:operator') },
      async (request, reply) => {
        const rid = request.requestId;
        const appId = request.appId!;
        const { id } = request.params;
        if (!VERIFICATION_ARTEFACT_ID_PATTERN.test(id)) {
          return reply.code(400).send(
            errorResponse('validation_request_invalid', 'Artefact ID is malformed', rid, {
              field: 'id',
            }),
          );
        }
        if (!validateKycApproveBody(request.body)) {
          return reply
            .code(400)
            .send(
              errorResponse(
                'validation_request_invalid',
                'Request body does not match schema',
                rid,
                { detail: { errors: validateKycApproveBody.errors ?? [] } },
              ),
            );
        }
        const data = (request.body as { narrative?: string }) ?? {};
        const existing = await deps.kycRecordsRepo.findById(id);
        if (!existing) {
          return reply
            .code(404)
            .send(errorResponse('kyc_artefact_not_found', 'No artefact with that ID', rid));
        }
        if (existing.status !== 'pending') {
          return reply
            .code(409)
            .send(
              errorResponse(
                'state_invalid_for_action',
                `KYC record is in state ${existing.status}; only pending can be approved`,
                rid,
                { detail: { current_state: existing.status } },
              ),
            );
        }

        const now = new Date();
        const expiresAt = new Date(now.getTime() + KYC_VALIDITY_MS);
        const updated = await deps.kycRecordsRepo.markVerified(id, {
          verifiedAt: now,
          expiresAt,
        });
        if (!updated) {
          // Race: state changed between findById and markVerified.
          return reply
            .code(409)
            .send(
              errorResponse(
                'state_invalid_for_action',
                'KYC record state changed during approval',
                rid,
              ),
            );
        }

        // Tier promotion if this artefact unlocks a higher tier.
        let tierPromotedTo: Tier | undefined;
        const account = await deps.customersRepo.findById(updated.accountId);
        if (account && account.tier === 'tier_0' && updated.tier === 'tier_1') {
          const tierResult = await deps.customersRepo.setTier(
            updated.accountId,
            'tier_1',
            'rule_based_tier_1_kyc_complete',
          );
          if (tierResult) {
            tierPromotedTo = 'tier_1';
            await deps.eventProducer.publish({
              topic: 'identiti.account.events',
              key: updated.accountId,
              type: 'TIER_CHANGED',
              occurredAt: tierResult.assignedAt.toISOString(),
              data: {
                account_uuid: updated.accountId,
                from_tier: tierResult.fromTier,
                to_tier: tierResult.toTier,
                reason: tierResult.reason,
              },
            });
          }
        }

        await deps.eventProducer.publish({
          topic: 'identiti.kyc.events',
          key: updated.accountId,
          type: 'KYC_APPROVED',
          occurredAt: now.toISOString(),
          data: {
            account_uuid: updated.accountId,
            artefact_id: updated.id,
            kind: updated.kind,
            tier: updated.tier,
            verified_at: now.toISOString(),
            expires_at: expiresAt.toISOString(),
            verification_method: 'manual',
            operator_app_id: appId,
          },
        });

        await deps.auditLogger.append({
          appId,
          actorType: 'operator',
          actorId: appId,
          action: 'operator.kyc.approved',
          resourceType: 'kyc_record',
          resourceId: updated.id,
          requestId: rid,
          traceparent: request.traceparent,
          outcome: 'success',
          detail: {
            account_uuid: updated.accountId,
            kind: updated.kind,
            tier: updated.tier,
            ...(data.narrative ? { narrative: data.narrative } : {}),
            ...(tierPromotedTo ? { tier_promoted_to: tierPromotedTo } : {}),
          },
        });

        const responseData: Record<string, unknown> = projectKycRecord(updated);
        if (tierPromotedTo) responseData.tier_promoted_to = tierPromotedTo;
        return reply.code(200).send(successResponse(responseData, rid));
      },
    );

    // ── Phase 9: KYC reject ─────────────────────────────────────────────────
    fastify.post<{ Params: { id: string } }>(
      '/v1/operator/kyc/:id/reject',
      { preHandler: requireScope('identiti:operator') },
      async (request, reply) => {
        const rid = request.requestId;
        const appId = request.appId!;
        const { id } = request.params;
        if (!VERIFICATION_ARTEFACT_ID_PATTERN.test(id)) {
          return reply.code(400).send(
            errorResponse('validation_request_invalid', 'Artefact ID is malformed', rid, {
              field: 'id',
            }),
          );
        }
        if (!validateKycRejectBody(request.body)) {
          return reply
            .code(400)
            .send(
              errorResponse(
                'validation_request_invalid',
                'Request body does not match schema',
                rid,
                { detail: { errors: validateKycRejectBody.errors ?? [] } },
              ),
            );
        }
        const data = request.body as { reason: string };
        const existing = await deps.kycRecordsRepo.findById(id);
        if (!existing) {
          return reply
            .code(404)
            .send(errorResponse('kyc_artefact_not_found', 'No artefact with that ID', rid));
        }
        if (existing.status !== 'pending') {
          return reply
            .code(409)
            .send(
              errorResponse(
                'state_invalid_for_action',
                `KYC record is in state ${existing.status}; only pending can be rejected`,
                rid,
                { detail: { current_state: existing.status } },
              ),
            );
        }
        const updated = await deps.kycRecordsRepo.markFailed(id, data.reason);
        if (!updated) {
          return reply
            .code(409)
            .send(
              errorResponse(
                'state_invalid_for_action',
                'KYC record state changed during rejection',
                rid,
              ),
            );
        }

        await deps.eventProducer.publish({
          topic: 'identiti.kyc.events',
          key: updated.accountId,
          type: 'KYC_REJECTED',
          occurredAt: new Date().toISOString(),
          data: {
            account_uuid: updated.accountId,
            artefact_id: updated.id,
            kind: updated.kind,
            reason: data.reason,
            operator_app_id: appId,
          },
        });

        await deps.auditLogger.append({
          appId,
          actorType: 'operator',
          actorId: appId,
          action: 'operator.kyc.rejected',
          resourceType: 'kyc_record',
          resourceId: updated.id,
          requestId: rid,
          traceparent: request.traceparent,
          outcome: 'success',
          detail: {
            account_uuid: updated.accountId,
            kind: updated.kind,
            reason: data.reason,
          },
        });

        return reply.code(200).send(successResponse(projectKycRecord(updated), rid));
      },
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
            }),
          );
        }
        if (!validateTierOverrideBody(request.body)) {
          return reply
            .code(400)
            .send(
              errorResponse(
                'validation_request_invalid',
                'Request body does not match schema',
                rid,
                { detail: { errors: validateTierOverrideBody.errors ?? [] } },
              ),
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
            rid,
          ),
        );
      },
    );
  };
}
