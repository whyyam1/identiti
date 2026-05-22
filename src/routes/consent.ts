/**
 * ID-14 — Hakken consent surface (newdocs pack ID-14).
 *
 *   POST /v1/consent/grants                     scope: identiti:consent:write
 *   GET  /v1/consent/{account_uuid}[?include=]  scope: identiti:consent:read
 *   POST /v1/consent/grants/{grant_id}/revoke   scope: identiti:consent:write
 *
 * Per `docs/NEWDOCS_DECISIONS.md` Q4 (settled): Identiti canonical.
 * Consuming rails (Hakken at HK-3/HK-4) cache 60s and invalidate via
 * Kafka — `identiti.consent.events`: `CONSENT_GRANTED` / `CONSENT_REVOKED`.
 * `SCOPE_DEGRADED` event semantics (when a re-grant narrows scope) are a
 * Phase-2 refinement — they require scope-hierarchy modelling that
 * v1.0 deliberately defers until the joint session locks the enum.
 *
 * Webhook delivery (HMAC-signed, retry 30s→24h) is also Phase 2: it
 * needs an outbox + worker, mirroring Helpan AI's pattern. v1.0 ships
 * the Kafka path only (same trade-off Todoku takes for STEP_UP_REQUIRED).
 */

import type { FastifyPluginAsync } from 'fastify';
import { errorResponse, generateUlid, successResponse } from '@kmv/platform-shared';
import { createAjv } from '../lib/ajv.js';
import {
  createConsentGrantRequestSchema,
  revokeConsentGrantRequestSchema,
} from '../schemas/consent.js';
import { isAccountUuid } from '../domain/accountUuid.js';
import { requireScope } from '../plugins/scope.js';
import type { ConsentGrant, ConsentGrantsRepo, CustomersRepo } from '../repositories/types.js';
import type { AuditLogger } from '../services/auditLogger.js';
import type { EventProducer } from '../services/eventProducer.js';

const ajv = createAjv();
const validateCreate = ajv.compile(createConsentGrantRequestSchema);
const validateRevoke = ajv.compile(revokeConsentGrantRequestSchema);

const GRANT_ID_PATTERN = /^cgr_[0-9A-HJKMNP-TV-Z]{26}$/;

interface CreateBody {
  account_uuid: string;
  app_id: string;
  scope: string;
}

interface RevokeBody {
  reason: string;
}

export interface ConsentRouteDeps {
  customersRepo: CustomersRepo;
  consentGrantsRepo: ConsentGrantsRepo;
  eventProducer: EventProducer;
  auditLogger: AuditLogger;
}

function serialiseGrant(g: ConsentGrant): Record<string, unknown> {
  const out: Record<string, unknown> = {
    grant_id: g.id,
    account_uuid: g.accountUuid,
    app_id: g.appId,
    scope: g.scope,
    granted_at: g.grantedAt.toISOString(),
    granted_via_app_id: g.grantedViaAppId,
  };
  if (g.revokedAt) out.revoked_at = g.revokedAt.toISOString();
  if (g.revokedByAppId) out.revoked_by_app_id = g.revokedByAppId;
  if (g.revokeReason) out.revoke_reason = g.revokeReason;
  return out;
}

