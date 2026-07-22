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
import { createCustomerRequestSchema } from '../schemas/customers.js';
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
                { detail: { errors: validateCreateBody.errors ?? [] } },
              ),
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
                { field: 'consent' },
              ),
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
                { field: 'phone' },
              ),
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
                { field: 'phone' },
              ),
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
            rid,
          ),
        );
      },
    );

    fastify.get<{ Params: { uuid: string } }>(
      '/v1/customers/:uuid',
      { preHandler: requireScope('identiti:customers:read') },
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
      },
    );

    /**
     * Self-serve activation — App Integration Guide §21.11.4 GAP-1.
     *
     * Until this existed, nothing in the rail could move an app-created
     * account out of `pending_onboarding`: the IPRS path promotes only the
     * *tier* (`setTier` never writes `status`), and operator `reactivate`
     * accepts only `frozen_aml`. Step-up requires `active`, so every
     * payment/payout authorisation was unreachable for a consuming app's real
     * customers — the app could create users it could never transact for.
     *
     * Scoped to `identiti:customers:write` — the same scope that created the
     * account. The consuming app has already proven phone ownership through
     * its own onboarding OTP, and Identiti still gates every sensitive
     * operation behind step-up + tier, so activation alone confers no new
     * authority. Only `pending_onboarding → active`; AML/KYC freezes are NOT
     * liftable here (that stays operator-only via `/v1/operator/.../reactivate`).
     *
     * Idempotent: an already-active account returns 200, not an error.
     */
    fastify.post<{ Params: { uuid: string } }>(
      '/v1/customers/:uuid/activate',
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

        const result = await deps.customersRepo.changeState(uuid, ['pending_onboarding'], 'active');

        if (!result) {
          const existing = await deps.customersRepo.findById(uuid);
          if (!existing) {
            return reply
              .code(404)
              .send(errorResponse('customer_not_found', 'No account with that UUID', rid));
          }
          // Already active → idempotent success, so a retry is never an error.
          if (existing.state === 'active') {
            return reply.code(200).send(
              successResponse(
                {
                  account_uuid: uuid,
                  state: existing.state,
                  already_active: true,
                },
                rid,
              ),
            );
          }
          // frozen_kyc / frozen_aml / closed_* are deliberately not liftable here.
          return reply.code(409).send(
            errorResponse(
              'state_invalid_for_action',
              `Cannot activate an account in state ${existing.state}`,
              rid,
              {
                detail: {
                  current_state: existing.state,
                  allowed_from_states: ['pending_onboarding'],
                },
              },
            ),
          );
        }

        const occurredAt = new Date().toISOString();
        await deps.eventProducer.publish({
          topic: 'identiti.account.events',
          key: uuid,
          type: 'ACCOUNT_ACTIVATED',
          occurredAt,
          data: {
            account_uuid: uuid,
            from_state: result.fromState,
            to_state: result.toState,
            activated_by_app_id: appId,
          },
        });

        await deps.auditLogger.append({
          appId,
          actorType: 'app',
          actorId: appId,
          action: 'customer.activate',
          resourceType: 'platform_account',
          resourceId: uuid,
          requestId: rid,
          traceparent: request.traceparent,
          outcome: 'success',
          detail: { from_state: result.fromState, to_state: result.toState },
        });

        return reply.code(200).send(
          successResponse(
            {
              account_uuid: uuid,
              state: result.toState,
              previous_state: result.fromState,
              activated_at: occurredAt,
            },
            rid,
          ),
        );
      },
    );
  };
}
