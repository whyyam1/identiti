/**
 * Postgres-backed SessionsRepo.
 */

import type { Db } from '../db/client.js';
import { sessions } from '../db/schema.js';
import type { SessionsRepo } from './types.js';

export function createPgSessionsRepo(db: Db): SessionsRepo {
  return {
    async create(input) {
      const [row] = await db
        .insert(sessions)
        .values({
          id: input.id,
          accountId: input.accountId,
          jti: input.jti,
          audience: input.audience,
          factorsUsed: [...input.factorsUsed],
          sessionKind: input.sessionKind,
          expiresAt: input.expiresAt,
        })
        .returning({ id: sessions.id, issuedAt: sessions.issuedAt });
      if (!row) throw new Error('sessions insert returned no row');
      return { id: row.id, issuedAt: row.issuedAt };
    },
  };
}
