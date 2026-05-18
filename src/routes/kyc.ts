/**
 * KYC endpoints — Phase 4 (Scaffold §11, Schema Appendix §5).
 *
 *   POST /v1/customers/:uuid/kyc/iprs              IPRS verification (§11.2)
 *   GET  /v1/customers/:uuid/kyc/artefacts         list (§11.6)
 *   GET  /v1/customers/:uuid/kyc/artefacts/:id     read one (§11.7)
 *
 * On verified IPRS, promotes the account tier_0 → tier_1 and publishes
 * KYC_APPROVED + TIER_CHANGED. Tier_1 → tier_2 needs additional artefacts
 * (selfie/address) which depend on KYC vendor selection (Track A) — those
 * routes ship in a later sprint.
 *
 * Document / selfie / address-proof routes (§11.3-§11.5) are deferred per
 * RECAP §2 ID-4 scope (RECAP names only the IPRS path + tier promotion +
 * Kafka events for this sprint).
 */

import type { FastifyPluginAsync } from 'fastify';
import { errorResponse, generateUlid, successResponse } from '@kmv/platform-shared';
import { createAjv } from '../lib/ajv.js';
import { iprsLookupRequestSchema } from '../schemas/kyc.js';
import { isAccountUuid } from '../domain/accountUuid.js';
import type {
  CustomersRepo,
  IprsConfidenceBand,
  IprsMatch,
  KycRecord,
  KycRecordsRepo,
} from '../repositories/types.js';
import type { EventProducer } from '../services/eventProducer.js';
import type { AuditLogger } from '../services/auditLogger.js';
import type { IprsService } from '../services/iprsService.js';
import type { KycHasher } from '../services/kycHash.js';
import { requireScope } from '../plugins/scope.js';

const ajv = createAjv();
const validateIprs = ajv.compile(iprsLookupRequestSchema);

const VERIFICATION_ARTEFACT_ID_PATTERN = /^ver_[0-9A-HJKMNP-TV-Z]{26}$/;

/** IPRS verification expires at 12 months per common KYC re-screening cadence. */
const IPRS_VALIDITY_MS = 365 * 24 * 60 * 60 * 1000;

interface IprsBody {
  national_id: string;
  name_first: string;
  name_last: string;
  date_of_birth: string;
}

export interface KycRouteDeps {
  customersRepo: CustomersRepo;
  kycRecordsRepo: KycRecordsRepo;
  iprsService: IprsService;
  kycHasher: KycHasher;
  eventProducer: EventProducer;
  auditLogger: AuditLogger;
}

function projectArtefact(r: KycRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {
    artefact_id: r.id,
    kind: r.kind,
    state: r.status,
    created_at: r.createdAt.toISOString(),
  };
  if (r.verifiedAt) out.verified_at = r.verifiedAt.toISOString();
  if (r.expiresAt) out.expires_at = r.expiresAt.toISOString();
  if (r.failureReason) out.failure_reason = r.failureReason;
  return out;
}

