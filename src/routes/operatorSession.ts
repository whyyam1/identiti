/**
 * ID-17 — Operator user identity + WebAuthn registration routes.
 *
 *   POST /v1/operator/users                              — provision operator user
 *   GET  /v1/operator/users/{user_id}                    — read
 *   POST /v1/operator/users/{user_id}/webauthn/options   — mint registration challenge
 *   POST /v1/operator/users/{user_id}/webauthn/register  — verify + store credential
 *
 * Operator step-up itself is the existing /v1/stepup/* surface with
 * `factor=hardware_key` and `operation_kind=operator.<rail>.<action>`.
 * See docs/NEWDOCS_DECISIONS.md Q3 for the sub-surface decision.
 *
 * All four routes are gated by scope `identiti:operator` — only operator
 * HMAC tenants may provision users + enrol credentials.
 */

import type { FastifyPluginAsync } from 'fastify';
import { errorResponse, generateUlid, successResponse } from '@kmv/platform-shared';
import { createAjv } from '../lib/ajv.js';
import {
  createOperatorUserRequestSchema,
  webauthnRegisterRequestSchema,
} from '../schemas/operatorSession.js';
import { requireScope } from '../plugins/scope.js';
import type {
  AuthChallengesRepo,
  OperatorUser,
  OperatorUsersRepo,
  OperatorWebauthnCredential,
  OperatorWebauthnCredentialsRepo,
} from '../repositories/types.js';
import type { AuditLogger } from '../services/auditLogger.js';
import type { WebauthnAdapter } from '../services/webauthnAdapter.js';

const ajv = createAjv();
const validateCreateUser = ajv.compile(createOperatorUserRequestSchema);
const validateRegister = ajv.compile(webauthnRegisterRequestSchema);

const OPERATOR_USER_ID_PATTERN = /^opu_[0-9A-HJKMNP-TV-Z]{26}$/;
/** Server-emitted WebAuthn registration challenge TTL (5 minutes). */
const REGISTRATION_CHALLENGE_TTL_MS = 5 * 60 * 1000;

interface CreateUserBody {
  email: string;
  display_name: string;
}

interface RegisterBody {
  challenge_b64: string;
  credential_id_b64: string;
  attestation_object_b64: string;
  client_data_json_b64: string;
  transports?: readonly ('usb' | 'nfc' | 'ble' | 'internal' | 'hybrid')[];
  display_name?: string;
}

export interface OperatorSessionRouteDeps {
  operatorUsersRepo: OperatorUsersRepo;
  operatorWebauthnCredentialsRepo: OperatorWebauthnCredentialsRepo;
  challengesRepo: AuthChallengesRepo;
  webauthnAdapter: WebauthnAdapter;
  auditLogger: AuditLogger;
  webauthnRpId: string;
  webauthnOrigin: string;
}

function serialiseOperatorUser(u: OperatorUser): Record<string, unknown> {
  return {
    user_id: u.id,
    app_id: u.appId,
    email: u.email,
    display_name: u.displayName,
    status: u.status,
    created_at: u.createdAt.toISOString(),
    ...(u.lastLoginAt ? { last_login_at: u.lastLoginAt.toISOString() } : {}),
  };
}

function serialiseCredential(c: OperatorWebauthnCredential): Record<string, unknown> {
  return {
    credential_id: c.id,
    created_at: c.createdAt.toISOString(),
    attestation_format: c.attestationFormat,
  };
}

