/**
 * Postgres-backed AuthChallengesRepo.
 */

import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { authChallenges } from '../db/schema.js';
import type {
  ActorType,
  AuthChallenge,
  AuthChallengesRepo,
  ChallengePurpose,
  ChallengeStatus,
  Factor,
  InitiatedBy,
} from './types.js';

function rowToChallenge(r: {
  id: string;
  accountId: string | null;
  appId: string;
  factor: string;
  purpose: string;
  otpHash: string | null;
  attemptsUsed: number;
  status: string;
  expiresAt: Date;
  consumedAt: Date | null;
  intendedOperation: string | null;
  operationAudience: string | null;
  operationRiskTier: string | null;
  actorType: string | null;
  actorAgentId: string | null;
  actorDelegatedAuthorityJti: string | null;
  initiatedBy: string | null;
  operatorUserId: string | null;
  factorData: unknown;
  createdAt: Date;
}): AuthChallenge {
  return {
    id: r.id,
    accountId: r.accountId,
    appId: r.appId,
    factor: r.factor as Factor,
    purpose: r.purpose as ChallengePurpose,
    otpHash: r.otpHash,
    attemptsUsed: r.attemptsUsed,
    status: r.status as ChallengeStatus,
    expiresAt: r.expiresAt,
    consumedAt: r.consumedAt,
    intendedOperation: r.intendedOperation,
    operationAudience: r.operationAudience,
    operationRiskTier: r.operationRiskTier as AuthChallenge['operationRiskTier'],
    actor: r.actorType
      ? {
          type: r.actorType as ActorType,
          ...(r.actorAgentId ? { agentId: r.actorAgentId } : {}),
          ...(r.actorDelegatedAuthorityJti
            ? { delegatedAuthorityJti: r.actorDelegatedAuthorityJti }
            : {}),
        }
      : null,
    initiatedBy: (r.initiatedBy as InitiatedBy | null) ?? null,
    operatorUserId: r.operatorUserId,
    factorData:
      r.factorData && typeof r.factorData === 'object'
        ? (r.factorData as Record<string, unknown>)
        : null,
    createdAt: r.createdAt,
  };
}

export function createPgAuthChallengesRepo(db: Db): AuthChallengesRepo {
  return {
    async create(input) {
      const [row] = await db
        .insert(authChallenges)
        .values({
          id: input.id,
          accountId: input.accountId,
          appId: input.appId,
          factor: input.factor,
          purpose: input.purpose,
          otpHash: input.otpHash,
          expiresAt: input.expiresAt,
          intendedOperation: input.intendedOperation,
          operationAudience: input.operationAudience,
          operationRiskTier: input.operationRiskTier,
          actorType: input.actor?.type ?? null,
          actorAgentId: input.actor?.agentId ?? null,
          actorDelegatedAuthorityJti: input.actor?.delegatedAuthorityJti ?? null,
          initiatedBy: input.initiatedBy ?? null,
          operatorUserId: input.operatorUserId ?? null,
          factorData: input.factorData ?? null,
        })
        .returning();
      if (!row) throw new Error('auth_challenges insert returned no row');
      return rowToChallenge(row);
    },

    async findById(id) {
      const rows = await db.select().from(authChallenges).where(eq(authChallenges.id, id)).limit(1);
      const r = rows[0];
      return r ? rowToChallenge(r) : null;
    },

    async recordAttempt(id, next) {
      return db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(authChallenges)
          .where(eq(authChallenges.id, id))
          .for('update')
          .limit(1);
        const cur = rows[0];
        if (!cur) return null;
        if (cur.status !== 'pending') {
          // Stable read of terminal challenge.
          return rowToChallenge(cur);
        }
        const newAttempts = next.incrementAttempts ? cur.attemptsUsed + 1 : cur.attemptsUsed;
        await tx
          .update(authChallenges)
          .set({
            attemptsUsed: newAttempts,
            status: next.status,
            consumedAt: next.consumedAt,
          })
          .where(and(eq(authChallenges.id, id), eq(authChallenges.status, 'pending')));
        return rowToChallenge({
          ...cur,
          attemptsUsed: newAttempts,
          status: next.status,
          consumedAt: next.consumedAt,
        });
      });
    },
  };
}
