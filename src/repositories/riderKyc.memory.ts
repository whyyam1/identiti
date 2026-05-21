/**
 * In-memory RiderKycRepo for tests. Mirrors the partial-unique-index
 * invariants of migration 0010: at most one verified row per
 * (kind, hash) combination across all accounts for the licence and
 * bike-registration hashes. The mpesa hash is NOT cross-account unique.
 */

import type {
  RiderKycArtefact,
  RiderKycArtefactInsert,
  RiderKycRepo,
  RiderKycSubmission,
  RiderKycSubmissionFull,
} from './types.js';

export function createMemoryRiderKycRepo(): RiderKycRepo {
  const submissions = new Map<string, RiderKycSubmission>();
  const artefacts: RiderKycArtefact[] = [];

  return {
    async create(submissionInput, artefactInputs) {
      // Cross-account uniqueness pre-check (mirrors the partial-unique-index).
      for (const a of artefactInputs) {
        if (a.state !== 'verified') continue;
        if (a.kind === 'rider_driving_licence' && a.licenceNumberHash) {
          const clash = artefacts.find(
            (x) =>
              x.kind === 'rider_driving_licence' &&
              x.state === 'verified' &&
              x.licenceNumberHash === a.licenceNumberHash &&
              x.accountUuid !== a.accountUuid,
          );
          if (clash) return { kind: 'cross_account_collision', conflictKind: 'driving_licence' };
        }
        if (a.kind === 'rider_motorbike_registration' && a.bikeRegistrationHash) {
          const clash = artefacts.find(
            (x) =>
              x.kind === 'rider_motorbike_registration' &&
              x.state === 'verified' &&
              x.bikeRegistrationHash === a.bikeRegistrationHash &&
              x.accountUuid !== a.accountUuid,
          );
          if (clash) return { kind: 'cross_account_collision', conflictKind: 'bike_registration' };
        }
      }

      const now = new Date();
      const submission: RiderKycSubmission = {
        id: submissionInput.id,
        accountUuid: submissionInput.accountUuid,
        state: submissionInput.state,
        riderClass: submissionInput.riderClass,
        rejectionReason: submissionInput.rejectionReason ?? null,
        submittedAt: now,
        verifiedAt: submissionInput.verifiedAt ?? null,
        rejectedAt: submissionInput.rejectedAt ?? null,
        expiresAt: submissionInput.expiresAt ?? null,
        createdAt: now,
      };
      submissions.set(submission.id, submission);
      for (const a of artefactInputs) {
        artefacts.push({
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
          createdAt: now,
        });
      }
      return { kind: 'created', submission: { ...submission } };
    },

    async findById(id) {
      const s = submissions.get(id);
      if (!s) return null;
      const arts = artefacts.filter((a) => a.submissionId === id);
      return {
        submission: { ...s },
        artefacts: arts.map((a) => ({ ...a })),
      } satisfies RiderKycSubmissionFull;
    },

    async listByAccount(accountUuid, limit = 50) {
      return [...submissions.values()]
        .filter((s) => s.accountUuid === accountUuid)
        .sort((a, b) => b.submittedAt.getTime() - a.submittedAt.getTime())
        .slice(0, Math.max(1, Math.min(200, limit)))
        .map((s) => ({ ...s }));
    },
  };
}

// Re-export the insert type for symmetry — keeps the import surface tight.
export type { RiderKycArtefactInsert };
