-- Identiti — Sprint 7 (Phase 7): phone-change ledger + step-up consumption tracking.
-- Per Schema Appendix §10.3-§10.4, §17.4 phone-change states, §3.8 errors.
--
-- Phone change flow:
--   1. POST /v1/customers/:uuid/profile/phone-change
--      Inserts phone_changes row in 'cooldown_active' state, generates OTPs,
--      publishes STEP_UP_REQUIRED to Todoku for each OTP target.
--   2. POST /v1/customers/:uuid/profile/phone-change/confirm
--      Verifies OTPs; on success updates phone_records and marks the
--      phone_changes row 'completed', publishes PHONE_CHANGED.
--
-- ALSO adds `consumed_at` to step_up_tokens so a self-consumed step-up token
-- (e.g. for identiti.phone_change) is single-use per Schema Appendix §16.3
-- step 12. Cross-rail consumers (KP, Todoku) maintain their own jti caches.
--
-- Apply: psql "$DATABASE_URL" -f drizzle/0007_phone_changes.sql

ALTER TABLE step_up_tokens
  ADD COLUMN IF NOT EXISTS consumed_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS phone_changes (
  id                       TEXT PRIMARY KEY,
    -- pch_<ULID>
  account_id               TEXT NOT NULL REFERENCES platform_accounts(id),
  state                    TEXT NOT NULL DEFAULT 'cooldown_active'
                           CHECK (state IN ('initiated', 'cooldown_active', 'completed', 'cancelled')),
  verification_method      TEXT NOT NULL
                           CHECK (verification_method IN (
                             'otp_to_old_phone',
                             'otp_to_new_phone_with_step_up_to_old'
                           )),
  -- Bound new phone — same hash + AES-256-GCM ciphertext shape as
  -- phone_records. Stored on the change-row so /confirm can swap it in
  -- without the caller re-supplying the phone (which would also be a fresh
  -- hash collision risk).
  new_phone_hash           TEXT NOT NULL,
  new_phone_encrypted      TEXT NOT NULL,
  -- The OTP challenges (purpose='phone_change_to_old' / 'phone_change_to_new')
  -- live in auth_challenges; we hold the FK pair here.
  challenge_old_id         TEXT REFERENCES auth_challenges(id),
  challenge_new_id         TEXT REFERENCES auth_challenges(id),
  -- The step-up token that authorised the initiate. Recorded for audit.
  authorising_stepup_jti   TEXT NOT NULL,
  -- Awaiting-confirmation deadline: NOW() + 10 minutes at initiate.
  -- After this passes, the change is implicitly cancellable.
  expires_at               TIMESTAMPTZ NOT NULL,
  initiated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at             TIMESTAMPTZ,
  cancelled_at             TIMESTAMPTZ,
  cancel_reason            TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS phone_changes_account_state_idx
  ON phone_changes (account_id, state, expires_at);

ALTER TABLE phone_changes ENABLE ROW LEVEL SECURITY;
