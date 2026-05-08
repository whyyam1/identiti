/**
 * In-memory PhoneTokensRepo for tests.
 */

import type {
  PhoneTokenInsert,
  PhoneTokenRecord,
  PhoneTokensRepo,
} from './types.js';

export function createMemoryPhoneTokensRepo(): PhoneTokensRepo & {
  list: () => readonly PhoneTokenRecord[];
} {
  const data = new Map<string, PhoneTokenRecord>();
  return {
    async create(input) {
      if (data.has(input.jti)) {
        throw new Error(`phone_tokens: jti ${input.jti} already exists`);
      }
      data.set(input.jti, {
        ...input,
        revoked: false,
        revokedAt: null,
        revokedBy: null,
        revokeReason: null,
      });
    },
    async findByJti(jti) {
      const r = data.get(jti);
      return r ? { ...r } : null;
    },
    async revoke(jti, by, reason) {
      const r = data.get(jti);
      if (!r || r.revoked) return null;
      const updated: PhoneTokenRecord = {
        ...r,
        revoked: true,
        revokedAt: new Date(),
        revokedBy: by,
        revokeReason: reason,
      };
      data.set(jti, updated);
      return { ...updated };
    },
    list: () => Array.from(data.values()),
  };
}

export function createInsertFor(input: PhoneTokenInsert): PhoneTokenInsert {
  return { ...input };
}
