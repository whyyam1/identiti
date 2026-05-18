/**
 * Seed `app_credentials` with a sandbox tenant set.
 *
 * Identiti authenticates every non-exempt request with HMAC-SHA-256 against an
 * `app_credentials` row. A fresh database has none, so every authenticated
 * endpoint returns 401 until at least one tenant exists. This script seeds the
 * starter set for the sandbox.
 *
 * Idempotent: `ON CONFLICT (app_id) DO NOTHING` — an existing tenant is left
 * untouched and its secret is NOT regenerated. Newly inserted tenants print
 * their generated `hmac_secret` to stdout once — capture it then; it is not
 * stored anywhere else retrievable in plaintext.
 *
 * Run: pnpm db:seed   (reads DATABASE_URL from .env)
 */

import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';

interface TenantSeed {
  appId: string;
  appName: string;
  tenantClass: 'internal' | 'external';
  scopes: string[];
}

/**
 * Sandbox starter tenants. `helpan_ai_internal` must keep that exact app_id —
 * `POST /v1/internal/sign` pins the caller to `HELPAN_AI_APP_ID` (default
 * `helpan_ai_internal`).
 */
const TENANTS: readonly TenantSeed[] = [
  {
    appId: 'sandbox_app',
    appName: 'Sandbox consuming app',
    tenantClass: 'external',
    scopes: [
      'identiti:customers:read',
      'identiti:customers:write',
      'identiti:stepup:request',
      'identiti:tier:read',
    ],
  },
  {
    appId: 'sandbox_operator',
    appName: 'Sandbox operator console',
    tenantClass: 'internal',
    scopes: ['identiti:operator', 'identiti:customers:read', 'identiti:tier:read'],
  },
  {
    appId: 'todoku_internal',
    appName: 'Todoku rail — phone-token resolve',
    tenantClass: 'internal',
    scopes: ['phone_token:resolve'],
  },
  {
    appId: 'helpan_ai_internal',
    appName: 'Helpan AI rail — delegated-authority signing',
    tenantClass: 'internal',
    scopes: ['identiti:internal:sign:delegated_authority'],
  },
];

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set (expected in .env).');
    process.exit(1);
  }

  const sql = postgres(databaseUrl, { max: 1, prepare: false, connect_timeout: 20 });
  let seeded = 0;
  let skipped = 0;

  try {
    for (const t of TENANTS) {
      const hmacSecret = randomBytes(32).toString('hex');
      const rows = await sql`
        INSERT INTO app_credentials (app_id, app_name, tenant_class, hmac_secret, status, scopes)
        VALUES (${t.appId}, ${t.appName}, ${t.tenantClass}, ${hmacSecret}, 'active', ${t.scopes})
        ON CONFLICT (app_id) DO NOTHING
        RETURNING app_id
      `;
      if (rows.length > 0) {
        seeded += 1;
        console.log(`SEEDED  ${t.appId}  (${t.tenantClass})`);
        console.log(`  hmac_secret: ${hmacSecret}`);
        console.log(`  scopes:      ${t.scopes.join(', ')}`);
      } else {
        skipped += 1;
        console.log(`EXISTS  ${t.appId}  — left untouched (secret unchanged)`);
      }
    }
  } finally {
    await sql.end();
  }

  console.log(`\nDone. ${seeded} seeded, ${skipped} already present.`);
  if (seeded > 0) {
    console.log(
      'Capture the hmac_secret values above now — they are not recoverable in plaintext.',
    );
  }
}

main().catch((err: unknown) => {
  console.error('seed failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
