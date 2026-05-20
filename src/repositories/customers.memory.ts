/**
 * In-memory CustomersRepo for tests.
 */

import { generateUlid } from '@kmv/platform-shared';
import type { AccountState, CustomerRow, CustomersRepo, Tier, TierAssignment } from './types.js';

const DEFAULT_HISTORY_LIMIT = 50;
const MAX_HISTORY_LIMIT = 200;

interface StoredAccount {
  accountUuid: string;
  state: AccountState;
  tier: Tier;
  tierAssignedAt: Date | null;
  tierReason: string | null;
  createdAt: Date;
  lastActiveAt: Date | null;
  phoneHash: string;
  phoneEncrypted: string;
  phoneCooldownUntil: Date | null;
  phoneLastChangeAt: Date;
}

interface StoredAssignment {
  assignmentId: string;
  accountUuid: string;
  tier: Tier;
  reason: string;
  assignedAt: Date;
  endedAt: Date | null;
}

export function createMemoryCustomersRepo(): CustomersRepo {
  const accounts = new Map<string, StoredAccount>();
  const phoneHashes = new Map<string, string>(); // phoneHash → accountUuid
  const tierHistory: StoredAssignment[] = [];

  return {
    async create(input) {
      if (phoneHashes.has(input.phoneHash)) {
        return { kind: 'phone_collision' };
      }
      const now = new Date();
      const stored: StoredAccount = {
        accountUuid: input.accountUuid,
        state: 'pending_onboarding',
        tier: 'tier_0',
        tierAssignedAt: null,
        tierReason: null,
        createdAt: now,
        lastActiveAt: null,
        phoneHash: input.phoneHash,
        phoneEncrypted: input.phoneEncrypted,
        phoneCooldownUntil: null,
        phoneLastChangeAt: now,
      };
      accounts.set(input.accountUuid, stored);
      phoneHashes.set(input.phoneHash, input.accountUuid);
      // Seed the initial open tier_0 assignment (Schema Appendix §6.4).
      tierHistory.push({
        assignmentId: `tas_${generateUlid()}`,
        accountUuid: input.accountUuid,
        tier: 'tier_0',
        reason: 'rule_based_tier_0_default',
        assignedAt: now,
        endedAt: null,
      });
      return {
        kind: 'created',
        outcome: {
          accountUuid: stored.accountUuid,
          state: stored.state,
          tier: stored.tier,
          createdAt: stored.createdAt,
        },
      };
    },

    async findById(accountUuid) {
      const a = accounts.get(accountUuid);
      if (!a) return null;
      const row: CustomerRow = {
        accountUuid: a.accountUuid,
        state: a.state,
        tier: a.tier,
        tierAssignedAt: a.tierAssignedAt,
        createdAt: a.createdAt,
        lastActiveAt: a.lastActiveAt,
      };
      return row;
    },

    async findByPhoneHash(phoneHash) {
      const accountUuid = phoneHashes.get(phoneHash);
      if (!accountUuid) return null;
      return { accountUuid };
    },

    async findEncryptedPhoneFor(accountUuid) {
      const a = accounts.get(accountUuid);
      return a?.phoneEncrypted ?? null;
    },

    async getPhoneRecord(accountUuid) {
      const a = accounts.get(accountUuid);
      if (!a) return null;
      return {
        phoneHash: a.phoneHash,
        phoneEncrypted: a.phoneEncrypted,
        cooldownUntil: a.phoneCooldownUntil,
        lastChangeAt: a.phoneLastChangeAt,
      };
    },

    async swapPhone(accountUuid, input) {
      const a = accounts.get(accountUuid);
      if (!a) return null;
      // Maintain the phoneHashes secondary index for findByPhoneHash.
      phoneHashes.delete(a.phoneHash);
      a.phoneHash = input.newPhoneHash;
      a.phoneEncrypted = input.newPhoneEncrypted;
      a.phoneCooldownUntil = input.cooldownUntil;
      a.phoneLastChangeAt = new Date();
      phoneHashes.set(a.phoneHash, a.accountUuid);
      return {
        phoneHash: a.phoneHash,
        phoneEncrypted: a.phoneEncrypted,
        cooldownUntil: a.phoneCooldownUntil,
        lastChangeAt: a.phoneLastChangeAt,
      };
    },

    async changeState(accountUuid, fromStates, toState) {
      const a = accounts.get(accountUuid);
      if (!a) return null;
      if (!fromStates.includes(a.state)) return null;
      const fromState = a.state;
      a.state = toState;
      return { fromState, toState };
    },

    async getTier(accountUuid) {
      const a = accounts.get(accountUuid);
      if (!a) return null;
      return {
        tier: a.tier,
        assignedAt: a.tierAssignedAt ?? a.createdAt,
        reason: a.tierReason ?? 'rule_based_tier_0_default',
      };
    },

    async setTier(accountUuid, tier, reason) {
      const a = accounts.get(accountUuid);
      if (!a) return null;
      const fromTier = a.tier;
      const now = new Date();
      a.tier = tier;
      a.tierAssignedAt = now;
      a.tierReason = reason;
      // Close the open assignment (if any) and open a new one. Mirrors the
      // partial-unique-index invariant on the PG side: one open row per account.
      const open = tierHistory.find((h) => h.accountUuid === accountUuid && h.endedAt === null);
      if (open) open.endedAt = now;
      tierHistory.push({
        assignmentId: `tas_${generateUlid()}`,
        accountUuid,
        tier,
        reason,
        assignedAt: now,
        endedAt: null,
      });
      return { fromTier, toTier: tier, assignedAt: now, reason };
    },

    async getTierHistory(accountUuid, opts = {}) {
      if (!accounts.has(accountUuid)) return null;
      const limit = Math.min(Math.max(opts.limit ?? DEFAULT_HISTORY_LIMIT, 1), MAX_HISTORY_LIMIT);
      // Newest-first by assigned_at; for ties (rare in memory tests), use
      // assignment_id as a stable tiebreaker.
      const all = tierHistory
        .filter((h) => h.accountUuid === accountUuid)
        .sort((a, b) => {
          const d = b.assignedAt.getTime() - a.assignedAt.getTime();
          return d !== 0 ? d : b.assignmentId.localeCompare(a.assignmentId);
        });
      // Cursor: skip until we pass the cursor's assignment_id.
      let start = 0;
      if (opts.cursor) {
        const idx = all.findIndex((h) => h.assignmentId === opts.cursor);
        if (idx >= 0) start = idx;
      }
      const slice = all.slice(start, start + limit);
      const next = start + limit < all.length ? all[start + limit]!.assignmentId : null;
      const items: TierAssignment[] = slice.map((h) => ({
        assignmentId: h.assignmentId,
        tier: h.tier,
        reason: h.reason,
        assignedAt: h.assignedAt,
        endedAt: h.endedAt,
      }));
      return { items, cursor: next };
    },
  };
}