export function kycRoutes(deps: KycRouteDeps): FastifyPluginAsync {
  return async (fastify) => {
    fastify.post<{ Params: { uuid: string } }>(
      '/v1/customers/:uuid/kyc/iprs',
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
        if (!validateIprs(request.body)) {
          return reply
            .code(400)
            .send(
              errorResponse(
                'validation_request_invalid',
                'Request body does not match schema',
                rid,
                { detail: { errors: validateIprs.errors ?? [] } },
              ),
            );
        }
        const data = request.body as IprsBody;

        const account = await deps.customersRepo.findById(uuid);
        if (!account) {
          return reply
            .code(404)
            .send(errorResponse('customer_not_found', 'No account with that UUID', rid));
        }
        // Already-verified guard — same account submitting IPRS again returns
        // kyc_artefact_already_submitted (Schema Appendix §3.3).
        const existing = await deps.kycRecordsRepo.listByAccount(uuid);
        if (existing.some((r) => r.kind === 'iprs_lookup' && r.status === 'verified')) {
          return reply
            .code(409)
            .send(
              errorResponse(
                'kyc_artefact_already_submitted',
                'IPRS lookup already verified for this account',
                rid,
              ),
            );
        }

        // Cross-account uniqueness on national_id_hash: refuse silently with
        // kyc_iprs_no_match if another account already verified this ID, to
        // avoid leaking which national IDs are on the platform. (No contract
        // code names this case explicitly; we conservatively return no_match.)
        const nationalIdHash = deps.kycHasher.hashNationalId(data.national_id);
        if (await deps.kycRecordsRepo.isNationalIdHashClaimedByOther(nationalIdHash, uuid)) {
          await deps.auditLogger.append({
            appId,
            actorType: 'app',
            actorId: appId,
            action: 'kyc.iprs.rejected.national_id_collision',
            resourceType: 'platform_account',
            resourceId: uuid,
            requestId: rid,
            traceparent: request.traceparent,
            outcome: 'failure',
            detail: { reason: 'national_id_already_verified_for_other_account' },
          });
          return reply.code(422).send(
            errorResponse('kyc_iprs_no_match', 'IPRS lookup did not return a usable match', rid, {
              detail: { lookup_at: new Date().toISOString() },
            }),
          );
        }

        const result = await deps.iprsService.lookup({
          nationalId: data.national_id,
          nameFirst: data.name_first,
          nameLast: data.name_last,
          dateOfBirth: data.date_of_birth,
        });

        if (result.kind === 'upstream_unavailable') {
          // No row written — the request never reached IPRS authoritatively.
          await deps.auditLogger.append({
            appId,
            actorType: 'app',
            actorId: appId,
            action: 'kyc.iprs.upstream_unavailable',
            resourceType: 'platform_account',
            resourceId: uuid,
            requestId: rid,
            traceparent: request.traceparent,
            outcome: 'failure',
            detail: { retry_after_seconds: result.retryAfterSeconds ?? null },
          });
          return reply.code(502).send(
            errorResponse('upstream_iprs_unavailable', 'IPRS upstream unavailable', rid, {
              detail: { retry_after_seconds: result.retryAfterSeconds ?? 30 },
            }),
          );
        }

        const artefactId = `ver_${generateUlid()}`;
        const now = new Date();

        if (result.kind === 'failed') {
          const failureCode =
            result.match === 'no_match' ? 'kyc_iprs_no_match' : 'kyc_iprs_document_mismatch';
          await deps.kycRecordsRepo.create({
            id: artefactId,
            accountId: uuid,
            kind: 'iprs_lookup',
            tier: 'tier_1',
            verificationMethod: 'iprs',
            status: 'failed',
            nationalIdHash,
            iprsVerified: false,
            iprsVerificationRef: result.iprsRef,
            iprsMatch: result.match as IprsMatch,
            iprsConfidenceBand: result.confidenceBand as IprsConfidenceBand,
            failureReason: failureCode,
          });
          await deps.auditLogger.append({
            appId,
            actorType: 'app',
            actorId: appId,
            action: 'kyc.iprs.failed',
            resourceType: 'kyc_record',
            resourceId: artefactId,
            requestId: rid,
            traceparent: request.traceparent,
            outcome: 'failure',
            detail: {
              account_uuid: uuid,
              match: result.match,
              confidence_band: result.confidenceBand,
              failure_code: failureCode,
            },
          });
          return reply.code(422).send(
            errorResponse(
              failureCode,
              failureCode === 'kyc_iprs_no_match'
                ? 'IPRS returned no matching record'
                : 'IPRS record found but submitted name or DOB does not match',
              rid,
              {
                detail:
                  failureCode === 'kyc_iprs_no_match'
                    ? { lookup_at: now.toISOString() }
                    : {
                        mismatch_fields: ['name_first', 'name_last', 'date_of_birth'],
                        lookup_at: now.toISOString(),
                      },
              },
            ),
          );
        }

        // result.kind === 'verified'
        const expiresAt = new Date(now.getTime() + IPRS_VALIDITY_MS);
        const record = await deps.kycRecordsRepo.create({
          id: artefactId,
          accountId: uuid,
          kind: 'iprs_lookup',
          tier: 'tier_1',
          verificationMethod: 'iprs',
          status: 'verified',
          nationalIdHash,
          iprsVerified: true,
          iprsVerificationRef: result.iprsRef,
          iprsMatch: result.match,
          iprsConfidenceBand: result.confidenceBand,
          verifiedAt: now,
          expiresAt,
        });

        // Tier promotion: tier_0 → tier_1 on first verified IPRS lookup.
        let tierPromotedTo: 'tier_1' | undefined;
        if (account.tier === 'tier_0') {
          const tierResult = await deps.customersRepo.setTier(uuid, 'tier_1', 'iprs_verified');
          if (tierResult) {
            tierPromotedTo = 'tier_1';
            await deps.eventProducer.publish({
              topic: 'identiti.account.events',
              key: uuid,
              type: 'TIER_CHANGED',
              occurredAt: tierResult.assignedAt.toISOString(),
              data: {
                account_uuid: uuid,
                from_tier: tierResult.fromTier,
                to_tier: tierResult.toTier,
                reason: tierResult.reason,
              },
            });
          }
        }

        await deps.eventProducer.publish({
          topic: 'identiti.kyc.events',
          key: uuid,
          type: 'KYC_APPROVED',
          occurredAt: now.toISOString(),
          data: {
            account_uuid: uuid,
            artefact_id: artefactId,
            kind: 'iprs_lookup',
            tier: 'tier_1',
            verified_at: now.toISOString(),
            expires_at: expiresAt.toISOString(),
          },
        });

        await deps.auditLogger.append({
          appId,
          actorType: 'app',
          actorId: appId,
          action: 'kyc.iprs.verified',
          resourceType: 'kyc_record',
          resourceId: artefactId,
          requestId: rid,
          traceparent: request.traceparent,
          outcome: 'success',
          detail: {
            account_uuid: uuid,
            match: result.match,
            confidence_band: result.confidenceBand,
            ...(tierPromotedTo ? { tier_promoted_to: tierPromotedTo } : {}),
          },
        });

        const responseData: Record<string, unknown> = {
          artefact_id: artefactId,
          state: record.status,
          iprs_summary: {
            match: result.match,
            confidence_band: result.confidenceBand,
            verified_at: now.toISOString(),
            expires_at: expiresAt.toISOString(),
          },
        };
        if (tierPromotedTo) responseData.tier_promoted_to = tierPromotedTo;

        return reply.code(201).send(successResponse(responseData, rid));
      },
    );

    fastify.get<{ Params: { uuid: string } }>(
      '/v1/customers/:uuid/kyc/artefacts',
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
        const account = await deps.customersRepo.findById(uuid);
        if (!account) {
          return reply
            .code(404)
            .send(errorResponse('customer_not_found', 'No account with that UUID', rid));
        }
        const records = await deps.kycRecordsRepo.listByAccount(uuid);
        return reply.code(200).send(successResponse({ items: records.map(projectArtefact) }, rid));
      },
    );

    fastify.get<{ Params: { uuid: string; id: string } }>(
      '/v1/customers/:uuid/kyc/artefacts/:id',
      { preHandler: requireScope('identiti:customers:read') },
      async (request, reply) => {
        const rid = request.requestId;
        const { uuid, id } = request.params;
        if (!isAccountUuid(uuid)) {
          return reply.code(400).send(
            errorResponse('validation_account_uuid_invalid', 'Account UUID is malformed', rid, {
              field: 'uuid',
            }),
          );
        }
        if (!VERIFICATION_ARTEFACT_ID_PATTERN.test(id)) {
          return reply.code(400).send(
            errorResponse('validation_request_invalid', 'Artefact ID is malformed', rid, {
              field: 'id',
            }),
          );
        }
        const record = await deps.kycRecordsRepo.findById(id);
        if (!record || record.accountId !== uuid) {
          return reply
            .code(404)
            .send(errorResponse('kyc_artefact_not_found', 'No artefact with that ID', rid));
        }
        return reply.code(200).send(successResponse(projectArtefact(record), rid));
      },
    );
  };
}
