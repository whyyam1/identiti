-- Identiti — ID-17 (Operator session + step-up surface; newdocs ID-17).
-- Per docs/NEWDOCS_DECISIONS.md Q3 (settled): operator step-up reuses
-- /v1/stepup/challenges + /v1/stepup/verify with `operation_kind` values
-- of the shape operator.<rail>.<action> and `factor=hardware_key`. This
-- migration lands the storage layer:
--
--   1. operator_users                — per-operator-tenant user identity.
--   2. operator_webauthn_credentials — registered FIDO2/WebAuthn creds.
--   3. auth_challenges extensions    — `operator_user_id` (nullable FK)
--                                      and `factor_data` (JSONB) for the
--                                      WebAuthn server challenge bytes.
--   4. step_up_tokens                — `account_uuid` nullable; new
--                                      `operator_user_id` column. The
--                                      step-up JWT's `sub` claim now may
--                                      be `opu_<ulid>` (operator user)
--                                      OR `acc_<uuid>` (customer); the
--                                      prefix is the discriminator.
--
-- v1.0 ships with a STUB WebAuthn adapter (`WEBAUTHN_STUB_MODE=true`);
-- the real attestation/assertion crypto follows per the
-- IPRS/NTSA/BRS pattern.
--
-- Apply: node scripts/apply-migration.mjs drizzle/0012_operator_session.sql

CREATE TABLE IF NOT EXISTS operator_users (
  id              TEXT PRIMARY KEY,
    -- opu_<ULID>
  app_id          TEXT NOT NULL,
    -- The operator HMAC tenant this user belongs to. e.g. `sandbox_operator`.
  email           TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'disabled')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at   TIMESTAMPTZ,
  CHECK (id ~ '^opu_[0-9A-HJKMNP-TV-Z]{26}$'),
  UNIQUE (app_id, email)
);
CREATE INDEX IF NOT EXISTS operator_users_app_idx ON operator_users (app_id);
ALTER TABLE operator_users ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS operator_webauthn_credentials (
  id                   TEXT PRIMARY KEY,
    -- opc_<ULID>
  user_id              TEXT NOT NULL REFERENCES operator_users(id) ON DELETE CASCADE,
  credential_id_b64    TEXT NOT NULL UNIQUE,
    -- base64url(rawId) emitted by the authenticator.
  public_key_jwk       JSONB NOT NULL,
    -- COSE key reduced to a JWK shape ({kty, alg, crv?, x?, y?, n?, e?}).
  signature_counter    INTEGER NOT NULL DEFAULT 0,
    -- WebAuthn assertion counter (RFC 8809 §6.1.1). Authenticators that
    -- support counters bump this monotonically; v1.0 stub uses 0 throughout.
  attestation_format   TEXT NOT NULL,
    -- e.g. 'none', 'packed', 'tpm', 'stub' (sandbox).
  transports           TEXT[],
    -- usb / nfc / ble / internal — informational.
  display_name         TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS operator_webauthn_credentials_user_idx
  ON operator_webauthn_credentials (user_id);
ALTER TABLE operator_webauthn_credentials ENABLE ROW LEVEL SECURITY;

-- auth_challenges: an operator step-up challenge points at an operator
-- user, not a platform account. `factor_data` carries the WebAuthn
-- server-side challenge bytes for hardware_key challenges (and is unused
-- for phone_otp challenges).
ALTER TABLE auth_challenges
  ADD COLUMN IF NOT EXISTS operator_user_id TEXT REFERENCES operator_users(id),
  ADD COLUMN IF NOT EXISTS factor_data JSONB;

-- Extend the purpose CHECK constraint to recognise the new
-- `operator_webauthn_register` purpose. Drop-and-recreate is the only
-- way to widen a column CHECK in PG. The drop is idempotent: the
-- constraint name is whatever migration 0003 chose, which on this DB
-- is `auth_challenges_purpose_check`.
ALTER TABLE auth_challenges
  DROP CONSTRAINT IF EXISTS auth_challenges_purpose_check;
ALTER TABLE auth_challenges
  ADD CONSTRAINT auth_challenges_purpose_check
    CHECK (purpose IN (
      'login',
      'stepup',
      'phone_change_to_old',
      'phone_change_to_new',
      'operator_webauthn_register'
    ));

CREATE INDEX IF NOT EXISTS auth_challenges_operator_user_idx
  ON auth_challenges (operator_user_id)
  WHERE operator_user_id IS NOT NULL;

-- step_up_tokens: relax account_uuid to nullable, add operator_user_id.
-- The CHECK enforces exactly-one-of so an operator-issued token can't
-- carry a customer subject and vice versa. Drop the FK before relaxing
-- the column (constraint name from PG convention is
-- `step_up_tokens_account_uuid_fkey`).
ALTER TABLE step_up_tokens
  DROP CONSTRAINT IF EXISTS step_up_tokens_account_uuid_fkey;

ALTER TABLE step_up_tokens
  ALTER COLUMN account_uuid DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS operator_user_id TEXT REFERENCES operator_users(id);

-- Re-create the customer-subject FK on the now-nullable column.
ALTER TABLE step_up_tokens
  ADD CONSTRAINT step_up_tokens_account_uuid_fkey
    FOREIGN KEY (account_uuid) REFERENCES platform_accounts(id);

ALTER TABLE step_up_tokens
  ADD CONSTRAINT step_up_tokens_subject_xor
    CHECK ((account_uuid IS NULL) <> (operator_user_id IS NULL));

CREATE INDEX IF NOT EXISTS step_up_tokens_operator_user_exp_idx
  ON step_up_tokens (operator_user_id, exp DESC)
  WHERE operator_user_id IS NOT NULL;
