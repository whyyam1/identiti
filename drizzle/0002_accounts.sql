-- Identiti — Sprint 1 (Phase 2): platform_accounts and phone_records.
-- Per Instruction Pack §6.2; Rail Contract Schema Appendix §4.
--
-- Apply: psql "$DATABASE_URL" -f drizzle/0002_accounts.sql
--        (or `pnpm db:push` once Supabase is provisioned)

CREATE TABLE IF NOT EXISTS platform_accounts (
  id                    TEXT PRIMARY KEY,
    -- acc_<uuid v4> per Rail Contract §1.1. Format-validated at ingress, not in DB.
  status                TEXT NOT NULL DEFAULT 'pending_onboarding',
  tier                  TEXT NOT NULL DEFAULT 'tier_0',
  tier_assigned_at      TIMESTAMPTZ,

  -- Profile (PII). Sprint 1 stores plaintext for sandbox; Stage 2 hardens to
  -- pgcrypto-wrapped columns. KYC consent is the legal predicate for capture.
  name_first            TEXT NOT NULL,
  name_last             TEXT NOT NULL,
  name_middle           TEXT,
  preferred_name        TEXT,
  email                 TEXT,

  -- Origination: which app created this account, and the app's own customer ref.
  app_correlation       TEXT NOT NULL,
  origin_app_id         TEXT NOT NULL REFERENCES app_credentials(app_id),

  -- Consent capture (Schema Appendix §1.13).
  dpa_consent_at        TIMESTAMPTZ NOT NULL,
  kyc_consent_at        TIMESTAMPTZ NOT NULL,
  marketing_consent     BOOLEAN NOT NULL DEFAULT false,
  consent_captured_via  TEXT NOT NULL,

  last_active_at        TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT platform_accounts_status_chk CHECK (status IN (
    'pending_onboarding', 'active', 'frozen_kyc', 'frozen_aml',
    'closed_customer', 'closed_operator', 'closed_regulatory'
  )),
  CONSTRAINT platform_accounts_tier_chk   CHECK (tier   IN ('tier_0', 'tier_1', 'tier_2')),
  CONSTRAINT platform_accounts_uuid_chk   CHECK (id ~ '^acc_[0-9a-f-]{36}$')
);
CREATE INDEX IF NOT EXISTS platform_accounts_origin_app_idx
  ON platform_accounts (origin_app_id);
CREATE INDEX IF NOT EXISTS platform_accounts_app_correlation_idx
  ON platform_accounts (origin_app_id, app_correlation);
ALTER TABLE platform_accounts ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS phone_records (
  id                TEXT PRIMARY KEY,
    -- ULID
  account_id        TEXT NOT NULL UNIQUE
                    REFERENCES platform_accounts(id) ON DELETE RESTRICT,
  phone_hash        TEXT NOT NULL UNIQUE,
    -- PBKDF2(normalised_msisdn, PHONE_HASH_SALT) hex. Deterministic; lookups
    -- enforce uniqueness without revealing plaintext.
  phone_encrypted   TEXT NOT NULL,
    -- AES-256-GCM. Layout: iv(12) || tag(16) || ciphertext, base64.
  last_change_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cooldown_until    TIMESTAMPTZ,
    -- Phase 7 phone-change cooldown enforcement; null when not in cooldown.
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS phone_records_phone_hash_idx
  ON phone_records (phone_hash);
ALTER TABLE phone_records ENABLE ROW LEVEL SECURITY;
