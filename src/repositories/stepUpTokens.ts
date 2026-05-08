/**
 * Postgres-backed StepUpTokensRepo.
 */

import type { Db } from '../db/client.js';
import { stepUpTokens } from '../db/schema.js';
import { and, eq, isNull } from 'drizzle-orm';
import type {
  ActorType,
  InitiatedBy,
  RiskTier,
  StepUpTokenInsert,
  StepUpTokensRepo,
} from './types.js';

export function createPgStepUpTokensRepo(db: Db): StepUpTokensRepo {
  return {
    async create(input) {
      await db.insert(stepUpTokens).values({
        jti: input.jti,
        accountUuid: input.accountUuid,
        challengeId: input.challengeId,
        audience: input.audience,
        operationKind: input.operationKind,
        operationRiskTier: input.operationRiskTier,
        factor: input.factor,
        env: input.env,
        actorType: input.actor?.type ?? null,
        actorAgentId: input.actor?.agentId ?? null,
        delegatedAuthorityJti: input.actor?.delegatedAuthorityJti ?? null,
        initiatedBy: input.initiatedBy ?? null,
        iat: input.iat,
        exp: input.exp,
      });
    },
    async markConsumed(jti, consumedAt) {
      const result = await db
        .update(stepUpTokens)
        .set({ consumedAt })
        .where(and(eq(stepUpTokens.jti, jti), isNull(stepUpTokens.consumedAt)))
        .returning({ jti: stepUpTokens.jti });
      return result.length > 0;
    },
    async findByJti(jti) {
      const rows = await db
        .select()
        .from(stepUpTokens)
        .where(eq(stepUpTokens.jti, jti))
        .limit(1);
      const r = rows[0];
      if (!r) return null;
      return {
        jti: r.jti,
        accountUuid: r.accountUuid,
        challengeId: r.challengeId,
        audience: r.audience,
        operationKind: r.operationKind,
        operationRiskTier: r.operationRiskTier as RiskTier,
        factor: r.factor as StepUpTokenInsert['factor'],
        env: r.env,
        iat: r.iat,
        exp: r.exp,
        ...(r.actorType
          ? {
              actor: {
                type: r.actorType as ActorType,
                ...(r.actorAgentId ? { agentId: r.actorAgentId } : {}),
                ...(r.delegatedAuthorityJti
                  ? { delegatedAuthorityJti: r.delegatedAuthorityJti }
                  : {}),
              },
            }
          : {}),
        ...(r.initiatedBy ? { initiatedBy: r.initiatedBy as InitiatedBy } : {}),
      };
    },
  };
}
