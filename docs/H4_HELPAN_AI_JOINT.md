# H4 — Identiti ↔ Helpan AI joint integration sign-off

**Document type:** Identiti engineering response to the Helpan AI Delegated Authority Token Contract v1.0 (Strawman) §8 — "Identiti-joint integration points pending H4 closure."
**Sprint:** ID-10.
**Date:** 13 May 2026.
**Status:** Identiti-side implemented and shipped. Helpan AI H-3 may proceed against the surface described here.
**Authoritative sources:** Helpan AI `helpan-ai-delegated-authority-contract-v1.md` §2–§8; Reboot Pack v1.2 §5, §A.1, §A.2, §A.5, §A.9, §A.11; Identiti Schema Appendix Amendment §A.

---

## 0. Summary

The strawman left five integration points open (its §8.1–§8.5). This memo records the Identiti engineering decision on each and points at the code that implements it. Helpan AI's H-3 (delegated authorities issuance/validation/revocation) was hard-blocked on this sprint; with ID-10 shipped, H-3 is unblocked.

| Point | Strawman ask | Identiti decision | Status |
|---|---|---|---|
| §8.1 | `kid` namespace coordination | Accepted — literal `helpan-da-<epoch>` kid, Identiti-supplied via `JWT_DA_KID` | ✅ shipped |
| §8.2 | Internal signing API `POST /v1/internal/sign` | Accepted — option (a): Identiti signs; Helpan AI never holds the key | ✅ shipped |
| §8.3 | Step-up audience `helpan_authority_issuance` | Accepted — audience + operation kind added | ✅ shipped |
| §8.4 | CAEP integration | Deferred to v1.1 per Reboot Pack §A.9 — topology confirmed non-precluding | ⏸ v1.1 |
| §8.5 | Cascade-revocation Kafka events | Partial — see §5 below; two events confirmed, two deferred | ⚠ see §5 |

---

## 1. §8.1 — `kid` namespace

**Decision: accepted, with Identiti as the kid authority.**

- The delegated-authority signing key is a **separate RSA keypair** from the step-up / customer-token key (`keyClass='delegated_authority'` vs `'step_up'` in `src/services/jwtKeys.ts`). Distinct key, distinct `kid`, same JWKS document.
- The `kid` is **Identiti-supplied as a literal** via the `JWT_DA_KID` env var. The strawman's proposed `helpan-da-2026-q2` form is honoured directly — Identiti does not re-derive it. The relying-party verifier may parse the rotation epoch out of the kid string as the strawman intends.
- Rotation: 90-day cadence, previous key retained in JWKS for a 24-hour overlap (Delegated Authority Contract §6.1). Operationally this is a `JWT_DA_KID` + PEM rotation; the JWKS multi-key publication path already supports an overlap window (the JWKS array simply carries both keys).
- Both keys are published at `GET /.well-known/jwks.json`. The `kid` header on each token discriminates: step-up tokens carry the SHA-derived step-up kid; delegated-authority tokens carry `helpan-da-*`.

**Code:** `src/services/jwtKeys.ts` (`JwtKeyClass`, `loadOrGenerateKeys`, `resolveKid`); `src/routes/jwks.ts` (publishes all `jwtKeys`); `src/index.ts` (loads both keypairs).

## 2. §8.2 — Internal signing API `POST /v1/internal/sign`

**Decision: accepted — strawman option (a). Identiti exposes the signing API; Helpan AI never holds the signing key.** Option (b) (subordinate key issued to Helpan AI) is rejected on the operational-risk grounds the strawman itself notes.

**Wire contract (matches Delegated Authority Contract §6.3):**

- Request: `{ "kid": string, "claims": <§2.3 claim set> }`
- Response: `{ "token": string, "signed_at": RFC3339 }`
- Auth: HMAC-SHA-256 (the platform service-to-service standard). **mTLS terminates at the edge** at Stage 1 — same posture as the rest of Identiti (RECAP §2 ID-1 row); the strawman's "mTLS + HMAC" is satisfied with mTLS as an edge concern.
- Scope: **`identiti:internal:sign:delegated_authority`** — granted only to Helpan AI's `app_credentials` row.
- Tenant pin: the route additionally checks `request.appId === HELPAN_AI_APP_ID`, so a mis-granted scope on any other tenant still cannot mint delegated-authority tokens (defence-in-depth).

