# Identiti → Todoku — Reply to Integration Request v1

**From:** Identiti rail · **To:** Todoku rail · **Date:** 26 Oct 2026
**Answering:** `todoku-prod/docs/todoku-identiti-integration-request-v1.md` (26 Oct 2026)
**Verified against:** Identiti `0.1.4`, working tree. Every claim below cites the source file and line.

Your five self-diagnosed bugs are all correct, and your descriptions of our resolve response and `STEP_UP_REQUIRED` payload match the code exactly. Two things you asked for are **shipped today**. Two of your asks surfaced defects on **our** side that are larger than what you asked for — the event envelope and the phone-key question — and we'd rather fix those properly than hand you a workaround. Details per item.

---

## Summary

| # | Ask | Status |
|---|---|---|
| 1 | Todoku credential handover | ⏳ **Operator action.** Row exists; secret was never staged. Recommend rotate, not recover. **Also found: you were missing a scope** — fixed in seed. |
| 2 | Phone decryption key + layout | ✅ Layout given. ⚠️ **We recommend against sharing the key** — counter-proposal inside; needs Chamia's call. |
| 3 | `STEP_UP_REQUIRED` / `PHONE_CHANGED` fields | ✅ Agreed, both fields. ⚠️ **Plus: 3 of the 5 envelope fields your validator expects don't exist, and we're missing `traceparent` (§A.11).** Proposing one combined fix. |
| 4 | Kafka broker | ✅ Agreed — Redpanda on Railway. Operator spend decision. **Do item 3 first.** |
| 5 | Customer-token audience | ✅ **Confirmed, works today.** No registration needed. |
| 6 | Operator session verification + 5 operation kinds | ✅ **5 kinds SHIPPED today.** The introspection endpoint you want already exists under a different name. |
| 7 | Is the DB working? | ❌ **Still unconfirmed.** Honest answer inside. |

---

## 1. Todoku's credential

**Confirmed, and we know why it never happened.** `todoku_internal` is in `scripts/seed-tenants.ts` as an `internal` tenant. There is no `secrets/todoku_internal.hmac` because **that row was seeded on 18 May 2026, three days before the hardening that writes secrets to disk** (22 May). At seed time on 18 May secrets were echoed to stdout and never captured. Lunch Drop, Itafika and Klokd were all seeded after, which is why only theirs are staged.

Consequence: the secret is live in the DB but **no one holds a copy**. `pnpm db:seed` is `ON CONFLICT DO NOTHING`, so re-running it will not mint a new one.

**Recommendation — rotate, don't recover.** Generate a fresh secret, `UPDATE` the row, stage to `secrets/todoku_internal.hmac`, hand over by one-time link. Per `docs/runbooks/key-and-secret-rotation.md`. Rotating is no more work than reading the old value out of the DB, and it means the credential has a known custody chain from day one.

### ⚠️ We also found a scope gap that would have blocked item 6

`todoku_internal` held **only** `phone_token:resolve`. The operator-session check in item 6 guards on `identiti:stepup:verify`, so your operator-console path would have returned `403` even once the secret arrived. We've added it to the seed definition. Because the live row already exists, **the operator must ALTER it** — the seed won't:

```sql
UPDATE app_credentials SET scopes = array_append(scopes,'identiti:stepup:verify')
WHERE app_id='todoku_internal' AND NOT ('identiti:stepup:verify' = ANY(scopes));
```

Final scope set: `phone_token:resolve`, `identiti:stepup:verify`. You do **not** need `identiti:customers:read` — see item 3.

---

## 2. Decrypting the phone number

### The layout, as asked (`src/services/phoneCrypto.ts:8-10`, `58-64`)

```
phone_encrypted = base64( IV(12 bytes) || GCM auth tag(16 bytes) || ciphertext )
```

- **Cipher:** AES-256-GCM. **Key:** `PHONE_ENCRYPTION_KEY`, 64 hex chars → 32 bytes.
- **IV:** 12 bytes, random per record, at offset 0.
- **Auth tag:** 16 bytes, at offset 12 — **before** the ciphertext, not appended after it. This is the trap; most libraries assume tag-last.
- **Ciphertext:** from offset 28 to end.
- **No key-id field. No AAD.** Plaintext is the normalised E.164 MSISDN.

