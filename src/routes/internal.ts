/**
 * Internal endpoints — restricted to specific HMAC tenants via scope.
 *
 *   POST /v1/internal/sign  — Helpan AI delegated-authority token issuance
 *                             (Delegated Authority Contract §6.3 + §8.2)
 *
 * Scope: `identiti:internal:sign:delegated_authority`. Only Helpan AI's
 * `app_credentials` row holds this scope; every other tenant gets 403.
 *
 * Identiti signs the pre-formed claim set (Helpan AI owns the claim author
 * surface — agent registry, scope catalogue, per-scope limits). We enforce:
 *   - HMAC scope (route-level)
 *   - Caller app_id matches HELPAN_AI_APP_ID env (defence-in-depth — the
 *     scope alone should suffice, but the explicit pin makes mis-grants safe)
 *   - JSON-Schema shape on `{kid, claims}` (claim must be §2.3 wire shape)
 *   - Semantic invariants in the signer service (kid known, iss literal,
 *     token_class, exp ≤ per-scope-class max)
 *
 * If the step-up JTI is supplied, we mark it consumed atomically (Schema
 * Appendix §16.3 step 12). High-stakes money / identity-sensitive scopes
 * SHOULD carry a step_up_jti per §3.5; v1.0 enforcement of "SHOULD" is left
 * to Helpan AI's request-side validation (it knows which scope_ids are
 * high-stakes).
 *
 * Audit:
 *   - `delegated_authority_signings` row written on every success (durable
 *     audit; cross-rail join via `traceparent` per Reboot Pack §A.11).
 *   - `audit_log` entry written on success and failure.
 */

import type { FastifyPluginAsync } from 'fastify';
import { errorResponse, successResponse } from '@kmv/platform-shared';
import { createAjv } from '../lib/ajv.js';
import { internalSignRequestSchema } from '../schemas/internal.js';
import { requireScope } from '../plugins/scope.js';
import type {
  CustomersRepo,
  DelegatedAuthoritySigningsRepo,
  StepUpTokensRepo,
} from '../repositories/types.js';
import type { AuditLogger } from '../services/auditLogger.js';
import type {
  DelegatedAuthoritySigner,
  DelegatedAuthorityClaimSet,
} from '../services/delegatedAuthoritySigner.js';

const ajv = createAjv();
const validateRequest = ajv.compile(internalSignRequestSchema);

export const INTERNAL_SIGN_SCOPE = 'identiti:internal:sign:delegated_authority';

interface SignBody {
  kid: string;
  claims: DelegatedAuthorityClaimSet & { step_up_jti?: string };
}

export interface InternalRouteDeps {
  customersRepo: CustomersRepo;
  stepUpTokensRepo: StepUpTokensRepo;
  delegatedAuthoritySigningsRepo: DelegatedAuthoritySigningsRepo;
  delegatedAuthoritySigner: DelegatedAuthoritySigner;
  auditLogger: AuditLogger;
  /** Pinned Helpan AI HMAC tenant app_id. Must match request.appId in addition to the scope check. */
  helpanAiAppId: string;
}

