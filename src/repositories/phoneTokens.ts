/**
 * Postgres-backed PhoneTokensRepo.
 */

import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { phoneTokens } from '../db/schema.js';
import type { PhoneTokenAudience, PhoneTokenRecord, PhoneTokensRepo } from './types.js';

function rowToRecord(r: {
  jti: string;
  accountUuid: string;
  audience: string;
  issuedAt: Date;
  expiresAt: Date;
  revoked: boolean;
  revokedAt: Date | null;
  revokedBy: string | null;
  revokeReason: string | null;
}): PhoneTokenRecord {
  return {
    jti: r.jti,
    accountUuid: r.accountUuid,
    audience: r.audience as PhoneTokenAudience,
    issuedAt: r.issuedAt,
    expiresAt: r.expiresAt,
    revoked: r.revoked,
    revokedAt: r.revokedAt,
    revokedBy: r.revokedBy,
    revokeReason: r.revokeReason,
  };
}

export function createPgPhoneTokensRepo(db: Db): PhoneTokensRepo {
  return {
    async create(input) {
      await db.insert(phoneTokens).values({
        jti: input.jti,
        accountUuid: input.accountUuid,
        audience: input.audience,
        issuedAt: input.issuedAt,
        expiresAt: input.expiresAt,
      });
    },
    async findByJti(jti) {
      const rows = await db.select().from(phoneTokens).where(eq(phoneTokens.jti, jti)).limit(1);
      const r = rows[0];
      return r ? rowToRecord(r) : null;
    },
    async revoke(jti, by, reason) {
      return db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(phoneTokens)
          .where(eq(phoneTokens.jti, jti))
          .for('update')
          .limit(1);
        const cur = rows[0];
        if (!cur || cur.revoked) return null;
        const revokedAt = new Date();
        await tx
          .update(phoneTokens)
          .set({
            revoked: true,
            revokedAt,
            revokedBy: by,
            revokeReason: reason,
          })
          .where(and(eq(phoneTokens.jti, jti), eq(phoneTokens.revoked, false)));
        return rowToRecord({
          ...cur,
          revoked: true,
          revokedAt,
          revokedBy: by,
          revokeReason: reason,
        });
      });
    },
  };
}
