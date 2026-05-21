/**
 * One-off probe: show columns + indexes for a table. Read-only.
 */
import postgres from 'postgres';
import 'dotenv/config';

const table = process.argv[2];
if (!table) {
  console.error('usage: node scripts/check-table.mjs <table>');
  process.exit(1);
}
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
try {
  const cols = await sql`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_name = ${table}
    ORDER BY ordinal_position
  `;
  const indexes = await sql`
    SELECT indexname, indexdef FROM pg_indexes WHERE tablename = ${table}
  `;
  console.log(`\n--- ${table} columns ---`);
  for (const c of cols) console.log(`${c.column_name} :: ${c.data_type} ${c.is_nullable === 'NO' ? 'NOT NULL' : ''}`);
  console.log(`\n--- ${table} indexes ---`);
  for (const i of indexes) console.log(i.indexdef);
} finally {
  await sql.end({ timeout: 5 });
}
