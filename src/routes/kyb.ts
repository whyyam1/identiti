/**
 * KYB routes — ID-13 (LipaStack §A5.1 / newdocs pack ID-13).
 *
 *   POST /v1/kyb/initiate       — initiate (synchronous in v1.0: stubs
 *                                  settle the verdict inline).
 *   GET  /v1/kyb/{kyb_id}        — fetch record + director links.
 *   POST /v1/kyb/{kyb_id}/retry  — stub: 501 until real BRS/IPRS adapters
 *                                  enable partial retry.
 *
 * Per `docs/NEWDOCS_DECISIONS.md` Q5 (settled): new `/v1/kyb/*` family
 * (NOT a sub-type of `/v1/customers/:uuid/kyc/iprs`). Director KYC reuses
 * the existing per-customer IPRS path (`kyc_records.kind='iprs_lookup'`
 * with `status='verified'`); a missing director-KYC produces state
 * `pending_info` (recoverable by getting the director IPRS, then retry).
 *
 * Events on `identiti.kyb.events` (new topic):
 *   - KYB_VERIFIED   — full verdict, all directors KYC'd + BRS passed
 *   - KYB_REJECTED   — definitive fail (format / signatory missing)
 *   - KYB_PENDING_INFO — recoverable (director IPRS missing)
 */

import type { FastifyPluginAsync } from 'fastify';
import { errorResponse, generateUlid, successResponse } from '@kmv/platform-shared';
import { createAjv } from '../lib/ajv.js';
import { initiateKybRequestSchema } from '../schemas/kyb.js';
import { requireScope } from '../plugins/scope.js';
import type {
  CustomersRepo,
  KybBusinessType,
  KybDirector,
  KybDirectorInsert,
  KybFull,
  KybRecord,
  KybRecordInsert,
  KybRepo,
  KybState,
  KycRecordsRepo,
} from '../repositories/types.js';
import type { AuditLogger } from '../services/auditLogger.js';
import type { EventProducer } from '../services/eventProducer.js';
import type { BrsService } from '../services/brsService.js';
import type { KybHasher } from '../services/kybHash.js';

const ajv = createAjv();
const validateInitiate = ajv.compile(initiateKybRequestSchema);

const KYB_ID_PATTERN = /^kyb_[0-9A-HJKMNP-TV-Z]{26}$/;

interface InitiateBody {
  business_name: string;
  business_registration_number: string;
  kra_pin: string;
  business_type: KybBusinessType;
  country_code?: 'KE';
  directors: Array<{
    account_uuid: string;
    is_signatory: boolean;
    ownership_pct?: number;
  }>;
}

export interface KybRouteDeps {
  customersRepo: CustomersRepo;
  kycRecordsRepo: KycRecordsRepo;
  kybRepo: KybRepo;
  kybHasher: KybHasher;
  brsService: BrsService;
  eventProducer: EventProducer;
  auditLogger: AuditLogger;
}