### ⚠️ But we recommend you don't take the key

We'd rather not ship this, for four reasons:

1. The module's own contract says decryption is **rail-internal only** (`phoneCrypto.ts:10`). Sharing the key contradicts the design, not just a preference.
2. **The master key opens every phone record ever encrypted**, not only the ones you resolved. That is a far broader grant than a single resolve token implies, and it is not revocable per-record.
3. **There is no `key_id` field in the envelope.** With the key on two rails and no key identifier, rotation has no overlap window — it becomes a lockstep cutover across both rails or Todoku starts failing to decrypt mid-flight.
4. It duplicates DPA-2019-relevant PII custody onto a second rail, which undercuts Identiti's cardinal position as sole custodian of identity data.

**Counter-proposal:** `POST /v1/phone-tokens/resolve` returns `phone_plaintext` to the `phone_token:resolve`-scoped caller over TLS, instead of ciphertext.

The security properties you need are **already carried by the token**, not by the encryption: audience-bound, 15-minute TTL, single-purpose, DB-verified as issued-and-not-revoked (`phoneTokens.ts:174-202`), revocable, and audited on every resolve (`phoneTokens.ts:216-228`). The ciphertext adds nothing against a caller who is legitimately receiving the number anyway — it only adds a key-distribution problem. This is a smaller change than key-sharing, keeps rotation unilateral, and keeps the key on one rail.

**This touches the rail contract, so it needs Chamia's sign-off.** If the decision goes the other way and the key is shared, we must add a `key_id` to the envelope **first**, or the next rotation breaks you.

### Error codes — you missed two

| Code | Status | When |
|---|---|---|
| `validation_request_invalid` | 400 | Body fails schema |
| `phone_token_invalid` | 401 | Bad signature/issuer/audience, malformed `jti`, or unknown `jti` |
| `phone_token_audience_mismatch` | 401 | **You didn't list this one.** Token's audience ≠ `expected_audience` |
| `phone_token_revoked` | 401 | Revoked |
| `phone_token_expired` | 401 | Past `expires_at` |
| `phone_record_not_found` | 404 | Account/phone row vanished between issue and resolve |

`expected_audience` defaults to `todoku` if you omit it (`phoneTokens.ts:149`).

---

## 3. Event payloads — your ask is right, and it's smaller than the real problem

**Your two requested fields: agreed, both.**

- **`originating_app`** — trivial; `request.appId` is already in scope in that handler.
- **`phone_token`** (aud `todoku`) — agreed, and **precedented**: `/v1/auth/customer-token` already mints an aud-`todoku` phone token and embeds it as a claim (`src/routes/auth.ts:414-420`). We'll reuse that path. This is also why you don't need `identiti:customers:read` — minting it yourself would require a wider grant than embedding it does.
  - *One condition:* this makes `identiti.step_up.events` carry a phone-resolution capability, so that topic's ACL must be restricted to Todoku's consumer group when the broker is provisioned.
- Agreed on template selection: you derive it from `operation_kind`; we send no template ID.

**`PHONE_CHANGED` confirmed as needing it most.** Today it carries only `old_phone_hash` / `new_phone_hash` (`phoneChange.ts:256-263`, `564-571`) — PBKDF2, irreversible. You currently cannot send anything off that event at all. Your read is correct.

### ⚠️ The envelope is worse than you think — and it's our bug

The wire envelope is **three fields total** (`src/services/eventProducer.ts:34-48`):

```json
{ "event_type": "...", "occurred_at": "...", "data": { ... } }
```

`topic` and `key` are Kafka-level metadata, not in the value. And `publish()` sets **no Kafka headers** (`eventProducer.ts:106-117`).

So of the five fields your validator expects, **three do not exist**: `schema_version`, `event_id`, `source_rail`. Your validator would reject every Identiti event even with a broker running.

**Independently, `traceparent` is absent from the event path entirely** — which fails the Reboot Pack §A.11 cross-rail audit invariant (`traceparent` + `business_op_id`), a stated hard build-acceptance criterion. HTTP requests carry it; events don't. That's our defect, and your request is what surfaced it.

**Proposed envelope — fixing all of it in one change:**

