-- Identiti — backlog item: customer-facing tier history (Schema Appendix §6.4).
-- One row per tier ASSIGNMENT (period the account spent at that tier).
-- The currently-open assignment has ended_at IS NULL; tier transitions close
-- the open row (set ended_at) and insert a new open row in the same tx.
-- A partial unique index enforces at most one open assignment per account.
--
-- No backfill: platform_accounts is empty in the sandbox; new code in
-- CustomersRepo writes the initial tier_0 assignment on account creation.
-- If accounts pre-date this migration, run scripts/backfill-tier-history.ts.
--
-- Apply: psql "$DATABASE_URL" -f drizzle/0009_tier_history.sql

CREATE TABLE IF NOT EXISTS tier_history (
  id            TEXT PRIMARY KEY,
    -- tas_<ULID>
  account_uuid  TEXT NOT NULL REFERENCES platform_accounts(id),
  tier          TEXT NOT NULL CHECK (tier IN ('tier_0', 'tier_1', 'tier_2')),
  reason        TEXT NOT NULL,
    -- Matches the tier-reason vocabulary at src/schemas/tier.ts.
  assigned_at   TIMESTAMPTZ NOT NULL,
  ended_at      TIMESTAMPTZ,
    -- NULL = current/open assignment. Tier transitions set this on the prior
    -- row before inserting the next.
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS tier_history_account_assigned_idx
  ON tier_history (account_uuid, assigned_at DESC);

-- Integrity invariant: at most one open assignment per account.
CREATE UNIQUE INDEX IF NOT EXISTS tier_history_one_open_per_account_idx
  ON tier_history (account_uuid)
  WHERE ended_at IS NULL;

ALTER TABLE tier_history ENABLE ROW LEVEL SECURITY;
