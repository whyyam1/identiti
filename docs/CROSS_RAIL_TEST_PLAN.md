# ID-11 — Cross-Rail Integration Test Plan (Identiti side)

**Sprint:** ID-11 — cross-rail integration testing.
**Status:** Plan authored; execution blocked. Cross-rail tests can run only once
Kipkiren Pay and Todoku are deployed sandboxes (KP-1 not started; Todoku
code-complete but not deployed as of 18 May 2026). This document is the
Identiti-side test plan — it defines every flow, fixture, and assertion so that
when the other rails come up, ID-11 is executed against a written spec, not
improvised.

**Authoritative sources:** Reboot Pack v1.2 §16.8 (cross-rail wiring) + §A.2;
Identiti Rail Contract §16/§23; `docs/INTEGRATION_MAP.md`;
`docs/H4_HELPAN_AI_JOINT.md`.

---

## 1. Test environment

| Rail | Sandbox base URL | Status |
|---|---|---|
| Identiti | Railway deploy of `whyyam1/identiti` (dev mode) | ✅ live |
| Kipkiren Pay | `sandbox.pay.kipkiren.com` (per Reboot Pack §16.8) | ❌ not deployed |
| Todoku | per Todoku Rail Contract §3.1 | ❌ not deployed |
| Helpan AI | per Helpan AI corpus | ❌ not deployed |

Each cross-rail test names its **own precondition** in the table below. A test
is runnable only when every rail it touches is at the named sprint or later.

Sandbox tokens never interoperate with production (Reboot Pack §16.8). All
cross-rail tests run entirely within the sandbox tier.

## 2. Test fixture customers

