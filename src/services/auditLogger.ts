/**
 * Tamper-evident audit log writer.
 * Per Instruction Pack §3.2: hash-chained entries.
 *   entry_hash = SHA-256(id + app_id + action + detail + previous_hash)
 *
 * Insertions are serialised via a Postgres transaction-scoped advisory lock so
 * concurrent appenders see a consistent previous_hash. The lock key is fixed
 * (rail-wide chain). Cost: serialisation, but writes are infrequent compared
 * to reads, so this is acceptable for v1.
 */

import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { generateUlid } from '@kmv/platform-shared';
import type { Db } from '../db/client.js';
import { auditLog } from '../db/schema.js';

export interface AuditEntry {
  appId: string;
  actorType: 'app' | 'operator' | 'system';
  actorId: string;
  action: string;
  resourceType?: string;
  resourceId?: string;
  requestId: string;
  traceparent?: string;
  ipAddress?: string;
  outcome: 'success' | 'failure';
  detail?: Record<string, unknown>;
}

export interface AuditLogger {
  append(entry: AuditEntry): Promise<void>;
}

const ADVISORY_LOCK_KEY = 73210123;

function computeEntryHash(input: {
  id: string;
  appId: string;
  action: string;
  detail: Record<string, unknown> | undefined;
  previousHash: string | null;
}): string {
  const detailString = input.detail ? JSON.stringify(input.detail) : '';
  return createHash('sha256')
    .update(
      [
        input.id,
        input.appId,
        input.action,
        detailString,
        input.previousHash ?? '',
      ].join('|')
    )
    .digest('hex');
}

export function createDbAuditLogger(db: Db): AuditLogger {
  return {
    async append(entry) {
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`);

        const lastRows = await tx
          .select({ entryHash: auditLog.entryHash })
          .from(auditLog)
          .orderBy(sql`${auditLog.createdAt} DESC`)
          .limit(1);
        const previousHash = lastRows[0]?.entryHash ?? null;

        const id = generateUlid();
        const entryHash = computeEntryHash({
          id,
          appId: entry.appId,
          action: entry.action,
          detail: entry.detail,
          previousHash,
        });

        await tx.insert(auditLog).values({
          id,
          appId: entry.appId,
          actorType: entry.actorType,
          actorId: entry.actorId,
          action: entry.action,
          resourceType: entry.resourceType ?? null,
          resourceId: entry.resourceId ?? null,
          requestId: entry.requestId,
          traceparent: entry.traceparent ?? null,
          ipAddress: entry.ipAddress ?? null,
          outcome: entry.outcome,
          detail: (entry.detail as object | undefined) ?? null,
          previousHash,
          entryHash,
        });
      });
    },
  };
}

export class InMemoryAuditLogger implements AuditLogger {
  readonly entries: AuditEntry[] = [];

  async append(entry: AuditEntry): Promise<void> {
    this.entries.push({ ...entry });
  }
}
