/**
 * In-memory CustomersRepo for tests.
 */

import type {
  AccountState,
  CustomerRow,
  CustomersRepo,
  Tier,
} from './types.js';

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
}

export function createMemoryCustomersRepo(): CustomersRepo {
  const accounts = new Map<string, StoredAccount>();
  const phoneHashes = new Map<string, string>(); // phoneHash → accountUuid

  return {
    async create(input) {
      if (phoneHashes.has(input.phoneHash)) {
        return { kind: 'phone_collision' };
      }
      const stored: StoredAccount = {
        accountUuid: input.accountUuid,
        state: 'pending_onboarding',
        tier: 'tier_0',
        tierAssignedAt: null,
        tierReason: null,
        createdAt: new Date(),
        lastActiveAt: null,
        phoneHash: input.phoneHash,
        phoneEncrypted: input.phoneEncrypted,
      };
      accounts.set(input.accountUuid, stored);
      phoneHashes.set(input.phoneHash, input.accountUuid);
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
      return { fromTier, toTier: tier, assignedAt: now, reason };
    },
  };
}
