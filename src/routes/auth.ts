/**
 * Customer authentication endpoints — Rail Contract Scaffold §13, Schema
 * Appendix §2.3–§2.6.
 *   POST /v1/auth/challenges      — initiate phone OTP challenge
 *   POST /v1/auth/customer-token  — verify OTP, issue RS256 customer JWT
 *
 * Phase 5 (Sprint 4) reuses the same `auth_challenges` table for step-up
 * challenges and reuses this signer for step-up tokens.
 */

import type { FastifyPluginAsync } from 'fastify';
import { errorResponse, generateUlid, successResponse } from '@kmv/platform-shared';
import { createAjv } from '../lib/ajv.js';
import { createChallengeRequestSchema, customerTokenRequestSchema } from '../schemas/auth.js';
import { normalisePhone } from '../domain/phoneNormalise.js';
import type {
  CustomersRepo,
  AuthChallengesRepo,
  PhoneTokensRepo,
  SessionsRepo,
} from '../repositories/types.js';
import type { PhoneCrypto } from '../services/phoneCrypto.js';
import type { EventProducer } from '../services/eventProducer.js';
import type { AuditLogger } from '../services/auditLogger.js';
import type { JwtSigner } from '../services/jwtSigner.js';
import type { PhoneTokenSigner } from '../services/phoneTokenSigner.js';
import {
  generateOtp,
  hashOtp,
  verifyOtp,
  LOGIN_OTP_TTL_SECONDS,
  STEPUP_OTP_TTL_SECONDS,
  MAX_OTP_ATTEMPTS,
} from '../services/otp.js';
import { requireScope } from '../plugins/scope.js';

const ajv = createAjv();
const validateChallengeRequest = ajv.compile(createChallengeRequestSchema);
const validateTokenRequest = ajv.compile(customerTokenRequestSchema);

const PRIMARY_TOKEN_TTL_SECONDS = 1800; // 30 minutes per Schema Appendix §2.6
/** Schema Appendix Amendment §A.4: elevated scopes get a 5-min TTL (no silent refresh). */
const ELEVATED_TOKEN_TTL_SECONDS = 300;

const CUSTOMER_PRIMARY_SCOPES = [
  'customer:profile_read',
  'customer:tier_request',
  'customer:stepup',
] as const;

/**
 * Scopes that flip a customer token into the §A.4 "elevated" bucket. v1.0 has
 * none reachable through /v1/auth/customer-token (Tier 2 reads + payment-write
 * land in later sprints), so the branch is latent today. The check is wired
 * so dropping a scope into this list immediately switches that scope's tokens
 * to a 5-min TTL.
 */
const ELEVATED_CUSTOMER_SCOPES: readonly string[] = [
  // 'customer:tier_2_evidence_view',
  // 'customer:payment_write',
];

function isElevatedScopeSet(scopes: readonly string[]): boolean {
  for (const s of scopes) {
    if (ELEVATED_CUSTOMER_SCOPES.includes(s)) return true;
  }
  return false;
}

interface ChallengeBody {
  phone: string;
  factor: 'phone_otp' | 'hardware_key' | 'passive_biometric';
  purpose: 'login' | 'stepup' | 'phone_change_to_old' | 'phone_change_to_new';
  app_correlation?: string;
  device?: unknown;
}

interface TokenBody {
  challenge_id: string;
  response: string | object;
  requested_audience: string;
}

export interface AuthRouteDeps {
  customersRepo: CustomersRepo;
  challengesRepo: AuthChallengesRepo;
  sessionsRepo: SessionsRepo;
  phoneTokensRepo: PhoneTokensRepo;
  phoneCrypto: PhoneCrypto;
  eventProducer: EventProducer;
  auditLogger: AuditLogger;
  jwtSigner: JwtSigner;
  phoneTokenSigner: PhoneTokenSigner;
  otpBcryptRounds: number;
  envName: string;
}

