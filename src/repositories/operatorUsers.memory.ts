/**
 * In-memory OperatorUsersRepo for tests. ID-17.
 */

import type {
  OperatorUser,
  OperatorUserCreateOutcome,
  OperatorUsersRepo,
} from './types.js';

export function createMemoryOperatorUsersRepo(): OperatorUsersRepo {
  const byId = new Map<string, OperatorUser>();
  const byAppEmail = new Map<string, OperatorUser>();
  const key = (appId: string, email: string): string => `${appId}::${email.toLowerCase()}`;

  return {
    async create(input): Promise<OperatorUserCreateOutcome> {
      const k = key(input.appId, input.email);
      if (byAppEmail.has(k)) return { kind: 'email_collision' };
      const u: OperatorUser = {
        id: input.id,
        appId: input.appId,
        email: input.email,
        displayName: input.displayName,
        status: 'active',
        createdAt: new Date(),
        lastLoginAt: null,
      };
      byId.set(u.id, u);
      byAppEmail.set(k, u);
      return { kind: 'created', user: { ...u } };
    },

    async findById(id) {
      const u = byId.get(id);
      return u ? { ...u } : null;
    },

    async findByAppAndEmail(appId, email) {
      const u = byAppEmail.get(key(appId, email));
      return u ? { ...u } : null;
    },

    async recordLogin(id, at) {
      const u = byId.get(id);
      if (u) u.lastLoginAt = at;
    },
  };
}
