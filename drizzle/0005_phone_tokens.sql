-- Identiti — Sprint 5 (Phase 6): phone_tokens issuance ledger.
-- Per Instruction Pack §6.2 + INTEGRATION_MAP §7.2.
--
-- Phone tokens are opaque HS256 JWTs apps pass to Todoku. Todoku does NOT
-- verify the JWT signature locally — it calls POST /v1/phone-tokens/resolve
-- and treats Identiti's response as authoritative. The signature is
-- defence-in-depth, not the primary trust mechanism; the lookup is.
--
-- Apply: psql "$DATABASE_URL" -f drizzle/0005_phone_tokens.sql

CREATE TABLE IF NOT EXISTS phone_tokens (
  jti           TEXT PRIMARY KEY,
    -- pht_<ULID>; same value carried as the JWT `jti` claim
  account_uuid  TEXT NOT NULL REFERENCES platform_accounts(id),
  audience      TEXT NOT NULL,
    -- v1.0: 'todoku' only. Enforced at handler ingress, not in DB.
  issued_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL,
    -- issued_at + 15 minutes (Reboot Pack §7 ID-D-05; INTEGRATION_MAP §7.2)
  revoked       BOOLEAN NOT NULL DEFAULT FALSE,
  revoked_at    TIMESTAMPTZ,
  revoked_by    TEXT,
    -- app_id of the operator app that revoked
  revoke_reason TEXT
);

CREATE INDEX IF NOT EXISTS phone_tokens_account_active_idx
  ON phone_tokens (account_uuid, revoked, expires_at);

ALTER TABLE phone_tokens ENABLE ROW LEVEL SECURITY;
