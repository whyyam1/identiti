/**
 * In-memory DelegatedAuthoritySigningsRepo for tests.
 */

import type { DelegatedAuthoritySigningInsert, DelegatedAuthoritySigningsRepo } from './types.js';

export function createMemoryDelegatedAuthoritySigningsRepo(): DelegatedAuthoritySigningsRepo & {
  list: () => readonly DelegatedAuthoritySigningInsert[];
} {
  const data = new Map<string, DelegatedAuthoritySigningInsert>();
  return {
    async create(input) {
      if (data.has(input.jti)) {
        // Mirror PK uniqueness so tests catch double-issuance bugs.
        throw new Error(`delegated_authority_signings: jti ${input.jti} already exists`);
      }
      data.set(input.jti, {
        ...input,
        scopes: input.scopes.map((s) => ({ ...s })),
      });
    },
    async findByJti(jti) {
      return data.get(jti) ?? null;
    },
    list: () => Array.from(data.values()),
  };
}
