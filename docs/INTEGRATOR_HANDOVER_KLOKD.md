# Identiti — Klokd integrator handover (OI-01)

**Integrator:** Klokd (request ticket OI-01). Rail-vs-consumer-app classification TBC; treated as external tenant either way.
**Tenant:** `klokd_sandbox` (external; per-request HMAC, no token exchange).
**Legal entity:** TBC by operator.
**Date:** 6 Jun 2026.
**Owner (Identiti side):** Identiti rail engineering.

---

## TL;DR — what Klokd asked for vs what they get

| Klokd's original ask | What Identiti actually provides | Reason |
|---|---|---|
| `IDENTITI_BASE_URL` (host: `sandbox.api.identiti.co.ke`) | `IDENTITI_API_BASE` (host: Railway-generated URL today; `sandbox.id.identiti.co.ke` later) | Naming alignment + custom domain not wired yet |
| `IDENTITI_API_KEY` (bearer token) | `IDENTITI_APP_ID` + `IDENTITI_APP_SECRET` (per-request HMAC-SHA-256) | **Identiti has no bearer-token mechanism.** Every request is HMAC-signed |
| `IDENTITI_WEBHOOK_SECRET` (HMAC for inbound webhooks) | — (not issued today; ID-14 Phase 2) | v1.0 ships **Kafka only** for cross-rail event delivery |
| Webhook event `KYC_TIER_CHANGED` | `TIER_CHANGED` (Kafka topic `identiti.account.events`) **+** `KYC_APPROVED` (topic `identiti.kyc.events`) | Identiti's tier signal and KYC verdict are separate events |
| Webhook event `SIM_SWAP_DETECTED` | **Does not exist.** Closest is `PHONE_CHANGED` on `identiti.phone.events` | Identiti has no telco-side SIM-swap signal in v1.0; phone changes are the proxy |

---

## TL;DR — env vars for Klokd's Railway

```env
# Identiti sandbox — per-request HMAC, NOT a bearer token
IDENTITI_API_BASE     = <Railway URL — operator hands over with secret>
IDENTITI_APP_ID       = klokd_sandbox
IDENTITI_APP_SECRET   = <64-char hex; from secrets/klokd_sandbox.hmac after seed>

# Webhook secret — DEFERRED to ID-14 Phase 2. Do not set.
# Per-app inbound HMAC for Identiti→Klokd webhooks ships post-Hakken joint
# design session. Until then, keep your /webhooks/identiti receiver
# disabled or returning 503.

# Cross-rail events — Kafka only in v1.0
# Subscribe to the topics for events you care about (see §6).
KAFKA_BROKERS         = <set when shared cluster lands; not wired in sandbox today>
```

JWKS URL: `${IDENTITI_API_BASE}/.well-known/jwks.json` (publishes 2 keys: step-up + delegated-authority).

---

## 1. `IDENTITI_API_BASE` — interim Railway URL

`https://sandbox.id.identiti.co.ke` is the doc-canonical value; **custom domain not yet wired**. Today:

- **Interim:** the Railway-generated URL of the `whyyam1/identiti` deploy (Railway org `kipkiren3`). Operator hands over with the secret.
- **Cutover commitment:** before GA, the custom domain swaps in.

Note: Klokd's original spec said `sandbox.api.identiti.co.ke` — that host is **not** valid. The correct subdomain is `.id.identiti.co.ke` (matches the `IDENTITI_*` env-var prefix and the Rail Contract).

---

## 2. `IDENTITI_APP_SECRET` — secure handover (NOT a bearer token)

There is no API key. The HMAC secret is on disk at `secrets/klokd_sandbox.hmac` (gitignored, 64-char hex) after `pnpm db:seed` ran. Operator:

1. Generate one-time-view link (e.g. https://onetimesecret.com), paste secret value.
2. Send URL to Klokd's secrets-owner via Signal / WhatsApp / Slack.
3. `rm secrets/klokd_sandbox.hmac`.

**Not recoverable in plaintext after delete.** If lost: rotate per `docs/runbooks/key-and-secret-rotation.md §4`.

---

## 3. Scopes granted (7)

```
identiti:customers:read    ✅ GET /v1/customers/* + GET .../kyc/* + POST /v1/phone-tokens
identiti:customers:write   ✅ POST /v1/customers + POST .../kyc/iprs + KYB initiate + rider-KYC submit
identiti:stepup:request    ✅ POST /v1/stepup/challenges
identiti:stepup:verify     ✅ POST /v1/stepup/tokens/validate
identiti:tier:read         ✅ GET /v1/customers/:uuid/tier + .../tier/history
identiti:consent:read      ✅ GET /v1/consent/:account_uuid
identiti:consent:write     ✅ POST /v1/consent/grants + .../revoke
```

Same 7-scope set as Lunch Drop. Forward-compatible for whatever Klokd's use case turns out to be.

---

## 4. mTLS posture — HMAC-over-TLS only in sandbox

No client certificates. Edge-terminated mTLS lands in Stage 1+.

### HMAC envelope (per request, NOT per session)

The exact canonical-string builder Identiti's verifier uses (from `@kmv/platform-shared/hmac`):

```ts
[METHOD.toUpperCase(), pathAndQuery, contentType, timestamp, sha256Hex(body)].join('\n')
```

The verifier reconstructs `contentType` from `request.headers['content-type'] ?? ''`. **For bodyless GETs**, the canonical's CONTENT_TYPE slot MUST be empty `''` (and the request MUST NOT send a `Content-Type` header). For POSTs with a JSON body, use `application/json; charset=utf-8` for both the canonical slot and the actual header.

Reference signer:
```ts
const body = opts.body ?? '';
const contentType = body ? 'application/json; charset=utf-8' : '';
const ts = new Date().toISOString();
const canonical = buildCanonicalString({
  method: opts.method,
  pathAndQuery: opts.url,
  contentType,
  timestamp: ts,
  bodySha256Hex: sha256Hex(body),
});
const signature = signRequest(canonical, IDENTITI_APP_SECRET);
const headers = {
  authorization: `Identiti-HMAC-SHA256 app_id=${IDENTITI_APP_ID}, signature=${signature}`,
  'x-identiti-timestamp': ts,
  ...(contentType ? { 'content-type': contentType } : {}),
  ...(idemKey ? { 'x-idempotency-key': idemKey } : {}),
};
```

**Other envelope items:**
- Auth header format: `Authorization: Identiti-HMAC-SHA256 app_id=klokd_sandbox, signature=<64-hex>`.
- Timestamp header: `x-identiti-timestamp` (RFC 3339 / ISO 8601).
- Idempotency: `X-Idempotency-Key: <opaque>` on every POST / PUT / PATCH / DELETE. 24h TTL. UUIDv4 is fine.
- Replay window: 300 seconds.
- For cross-rail audit join: send `traceparent` (W3C) on every request — Identiti stamps it on every audit row.

---

## 5. ⚠️ The two webhook events Klokd named don't exist as named

Identiti emits **events on Kafka topics**, not HMAC-signed webhooks (yet). Webhook delivery is **ID-14 Phase 2** — ships after the joint design session with Hakken, likely as shared infra across all integrators. Until then:

- Klokd's `/webhooks/identiti/*` receiver should stay 503 / disabled.
- No `IDENTITI_WEBHOOK_SECRET` is issued.
- Event consumption goes via Kafka subscription (see §6).

### 5.1 `KYC_TIER_CHANGED` → two separate events on two separate topics

Identiti models tier moves and KYC verdicts independently. Klokd needs to wire **both**:

| Event Klokd wants | What Identiti actually emits | Topic | When |
|---|---|---|---|
| `KYC_TIER_CHANGED` (in spirit: customer's KYC status changed) | `KYC_APPROVED` | `identiti.kyc.events` | IPRS happy path verifies a customer-KYC artefact |
| | `KYC_REJECTED` | `identiti.kyc.events` | IPRS no-match / partial-match, or operator rejects |
| | `TIER_CHANGED` | `identiti.account.events` | Financial tier moves (tier_0 → tier_1 on KYC, tier_1 → tier_2 on Tier-2 evidence, operator override) |

Payload fields (TIER_CHANGED): `account_uuid`, `from_tier`, `to_tier`, `reason`.
Payload fields (KYC_APPROVED / KYC_REJECTED): `account_uuid`, `artefact_id`, `kind`, `tier` (the artefact's tier-band), `reason?`.

### 5.2 `SIM_SWAP_DETECTED` → does not exist; closest is `PHONE_CHANGED`

Identiti has no telco-side SIM-swap signal in v1.0 (would need an M-Pesa / Safaricom probe vendor that's not wired). The closest concept:

| Event | Topic | When | Payload |
|---|---|---|---|
| `PHONE_CHANGED` | `identiti.phone.events` | A customer completes `POST /v1/customers/:uuid/profile/phone-change/confirm` (step-up + OTP verified) | `account_uuid`, `old_phone_hash`, `new_phone_hash`, `verification_method`, `cooldown_until` |

If Klokd is using this as a fraud signal, note: a `PHONE_CHANGED` event in sandbox represents an authenticated phone change (step-up + OTP). A malicious SIM-swap would have the same on-the-wire shape — defending against that is a step-up policy concern (require very-high-risk step-up for phone change, log + alert on rapid changes), not a different event type.

A real `SIM_SWAP_DETECTED` event would need a telco-side data feed Identiti doesn't have today. If Klokd's risk model needs it, raise it as a sprint ask and we'd source the telco signal.

---

## 6. Kafka topics + event types Klokd can subscribe to

| Topic | Event types | Relevant when |
|---|---|---|
| `identiti.account.events` | `ACCOUNT_CREATED`, `ACCOUNT_SUSPENDED`, `ACCOUNT_REACTIVATED`, `TIER_CHANGED` | Customer lifecycle + tier moves |
| `identiti.kyc.events` | `KYC_APPROVED`, `KYC_REJECTED`, `rider.kyc_verified`, `rider.kyc_rejected` | KYC verdicts (customer + rider) |
| `identiti.kyb.events` | `KYB_VERIFIED`, `KYB_REJECTED`, `KYB_PENDING_INFO` | Business KYB verdicts (LipaStack pattern) |
| `identiti.consent.events` | `CONSENT_GRANTED`, `CONSENT_REVOKED` | Customer consent grants (ID-14 Phase 1) |
| `identiti.step_up.events` | `STEP_UP_REQUIRED` | Step-up challenges issued (carries OTP in sandbox) |
| `identiti.phone.events` | `PHONE_CHANGED` | The closest event to SIM-swap detection |

Convention note: customer-KYC + cross-rail events use `UPPERCASE`. Rider-KYC events use lowercase dotted (`rider.kyc_verified`). Both stable; don't normalise.

**Kafka cluster not wired in sandbox today** — events publish to the in-memory `eventProducer`. When the shared Kafka cluster lands (cross-rail prereq), Klokd will get topic-level access; until then they can't subscribe.

---

## 7. account_uuid lifecycle — minting customers

There's no rail-specific creation endpoint. Klokd creates customers via `POST /v1/customers` (scope: `customers:write`):

1. Body: `{phone, name_first, name_last, consent: {dpa_consent: true, kyc_consent: true, captured_at}, app_correlation}`.
2. Returns `{account_uuid: "acc_<uuid v4>"}` — this is the canonical cross-rail customer key.
3. New customer lands in state `pending_onboarding`. To reach `active` (required for step-up + most operations):
   - **Production path:** `POST /v1/customers/:uuid/kyc/iprs` happy path moves state to `active` and tier to `tier_1`.
   - **Sandbox-only shortcut:** direct Supabase SQL update.

---

## 8. Sandbox OTP retrieval — no SMS bridge; OTP is in the response

There is no SMS dispatch in sandbox. `POST /v1/stepup/challenges` echoes `otp_plaintext` + `sandbox_only: true` in the response when `NODE_ENV != production` AND `factor=phone_otp`:

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

Use `otp_plaintext` as the `response` field of the immediate `POST /v1/stepup/verify` call. Production strips both fields — the SMS gateway becomes the only delivery path.

---

## 9. Operator checklist (Identiti side)

1. ✅ `scripts/seed-tenants.ts` updated with `klokd_sandbox` row (6 Jun 2026, this commit).
2. ✅ `pnpm db:seed` run against Supabase. Row verified via `node scripts/check-tenant.mjs klokd_sandbox` — `external`, `active`, 7 scopes, 64-char secret.
3. ⏳ **Operator (Silvia or Cornelius):** generate one-time-view link with the contents of `secrets/klokd_sandbox.hmac`. Send URL to Klokd's secrets-owner via Signal / WhatsApp / Slack.
4. ⏳ **Operator:** `rm secrets/klokd_sandbox.hmac`.
5. ⏳ **Operator:** also hand Klokd the Railway URL (interim `IDENTITI_API_BASE`).
6. ⏳ **Operator (when known):** confirm Klokd's legal entity + use case + rail-vs-consumer-app classification; update this doc and RECAP §1.1.

---

## References

- [`docs/INTEGRATOR_HANDOVER_LUNCHDROP.md`](INTEGRATOR_HANDOVER_LUNCHDROP.md) — first consumer-app integrator (same template).
- [`docs/INTEGRATOR_HANDOVER_ITAFIKA.md`](INTEGRATOR_HANDOVER_ITAFIKA.md) — first sibling-rail integrator (same template + 6-mismatch catalogue).
- [`docs/INTEGRATION_MAP.md`](INTEGRATION_MAP.md) — Identiti's full cross-rail integration surface.
- [`docs/NEWDOCS_DECISIONS.md`](NEWDOCS_DECISIONS.md) Q4 — consent surface design (ID-14, the path for future webhook delivery).
- [`docs/runbooks/key-and-secret-rotation.md`](runbooks/key-and-secret-rotation.md) — rotation procedure.