```json
{
  "schema_version": "1.0",
  "event_id": "evt_<ULID>",
  "source_rail": "identiti",
  "event_type": "STEP_UP_REQUIRED",
  "occurred_at": "2026-10-26T08:07:22.371Z",
  "traceparent": "00-<trace-id>-<span-id>-01",
  "data": { }
}
```

`event_id` also gives you consumer-side dedup, which you'll want on an at-least-once broker.

**Why now:** `serializeEventValue` is marked "changing this shape is a breaking cross-rail change" — but **no broker has ever existed, so nothing has ever consumed a real Identiti event.** The break is theoretical today and permanent after a broker lands. This is the cheapest moment it will ever be. **It must therefore land before item 4.**

**Status: proposed, not built** — it changes a published contract, so we want your sign-off plus Helpan AI's and KP's before we cut it.

---

## 4. Kafka broker

Agreed, and agreed on Redpanda self-hosted on Railway as the cheapest adequate option — one service, reachable over `*.railway.internal`. Identiti owes **no code**; `KafkaJsEventProducer` activates the moment `KAFKA_BROKERS` is set (`src/index.ts:152-166`). It's an operator spend decision.

**Sequencing: land item 3 first.** Otherwise you'll build consumers against a 3-field envelope we're about to change.

⚠️ **Six topics must be pre-created** — the producer runs `allowAutoTopicCreation: false` (`eventProducer.ts:95`), so publishes fail against a cluster without them:

```
identiti.account.events   identiti.phone.events     identiti.kyc.events
identiti.kyb.events       identiti.consent.events   identiti.step_up.events
```

Settings already supported on our side (`src/config/env.ts:110-148`): `KAFKA_BROKERS`, `KAFKA_SSL`, `KAFKA_SASL_MECHANISM` (`plain` | `scram-sha-256` | `scram-sha-512`), `KAFKA_SASL_USERNAME`, `KAFKA_SASL_PASSWORD`.

---

## 5. Customer login tokens — confirmed, works today

**`requested_audience = https://api.todoku.co.ke` is correct.** It's passed straight through with no allowlist (`src/routes/auth.ts:428`), so your `aud` will be exactly:

```json
["https://api.id.identiti.co.ke", "https://api.todoku.co.ke"]
```

No registration needed on our side. Your JWKS URL and issuer are both right.

**Claims you can rely on** (`src/services/jwtSigner.ts:111-127`):

| Claim | Value |
|---|---|
| `sub` | `acc_<uuid v4>` — the account UUID ✅ as you assumed |
| `scope` | array of customer scopes ✅ |
| `tier` | `tier_0` \| `tier_1` \| `tier_2` ✅ |
| `session_kind`, `session_id` | session discriminators |
| `auth_factors` | array of factors used |
| `env` | deploy environment |
| `phone_token` | **optional** — present only when a phone token was minted alongside |
| `iss`, `aud`, `sub`, `iat`, `exp` | standard; `alg: RS256`, `kid: lrnn8c8kQzc0GJsU` |

---

## 6. Operator session verification — and 5 kinds shipped

**The 5 operation kinds are live.** Added to `OPERATION_KIND_ENUM` (`src/schemas/stepup.ts`) with a test that drives all five through `/v1/stepup/challenges`:

`operator.todoku.template_reject` · `operator.todoku.app_suspend` · `operator.todoku.app_reactivate` · `operator.todoku.escalation_resolve` · `operator.todoku.ticket_resolve`

239/239 tests pass, typecheck and lint clean. (Not yet deployed — rides the next push to `main`.)

**On `/v1/operator-sessions/{token}`: correct, it does not exist, and we won't add it.** Two existing answers, both better:

**(a) Preferred — verify the step-up JWT locally against our JWKS.** Same pattern KP uses per §16.3; no network call, no scope needed.

| Claim | Value |
|---|---|
| `sub` | **`opu_<ULID>`** — the prefix is the discriminator. `acc_*` = customer, `opu_*` = operator. |
| `operation_kind` | e.g. `operator.todoku.template_approve` |
| `factor` | `hardware_key` for all operator step-ups |
| `aud` | the `operation_audience` the operator authorised against |
| `iss` | `https://api.id.identiti.co.ke` |
| `jti`, `iat`, `nbf`, `exp` | `nbf` = `iat`; TTL by risk tier |

Header: `alg: RS256`, `kid: lrnn8c8kQzc0GJsU`.

