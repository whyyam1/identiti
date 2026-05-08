/**
 * Postgres client — Drizzle over postgres-js.
 *
 * `prepare: false` is required for compatibility with Supabase's pgBouncer
 * transaction-mode pooler (the default setup); prepared statements are
 * incompatible with that pooling mode.
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export type Db = ReturnType<typeof createDb>;

export function createDb(databaseUrl: string) {
  const client = postgres(databaseUrl, {
    max: 10,
    prepare: false,
  });
  return drizzle(client, { schema });
}
