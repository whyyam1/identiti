/**
 * Postgres-backed OperatorUsersRepo. ID-17.
 *
 * Cross-tenant uniqueness on (app_id, email) is enforced by the UNIQUE
 * constraint in migration 0012; a PG `23505` on the constraint name is
 * translated back to a typed `email_collision` outcome.
 */

import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { operatorUsers } from '../db/schema.js';
import type {
  OperatorUser,
  OperatorUserCreateOutcome,
  OperatorUserStatus,
  OperatorUsersRepo,
} from './types.js';

interface PgError {
  code?: string;
  constraint_name?: string;
}

function isUniqueViolation(err: unknown): err is PgError {
  return typeof err === 'object' && err !== null && (err as PgError).code === '23505';
}

export function createPgOperatorUsersRepo(db: Db): OperatorUsersRepo {
  const toRow = (r: typeof operatorUsers.$inferSelect): OperatorUser => ({
    id: r.id,
    appId: r.appId,
    email: r.email,
    displayName: r.displayName,
    status: r.status as OperatorUserStatus,
    createdAt: r.createdAt,
    lastLoginAt: r.lastLoginAt,
  });

  return {
    async create(input): Promise<OperatorUserCreateOutcome> {
      try {
        const [row] = await db
          .insert(operatorUsers)
          .values({
            id: input.id,
            appId: input.appId,
            email: input.email,
            displayName: input.displayName,
          })
          .returning();
        if (!row) throw new Error('operator_users insert returned no row');
        return { kind: 'created', user: toRow(row) };
      } catch (err) {
        if (isUniqueViolation(err)) {
          return { kind: 'email_collision' };
        }
        throw err;
      }
    },

    async findById(id) {
      const rows = await db.select().from(operatorUsers).where(eq(operatorUsers.id, id)).limit(1);
      const r = rows[0];
      return r ? toRow(r) : null;
    },

    async findByAppAndEmail(appId, email) {
      const rows = await db
        .select()
        .from(operatorUsers)
        .where(and(eq(operatorUsers.appId, appId), eq(operatorUsers.email, email)))
        .limit(1);
      const r = rows[0];
      return r ? toRow(r) : null;
    },

    async recordLogin(id, at) {
      await db.update(operatorUsers).set({ lastLoginAt: at }).where(eq(operatorUsers.id, id));
    },
  };
}
