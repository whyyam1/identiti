/**
 * Postgres-backed PhoneChangesRepo.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { phoneChanges } from '../db/schema.js';
import type {
  PhoneChange,
  PhoneChangeState,
  PhoneChangeVerificationMethod,
  PhoneChangesRepo,
} from './types.js';

function rowToChange(r: {
  id: string;
  accountId: string;
  state: string;
  verificationMethod: string;
  newPhoneHash: string;
  newPhoneEncrypted: string;
  challengeOldId: string | null;
  challengeNewId: string | null;
  authorisingStepupJti: string;
  expiresAt: Date;
  initiatedAt: Date;
  completedAt: Date | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  createdAt: Date;
}): PhoneChange {
  return {
    id: r.id,
    accountId: r.accountId,
    state: r.state as PhoneChangeState,
    verificationMethod: r.verificationMethod as PhoneChangeVerificationMethod,
    newPhoneHash: r.newPhoneHash,
    newPhoneEncrypted: r.newPhoneEncrypted,
    challengeOldId: r.challengeOldId,
    challengeNewId: r.challengeNewId,
    authorisingStepupJti: r.authorisingStepupJti,
    expiresAt: r.expiresAt,
    initiatedAt: r.initiatedAt,
    completedAt: r.completedAt,
    cancelledAt: r.cancelledAt,
    cancelReason: r.cancelReason,
    createdAt: r.createdAt,
  };
}

export function createPgPhoneChangesRepo(db: Db): PhoneChangesRepo {
  return {
    async create(input) {
      const [row] = await db
        .insert(phoneChanges)
        .values({
          id: input.id,
          accountId: input.accountId,
          state: input.state,
          verificationMethod: input.verificationMethod,
          newPhoneHash: input.newPhoneHash,
          newPhoneEncrypted: input.newPhoneEncrypted,
          challengeOldId: input.challengeOldId,
          challengeNewId: input.challengeNewId,
          authorisingStepupJti: input.authorisingStepupJti,
          expiresAt: input.expiresAt,
        })
        .returning();
      if (!row) throw new Error('phone_changes insert returned no row');
      return rowToChange(row);
    },
    async findById(id) {
      const rows = await db.select().from(phoneChanges).where(eq(phoneChanges.id, id)).limit(1);
      const r = rows[0];
      return r ? rowToChange(r) : null;
    },
    async findActiveForAccount(accountId) {
      const rows = await db
        .select()
        .from(phoneChanges)
        .where(
          and(
            eq(phoneChanges.accountId, accountId),
            inArray(phoneChanges.state, ['initiated', 'cooldown_active']),
          ),
        )
        .limit(1);
      const r = rows[0];
      return r ? rowToChange(r) : null;
    },
    async complete(id, completedAt) {
      const [row] = await db
        .update(phoneChanges)
        .set({
          state: 'completed',
          completedAt,
          updatedAt: sql`NOW()`,
        })
        .where(and(eq(phoneChanges.id, id), eq(phoneChanges.state, 'cooldown_active')))
        .returning();
      return row ? rowToChange(row) : null;
    },
    async cancel(id, reason, cancelledAt) {
      const [row] = await db
        .update(phoneChanges)
        .set({
          state: 'cancelled',
          cancelledAt,
          cancelReason: reason,
          updatedAt: sql`NOW()`,
        })
        .where(
          and(
            eq(phoneChanges.id, id),
            inArray(phoneChanges.state, ['initiated', 'cooldown_active']),
          ),
        )
        .returning();
      return row ? rowToChange(row) : null;
    },
  };
}
