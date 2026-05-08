/**
 * In-memory PhoneChangesRepo for tests.
 */

import type {
  PhoneChange,
  PhoneChangeInsert,
  PhoneChangesRepo,
} from './types.js';

function inflate(input: PhoneChangeInsert): PhoneChange {
  const now = new Date();
  return {
    ...input,
    initiatedAt: now,
    completedAt: null,
    cancelledAt: null,
    cancelReason: null,
    createdAt: now,
  };
}

export function createMemoryPhoneChangesRepo(): PhoneChangesRepo & {
  list: () => readonly PhoneChange[];
} {
  const data = new Map<string, PhoneChange>();
  return {
    async create(input) {
      const r = inflate(input);
      data.set(r.id, r);
      return { ...r };
    },
    async findById(id) {
      const r = data.get(id);
      return r ? { ...r } : null;
    },
    async findActiveForAccount(accountId) {
      for (const r of data.values()) {
        if (
          r.accountId === accountId &&
          (r.state === 'initiated' || r.state === 'cooldown_active')
        ) {
          return { ...r };
        }
      }
      return null;
    },
    async complete(id, completedAt) {
      const r = data.get(id);
      if (!r || r.state !== 'cooldown_active') return null;
      const updated: PhoneChange = { ...r, state: 'completed', completedAt };
      data.set(id, updated);
      return { ...updated };
    },
    async cancel(id, reason, cancelledAt) {
      const r = data.get(id);
      if (!r || r.state === 'completed' || r.state === 'cancelled') return null;
      const updated: PhoneChange = {
        ...r,
        state: 'cancelled',
        cancelledAt,
        cancelReason: reason,
      };
      data.set(id, updated);
      return { ...updated };
    },
    list: () => Array.from(data.values()),
  };
}
