-- Identiti — ID-13 (KYB extension for LipaStack; newdocs §A5.1 + ID-13).
-- Per docs/NEWDOCS_DECISIONS.md Q5 (settled): new /v1/kyb/* family with
-- its own resource model, NOT a sub-type of /v1/customers/:uuid/kyc/iprs.
--
-- Data model: one kyb_records row per attempt; one kyb_directors row per
-- director-account link. Cross-account uniqueness on the business
-- registration number hash and KRA PIN hash mirrors the existing
-- kyc_records.national_id_hash pattern.
--
-- Apply: psql "$DATABASE_URL" -f drizzle/0011_kyb.sql

CREATE TABLE IF NOT EXISTS kyb_records (
  id                          TEXT PRIMARY KEY,
    -- kyb_<ULID>
  state                       TEXT NOT NULL CHECK (state IN ('pending', 'verified', 'rejected', 'pending_info')),
  business_name               TEXT NOT NULL,
  business_type               TEXT NOT NULL CHECK (business_type IN ('sole_proprietor', 'partnership', 'company', 'llp')),
  country_code                TEXT NOT NULL DEFAULT 'KE',
  business_registration_hash  TEXT NOT NULL,
    -- PBKDF2 of normalised business registration number. Cross-account unique
    -- (a registered business can KYB exactly once).
  kra_pin_hash                TEXT NOT NULL,
    -- PBKDF2 of normalised KRA PIN. Cross-account unique.
  rejection_reason            TEXT,
  pending_info_reason         TEXT,
  submitted_by_app_id         TEXT NOT NULL,
    -- HMAC tenant that initiated the KYB (e.g. lipastack). Audit.
  submitted_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verified_at                 TIMESTAMPTZ,
  rejected_at                 TIMESTAMPTZ,
  expires_at                  TIMESTAMPTZ,
    -- KYB re-verification cadence. NULL = no expiry; production likely 365d.
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS kyb_records_state_submitted_idx
  ON kyb_records (state, submitted_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS kyb_records_biz_reg_uniq
  ON kyb_records (business_registration_hash)
  WHERE state = 'verified';

CREATE UNIQUE INDEX IF NOT EXISTS kyb_records_kra_pin_uniq
  ON kyb_records (kra_pin_hash)
  WHERE state = 'verified';

ALTER TABLE kyb_records ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS kyb_directors (
  id                  TEXT PRIMARY KEY,
    -- kybd_<ULID>
  kyb_id              TEXT NOT NULL REFERENCES kyb_records(id) ON DELETE CASCADE,
  director_account_uuid TEXT NOT NULL REFERENCES platform_accounts(id),
  is_signatory        BOOLEAN NOT NULL DEFAULT FALSE,
  ownership_pct       NUMERIC(5, 2),
    -- 0.00 - 100.00; aggregate per kyb_id MAY be ≤ 100 (other shareholders
    -- may exist outside the platform).
  kyc_verified_at_submit BOOLEAN NOT NULL,
    -- Snapshot of whether this director had a verified iprs_lookup at the
    -- time the KYB was submitted. Drives state='pending_info' on submit.
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS kyb_directors_kyb_idx
  ON kyb_directors (kyb_id);

CREATE INDEX IF NOT EXISTS kyb_directors_account_idx
  ON kyb_directors (director_account_uuid);

ALTER TABLE kyb_directors ENABLE ROW LEVEL SECURITY;
