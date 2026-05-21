-- Identiti — ID-12 (Rider-KYC extension for Itafika; newdocs §15).
-- Per docs/NEWDOCS_DECISIONS.md Q1 (confirmed 21 May 2026): rider verification
-- is ORTHOGONAL to the financial 3-tier model. platform_accounts gains a
-- `rider_class` column ('none' / 'rider_tier_1' / 'rider_tier_2'); the
-- financial `tier` column stays untouched by rider-KYC.
--
-- Data model: one submission per attempt; one artefact row per evidence
-- kind (licence / bike / mpesa-probe / insurance). Cross-account uniqueness
-- on the licence-number hash and bike-registration hash (where verified)
-- mirrors the existing kyc_records.national_id_hash pattern.
--
-- Apply: psql "$DATABASE_URL" -f drizzle/0010_rider_kyc.sql

-- Q1 (confirmed): rider_class is orthogonal to financial tier.
ALTER TABLE platform_accounts
  ADD COLUMN IF NOT EXISTS rider_class TEXT
    NOT NULL DEFAULT 'none'
    CHECK (rider_class IN ('none', 'rider_tier_1', 'rider_tier_2'));

CREATE TABLE IF NOT EXISTS rider_kyc_submissions (
  id              TEXT PRIMARY KEY,
    -- rks_<ULID>
  account_uuid    TEXT NOT NULL REFERENCES platform_accounts(id),
  state           TEXT NOT NULL CHECK (state IN ('pending', 'verified', 'rejected')),
  rider_class     TEXT NOT NULL DEFAULT 'none'
    CHECK (rider_class IN ('none', 'rider_tier_1', 'rider_tier_2')),
    -- Aggregate verdict: set when state transitions to 'verified'. tier_1 =
    -- licence + bike + mpesa probe verified; tier_2 = above + insurance.
  rejection_reason TEXT,
  submitted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verified_at     TIMESTAMPTZ,
  rejected_at     TIMESTAMPTZ,
  -- Earliest of any artefact expiry (licence / insurance). Drives the
  -- rider.kyc_expiring_soon + .licence_expired + .insurance_expired cron
  -- events (cron itself is a follow-on ticket).
  expires_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS rider_kyc_submissions_account_state_idx
  ON rider_kyc_submissions (account_uuid, state, submitted_at DESC);

ALTER TABLE rider_kyc_submissions ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS rider_kyc_artefacts (
  id              TEXT PRIMARY KEY,
    -- rka_<ULID>
  submission_id   TEXT NOT NULL REFERENCES rider_kyc_submissions(id),
  account_uuid    TEXT NOT NULL REFERENCES platform_accounts(id),
    -- Denormalised for the cross-account-uniqueness partial-unique indexes
    -- below; the FK to submissions keeps it consistent.
  kind            TEXT NOT NULL CHECK (kind IN (
    'rider_driving_licence',
    'rider_motorbike_registration',
    'rider_mpesa_ownership_probe',
    'rider_insurance'
  )),
  state           TEXT NOT NULL CHECK (state IN ('pending', 'verified', 'rejected')),

  -- Hashed identifiers (PBKDF2 with KYC_HASH_SALT, same pattern as
  -- kyc_records.national_id_hash). NULL when not applicable for the kind.
  licence_number_hash       TEXT,
  bike_registration_hash    TEXT,
  mpesa_msisdn_hash         TEXT,

  -- Kind-specific structured fields (not the raw images — bytes stay in
  -- the encrypted document store via signed-URL refs; Sprint 2+ wires the
  -- actual storage adapter).
  image_ref                 TEXT,
  licence_class             TEXT,
  licence_expiry            TIMESTAMPTZ,
  bike_make                 TEXT,
  bike_model                TEXT,
  insurance_policy_number   TEXT,
  insurance_expiry          TIMESTAMPTZ,

  vendor_ref                TEXT,
    -- NTSA TIMS / insurance vendor reference when a real adapter is wired
    -- (Sprint 2+). Stub mode leaves NULL.
  failure_reason            TEXT,
  verified_at               TIMESTAMPTZ,
  rejected_at               TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS rider_kyc_artefacts_submission_idx
  ON rider_kyc_artefacts (submission_id);

-- Cross-account uniqueness: a verified driving licence cannot belong to two
-- accounts; same for bike registration. Mirror of kyc_records.national_id_hash
-- partial-unique-index pattern. M-Pesa MSISDN is NOT cross-account unique
-- (households legitimately share a number).
CREATE UNIQUE INDEX IF NOT EXISTS rider_kyc_artefacts_licence_uniq
  ON rider_kyc_artefacts (licence_number_hash)
  WHERE kind = 'rider_driving_licence'
    AND state = 'verified'
    AND licence_number_hash IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS rider_kyc_artefacts_bike_uniq
  ON rider_kyc_artefacts (bike_registration_hash)
  WHERE kind = 'rider_motorbike_registration'
    AND state = 'verified'
    AND bike_registration_hash IS NOT NULL;

ALTER TABLE rider_kyc_artefacts ENABLE ROW LEVEL SECURITY;
