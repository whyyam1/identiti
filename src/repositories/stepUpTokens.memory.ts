/**
 * In-memory StepUpTokensRepo for tests.
 */

import type { StepUpTokenInsert, StepUpTokensRepo } from './types.js';

export function createMemoryStepUpTokensRepo(): StepUpTokensRepo & {
  list: () => readonly StepUpTokenInsert[];
} {
  const data = new Map<string, StepUpTokenInsert>();
  return {
    async create(input) {
      if (data.has(input.jti)) {
        // Mirror the PG UNIQUE-violation behaviour so tests catch double-issuance.
        throw new Error(`step_up_tokens: jti ${input.jti} already exists`);
      }
      data.set(input.jti, {
        ...input,
        ...(input.actor ? { actor: { ...input.actor } } : {}),
      });
    },
    async findByJti(jti) {
      const r = data.get(jti);
      if (!r) return null;
      return { ...r, ...(r.actor ? { actor: { ...r.actor } } : {}) };
    },
    list: () => Array.from(data.values()),
  };
}