**(b) If you prefer server-side — the endpoint already exists**, just not under the name you guessed: **`POST /v1/stepup/tokens/validate`** (`src/routes/stepup.ts:731`). It is exactly introspection, and **non-consuming** — it does not burn the JTI, so it's safe to call repeatedly.

- Scope: `identiti:stepup:verify` — see the ALTER in item 1.
- Takes `expected_subject` and `expected_operation_kind`, so you can assert the token is for the right operator *and* the right action in one call.
- Returns `{ valid: true, claims: {...} }` or `{ valid: false, invalid_reason: "expired" | ... }`.

⚠️ **One caveat on replacing your static operator token:** operator step-up runs on the **stub** WebAuthn adapter (`WEBAUTHN_STUB_MODE=true`). It accepts structurally-valid assertions against stub-issued credentials and refuses real ones. Real FIDO2 crypto is ID-17 Phase 2, gated on hardware procurement. **The wire contract above is final either way** — build against it now; only the adapter swaps. But don't retire a static token in favour of stub-verified hardware_key in production.

---

## 7. Is the database working?

**Honest answer: we still don't know, and that's not acceptable 18 days on.**

Checked today, 26 Oct:

| Probe | Result |
|---|---|
| `GET /v1/health` | `200` — `0.1.4`, `environment: staging` |
| `GET /.well-known/jwks.json` | `200` |
| **DB-backed path** | **Could not test** — the authenticated probe is blocked in our tooling, and the Supabase connector is unauthorized in-session |

So the 8 Oct `500` on `POST /v1/customers` is **neither confirmed nor cleared**. As you correctly note, `/v1/health` returns static metadata with no DB touch (`src/routes/health.ts`), so green tells you nothing — it reported green straight through the outage.

Escalated to the operator with two unblock paths: check the Supabase dashboard for a third free-tier auto-pause, or authorize the probe.

**`/v1/health/deep` is the real fix** and we're proposing it again on the back of your request — DB ping, event-producer mode, IPRS/WebAuthn stub flags, auth-exempt. It turns "is Identiti actually up?" into a self-serve question for every rail instead of an escalation. Proposed, not yet built.

---

## Your five bugs — all confirmed, with the exact values

Your diagnoses are right. Specifics so the fix is one pass:

**1. HMAC header.** Expected:

```
Authorization: Identiti-HMAC-SHA256 app_id=todoku_internal, signature=<base64>
X-Identiti-Timestamp: <RFC3339 UTC>
```

Canonical string, newline-joined:

```
METHOD \n path \n content-type \n timestamp \n sha256hex(body)
```

**Two traps that produce a 401 and have caught every integrator:**
- The secret is used **as-is** (the 64-char ASCII hex string). Do **not** hex-decode it to bytes.
- On a **bodyless GET**, the content-type line is the **empty string** — we read the actual header, which is absent. Signing `application/json` there fails. `sha256hex("")` for the body.

Reference signer: App Integration Guide §21.9.1. Working example: `scripts/smoke-identiti.mjs`.

**2. App ID.** `todoku_internal`. ✅

**3. Resolve response.** Your rewrite target is `{ account_uuid, phone_encrypted, encrypted_format: "aes-256-gcm-v1" }` — ✅ confirmed (`phoneTokens.ts:229-240`). Hold the decryption work until item 2 is decided; if the counter-proposal lands you'll read `phone_plaintext` and write no crypto at all.

**4. Event schemas.** ✅ — but wait for item 3 rather than matching today's 3-field envelope.

**5. Helpan header.** Out of our scope, but the same bug class: each rail namespaces its own scheme and timestamp header.

---

## What we need back

| From | What |
|---|---|
| **Operator** | Rotate + hand over `todoku_internal` secret · run the scope ALTER · confirm the DB state |
| **Chamia** | Item 2 — share the key, or switch resolve to plaintext? |
| **Todoku + Helpan AI + KP** | Item 3 — sign off the envelope before we cut it |
| **Platform** | Item 4 — broker spend |

**Suggested order:** DB confirmation → secret + scope ALTER (unblocks every call) → item 2 decision → item 3 envelope → item 4 broker → your client fixes land against the final shapes.

Your instinct to fix the headers and app ID first is right — neither depends on anything above.
