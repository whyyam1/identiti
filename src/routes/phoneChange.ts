/**
 * Phone-change endpoints — Phase 7 (Schema Appendix §10.3-§10.4, §17.4 +
 * Instruction Pack §6.3 #19-#20 + Reboot Pack §7 ID-D-08).
 *
 *   POST /v1/customers/:uuid/profile/phone-change            initiate
 *   POST /v1/customers/:uuid/profile/phone-change/confirm    confirm
 *
 * Step-up token in `X-Stepup-Token` header is required at initiate.
 * `operation_kind` must be `identiti.phone_change`. The verifier consumes
 * the JTI single-use per Schema Appendix §16.3 step 12.
 *
 * Two verification methods (per Schema Appendix §10.3):
 *   - `otp_to_old_phone`: the step-up OTP to the OLD phone IS the proof. The
 *     change applies synchronously at initiate; no /confirm call needed.
 *     Response carries `change_state: 'completed'` and the cooldown for the
 *     NEXT phone change.
 *   - `otp_to_new_phone_with_step_up_to_old`: a fresh OTP to the NEW phone is
 *     required. Initiate returns `change_state: 'cooldown_active'` with
 *     `cooldown_until` = expiry of the awaiting-confirmation window. Customer
 *     calls /confirm with the OTP code to complete.
 *
 * Post-completion: `phone_records.cooldown_until` is set to NOW + 24h
 * (DEFAULT_COOLDOWN_MS) — or 7d if the account has an active KP balance
 * (ACTIVE_BALANCE_COOLDOWN_MS). KP isn't built yet, so v1.0 always uses 24h.
 */

import type { FastifyPluginAsync } from 'fastify';
import { errorResponse, generateUlid, successResponse } from '@kmv/platform-shared';
import { createAjv } from '../lib/ajv.js';
import {
  initiatePhoneChangeRequestSchema,
  confirmPhoneChangeRequestSchema,
} from '../schemas/phoneChange.js';
import { isAccountUuid } from '../domain/accountUuid.js';
import { normalisePhone } from '../domain/phoneNormalise.js';
import { computeCooldownUntil, isInCooldown } from '../domain/phoneCooldown.js';
import type { AuthChallengesRepo, CustomersRepo, PhoneChangesRepo } from '../repositories/types.js';
import type { PhoneCrypto } from '../services/phoneCrypto.js';
import type { EventProducer } from '../services/eventProducer.js';
import type { AuditLogger } from '../services/auditLogger.js';
import type { StepupVerifier } from '../services/stepupVerifier.js';
import { generateOtp, hashOtp, verifyOtp, MAX_OTP_ATTEMPTS } from '../services/otp.js';
import { requireScope } from '../plugins/scope.js';

const ajv = createAjv();
const validateInitiate = ajv.compile(initiatePhoneChangeRequestSchema);
const validateConfirm = ajv.compile(confirmPhoneChangeRequestSchema);

const IDENTITI_AUDIENCE = 'https://api.id.identiti.co.ke';
const PHONE_CHANGE_OPERATION_KIND = 'identiti.phone_change';

/** Awaiting-confirmation window for method 2. Long enough for the customer to flip phones. */
const AWAITING_CONFIRMATION_TTL_SECONDS = 10 * 60;

interface InitiateBody {
  new_phone: string;
  verification_method: 'otp_to_old_phone' | 'otp_to_new_phone_with_step_up_to_old';
}
interface ConfirmBody {
  change_id: string;
  otp_response: string;
}

export interface PhoneChangeRouteDeps {
  customersRepo: CustomersRepo;
  challengesRepo: AuthChallengesRepo;
  phoneChangesRepo: PhoneChangesRepo;
  phoneCrypto: PhoneCrypto;
  eventProducer: EventProducer;
  auditLogger: AuditLogger;
  stepupVerifier: StepupVerifier;
  otpBcryptRounds: number;
}

