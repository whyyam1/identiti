/**
 * Phone-tokens endpoints — Phase 6 (Instruction Pack §6.3 #16-#18 +
 * INTEGRATION_MAP §5.2 / §7.2).
 *
 *   POST /v1/phone-tokens                 — issue (scope: identiti:customers:read)
 *   POST /v1/phone-tokens/resolve         — Todoku-internal (scope: phone_token:resolve)
 *   POST /v1/phone-tokens/{jti}/revoke    — operator (scope: identiti:operator)
 *
 * Phone tokens are opaque HS256 JWTs. Todoku does NOT verify the JWT locally
 * — /resolve is the authoritative path. Plaintext MSISDN never leaves
 * Identiti via any public surface; /resolve returns AES-256-GCM ciphertext
 * of the normalised E.164 phone, which Todoku decrypts in-memory inside its
 * vendor adapter.
 */

import type { FastifyPluginAsync } from 'fastify';
import { errorResponse, generateUlid, successResponse } from '@kmv/platform-shared';
import { createAjv } from '../lib/ajv.js';
import {
  issuePhoneTokenRequestSchema,
  resolvePhoneTokenRequestSchema,
  revokePhoneTokenRequestSchema,
} from '../schemas/phoneTokens.js';
import type {
  CustomersRepo,
  PhoneTokenAudience,
  PhoneTokensRepo,
} from '../repositories/types.js';
import type { AuditLogger } from '../services/auditLogger.js';
import type { PhoneTokenSigner } from '../services/phoneTokenSigner.js';
import { requireScope } from '../plugins/scope.js';

const ajv = createAjv();
const validateIssue = ajv.compile(issuePhoneTokenRequestSchema);
const validateResolve = ajv.compile(resolvePhoneTokenRequestSchema);
const validateRevoke = ajv.compile(revokePhoneTokenRequestSchema);

const PHONE_TOKEN_JTI_PATTERN = /^pht_[0-9A-HJKMNP-TV-Z]{26}$/;
const DEFAULT_AUDIENCE: PhoneTokenAudience = 'todoku';

interface IssueBody {
  account_uuid: string;
  audience?: PhoneTokenAudience;
}
interface ResolveBody {
  phone_token: string;
  expected_audience?: PhoneTokenAudience;
}
interface RevokeBody {
  reason: string;
}

export interface PhoneTokensRouteDeps {
  customersRepo: CustomersRepo;
  phoneTokensRepo: PhoneTokensRepo;
  phoneTokenSigner: PhoneTokenSigner;
  auditLogger: AuditLogger;
}

