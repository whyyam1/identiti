/**
 * Step-up endpoints — Schema Appendix §7, Scaffold §14.
 *   POST /v1/stepup/challenges       — initiate (publishes STEP_UP_REQUIRED)
 *   POST /v1/stepup/verify           — consume challenge, issue RS256 step-up JWT
 *   POST /v1/stepup/tokens/validate  — diagnostic non-consuming validation
 *
 * `/v1/stepup/tokens/validate` (Schema Appendix §7.5/§7.6, Scaffold §14.4) is
 * a diagnostic: it verifies a step-up JWT without consuming the JTI. KP and
 * other relying rails still verify locally against the JWKS per §16.3 — this
 * endpoint is a convenience for callers that prefer a server-side check.
 *
 * Reuses `auth_challenges` with `purpose='stepup'` (table is shared by
 * design; migration 0003 supports this).
 */

import type { FastifyPluginAsync } from 'fastify';
import { errorResponse, generateUlid, successResponse } from '@kmv/platform-shared';
import { createAjv } from '../lib/ajv.js';
import {
  initiateStepupRequestSchema,
  isOperatorOperationKind,
  verifyStepupRequestSchema,
  validateStepupTokenRequestSchema,
  STEPUP_TTL_BY_RISK,
} from '../schemas/stepup.js';
import { isAccountUuid } from '../domain/accountUuid.js';
import type {
  AuthChallengesRepo,
  CustomersRepo,
  InitiatedBy,
  OperatorUsersRepo,
  OperatorWebauthnCredentialsRepo,
  RiskTier,
  StepUpActor,
  StepUpTokensRepo,
} from '../repositories/types.js';
import type { EventProducer } from '../services/eventProducer.js';
import type { AuditLogger } from '../services/auditLogger.js';
import type { JwtSigner } from '../services/jwtSigner.js';
import type { StepupVerifier } from '../services/stepupVerifier.js';
import type { WebauthnAdapter } from '../services/webauthnAdapter.js';
import { generateOtp, hashOtp, verifyOtp, MAX_OTP_ATTEMPTS } from '../services/otp.js';
import { requireScope } from '../plugins/scope.js';

const OPERATOR_USER_ID_PATTERN = /^opu_[0-9A-HJKMNP-TV-Z]{26}$/;

const ajv = createAjv();
const validateInitiate = ajv.compile(initiateStepupRequestSchema);
const validateVerify = ajv.compile(verifyStepupRequestSchema);
const validateValidateToken = ajv.compile(validateStepupTokenRequestSchema);

interface InitiateBody {
  account_uuid?: string;
  /** ID-17: required when operation_kind starts with `operator.`. */
  operator_user_id?: string;
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

/**
 * ID-17 WebAuthn assertion shape sent at /v1/stepup/verify when the
 * challenge factor is `hardware_key`. The four base64url-encoded fields
 * are exactly what the browser emits from
 * `navigator.credentials.get(...).response`.
 */
interface WebauthnAssertionPayload {
  credential_id_b64: string;
  client_data_json_b64: string;
  authenticator_data_b64: string;
  signature_b64: string;
}

interface VerifyBody {
  challenge_id: string;
  response: string | WebauthnAssertionPayload;
  client_device?: unknown;
}

function isWebauthnAssertion(r: unknown): r is WebauthnAssertionPayload {
  if (typeof r !== 'object' || r === null) return false;
  const a = r as Record<string, unknown>;
  return (
    typeof a['credential_id_b64'] === 'string' &&
    typeof a['client_data_json_b64'] === 'string' &&
    typeof a['authenticator_data_b64'] === 'string' &&
    typeof a['signature_b64'] === 'string'
  );
}

interface ValidateTokenBody {
  stepup_token: string;
  expected_audience: string;
  expected_subject: string;
  expected_operation_kind: string;
}

export interface StepupRouteDeps {
  customersRepo: CustomersRepo;
  challengesRepo: AuthChallengesRepo;
  stepUpTokensRepo: StepUpTokensRepo;
  /** ID-17 */
  operatorUsersRepo: OperatorUsersRepo;
  /** ID-17 */
  operatorWebauthnCredentialsRepo: OperatorWebauthnCredentialsRepo;
  /** ID-17 */
  webauthnAdapter: WebauthnAdapter;
  eventProducer: EventProducer;
  auditLogger: AuditLogger;
  jwtSigner: JwtSigner;
  stepupVerifier: StepupVerifier;
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
          return reply
            .code(400)
            .send(
              errorResponse(
                'validation_request_invalid',
                'Request body does not match schema',
                rid,
                { detail: { errors: validateInitiate.errors ?? [] } },
              ),
            );
        }
        const data = request.body as InitiateBody;

