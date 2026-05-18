/**
 * Postgres-backed KycRecordsRepo.
 */

import { and, desc, eq, ne, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { kycRecords } from '../db/schema.js';
import type {
  IprsConfidenceBand,
  IprsMatch,
  KycArtefactState,
  KycKind,
  KycRecord,
  KycRecordsRepo,
  KycVerificationMethod,
} from './types.js';

function rowToRecord(r: {
  id: string;
  accountId: string;
  kind: string;
  tier: string;
  verificationMethod: string;
  status: string;
  nationalIdHash: string | null;
  iprsVerified: boolean;
  iprsVerificationRef: string | null;
  iprsMatch: string | null;
  iprsConfidenceBand: string | null;
  sanctionsChecked: boolean;
  pepChecked: boolean;
  failureReason: string | null;
  verifiedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
}): KycRecord {
  return {
    id: r.id,
    accountId: r.accountId,
    kind: r.kind as KycKind,
    tier: r.tier as 'tier_1' | 'tier_2',
    verificationMethod: r.verificationMethod as KycVerificationMethod,
    status: r.status as KycArtefactState,
    nationalIdHash: r.nationalIdHash,
    iprsVerified: r.iprsVerified,
    iprsVerificationRef: r.iprsVerificationRef,
    iprsMatch: r.iprsMatch as IprsMatch | null,
    iprsConfidenceBand: r.iprsConfidenceBand as IprsConfidenceBand | null,
    sanctionsChecked: r.sanctionsChecked,
    pepChecked: r.pepChecked,
    failureReason: r.failureReason,
    verifiedAt: r.verifiedAt,
    expiresAt: r.expiresAt,
    createdAt: r.createdAt,
  };
}

export function createPgKycRecordsRepo(db: Db): KycRecordsRepo {
  return {
    async create(input) {
      const [row] = await db
        .insert(kycRecords)
        .values({
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
          failureReason: input.failureReason ?? null,
          verifiedAt: input.verifiedAt ?? null,
          expiresAt: input.expiresAt ?? null,
        })
        .returning();
      if (!row) throw new Error('kyc_records insert returned no row');
      return rowToRecord(row);
    },
    async findById(id) {
      const rows = await db.select().from(kycRecords).where(eq(kycRecords.id, id)).limit(1);
      const r = rows[0];
      return r ? rowToRecord(r) : null;
    },
    async listByAccount(accountId) {
      const rows = await db.select().from(kycRecords).where(eq(kycRecords.accountId, accountId));
      return rows.map(rowToRecord);
    },
    async listByStatus(status, limit) {
      const cap = limit ?? 100;
      const rows = await db
        .select()
        .from(kycRecords)
        .where(eq(kycRecords.status, status))
        .orderBy(desc(kycRecords.createdAt))
        .limit(cap);
      return rows.map(rowToRecord);
    },
    async isNationalIdHashClaimedByOther(nationalIdHash, excludingAccountId) {
      const rows = await db
        .select({ id: kycRecords.id })
        .from(kycRecords)
        .where(
          and(
            eq(kycRecords.nationalIdHash, nationalIdHash),
            eq(kycRecords.status, 'verified'),
            ne(kycRecords.accountId, excludingAccountId),
          ),
        )
        .limit(1);
      return rows.length > 0;
    },
    async markVerified(id, opts) {
      const [row] = await db
        .update(kycRecords)
        .set({
          status: 'verified',
          verifiedAt: opts.verifiedAt,
          expiresAt: opts.expiresAt,
          updatedAt: sql`NOW()`,
        })
        .where(and(eq(kycRecords.id, id), eq(kycRecords.status, 'pending')))
        .returning();
      return row ? rowToRecord(row) : null;
    },
    async markFailed(id, reason) {
      const [row] = await db
        .update(kycRecords)
        .set({
          status: 'failed',
          failureReason: reason,
          updatedAt: sql`NOW()`,
        })
        .where(and(eq(kycRecords.id, id), eq(kycRecords.status, 'pending')))
        .returning();
      return row ? rowToRecord(row) : null;
    },
  };
}
