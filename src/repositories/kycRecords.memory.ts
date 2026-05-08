/**
 * In-memory KycRecordsRepo for tests.
 */

import type {
  KycRecord,
  KycRecordInsert,
  KycRecordsRepo,
} from './types.js';

function inflate(input: KycRecordInsert): KycRecord {
  return {
    id: input.id,
    accountId: input.accountId,
    kind: input.kind,
    tier: input.tier,
    verificationMethod: input.verificationMethod,
    status: input.status,
    nationalIdHash: input.nationalIdHash ?? null,
    iprsVerified: input.iprsVerified ?? false,
    iprsVerificationRef: input.iprsVerificationRef ?? null,
    iprsMatch: input.iprsMatch ?? null,
    iprsConfidenceBand: input.iprsConfidenceBand ?? null,
    sanctionsChecked: false,
    pepChecked: false,
    failureReason: input.failureReason ?? null,
    verifiedAt: input.verifiedAt ?? null,
    expiresAt: input.expiresAt ?? null,
    createdAt: new Date(),
  };
}

export function createMemoryKycRecordsRepo(): KycRecordsRepo & {
  list: () => readonly KycRecord[];
} {
  const data = new Map<string, KycRecord>();
  return {
    async create(input) {
      const r = inflate(input);
      data.set(r.id, r);
      return { ...r };
    },
    async findById(id) {
      const r = data.get(id);
      return r ? { ...r } : null;
    },
    async listByAccount(accountId) {
      return Array.from(data.values())
        .filter((r) => r.accountId === accountId)
        .map((r) => ({ ...r }));
    },
    async isNationalIdHashClaimedByOther(nationalIdHash, excludingAccountId) {
      for (const r of data.values()) {
        if (
          r.status === 'verified' &&
          r.nationalIdHash === nationalIdHash &&
          r.accountId !== excludingAccountId
        ) {
          return true;
        }
      }
      return false;
    },
    list: () => Array.from(data.values()),
  };
}