Cross-rail testing needs a deterministic set of Identiti accounts the other
rails can target (Reboot Pack §16.8: "the test fixture customer set across all
three sandboxes"). Identiti is the issuer of record, so Identiti seeds them and
publishes the resulting Account UUIDs to the other rails.

| Fixture | Tier | State | Purpose |
|---|---|---|---|
| `FIX-T0` | tier_0 | active | phone-only; below KP transaction floor |
| `FIX-T1` | tier_1 | active | IPRS-verified; standard KP limits |
| `FIX-T2` | tier_2 | active | enhanced KYC; high KP limits; step-up exercised |
| `FIX-FROZEN` | tier_1 | frozen_aml | suspended — KP must reject, Todoku must suppress |
| `FIX-AGENT` | tier_2 | active | used for the Helpan AI delegated-authority path |

**Action when ID-11 starts:** extend `scripts/seed-tenants.ts` (or add
`scripts/seed-fixtures.ts`) to create these five accounts and emit their
Account UUIDs. The UUID format is `acc_<uuid v4>` (random) — the seed must
print the generated UUIDs so KP/Todoku/Helpan AI can pin them. Do not hardcode
UUIDs; the fixture identity is the seed output.

## 3. Cross-rail flows — test matrix

### 3.1 Tier signal → Kipkiren Pay

| | |
|---|---|
| Surface | `GET /v1/customers/{uuid}/tier` (Identiti) — KP caches the result 60 s |
| Precondition | KP-2 (tier consumer) |
| Steps | 1. KP reads the tier signal for `FIX-T1`. 2. Identiti operator promotes `FIX-T1` → tier_2. 3. Identiti publishes `TIER_CHANGED` on `identiti.account.events`. 4. KP consumes the event and invalidates its cache. |
| Assertions | Response carries `Cache-Control: private, max-age=60`; `TIER_CHANGED` event matches the `SerializedRailEvent` envelope (`tests/eventEnvelope.test.ts`) with `from_tier`/`to_tier`; KP recomputes limits within one cache TTL. |

### 3.2 Step-up token → Kipkiren Pay

| | |
|---|---|
| Surface | `POST /v1/stepup/challenges` + `/v1/stepup/verify` (Identiti) → RS256 JWT → KP verifies against `/.well-known/jwks.json` |
| Precondition | KP-4 (step-up verifier) |
| Steps | 1. App initiates a `kipkiren_pay.redemption` step-up for `FIX-T2`. 2. Complete with the OTP. 3. Present the step-up JWT to KP's payment-execute path. |
| Assertions | JWT verifies under the **step-up** `kid` in the 2-key JWKS; claim shape per Schema Appendix §16.2; `aud` = the KP audience; single-use enforced on the KP side; expiry honours the risk-tier TTL. |

### 3.3 Account-state propagation → Kipkiren Pay

| | |
|---|---|
| Surface | `identiti.account.events` `ACCOUNT_SUSPENDED` |
| Precondition | KP-2 |
| Steps | 1. Identiti operator suspends `FIX-FROZEN` (`active → frozen_aml`). 2. `ACCOUNT_SUSPENDED` published. 3. KP consumes it. |
| Assertions | KP applies the freeze; subsequent KP movements on `FIX-FROZEN` are rejected. |

### 3.4 Phone token → Todoku

| | |
|---|---|
| Surface | `POST /v1/phone-tokens` (issue) + `POST /v1/phone-tokens/resolve` (Todoku-internal, scope `phone_token:resolve`) |
| Precondition | Todoku TD-2 (send pipeline) |
| Steps | 1. App obtains a phone token for `FIX-T1` (direct issue, or the `phone_token` claim on the customer-token JWT). 2. App calls Todoku send. 3. Todoku's adapter calls `/v1/phone-tokens/resolve`. |
| Assertions | `/resolve` returns the AES-256-GCM ciphertext of the MSISDN, never plaintext; audience-bound to `todoku`; expired/revoked tokens rejected; raw MSISDN never appears in any Todoku surface. |

### 3.5 STEP_UP_REQUIRED → Todoku (OTP delivery)

| | |
|---|---|
| Surface | `identiti.step_up.events` `STEP_UP_REQUIRED` |
| Precondition | Todoku TD-2 |
| Steps | 1. Identiti step-up initiate for `FIX-T2` publishes `STEP_UP_REQUIRED`. 2. Todoku consumes it and sends the OTP. 3. Phone-change variant: event carries `target.kind='new_phone'`. |
| Assertions | Todoku delivers to the correct number; the new-phone target path is honoured for `identiti.phone_change`; when the step-up was agent-dispatched, the event carries `actor` + `initiated_by` (ID-10) and Todoku persists them per Reboot Pack §A.2. |

### 3.6 Delegated-authority signing → Helpan AI

| | |
|---|---|
| Surface | `POST /v1/internal/sign` (Identiti, scope `identiti:internal:sign:delegated_authority`) |
| Precondition | Helpan AI H-3 (delegated authorities) |
| Steps | 1. Helpan AI requests a step-up token with audience `helpan_authority_issuance` for `FIX-AGENT`. 2. Helpan AI calls `/v1/internal/sign` with the delegated-authority claim set. 3. A relying party verifies the returned token against the JWKS. |
| Assertions | Token verifies under the **delegated-authority** `kid` in the 2-key JWKS; per-scope-class TTL bounds enforced; `delegated_authority_signings` audit row written; step-up JTI consumed single-use. Full surface contract in `docs/H4_HELPAN_AI_JOINT.md`. |

### 3.7 Cross-rail audit invariant (Reboot Pack §A.11)

| | |
|---|---|
| Precondition | KP + Todoku live + at least one agent-dispatched flow |
| Assertion | For a single agent-initiated business operation, the `actor` + `initiated_by` values and the `traceparent` + `business_op_id` are identical across the Identiti, KP, and Todoku audit-log entries. This is a **hard build-acceptance criterion** for any rail consuming step-up tokens. |

## 4. Execution checklist (when unblocked)

1. Deploy KP + Todoku + Helpan AI sandboxes.
2. Seed the §2 fixture customers in Identiti; distribute the Account UUIDs.
3. Run §3.1–§3.6 in dependency order; each gated on its precondition sprint.
4. Run §3.7 last — it needs a complete agent-initiated flow across all rails.
5. Record results against this plan; file divergences as rail-contract issues.

## 5. What is NOT in ID-11 scope

Load testing, DR drills, and pen-test resolution are **ID-Beta** (Stage 2) —
see `docs/runbooks/`. ID-11 is functional cross-rail correctness only.