export function operatorSessionRoutes(deps: OperatorSessionRouteDeps): FastifyPluginAsync {
  return async (fastify) => {
    // ── POST /v1/operator/users ─────────────────────────────────────────
    fastify.post(
      '/v1/operator/users',
      { preHandler: requireScope('identiti:operator') },
      async (request, reply) => {
        const rid = request.requestId;
        const appId = request.appId!;

        if (!validateCreateUser(request.body)) {
          return reply.code(400).send(
            errorResponse('validation_request_invalid', 'Request body does not match schema', rid, {
              detail: { errors: validateCreateUser.errors ?? [] },
            }),
          );
        }
        const data = request.body as CreateUserBody;
        const userId = `opu_${generateUlid()}`;
        const outcome = await deps.operatorUsersRepo.create({
          id: userId,
          appId,
          email: data.email,
          displayName: data.display_name,
        });
        if (outcome.kind === 'email_collision') {
          return reply.code(409).send(
            errorResponse(
              'operator_user_email_taken',
              `An operator user with email ${data.email} already exists for this tenant`,
              rid,
              { field: 'email' },
            ),
          );
        }
        await deps.auditLogger.append({
          appId,
          actorType: 'app',
          actorId: appId,
          action: 'operator.user.create',
          resourceType: 'operator_user',
          resourceId: outcome.user.id,
          requestId: rid,
          traceparent: request.traceparent,
          outcome: 'success',
          detail: { email: data.email },
        });
        return reply.code(201).send(successResponse(serialiseOperatorUser(outcome.user), rid));
      },
    );

    // ── GET /v1/operator/users/:user_id ─────────────────────────────────
    fastify.get<{ Params: { user_id: string } }>(
      '/v1/operator/users/:user_id',
      { preHandler: requireScope('identiti:operator') },
      async (request, reply) => {
        const rid = request.requestId;
        const { user_id } = request.params;
        if (!OPERATOR_USER_ID_PATTERN.test(user_id)) {
          return reply.code(400).send(
            errorResponse('validation_request_invalid', 'operator user_id is malformed', rid, {
              field: 'user_id',
            }),
          );
        }
        const user = await deps.operatorUsersRepo.findById(user_id);
        if (!user) {
          return reply
            .code(404)
            .send(errorResponse('operator_user_not_found', 'Unknown operator user_id', rid));
        }
        return reply.code(200).send(successResponse(serialiseOperatorUser(user), rid));
      },
    );

    // ── POST /v1/operator/users/:user_id/webauthn/options ───────────────
    // Emits the server registration challenge and persists it on a fresh
    // auth_challenges row with `purpose='operator_webauthn_register'`. The
    // client passes the challenge bytes back at /register time so we can
    // confirm the round-trip and atomically consume the challenge.
    fastify.post<{ Params: { user_id: string } }>(
      '/v1/operator/users/:user_id/webauthn/options',
      { preHandler: requireScope('identiti:operator') },
      async (request, reply) => {
        const rid = request.requestId;
        const appId = request.appId!;
        const { user_id } = request.params;
        if (!OPERATOR_USER_ID_PATTERN.test(user_id)) {
          return reply.code(400).send(
            errorResponse('validation_request_invalid', 'operator user_id is malformed', rid, {
              field: 'user_id',
            }),
          );
        }
        const user = await deps.operatorUsersRepo.findById(user_id);
        if (!user) {
          return reply
            .code(404)
            .send(errorResponse('operator_user_not_found', 'Unknown operator user_id', rid));
        }
        if (user.status !== 'active') {
          return reply.code(409).send(
            errorResponse(
              'operator_user_disabled',
              `Operator user is in state ${user.status}; cannot enrol credentials`,
              rid,
            ),
          );
        }

        const { challengeB64 } = deps.webauthnAdapter.createChallenge();
        const challengeId = `stp_${generateUlid()}`;
        const expiresAt = new Date(Date.now() + REGISTRATION_CHALLENGE_TTL_MS);
        await deps.challengesRepo.create({
          id: challengeId,
          accountId: null,
          appId,
          factor: 'hardware_key',
          purpose: 'operator_webauthn_register',
          otpHash: null,
          expiresAt,
          intendedOperation: null,
          operationAudience: null,
          operationRiskTier: null,
          operatorUserId: user_id,
          factorData: { challenge_b64: challengeB64 },
        });

        await deps.auditLogger.append({
          appId,
          actorType: 'app',
          actorId: appId,
          action: 'operator.webauthn.register.options',
          resourceType: 'operator_user',
          resourceId: user_id,
          requestId: rid,
          traceparent: request.traceparent,
          outcome: 'success',
          detail: { challenge_id: challengeId },
        });

        return reply.code(200).send(
          successResponse(
            {
              challenge_b64: challengeB64,
              rp_id: deps.webauthnRpId,
              origin: deps.webauthnOrigin,
              user: {
                id: user.id,
                name: user.email,
                display_name: user.displayName,
              },
              expires_at: expiresAt.toISOString(),
            },
            rid,
          ),
        );
      },
    );

    // ── POST /v1/operator/users/:user_id/webauthn/register ──────────────
    // Verifies the attestation against the most-recent matching registration
    // challenge for the user, stores the credential, marks the challenge
    // consumed. The client supplies the challenge bytes it received; we
    // look up the row by (operator_user_id, factorData.challenge_b64).
    fastify.post<{ Params: { user_id: string } }>(
      '/v1/operator/users/:user_id/webauthn/register',
      { preHandler: requireScope('identiti:operator') },
      async (request, reply) => {
        const rid = request.requestId;
        const appId = request.appId!;
        const { user_id } = request.params;
        if (!OPERATOR_USER_ID_PATTERN.test(user_id)) {
          return reply.code(400).send(
            errorResponse('validation_request_invalid', 'operator user_id is malformed', rid, {
              field: 'user_id',
            }),
          );
        }
        if (!validateRegister(request.body)) {
          return reply.code(400).send(
            errorResponse('validation_request_invalid', 'Request body does not match schema', rid, {
              detail: { errors: validateRegister.errors ?? [] },
            }),
          );
        }
        const data = request.body as RegisterBody;

        const user = await deps.operatorUsersRepo.findById(user_id);
        if (!user) {
          return reply
            .code(404)
            .send(errorResponse('operator_user_not_found', 'Unknown operator user_id', rid));
        }

        // Refuse re-enrolling the same credential under a different user.
        const existing = await deps.operatorWebauthnCredentialsRepo.findByCredentialId(
          data.credential_id_b64,
        );
        if (existing) {
          return reply.code(409).send(
            errorResponse(
              'webauthn_credential_already_registered',
              'This credential is already registered',
              rid,
              { detail: { user_id: existing.userId } },
            ),
          );
        }

        const verdict = await deps.webauthnAdapter.verifyRegistration({
          userId: user_id,
          attestationResponse: {
            credentialIdB64: data.credential_id_b64,
            attestationObjectB64: data.attestation_object_b64,
            clientDataJsonB64: data.client_data_json_b64,
            ...(data.transports ? { transports: data.transports } : {}),
          },
          serverChallengeB64: data.challenge_b64,
        });

        if (!verdict.ok) {
          await deps.auditLogger.append({
            appId,
            actorType: 'app',
            actorId: appId,
            action: 'operator.webauthn.register.failed',
            resourceType: 'operator_user',
            resourceId: user_id,
            requestId: rid,
            traceparent: request.traceparent,
            outcome: 'failure',
            detail: { reason: verdict.reason },
          });
          return reply
            .code(400)
            .send(errorResponse('webauthn_registration_failed', verdict.reason, rid));
        }

        const credentialRowId = `opc_${generateUlid()}`;
        const credential = await deps.operatorWebauthnCredentialsRepo.create({
          id: credentialRowId,
          userId: user_id,
          credentialIdB64: verdict.outcome.credentialIdB64,
          publicKeyJwk: verdict.outcome.publicKeyJwk,
          attestationFormat: verdict.outcome.attestationFormat,
          ...(verdict.outcome.transports ? { transports: verdict.outcome.transports } : {}),
          ...(data.display_name ? { displayName: data.display_name } : {}),
        });

        await deps.auditLogger.append({
          appId,
          actorType: 'app',
          actorId: appId,
          action: 'operator.webauthn.register.success',
          resourceType: 'operator_webauthn_credential',
          resourceId: credentialRowId,
          requestId: rid,
          traceparent: request.traceparent,
          outcome: 'success',
          detail: {
            user_id,
            attestation_format: verdict.outcome.attestationFormat,
            adapter_mode: deps.webauthnAdapter.mode,
          },
        });

        return reply.code(201).send(successResponse(serialiseCredential(credential), rid));
      },
    );
  };
}
