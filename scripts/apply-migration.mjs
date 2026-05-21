/**
 * One-off: apply a single drizzle migration to the configured DATABASE_URL.
 *
 *   pnpm exec node scripts/apply-migration.mjs drizzle/0011_kyb.sql
 *
 * Idempotent because each migration uses `CREATE TABLE IF NOT EXISTS` /
 * `CREATE INDEX IF NOT EXISTS`. Safe to re-run.
 */
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import 'dotenv/config';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/apply-migration.mjs <path-to-sql-file>');
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}
const sql = readFileSync(file, 'utf8');
const client = postgres(url, { max: 1, prepare: false });
try {
  console.log(`applying ${file} ...`);
  await client.unsafe(sql);
  console.log(`applied ${file} OK`);
} catch (err) {
  console.error('migration failed:', err);
  process.exitCode = 1;
} finally {
  await client.end({ timeout: 5 });
}
