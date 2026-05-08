/**
 * Customer (account) endpoint family — Rail Contract Scaffold §10, Schema Appendix §4.
 *   POST /v1/customers       — create platform account; issue Account UUID
 *   GET  /v1/customers/{uuid} — read account state, tier, KYC progress
 *
 * Side effects on successful create:
 *   - phone_records row inserted (PBKDF2 hash + AES-256-GCM ciphertext)
 *   - identiti.account.events / ACCOUNT_CREATED published
 *   - audit_log entry appended
 */

import type { FastifyPluginAsync } from 'fastify';
import { errorResponse, generateUlid, successResponse } from '@kmv/platform-shared';
import { createAjv } from '../lib/ajv.js';
import {
  createCustomerRequestSchema,
} from '../schemas/customers.js';
import { generateAccountUuid, isAccountUuid } from '../domain/accountUuid.js';
import { normalisePhone } from '../domain/phoneNormalise.js';
import type { CustomersRepo } from '../repositories/types.js';
import type { PhoneCrypto } from '../services/phoneCrypto.js';
import type { EventProducer } from '../services/eventProducer.js';
import type { AuditLogger } from '../services/auditLogger.js';
import { requireScope } from '../plugins/scope.js';

const ajv = createAjv();
const validateCreateBody = ajv.compile(createCustomerRequestSchema);

interface ConsentInput {
  dpa_consent: boolean;
  kyc_consent: boolean;
  marketing_consent?: boolean;
  captured_at: string;
  captured_via?: 'app_onboarding' | 'operator_console' | 'self_service_portal';
}

interface CreateBody {
  phone: string;
  name_first: string;
  name_last: string;
  name_middle?: string;
  preferred_name?: string;
  email?: string;
  consent: ConsentInput;
  app_correlation: string;
  device?: unknown;
}

export interface CustomersRouteDeps {
  customersRepo: CustomersRepo;
  phoneCrypto: PhoneCrypto;
  eventProducer: EventProducer;
  auditLogger: AuditLogger;
}

export function customersRoutes(deps: CustomersRouteDeps): FastifyPluginAsync {
  return async (fastify) => {
    fastify.post(
      '/v1/customers',
      { preHandler: requireScope('identiti:customers:write') },
      async (request, reply) => {
        const rid = request.requestId;
        const appId = request.appId!;

        if (!validateCreateBody(request.body)) {
          return reply
            .code(400)
            .send(
              errorResponse(
                'validation_request_invalid',
                'Request body does not match schema',
                rid,
                { detail: { errors: validateCreateBody.errors ?? [] } }
              )
            );
        }
        const data = request.body as CreateBody;

        if (data.consent.dpa_consent !== true || data.consent.kyc_consent !== true) {
          return reply
            .code(400)
            .send(
              errorResponse(
                'validation_consent_missing',
                'Both dpa_consent and kyc_consent must be true',
                rid,
                { field: 'consent' }
              )
            );
        }

        const normalisedPhone = normalisePhone(data.phone);
        if (!normalisedPhone) {
          return reply
            .code(400)
            .send(
              errorResponse(
                'validation_phone_invalid',
                'Phone is not a valid Kenyan E.164 MSISDN',
                rid,
                { field: 'phone' }
              )
            );
        }

        const phoneHash = deps.phoneCrypto.hash(normalisedPhone);
        const phoneEncrypted = deps.phoneCrypto.encrypt(normalisedPhone);
        const accountUuid = generateAccountUuid();
        const phoneRecordId = generateUlid();
        const consentAt = new Date(data.consent.captured_at);

        const result = await deps.customersRepo.create({
          accountUuid,
          nameFirst: data.name_first,
          nameLast: data.name_last,
          nameMiddle: data.name_middle ?? null,
          preferredName: data.preferred_name ?? null,
          email: data.email ?? null,
          appCorrelation: data.app_correlation,
          originAppId: appId,
          dpaConsentAt: consentAt,
          kycConsentAt: consentAt,
          marketingConsent: data.consent.marketing_consent ?? false,
          consentCapturedVia: data.consent.captured_via ?? 'app_onboarding',
          phoneRecordId,
          phoneHash,
          phoneEncrypted,
        });

        if (result.kind === 'phone_collision') {
          await deps.auditLogger.append({
            appId,
            actorType: 'app',
            actorId: appId,
            action: 'customer.create.rejected.phone_collision',
            resourceType: 'platform_account',
            requestId: rid,
            traceparent: request.traceparent,
            outcome: 'failure',
            detail: { app_correlation: data.app_correlation },
          });
          return reply
            .code(400)
            .send(
              errorResponse(
                'validation_phone_already_registered',
                'Phone is already registered to another account',
                rid,
                { field: 'phone' }
              )
            );
        }

        const occurredAt = new Date().toISOString();
        await deps.eventProducer.publish({
          topic: 'identiti.account.events',
          key: result.outcome.accountUuid,
          type: 'ACCOUNT_CREATED',
          occurredAt,
          data: {
            account_uuid: result.outcome.accountUuid,
            origin_app_id: appId,
            initial_state: result.outcome.state,
            initial_tier: result.outcome.tier,
          },
        });

        await deps.auditLogger.append({
          appId,
          actorType: 'app',
          actorId: appId,
          action: 'customer.create',
          resourceType: 'platform_account',
          resourceId: result.outcome.accountUuid,
          requestId: rid,
          traceparent: request.traceparent,
          outcome: 'success',
          detail: { app_correlation: data.app_correlation },
        });

        return reply.code(201).send(
          successResponse(
            {
              account_uuid: result.outcome.accountUuid,
              state: result.outcome.state,
              tier: result.outcome.tier,
              created_at: result.outcome.createdAt.toISOString(),
            },
            rid
          )
        );
      }
    );

    fastify.get<{ Params: { uuid: string } }>(
      '/v1/customers/:uuid',
      { preHandler: requireScope('identiti:customers:read') },
      async (request, reply) => {
        const rid = request.requestId;
        const { uuid } = request.params;
        if (!isAccountUuid(uuid)) {
          return reply
            .code(400)
            .send(
              errorResponse(
                'validation_account_uuid_invalid',
                'Account UUID is malformed',
                rid,
                { field: 'uuid' }
              )
            );
        }

        const row = await deps.customersRepo.findById(uuid);
        if (!row) {
          return reply
            .code(404)
            .send(errorResponse('customer_not_found', 'No account with that UUID', rid));
        }

        // KYC progress is Phase 4; Sprint 1 reports tier-derived defaults.
        const responseData: Record<string, unknown> = {
          account_uuid: row.accountUuid,
          state: row.state,
          tier: row.tier,
          kyc_completion: {
            tier_1_progress_pct: row.tier === 'tier_0' ? 0 : 100,
            tier_2_progress_pct: row.tier === 'tier_2' ? 100 : 0,
          },
          created_at: row.createdAt.toISOString(),
        };
        if (row.tierAssignedAt) {
          responseData.tier_assigned_at = row.tierAssignedAt.toISOString();
        }
        if (row.lastActiveAt) {
          responseData.last_active_at = row.lastActiveAt.toISOString();
        }

        return reply.code(200).send(successResponse(responseData, rid));
      }
    );
  };
}