export function kybRoutes(deps: KybRouteDeps): FastifyPluginAsync {
  return async (fastify) => {
    fastify.post(
      '/v1/kyb/initiate',
      { preHandler: requireScope('identiti:customers:write') },
      async (request, reply) => {
        const rid = request.requestId;
        const appId = request.appId!;

        if (!validateInitiate(request.body)) {
          return reply.code(400).send(
            errorResponse('validation_request_invalid', 'Request body does not match schema', rid, {
              detail: { errors: validateInitiate.errors ?? [] },
            }),
          );
        }
        const data = request.body as InitiateBody;

        // 1. Structural check: at least one signatory.
        if (!data.directors.some((d) => d.is_signatory)) {
          return reply.code(400).send(
            errorResponse(
              'validation_request_invalid',
              'At least one director must be marked is_signatory',
              rid,
              { field: 'directors' },
            ),
          );
        }

        // 2. All director accounts must exist.
        const directorChecks = await Promise.all(
          data.directors.map(async (d) => {
            const account = await deps.customersRepo.findById(d.account_uuid);
            if (!account) return { d, accountExists: false, iprsVerified: false };
            const kycRows = await deps.kycRecordsRepo.listByAccount(d.account_uuid);
            const iprsVerified = kycRows.some(
              (r) => r.kind === 'iprs_lookup' && r.status === 'verified',
            );
            return { d, accountExists: true, iprsVerified };
          }),
        );
        const missingAccount = directorChecks.find((x) => !x.accountExists);
        if (missingAccount) {
          return reply.code(404).send(
            errorResponse(
              'director_account_not_found',
              `No account with UUID ${missingAccount.d.account_uuid}`,
              rid,
              { detail: { director_account_uuid: missingAccount.d.account_uuid } },
            ),
          );
        }
        const directorsMissingKyc = directorChecks
          .filter((x) => !x.iprsVerified)
          .map((x) => x.d.account_uuid);

        // 3. BRS check (stub — format only in v1.0).
        const brsVerdict = await deps.brsService.verify({
          businessRegistrationNumber: data.business_registration_number,
          kraPin: data.kra_pin,
          businessType: data.business_type,
        });

        // 4. State derivation:
        //    - BRS format ok + all directors KYC'd → verified
        //    - BRS format ok + some director missing KYC → pending_info
        //    - BRS format bad → rejected (definitive — fix the data and retry)
        const now = new Date();
        const kybId = `kyb_${generateUlid()}`;
        let state: KybState;
        let rejectionReason: string | undefined;
        let pendingInfoReason: string | undefined;
        if (!brsVerdict.ok) {
          state = 'rejected';
          rejectionReason = brsVerdict.reason;
        } else if (directorsMissingKyc.length > 0) {
          state = 'pending_info';
          pendingInfoReason = `director_iprs_missing:${directorsMissingKyc.join(',')}`;
        } else {
          state = 'verified';
        }

        const recordInput: KybRecordInsert = {
          id: kybId,
          state,
          businessName: data.business_name,
          businessType: data.business_type,
          countryCode: data.country_code ?? 'KE',
          businessRegistrationHash: deps.kybHasher.hashBusinessRegistration(
            data.business_registration_number,
          ),
          kraPinHash: deps.kybHasher.hashKraPin(data.kra_pin),
          submittedByAppId: appId,
          ...(rejectionReason ? { rejectionReason } : {}),
          ...(pendingInfoReason ? { pendingInfoReason } : {}),
          ...(state === 'verified'
            ? { verifiedAt: now }
            : state === 'rejected'
              ? { rejectedAt: now }
              : {}),
        };
        const directorsInput: KybDirectorInsert[] = directorChecks.map((x) => ({
          id: `kybd_${generateUlid()}`,
          kybId,
          directorAccountUuid: x.d.account_uuid,
          isSignatory: x.d.is_signatory,
          ...(x.d.ownership_pct !== undefined ? { ownershipPct: x.d.ownership_pct } : {}),
          kycVerifiedAtSubmit: x.iprsVerified,
        }));

        const insertOutcome = await deps.kybRepo.create(recordInput, directorsInput);

        if (insertOutcome.kind === 'cross_account_collision') {
          await deps.auditLogger.append({
            appId,
            actorType: 'app',
            actorId: appId,
            action: 'kyb.cross_account_collision',
            resourceType: 'kyb_record',
            resourceId: kybId,
            requestId: rid,
            traceparent: request.traceparent,
            outcome: 'failure',
            detail: { conflict: insertOutcome.conflictKind, business_name: data.business_name },
          });
          return reply.code(409).send(
            errorResponse(
              'kyb_cross_account_collision',
              `A different KYB already verified this ${insertOutcome.conflictKind === 'business_registration' ? 'business registration' : 'KRA PIN'}`,
              rid,
              { detail: { conflict_kind: insertOutcome.conflictKind } },
            ),
          );
        }

        // Kafka — new identiti.kyb.events topic per the newdocs pack ID-13.
        const eventType =
          state === 'verified'
            ? 'KYB_VERIFIED'
            : state === 'rejected'
              ? 'KYB_REJECTED'
              : 'KYB_PENDING_INFO';
        await deps.eventProducer.publish({
          topic: 'identiti.kyb.events',
          key: kybId,
          type: eventType,
          occurredAt: now.toISOString(),
          data: {
            kyb_id: kybId,
            business_name: data.business_name,
            business_type: data.business_type,
            state,
            ...(rejectionReason ? { rejection_reason: rejectionReason } : {}),
            ...(pendingInfoReason ? { pending_info_reason: pendingInfoReason } : {}),
            director_account_uuids: data.directors.map((d) => d.account_uuid),
          },
        });

        await deps.auditLogger.append({
          appId,
          actorType: 'app',
          actorId: appId,
          action:
            state === 'verified'
              ? 'kyb.verified'
              : state === 'rejected'
                ? 'kyb.rejected'
                : 'kyb.pending_info',
          resourceType: 'kyb_record',
          resourceId: kybId,
          requestId: rid,
          traceparent: request.traceparent,
          outcome: state === 'verified' ? 'success' : 'failure',
          detail: {
            business_name: data.business_name,
            director_count: data.directors.length,
            ...(rejectionReason ? { rejection_reason: rejectionReason } : {}),
            ...(pendingInfoReason ? { pending_info_reason: pendingInfoReason } : {}),
          },
        });

        return reply.code(201).send(
          successResponse(
            {
              kyb_id: kybId,
              state,
              ...(rejectionReason ? { rejection_reason: rejectionReason } : {}),
              ...(pendingInfoReason ? { pending_info_reason: pendingInfoReason } : {}),
            },
            rid,
          ),
        );
      },
    );

    fastify.get<{ Params: { kyb_id: string } }>(
      '/v1/kyb/:kyb_id',
      { preHandler: requireScope('identiti:customers:read') },
      async (request, reply) => {
        const rid = request.requestId;
        const { kyb_id } = request.params;
        if (!KYB_ID_PATTERN.test(kyb_id)) {
          return reply.code(400).send(
            errorResponse('validation_request_invalid', 'kyb_id is malformed', rid, {
              field: 'kyb_id',
            }),
          );
        }
        const found = await deps.kybRepo.findById(kyb_id);
        if (!found) {
          return reply
            .code(404)
            .send(errorResponse('kyb_record_not_found', 'Unknown kyb_id', rid));
        }
        return reply.code(200).send(successResponse(serialiseKyb(found), rid));
      },
    );

    fastify.post<{ Params: { kyb_id: string } }>(
      '/v1/kyb/:kyb_id/retry',
      { preHandler: requireScope('identiti:customers:write') },
      async (request, reply) => {
        const rid = request.requestId;
        const { kyb_id } = request.params;
        if (!KYB_ID_PATTERN.test(kyb_id)) {
          return reply.code(400).send(
            errorResponse('validation_request_invalid', 'kyb_id is malformed', rid, {
              field: 'kyb_id',
            }),
          );
        }
        const found = await deps.kybRepo.findById(kyb_id);
        if (!found) {
          return reply
            .code(404)
            .send(errorResponse('kyb_record_not_found', 'Unknown kyb_id', rid));
        }
        return reply.code(501).send(
          errorResponse(
            'NOT_IMPLEMENTED',
            'KYB retry is not yet implemented; resubmit via /v1/kyb/initiate after addressing pending_info',
            rid,
          ),
        );
      },
    );
  };
}

function serialiseKyb(full: KybFull): Record<string, unknown> {
  const r = full.record as KybRecord;
  const out: Record<string, unknown> = {
    kyb_id: r.id,
    state: r.state,
    business_name: r.businessName,
    business_type: r.businessType,
    country_code: r.countryCode,
    submitted_at: r.submittedAt.toISOString(),
    directors: full.directors.map(serialiseDirector),
  };
  if (r.rejectionReason) out.rejection_reason = r.rejectionReason;
  if (r.pendingInfoReason) out.pending_info_reason = r.pendingInfoReason;
  if (r.verifiedAt) out.verified_at = r.verifiedAt.toISOString();
  if (r.rejectedAt) out.rejected_at = r.rejectedAt.toISOString();
  if (r.expiresAt) out.expires_at = r.expiresAt.toISOString();
  return out;
}

function serialiseDirector(d: KybDirector): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: d.id,
    account_uuid: d.directorAccountUuid,
    is_signatory: d.isSignatory,
    kyc_verified_at_submit: d.kycVerifiedAtSubmit,
  };
  if (d.ownershipPct !== null) out.ownership_pct = d.ownershipPct;
  return out;
}
