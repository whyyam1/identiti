-- Identiti — ID-14 (Hakken consent surface; newdocs ID-14).
-- Per docs/NEWDOCS_DECISIONS.md Q4 (settled 21 May 2026): Identiti is the
-- canonical store for cross-app consent. Consuming rails cache 60s and
-- invalidate via webhook / Kafka event.
--
-- Schema follows the tier_history pattern: one row per "consent assignment"
-- (a grant-then-revoke pair). Open grants have `revoked_at IS NULL`. The
-- partial-unique index enforces "at most one open grant per
-- (account_uuid, app_id, scope)" — re-granting the same scope while one is
-- open is a `409 consent_grant_already_open`; the caller must revoke first.
--
-- v1.0 ships the data layer + the read/write endpoints + Kafka events.
-- Webhook delivery (HMAC-signed, retry schedule 30s→24h) is Phase 2 — it
-- requires an outbox + worker pattern. Kafka is the v1.0 propagation path
-- (consistent with how STEP_UP_REQUIRED reaches Todoku).
--
-- The `scope` column is a free-form string in v1.0. Locking the enum to
-- the Hakken-agreed catalogue (`profile:read` / `phone:read` /
-- `payments:read` / etc.) is a Phase-2 hardening pass after the joint
-- design session with Hakken.
--
-- Apply: node scripts/apply-migration.mjs drizzle/0013_consent_grants.sql

CREATE TABLE IF NOT EXISTS consent_grants (
  id                    TEXT PRIMARY KEY,
    -- cgr_<ULID>
  account_uuid          TEXT NOT NULL REFERENCES platform_accounts(id),
  app_id                TEXT NOT NULL,
    -- The app to which consent is granted (i.e. the bearer of the grant).
    -- NOT necessarily the same as `granted_via_app_id` — e.g. a user-facing
    -- profile screen on Itafika grants consent TO Hakken to read profile.
  scope                 TEXT NOT NULL,
    -- Free-form in v1.0; enum-locked in Phase 2 (joint with Hakken).
    -- Example values: 'profile:read', 'phone:read', 'payments:read'.
  granted_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  granted_via_app_id    TEXT NOT NULL,
    -- The HMAC tenant that recorded the grant. Audit-only.
  revoked_at            TIMESTAMPTZ,
  revoked_by_app_id     TEXT,
  revoke_reason         TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT consent_grants_id_chk
    CHECK (id ~ '^cgr_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT consent_grants_revocation_consistent_chk
    CHECK (
      (revoked_at IS NULL AND revoked_by_app_id IS NULL)
      OR
      (revoked_at IS NOT NULL AND revoked_by_app_id IS NOT NULL)
    )
);

-- One open grant per (account, app, scope) — the tier_history pattern.
CREATE UNIQUE INDEX IF NOT EXISTS consent_grants_open_uniq
  ON consent_grants (account_uuid, app_id, scope)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS consent_grants_account_idx
  ON consent_grants (account_uuid, granted_at DESC);

CREATE INDEX IF NOT EXISTS consent_grants_app_idx
  ON consent_grants (app_id, granted_at DESC);

ALTER TABLE consent_grants ENABLE ROW LEVEL SECURITY;
