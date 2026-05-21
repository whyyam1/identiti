/**
 * Rider-KYC routes — ID-12, per `NEWDOCS_INSTRUCTION_PACK.md` ID-12 +
 * Itafika §15.
 *
 *   POST /v1/kyc/rider/submit            — initiate (synchronous in v1.0:
 *                                          stubs verify in-process and the
 *                                          submission settles to verified/
 *                                          rejected on response).
 *   GET  /v1/kyc/rider/{submission_id}   — fetch a submission + artefacts.
 *   POST /v1/kyc/rider/{submission_id}/retry — resubmit (route stub for now;
 *                                          full retry semantics land when the
 *                                          stubs are replaced with real NTSA
 *                                          and insurance adapters).
 *
 * Per `docs/NEWDOCS_DECISIONS.md` Q1 (confirmed orthogonal): rider
 * verification sets `platform_accounts.rider_class`; the financial `tier` is
 * NOT touched by rider-KYC.
 *
 * Promotion ladder (rider_class):
 *   - none           — submission not verified
 *   - rider_tier_1   — licence + bike + mpesa probe all verified
 *   - rider_tier_2   — above + insurance also verified (insurance is
 *                      optional in v1.0; absent = rider_tier_1)
 *
 * Atomicity note: the submission row + artefact rows insert in one PG
 * transaction (RiderKycRepo). The subsequent `setRiderClass` on
 * platform_accounts is a separate UPDATE — if the process dies between
 * them, a verified submission exists but `rider_class` is stale. v1.0
 * accepts this; recovery is a re-read + manual setRiderClass. Tightening
 * to a single transaction is a follow-up.
 */

import type { FastifyPluginAsync } from 'fastify';
import { errorResponse, generateUlid, successResponse } from '@kmv/platform-shared';
import { createAjv } from '../lib/ajv.js';
import { submitRiderKycRequestSchema } from '../schemas/riderKyc.js';
import { requireScope } from '../plugins/scope.js';
import type {
  CustomersRepo,
  RiderClass,
  RiderKycArtefact,
  RiderKycArtefactInsert,
  RiderKycRepo,
  RiderKycSubmission,
  RiderKycSubmissionFull,
  RiderKycSubmissionState,
} from '../repositories/types.js';
import type { AuditLogger } from '../services/auditLogger.js';
import type { EventProducer } from '../services/eventProducer.js';
import type { InsuranceService } from '../services/insuranceService.js';
import type { MpesaProbeService } from '../services/mpesaProbeService.js';
import type { NtsaService } from '../services/ntsaService.js';
import type { RiderHasher } from '../services/riderHash.js';

const ajv = createAjv();
const validateSubmit = ajv.compile(submitRiderKycRequestSchema);

const SUBMISSION_ID_PATTERN = /^rks_[0-9A-HJKMNP-TV-Z]{26}$/;

interface SubmitBody {
  account_uuid: string;
  driving_licence: {
    number: string;
    class: string;
    expiry: string; // ISO
    image_ref?: string;
  };
  motorbike_registration: {
    number: string;
    make?: string;
    model?: string;
    image_ref?: string;
  };
  mpesa_msisdn: string;
  insurance?: {
    policy_number: string;
    expiry: string;
    image_ref?: string;
  };
}

export interface RiderKycRouteDeps {
  customersRepo: CustomersRepo;
  riderKycRepo: RiderKycRepo;
  riderHasher: RiderHasher;
  ntsaService: NtsaService;
  mpesaProbeService: MpesaProbeService;
  insuranceService: InsuranceService;
  eventProducer: EventProducer;
  auditLogger: AuditLogger;
}

