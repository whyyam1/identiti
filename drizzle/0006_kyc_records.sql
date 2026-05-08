-- Identiti — Sprint 6 (Phase 4): KYC artefacts + IPRS verification.
-- Per Instruction Pack §6.2 + Schema Appendix §5 / §17.2.
--
-- Each row is a single KYC artefact. The IPRS lookup flow (§11.2) writes one
-- row per submission. Document / selfie / address-proof artefacts (§11.3-§11.5)
-- write here too when those vendor-backed flows ship.
--
-- ID prefix: `ver_<ULID>` per Schema Appendix §1.2 VerificationArtefactId.
-- State machine §17.2: pending → verified → expired/revoked; pending → failed.
--
-- Apply: psql "$DATABASE_URL" -f drizzle/0006_kyc_records.sql

CREATE TABLE IF NOT EXISTS kyc_records (
  id                       TEXT PRIMARY KEY,
    -- ver_<ULID>
  account_id               TEXT NOT NULL REFERENCES platform_accounts(id),
  kind                     TEXT NOT NULL CHECK (kind IN (
    'iprs_lookup',
    'national_id_front', 'national_id_back',
    'passport_main', 'passport_signed',
    'selfie_liveness',
    'address_proof_utility', 'address_proof_bank_statement',
    'address_proof_tenancy', 'address_proof_government',
    'sanctions_check', 'pep_check',
    'kmpdc_verification', 'business_registration'
  )),
  tier                     TEXT NOT NULL CHECK (tier IN ('tier_1', 'tier_2')),
    -- Which tier this artefact contributes to.
  verification_method      TEXT NOT NULL CHECK (verification_method IN (
    'iprs', 'manual', 'document_scan', 'selfie_liveness', 'address_proof'
  )),
  status                   TEXT NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'verified', 'failed', 'expired', 'revoked')),

  -- Hashed national-ID (PBKDF2 with KYC_HASH_SALT). Raw ID number is never
  -- stored. Indexed for cross-account collision detection (one IPRS-verified
  -- ID per platform).
  national_id_hash         TEXT,
  iprs_verified            BOOLEAN NOT NULL DEFAULT FALSE,
  iprs_verification_ref    TEXT,
    -- IPRS upstream's reference; for audit / re-query.
  iprs_match               TEXT CHECK (iprs_match IN ('full_match', 'partial_match', 'no_match')),
  iprs_confidence_band     TEXT CHECK (iprs_confidence_band IN ('high', 'medium', 'low')),

  sanctions_checked        BOOLEAN NOT NULL DEFAULT FALSE,
  sanctions_check_ref      TEXT,
  pep_checked              BOOLEAN NOT NULL DEFAULT FALSE,
  pep_check_ref            TEXT,

  failure_reason           TEXT,

  verified_at              TIMESTAMPTZ,
  expires_at               TIMESTAMPTZ,
    -- Per §1.9 IprsResponseSummary, IPRS verification expires; re-verify on demand.
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS kyc_records_account_kind_status_idx
  ON kyc_records (account_id, kind, status);

-- Cross-account uniqueness on a verified national ID hash. Permits multiple
-- pending submissions but enforces "one IPRS-verified ID per platform" once
-- a row reaches verified state.
CREATE UNIQUE INDEX IF NOT EXISTS kyc_records_national_id_unique_when_verified
  ON kyc_records (national_id_hash)
  WHERE national_id_hash IS NOT NULL AND status = 'verified';

ALTER TABLE kyc_records ENABLE ROW LEVEL SECURITY;
