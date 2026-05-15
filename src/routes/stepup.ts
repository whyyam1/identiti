/**
 * Step-up endpoints — Schema Appendix §7, Scaffold §14.
 *   POST /v1/stepup/challenges  — initiate (publishes STEP_UP_REQUIRED)
 *   POST /v1/stepup/verify      — consume challenge, issue RS256 step-up JWT
 *
 * `/v1/stepup/tokens/validate` (Schema Appendix §7.5) is deliberately NOT
 * shipped in v1.0 — it's a diagnostic endpoint per Scaffold §14.4 and KP
 * verifies tokens locally against the JWKS per §16.3. Add when an
 * edge-case caller materialises.
 *
 * Reuses `auth_challenges` with `purpose='stepup'` (table is shared by
 * design; migration 0003 supports this).
 */

import type { FastifyPluginAsync } from 'fastify';
import { errorResponse, generateUlid, successResponse } from '@kmv/platform-shared';
import { createAjv } from '../lib/ajv.js';
import {
  initiateStepupRequestSchema,
  verifyStepupRequestSchema,
  STEPUP_TTL_BY_RISK,
} from '../schemas/stepup.js';
import { isAccountUuid } from '../domain/accountUuid.js';
import type {
  AuthChallengesRepo,
  CustomersRepo,
  InitiatedBy,
  RiskTier,
  StepUpActor,
  StepUpTokensRepo,
} from '../repositories/types.js';
import type { EventProducer } from '../services/eventProducer.js';
import type { AuditLogger } from '../services/auditLogger.js';
import type { JwtSigner } from '../services/jwtSigner.js';
import { generateOtp, hashOtp, verifyOtp, MAX_OTP_ATTEMPTS } from '../services/otp.js';
import { requireScope } from '../plugins/scope.js';

const ajv = createAjv();
const validateInitiate = ajv.compile(initiateStepupRequestSchema);
const validateVerify = ajv.compile(verifyStepupRequestSchema);

interface InitiateBody {
  account_uuid: string;
  operation_audience: string;
  operation_kind: string;
  operation_risk_tier: RiskTier;
  factor: 'phone_otp' | 'hardware_key' | 'passive_biometric';
  device?: unknown;
  // ID-10 (Amendment §A.1/§A.2) — agentic-AI propagation. Both optional.
  actor?: {
    type: 'agent';
    agent_id: string;
    delegated_authority_jti?: string;
  };
  initiated_by?: InitiatedBy;
}

interface VerifyBody {
  challenge_id: string;
  response: string | object;
  client_device?: unknown;
}

export interface StepupRouteDeps {
  customersRepo: CustomersRepo;
  challengesRepo: AuthChallengesRepo;
  stepUpTokensRepo: StepUpTokensRepo;
  eventProducer: EventProducer;
  auditLogger: AuditLogger;
  jwtSigner: JwtSigner;
  otpBcryptRounds: number;
  envName: string;
}

