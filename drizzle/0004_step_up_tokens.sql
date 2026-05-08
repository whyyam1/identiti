-- Identiti — Sprint 4 (Phase 5): step-up token issuance ledger.
-- Per Schema Appendix §16 (canonical JWT form) + Amendment §A.1 (`actor`,
-- `initiated_by` propagation columns landed at table birth so ID-10 H4 has
-- nothing to migrate when Helpan AI delegated-authority issuance starts).
--
-- The JTI equals the challenge_id per Schema Appendix §14.5 — single-use
-- enforcement at issuance is the PRIMARY KEY uniqueness; consuming rails
-- (KP, Todoku) enforce single-use again on their own side per §16.3 step 12.
--
-- ALSO extends `auth_challenges` with the operation_audience and
-- operation_risk_tier the /v1/stepup/challenges caller supplied, so /verify
-- can reissue the JWT bound to the audience the customer authorised against.
-- Both columns are nullable; login challenges (purpose='login') leave them
-- NULL.
--
-- Apply: psql "$DATABASE_URL" -f drizzle/0004_step_up_tokens.sql
--        (or `pnpm db:push`)

ALTER TABLE auth_challenges
  ADD COLUMN IF NOT EXISTS operation_audience TEXT,
  ADD COLUMN IF NOT EXISTS operation_risk_tier TEXT
    CHECK (operation_risk_tier IS NULL
           OR operation_risk_tier IN ('low', 'medium', 'high', 'very_high'));

CREATE TABLE IF NOT EXISTS step_up_tokens (
  jti                       TEXT PRIMARY KEY,
    -- = challenge_id (Schema Appendix §14.5); shape stp_<ULID> per §1.2
  account_uuid              TEXT NOT NULL REFERENCES platform_accounts(id),
  challenge_id              TEXT NOT NULL REFERENCES auth_challenges(id),
  audience                  TEXT NOT NULL,
    -- The single operation_audience value, e.g. https://api.pay.kipkiren.com
  operation_kind            TEXT NOT NULL,
    -- §1.8 OperationKind enum (validated at handler ingress)
  operation_risk_tier       TEXT NOT NULL CHECK (operation_risk_tier IN ('low', 'medium', 'high', 'very_high')),
  factor                    TEXT NOT NULL CHECK (factor IN ('phone_otp', 'hardware_key', 'passive_biometric')),
  env                       TEXT NOT NULL,

  -- Amendment §A.1 (Identiti Schema Appendix) — agentic-AI propagation.
  -- All four are NULLable in v1.0; populated by ID-10 H4 joint contract once
  -- Helpan AI dispatches step-ups with delegated-authority context.
  actor_type                TEXT CHECK (actor_type IN ('human', 'agent')),
  actor_agent_id            TEXT,
  delegated_authority_jti   TEXT,
  initiated_by              TEXT CHECK (initiated_by IN ('human', 'agent', 'system')),

  iat                       TIMESTAMPTZ NOT NULL,
  exp                       TIMESTAMPTZ NOT NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS step_up_tokens_account_exp_idx
  ON step_up_tokens (account_uuid, exp DESC);

CREATE INDEX IF NOT EXISTS step_up_tokens_delegated_authority_idx
  ON step_up_tokens (delegated_authority_jti)
  WHERE delegated_authority_jti IS NOT NULL;

ALTER TABLE step_up_tokens ENABLE ROW LEVEL SECURITY;
