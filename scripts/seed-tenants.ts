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
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
      'identiti:stepup:verify',
      'identiti:tier:read',
      'identiti:consent:read',
      'identiti:consent:write',
    ],
  },
  {
    appId: 'sandbox_operator',
    appName: 'Sandbox operator console',
    tenantClass: 'internal',
    scopes: [
      'identiti:operator',
      'identiti:customers:read',
      'identiti:tier:read',
      'identiti:stepup:request',
      'identiti:stepup:verify',
    ],
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
  // Consumer apps (vs rails). First entry per the 22 May 2026 Lunch Drop
  // integration ask — same external-tenant treatment as a rail; the
  // distinction is roster/positioning, not auth posture.
  // Legal entity: Lunch Drop Limited (a Kirimon Market Ventures company).
  {
    appId: 'lunchdrop_sandbox',
    appName: 'Lunch Drop — Westlands food-delivery pilot',
    tenantClass: 'external',
    scopes: [
      'identiti:customers:read',
      'identiti:customers:write',
      'identiti:stepup:request',
      'identiti:stepup:verify',
      'identiti:tier:read',
      'identiti:consent:read',
      'identiti:consent:write',
    ],
  },
  // Itafika (rail #6, logistics-as-a-service) — needs ID-12 rider-KYC.
  // 4 Jun 2026 onboarding ask. The 7 scopes are the literal set Itafika
  // asked for; kyc:read + kyc:write are NOT in Identiti's real scope
  // catalogue (today rider-KYC routes guard on customers:read/write).
  // They're granted-as-asked for forward compatibility — no harm if
  // unused; if a future split lands they're already there.
  // Legal entity: Kirimon Market Ventures.
  {
    appId: 'itafika_sandbox',
    appName: 'Itafika — logistics-as-a-service (rail #6)',
    tenantClass: 'external',
    scopes: [
      'identiti:customers:read',
      'identiti:customers:write',
      'identiti:kyc:read',
      'identiti:kyc:write',
      'identiti:stepup:request',
      'identiti:stepup:verify',
      'identiti:tier:read',
    ],
  },
  // NOTE — scope `identiti:token:issue` (cross-rail audience token, R-ID-1)
  // is intentionally NOT in any starter set. It lets an app mint a customer
  // bearer JWT (e.g. aud=https://hakken.co.ke) on its own authority, so it is
  // granted per-app as a deliberate operator/security decision, not by default.
  // To grant Klokd its Hakken token: add 'identiti:token:issue' to the
  // klokd_sandbox scopes array below and re-run `pnpm db:seed` is a no-op for
  // existing rows — instead ALTER the row:
  //   UPDATE app_credentials SET scopes = array_append(scopes,'identiti:token:issue')
  //   WHERE app_id='klokd_sandbox' AND NOT ('identiti:token:issue' = ANY(scopes));
  //
  // Klokd (OI-01) — 6 Jun 2026 onboarding ask. Original ask was for
  // bearer-token + webhook-secret (both wrong for Identiti's surface:
  // HMAC per request, Kafka in v1.0). Granting the standard 7-scope
  // integrator set so they're forward-compatible across their use case
  // (originally framed as KYC + tier + SIM-swap event consumption).
  // Tenant_class: external. Rail vs consumer-app status TBC.
  {
    appId: 'klokd_sandbox',
    appName: 'Klokd (OI-01)',
    tenantClass: 'external',
    scopes: [
      'identiti:customers:read',
      'identiti:customers:write',
      'identiti:stepup:request',
      'identiti:stepup:verify',
      'identiti:tier:read',
      'identiti:consent:read',
      'identiti:consent:write',
    ],
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
        // Write the secret to a gitignored file rather than echoing to
        // stdout — the conversation/CI/terminal-history transcripts that
        // capture stdout count as "in chat". Hand-over via 1Password
        // sourced from the file, then delete the file.
        const secretsDir = join(dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', 'secrets');
        if (!existsSync(secretsDir)) mkdirSync(secretsDir, { recursive: true });
        const secretFile = join(secretsDir, `${t.appId}.hmac`);
        writeFileSync(secretFile, hmacSecret, { mode: 0o600 });
        console.log(`SEEDED  ${t.appId}  (${t.tenantClass})`);
        console.log(`  secret written to: secrets/${t.appId}.hmac  (chmod 0600, gitignored)`);
        console.log(`  scopes:            ${t.scopes.join(', ')}`);
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
      `New secrets written under secrets/*.hmac (gitignored, chmod 0600). Move them into 1Password (or your secrets manager) then 'rm secrets/*.hmac'. They are not recoverable in plaintext.`,
    );
  }
}

main().catch((err: unknown) => {
  console.error('seed failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
