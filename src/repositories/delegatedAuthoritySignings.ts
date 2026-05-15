/**
 * Postgres-backed DelegatedAuthoritySigningsRepo (ID-10).
 *
 * One row per POST /v1/internal/sign issuance. The signing key never leaves
 * Identiti's HSM (Reboot Pack §A.5: Identiti = OAuth issuance authority); this
 * table is the durable audit record Helpan AI cannot tamper with.
 */

import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { delegatedAuthoritySignings } from '../db/schema.js';
import type {
  DelegatedAuthorityScope,
  DelegatedAuthoritySigningsRepo,
} from './types.js';

export function createPgDelegatedAuthoritySigningsRepo(
  db: Db
): DelegatedAuthoritySigningsRepo {
  return {
    async create(input) {
      await db.insert(delegatedAuthoritySignings).values({
        jti: input.jti,
        accountUuid: input.accountUuid,
        agentId: input.agentId,
        stepUpJti: input.stepUpJti,
        scopes: input.scopes as unknown as DelegatedAuthorityScope[],
        kid: input.kid,
        signedAt: input.signedAt,
        expiresAt: input.expiresAt,
        callerAppId: input.callerAppId,
        traceparent: input.traceparent,
        businessOpId: input.businessOpId,
      });
    },
    async findByJti(jti) {
      const rows = await db
        .select()
        .from(delegatedAuthoritySignings)
        .where(eq(delegatedAuthoritySignings.jti, jti))
        .limit(1);
      const r = rows[0];
      if (!r) return null;
      return {
        jti: r.jti,
        accountUuid: r.accountUuid,
        agentId: r.agentId,
        stepUpJti: r.stepUpJti,
        scopes: r.scopes as readonly DelegatedAuthorityScope[],
        kid: r.kid,
        signedAt: r.signedAt,
        expiresAt: r.expiresAt,
        callerAppId: r.callerAppId,
        traceparent: r.traceparent,
        businessOpId: r.businessOpId,
      };
    },
  };
}
