-- Identiti — Phase 1 universal tables.
-- Per Instruction Pack §3.2 (audit_log), §3.3 (idempotency_keys), §3.4 (app_credentials).
-- Per §3.1 universal conventions: TEXT ULID primary keys, TIMESTAMPTZ, RLS enabled.
--
-- Apply via either:
--   pnpm db:push                      (drizzle-kit, prefers schema.ts)
--   psql "$DATABASE_URL" -f drizzle/0001_initial.sql

CREATE TABLE IF NOT EXISTS app_credentials (
  app_id        TEXT PRIMARY KEY,
  app_name      TEXT NOT NULL,
  tenant_class  TEXT NOT NULL CHECK (tenant_class IN ('internal', 'external')),
  hmac_secret   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  scopes        TEXT[] NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key                TEXT NOT NULL,
  app_id             TEXT NOT NULL,
  request_body_hash  TEXT NOT NULL,
  status_code        INT NOT NULL,
  response_body      JSONB NOT NULL,
  expires_at         TIMESTAMPTZ NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (key, app_id)
);
CREATE INDEX IF NOT EXISTS idempotency_keys_expires_at_idx
  ON idempotency_keys (expires_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id            TEXT PRIMARY KEY,
  app_id        TEXT NOT NULL,
  actor_type    TEXT NOT NULL CHECK (actor_type IN ('app', 'operator', 'system')),
  actor_id      TEXT NOT NULL,
  action        TEXT NOT NULL,
  resource_type TEXT,
  resource_id   TEXT,
  request_id    TEXT NOT NULL,
  traceparent   TEXT,
  ip_address    INET,
  outcome       TEXT NOT NULL CHECK (outcome IN ('success', 'failure')),
  detail        JSONB,
  previous_hash TEXT,
  entry_hash    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS audit_log_app_id_created_at_idx
  ON audit_log (app_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_resource_idx
  ON audit_log (resource_type, resource_id, created_at DESC);

-- Row-level security: defence in depth. The API uses the Supabase service-role
-- key which bypasses RLS by design; these policies mean any path that does NOT
-- carry the service-role context (e.g. anon key, exposed Postgres role) sees
-- nothing. Per Instruction Pack §3.1.
ALTER TABLE app_credentials  ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log        ENABLE ROW LEVEL SECURITY;
