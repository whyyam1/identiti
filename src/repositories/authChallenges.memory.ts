/**
 * In-memory AuthChallengesRepo for tests.
 */

import type { AuthChallenge, AuthChallengesRepo } from './types.js';

export function createMemoryAuthChallengesRepo(): AuthChallengesRepo {
  const data = new Map<string, AuthChallenge>();
  return {
    async create(input) {
      const c: AuthChallenge = {
        id: input.id,
        accountId: input.accountId,
        appId: input.appId,
        factor: input.factor,
        purpose: input.purpose,
        otpHash: input.otpHash,
        attemptsUsed: 0,
        status: 'pending',
        expiresAt: input.expiresAt,
        consumedAt: null,
        intendedOperation: input.intendedOperation,
        operationAudience: input.operationAudience,
        operationRiskTier: input.operationRiskTier,
        createdAt: new Date(),
      };
      data.set(c.id, c);
      return { ...c };
    },

    async findById(id) {
      const c = data.get(id);
      return c ? { ...c } : null;
    },

    async recordAttempt(id, next) {
      const c = data.get(id);
      if (!c) return null;
      if (c.status !== 'pending') return { ...c };
      if (next.incrementAttempts) c.attemptsUsed += 1;
      c.status = next.status;
      c.consumedAt = next.consumedAt;
      return { ...c };
    },
  };
}
