-- Identiti — ID-10 (H4 joint with Helpan AI): delegated-authority signing ledger.
-- Per Helpan AI Delegated Authority Contract v1.0 §6.3 + §8.
--
-- Identiti is the canonical signer for delegated authority tokens (Reboot Pack
-- §A.5: Identiti = OAuth issuance authority; Helpan AI = registry/scope/audit).
-- Helpan AI calls POST /v1/internal/sign with the pre-formed claim set; this
-- table records every issuance for audit + replay-attack diagnostics. The
-- corresponding Authority record (status, revocation, validate-endpoint
-- bookkeeping) lives on the Helpan AI side per §3.4.
--
-- One row per signing event. We persist the claim shape we signed (not the
-- full JWT) so a forensic auditor can reconstruct exactly what Identiti
-- attested to without trusting Helpan AI's copy of the token.
--
-- Apply: psql "$DATABASE_URL" -f drizzle/0008_delegated_authority_signings.sql

-- ALSO extends `auth_challenges` with Amendment §A.1/§A.2 propagation columns
-- so the actor + initiated_by supplied at /v1/stepup/challenges survive the
-- async gap to /v1/stepup/verify. step_up_tokens already carries these from
-- migration 0004; this ALTER closes the gap on the challenge side.
ALTER TABLE auth_challenges
  ADD COLUMN IF NOT EXISTS actor_type TEXT
    CHECK (actor_type IS NULL OR actor_type IN ('human', 'agent')),
  ADD COLUMN IF NOT EXISTS actor_agent_id TEXT,
  ADD COLUMN IF NOT EXISTS actor_delegated_authority_jti TEXT,
  ADD COLUMN IF NOT EXISTS initiated_by TEXT
    CHECK (initiated_by IS NULL OR initiated_by IN ('human', 'agent', 'system'));

CREATE TABLE IF NOT EXISTS delegated_authority_signings (
  jti                  TEXT PRIMARY KEY,
    -- daa_<ULID> per Delegated Authority Contract §2.4; same value as the
    -- signed JWT's jti claim; same value as the Helpan AI Authority.id.

  account_uuid         TEXT NOT NULL REFERENCES platform_accounts(id),
    -- The delegating user (sub claim).

  agent_id             TEXT NOT NULL,
    -- actor.agent_id from the claim payload. Opaque to Identiti; validated
    -- by Helpan AI's agent registry.

  step_up_jti          TEXT REFERENCES step_up_tokens(jti),
    -- Required for high-stakes scopes per §3.5 / §A.2 audit invariant.
    -- NULL for read-only scopes per §3.5.

  scopes               JSONB NOT NULL,
    -- Array of scope objects per §2.5 ({scope_id, amount_limit_minor,
    -- per_period_limit_minor, period, category_whitelist, recipient_whitelist}).

  kid                  TEXT NOT NULL,
    -- Identifies which DA signing key minted the token (e.g. helpan-da-2026-q2).

  signed_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- = iat in the signed JWT.

  expires_at           TIMESTAMPTZ NOT NULL,
    -- = exp in the signed JWT. Per-scope-class bounds enforced at sign time
    -- (≤3600s money, ≤900s identity-sensitive, ≤86400s read-only).

  caller_app_id        TEXT NOT NULL,
    -- HMAC tenant that called /v1/internal/sign. Locked to Helpan AI's app_id
    -- by the route's scope guard, but recorded here for tamper-evident audit.

  traceparent          TEXT,
    -- W3C Trace Context propagation per Reboot Pack §A.11. Cross-rail
    -- correlation join key with Helpan AI's Authority row + KP/Todoku audit
    -- entries that later consume this authority.

  business_op_id       TEXT,
    -- Per Reboot Pack §A.11 audit invariant (§A.2 cross-rail join key).
    -- Optional at v1.0; required at v1.1 once Helpan AI populates it.

  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS delegated_authority_signings_account_signed_idx
  ON delegated_authority_signings (account_uuid, signed_at DESC);

CREATE INDEX IF NOT EXISTS delegated_authority_signings_step_up_idx
  ON delegated_authority_signings (step_up_jti)
  WHERE step_up_jti IS NOT NULL;

CREATE INDEX IF NOT EXISTS delegated_authority_signings_agent_idx
  ON delegated_authority_signings (agent_id);

ALTER TABLE delegated_authority_signings ENABLE ROW LEVEL SECURITY;
