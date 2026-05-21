/**
 * Postgres-backed CustomersRepo. Drizzle on top of postgres-js.
 *
 * `create` runs the platform_accounts insert and the phone_records insert in a
 * single transaction. A unique-violation on phone_hash maps to
 * `phone_collision`; callers translate this to validation_phone_already_registered
 * (Rail Contract Schema Appendix §3 / §10.2).
 */

import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import { generateUlid } from '@kmv/platform-shared';
import type { Db } from '../db/client.js';
import { phoneRecords, platformAccounts, tierHistory } from '../db/schema.js';
import type {
  AccountState,
  CustomerRow,
  CustomersRepo,
  Tier,
  TierAssignment,
  TierHistoryPage,
} from './types.js';

const DEFAULT_HISTORY_LIMIT = 50;
const MAX_HISTORY_LIMIT = 200;

interface PgError {
  code?: string;
  constraint_name?: string;
}

function isUniqueViolation(err: unknown): err is PgError {
  return typeof err === 'object' && err !== null && (err as PgError).code === '23505';
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

          // Seed the initial open tier_0 assignment (Schema Appendix §6.4).
          // The partial-unique index ensures at most one open row per account.
          await tx.insert(tierHistory).values({
            id: `tas_${generateUlid()}`,
            accountUuid: input.accountUuid,
            tier: 'tier_0',
            reason: 'rule_based_tier_0_default',
            assignedAt: acc.createdAt,
            endedAt: null,
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
          riderClass: platformAccounts.riderClass,
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
        riderClass: r.riderClass as CustomerRow['riderClass'],
        createdAt: r.createdAt,
        lastActiveAt: r.lastActiveAt,
      };
    },

    async setRiderClass(accountUuid, riderClass) {
      const result = await db
        .update(platformAccounts)
        .set({ riderClass, updatedAt: sql`NOW()` })
        .where(eq(platformAccounts.id, accountUuid))
        .returning({ id: platformAccounts.id });
      return result.length > 0;
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

    async getPhoneRecord(accountUuid) {
      const rows = await db
        .select({
          phoneHash: phoneRecords.phoneHash,
          phoneEncrypted: phoneRecords.phoneEncrypted,
          cooldownUntil: phoneRecords.cooldownUntil,
          lastChangeAt: phoneRecords.lastChangeAt,
        })
        .from(phoneRecords)
        .where(eq(phoneRecords.accountId, accountUuid))
        .limit(1);
      const r = rows[0];
      if (!r) return null;
      return {
        phoneHash: r.phoneHash,
        phoneEncrypted: r.phoneEncrypted,
        cooldownUntil: r.cooldownUntil,
        lastChangeAt: r.lastChangeAt,
      };
    },

    async swapPhone(accountUuid, input) {
      const [row] = await db
        .update(phoneRecords)
        .set({
          phoneHash: input.newPhoneHash,
          phoneEncrypted: input.newPhoneEncrypted,
          cooldownUntil: input.cooldownUntil,
          lastChangeAt: sql`NOW()`,
        })
        .where(eq(phoneRecords.accountId, accountUuid))
        .returning({
          phoneHash: phoneRecords.phoneHash,
          phoneEncrypted: phoneRecords.phoneEncrypted,
          cooldownUntil: phoneRecords.cooldownUntil,
          lastChangeAt: phoneRecords.lastChangeAt,
        });
      if (!row) return null;
      return {
        phoneHash: row.phoneHash,
        phoneEncrypted: row.phoneEncrypted,
        cooldownUntil: row.cooldownUntil,
        lastChangeAt: row.lastChangeAt,
      };
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
        // Close the open tier-history row (if any) and open a new one.
        // The partial-unique-index would reject a second open row, so this
        // close-then-insert ordering must hold within the transaction.
        await tx
          .update(tierHistory)
          .set({ endedAt: now })
          .where(and(eq(tierHistory.accountUuid, accountUuid), isNull(tierHistory.endedAt)));
        await tx.insert(tierHistory).values({
          id: `tas_${generateUlid()}`,
          accountUuid,
          tier,
          reason,
          assignedAt: now,
          endedAt: null,
        });
        return { fromTier, toTier: tier, assignedAt: now, reason };
      });
    },

    async getTierHistory(accountUuid, opts = {}) {
      // Confirm the account exists so we can distinguish 404 from empty.
      const accExists = await db
        .select({ id: platformAccounts.id })
        .from(platformAccounts)
        .where(eq(platformAccounts.id, accountUuid))
        .limit(1);
      if (accExists.length === 0) return null;

      const limit = Math.min(Math.max(opts.limit ?? DEFAULT_HISTORY_LIMIT, 1), MAX_HISTORY_LIMIT);

      // Cursor: the assignment_id at which the next page starts. We translate
      // it to a < cursor's assigned_at filter for the seek. (For ties on
      // assigned_at we sort assignment_id DESC; same in the WHERE.)
      let cursorAssignedAt: Date | null = null;
      if (opts.cursor) {
        const c = await db
          .select({ assignedAt: tierHistory.assignedAt })
          .from(tierHistory)
          .where(eq(tierHistory.id, opts.cursor))
          .limit(1);
        cursorAssignedAt = c[0]?.assignedAt ?? null;
      }
      const whereClauses = cursorAssignedAt
        ? and(
            eq(tierHistory.accountUuid, accountUuid),
            lt(tierHistory.assignedAt, cursorAssignedAt),
          )
        : eq(tierHistory.accountUuid, accountUuid);

      // Fetch one extra row to know whether a next page exists.
      const rows = await db
        .select()
        .from(tierHistory)
        .where(whereClauses)
        .orderBy(desc(tierHistory.assignedAt), desc(tierHistory.id))
        .limit(limit + 1);

      const slice = rows.slice(0, limit);
      const next = rows.length > limit ? rows[limit]!.id : null;
      const items: TierAssignment[] = slice.map((r) => ({
        assignmentId: r.id,
        tier: r.tier as Tier,
        reason: r.reason,
        assignedAt: r.assignedAt,
        endedAt: r.endedAt,
      }));
      const page: TierHistoryPage = { items, cursor: next };
      return page;
    },
  };
}
