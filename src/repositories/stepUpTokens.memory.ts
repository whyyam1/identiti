/**
 * In-memory StepUpTokensRepo for tests.
 */

import type { StepUpTokenInsert, StepUpTokensRepo } from './types.js';

interface StoredStepUpToken {
  insert: StepUpTokenInsert;
  consumedAt: Date | null;
}

export function createMemoryStepUpTokensRepo(): StepUpTokensRepo & {
  list: () => readonly StepUpTokenInsert[];
} {
  const data = new Map<string, StoredStepUpToken>();
  return {
    async create(input) {
      if (data.has(input.jti)) {
        // Mirror the PG UNIQUE-violation behaviour so tests catch double-issuance.
        throw new Error(`step_up_tokens: jti ${input.jti} already exists`);
      }
      data.set(input.jti, {
        insert: {
          ...input,
          ...(input.actor ? { actor: { ...input.actor } } : {}),
        },
        consumedAt: null,
      });
    },
    async findByJti(jti) {
      const r = data.get(jti);
      if (!r) return null;
      const { insert } = r;
      return { ...insert, ...(insert.actor ? { actor: { ...insert.actor } } : {}) };
    },
    async markConsumed(jti, consumedAt) {
      const r = data.get(jti);
      if (!r) return false;
      if (r.consumedAt) return false;
      r.consumedAt = consumedAt;
      return true;
    },
    list: () => Array.from(data.values()).map((r) => r.insert),
  };
}
