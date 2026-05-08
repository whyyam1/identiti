/**
 * Postgres-backed CustomersRepo. Drizzle on top of postgres-js.
 *
 * `create` runs the platform_accounts insert and the phone_records insert in a
 * single transaction. A unique-violation on phone_hash maps to
 * `phone_collision`; callers translate this to validation_phone_already_registered
 * (Rail Contract Schema Appendix §3 / §10.2).
 */

import { eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { phoneRecords, platformAccounts } from '../db/schema.js';
import type {
  AccountState,
  CustomersRepo,
  Tier,
} from './types.js';

interface PgError {
  code?: string;
  constraint_name?: string;
}

function isUniqueViolation(err: unknown): err is PgError {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as PgError).code === '23505'
  );
}

export function createPgCustomersRepo(db: Db): CustomersRepo {
  return {
    async create(input) {
      try {
        const created = await db.transaction(async (tx) => {
          const [acc] = await tx
            .insert(platformAccounts)
            .values({
              id: input.accountUuid,
              status: 'pending_onboarding',
              tier: 'tier_0',
              nameFirst: input.nameFirst,
              nameLast: input.nameLast,
              nameMiddle: input.nameMiddle,
              preferredName: input.preferredName,
              email: input.email,
              appCorrelation: input.appCorrelation,
              originAppId: input.originAppId,
              dpaConsentAt: input.dpaConsentAt,
              kycConsentAt: input.kycConsentAt,
              marketingConsent: input.marketingConsent,
              consentCapturedVia: input.consentCapturedVia,
            })
            .returning({
              id: platformAccounts.id,
              status: platformAccounts.status,
              tier: platformAccounts.tier,
              createdAt: platformAccounts.createdAt,
            });
          if (!acc) throw new Error('platform_accounts insert returned no row');

          await tx.insert(phoneRecords).values({
            id: input.phoneRecordId,
            accountId: input.accountUuid,
            phoneHash: input.phoneHash,
            phoneEncrypted: input.phoneEncrypted,
          });

          return acc;
        });

        return {
          kind: 'created',
          outcome: {
            accountUuid: created.id,
            state: created.status as AccountState,
            tier: created.tier as Tier,
            createdAt: created.createdAt,
          },
        };
      } catch (err: unknown) {
        if (
          isUniqueViolation(err) &&
          (err.constraint_name?.includes('phone_hash') ||
            err.constraint_name?.includes('phone_records_phone_hash'))
        ) {
          return { kind: 'phone_collision' };
        }
        throw err;
      }
    },

    async findById(accountUuid) {
      const rows = await db
        .select({
          id: platformAccounts.id,
          status: platformAccounts.status,
          tier: platformAccounts.tier,
          tierAssignedAt: platformAccounts.tierAssignedAt,
          createdAt: platformAccounts.createdAt,
          lastActiveAt: platformAccounts.lastActiveAt,
        })
        .from(platformAccounts)
        .where(eq(platformAccounts.id, accountUuid))
        .limit(1);
      const r = rows[0];
      if (!r) return null;
      return {
        accountUuid: r.id,
        state: r.status as AccountState,
        tier: r.tier as Tier,
        tierAssignedAt: r.tierAssignedAt,
        createdAt: r.createdAt,
        lastActiveAt: r.lastActiveAt,
      };
    },

    async findByPhoneHash(phoneHash) {
      const rows = await db
        .select({ accountId: phoneRecords.accountId })
        .from(phoneRecords)
        .where(eq(phoneRecords.phoneHash, phoneHash))
        .limit(1);
      const r = rows[0];
      if (!r) return null;
      return { accountUuid: r.accountId };
    },

    async findEncryptedPhoneFor(accountUuid) {
      const rows = await db
        .select({ phoneEncrypted: phoneRecords.phoneEncrypted })
        .from(phoneRecords)
        .where(eq(phoneRecords.accountId, accountUuid))
        .limit(1);
      const r = rows[0];
      return r ? r.phoneEncrypted : null;
    },

    async changeState(accountUuid, fromStates, toState) {
      return db.transaction(async (tx) => {
        const rows = await tx
          .select({ status: platformAccounts.status })
          .from(platformAccounts)
          .where(eq(platformAccounts.id, accountUuid))
          .for('update')
          .limit(1);
        const current = rows[0];
        if (!current) return null;
        const fromState = current.status as AccountState;
        if (!fromStates.includes(fromState)) return null;
        await tx
          .update(platformAccounts)
          .set({ status: toState, updatedAt: sql`NOW()` })
          .where(eq(platformAccounts.id, accountUuid));
        return { fromState, toState };
      });
    },

    async getTier(accountUuid) {
      const rows = await db
        .select({
          tier: platformAccounts.tier,
          tierAssignedAt: platformAccounts.tierAssignedAt,
          tierReason: platformAccounts.tierReason,
          createdAt: platformAccounts.createdAt,
        })
        .from(platformAccounts)
        .where(eq(platformAccounts.id, accountUuid))
        .limit(1);
      const r = rows[0];
      if (!r) return null;
      return {
        tier: r.tier as Tier,
        assignedAt: r.tierAssignedAt ?? r.createdAt,
        reason: r.tierReason ?? 'rule_based_tier_0_default',
      };
    },

    async setTier(accountUuid, tier, reason) {
      return db.transaction(async (tx) => {
        const rows = await tx
          .select({ tier: platformAccounts.tier })
          .from(platformAccounts)
          .where(eq(platformAccounts.id, accountUuid))
          .for('update')
          .limit(1);
        const current = rows[0];
        if (!current) return null;
        const fromTier = current.tier as Tier;
        const now = new Date();
        await tx
          .update(platformAccounts)
          .set({
            tier,
            tierAssignedAt: now,
            tierReason: reason,
            updatedAt: sql`NOW()`,
          })
          .where(eq(platformAccounts.id, accountUuid));
        return { fromTier, toTier: tier, assignedAt: now, reason };
      });
    },
  };
}
