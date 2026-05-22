/**
 * In-memory ConsentGrantsRepo for tests. ID-14.
 *
 * Mirrors the partial-unique-index invariant of migration 0013:
 * at most one open grant per (accountUuid, appId, scope) — pre-checked
 * before insert so the create() outcome surfaces `already_open` with the
 * existing row.
 */

import type {
  ConsentGrant,
  ConsentGrantOutcome,
  ConsentGrantsRepo,
  ConsentRevokeOutcome,
} from './types.js';

export function createMemoryConsentGrantsRepo(): ConsentGrantsRepo {
  const byId = new Map<string, ConsentGrant>();

  const findOpen = (accountUuid: string, appId: string, scope: string): ConsentGrant | null => {
    for (const g of byId.values()) {
      if (
        g.accountUuid === accountUuid &&
        g.appId === appId &&
        g.scope === scope &&
        g.revokedAt === null
      ) {
        return g;
      }
    }
    return null;
  };

  return {
    async create(input): Promise<ConsentGrantOutcome> {
      const existing = findOpen(input.accountUuid, input.appId, input.scope);
      if (existing) return { kind: 'already_open', existing: { ...existing } };
      const now = new Date();
      const g: ConsentGrant = {
        id: input.id,
        accountUuid: input.accountUuid,
        appId: input.appId,
        scope: input.scope,
        grantedAt: now,
        grantedViaAppId: input.grantedViaAppId,
        revokedAt: null,
        revokedByAppId: null,
        revokeReason: null,
        createdAt: now,
      };
      byId.set(g.id, g);
      return { kind: 'created', grant: { ...g } };
    },

    async findById(id) {
      const g = byId.get(id);
      return g ? { ...g } : null;
    },

    async listByAccount(accountUuid) {
      return Array.from(byId.values())
        .filter((g) => g.accountUuid === accountUuid)
        .sort((a, b) => b.grantedAt.getTime() - a.grantedAt.getTime())
        .map((g) => ({ ...g }));
    },

    async listOpenByAccount(accountUuid) {
      return Array.from(byId.values())
        .filter((g) => g.accountUuid === accountUuid && g.revokedAt === null)
        .sort((a, b) => b.grantedAt.getTime() - a.grantedAt.getTime())
        .map((g) => ({ ...g }));
    },

    async revoke(id, revokedByAppId, revokeReason, at): Promise<ConsentRevokeOutcome> {
      const g = byId.get(id);
      if (!g) return { kind: 'not_found' };
      if (g.revokedAt !== null) return { kind: 'already_revoked', existing: { ...g } };
      g.revokedAt = at;
      g.revokedByAppId = revokedByAppId;
      g.revokeReason = revokeReason;
      return { kind: 'revoked', grant: { ...g } };
    },
  };
}