export function phoneTokensRoutes(
  deps: PhoneTokensRouteDeps
): FastifyPluginAsync {
  return async (fastify) => {
    fastify.post(
      '/v1/phone-tokens',
      { preHandler: requireScope('identiti:customers:read') },
      async (request, reply) => {
        const rid = request.requestId;
        const appId = request.appId!;

        if (!validateIssue(request.body)) {
          return reply.code(400).send(
            errorResponse(
              'validation_request_invalid',
              'Request body does not match schema',
              rid,
              { detail: { errors: validateIssue.errors ?? [] } }
            )
          );
        }
        const data = request.body as IssueBody;
        const audience = data.audience ?? DEFAULT_AUDIENCE;

        const account = await deps.customersRepo.findById(data.account_uuid);
        if (!account) {
          return reply
            .code(404)
            .send(errorResponse('customer_not_found', 'No account with that UUID', rid));
        }

        const signed = await deps.phoneTokenSigner.sign({
          sub: data.account_uuid,
          jti: `pht_${generateUlid()}`,
          audience,
          issuer: 'https://api.id.identiti.co.ke',
        });

        await deps.phoneTokensRepo.create({
          jti: signed.jti,
          accountUuid: data.account_uuid,
          audience,
          issuedAt: signed.issuedAt,
          expiresAt: signed.expiresAt,
        });

        await deps.auditLogger.append({
          appId,
          actorType: 'app',
          actorId: appId,
          action: 'phone_token.issued',
          resourceType: 'phone_token',
          resourceId: signed.jti,
          requestId: rid,
          traceparent: request.traceparent,
          outcome: 'success',
          detail: { account_uuid: data.account_uuid, audience },
        });

        return reply.code(201).send(
          successResponse(
            {
              phone_token: signed.token,
              jti: signed.jti,
              audience,
              expires_at: signed.expiresAt.toISOString(),
            },
            rid
          )
        );
      }
    );

    fastify.post(
      '/v1/phone-tokens/resolve',
      { preHandler: requireScope('phone_token:resolve') },
      async (request, reply) => {
        const rid = request.requestId;
        const appId = request.appId!;

        if (!validateResolve(request.body)) {
          return reply.code(400).send(
            errorResponse(
              'validation_request_invalid',
              'Request body does not match schema',
              rid,
              { detail: { errors: validateResolve.errors ?? [] } }
            )
          );
        }
        const data = request.body as ResolveBody;
        const expected = data.expected_audience ?? DEFAULT_AUDIENCE;

        // Step 1: signature + issuer + audience cryptographic check.
        let payload;
        try {
          payload = await deps.phoneTokenSigner.verify(data.phone_token, expected);
        } catch {
          return reply
            .code(401)
            .send(
              errorResponse(
                'phone_token_invalid',
                'Token signature, issuer, or audience invalid',
                rid
              )
            );
        }

        const jti = payload.jti;
        if (typeof jti !== 'string' || !PHONE_TOKEN_JTI_PATTERN.test(jti)) {
          return reply
            .code(401)
            .send(errorResponse('phone_token_invalid', 'Token jti malformed', rid));
        }

        // Step 2: DB-side lookup is the authoritative trust step (the JWT
        // signature is defence-in-depth). Verify the jti was issued by us,
        // hasn't been revoked, hasn't expired, and matches the requested
        // audience.
        const record = await deps.phoneTokensRepo.findByJti(jti);
        if (!record) {
          return reply
            .code(401)
            .send(errorResponse('phone_token_invalid', 'Unknown jti', rid));
        }
        if (record.audience !== expected) {
          return reply
            .code(401)
            .send(
              errorResponse(
                'phone_token_audience_mismatch',
                `Token issued for audience ${record.audience}, not ${expected}`,
                rid
              )
            );
        }
        if (record.revoked) {
          return reply
            .code(401)
            .send(errorResponse('phone_token_revoked', 'Token has been revoked', rid));
        }
        if (record.expiresAt.getTime() <= Date.now()) {
          return reply
            .code(401)
            .send(errorResponse('phone_token_expired', 'Token has expired', rid));
        }

        // Step 3: fetch the encrypted phone for the bound account.
        const phone = await deps.customersRepo.findEncryptedPhoneFor(record.accountUuid);
        if (!phone) {
          // Race: account or phone_records row deleted between issuance and
          // resolve. Treat as invalid.
          return reply
            .code(404)
            .send(
              errorResponse(
                'phone_record_not_found',
                'No phone record for the bound account',
                rid
              )
            );
        }

        await deps.auditLogger.append({
          appId,
          actorType: 'app',
          actorId: appId,
          action: 'phone_token.resolved',
          resourceType: 'phone_token',
          resourceId: jti,
          requestId: rid,
          traceparent: request.traceparent,
          outcome: 'success',
          detail: { account_uuid: record.accountUuid, audience: record.audience },
        });

        return reply.code(200).send(
          successResponse(
            {
              account_uuid: record.accountUuid,
              phone_encrypted: phone,
              encrypted_format: 'aes-256-gcm-v1' as const,
            },
            rid
          )
        );
      }
    );

    fastify.post<{ Params: { jti: string } }>(
      '/v1/phone-tokens/:jti/revoke',
      { preHandler: requireScope('identiti:operator') },
      async (request, reply) => {
        const rid = request.requestId;
        const appId = request.appId!;
        const { jti } = request.params;

        if (!PHONE_TOKEN_JTI_PATTERN.test(jti)) {
          return reply.code(400).send(
            errorResponse('validation_request_invalid', 'Token jti is malformed', rid, {
              field: 'jti',
            })
          );
        }
        if (!validateRevoke(request.body)) {
          return reply.code(400).send(
            errorResponse(
              'validation_request_invalid',
              'Request body does not match schema',
              rid,
              { detail: { errors: validateRevoke.errors ?? [] } }
            )
          );
        }
        const data = request.body as RevokeBody;

        const updated = await deps.phoneTokensRepo.revoke(jti, appId, data.reason);
        if (!updated) {
          // Either jti unknown or already revoked.
          const existing = await deps.phoneTokensRepo.findByJti(jti);
          if (!existing) {
            return reply
              .code(404)
              .send(errorResponse('phone_token_not_found', 'Unknown jti', rid));
          }
          // Already revoked → idempotent success.
          return reply.code(200).send(
            successResponse(
              {
                jti: existing.jti,
                revoked_at: existing.revokedAt!.toISOString(),
                reason: existing.revokeReason ?? data.reason,
              },
              rid
            )
          );
        }

        await deps.auditLogger.append({
          appId,
          actorType: 'operator',
          actorId: appId,
          action: 'phone_token.revoked',
          resourceType: 'phone_token',
          resourceId: jti,
          requestId: rid,
          traceparent: request.traceparent,
          outcome: 'success',
          detail: { reason: data.reason, account_uuid: updated.accountUuid },
        });

        return reply.code(200).send(
          successResponse(
            {
              jti: updated.jti,
              revoked_at: updated.revokedAt!.toISOString(),
              reason: data.reason,
            },
            rid
          )
        );
      }
    );
  };
}
