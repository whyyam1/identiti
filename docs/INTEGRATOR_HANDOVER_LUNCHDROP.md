# Identiti — Lunch Drop integrator handover

**Integrator:** Lunch Drop (Lunch Drop Limited, a Kirimon Market Ventures company) — food-delivery consumer app, Westlands pilot. First consumer app riding the KMV rails.
**Tenant:** `lunchdrop_sandbox` (external; same posture as a rail sandbox tenant).
**Date:** 22 May 2026.
**Owner (Identiti side):** Identiti rail engineering.
**Audience:** Lunch Drop engineering, integrating sandbox today.

---

## TL;DR — the 4 env vars

```env
IDENTITI_API_BASE=<see §1>
IDENTITI_APP_ID=lunchdrop_sandbox
IDENTITI_APP_SECRET=<from secrets/lunchdrop_sandbox.hmac after seed; hand over via 1Password>
# IDENTITI_WEBHOOK_SECRET intentionally omitted — webhooks land in ID-14 Phase 2
```

JWKS URL: `${IDENTITI_API_BASE}/.well-known/jwks.json` (publishes 2 keys: step-up + delegated-authority).

---

## 1. `IDENTITI_API_BASE` — interim Railway URL, custom domain later

The doc-canonical value is `https://sandbox.id.identiti.co.ke`, but the **custom domain is not yet wired** (see RECAP §1.1 — DNS CNAME + Railway custom-domain config pending). Today:

- **Interim:** the Railway-generated URL of the `whyyam1/identiti` deploy on Railway (org `kipkiren3`). Operator (Cornelius) hands this over with the secret.
- **Cutover commitment:** before GA, `sandbox.id.identiti.co.ke` will be wired and the env var swapped. Lunch Drop should treat the base URL as configurable, not hard-coded.

---

## 2. `IDENTITI_APP_SECRET` — secure handover

The HMAC secret is minted by `pnpm db:seed` (idempotent — `ON CONFLICT DO NOTHING`). On a fresh seed of `lunchdrop_sandbox`:

1. The script writes the secret to `secrets/lunchdrop_sandbox.hmac` (gitignored, `chmod 0600`) and prints the path — **not the value** — to stdout.
2. Operator opens that file, copies the secret into 1Password (item: `KMV / Identiti / lunchdrop_sandbox HMAC`).
3. `rm secrets/lunchdrop_sandbox.hmac`.
4. Hand over the 1Password share to Lunch Drop's secrets owner.

**Important:** the secret is not recoverable in plaintext after the file is deleted. If lost: rotate per `docs/runbooks/key-and-secret-rotation.md §4` (re-seed under a different `app_id` or alter the row directly).

---

## 3. Granted scopes (7)

```
identiti:customers:read
identiti:customers:write
identiti:stepup:request
identiti:stepup:verify
identiti:tier:read
identiti:consent:read
identiti:consent:write
```

Dropped from the 10-scope universe:
- `identiti:operator` (sandbox-only operator console; not a Lunch Drop concern)
- `identiti:internal:sign:delegated_authority` (Helpan AI hard-pin)
- `phone_token:resolve` (Todoku rail-internal — Lunch Drop is the **producer** of phone tokens via `POST /v1/phone-tokens`, which uses `identiti:customers:read`)

### Scope → endpoint map

| Scope | Endpoints |
|---|---|
| `customers:read` | `GET /v1/customers/:uuid`, `GET .../kyc/artefacts(/:id)`, **`POST /v1/phone-tokens` (issue side)**, `GET /v1/customers/:uuid/profile/phone-change/*` |
| `customers:write` | `POST /v1/customers`, `POST .../kyc/iprs`, `POST /v1/kyc/rider/submit`, `POST /v1/kyb/initiate`, `POST .../phone-change`, `POST .../phone-change/confirm` |
| `stepup:request` | `POST /v1/stepup/challenges` |
| `stepup:verify` | `POST /v1/stepup/verify` (no scope guard today — listed for symmetry), `POST /v1/stepup/tokens/validate` (diagnostic) |
| `tier:read` | `GET /v1/customers/:uuid/tier`, `GET .../tier/history` |
| `consent:read` | `GET /v1/consent/:account_uuid[?include=revoked]` |
| `consent:write` | `POST /v1/consent/grants`, `POST .../revoke` |