        // ID-17: operator.* operation_kinds require operator_user_id;
        // every other operation_kind requires account_uuid. They are
        // mutually exclusive.
        const operatorMode = isOperatorOperationKind(data.operation_kind);
        if (operatorMode) {
          if (!data.operator_user_id) {
            return reply.code(400).send(
              errorResponse(
                'validation_request_invalid',
                'operator_user_id is required when operation_kind is operator.*',
                rid,
                { field: 'operator_user_id' },
              ),
            );
          }
          if (data.account_uuid) {
            return reply.code(400).send(
              errorResponse(
                'validation_request_invalid',
                'account_uuid must not be set for operator.* operation_kind; use operator_user_id',
                rid,
                { field: 'account_uuid' },
              ),
            );
          }
          if (!OPERATOR_USER_ID_PATTERN.test(data.operator_user_id)) {
            return reply.code(400).send(
              errorResponse(
                'validation_request_invalid',
                'operator_user_id is malformed',
                rid,
                { field: 'operator_user_id' },
              ),
            );
          }
        } else {
          if (!data.account_uuid) {
            return reply.code(400).send(
              errorResponse(
                'validation_request_invalid',
                'account_uuid is required for non-operator operation_kind',
                rid,
                { field: 'account_uuid' },
              ),
            );
          }
          if (data.operator_user_id) {
            return reply.code(400).send(
              errorResponse(
                'validation_request_invalid',
                'operator_user_id only applies to operator.* operation_kind',
                rid,
                { field: 'operator_user_id' },
              ),
            );
          }
          if (!isAccountUuid(data.account_uuid)) {
            return reply.code(400).send(
              errorResponse('validation_account_uuid_invalid', 'Account UUID is malformed', rid, {
                field: 'account_uuid',
              }),
            );
          }
        }

        // ID-17: customer step-up still requires phone_otp; operator step-up
        // requires hardware_key. passive_biometric remains adapter-blocked.
        if (operatorMode) {
          if (data.factor !== 'hardware_key') {
            return reply.code(400).send(
              errorResponse(
                'auth_factor_unsupported',
                `Operator step-up requires factor=hardware_key; got ${data.factor}`,
                rid,
                { field: 'factor' },
              ),
            );
          }
        } else if (data.factor !== 'phone_otp') {
          return reply
            .code(400)
            .send(
              errorResponse(
                'auth_factor_unsupported',
                `Factor ${data.factor} is not supported for customer step-up`,
                rid,
                { field: 'factor' },
              ),
            );
        }

        let subjectAccountUuid: string | null = null;
        let subjectOperatorUserId: string | null = null;