export function authRoutes(deps: AuthRouteDeps): FastifyPluginAsync {
  return async (fastify) => {
    fastify.post(
      '/v1/auth/challenges',
      { preHandler: requireScope('identiti:stepup:request') },
      async (request, reply) => {
        const rid = request.requestId;
        const appId = request.appId!;

        if (!validateChallengeRequest(request.body)) {
          return reply
            .code(400)
            .send(
              errorResponse(
                'validation_request_invalid',
                'Request body does not match schema',
                rid,
                { detail: { errors: validateChallengeRequest.errors ?? [] } },
              ),
            );
        }
        const data = request.body as ChallengeBody;

        // Phase 5+ adds hardware_key; Sprint 2 supports phone_otp only.
        if (data.factor !== 'phone_otp') {
          return reply
            .code(400)
            .send(
              errorResponse(
                'auth_factor_unsupported',
                `Factor ${data.factor} is not supported in this phase`,
                rid,
                { field: 'factor' },
              ),
            );
        }

        const normalised = normalisePhone(data.phone);
        if (!normalised) {
          return reply.code(400).send(
            errorResponse(
              'validation_phone_invalid',
              'Phone is not a valid Kenyan E.164 MSISDN',
              rid,
              {
                field: 'phone',
              },
            ),
          );
        }
        const phoneHash = deps.phoneCrypto.hash(normalised);
        const accountLookup = await deps.customersRepo.findByPhoneHash(phoneHash);
        if (!accountLookup) {
          // Don't leak account existence to a misconfigured app (can be hardened
          // in Stage 2 with a fake-challenge response if app-side enumeration
          // becomes a concern).
          return reply
            .code(404)
            .send(errorResponse('customer_not_found', 'No account for that phone', rid));
        }

        const ttlSeconds =
          data.purpose === 'stepup' ? STEPUP_OTP_TTL_SECONDS : LOGIN_OTP_TTL_SECONDS;
        const otp = generateOtp();
        const otpHash = await hashOtp(otp, deps.otpBcryptRounds);
        const challengeId = `stp_${generateUlid()}`;
        const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

        await deps.challengesRepo.create({
          id: challengeId,
          accountId: accountLookup.accountUuid,
          appId,
          factor: 'phone_otp',
          purpose: data.purpose,
          otpHash,
          expiresAt,
          intendedOperation: null,
          // /v1/auth/challenges is for login OTP. Step-up's audience + risk
          // tier come in via /v1/stepup/challenges.
          operationAudience: null,
          operationRiskTier: null,
        });

        // Publish for Todoku to deliver. Production will encrypt the OTP with
        // Todoku's public key per Reboot Pack §16.8 — Sprint 2 plaintext is a
        // dev-stage shortcut.
        await deps.eventProducer.publish({
          topic: 'identiti.step_up.events',
          key: accountLookup.accountUuid,
          type: 'AUTH_CHALLENGE_REQUIRED',
          occurredAt: new Date().toISOString(),
          data: {
            account_uuid: accountLookup.accountUuid,
            challenge_id: challengeId,
            purpose: data.purpose,
            factor: 'phone_otp',
            otp_plaintext: otp,
            expires_at: expiresAt.toISOString(),
          },
        });

        await deps.auditLogger.append({
          appId,
          actorType: 'app',
          actorId: appId,
          action: 'auth.challenge.create',
          resourceType: 'auth_challenge',
          resourceId: challengeId,
          requestId: rid,
          traceparent: request.traceparent,
          outcome: 'success',
          detail: { purpose: data.purpose, account_uuid: accountLookup.accountUuid },
        });

        // Sandbox-only: echo the OTP so integrators can complete
        // /v1/auth/customer-token without a Todoku→SMS bridge. The login OTP
        // otherwise lives only on the AUTH_CHALLENGE_REQUIRED Kafka payload,
        // which is unreachable while no broker is wired — leaving customer
        // login impossible in sandbox (App Integration Guide §21.11.4 GAP-2).
        // Mirrors the /v1/stepup/challenges echo. Production strips both.
        const sandboxOtpEcho =
          deps.envName !== 'production' ? { otp_plaintext: otp, sandbox_only: true as const } : null;

        return reply.code(201).send(
          successResponse(
            {
              challenge_id: challengeId,
              factor: 'phone_otp' as const,
              expires_at: expiresAt.toISOString(),
              delivery_status: 'dispatched' as const,
              ...(sandboxOtpEcho ?? {}),
            },
            rid,
          ),
        );
      },
    );

    fastify.post(
      '/v1/auth/customer-token',
      // No scope: this endpoint completes a challenge and the challenge
      // identifier is the proof of pre-auth. Apps still need a valid HMAC
      // call. Internal apps use a dedicated lower-privilege app credential.
      async (request, reply) => {
        const rid = request.requestId;
        const appId = request.appId!;

        if (!validateTokenRequest(request.body)) {
          return reply
            .code(400)
            .send(
              errorResponse(
                'validation_request_invalid',
                'Request body does not match schema',
                rid,
                { detail: { errors: validateTokenRequest.errors ?? [] } },
              ),
            );
        }
        const data = request.body as TokenBody;

        const challenge = await deps.challengesRepo.findById(data.challenge_id);
        if (!challenge) {
          // Schema Appendix §3.1: there is no `auth_challenge_not_found` code.
          // An unusable challenge surfaces as auth_factor_failed with
          // attempts_remaining=0 — same shape as a wrong-OTP final attempt.
          // Side benefit: doesn't leak challenge_id existence to a probing app.
          return reply.code(401).send(
            errorResponse('auth_factor_failed', 'Challenge is no longer usable', rid, {
              detail: { challenge_id: data.challenge_id, attempts_remaining: 0 },
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
        // /v1/auth/customer-token only consumes login challenges. Step-up
        // challenges (purpose='stepup') must be verified at /v1/stepup/verify
        // to mint the right token shape.
        if (challenge.purpose !== 'login') {
          return reply
            .code(401)
            .send(
              errorResponse(
                'auth_factor_failed',
                `Challenge purpose ${challenge.purpose} is not valid for /auth/customer-token`,
                rid,
                { detail: { challenge_id: challenge.id, attempts_remaining: 0 } },
              ),
            );
        }
        if (challenge.expiresAt.getTime() <= Date.now()) {
          await deps.challengesRepo.recordAttempt(challenge.id, {
            status: 'expired',
            consumedAt: null,
            incrementAttempts: false,
          });
          // Schema Appendix §3.1: auth_challenge_expired is HTTP 410 with
          // { challenge_id, expired_at } body.
          return reply.code(410).send(
            errorResponse('auth_challenge_expired', 'Challenge has expired', rid, {
              detail: {
                challenge_id: challenge.id,
                expired_at: challenge.expiresAt.toISOString(),
              },
            }),
          );
        }
        if (typeof data.response !== 'string') {
          return reply
            .code(400)
            .send(
              errorResponse(
                'auth_factor_unsupported',
                'Only phone_otp string responses are accepted in this phase',
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
              action: 'auth.challenge.failed.max_attempts',
              resourceType: 'auth_challenge',
              resourceId: challenge.id,
              requestId: rid,
              traceparent: request.traceparent,
              outcome: 'failure',
              detail: { attempts: newAttempts },
            });
            // Schema Appendix §3.1: auth_factor_failed is HTTP 401 with
            // { challenge_id, attempts_remaining } body. attempts_remaining=0
            // signals the challenge is locked; customer must start fresh.
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
          return reply.code(401).send(
            errorResponse('auth_factor_failed', 'Invalid OTP', rid, {
              detail: { challenge_id: challenge.id, attempts_remaining: attemptsRemaining },
            }),
          );
        }

        // Success — consume challenge, mint session + JWT.
        const accountUuid = challenge.accountId;
        if (!accountUuid) {
          return reply
            .code(500)
            .send(errorResponse('INTERNAL_UNSPECIFIED', 'Challenge missing account binding', rid));
        }
        await deps.challengesRepo.recordAttempt(challenge.id, {
          status: 'consumed',
          consumedAt: new Date(),
          incrementAttempts: true,
        });

        const tier = await deps.customersRepo.getTier(accountUuid);
        if (!tier) {
          return reply
            .code(404)
            .send(errorResponse('customer_not_found', 'Account no longer exists', rid));
        }

        const sessionId = `ses_${generateUlid()}`;
        const jti = generateUlid();
        // /v1/auth/customer-token is login-only after the purpose guard above;
        // step-up tokens come out of /v1/stepup/verify with their own claim
        // shape per Schema Appendix §16.2.
        const sessionKind = 'primary' as const;
        // §A.4 TTL policy: 30 min for standard scopes, 5 min for elevated.
        const expiresInSeconds = isElevatedScopeSet(CUSTOMER_PRIMARY_SCOPES)
          ? ELEVATED_TOKEN_TTL_SECONDS
          : PRIMARY_TOKEN_TTL_SECONDS;

        // Schema Appendix §2.7: customer-token JWTs carry a `phone_token`
        // claim — an opaque phone token apps pass to Todoku for SMS sends
        // without ever seeing a raw MSISDN.
        const phoneTokenJti = `pht_${generateUlid()}`;
        const phoneTokenSigned = await deps.phoneTokenSigner.sign({
          sub: accountUuid,
          jti: phoneTokenJti,
          audience: 'todoku',
          issuer: 'https://api.id.identiti.co.ke',
        });
        await deps.phoneTokensRepo.create({
          jti: phoneTokenJti,
          accountUuid,
          audience: 'todoku',
          issuedAt: phoneTokenSigned.issuedAt,
          expiresAt: phoneTokenSigned.expiresAt,
        });

        const signed = await deps.jwtSigner.signCustomerToken({
          sub: accountUuid,
          jti,
          audience: ['https://api.id.identiti.co.ke', data.requested_audience],
          scope: CUSTOMER_PRIMARY_SCOPES,
          tier: tier.tier,
          sessionKind,
          sessionId,
          authFactors: ['phone_otp'],
          env: deps.envName,
          expiresInSeconds,
          phoneToken: phoneTokenSigned.token,
        });

        await deps.sessionsRepo.create({
          id: sessionId,
          accountId: accountUuid,
          jti,
          audience: data.requested_audience,
          factorsUsed: ['phone_otp'],
          sessionKind,
          expiresAt: signed.expiresAt,
        });

        await deps.auditLogger.append({
          appId,
          actorType: 'app',
          actorId: appId,
          action: 'auth.customer_token.issued',
          resourceType: 'session',
          resourceId: sessionId,
          requestId: rid,
          traceparent: request.traceparent,
          outcome: 'success',
          detail: {
            account_uuid: accountUuid,
            session_kind: sessionKind,
            audience: data.requested_audience,
          },
        });

        return reply.code(200).send(
          successResponse(
            {
              access_token: signed.token,
              token_type: 'bearer' as const,
              expires_in: expiresInSeconds,
              account_uuid: accountUuid,
              session_id: sessionId,
            },
            rid,
          ),
        );
      },
    );
  };
}