**Server-side guards Identiti enforces before signing** (Helpan AI owns claim authorship — agent registry, scope catalogue, per-scope limits — but Identiti enforces the invariants a relying-party verifier depends on):

1. `claims` validates against the §2.3 JSON-Schema shape (AJV) — else `validation_request_invalid` (400).
2. `kid` must resolve to a known delegated-authority key — else `kid_unknown` (400).
3. `claims.iss` must be the Identiti issuer literal — else `issuer_mismatch` (400).
4. `claims.token_class` must be `delegated_authority` — else `wrong_token_class` (400).
5. `claims.exp - claims.iat` must not exceed the per-scope-class maximum (§3.5): **≤3600s** money (`kipkiren.write.*`, `chapaa.write.*`, `chapaa.mmf.*`), **≤900s** identity-sensitive (`identiti.write.*`, `chapaa.read.behavioural`), **≤86400s** read-only. The tightest matching bound across all scopes in the request wins — else `expiry_out_of_bounds` (400).
6. `claims.iat` must not be more than 60s in the future — else `iat_in_future` (400).
7. `claims.sub` must reference an existing account — else `customer_not_found` (404). Identiti checks identity *existence* only; KYC-tier / freeze gating is Helpan AI's issuance-flow responsibility per §3.5.

**Step-up consumption.** If `claims.step_up_jti` is present, Identiti verifies the JTI exists, is bound to `claims.sub`, and marks it consumed atomically (single-use per Schema Appendix §16.3 step 12). Replay returns `step_up_token_already_used` (409); unknown JTI `step_up_token_unknown` (400); subject mismatch `step_up_token_subject_mismatch` (400).

