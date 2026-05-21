/**
 * Postgres-backed KybRepo. Cross-account uniqueness is enforced by the
 * partial UNIQUE INDEX in migration 0011; PG `23505` violations on the
 * named indexes translate back to typed `cross_account_collision`
 * outcomes.
 */

import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { kybDirectors, kybRecords } from '../db/schema.js';
import type {
  KybBusinessType,
  KybDirector,
  KybFull,
  KybRecord,
  KybRepo,
  KybState,
} from './types.js';

interface PgError {
  code?: string;
  constraint_name?: string;
}

function isUniqueViolation(err: unknown): err is PgError {
  return typeof err === 'object' && err !== null && (err as PgError).code === '23505';
}

export function createPgKybRepo(db: Db): KybRepo {
  return {
    async create(recordInput, directorInputs) {
      try {
        await db.transaction(async (tx) => {
          await tx.insert(kybRecords).values({
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
            verifiedAt: recordInput.verifiedAt ?? null,
            rejectedAt: recordInput.rejectedAt ?? null,
            expiresAt: recordInput.expiresAt ?? null,
          });
          for (const d of directorInputs) {
            await tx.insert(kybDirectors).values({
              id: d.id,
              kybId: d.kybId,
              directorAccountUuid: d.directorAccountUuid,
              isSignatory: d.isSignatory,
              ownershipPct: d.ownershipPct !== undefined ? String(d.ownershipPct) : null,
              kycVerifiedAtSubmit: d.kycVerifiedAtSubmit,
            });
          }
        });
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          const cn = err.constraint_name ?? '';
          if (cn.includes('biz_reg_uniq')) {
            return { kind: 'cross_account_collision', conflictKind: 'business_registration' };
          }
          if (cn.includes('kra_pin_uniq')) {
            return { kind: 'cross_account_collision', conflictKind: 'kra_pin' };
          }
        }
        throw err;
      }
      const full = await this.findById(recordInput.id);
      if (!full)
        throw new Error(`kyb_records ${recordInput.id} not visible after insert`);
      return { kind: 'created', record: full.record };
    },

    async findById(id) {
      const recRows = await db
        .select()
        .from(kybRecords)
        .where(eq(kybRecords.id, id))
        .limit(1);
      const r = recRows[0];
      if (!r) return null;
      const dirRows = await db
        .select()
        .from(kybDirectors)
        .where(eq(kybDirectors.kybId, id))
        .orderBy(kybDirectors.createdAt);
      const record: KybRecord = {
        id: r.id,
        state: r.state as KybState,
        businessName: r.businessName,
        businessType: r.businessType as KybBusinessType,
        countryCode: r.countryCode,
        businessRegistrationHash: r.businessRegistrationHash,
        kraPinHash: r.kraPinHash,
        rejectionReason: r.rejectionReason,
        pendingInfoReason: r.pendingInfoReason,
        submittedByAppId: r.submittedByAppId,
        submittedAt: r.submittedAt,
        verifiedAt: r.verifiedAt,
        rejectedAt: r.rejectedAt,
        expiresAt: r.expiresAt,
        createdAt: r.createdAt,
      };
      const directors: KybDirector[] = dirRows.map((d) => ({
        id: d.id,
        kybId: d.kybId,
        directorAccountUuid: d.directorAccountUuid,
        isSignatory: d.isSignatory,
        ownershipPct: d.ownershipPct === null ? null : Number(d.ownershipPct),
        kycVerifiedAtSubmit: d.kycVerifiedAtSubmit,
        createdAt: d.createdAt,
      }));
      return { record, directors } satisfies KybFull;
    },
  };
}
