/**
 * Postgres-backed ConsentGrantsRepo. ID-14.
 *
 * Cross-grant uniqueness on (account_uuid, app_id, scope) WHERE revoked_at
 * IS NULL is enforced by the partial UNIQUE INDEX in migration 0013
 * (`consent_grants_open_uniq`). A PG `23505` on that index name is
 * translated back to a typed `already_open` outcome — we then read the
 * existing row so the caller can decide whether to revoke + re-grant.
 */

import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { consentGrants } from '../db/schema.js';
import type {
  ConsentGrant,
  ConsentGrantOutcome,
  ConsentGrantsRepo,
  ConsentRevokeOutcome,
} from './types.js';

interface PgError {
  code?: string;
  constraint_name?: string;
}

function isUniqueViolation(err: unknown): err is PgError {
  return typeof err === 'object' && err !== null && (err as PgError).code === '23505';
}

function toGrant(r: typeof consentGrants.$inferSelect): ConsentGrant {
  return {
    id: r.id,
    accountUuid: r.accountUuid,
    appId: r.appId,
    scope: r.scope,
    grantedAt: r.grantedAt,
    grantedViaAppId: r.grantedViaAppId,
    revokedAt: r.revokedAt,
    revokedByAppId: r.revokedByAppId,
    revokeReason: r.revokeReason,
    createdAt: r.createdAt,
  };
}

export function createPgConsentGrantsRepo(db: Db): ConsentGrantsRepo {
  const findOpen = async (
    accountUuid: string,
    appId: string,
    scope: string,
  ): Promise<ConsentGrant | null> => {
    const rows = await db
      .select()
      .from(consentGrants)
      .where(
        and(
          eq(consentGrants.accountUuid, accountUuid),
          eq(consentGrants.appId, appId),
          eq(consentGrants.scope, scope),
          isNull(consentGrants.revokedAt),
        ),
      )
      .limit(1);
    const r = rows[0];
    return r ? toGrant(r) : null;
  };

  return {
    async create(input): Promise<ConsentGrantOutcome> {
      try {
        const [row] = await db
          .insert(consentGrants)
          .values({
            id: input.id,
            accountUuid: input.accountUuid,
            appId: input.appId,
            scope: input.scope,
            grantedViaAppId: input.grantedViaAppId,
          })
          .returning();
        if (!row) throw new Error('consent_grants insert returned no row');
        return { kind: 'created', grant: toGrant(row) };
      } catch (err) {
        if (isUniqueViolation(err)) {
          const existing = await findOpen(input.accountUuid, input.appId, input.scope);
          if (existing) return { kind: 'already_open', existing };
        }
        throw err;
      }
    },

    async findById(id) {
      const rows = await db.select().from(consentGrants).where(eq(consentGrants.id, id)).limit(1);
      const r = rows[0];
      return r ? toGrant(r) : null;
    },

    async listByAccount(accountUuid) {
      const rows = await db
        .select()
        .from(consentGrants)
        .where(eq(consentGrants.accountUuid, accountUuid))
        .orderBy(desc(consentGrants.grantedAt));
      return rows.map(toGrant);
    },

    async listOpenByAccount(accountUuid) {
      const rows = await db
        .select()
        .from(consentGrants)
        .where(and(eq(consentGrants.accountUuid, accountUuid), isNull(consentGrants.revokedAt)))
        .orderBy(desc(consentGrants.grantedAt));
      return rows.map(toGrant);
    },

    async revoke(id, revokedByAppId, revokeReason, at): Promise<ConsentRevokeOutcome> {
      return db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(consentGrants)
          .where(eq(consentGrants.id, id))
          .for('update')
          .limit(1);
        const cur = rows[0];
        if (!cur) return { kind: 'not_found' as const };
        if (cur.revokedAt !== null) {
          return { kind: 'already_revoked' as const, existing: toGrant(cur) };
        }
        const [updated] = await tx
          .update(consentGrants)
          .set({ revokedAt: at, revokedByAppId, revokeReason })
          .where(and(eq(consentGrants.id, id), isNull(consentGrants.revokedAt)))
          .returning();
        if (!updated) {
          // Lost a race; re-read.
          const reread = await this.findById(id);
          if (reread && reread.revokedAt !== null) {
            return { kind: 'already_revoked' as const, existing: reread };
          }
          throw new Error(`consent_grants ${id} revoke race left no consistent state`);
        }
        return { kind: 'revoked' as const, grant: toGrant(updated) };
      });
    },
  };
}