---

## 4. mTLS posture — HMAC-over-TLS only in sandbox

No client certificates. Edge-terminated mTLS lands in Stage 1+ (operator concern; transparent to Lunch Drop).

### HMAC envelope

Per `@kmv/platform-shared/hmac`:

- `X-Identiti-Timestamp: <RFC 3339>` — replay window 300 s.
- `Authorization: Identiti-HMAC-SHA256 app_id=lunchdrop_sandbox, signature=<hex>`
- Canonical string: `method\npath_and_query\ncontent_type\ntimestamp\nbody_sha256_hex` (uppercase HMAC of this with the shared secret).
- `X-Idempotency-Key: <opaque>` required on every POST/PUT/PATCH/DELETE — 24h TTL.

Pre-built signer: `@kmv/platform-shared/hmac` exports `buildCanonicalString` + `signRequest` (used by every test in this repo — Lunch Drop can either depend on `@kmv/platform-shared` directly or port the ~30-line signer).

---

## 5. Phone-token producer side — for the Todoku send pipeline

When Lunch Drop sends an SMS via Todoku, Todoku needs a `recipient_token` — a Lunch-Drop-issued phone token referencing the recipient's Identiti account. The flow:

1. Lunch Drop calls `POST /v1/phone-tokens` with `{account_uuid, audience: "todoku"}` (scope: `identiti:customers:read` — already granted, no 8th scope needed).
2. Identiti returns `{phone_token, jti, audience, expires_at}` — HS256 opaque JWT, `pht_<ULID>` jti, 15-min TTL.
3. Lunch Drop passes `phone_token` to Todoku as `recipient_token`.
4. Todoku calls `POST /v1/phone-tokens/resolve` (Todoku-only scope `phone_token:resolve`) to get the encrypted MSISDN at send time.