export function consentRoutes(deps: ConsentRouteDeps): FastifyPluginAsync {
  return async (fastify) => {
    // ── POST /v1/consent/grants ────────────────────────────────────────
    fastify.post(
      '/v1/consent/grants',
      { preHandler: requireScope('identiti:consent:write') },
      async (request, reply) => {
        const rid = request.requestId;
        const appId = request.appId!;

        if (!validateCreate(request.body)) {
          return reply.code(400).send(
            errorResponse('validation_request_invalid', 'Request body does not match schema', rid, {
              detail: { errors: validateCreate.errors ?? [] },
            }),
          );
        }
        const data = request.body as CreateBody;

        const account = await deps.customersRepo.findById(data.account_uuid);
        if (!account) {
          return reply
            .code(404)
            .send(errorResponse('customer_not_found', 'No account with that UUID', rid));
        }

        const grantId = `cgr_${generateUlid()}`;
        const outcome = await deps.consentGrantsRepo.create({
          id: grantId,
          accountUuid: data.account_uuid,
          appId: data.app_id,
          scope: data.scope,
          grantedViaAppId: appId,
        });

        if (outcome.kind === 'already_open') {
          await deps.auditLogger.append({
            appId,
            actorType: 'app',
            actorId: appId,
            action: 'consent.grant.already_open',
            resourceType: 'consent_grant',
            resourceId: outcome.existing.id,
            requestId: rid,
            traceparent: request.traceparent,
            outcome: 'failure',
            detail: {
              account_uuid: data.account_uuid,
              app_id: data.app_id,
              scope: data.scope,
            },
          });
          return reply.code(409).send(
            errorResponse(
              'consent_grant_already_open',
              'An open grant for this (account, app, scope) already exists; revoke it before re-granting',
              rid,
              { detail: { existing_grant_id: outcome.existing.id } },
            ),
          );
        }

        await deps.eventProducer.publish({
          topic: 'identiti.consent.events',
          key: data.account_uuid,
          type: 'CONSENT_GRANTED',
          occurredAt: outcome.grant.grantedAt.toISOString(),
          data: {
            grant_id: outcome.grant.id,
            account_uuid: outcome.grant.accountUuid,
            app_id: outcome.grant.appId,
            scope: outcome.grant.scope,
            granted_via_app_id: outcome.grant.grantedViaAppId,
            granted_at: outcome.grant.grantedAt.toISOString(),
          },
        });

        await deps.auditLogger.append({
          appId,
          actorType: 'app',
          actorId: appId,
          action: 'consent.granted',
          resourceType: 'consent_grant',
          resourceId: outcome.grant.id,
          requestId: rid,
          traceparent: request.traceparent,
          outcome: 'success',
          detail: {
            account_uuid: data.account_uuid,
            app_id: data.app_id,
            scope: data.scope,
          },
        });

        return reply.code(201).send(successResponse(serialiseGrant(outcome.grant), rid));
      },
    );

    // ── GET /v1/consent/:account_uuid ──────────────────────────────────
    fastify.get<{
      Params: { account_uuid: string };
      Querystring: { include?: string };
    }>(
      '/v1/consent/:account_uuid',
      { preHandler: requireScope('identiti:consent:read') },
      async (request, reply) => {
        const rid = request.requestId;
        const { account_uuid } = request.params;
        if (!isAccountUuid(account_uuid)) {
          return reply.code(400).send(
            errorResponse('validation_account_uuid_invalid', 'Account UUID is malformed', rid, {
              field: 'account_uuid',
            }),
          );
        }
        const account = await deps.customersRepo.findById(account_uuid);
        if (!account) {
          return reply
            .code(404)
            .send(errorResponse('customer_not_found', 'No account with that UUID', rid));
        }

        // `?include=revoked` returns the full history (open + revoked);
        // default is open only — that's what consumers cache for 60s.
        const includeRevoked = request.query.include === 'revoked';
        const grants = includeRevoked
          ? await deps.consentGrantsRepo.listByAccount(account_uuid)
          : await deps.consentGrantsRepo.listOpenByAccount(account_uuid);

        // Hakken caches the read for 60s per Q4; the Cache-Control header
        // makes the cadence explicit. The Kafka invalidation path bypasses
        // the cache regardless.
        return reply
          .code(200)
          .header('cache-control', 'private, max-age=60')
          .send(
            successResponse(
              {
                account_uuid,
                grants: grants.map(serialiseGrant),
              },
              rid,
            ),
          );
      },
    );

    // ── POST /v1/consent/grants/:grant_id/revoke ───────────────────────
    fastify.post<{ Params: { grant_id: string } }>(
      '/v1/consent/grants/:grant_id/revoke',
      { preHandler: requireScope('identiti:consent:write') },
      async (request, reply) => {
        const rid = request.requestId;
        const appId = request.appId!;
        const { grant_id } = request.params;
        if (!GRANT_ID_PATTERN.test(grant_id)) {
          return reply.code(400).send(
            errorResponse('validation_request_invalid', 'grant_id is malformed', rid, {
              field: 'grant_id',
            }),
          );
        }
        if (!validateRevoke(request.body)) {
          return reply.code(400).send(
            errorResponse('validation_request_invalid', 'Request body does not match schema', rid, {
              detail: { errors: validateRevoke.errors ?? [] },
            }),
          );
        }
        const data = request.body as RevokeBody;

        const now = new Date();
        const outcome = await deps.consentGrantsRepo.revoke(grant_id, appId, data.reason, now);
        if (outcome.kind === 'not_found') {
          return reply
            .code(404)
            .send(errorResponse('consent_grant_not_found', 'Unknown grant_id', rid));
        }
        if (outcome.kind === 'already_revoked') {
          return reply.code(409).send(
            errorResponse(
              'consent_grant_already_revoked',
              'This grant has already been revoked',
              rid,
              {
                detail: {
                  grant_id,
                  revoked_at: outcome.existing.revokedAt?.toISOString() ?? null,
                },
              },
            ),
          );
        }

        await deps.eventProducer.publish({
          topic: 'identiti.consent.events',
          key: outcome.grant.accountUuid,
          type: 'CONSENT_REVOKED',
          occurredAt: now.toISOString(),
          data: {
            grant_id: outcome.grant.id,
            account_uuid: outcome.grant.accountUuid,
            app_id: outcome.grant.appId,
            scope: outcome.grant.scope,
            revoked_by_app_id: appId,
            revoke_reason: data.reason,
            revoked_at: now.toISOString(),
          },
        });

        await deps.auditLogger.append({
          appId,
          actorType: 'app',
          actorId: appId,
          action: 'consent.revoked',
          resourceType: 'consent_grant',
          resourceId: outcome.grant.id,
          requestId: rid,
          traceparent: request.traceparent,
          outcome: 'success',
          detail: {
            account_uuid: outcome.grant.accountUuid,
            app_id: outcome.grant.appId,
            scope: outcome.grant.scope,
            reason: data.reason,
          },
        });

        return reply.code(200).send(successResponse(serialiseGrant(outcome.grant), rid));
      },
    );
  };
}