export function riderKycRoutes(deps: RiderKycRouteDeps): FastifyPluginAsync {
  return async (fastify) => {
    fastify.post(
      '/v1/kyc/rider/submit',
      { preHandler: requireScope('identiti:customers:write') },
      async (request, reply) => {
        const rid = request.requestId;
        const appId = request.appId!;

        if (!validateSubmit(request.body)) {
          return reply.code(400).send(
            errorResponse('validation_request_invalid', 'Request body does not match schema', rid, {
              detail: { errors: validateSubmit.errors ?? [] },
            }),
          );
        }
        const data = request.body as SubmitBody;

        const account = await deps.customersRepo.findById(data.account_uuid);
        if (!account) {
          return reply
            .code(404)
            .send(errorResponse('customer_not_found', 'No account with that UUID', rid));
        }

        const licenceExpiry = new Date(data.driving_licence.expiry);
        const insuranceExpiry = data.insurance ? new Date(data.insurance.expiry) : null;

        // Run the three (or four) verifiers in parallel — stub mode returns
        // immediately. When real adapters land they're remote calls but
        // independent of each other.
        const [licenceVerdict, bikeVerdict, mpesaVerdict, insuranceVerdict] = await Promise.all([
          deps.ntsaService.verifyLicence({
            licenceNumber: data.driving_licence.number,
            licenceClass: data.driving_licence.class,
            licenceExpiry,
          }),
          deps.ntsaService.verifyBikeRegistration({
            registrationNumber: data.motorbike_registration.number,
            ...(data.motorbike_registration.make ? { make: data.motorbike_registration.make } : {}),
            ...(data.motorbike_registration.model
              ? { model: data.motorbike_registration.model }
              : {}),
          }),
          deps.mpesaProbeService.probe(data.mpesa_msisdn),
          data.insurance
            ? deps.insuranceService.verify({
                policyNumber: data.insurance.policy_number,
                expiry: insuranceExpiry!,
              })
            : Promise.resolve({ ok: true as const, vendorRef: null }),
        ]);

        const allVerified =
          licenceVerdict.ok && bikeVerdict.ok && mpesaVerdict.ok && insuranceVerdict.ok;
        const failureReasons = [
          !licenceVerdict.ok ? `licence:${licenceVerdict.reason}` : null,
          !bikeVerdict.ok ? `bike:${bikeVerdict.reason}` : null,
          !mpesaVerdict.ok ? `mpesa:${mpesaVerdict.reason}` : null,
          !insuranceVerdict.ok && data.insurance ? `insurance:${insuranceVerdict.reason}` : null,
        ]
          .filter((s): s is string => s !== null)
          .join(',');

        const now = new Date();
        const submissionId = `rks_${generateUlid()}`;
        const state: RiderKycSubmissionState = allVerified ? 'verified' : 'rejected';
        const riderClass: RiderClass = allVerified
          ? data.insurance && insuranceVerdict.ok
            ? 'rider_tier_2'
            : 'rider_tier_1'
          : 'none';
        const expiresAt = earliestFuture([
          licenceExpiry,
          ...(insuranceExpiry ? [insuranceExpiry] : []),
        ]);

        const artefacts: RiderKycArtefactInsert[] = [
          {
            id: `rka_${generateUlid()}`,
            submissionId,
            accountUuid: data.account_uuid,
            kind: 'rider_driving_licence',
            state: licenceVerdict.ok ? 'verified' : 'rejected',
            licenceNumberHash: deps.riderHasher.hashLicenceNumber(data.driving_licence.number),
            licenceClass: data.driving_licence.class,
            licenceExpiry,
            ...(data.driving_licence.image_ref ? { imageRef: data.driving_licence.image_ref } : {}),
            ...(licenceVerdict.ok
              ? {
                  verifiedAt: now,
                  ...(licenceVerdict.vendorRef ? { vendorRef: licenceVerdict.vendorRef } : {}),
                }
              : { rejectedAt: now, failureReason: licenceVerdict.reason }),
          },
          {
            id: `rka_${generateUlid()}`,
            submissionId,
            accountUuid: data.account_uuid,
            kind: 'rider_motorbike_registration',
            state: bikeVerdict.ok ? 'verified' : 'rejected',
            bikeRegistrationHash: deps.riderHasher.hashBikeRegistration(
              data.motorbike_registration.number,
            ),
            ...(data.motorbike_registration.make
              ? { bikeMake: data.motorbike_registration.make }
              : {}),
            ...(data.motorbike_registration.model
              ? { bikeModel: data.motorbike_registration.model }
              : {}),
            ...(data.motorbike_registration.image_ref
              ? { imageRef: data.motorbike_registration.image_ref }
              : {}),
            ...(bikeVerdict.ok
              ? { verifiedAt: now }
              : { rejectedAt: now, failureReason: bikeVerdict.reason }),
          },
          {
            id: `rka_${generateUlid()}`,
            submissionId,
            accountUuid: data.account_uuid,
            kind: 'rider_mpesa_ownership_probe',
            state: mpesaVerdict.ok ? 'verified' : 'rejected',
            mpesaMsisdnHash: deps.riderHasher.hashMpesaMsisdn(data.mpesa_msisdn),
            ...(mpesaVerdict.ok
              ? { verifiedAt: now }
              : { rejectedAt: now, failureReason: mpesaVerdict.reason }),
          },
        ];
        if (data.insurance) {
          artefacts.push({
            id: `rka_${generateUlid()}`,
            submissionId,
            accountUuid: data.account_uuid,
            kind: 'rider_insurance',
            state: insuranceVerdict.ok ? 'verified' : 'rejected',
            insurancePolicyNumber: data.insurance.policy_number,
            insuranceExpiry: insuranceExpiry!,
            ...(data.insurance.image_ref ? { imageRef: data.insurance.image_ref } : {}),
            ...(insuranceVerdict.ok
              ? { verifiedAt: now }
              : { rejectedAt: now, failureReason: insuranceVerdict.reason }),
          });
        }

        const insertOutcome = await deps.riderKycRepo.create(
          {
            id: submissionId,
            accountUuid: data.account_uuid,
            state,
            riderClass,
            ...(allVerified ? {} : { rejectionReason: failureReasons }),
            ...(state === 'verified' ? { verifiedAt: now } : { rejectedAt: now }),
            ...(expiresAt ? { expiresAt } : {}),
          },
          artefacts,
        );

        if (insertOutcome.kind === 'cross_account_collision') {
          await deps.auditLogger.append({
            appId,
            actorType: 'app',
            actorId: appId,
            action: 'rider_kyc.cross_account_collision',
            resourceType: 'platform_account',
            resourceId: data.account_uuid,
            requestId: rid,
            traceparent: request.traceparent,
            outcome: 'failure',
            detail: { conflict: insertOutcome.conflictKind },
          });
          return reply
            .code(409)
            .send(
              errorResponse(
                'rider_kyc_cross_account_collision',
                `A different account already has a verified ${insertOutcome.conflictKind}`,
                rid,
                { detail: { conflict_kind: insertOutcome.conflictKind } },
              ),
            );
        }

        // Promote rider_class on the account row. Same-tx atomicity is a
        // follow-up (see module header).
        if (state === 'verified' && riderClass !== 'none') {
          await deps.customersRepo.setRiderClass(data.account_uuid, riderClass);
        }

        // Kafka — new event types on the existing identiti.kyc.events topic.
        await deps.eventProducer.publish({
          topic: 'identiti.kyc.events',
          key: data.account_uuid,
          type: state === 'verified' ? 'rider.kyc_verified' : 'rider.kyc_rejected',
          occurredAt: now.toISOString(),
          data: {
            account_uuid: data.account_uuid,
            submission_id: submissionId,
            rider_class: riderClass,
            ...(state === 'rejected' ? { rejection_reason: failureReasons } : {}),
          },
        });

        await deps.auditLogger.append({
          appId,
          actorType: 'app',
          actorId: appId,
          action: state === 'verified' ? 'rider_kyc.verified' : 'rider_kyc.rejected',
          resourceType: 'rider_kyc_submission',
          resourceId: submissionId,
          requestId: rid,
          traceparent: request.traceparent,
          outcome: state === 'verified' ? 'success' : 'failure',
          detail: {
            account_uuid: data.account_uuid,
            rider_class: riderClass,
            ...(state === 'rejected' ? { rejection_reason: failureReasons } : {}),
          },
        });

        return reply.code(201).send(
          successResponse(
            {
              submission_id: submissionId,
              state,
              rider_class: riderClass,
              ...(state === 'rejected' ? { rejection_reason: failureReasons } : {}),
            },
            rid,
          ),
        );
      },
    );

    fastify.get<{ Params: { submission_id: string } }>(
      '/v1/kyc/rider/:submission_id',
      { preHandler: requireScope('identiti:customers:read') },
      async (request, reply) => {
        const rid = request.requestId;
        const { submission_id } = request.params;
        if (!SUBMISSION_ID_PATTERN.test(submission_id)) {
          return reply.code(400).send(
            errorResponse('validation_request_invalid', 'submission_id is malformed', rid, {
              field: 'submission_id',
            }),
          );
        }
        const found = await deps.riderKycRepo.findById(submission_id);
        if (!found) {
          return reply
            .code(404)
            .send(errorResponse('rider_kyc_submission_not_found', 'Unknown submission_id', rid));
        }
        return reply.code(200).send(successResponse(serialiseSubmission(found), rid));
      },
    );

    // Retry: stub for v1.0. Returns 501 until the real retry semantics
    // (re-run only the failed artefacts, keep the rest, update state) land
    // alongside the real NTSA / insurance adapters. The route exists so
    // Itafika integration code can wire to the final URL shape today.
    fastify.post<{ Params: { submission_id: string } }>(
      '/v1/kyc/rider/:submission_id/retry',
      { preHandler: requireScope('identiti:customers:write') },
      async (request, reply) => {
        const rid = request.requestId;
        const { submission_id } = request.params;
        if (!SUBMISSION_ID_PATTERN.test(submission_id)) {
          return reply.code(400).send(
            errorResponse('validation_request_invalid', 'submission_id is malformed', rid, {
              field: 'submission_id',
            }),
          );
        }
        const found = await deps.riderKycRepo.findById(submission_id);
        if (!found) {
          return reply
            .code(404)
            .send(errorResponse('rider_kyc_submission_not_found', 'Unknown submission_id', rid));
        }
        return reply
          .code(501)
          .send(
            errorResponse(
              'NOT_IMPLEMENTED',
              'Rider-KYC retry is not yet implemented; resubmit via /v1/kyc/rider/submit for now',
              rid,
            ),
          );
      },
    );
  };
}

