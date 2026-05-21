/**
 * In-memory KybRepo for tests. Mirrors the partial-unique-index invariants
 * of migration 0011: at most one verified row per
 * `business_registration_hash` and per `kra_pin_hash`.
 */

import type { KybDirector, KybFull, KybRecord, KybRepo } from './types.js';

export function createMemoryKybRepo(): KybRepo {
  const records = new Map<string, KybRecord>();
  const directors: KybDirector[] = [];

  return {
    async create(recordInput, directorInputs) {
      if (recordInput.state === 'verified') {
        const regClash = [...records.values()].find(
          (r) =>
            r.state === 'verified' &&
            r.businessRegistrationHash === recordInput.businessRegistrationHash,
        );
        if (regClash) {
          return { kind: 'cross_account_collision', conflictKind: 'business_registration' };
        }
        const pinClash = [...records.values()].find(
          (r) => r.state === 'verified' && r.kraPinHash === recordInput.kraPinHash,
        );
        if (pinClash) {
          return { kind: 'cross_account_collision', conflictKind: 'kra_pin' };
        }
      }

      const now = new Date();
      const record: KybRecord = {
        id: recordInput.id,
        state: recordInput.state,
        businessName: recordInput.businessName,
        businessType: recordInput.businessType,
        countryCode: recordInput.countryCode,
        businessRegistrationHash: recordInput.businessRegistrationHash,
        kraPinHash: recordInput.kraPinHash,
        rejectionReason: recordInput.rejectionReason ?? null,
        pendingInfoReason: recordInput.pendingInfoReason ?? null,
        submittedByAppId: recordInput.submittedByAppId,
        submittedAt: now,
        verifiedAt: recordInput.verifiedAt ?? null,
        rejectedAt: recordInput.rejectedAt ?? null,
        expiresAt: recordInput.expiresAt ?? null,
        createdAt: now,
      };
      records.set(record.id, record);
      for (const d of directorInputs) {
        directors.push({
          id: d.id,
          kybId: d.kybId,
          directorAccountUuid: d.directorAccountUuid,
          isSignatory: d.isSignatory,
          ownershipPct: d.ownershipPct ?? null,
          kycVerifiedAtSubmit: d.kycVerifiedAtSubmit,
          createdAt: now,
        });
      }
      return { kind: 'created', record: { ...record } };
    },

    async findById(id) {
      const r = records.get(id);
      if (!r) return null;
      const ds = directors.filter((d) => d.kybId === id);
      return {
        record: { ...r },
        directors: ds.map((d) => ({ ...d })),
      } satisfies KybFull;
    },
  };
}

export type { KybDirectorInsert } from './types.js';
