/**
 * Postgres-backed RiderKycRepo.
 *
 * The cross-account uniqueness invariants live in migration 0010 as
 * partial UNIQUE INDEX. We translate the resulting `23505` unique-violation
 * codes back into a typed `cross_account_collision` outcome so callers
 * don't have to know about PG error codes.
 */

import { desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { riderKycArtefacts, riderKycSubmissions } from '../db/schema.js';
import type {
  RiderClass,
  RiderKycArtefact,
  RiderKycArtefactKind,
  RiderKycArtefactState,
  RiderKycRepo,
  RiderKycSubmission,
  RiderKycSubmissionFull,
  RiderKycSubmissionState,
} from './types.js';

interface PgError {
  code?: string;
  constraint_name?: string;
}

function isUniqueViolation(err: unknown): err is PgError {
  return typeof err === 'object' && err !== null && (err as PgError).code === '23505';
}

export function createPgRiderKycRepo(db: Db): RiderKycRepo {
  return {
    async create(submissionInput, artefactInputs) {
      try {
        await db.transaction(async (tx) => {
          await tx.insert(riderKycSubmissions).values({
            id: submissionInput.id,
            accountUuid: submissionInput.accountUuid,
            state: submissionInput.state,
            riderClass: submissionInput.riderClass,
            rejectionReason: submissionInput.rejectionReason ?? null,
            verifiedAt: submissionInput.verifiedAt ?? null,
            rejectedAt: submissionInput.rejectedAt ?? null,
            expiresAt: submissionInput.expiresAt ?? null,
          });
          for (const a of artefactInputs) {
            await tx.insert(riderKycArtefacts).values({
              id: a.id,
              submissionId: a.submissionId,
              accountUuid: a.accountUuid,
              kind: a.kind,
              state: a.state,
              licenceNumberHash: a.licenceNumberHash ?? null,
              bikeRegistrationHash: a.bikeRegistrationHash ?? null,
              mpesaMsisdnHash: a.mpesaMsisdnHash ?? null,
              imageRef: a.imageRef ?? null,
              licenceClass: a.licenceClass ?? null,
              licenceExpiry: a.licenceExpiry ?? null,
              bikeMake: a.bikeMake ?? null,
              bikeModel: a.bikeModel ?? null,
              insurancePolicyNumber: a.insurancePolicyNumber ?? null,
              insuranceExpiry: a.insuranceExpiry ?? null,
              vendorRef: a.vendorRef ?? null,
              failureReason: a.failureReason ?? null,
              verifiedAt: a.verifiedAt ?? null,
              rejectedAt: a.rejectedAt ?? null,
            });
          }
        });
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          const cn = err.constraint_name ?? '';
          if (cn.includes('licence_uniq')) {
            return { kind: 'cross_account_collision', conflictKind: 'driving_licence' };
          }
          if (cn.includes('bike_uniq')) {
            return { kind: 'cross_account_collision', conflictKind: 'bike_registration' };
          }
        }
        throw err;
      }

      const created = await this.findById(submissionInput.id);
      if (!created)
        throw new Error(`rider_kyc_submissions ${submissionInput.id} not visible after insert`);
      return { kind: 'created', submission: created.submission };
    },

    async findById(id) {
      const subRows = await db
        .select()
        .from(riderKycSubmissions)
        .where(eq(riderKycSubmissions.id, id))
        .limit(1);
      const s = subRows[0];
      if (!s) return null;
      const artRows = await db
        .select()
        .from(riderKycArtefacts)
        .where(eq(riderKycArtefacts.submissionId, id))
        .orderBy(riderKycArtefacts.createdAt);
      const submission: RiderKycSubmission = {
        id: s.id,
        accountUuid: s.accountUuid,
        state: s.state as RiderKycSubmissionState,
        riderClass: s.riderClass as RiderClass,
        rejectionReason: s.rejectionReason,
        submittedAt: s.submittedAt,
        verifiedAt: s.verifiedAt,
        rejectedAt: s.rejectedAt,
        expiresAt: s.expiresAt,
        createdAt: s.createdAt,
      };
      const artefacts: RiderKycArtefact[] = artRows.map((r) => ({
        id: r.id,
        submissionId: r.submissionId,
        accountUuid: r.accountUuid,
        kind: r.kind as RiderKycArtefactKind,
        state: r.state as RiderKycArtefactState,
        licenceNumberHash: r.licenceNumberHash,
        bikeRegistrationHash: r.bikeRegistrationHash,
        mpesaMsisdnHash: r.mpesaMsisdnHash,
        imageRef: r.imageRef,
        licenceClass: r.licenceClass,
        licenceExpiry: r.licenceExpiry,
        bikeMake: r.bikeMake,
        bikeModel: r.bikeModel,
        insurancePolicyNumber: r.insurancePolicyNumber,
        insuranceExpiry: r.insuranceExpiry,
        vendorRef: r.vendorRef,
        failureReason: r.failureReason,
        verifiedAt: r.verifiedAt,
        rejectedAt: r.rejectedAt,
        createdAt: r.createdAt,
      }));
      return { submission, artefacts } satisfies RiderKycSubmissionFull;
    },

    async listByAccount(accountUuid, limit = 50) {
      const clamped = Math.max(1, Math.min(200, limit));
      const rows = await db
        .select()
        .from(riderKycSubmissions)
        .where(eq(riderKycSubmissions.accountUuid, accountUuid))
        .orderBy(desc(riderKycSubmissions.submittedAt))
        .limit(clamped);
      return rows.map((s) => ({
        id: s.id,
        accountUuid: s.accountUuid,
        state: s.state as RiderKycSubmissionState,
        riderClass: s.riderClass as RiderClass,
        rejectionReason: s.rejectionReason,
        submittedAt: s.submittedAt,
        verifiedAt: s.verifiedAt,
        rejectedAt: s.rejectedAt,
        expiresAt: s.expiresAt,
        createdAt: s.createdAt,
      }));
    },
  };
}
