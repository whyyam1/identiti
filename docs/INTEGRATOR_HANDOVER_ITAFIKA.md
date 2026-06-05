# Identiti — Itafika integrator handover

**Integrator:** Itafika (rail #6, logistics-as-a-service). Sibling rail, not a consumer app — but the Identiti-side onboarding is identical to a consumer-app tenant.
**Repo:** github.com/iamkn1ght/itafika
**Dev URL (Itafika side):** https://itafika-production.up.railway.app
**Tenant:** `itafika_sandbox` (external; per-request HMAC, no token exchange).
**Legal entity:** Kirimon Market Ventures.
**Date:** 5 Jun 2026.
**Owner (Identiti side):** Identiti rail engineering.

---

## TL;DR — the 3 env vars

```env
IDENTITI_API_BASE=<see §1>
IDENTITI_APP_ID=itafika_sandbox
IDENTITI_APP_SECRET=<from secrets/itafika_sandbox.hmac after seed; hand over via secure channel>
# No IDENTITI_WEBHOOK_SECRET — webhooks land in ID-14 Phase 2. Per Itafika's
# loader: omit entirely; do not stub. /v1/rails/identiti/events stays at 503.
```

JWKS URL: `${IDENTITI_API_BASE}/.well-known/jwks.json` (publishes 2 keys: step-up + delegated-authority).

---

## 1. `IDENTITI_API_BASE` — interim Railway URL, custom domain later

`https://sandbox.id.identiti.co.ke` is the doc-canonical value but **custom domain is not yet wired**. Today:

- **Interim:** Railway-generated URL of the `whyyam1/identiti` deploy (Railway org `kipkiren3`). Operator hands over with the secret.
- **Cutover commitment:** before GA, custom domain swaps in. Itafika should keep this configurable, not hard-coded.

---

## 2. `IDENTITI_APP_SECRET` — secure handover

The HMAC secret is on disk at `secrets/itafika_sandbox.hmac` (gitignored, 64-char hex) after `pnpm db:seed` ran. Operator:

1. Open the one-time-view link tool (e.g. https://onetimesecret.com), paste the secret value, generate URL.
2. Send URL via WhatsApp / Signal / Slack to Itafika's secrets-owner.
3. `rm secrets/itafika_sandbox.hmac`.

**Not recoverable in plaintext after delete.** If lost: rotate per `docs/runbooks/key-and-secret-rotation.md §4`.

---

## 3. Scopes granted (7) — but two are inert today

```
identiti:customers:read   ✅ unlocks GET /v1/customers/* + GET .../kyc/* + GET .../tier* + POST /v1/phone-tokens
identiti:customers:write  ✅ unlocks POST /v1/customers + POST /v1/kyc/rider/* + POST .../kyc/iprs
identiti:kyc:read         ⚠️ INERT — no route checks this scope today
identiti:kyc:write        ⚠️ INERT — no route checks this scope today
identiti:stepup:request   ✅ unlocks POST /v1/stepup/challenges
identiti:stepup:verify    ✅ unlocks POST /v1/stepup/tokens/validate (verify itself is unguarded)
identiti:tier:read        ✅ unlocks GET /v1/customers/:uuid/tier + .../tier/history
```

**Why `kyc:read` + `kyc:write` are inert:** rider-KYC routes (`/v1/kyc/rider/*`) and the existing IPRS path (`/v1/customers/:uuid/kyc/iprs`) are guarded by `customers:read` / `customers:write` because KYC is a customer-attached resource. The `kyc:*` scopes were granted as asked for forward compatibility — if a future split lands, they're already in Itafika's grant. They do no harm and unlock no extra surface today.

---

## 4. mTLS posture — HMAC-over-TLS only in sandbox

No client certificates. Edge-terminated mTLS lands in Stage 1+ (operator concern; transparent to Itafika).

### HMAC envelope — `@kmv/platform-shared/hmac`

The exact canonical-string builder Identiti's verifier uses:

```ts
[METHOD.toUpperCase(), pathAndQuery, contentType, timestamp, sha256Hex(body)].join('\n')
```

And the verifier reads `request.headers['content-type'] ?? ''` to reconstruct it. **This is the critical alignment point** — see §5.

**Other envelope items:**
- Auth header: `Authorization: Identiti-HMAC-SHA256 app_id=itafika_sandbox, signature=<hex>` (HMAC-SHA-256, 64 hex chars).
- Timestamp header: `x-identiti-timestamp` (RFC 3339 / ISO 8601).
- Idempotency: `X-Idempotency-Key: <opaque>` (UUIDv4 is fine) on every POST/PUT/PATCH/DELETE. 24h TTL.
- Replay window: 300 seconds (`AUTH_HMAC_TOLERANCE_SECONDS=300`). ✅ matches what Itafika assumed.

---

## 5. ⚠️ Wire-contract alignments — fix these before integration tests

Itafika's wire spec has multiple drifts from what Identiti actually exposes. Listed in priority order — Item 1 will blow up immediately, Items 2–5 will show up as 404 / 400 / 422 once a request gets past auth.

### 5.1 GET canonicalization — the alignment Itafika flagged

**Wrong (Itafika's current client):** canonical CONTENT_TYPE = `'application/json'` for ALL requests, no `Content-Type` header sent on GET.

**Right:** for bodyless requests (typically GETs), canonical CONTENT_TYPE = `''` AND no `Content-Type` header sent.

The verifier reads `request.headers['content-type'] ?? ''` and rebuilds the canonical with that. If Itafika signs with `'application/json'` but the verifier sees no header → mismatch → `401 AUTH_HMAC_INVALID` on every GET.

**Fix (one line on Itafika's signer):**
```ts
const contentType = body ? 'application/json; charset=utf-8' : '';
```

Reference fixture: every test in this repo uses that exact line — see `tests/helpers.ts` and any `tests/*.test.ts` `signed()` helper.

### 5.2 Tier endpoint path mismatch

**Wrong (Itafika's spec):** `GET /v1/accounts/{uuid}/tier`
**Right:** `GET /v1/customers/{uuid}/tier`

Identiti's app-facing path is `/v1/customers/*`, not `/v1/accounts/*`. The Rail Contract uses `/v1/accounts` aspirationally; the implementation went the other way (locked in Phase 1 per memory `identiti_phase1_decisions.md` §3 — "Rail Contract wins app-facing"). `/v1/accounts/*` returns 404.

Response shape: `{tier, reason?, assigned_at?, next_review_at?}`. Itafika's `data.tier` read works fine.

### 5.3 POST /v1/kyc/rider/submit body shape

**Wrong (Itafika's spec):**
```json
{ "account_uuid": "acc_...",
  "licence_image_base64": "...",
  "bike_registration_image_base64": "...",
  "insurance_image_base64": "...",
  "mpesa_number": "+254..." }
```

**Right:**
```json
{ "account_uuid": "acc_...",
  "driving_licence":         { "number": "DL12345678", "class": "A", "expiry": "2027-12-31T00:00:00Z", "image_ref": "https://..." },
  "motorbike_registration":  { "number": "KMCA123A",   "make": "Boxer", "model": "150", "image_ref": "https://..." },
  "mpesa_msisdn": "+254712345678",
  "insurance":               { "policy_number": "POL-987654", "expiry": "2027-06-30T00:00:00Z", "image_ref": "https://..." }
}
```

**Why:** Identiti's NTSA / M-Pesa / insurance stubs verify structured fields (`number`, `class`, `expiry`), not image bytes. The stubs don't open the images. Itafika needs to extract those fields from their UI (operator types them, or OCR result) and pass them. `image_ref` is an optional URL/key pointer (not base64) for audit / future-vendor consumption.

Specific field renames:
- `mpesa_number` → `mpesa_msisdn`
- `licence_image_base64` → `driving_licence.image_ref` (and add `.number`, `.class`, `.expiry`)
- `bike_registration_image_base64` → `motorbike_registration.image_ref` (and add `.number`, optional `.make` + `.model`)
- `insurance_image_base64` → `insurance.image_ref` (and add `.policy_number`, `.expiry`)

### 5.4 GET /v1/kyc/rider/{submission_id} response shape

**Wrong (Itafika's spec):**
```
data: { submission_id, status, tier?, licence_valid?, bike_registered?, mpesa_verified?, insurance_valid?, mpesa_number_hash?, rejection_reason? }
```

**Right (actual):**
```
data: { submission_id, account_uuid, state, rider_class, submitted_at, artefacts: [{id, kind, state, ...}], rejection_reason?, verified_at?, rejected_at?, expires_at? }
```

Mapping for Itafika's client:
- `status` → `state` (enum `pending` | `verified` | `rejected`)
- `tier` → `rider_class` (enum `none` | `rider_tier_1` | `rider_tier_2`) — see Q1 in `docs/NEWDOCS_DECISIONS.md`: `rider_class` is orthogonal to the financial `tier`
- `licence_valid` → `artefacts.find(a => a.kind === 'rider_driving_licence').state === 'verified'`
- `bike_registered` → `artefacts.find(a => a.kind === 'rider_motorbike_registration').state === 'verified'`
- `mpesa_verified` → `artefacts.find(a => a.kind === 'rider_mpesa_ownership_probe').state === 'verified'`
- `insurance_valid` → `artefacts.find(a => a.kind === 'rider_insurance').state === 'verified'`
- `mpesa_number_hash` → **NOT exposed**. The hash is stored privately on the artefact row; PII derivatives don't leave the rail.
- `rejection_reason` → present when `state === 'rejected'`

### 5.5 POST /v1/kyc/rider/{submission_id}/retry is a 501 stub today

**Wrong (Itafika's spec):** retry returns `{submission_id, status}`.
**Right:** retry returns `501 NOT_IMPLEMENTED`:
```json
{ "ok": false, "error": { "code": "NOT_IMPLEMENTED", "message": "..." } }
```

Real retry semantics (re-run only the failed artefacts, keep the rest, update state) land alongside the real NTSA / insurance adapters (Sprint 2+ Track A). The route exists so Itafika's URL wiring is final today.

**Workaround:** re-submit via `POST /v1/kyc/rider/submit` with the same `account_uuid`. The cross-account uniqueness check on licence/bike hashes is keyed on `state='verified'`, so a previously-rejected submission doesn't block resubmission.

### 5.6 §A.2 envelope — `x-itafika-*` headers don't propagate; use `traceparent` + body claims

Itafika sends `x-itafika-actor` + `x-itafika-initiated-by` on every call. Identiti's auth plugin does NOT read these (they're ignored). Two separate things to do depending on what Itafika is trying to achieve:

1. **Cross-rail audit join (§A.11 invariant):** send `traceparent` (W3C standard) on every request. Identiti's audit log stamps it onto every row (see `request.traceparent` throughout the route layer). Downstream rails (KP, Todoku) honour it too, so the same `business_op_id` joins across the audit trail.

2. **§A.1/A.2 propagation into the step-up JWT (`actor` + `initiated_by` claims):** put these in the REQUEST BODY of `POST /v1/stepup/challenges`:
   ```json
   { "account_uuid": "acc_...",
     "operation_audience": "...",
     "operation_kind": "...",
     "operation_risk_tier": "high",
     "factor": "phone_otp",
     "actor": { "type": "agent", "agent_id": "agt_...", "delegated_authority_jti": "daa_..." },
     "initiated_by": "agent" }
   ```
   The resulting step-up JWT then carries `actor` + `initiated_by` claims that relying parties read.

---

## 6. Endpoint scope guard reference

| Endpoint | Scope today |
|---|---|
| `POST /v1/customers` | `customers:write` |
| `GET /v1/customers/:uuid` | `customers:read` |
| `POST /v1/customers/:uuid/kyc/iprs` | `customers:write` |
| `GET /v1/customers/:uuid/kyc/artefacts` | `customers:read` |
| **`POST /v1/kyc/rider/submit`** | `customers:write` |
| **`GET /v1/kyc/rider/:submission_id`** | `customers:read` |
| **`POST /v1/kyc/rider/:submission_id/retry`** | `customers:write` |
| **`GET /v1/customers/:uuid/tier`** | `tier:read` |
| `GET /v1/customers/:uuid/tier/history` | `tier:read` |
| `POST /v1/stepup/challenges` | `stepup:request` |
| `POST /v1/stepup/verify` | (unguarded — challenge_id is the credential) |
| `POST /v1/stepup/tokens/validate` | `stepup:verify` |
| `POST /v1/phone-tokens` | `customers:read` (yes — producer side is read-shaped) |

---

## 7. account_uuid lifecycle — rider creation

There is **no rider-specific creation endpoint**. Riders are customers; the `rider_class` dimension gets set when rider-KYC verifies.

Flow:

1. `POST /v1/customers` with the rider's `phone`, `name_first`, `name_last`, `consent: {dpa_consent: true, kyc_consent: true, captured_at}`, `app_correlation`. Scope: `customers:write`. Returns `{account_uuid: "acc_<uuid v4>"}`.
2. New customer lands in state `pending_onboarding`. They need to reach `active` before step-up works:
   - **Production path:** `POST /v1/customers/:uuid/kyc/iprs` happy path activates the account-state side-effect (tier_0 → tier_1, state → active).
   - **Sandbox-only shortcut:** direct Supabase SQL update — `UPDATE platform_accounts SET status='active' WHERE id='acc_...'`. Convenient for tests where IPRS isn't the point.
3. `POST /v1/kyc/rider/submit` with the `account_uuid` + the structured artefact fields per §5.3. Sandbox stubs return verified on a clean shape, rejected on bad shapes.
4. On `state === 'verified'`, the account's `rider_class` is promoted to `rider_tier_1` (basic) or `rider_tier_2` (with insurance). Tier signal (`/v1/customers/:uuid/tier`) is **untouched** — `rider_class` is orthogonal per `NEWDOCS_DECISIONS.md` Q1.

---

## 8. KYC events — Kafka only in v1.0

Topic: `identiti.kyc.events`. Event types Itafika cares about:

| Type | When | Payload (selected fields) |
|---|---|---|
| `rider.kyc_verified` | `POST /v1/kyc/rider/submit` returns `state='verified'` | `account_uuid`, `submission_id`, `rider_class` |
| `rider.kyc_rejected` | Same returns `state='rejected'` | `account_uuid`, `submission_id`, `rider_class` (= 'none'), `rejection_reason` |
| `KYC_APPROVED` | IPRS path lands `tier_1` (relevant if Itafika also reads customer-KYC) | `account_uuid`, `kind='iprs_lookup'`, `tier` |
| `KYC_REJECTED` | Operator rejects a customer-KYC artefact | `account_uuid`, `artefact_id`, `reason` |
| `TIER_CHANGED` | (separate topic `identiti.account.events`) when financial tier moves | `account_uuid`, `from_tier`, `to_tier`, `reason` |

Convention note: rider events are `rider.kyc_verified` / `rider.kyc_rejected` (lowercase, dotted). Customer-KYC + cross-rail events use `UPPERCASE` (`KYC_APPROVED`, `TIER_CHANGED`, `CONSENT_GRANTED`, etc.). Different vintages; both stable. Don't normalise.

**Webhook delivery + signing is deferred to ID-14 Phase 2** (joint design with Hakken before HK-3/HK-4). Itafika's `/v1/rails/identiti/events` receiver staying at 503 is the right posture — no webhook secret is issued today.

---

## 9. Sandbox OTP retrieval — no MSISDN whitelist; OTP is in the response

There is **no SMS dispatch in sandbox** and **no phone-whitelist concept** on Identiti's side. `+254700000002` (or any E.164) is fine to use as the rider's phone — Identiti hashes it and binds to the account; cross-account uniqueness applies.

The OTP comes back two ways in sandbox:

1. **In the `POST /v1/stepup/challenges` response body** (added 22 May 2026 for integrator end-to-end testing):
   ```json
   { "ok": true,
     "data": {
       "challenge_id": "stp_01J...",
       "factor": "phone_otp",
       "expires_at": "...",
       "delivery_status": "dispatched",
       "otp_plaintext": "317492",
       "sandbox_only": true } }
   ```
   Use `otp_plaintext` as the `response` field of the immediate `POST /v1/stepup/verify` call. **Production strips both `otp_plaintext` and `sandbox_only`** — the SMS gateway becomes the only delivery path. Itafika's integration code should accept these as optional and gracefully fall back to "wait for SMS" when not present.

2. **In the `STEP_UP_REQUIRED` Kafka payload** (if Itafika is subscribed to `identiti.step_up.events`): `data.otp_plaintext`. Same value as the response echo.

When Todoku TD-2 (the SMS bridge) lands, production OTPs will be SMS-delivered. Today they aren't.

---

## 10. Operator checklist (Identiti side)

1. ✅ `scripts/seed-tenants.ts` updated with `itafika_sandbox` row (this commit).
2. ✅ `pnpm db:seed` run against Supabase (5 Jun 2026). Row verified via `node scripts/check-tenant.mjs itafika_sandbox` — `external`, `active`, 7 scopes, 64-char secret.
3. ⏳ **Operator (Silvia or Cornelius):** generate a one-time-view link with the contents of `secrets/itafika_sandbox.hmac` (e.g. https://onetimesecret.com). Send the URL to Itafika via Signal / WhatsApp / Slack.
4. ⏳ **Operator:** `rm secrets/itafika_sandbox.hmac`.
5. ⏳ **Operator:** also hand Itafika the Railway URL (interim `IDENTITI_API_BASE`).

---

## References

- [`docs/INTEGRATOR_HANDOVER_LUNCHDROP.md`](INTEGRATOR_HANDOVER_LUNCHDROP.md) — first integrator handover; same template.
- [`docs/INTEGRATION_MAP.md`](INTEGRATION_MAP.md) — Identiti's full cross-rail integration surface.
- [`docs/NEWDOCS_DECISIONS.md`](NEWDOCS_DECISIONS.md) Q1 — `rider_class` orthogonal to financial `tier`.
- [`docs/runbooks/key-and-secret-rotation.md`](runbooks/key-and-secret-rotation.md) — rotation procedure if the secret is lost or exposed.
- [`src/routes/riderKyc.ts`](../src/routes/riderKyc.ts) — actual rider-KYC implementation.
- [`src/schemas/riderKyc.ts`](../src/schemas/riderKyc.ts) — actual request/response schemas.
