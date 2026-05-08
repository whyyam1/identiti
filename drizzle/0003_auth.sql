-- Identiti — Sprint 2 (Phases 3 + 8): authentication and tier signal.
-- Adds auth_challenges, sessions; extends platform_accounts with tier_reason
-- so /v1/customers/{uuid}/tier can return a reason per Schema Appendix §6.1.
--
-- Apply: psql "$DATABASE_URL" -f drizzle/0003_auth.sql
--        (or `pnpm db:push`)

ALTER TABLE platform_accounts
  ADD COLUMN IF NOT EXISTS tier_reason TEXT;

-- One challenge row per /auth/challenges request. Used for both login (Sprint 2)
-- and step-up (Sprint 4) flows; `purpose` distinguishes. Identifier prefix
-- `stp_` per Schema Appendix §1.2 is shared across challenge kinds.
CREATE TABLE IF NOT EXISTS auth_challenges (
  id                  TEXT PRIMARY KEY,
    -- stp_<ULID>
  account_id          TEXT REFERENCES platform_accounts(id),
    -- nullable — challenge may be raised pre-account-resolution by phone hash;
    -- set after we resolve the phone to an account.
  app_id              TEXT NOT NULL REFERENCES app_credentials(app_id),
  factor              TEXT NOT NULL CHECK (factor IN ('phone_otp', 'hardware_key', 'passive_biometric')),
  purpose             TEXT NOT NULL CHECK (purpose IN ('login', 'stepup', 'phone_change_to_old', 'phone_change_to_new')),
  otp_hash            TEXT,
    -- bcrypt; null for hardware_key
  attempts_used       INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'consumed', 'expired', 'failed')),
  expires_at          TIMESTAMPTZ NOT NULL,
  consumed_at         TIMESTAMPTZ,
  intended_operation  TEXT,
    -- Sprint 4: e.g. 'kipkiren_pay.redemption'
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS auth_challenges_account_status_idx
  ON auth_challenges (account_id, status, expires_at);
ALTER TABLE auth_challenges ENABLE ROW LEVEL SECURITY;

-- One row per issued customer JWT. Tracks revocation and is consulted by
-- the bearer-token verification path (Phase 3 follow-up).
CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,
    -- ses_<ULID>
  account_id      TEXT NOT NULL REFERENCES platform_accounts(id),
  jti             TEXT NOT NULL UNIQUE,
  audience        TEXT NOT NULL,
  factors_used    TEXT[] NOT NULL,
  session_kind    TEXT NOT NULL CHECK (session_kind IN ('primary', 'stepup')),
  issued_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL,
  revoked_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS sessions_account_idx
  ON sessions (account_id, expires_at);
CREATE INDEX IF NOT EXISTS sessions_jti_idx
  ON sessions (jti);
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