export function phoneChangeRoutes(deps: PhoneChangeRouteDeps): FastifyPluginAsync {
  return async (fastify) => {
    fastify.post<{ Params: { uuid: string } }>(
      '/v1/customers/:uuid/profile/phone-change',
      { preHandler: requireScope('identiti:customers:write') },
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

        const stepupToken = (request.headers['x-stepup-token'] as string | undefined) ?? null;
        if (!stepupToken) {
          return reply.code(401).send(
            errorResponse('auth_factor_required', 'X-Stepup-Token header is required', rid, {
              detail: {
                required_factors: ['phone_otp'],
                satisfied_factors: [],
              },
            }),
          );
        }

        const verification = await deps.stepupVerifier.verify({
          token: stepupToken,
          expectedAudience: IDENTITI_AUDIENCE,
          expectedSubject: uuid,
          expectedOperationKind: PHONE_CHANGE_OPERATION_KIND,
        });
        if (verification.kind === 'expired') {
          return reply.code(401).send(
            errorResponse('stepup_token_expired', 'Step-up token has expired', rid, {
              detail: { expired_at: new Date().toISOString() },
            }),
          );
        }
        if (verification.kind === 'invalid') {
          return reply.code(401).send(
            errorResponse('stepup_token_invalid', 'Step-up token invalid', rid, {
              detail: { reason: verification.reason },
            }),
          );
        }
        const stepupJti = verification.jti;

        const account = await deps.customersRepo.findById(uuid);
        if (!account) {
          return reply
            .code(404)
            .send(errorResponse('customer_not_found', 'No account with that UUID', rid));
        }

        const currentPhone = await deps.customersRepo.getPhoneRecord(uuid);
        if (!currentPhone) {
          return reply
            .code(409)
            .send(
              errorResponse('state_invalid_for_action', 'Account has no bound phone record', rid),
            );
        }
        if (isInCooldown(currentPhone.cooldownUntil, new Date())) {
          return reply.code(422).send(
            errorResponse(
              'phone_change_cooldown_active',
              'A previous phone change is still in cooldown',
              rid,
              {
                detail: {
                  cooldown_until: currentPhone.cooldownUntil!.toISOString(),
                },
              },
            ),
          );
        }

        const normalisedNew = normalisePhone(data.new_phone);
        if (!normalisedNew) {
          return reply.code(400).send(
            errorResponse(
              'validation_phone_invalid',
              'New phone is not a valid Kenyan E.164 MSISDN',
              rid,
              {
                field: 'new_phone',
              },
            ),
          );
        }
        const newHash = deps.phoneCrypto.hash(normalisedNew);
        if (newHash === currentPhone.phoneHash) {
          return reply
            .code(400)
            .send(
              errorResponse(
                'validation_request_invalid',
                'New phone is the same as the current phone',
                rid,
                { field: 'new_phone' },
              ),
            );
        }
        const collision = await deps.customersRepo.findByPhoneHash(newHash);
        if (collision && collision.accountUuid !== uuid) {
          return reply
            .code(400)
            .send(
              errorResponse(
                'validation_phone_already_registered',
                'New phone is already registered to another account',
                rid,
                { detail: { phone_token: '<unavailable_at_v1>' } },
              ),
            );
        }
        const newEncrypted = deps.phoneCrypto.encrypt(normalisedNew);

        // Cancel any prior in-flight phone-change for this account.
        const existing = await deps.phoneChangesRepo.findActiveForAccount(uuid);
        if (existing) {
          await deps.phoneChangesRepo.cancel(existing.id, 'superseded_by_new_initiate', new Date());
        }

        const changeId = `pch_${generateUlid()}`;
        const now = new Date();

        if (data.verification_method === 'otp_to_old_phone') {
          // Method 1: synchronous completion. Step-up to old phone is the proof.
          const cooldownUntil = computeCooldownUntil(now, { hasActiveBalance: false });
          await deps.phoneChangesRepo.create({
            id: changeId,
            accountId: uuid,
            state: 'completed',
            verificationMethod: 'otp_to_old_phone',
            newPhoneHash: newHash,
            newPhoneEncrypted: newEncrypted,
            challengeOldId: null,
            challengeNewId: null,
            authorisingStepupJti: stepupJti,
            expiresAt: cooldownUntil,
          });
          await deps.phoneChangesRepo.complete(changeId, now);
          const swapped = await deps.customersRepo.swapPhone(uuid, {
            newPhoneHash: newHash,
            newPhoneEncrypted: newEncrypted,
            cooldownUntil,
          });
          if (!swapped) {
            // Race / vanished record. Cancel the change and surface 500.
            await deps.phoneChangesRepo.cancel(changeId, 'phone_record_vanished', new Date());
            return reply
              .code(500)
              .send(
                errorResponse('INTERNAL_UNSPECIFIED', 'Phone record vanished during swap', rid),
              );
          }

          await deps.eventProducer.publish({
            topic: 'identiti.phone.events',
            key: uuid,
            type: 'PHONE_CHANGED',
            occurredAt: now.toISOString(),
            data: {
              account_uuid: uuid,
              old_phone_hash: currentPhone.phoneHash,
              new_phone_hash: newHash,
              changed_at: now.toISOString(),
              verification_method: 'otp_to_old_phone',
              authorising_stepup_jti: stepupJti,
            },
          });

          await deps.auditLogger.append({
            appId,
            actorType: 'app',
            actorId: appId,
            action: 'phone_change.completed',
            resourceType: 'phone_change',
            resourceId: changeId,
            requestId: rid,
            traceparent: request.traceparent,
            outcome: 'success',
            detail: {
              account_uuid: uuid,
              verification_method: 'otp_to_old_phone',
              cooldown_until: cooldownUntil.toISOString(),
            },
          });

          return reply.code(201).send(
            successResponse(
              {
                change_id: changeId,
                change_state: 'completed' as const,
                cooldown_until: cooldownUntil.toISOString(),
                delivery_status: 'n/a' as const,
              },
              rid,
            ),
          );
        }

        // Method 2: otp_to_new_phone_with_step_up_to_old — async OTP-to-new flow.
        const otp = generateOtp();
        const otpHash = await hashOtp(otp, deps.otpBcryptRounds);
        const challengeId = `stp_${generateUlid()}`;
        const expiresAt = new Date(now.getTime() + AWAITING_CONFIRMATION_TTL_SECONDS * 1000);
        await deps.challengesRepo.create({
          id: challengeId,
          accountId: uuid,
          appId,
          factor: 'phone_otp',
          purpose: 'phone_change_to_new',
          otpHash,
          expiresAt,
          intendedOperation: PHONE_CHANGE_OPERATION_KIND,
          operationAudience: IDENTITI_AUDIENCE,
          operationRiskTier: 'high',
        });

        await deps.phoneChangesRepo.create({
          id: changeId,
          accountId: uuid,
          state: 'cooldown_active',
          verificationMethod: 'otp_to_new_phone_with_step_up_to_old',
          newPhoneHash: newHash,
          newPhoneEncrypted: newEncrypted,
          challengeOldId: null,
          challengeNewId: challengeId,
          authorisingStepupJti: stepupJti,
          expiresAt,
        });

        // Publish for Todoku to deliver the OTP. v1.0 sends OTP plaintext +
        // target_phone_plaintext in the payload (sandbox); production
        // encrypts both with Todoku's per-tenant public key per Reboot Pack
        // §16.8. Without `target` Todoku would default to the bound phone;
        // for phone-change-to-new we must override.
        await deps.eventProducer.publish({
          topic: 'identiti.step_up.events',
          key: uuid,
          type: 'STEP_UP_REQUIRED',
          occurredAt: now.toISOString(),
          data: {
            account_uuid: uuid,
            challenge_id: challengeId,
            operation_kind: PHONE_CHANGE_OPERATION_KIND,
            operation_risk_tier: 'high',
            operation_audience: IDENTITI_AUDIENCE,
            factor: 'phone_otp',
            otp_plaintext: otp,
            target: {
              kind: 'new_phone',
              phone_plaintext: normalisedNew,
            },
            expires_at: expiresAt.toISOString(),
          },
        });

        await deps.auditLogger.append({
          appId,
          actorType: 'app',
          actorId: appId,
          action: 'phone_change.initiated',
          resourceType: 'phone_change',
          resourceId: changeId,
          requestId: rid,
          traceparent: request.traceparent,
          outcome: 'success',
          detail: {
            account_uuid: uuid,
            verification_method: 'otp_to_new_phone_with_step_up_to_old',
            challenge_id: challengeId,
            authorising_stepup_jti: stepupJti,
          },
        });

        return reply.code(201).send(
          successResponse(
            {
              change_id: changeId,
              change_state: 'cooldown_active' as const,
              cooldown_until: expiresAt.toISOString(),
              expires_at: expiresAt.toISOString(),
              delivery_status: 'dispatched' as const,
            },
            rid,
          ),
        );
      },
    );

    fastify.post<{ Params: { uuid: string } }>(
      '/v1/customers/:uuid/profile/phone-change/confirm',
      { preHandler: requireScope('identiti:customers:write') },
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
        if (!validateConfirm(request.body)) {
          return reply
            .code(400)
            .send(
              errorResponse(
                'validation_request_invalid',
                'Request body does not match schema',
                rid,
                { detail: { errors: validateConfirm.errors ?? [] } },
              ),
            );
        }
        const data = request.body as ConfirmBody;

        const change = await deps.phoneChangesRepo.findById(data.change_id);
        if (!change || change.accountId !== uuid) {
          return reply
            .code(404)
            .send(errorResponse('phone_change_not_found', 'No phone-change with that id', rid));
        }
        if (change.state !== 'cooldown_active') {
          return reply
            .code(409)
            .send(
              errorResponse(
                'state_invalid_for_action',
                `Phone change is in state ${change.state}`,
                rid,
                { detail: { current_state: change.state } },
              ),
            );
        }
        if (change.expiresAt.getTime() <= Date.now()) {
          await deps.phoneChangesRepo.cancel(
            change.id,
            'awaiting_confirmation_expired',
            new Date(),
          );
          return reply.code(410).send(
            errorResponse(
              'auth_challenge_expired',
              'Phone-change confirmation window has expired',
              rid,
              {
                detail: {
                  challenge_id: change.challengeNewId ?? change.id,
                  expired_at: change.expiresAt.toISOString(),
                },
              },
            ),
          );
        }
        if (!change.challengeNewId) {
          return reply
            .code(500)
            .send(
              errorResponse(
                'INTERNAL_UNSPECIFIED',
                'Phone change has no bound challenge (corrupt state)',
                rid,
              ),
            );
        }

        const challenge = await deps.challengesRepo.findById(change.challengeNewId);
        if (!challenge || !challenge.otpHash) {
          await deps.phoneChangesRepo.cancel(change.id, 'challenge_missing', new Date());
          return reply
            .code(500)
            .send(
              errorResponse('INTERNAL_UNSPECIFIED', 'Bound challenge is missing or invalid', rid),
            );
        }
        if (challenge.status !== 'pending') {
          // Can happen if the challenge expired separately or got marked
          // failed by max-attempts. Treat as unusable.
          await deps.phoneChangesRepo.cancel(
            change.id,
            `challenge_${challenge.status}`,
            new Date(),
          );
          return reply.code(401).send(
            errorResponse('auth_factor_failed', 'Challenge no longer usable', rid, {
              detail: { challenge_id: challenge.id, attempts_remaining: 0 },
            }),
          );
        }

        const ok = await verifyOtp(data.otp_response, challenge.otpHash);
        if (!ok) {
          const newAttempts = challenge.attemptsUsed + 1;
          const attemptsRemaining = Math.max(0, MAX_OTP_ATTEMPTS - newAttempts);
          if (newAttempts >= MAX_OTP_ATTEMPTS) {
            await deps.challengesRepo.recordAttempt(challenge.id, {
              status: 'failed',
              consumedAt: new Date(),
              incrementAttempts: true,
            });
            await deps.phoneChangesRepo.cancel(change.id, 'max_otp_attempts', new Date());
            await deps.auditLogger.append({
              appId,
              actorType: 'app',
              actorId: appId,
              action: 'phone_change.cancelled.max_attempts',
              resourceType: 'phone_change',
              resourceId: change.id,
              requestId: rid,
              traceparent: request.traceparent,
              outcome: 'failure',
              detail: { account_uuid: uuid, attempts: newAttempts },
            });
            return reply
              .code(401)
              .send(
                errorResponse(
                  'auth_factor_failed',
                  'Too many failed attempts; phone-change cancelled',
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
          return reply.code(401).send(
            errorResponse('auth_factor_failed', 'Invalid OTP', rid, {
              detail: { challenge_id: challenge.id, attempts_remaining: attemptsRemaining },
            }),
          );
        }

        // OTP verified — consume challenge, swap phone, complete change,
        // publish PHONE_CHANGED.
        await deps.challengesRepo.recordAttempt(challenge.id, {
          status: 'consumed',
          consumedAt: new Date(),
          incrementAttempts: true,
        });

        const now = new Date();
        const cooldownUntil = computeCooldownUntil(now, { hasActiveBalance: false });
        const previousPhone = await deps.customersRepo.getPhoneRecord(uuid);
        const swapped = await deps.customersRepo.swapPhone(uuid, {
          newPhoneHash: change.newPhoneHash,
          newPhoneEncrypted: change.newPhoneEncrypted,
          cooldownUntil,
        });
        if (!swapped) {
          await deps.phoneChangesRepo.cancel(change.id, 'phone_record_vanished', new Date());
          return reply
            .code(500)
            .send(errorResponse('INTERNAL_UNSPECIFIED', 'Phone record vanished during swap', rid));
        }
        await deps.phoneChangesRepo.complete(change.id, now);

        await deps.eventProducer.publish({
          topic: 'identiti.phone.events',
          key: uuid,
          type: 'PHONE_CHANGED',
          occurredAt: now.toISOString(),
          data: {
            account_uuid: uuid,
            old_phone_hash: previousPhone?.phoneHash ?? null,
            new_phone_hash: change.newPhoneHash,
            changed_at: now.toISOString(),
            verification_method: 'otp_to_new_phone_with_step_up_to_old',
            authorising_stepup_jti: change.authorisingStepupJti,
          },
        });

        await deps.auditLogger.append({
          appId,
          actorType: 'app',
          actorId: appId,
          action: 'phone_change.completed',
          resourceType: 'phone_change',
          resourceId: change.id,
          requestId: rid,
          traceparent: request.traceparent,
          outcome: 'success',
          detail: {
            account_uuid: uuid,
            verification_method: 'otp_to_new_phone_with_step_up_to_old',
            cooldown_until: cooldownUntil.toISOString(),
          },
        });

        return reply.code(200).send(
          successResponse(
            {
              change_id: change.id,
              change_state: 'completed' as const,
              cooldown_until: cooldownUntil.toISOString(),
            },
            rid,
          ),
        );
      },
    );
  };
}
