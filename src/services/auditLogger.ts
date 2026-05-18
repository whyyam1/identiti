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

export interface AuditEntryRead extends AuditEntry {
  id: string;
  createdAt: Date;
  previousHash: string | null;
  entryHash: string;
}

export interface AuditListOptions {
  /** Hard cap. Defaults to 100; clamped to 500 (operator console pulls full pages on demand). */
  limit?: number;
}

export interface AuditLogger {
  append(entry: AuditEntry): Promise<void>;
  /**
   * Read entries for a (resourceType, resourceId) pair, newest first. v1.0
   * limit-only — cursor pagination is a v1.1 polish if console UX needs it.
   */
  listByResource(
    resourceType: string,
    resourceId: string,
    opts?: AuditListOptions,
  ): Promise<AuditEntryRead[]>;
}

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;

export function clampListLimit(requested: number | undefined): number {
  if (requested === undefined) return DEFAULT_LIST_LIMIT;
  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_LIST_LIMIT;
  return Math.min(MAX_LIST_LIMIT, Math.max(1, Math.floor(requested)));
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
    .update([input.id, input.appId, input.action, detailString, input.previousHash ?? ''].join('|'))
    .digest('hex');
}

export function createDbAuditLogger(db: Db): AuditLogger {
  return {
    async listByResource(resourceType, resourceId, opts) {
      const limit = clampListLimit(opts?.limit);
      const rows = await db
        .select()
        .from(auditLog)
        .where(
          sql`${auditLog.resourceType} = ${resourceType} AND ${auditLog.resourceId} = ${resourceId}`,
        )
        .orderBy(sql`${auditLog.createdAt} DESC`)
        .limit(limit);
      return rows.map((r) => {
        const entry: AuditEntryRead = {
          id: r.id,
          appId: r.appId,
          actorType: r.actorType as 'app' | 'operator' | 'system',
          actorId: r.actorId,
          action: r.action,
          requestId: r.requestId,
          outcome: r.outcome as 'success' | 'failure',
          previousHash: r.previousHash,
          entryHash: r.entryHash,
          createdAt: r.createdAt,
        };
        if (r.resourceType !== null) entry.resourceType = r.resourceType;
        if (r.resourceId !== null) entry.resourceId = r.resourceId;
        if (r.traceparent !== null) entry.traceparent = r.traceparent;
        if (r.ipAddress !== null) entry.ipAddress = r.ipAddress;
        if (r.detail !== null) entry.detail = r.detail as Record<string, unknown>;
        return entry;
      });
    },
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

  async listByResource(
    resourceType: string,
    resourceId: string,
    opts?: AuditListOptions,
  ): Promise<AuditEntryRead[]> {
    const limit = clampListLimit(opts?.limit);
    // Newest-first projection. Tests don't need stable IDs / hash chains, so
    // synthesise placeholders on read.
    const matched = this.entries
      .filter((e) => e.resourceType === resourceType && e.resourceId === resourceId)
      .reverse()
      .slice(0, limit);
    return matched.map((e, idx) => ({
      ...e,
      id: `mem_${idx}`,
      createdAt: new Date(),
      previousHash: null,
      entryHash: `mem_hash_${idx}`,
    }));
  }
}
