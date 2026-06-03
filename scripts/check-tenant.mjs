/**
 * One-off read-only probe: confirm an app_credentials row landed with the
 * expected app_id, tenant_class, status, and scope set. Does NOT print the
 * hmac_secret.
 *
 *   node scripts/check-tenant.mjs <app_id>
 */
import postgres from 'postgres';
import 'dotenv/config';

const appId = process.argv[2];
if (!appId) {
  console.error('usage: node scripts/check-tenant.mjs <app_id>');
  process.exit(1);
}
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
try {
  const rows = await sql`
    SELECT app_id, app_name, tenant_class, status, scopes, created_at,
           length(hmac_secret) AS secret_len
    FROM app_credentials
    WHERE app_id = ${appId}
  `;
  if (rows.length === 0) {
    console.log(`NOT FOUND: ${appId}`);
    process.exitCode = 1;
  } else {
    const r = rows[0];
    console.log(`FOUND  ${r.app_id}`);
    console.log(`  app_name:     ${r.app_name}`);
    console.log(`  tenant_class: ${r.tenant_class}`);
    console.log(`  status:       ${r.status}`);
    console.log(`  scopes (${r.scopes.length}): ${r.scopes.join(', ')}`);
    console.log(`  created_at:   ${r.created_at.toISOString()}`);
    console.log(`  secret_len:   ${r.secret_len} chars (64 = 32 random bytes hex)`);
  }
} finally {
  await sql.end({ timeout: 5 });
}