**Audit.** Every successful signing writes a durable row to `delegated_authority_signings` (the claim set Identiti attested to, not the JWT — a forensic auditor reconstructs the attestation without trusting Helpan AI's copy) **and** an `audit_log` entry. Failures write an `audit_log` entry too. The `traceparent` is persisted on the signing row as the cross-rail join key (§A.11).

**Hostname.** The strawman names `https://internal.identiti.co.ke`. v1.0 ships the route on the main app behind the scope guard; the `internal.` hostname split is a Stage 1 ingress concern, not a code change.

**Code:** `src/routes/internal.ts`, `src/services/delegatedAuthoritySigner.ts`, `src/schemas/internal.ts`, `src/repositories/delegatedAuthoritySignings.ts`, migration `drizzle/0008_delegated_authority_signings.sql`.

## 3. §8.3 — Step-up audience `helpan_authority_issuance`

**Decision: accepted.**

- `helpan_authority_issuance` is added as an accepted step-up `operation_audience`. It is a **bare (non-URI) audience string** — the step-up request schema special-cases it alongside the existing URI-shaped audiences (`kipkiren_pay`, `identiti`).
- `helpan_ai.authority_issuance` is added to the step-up `operation_kind` enum.
- A step-up token minted with this audience is what a user presents to Helpan AI `POST /v1/authorities` when granting an agent a high-stakes delegated authority — the "the two compose" pattern of Delegated Authority Contract §1.

**Code:** `src/schemas/stepup.ts` (`NON_URI_AUDIENCES`, `operationAudienceSchema`, `OPERATION_KIND_ENUM`).

## 4. §8.3 (cont.) — `actor` / `initiated_by` request-side propagation

The strawman's §2.3 delegated-authority token carries `actor` + `initiated_by`. The matching **step-up** claims (Schema Appendix Amendment §A.1/§A.2) were emission-only until ID-10. They are now populated request-side:

- `/v1/stepup/challenges` accepts optional `actor` (`{type:'agent', agent_id, delegated_authority_jti?}`) and `initiated_by` (`human|agent|system`).
- The values survive the async gap to `/v1/stepup/verify` on the `auth_challenges` row (columns added by migration 0008), ride onto the `STEP_UP_REQUIRED` Kafka event, and land as claims on the issued step-up JWT plus the durable `step_up_tokens` row.
- All fields optional and backward-compatible — human-initiated step-ups are unchanged.

This satisfies the Reboot Pack §A.11 hard build-acceptance criterion: a step-up-consuming endpoint persists the §A.2 claims, and the cross-rail audit join (`traceparent` + `business_op_id`) is intact.

**Code:** `src/schemas/stepup.ts`, `src/routes/stepup.ts`, `src/repositories/authChallenges*.ts`.

## 5. §8.5 — Cascade-revocation Kafka events

The strawman subscribes to four event types. Identiti's position:

| Event | Identiti v1.0 status | Guidance to Helpan AI H-3 |
|---|---|---|
| `identiti.account.events` `ACCOUNT_SUSPENDED` | ✅ Emitted today (operator suspend, `active → frozen_aml`). Wire envelope locked by `tests/eventEnvelope.test.ts`. | Subscribe as designed. |
| `identiti.account.events` `ACCOUNT_DELETED` | ❌ Not emitted — Identiti has no account-deletion flow in v1.0 (`AccountState` has no deleted value; closures are `closed_*` states). | **Deferred.** No `ACCOUNT_DELETED` cascade source in v1.0. If a closure-driven cascade is needed, subscribe to `ACCOUNT_SUSPENDED` semantics or raise a v1.1 item. |
| `identiti.account.events` `KYC_DOWNGRADED` | ❌ Not emitted as a distinct type. Tier changes publish `TIER_CHANGED` carrying `from_tier` + `to_tier`. | **Use `TIER_CHANGED`.** Derive "downgrade" from `to_tier < from_tier` in the payload. Identiti will not add a separate `KYC_DOWNGRADED` type in v1.0 — it would duplicate data already on `TIER_CHANGED`. |
| `identiti.consent.events` `CONSENT_REVOKED` | ❌ Not emitted — Identiti has no consent-management surface in v1.0; the `identiti.consent.events` topic does not exist. | **Deferred to v1.1.** No consent-revocation cascade source in v1.0. Track as a v1.1 joint item alongside CAEP (§8.4). |

**Net:** one event (`ACCOUNT_SUSPENDED`) is consumable today; one (`KYC_DOWNGRADED`) is satisfied by `TIER_CHANGED` with a payload-derived downgrade check; two (`ACCOUNT_DELETED`, `CONSENT_REVOKED`) have no v1.0 source and are v1.1 roadmap. H-3's cascade-revocation logic should be built against `ACCOUNT_SUSPENDED` + `TIER_CHANGED` for v1.0.

## 6. §8.4 — CAEP integration

**Deferred to v1.1**, consistent with Reboot Pack §A.9 ("CAEP real-time revocation … out of scope for v1.0, but Kafka topology MUST not preclude per-token revocation events"). Identiti's `EventProducer` places no constraint on topics or per-token event granularity, so the topology is confirmed non-precluding. CAEP receiver-model design is a joint v1.1 task.

## 7. What Helpan AI H-3 can now build against

- `POST https://api.identiti.co.ke/v1/internal/sign` (Stage 1: behind HMAC scope `identiti:internal:sign:delegated_authority`; `internal.` hostname split at deploy time).
- Delegated-authority JWTs verifiable at `GET /.well-known/jwks.json` by the `helpan-da-*` `kid`.
- Step-up tokens with audience `helpan_authority_issuance` accepted as the issuance-time proof.
- Cascade triggers: `ACCOUNT_SUSPENDED` + `TIER_CHANGED` (downgrade derived).

Open joint items remaining: §8.4 CAEP (v1.1), §8.5 `ACCOUNT_DELETED` / `CONSENT_REVOKED` (v1.1).