        if (operatorMode) {
          const opUser = await deps.operatorUsersRepo.findById(data.operator_user_id!);
          if (!opUser) {
            return reply
              .code(404)
              .send(errorResponse('operator_user_not_found', 'Unknown operator user_id', rid));
          }
          if (opUser.status !== 'active') {
            return reply.code(409).send(
              errorResponse(
                'operator_user_disabled',
                `Operator user is in state ${opUser.status}; cannot step up`,
                rid,
              ),
            );
          }
          // Refuse to issue a hardware_key challenge for a user with no
          // registered credentials — otherwise /verify cannot succeed.
          const creds = await deps.operatorWebauthnCredentialsRepo.listByUser(opUser.id);
          if (creds.length === 0) {
            return reply.code(409).send(
              errorResponse(
                'operator_user_no_credentials',
                'Operator user has no registered WebAuthn credentials; complete /webauthn/register first',
                rid,
              ),
            );
          }
          subjectOperatorUserId = opUser.id;
        } else {
          const account = await deps.customersRepo.findById(data.account_uuid!);
          if (!account) {
            return reply
              .code(404)
              .send(errorResponse('customer_not_found', 'No account with that UUID', rid));
          }
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
                },
              ),
            );
          }
          subjectAccountUuid = account.accountUuid;
        }

        const ttlSeconds = STEPUP_TTL_BY_RISK[data.operation_risk_tier];
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

        // ID-17: factor-specific challenge material.
        //   - phone_otp:    generate OTP, hash to otpHash, dispatch via Todoku.
        //   - hardware_key: mint WebAuthn server challenge, stash on factor_data.
        let otpForDispatch: string | null = null;
        let otpHashForRow: string | null = null;
        let webauthnChallengeB64: string | null = null;
        if (operatorMode) {
          const c = deps.webauthnAdapter.createChallenge();
          webauthnChallengeB64 = c.challengeB64;
        } else {
          otpForDispatch = generateOtp();
          otpHashForRow = await hashOtp(otpForDispatch, deps.otpBcryptRounds);
        }

        await deps.challengesRepo.create({
          id: challengeId,
          accountId: subjectAccountUuid,
          appId,
          factor: data.factor,
          purpose: 'stepup',
          otpHash: otpHashForRow,
          expiresAt,
          intendedOperation: data.operation_kind,
          operationAudience: data.operation_audience,
          operationRiskTier: data.operation_risk_tier,
          ...(challengeActor ? { actor: challengeActor } : {}),
          ...(challengeInitiatedBy ? { initiatedBy: challengeInitiatedBy } : {}),
          operatorUserId: subjectOperatorUserId,
          factorData: webauthnChallengeB64 ? { challenge_b64: webauthnChallengeB64 } : null,
        });

        // STEP_UP_REQUIRED → identiti.step_up.events. Customer step-up
        // carries the OTP plaintext for Todoku to deliver; operator step-up
        // carries the WebAuthn challenge bytes the operator's browser will
        // sign.
        await deps.eventProducer.publish({
          topic: 'identiti.step_up.events',
          key: subjectAccountUuid ?? subjectOperatorUserId!,
          type: 'STEP_UP_REQUIRED',
          occurredAt: new Date().toISOString(),
          data: {
            ...(subjectAccountUuid ? { account_uuid: subjectAccountUuid } : {}),
            ...(subjectOperatorUserId ? { operator_user_id: subjectOperatorUserId } : {}),
            challenge_id: challengeId,
            operation_kind: data.operation_kind,
            operation_risk_tier: data.operation_risk_tier,
            operation_audience: data.operation_audience,
            factor: data.factor,
            ...(otpForDispatch ? { otp_plaintext: otpForDispatch } : {}),
            ...(webauthnChallengeB64
              ? { webauthn_challenge_b64: webauthnChallengeB64 }
              : {}),
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
            ...(subjectAccountUuid ? { account_uuid: subjectAccountUuid } : {}),
            ...(subjectOperatorUserId ? { operator_user_id: subjectOperatorUserId } : {}),
            operation_kind: data.operation_kind,
            operation_risk_tier: data.operation_risk_tier,
            operation_audience: data.operation_audience,
            factor: data.factor,
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

        // Sandbox-only: echo the OTP plaintext in the response so external
        // integrators can complete /v1/stepup/verify without a Todoku→SMS
        // bridge wired. Mirrors the otp_plaintext that already lives on
        // the STEP_UP_REQUIRED Kafka payload in non-prod. Production
        // strips this — the SMS gateway is the only delivery path.
        const sandboxOtpEcho =
          deps.envName !== 'production' && otpForDispatch
            ? { otp_plaintext: otpForDispatch, sandbox_only: true as const }
            : null;

        return reply.code(201).send(
          successResponse(
            {
              challenge_id: challengeId,
              factor: data.factor,
              expires_at: expiresAt.toISOString(),
              delivery_status: 'dispatched' as const,
              ...(webauthnChallengeB64 ? { webauthn_challenge_b64: webauthnChallengeB64 } : {}),
              ...(sandboxOtpEcho ?? {}),
            },
            rid,
          ),
        );
      },
    );

    fastify.post('/v1/stepup/verify', async (request, reply) => {
      const rid = request.requestId;
      const appId = request.appId!;

      if (!validateVerify(request.body)) {
        return reply.code(400).send(
          errorResponse('validation_request_invalid', 'Request body does not match schema', rid, {
            detail: { errors: validateVerify.errors ?? [] },
          }),
        );
      }
      const data = request.body as VerifyBody;

      const challenge = await deps.challengesRepo.findById(data.challenge_id);
      if (!challenge) {
        return reply.code(401).send(
          errorResponse('auth_factor_failed', 'Challenge is no longer usable', rid, {
            detail: { challenge_id: data.challenge_id, attempts_remaining: 0 },
          }),
        );
      }
      // /v1/stepup/verify ONLY consumes purpose='stepup' challenges; a login
      // challenge here is the wrong flow.
      if (challenge.purpose !== 'stepup') {
        return reply.code(401).send(
          errorResponse('auth_factor_failed', 'Wrong challenge purpose for this endpoint', rid, {
            detail: { challenge_id: challenge.id, attempts_remaining: 0 },
          }),
        );
      }
      if (challenge.status !== 'pending') {
        return reply.code(401).send(
          errorResponse('auth_factor_failed', `Challenge is ${challenge.status}`, rid, {
            detail: { challenge_id: challenge.id, attempts_remaining: 0 },
          }),
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
          }),
        );
      }
      // ID-17: branch on challenge.factor. phone_otp consumes a 6-digit
      // string response; hardware_key consumes a WebAuthn assertion object
      // and runs it through the configured adapter.
      let factorVerified = false;
      let factorFailureReason: string | null = null;
      if (challenge.factor === 'hardware_key') {
        if (!isWebauthnAssertion(data.response)) {
          return reply.code(400).send(
            errorResponse(
              'auth_factor_unsupported',
              'hardware_key challenge requires a WebAuthn assertion object response',
              rid,
              { field: 'response' },
            ),
          );
        }
        const challengeBytes =
          challenge.factorData && typeof challenge.factorData['challenge_b64'] === 'string'
            ? (challenge.factorData['challenge_b64'] as string)
            : null;
        if (!challengeBytes) {
          return reply
            .code(500)
            .send(
              errorResponse(
                'INTERNAL_UNSPECIFIED',
                'hardware_key challenge missing server challenge bytes',
                rid,
              ),
            );
        }
        const cred = await deps.operatorWebauthnCredentialsRepo.findByCredentialId(
          data.response.credential_id_b64,
        );
        if (!cred) {
          factorVerified = false;
          factorFailureReason = 'webauthn_credential_unknown';
        } else if (cred.userId !== challenge.operatorUserId) {
          factorVerified = false;
          factorFailureReason = 'webauthn_credential_user_mismatch';
        } else {
          const verdict = await deps.webauthnAdapter.verifyAssertion({
            credentialIdB64: data.response.credential_id_b64,
            clientDataJsonB64: data.response.client_data_json_b64,
            authenticatorDataB64: data.response.authenticator_data_b64,
            signatureB64: data.response.signature_b64,
            serverChallengeB64: challengeBytes,
            storedPublicKeyJwk: cred.publicKeyJwk,
            storedSignatureCounter: cred.signatureCounter,
          });
          if (verdict.ok) {
            factorVerified = true;
            await deps.operatorWebauthnCredentialsRepo.recordUse(
              cred.id,
              verdict.newSignatureCounter,
              new Date(),
            );
          } else {
            factorVerified = false;
            factorFailureReason = verdict.reason;
          }
        }
      } else {
        if (typeof data.response !== 'string') {
          return reply
            .code(400)
            .send(
              errorResponse(
                'auth_factor_unsupported',
                'phone_otp challenge requires a string OTP response',
                rid,
                { field: 'response' },
              ),
            );
        }
        if (!challenge.otpHash) {
          return reply
            .code(400)
            .send(errorResponse('auth_factor_unsupported', 'Challenge has no OTP hash', rid));
        }
        factorVerified = await verifyOtp(data.response, challenge.otpHash);
      }

      if (!factorVerified) {
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
            detail: {
              attempts: newAttempts,
              factor: challenge.factor,
              ...(factorFailureReason ? { reason: factorFailureReason } : {}),
            },
          });
          return reply
            .code(401)
            .send(
              errorResponse(
                'auth_factor_failed',
                'Too many failed attempts; challenge is now invalid',
                rid,
                { detail: { challenge_id: challenge.id, attempts_remaining: 0 } },
              ),
            );
        }
        await deps.challengesRepo.recordAttempt(challenge.id, {
          status: 'pending',
          consumedAt: null,
          incrementAttempts: true,
        });
        const failMessage =
          challenge.factor === 'hardware_key'
            ? `WebAuthn assertion rejected: ${factorFailureReason ?? 'unknown'}`
            : 'Invalid OTP';
        return reply.code(401).send(
          errorResponse('auth_factor_failed', failMessage, rid, {
            detail: { challenge_id: challenge.id, attempts_remaining: attemptsRemaining },
          }),
        );
      }

      // Factor verified — consume challenge, sign step-up token, persist row.
      // ID-17: subject is the customer for non-operator step-ups and the
      // operator-user for operator.* step-ups. Exactly one is set on the
      // challenge row.
      const subject = challenge.accountId ?? challenge.operatorUserId;
      if (!subject) {
        return reply
          .code(500)
          .send(errorResponse('INTERNAL_UNSPECIFIED', 'Challenge missing subject binding', rid));
      }
      const operationKind = challenge.intendedOperation;
      const audience = challenge.operationAudience;
      const riskTier = challenge.operationRiskTier;
      if (!operationKind || !audience || !riskTier) {
        // /v1/stepup/challenges populates all three. A null here implies the
        // challenge was created via /v1/auth/challenges with purpose='stepup'
        // — that path is rejected at /v1/auth/customer-token but we cannot
        // mint a step-up token from it either.
        return reply
          .code(500)
          .send(
            errorResponse(
              'INTERNAL_UNSPECIFIED',
              'Challenge missing step-up binding (intended_operation, operation_audience, operation_risk_tier)',
              rid,
            ),
          );
      }

      await deps.challengesRepo.recordAttempt(challenge.id, {
        status: 'consumed',
        consumedAt: new Date(),
        incrementAttempts: true,
      });

      const expiresInSeconds = STEPUP_TTL_BY_RISK[riskTier];
      const signed = await deps.jwtSigner.signStepupToken({
        sub: subject,
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
        accountUuid: challenge.accountId,
        operatorUserId: challenge.operatorUserId,
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

      if (challenge.operatorUserId) {
        // ID-17: stamp the last-login moment now that the operator has
        // successfully presented hardware_key.
        await deps.operatorUsersRepo.recordLogin(challenge.operatorUserId, new Date());
      }

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
          subject,
          ...(challenge.accountId ? { account_uuid: challenge.accountId } : {}),
          ...(challenge.operatorUserId ? { operator_user_id: challenge.operatorUserId } : {}),
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
          rid,
        ),
      );
    });

    // POST /v1/stepup/tokens/validate — Schema Appendix §7.5/§7.6.
    // Diagnostic: verifies a step-up JWT without consuming its JTI. Always
    // returns 200 — `valid` carries the verdict (an invalid token is not an
    // HTTP error, it's a query result).
    fastify.post(
      '/v1/stepup/tokens/validate',
      { preHandler: requireScope('identiti:stepup:verify') },
      async (request, reply) => {
        const rid = request.requestId;
        const appId = request.appId!;

        if (!validateValidateToken(request.body)) {
          return reply.code(400).send(
            errorResponse('validation_request_invalid', 'Request body does not match schema', rid, {
              detail: { errors: validateValidateToken.errors ?? [] },
            }),
          );
        }
        const data = request.body as ValidateTokenBody;

        const result = await deps.stepupVerifier.inspect({
          token: data.stepup_token,
          expectedAudience: data.expected_audience,
          expectedSubject: data.expected_subject,
          expectedOperationKind: data.expected_operation_kind,
        });

        const body =
          result.kind === 'valid'
            ? { valid: true as const, claims: result.claims }
            : {
                valid: false as const,
                invalid_reason: result.kind === 'expired' ? 'expired' : result.reason,
              };

        await deps.auditLogger.append({
          appId,
          actorType: 'app',
          actorId: appId,
          action: 'stepup.token.validate',
          resourceType: 'step_up_token',
          ...(result.kind === 'valid' ? { resourceId: result.jti } : {}),
          requestId: rid,
          traceparent: request.traceparent,
          outcome: 'success',
          detail: {
            valid: body.valid,
            expected_subject: data.expected_subject,
            expected_operation_kind: data.expected_operation_kind,
            ...(body.valid ? {} : { invalid_reason: body.invalid_reason }),
          },
        });

        return reply.code(200).send(successResponse(body, rid));
      },
    );
  };
}
