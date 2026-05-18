# Runbook — Key and Secret Rotation

Identiti holds five classes of secret. Each rotates differently — a blind
"change them all" breaks live tokens. Procedures below.

| Secret | Where it lives | Blast radius if rotated naïvely |
|---|---|---|
| RS256 step-up key (`JWT_*_PEM`) | Railway env var | All live customer + step-up JWTs fail verification |
| RS256 delegated-authority key (`JWT_DA_*_PEM`) | Railway env var | All live delegated-authority tokens fail |
| Phone-token HS256 key (`PHONE_TOKEN_SIGNING_KEY`) | Railway env var | All live phone tokens fail |
| Crypto keys (`PHONE_ENCRYPTION_KEY`, `PHONE_HASH_SALT`, `KYC_HASH_SALT`) | Railway env var | **Data loss** — see §4 |
| Tenant HMAC secrets (`app_credentials.hmac_secret`) | Database | The affected tenant's requests all 401 |

## 1. RS256 signing keys (step-up + delegated-authority)

Tokens are short-lived (≤30 min customer, ≤5 min step-up, ≤24 h DA). The JWKS
publishes **all** active public keys; the `kid` header selects one. So rotate
with an overlap window — never a hard swap.

1. Generate a new keypair:
   ```sh
   openssl genrsa -out priv.pem 2048
   openssl rsa -in priv.pem -pubout -out pub.pem
   ```
2. Add the new key **alongside** the old one so JWKS serves both. The app's
   `jwtKeys` array already supports multiple keys; the deploy must publish old
   + new through the overlap.
3. Switch *signing* to the new key; keep the old key *published* for at least
   one max-TTL window (24 h covers the longest-lived token) so tokens already
   in flight still verify.
4. After the window, drop the old key from the env / JWKS.
5. For the DA key, also set `JWT_DA_KID` to the new dated value
   (e.g. `helpan-da-2026-q3`) — Helpan AI's verifier parses the kid; coordinate
   per `docs/H4_HELPAN_AI_JOINT.md §1`.

Cadence: 90 days, 24 h overlap (Delegated Authority Contract §6.1). The
automated rotation orchestrator is still a backlog item — today this is manual.

## 2. Phone-token HS256 key

Phone tokens are 15-min TTL and the `/v1/phone-tokens/resolve` DB lookup is the
real trust path (the HS256 signature is defence-in-depth). A hard swap breaks
only tokens issued in the last 15 min.

1. Generate: `openssl rand -hex 32`.
2. Set `PHONE_TOKEN_SIGNING_KEY` in Railway, redeploy.
3. Accept that phone tokens minted in the 15 min before the swap will fail
   resolve — or, for zero disruption, do a 15-min dual-key overlap if the
   signer is extended to support it (v1.1 hardening).

## 3. Tenant HMAC secrets (`app_credentials`)

Per-tenant, independent. Rotating one affects only that tenant.

1. Generate a new secret (`openssl rand -hex 32`).
2. `UPDATE app_credentials SET hmac_secret = '<new>', updated_at = now() WHERE app_id = '<tenant>';`
3. Hand the new secret to that tenant's owner; they must switch in lockstep —
   there is no per-tenant overlap window. Coordinate a cutover.
4. To rotate all sandbox tenants, delete the rows and re-run `pnpm db:seed`
   (it regenerates secrets); then redistribute.

## 4. Crypto keys — handle with care

`PHONE_ENCRYPTION_KEY`, `PHONE_HASH_SALT`, `KYC_HASH_SALT` are **not**
rotatable by a simple env swap:

- `PHONE_ENCRYPTION_KEY` (AES-256-GCM) — changing it makes every stored
  `phone_records.phone_encrypted` ciphertext **undecryptable**. A real rotation
  requires decrypt-with-old then re-encrypt-with-new across every row, ideally
  with an envelope/key-version scheme. Treat the current key as fixed for the
  life of the data unless a migration is built.
- `PHONE_HASH_SALT`, `KYC_HASH_SALT` — changing a salt makes every existing
  hash non-matching, breaking phone-collision and cross-account national-ID
  uniqueness checks. Effectively immutable once data exists.

**Therefore:** set these to strong random values **once, before any real data**,
and store them in a secrets manager. The current sandbox values were generated
in-chat and are placeholders — they MUST be replaced before any non-throwaway
data is written, because after that point they cannot be rotated cleanly.

## 5. Secrets exposed during the 15–18 May sandbox setup

These were surfaced in chat during setup and must be regenerated before the
sandbox is treated as anything more than throwaway:

- Supabase DB password — Supabase dashboard → Database → Reset password →
  update `DATABASE_URL` in Railway + local `.env`.
- The four crypto/token keys (`PHONE_ENCRYPTION_KEY`, `PHONE_HASH_SALT`,
  `PHONE_TOKEN_SIGNING_KEY`, `KYC_HASH_SALT`) — regenerate, but see §4: only
  safe to change while the DB holds no real data. Do this as part of the
  `staging` cutover, on a fresh/empty dataset.
- The four tenant HMAC secrets — §3, or re-seed.

## 6. Quick reference

| Secret | Overlap needed? | Method |
|---|---|---|
| RS256 step-up / DA keys | Yes — 24 h | §1 dual-publish via JWKS |
| Phone-token HS256 key | Optional — 15 min | §2 env swap |
| Tenant HMAC secret | No (coordinate cutover) | §3 `UPDATE` or re-seed |
| Crypto keys | N/A — effectively immutable | §4 — set once, pre-data |