export function stepupRoutes(deps: StepupRouteDeps): FastifyPluginAsync {
  return async (fastify) => {
    fastify.post(
      '/v1/stepup/challenges',
      { preHandler: requireScope('identiti:stepup:request') },
      async (request, reply) => {
        const rid = request.requestId;
        const appId = request.appId!;

        if (!validateInitiate(request.body)) {
          return reply.code(400).send(
            errorResponse(
              'validation_request_invalid',
              'Request body does not match schema',
              rid,
              { detail: { errors: validateInitiate.errors ?? [] } }
            )
          );
        }
        const data = request.body as InitiateBody;

        if (!isAccountUuid(data.account_uuid)) {
          return reply.code(400).send(
            errorResponse('validation_account_uuid_invalid', 'Account UUID is malformed', rid, {
              field: 'account_uuid',
            })
          );
        }

        // v1.0 only wires phone_otp end-to-end. hardware_key and
        // passive_biometric require Phase 5+ adapters; reject up-front.
        if (data.factor !== 'phone_otp') {
          return reply.code(400).send(
            errorResponse(
              'auth_factor_unsupported',
              `Factor ${data.factor} is not supported in this phase`,
              rid,
              { field: 'factor' }
            )
          );
        }

        const account = await deps.customersRepo.findById(data.account_uuid);
        if (!account) {
          return reply
            .code(404)
            .send(errorResponse('customer_not_found', 'No account with that UUID', rid));
        }
        // Step-up requires an active account. Frozen / closed accounts cannot
        // step up to elevate permissions on a different rail.
        if (account.state !== 'active') {
          return reply.code(409).send(
            errorResponse(
              'state_invalid_for_action',
              `Account is in state ${account.state}; step-up requires active`,
              rid,
              {
                detail: {
                  current_state: account.state,
                  required_state: 'active',
                },
              }
            )
          );
        }

        const ttlSeconds = STEPUP_TTL_BY_RISK[data.operation_risk_tier];
        const otp = generateOtp();
        const otpHash = await hashOtp(otp, deps.otpBcryptRounds);
        const challengeId = `stp_${generateUlid()}`;
        const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

        // ID-10: hold the agentic-AI propagation claims on the challenge row
        // so /v1/stepup/verify can stamp them into the resulting JWT.
        const challengeActor: StepUpActor | undefined = data.actor
          ? {
              type: data.actor.type,
              ...(data.actor.agent_id ? { agentId: data.actor.agent_id } : {}),
              ...(data.actor.delegated_authority_jti
                ? { delegatedAuthorityJti: data.actor.delegated_authority_jti }
                : {}),
            }
          : undefined;
        const challengeInitiatedBy: InitiatedBy | undefined = data.initiated_by;

        await deps.challengesRepo.create({
          id: challengeId,
          accountId: data.account_uuid,
          appId,
          factor: 'phone_otp',
          purpose: 'stepup',
          otpHash,
          expiresAt,
          intendedOperation: data.operation_kind,
          operationAudience: data.operation_audience,
          operationRiskTier: data.operation_risk_tier,
          ...(challengeActor ? { actor: challengeActor } : {}),
          ...(challengeInitiatedBy ? { initiatedBy: challengeInitiatedBy } : {}),
        });

        // STEP_UP_REQUIRED → identiti.step_up.events. Todoku consumes and
        // delivers the OTP. v1.0 sends OTP plaintext in the payload (sandbox);
        // production will encrypt with Todoku's per-tenant public key per
        // Reboot Pack §16.8. actor + initiated_by are carried so downstream
        // audit (Helpan AI, KP, Todoku) can join on the same business op.
        await deps.eventProducer.publish({
          topic: 'identiti.step_up.events',
          key: data.account_uuid,
          type: 'STEP_UP_REQUIRED',
          occurredAt: new Date().toISOString(),
          data: {
            account_uuid: data.account_uuid,
            challenge_id: challengeId,
            operation_kind: data.operation_kind,
            operation_risk_tier: data.operation_risk_tier,
            operation_audience: data.operation_audience,
            factor: 'phone_otp',
            otp_plaintext: otp,
            expires_at: expiresAt.toISOString(),
            ...(challengeActor
              ? {
                  actor: {
                    type: challengeActor.type,
                    ...(challengeActor.agentId ? { agent_id: challengeActor.agentId } : {}),
                    ...(challengeActor.delegatedAuthorityJti
                      ? { delegated_authority_jti: challengeActor.delegatedAuthorityJti }
                      : {}),
                  },
                }
              : {}),
            ...(challengeInitiatedBy ? { initiated_by: challengeInitiatedBy } : {}),
          },
        });

        await deps.auditLogger.append({
          appId,
          actorType: 'app',
          actorId: appId,
          action: 'stepup.challenge.create',
          resourceType: 'auth_challenge',
          resourceId: challengeId,
          requestId: rid,
          traceparent: request.traceparent,
          outcome: 'success',
          detail: {
            account_uuid: data.account_uuid,
            operation_kind: data.operation_kind,
            operation_risk_tier: data.operation_risk_tier,
            operation_audience: data.operation_audience,
            ...(challengeActor
              ? {
                  actor_type: challengeActor.type,
                  actor_agent_id: challengeActor.agentId ?? null,
                  delegated_authority_jti: challengeActor.delegatedAuthorityJti ?? null,
                }
              : {}),
            ...(challengeInitiatedBy ? { initiated_by: challengeInitiatedBy } : {}),
          },
        });

        return reply.code(201).send(
          successResponse(
            {
              challenge_id: challengeId,
              factor: 'phone_otp' as const,
              expires_at: expiresAt.toISOString(),
              delivery_status: 'dispatched' as const,
            },
            rid
          )
        );
      }
    );

    fastify.post('/v1/stepup/verify', async (request, reply) => {
      const rid = request.requestId;
      const appId = request.appId!;

      if (!validateVerify(request.body)) {
        return reply.code(400).send(
          errorResponse(
            'validation_request_invalid',
            'Request body does not match schema',
            rid,
            { detail: { errors: validateVerify.errors ?? [] } }
          )
        );
      }
      const data = request.body as VerifyBody;

      const challenge = await deps.challengesRepo.findById(data.challenge_id);
      if (!challenge) {
        return reply.code(401).send(
          errorResponse('auth_factor_failed', 'Challenge is no longer usable', rid, {
            detail: { challenge_id: data.challenge_id, attempts_remaining: 0 },
          })
        );
      }
      // /v1/stepup/verify ONLY consumes purpose='stepup' challenges; a login
      // challenge here is the wrong flow.
      if (challenge.purpose !== 'stepup') {
        return reply.code(401).send(
          errorResponse('auth_factor_failed', 'Wrong challenge purpose for this endpoint', rid, {
            detail: { challenge_id: challenge.id, attempts_remaining: 0 },
          })
        );
      }
      if (challenge.status !== 'pending') {
        return reply.code(401).send(
          errorResponse('auth_factor_failed', `Challenge is ${challenge.status}`, rid, {
            detail: { challenge_id: challenge.id, attempts_remaining: 0 },
          })
        );
      }
      if (challenge.expiresAt.getTime() <= Date.now()) {
        await deps.challengesRepo.recordAttempt(challenge.id, {
          status: 'expired',
          consumedAt: null,
          incrementAttempts: false,
        });
        return reply.code(410).send(
          errorResponse('auth_challenge_expired', 'Challenge has expired', rid, {
            detail: {
              challenge_id: challenge.id,
              expired_at: challenge.expiresAt.toISOString(),
            },
          })
        );
      }
      if (typeof data.response !== 'string') {
        return reply.code(400).send(
          errorResponse(
            'auth_factor_unsupported',
            'Only phone_otp string responses are accepted in this phase',
            rid,
            { field: 'response' }
          )
        );
      }
      if (!challenge.otpHash) {
        return reply
          .code(400)
          .send(errorResponse('auth_factor_unsupported', 'Challenge has no OTP hash', rid));
      }

      const ok = await verifyOtp(data.response, challenge.otpHash);
      if (!ok) {
        const newAttempts = challenge.attemptsUsed + 1;
        const attemptsRemaining = Math.max(0, MAX_OTP_ATTEMPTS - newAttempts);
        if (newAttempts >= MAX_OTP_ATTEMPTS) {
          await deps.challengesRepo.recordAttempt(challenge.id, {
            status: 'failed',
            consumedAt: new Date(),
            incrementAttempts: true,
          });
          await deps.auditLogger.append({
            appId,
            actorType: 'app',
            actorId: appId,
            action: 'stepup.challenge.failed.max_attempts',
            resourceType: 'auth_challenge',
            resourceId: challenge.id,
            requestId: rid,
            traceparent: request.traceparent,
            outcome: 'failure',
            detail: { attempts: newAttempts },
          });
          return reply.code(401).send(
            errorResponse(
              'auth_factor_failed',
              'Too many failed attempts; challenge is now invalid',
              rid,
              { detail: { challenge_id: challenge.id, attempts_remaining: 0 } }
            )
          );
        }
        await deps.challengesRepo.recordAttempt(challenge.id, {
          status: 'pending',
          consumedAt: null,
          incrementAttempts: true,
        });
        return reply.code(401).send(
          errorResponse('auth_factor_failed', 'Invalid OTP', rid, {
            detail: { challenge_id: challenge.id, attempts_remaining: attemptsRemaining },
          })
        );
      }

      // OTP verified — consume challenge, sign step-up token, persist row.
      const accountUuid = challenge.accountId;
      if (!accountUuid) {
        return reply
          .code(500)
          .send(errorResponse('INTERNAL_UNSPECIFIED', 'Challenge missing account binding', rid));
      }
      const operationKind = challenge.intendedOperation;
      const audience = challenge.operationAudience;
      const riskTier = challenge.operationRiskTier;
      if (!operationKind || !audience || !riskTier) {
        // /v1/stepup/challenges populates all three. A null here implies the
        // challenge was created via /v1/auth/challenges with purpose='stepup'
        // — that path is rejected at /v1/auth/customer-token but we cannot
        // mint a step-up token from it either.
        return reply.code(500).send(
          errorResponse(
            'INTERNAL_UNSPECIFIED',
            'Challenge missing step-up binding (intended_operation, operation_audience, operation_risk_tier)',
            rid
          )
        );
      }

      await deps.challengesRepo.recordAttempt(challenge.id, {
        status: 'consumed',
        consumedAt: new Date(),
        incrementAttempts: true,
      });

      const expiresInSeconds = STEPUP_TTL_BY_RISK[riskTier];
      const signed = await deps.jwtSigner.signStepupToken({
        sub: accountUuid,
        jti: challenge.id,
        challengeId: challenge.id,
        audience,
        operationKind,
        operationRiskTier: riskTier,
        factor: challenge.factor,
        env: deps.envName,
        expiresInSeconds,
        // ID-10: forward the actor + initiated_by captured at /v1/stepup/challenges
        // so the issued JWT carries the §A.1/§A.2 claims relying parties audit.
        ...(challenge.actor ? { actor: challenge.actor } : {}),
        ...(challenge.initiatedBy ? { initiatedBy: challenge.initiatedBy } : {}),
      });

      await deps.stepUpTokensRepo.create({
        jti: challenge.id,
        accountUuid,
        challengeId: challenge.id,
        audience,
        operationKind,
        operationRiskTier: riskTier,
        factor: challenge.factor,
        env: deps.envName,
        iat: signed.issuedAt,
        exp: signed.expiresAt,
        ...(challenge.actor ? { actor: challenge.actor } : {}),
        ...(challenge.initiatedBy ? { initiatedBy: challenge.initiatedBy } : {}),
      });

      await deps.auditLogger.append({
        appId,
        actorType: 'app',
        actorId: appId,
        action: 'stepup.token.issued',
        resourceType: 'step_up_token',
        resourceId: challenge.id,
        requestId: rid,
        traceparent: request.traceparent,
        outcome: 'success',
        detail: {
          account_uuid: accountUuid,
          operation_kind: operationKind,
          audience,
        },
      });

      return reply.code(200).send(
        successResponse(
          {
            stepup_token: signed.token,
            expires_in: expiresInSeconds,
          },
          rid
        )
      );
    });
  };
}