The single master signing key is in `PHONE_TOKEN_SIGNING_KEY`; per-account-per-audience derived keys are v1.1 hardening (not Lunch Drop's concern).

**Blocked by Todoku TD-2.** Producer side (Identiti, Lunch Drop) is live today; consumer side (Todoku `/resolve`) needs TD-2 deployed. Lunch Drop can mint + cache tokens today and exercise the producer surface immediately.

---

## 6. OTP sandbox-retrieval — Option A shipped 22 May 2026

`POST /v1/stepup/challenges` now echoes the OTP in the response **when `NODE_ENV != production` AND `factor=phone_otp`**:

```json
{
  "ok": true,
  "data": {
    "challenge_id": "stp_01J...",
    "factor": "phone_otp",
    "expires_at": "2026-05-22T...",
    "delivery_status": "dispatched",
    "otp_plaintext": "317492",
    "sandbox_only": true
  },
  ...
}
```

Use `otp_plaintext` as the `response` field of the immediate `POST /v1/stepup/verify` call. This unblocks end-to-end testable buyer signup without a Todoku→SMS bridge wired.

**Production strips both `otp_plaintext` and `sandbox_only`.** The SMS gateway (via Todoku) becomes the only delivery path. Lunch Drop integration code should accept the field as optional and gracefully fail back to "wait for SMS" when not present — this is the only env-conditional shape difference Lunch Drop will see.

Mirrors the `otp_plaintext` already on the `STEP_UP_REQUIRED` Kafka payload in non-prod — same security boundary, same env-gate.

---

## 7. Webhooks — not in v1.0

`IDENTITI_WEBHOOK_SECRET` is intentionally omitted from the env block. Identiti does NOT sign outbound webhooks today.

- Events flow via **Kafka topics**: `identiti.account.events`, `identiti.kyc.events`, `identiti.kyb.events`, `identiti.consent.events`, `identiti.step_up.events`, `identiti.phone.events`.
- Webhook delivery (HMAC-signed, 30s→24h retry schedule) is ID-14 Phase 2, ships after the joint design session with Hakken — likely shared infrastructure across all consumer apps. Lunch Drop's `https://kalunchstaging-production.up.railway.app/webhooks/identiti/*` callback base is noted and will be wired then.

Sandbox today: Lunch Drop polls the read endpoints (e.g. `GET /v1/consent/:account_uuid` with `Cache-Control: private, max-age=60`) or, if Kafka is wired on the consumer side, subscribes to the topics directly.

---

## 8. Test data + sandbox flow

Recommended smoke test once the secret lands:

1. `POST /v1/customers` — create a test customer. New customers land in `pending_onboarding` (state). Identiti returns `account_uuid` of the shape `acc_<uuid v4>`.
2. To exercise step-up, the customer must be `state=active`. Today that requires either:
   - The `POST /v1/customers/:uuid/kyc/iprs` happy path (IPRS stub default-returns `full_match` for any unknown `national_id`; tier_0 → tier_1 promotion automatically activates the account-state side-effect), **or**
   - A direct DB update via Supabase SQL editor (sandbox-only convenience).
3. `POST /v1/stepup/challenges` with `factor=phone_otp` + a customer-side `operation_kind` (e.g. `kipkiren_pay.redemption`) — read `otp_plaintext` from the response.
4. `POST /v1/stepup/verify` with `{challenge_id, response: "<the otp>"}` — get a step-up JWT. Validate locally against `/.well-known/jwks.json`.
5. `POST /v1/consent/grants` — record a consent (`app_id`, `scope`); `GET /v1/consent/:account_uuid` to read.

No SMS gateway in the loop. No phone whitelist — OTP comes from the response (or the Kafka payload if Kafka is wired).

---

## 9. Things Lunch Drop should also know

- **Account UUID is canonical** across all rails. Treat it as your shared customer key, not your internal Lunch Drop user_id.
- **Tier signal:** `GET /v1/customers/:uuid/tier` returns `Cache-Control: private, max-age=60`. Lunch Drop's risk-engine should respect that cadence; on a tier-promotion the `TIER_CHANGED` Kafka event invalidates earlier (if Lunch Drop is consuming Kafka).
- **No long-lived bearer tokens.** Every request is HMAC-signed; there is no `Bearer` JWT for app-to-Identiti calls. The step-up JWT is a per-operation freshness proof (TTL 60–600 s by risk tier).
- **Idempotency:** every POST must carry `X-Idempotency-Key`. Replaying the same key returns the same response within the 24h TTL window.

---

## 10. Operator checklist (Identiti side)

What still needs to happen for Lunch Drop to be operational:

1. ✅ `scripts/seed-tenants.ts` updated with `lunchdrop_sandbox` row (committed 22 May 2026).
2. ✅ Supabase project resumed (operator action, 3 Jun 2026).
3. ✅ `pnpm db:seed` run against Supabase (3 Jun 2026). Row verified via `node scripts/check-tenant.mjs lunchdrop_sandbox`:
   - `app_id: lunchdrop_sandbox`, `tenant_class: external`, `status: active`, 7 scopes, 64-char HMAC secret.
   - Secret on disk at `secrets/lunchdrop_sandbox.hmac` (gitignored).
4. ⏳ **Operator (Silvia or Cornelius):** move `secrets/lunchdrop_sandbox.hmac` into 1Password — item: `KMV / Identiti / lunchdrop_sandbox HMAC`. Then `rm secrets/lunchdrop_sandbox.hmac`.
5. ⏳ **Operator:** hand the Railway URL (interim `IDENTITI_API_BASE`) + the 1Password share to Lunch Drop.

---

## References

- [`docs/INTEGRATION_MAP.md`](INTEGRATION_MAP.md) — Identiti's full cross-rail integration surface.
- [`docs/RAILWAY_DEPLOY.md`](RAILWAY_DEPLOY.md) — env-var matrix for the deployed instance.
- [`docs/runbooks/key-and-secret-rotation.md`](runbooks/key-and-secret-rotation.md) — rotation procedure.
- [`docs/NEWDOCS_DECISIONS.md`](NEWDOCS_DECISIONS.md) Q4 — consent surface design rationale (ID-14).
- [`docs/H4_HELPAN_AI_JOINT.md`](H4_HELPAN_AI_JOINT.md) — delegated-authority signing contract (ID-10; reference, not used by Lunch Drop).
