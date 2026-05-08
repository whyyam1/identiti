/**
 * Drizzle-backed implementation of the IdempotencyStore interface from
 * @kmv/platform-shared. Persists request_body_hash + response in idempotency_keys
 * with a TTL (24 hours per Rail Contract §6).
 */

import { and, eq } from 'drizzle-orm';
import type { IdempotencyStore } from '@kmv/platform-shared';
import type { Db } from '../db/client.js';
import { idempotencyKeys } from '../db/schema.js';

export function createIdempotencyStore(db: Db): IdempotencyStore {
  return {
    async get(key, appId) {
      const rows = await db
        .select()
        .from(idempotencyKeys)
        .where(and(eq(idempotencyKeys.key, key), eq(idempotencyKeys.appId, appId)))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      if (row.expiresAt.getTime() < Date.now()) return null;

      return {
        requestBodyHash: row.requestBodyHash,
        statusCode: row.statusCode,
        responseBody: row.responseBody,
        createdAt: row.createdAt.toISOString(),
      };
    },

    async set(key, appId, record, ttlSeconds) {
      const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
      await db
        .insert(idempotencyKeys)
        .values({
          key,
          appId,
          requestBodyHash: record.requestBodyHash,
          statusCode: record.statusCode,
          responseBody: record.responseBody as object,
          expiresAt,
        })
        .onConflictDoNothing();
    },
  };
}