function earliestFuture(dates: readonly Date[]): Date | undefined {
  const future = dates
    .filter((d) => d.getTime() > Date.now())
    .sort((a, b) => a.getTime() - b.getTime());
  return future[0];
}

function serialiseSubmission(full: RiderKycSubmissionFull): Record<string, unknown> {
  const s = full.submission as RiderKycSubmission;
  const out: Record<string, unknown> = {
    submission_id: s.id,
    account_uuid: s.accountUuid,
    state: s.state,
    rider_class: s.riderClass,
    submitted_at: s.submittedAt.toISOString(),
    artefacts: full.artefacts.map(serialiseArtefact),
  };
  if (s.rejectionReason) out.rejection_reason = s.rejectionReason;
  if (s.verifiedAt) out.verified_at = s.verifiedAt.toISOString();
  if (s.rejectedAt) out.rejected_at = s.rejectedAt.toISOString();
  if (s.expiresAt) out.expires_at = s.expiresAt.toISOString();
  return out;
}

function serialiseArtefact(a: RiderKycArtefact): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: a.id,
    kind: a.kind,
    state: a.state,
  };
  if (a.failureReason) out.failure_reason = a.failureReason;
  if (a.licenceClass) out.licence_class = a.licenceClass;
  if (a.licenceExpiry) out.licence_expiry = a.licenceExpiry.toISOString();
  if (a.bikeMake) out.bike_make = a.bikeMake;
  if (a.bikeModel) out.bike_model = a.bikeModel;
  if (a.insurancePolicyNumber) out.insurance_policy_number = a.insurancePolicyNumber;
  if (a.insuranceExpiry) out.insurance_expiry = a.insuranceExpiry.toISOString();
  return out;
}