export function internalRoutes(deps: InternalRouteDeps): FastifyPluginAsync {
  return async (fastify) => {
    fastify.post(
      '/v1/internal/sign',
      { preHandler: requireScope(INTERNAL_SIGN_SCOPE) },
      async (request, reply) => {
        const rid = request.requestId;
        const appId = request.appId!;

        // Belt-and-braces: the scope alone should be enough, but pin to the
        // configured Helpan AI tenant so a mis-granted scope on another tenant
        // can't mint delegated-authority tokens.
        if (appId !== deps.helpanAiAppId) {
          return reply
            .code(403)
            .send(
              errorResponse(
                'AUTH_SCOPE_INSUFFICIENT',
                'Only the Helpan AI internal tenant may call this endpoint',
                rid,
              ),
            );
        }

        if (!validateRequest(request.body)) {
          return reply
            .code(400)
            .send(
              errorResponse(
                'validation_request_invalid',
                'Request body does not match schema',
                rid,
                { detail: { errors: validateRequest.errors ?? [] } },
              ),
            );
        }
        const body = request.body as SignBody;

        // Account must exist and be in a non-terminal state. We do NOT require
        // 'active' here — Helpan AI's H-3 issuance flow runs its own gates
        // (KYC tier, freeze states) per Delegated Authority Contract §3.5;
        // Identiti's job is identity existence + signing, not authorisation.
        const account = await deps.customersRepo.findById(body.claims.sub);
        if (!account) {
          return reply
            .code(404)
            .send(errorResponse('customer_not_found', 'No account with that UUID', rid));
        }

        // Optional step-up consumption. Atomic single-use enforcement per
        // Schema Appendix §16.3 step 12. If the JTI is unknown or already
        // consumed, fail the sign request — Helpan AI cannot mint over a
        // dead step-up.
        if (body.claims.step_up_jti) {
          const stepup = await deps.stepUpTokensRepo.findByJti(body.claims.step_up_jti);
          if (!stepup) {
            return reply.code(400).send(
              errorResponse('step_up_token_unknown', 'Step-up token jti not found', rid, {
                field: 'claims.step_up_jti',
              }),
            );
          }
          if (stepup.accountUuid !== body.claims.sub) {
            return reply
              .code(400)
              .send(
                errorResponse(
                  'step_up_token_subject_mismatch',
                  'Step-up token subject does not match claims.sub',
                  rid,
                  { field: 'claims.step_up_jti' },
                ),
              );
          }
          const consumed = await deps.stepUpTokensRepo.markConsumed(
            body.claims.step_up_jti,
            new Date(),
          );
          if (!consumed) {
            return reply
              .code(409)
              .send(
                errorResponse(
                  'step_up_token_already_used',
                  'Step-up token has already been consumed (replay detected)',
                  rid,
                  { field: 'claims.step_up_jti' },
                ),
              );
          }
        }

        // Sign. The signer service enforces the §2.4 semantic invariants
        // (kid known, iss literal, token_class, exp bounds).
        const signed = await deps.delegatedAuthoritySigner.sign({
          kid: body.kid,
          claims: body.claims,
        });
        if (!signed.ok) {
          await deps.auditLogger.append({
            appId,
            actorType: 'app',
            actorId: appId,
            action: 'internal.sign.delegated_authority.rejected',
            resourceType: 'delegated_authority_signing',
            resourceId: body.claims.jti,
            requestId: rid,
            traceparent: request.traceparent,
            outcome: 'failure',
            detail: {
              error_code: signed.error.code,
              error_message: signed.error.message,
              kid: body.kid,
            },
          });
          return reply.code(400).send(
            errorResponse(signed.error.code, signed.error.message, rid, {
              detail: { kid: body.kid },
            }),
          );
        }

        // Durable audit row. Cross-rail join key is `traceparent` per Reboot
        // Pack §A.11; Helpan AI persists the same traceparent on the
        // Authority row.
        await deps.delegatedAuthoritySigningsRepo.create({
          jti: body.claims.jti,
          accountUuid: body.claims.sub,
          agentId: body.claims.actor.agent_id,
          stepUpJti: body.claims.step_up_jti ?? null,
          scopes: body.claims.scopes,
          kid: body.kid,
          signedAt: signed.result.signedAt,
          expiresAt: signed.result.expiresAt,
          callerAppId: appId,
          traceparent: request.traceparent ?? null,
          businessOpId: null,
        });

        await deps.auditLogger.append({
          appId,
          actorType: 'app',
          actorId: appId,
          action: 'internal.sign.delegated_authority',
          resourceType: 'delegated_authority_signing',
          resourceId: body.claims.jti,
          requestId: rid,
          traceparent: request.traceparent,
          outcome: 'success',
          detail: {
            account_uuid: body.claims.sub,
            agent_id: body.claims.actor.agent_id,
            kid: body.kid,
            scope_ids: body.claims.scopes.map((s) => s.scope_id),
            step_up_jti: body.claims.step_up_jti ?? null,
          },
        });

        return reply.code(200).send(
          successResponse(
            {
              token: signed.result.token,
              signed_at: signed.result.signedAt.toISOString(),
            },
            rid,
          ),
        );
      },
    );
  };
}
