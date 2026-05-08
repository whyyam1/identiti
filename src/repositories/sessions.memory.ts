/**
 * In-memory SessionsRepo for tests.
 */

import type { SessionInsert, SessionsRepo } from './types.js';

export function createMemorySessionsRepo(): SessionsRepo & {
  list: () => readonly SessionInsert[];
} {
  const rows: SessionInsert[] = [];
  return {
    async create(input) {
      rows.push({ ...input, factorsUsed: [...input.factorsUsed] });
      return { id: input.id, issuedAt: new Date() };
    },
    list: () => rows,
  };
}
