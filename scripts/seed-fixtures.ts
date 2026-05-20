/**
 * Seed the cross-rail test fixture customers (ID-11 prep).
 *
 * Per `docs/CROSS_RAIL_TEST_PLAN.md §2`: cross-rail integration testing needs
 * a deterministic set of Identiti accounts the other rails can target. Identiti
 * is the issuer of record, so Identiti seeds them and publishes the resulting
 * Account UUIDs (Account UUIDs are random `acc_<uuid v4>`, so they aren't
 * hardcoded — capture the printed UUIDs and distribute to KP/Todoku/Helpan AI).
 *
 * Idempotent: each fixture carries an `app_correlation = fixture:<KEY>`
 * marker; re-runs skip rows already present.
 *
 * Run: pnpm db:seed-fixtures   (reads DATABASE_URL + crypto keys from .env)
 */

import 'dotenv/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { generateUlid } from '@kmv/platform-shared';
import { generateAccountUuid } from '../src/domain/accountUuid.js';
import { createPgCustomersRepo } from '../src/repositories/customers.js';
import { createPhoneCrypto } from '../src/services/phoneCrypto.js';
import * as schema from '../src/db/schema.js';

type FixtureTier = 'tier_0' | 'tier_1' | 'tier_2';
type FixtureState = 'active' | 'frozen_aml';

interface Fixture {
  key: string;
  phone: string;
  nameFirst: string;
  nameLast: string;
  tier: FixtureTier;
  tierReason: string;
  state: FixtureState;
  notes: string;
}

const FIXTURES: readonly Fixture[] = [
  {
    key: 'FIX-T0',
    phone: '+254700000001',
    nameFirst: 'Fixture',
    nameLast: 'TierZero',
    tier: 'tier_0',
    tierReason: 'rule_based_tier_0_default',
    state: 'active',
    notes: 'phone-only; below KP transaction floor',
  },
  {
    key: 'FIX-T1',
    phone: '+254700000002',
    nameFirst: 'Fixture',
    nameLast: 'TierOne',
    tier: 'tier_1',
    tierReason: 'rule_based_tier_1_kyc_complete',
    state: 'active',
    notes: 'IPRS-verified; standard KP limits',
  },
  {
    key: 'FIX-T2',
    phone: '+254700000003',
    nameFirst: 'Fixture',
    nameLast: 'TierTwo',
    tier: 'tier_2',
    tierReason: 'operator_tier_2_approval',
    state: 'active',
    notes: 'enhanced KYC; step-up exercised',
  },
  {
    key: 'FIX-FROZEN',
    phone: '+254700000004',
    nameFirst: 'Fixture',
    nameLast: 'Frozen',
    tier: 'tier_1',
    tierReason: 'rule_based_tier_1_kyc_complete',
    state: 'frozen_aml',
    notes: 'suspended — KP must reject, Todoku must suppress',
  },
  {
    key: 'FIX-AGENT',
    phone: '+254700000005',
    nameFirst: 'Fixture',
    nameLast: 'Agent',
    tier: 'tier_2',
    tierReason: 'operator_tier_2_approval',
    state: 'active',
    notes: 'Helpan AI delegated-authority path',
  },
];

const FIXTURE_ORIGIN_APP_ID = 'sandbox_app'; // must exist in app_credentials
const FIXTURE_CORRELATION_PREFIX = 'fixture:';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (expected in .env)`);
  return v;
}

async function main(): Promise<void> {
  const url = requireEnv('DATABASE_URL');
  const client = postgres(url, { max: 5, prepare: false, connect_timeout: 20 });
  const db = drizzle(client, { schema });
  const customersRepo = createPgCustomersRepo(db);
  const phoneCrypto = createPhoneCrypto({
    encryptionKeyHex: requireEnv('PHONE_ENCRYPTION_KEY'),
    hashSaltHex: requireEnv('PHONE_HASH_SALT'),
  });

  let seeded = 0;
  let existed = 0;

  try {
    for (const f of FIXTURES) {
      const correlation = `${FIXTURE_CORRELATION_PREFIX}${f.key}`;

      // Idempotency check — has this fixture already been seeded?
      const existing = await client`
        SELECT id FROM platform_accounts
        WHERE origin_app_id = ${FIXTURE_ORIGIN_APP_ID} AND app_correlation = ${correlation}
        LIMIT 1
      `;
      if (existing.length > 0) {
        console.log(`EXISTS  ${f.key.padEnd(11)}  acc=${existing[0]!.id}`);
        existed += 1;
        continue;
      }

      const accountUuid = generateAccountUuid();
      const now = new Date();
      const phoneHash = phoneCrypto.hash(f.phone);
      const phoneEncrypted = phoneCrypto.encrypt(f.phone);
      const phoneRecordId = `phn_${generateUlid()}`;

      // Use the real repo create — exercises tier_history seeding + all invariants.
      const result = await customersRepo.create({
        accountUuid,
        nameFirst: f.nameFirst,
        nameLast: f.nameLast,
        nameMiddle: null,
        preferredName: null,
        email: null,
        appCorrelation: correlation,
        originAppId: FIXTURE_ORIGIN_APP_ID,
        dpaConsentAt: now,
        kycConsentAt: now,
        marketingConsent: false,
        consentCapturedVia: 'fixture_seed',
        phoneRecordId,
        phoneHash,
        phoneEncrypted,
      });
      if (result.kind !== 'created') {
        console.log(`SKIP    ${f.key.padEnd(11)}  ${result.kind}`);
        continue;
      }

      // Move pending_onboarding → active (every fixture is at least active first).
      await customersRepo.changeState(accountUuid, ['pending_onboarding'], 'active');

      // Promote tier if non-default. setTier() atomically closes the open
      // tier_0 assignment and opens the new one in tier_history.
      if (f.tier !== 'tier_0') {
        await customersRepo.setTier(accountUuid, f.tier, f.tierReason);
      }

      // Apply freeze last so the fixture lands in its target state.
      if (f.state === 'frozen_aml') {
        await customersRepo.changeState(accountUuid, ['active'], 'frozen_aml');
      }

      console.log(`SEEDED  ${f.key.padEnd(11)}  acc=${accountUuid}`);
      console.log(`        tier=${f.tier}  state=${f.state}  phone=${f.phone}`);
      console.log(`        app_correlation=${correlation}`);
      console.log(`        ${f.notes}`);
      seeded += 1;
    }
  } finally {
    await client.end();
  }

  console.log(`\nDone. ${seeded} seeded, ${existed} already present.`);
  if (seeded > 0) {
    console.log('Capture the Account UUIDs above — they are the cross-rail join keys.');
    console.log('Hand them to KP / Todoku / Helpan AI as their test-fixture references.');
  }
}

main().catch((err: unknown) => {
  console.error('seed-fixtures failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
