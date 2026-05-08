# Identiti Rail — Build Progress and Sprint Tracker

**Document type:** Rail-specific progress tracker. Update at each sprint close.
**Date:** 9 May 2026
**Cross-rail source of truth:** `c:\Projects\Platform Rails-instruction pack v1-reboot pack v1.2\RECAP.md` — read this file's §3 (dependency graph) and §5 (critical path) before starting any sprint.
**Rail design corpus:** `Identiti_Rail_Contract_v1.0_Scaffold.md` + Schema Appendix + Amendment §A; `docs/INTEGRATION_MAP.md`; `README.md`.

---

## 1. Where this rail is

**Design phase:** ✅ complete (Chamia-canonical contract + scan amendments).
**Code:** 🟡 ID-1, ID-2, ID-3, ID-4, ID-5, ID-6 closed; ID-8-partial / ID-9-partial open. 101/101 tests pass; typecheck clean.
**Stack:** Node.js 22 LTS · TypeScript 5.x strict · Fastify 4.x · AJV (JSON Schema 2020-12) · PostgreSQL 16 via Supabase (af-south-1) · Drizzle ORM · Kafka (kafkajs) · Vitest · Railway.
**Dependencies:** `@kmv/platform-shared` from `C:\Projects\platform-shared\`.

**Standing position:** Identiti is the **root of the trust graph.** Every other rail blocks on it. Build first, ship Phase 1–6 to staging before anyone else needs it.

---

## 2. Sprint plan

Conventions: 2-week sprints. Status: [ ] open · [~] in flight · [x] done. Update inline.

| Sprint | Goal | Maps to | Cross-rail deps | Status | Notes |
|---|---|---|---|---|---|
| **ID-1** | Foundation — Fastify scaffold, mTLS+HMAC auth middleware, idempotency middleware, `GET /v1/health`, DB migrations 0001–0003 | Claude Code Instruction Pack §6.3 Phase 1 | None | [x] | Closed 8 May 2026. mTLS deferred to Stage 1 deployment (terminated at edge); HMAC live. Schema reflects Schema Appendix §1.5 7-value `AccountState` (no `suspended`; operator suspend → `frozen_aml`) per memory `identiti_phase1_decisions.md` §4. Bearer JWT-on-customer-side adopted in lieu of JWT-from-`/auth/service-token` per same memory §1; service-token endpoint deferred to Phase 3 |
| **ID-2** | Account lifecycle — `POST /v1/accounts`, `GET /v1/accounts/{uuid}`, suspend/reactivate, Kafka `identiti.account.events` | §6.3 Phase 2 | None | [x] | Closed 8 May 2026. App-facing path is `/v1/customers` (Rail Contract wins; memory `identiti_phase1_decisions.md` §3). Operator suspend/reactivate is AML-only by design (`active ↔ frozen_aml`); `frozen_kyc → active` is ID-4 (KYC artefact verification). Deferred: `routing_paused_kyc_velocity` (→ ID-4), `device` payload propagation (→ ID-7). Kafka wire envelope locked by `tests/eventEnvelope.test.ts` |
| **ID-3** | Authentication — `/auth/customer-token`, `/auth/service-token`, JWT with TTL policy per Schema Appendix Amendment §A.4 | §6.3 Phase 3 | None | [x] | Closed 8 May 2026. `/v1/auth/challenges` + `/v1/auth/customer-token` shipped per Schema Appendix §2.4 / §2.6. `/auth/service-token` deferred (memory `identiti_phase1_decisions.md` §1 — Phase 1 adopted HMAC-on-every-request). Elevated-scope 5-min TTL branch (Amendment §A.4) is latent: standard 30-min TTL in effect; will activate when Tier 2 / payment-write scopes wire through. Refresh-token flow not implemented (not v1 acceptance) |
| **ID-4** | KYC + IPRS stub — `POST /v1/accounts/{uuid}/kyc`, IPRS service wrapped (`IPRS_STUB_MODE=true`), tier promotion, Kafka `KYC_APPROVED`/`TIER_CHANGED` | §6.3 Phase 4 | None | [x] | Closed 9 May 2026. App-facing path is `/v1/customers/:uuid/kyc/iprs` per Scaffold §11.2. IPRS-only path shipped; documents / selfie-liveness / address-proof routes deferred (KYC vendor Track A pending; BR-AI-5 IAD requirement gates Stage 1 vendor onboarding). Tier_0 → tier_1 promotion on first verified IPRS, with KYC_APPROVED → `identiti.kyc.events` + TIER_CHANGED → `identiti.account.events`. National-ID hashed via PBKDF2 with `KYC_HASH_SALT`; cross-account uniqueness enforced. Production guard rejects boot if `IPRS_STUB_MODE=false` without a real adapter |
| **ID-5** | Step-up — `POST /v1/step-up/initiate` (Kafka `STEP_UP_REQUIRED`), `POST /v1/step-up/complete`, **JWKS endpoint** `/.well-known/jwks.json`, `actor` + `initiated_by` claims per Schema Appendix Amendment §A | §6.3 Phase 5 | Todoku ID-2 minimal (so OTP can be sent) | [x] | Closed 8 May 2026. App-facing paths are `/v1/stepup/challenges` + `/v1/stepup/verify` (Rail Contract §7/§14 wins; RECAP names retained for legacy references). `/v1/stepup/tokens/validate` deferred per Scaffold §14.4 (diagnostic only; KP validates locally per §16.3). `actor` + `initiated_by` claim **emission** is wired in `signStepupToken`; **request-side population** (Schema Appendix §7.1 schema extension) blocks on ID-10 H4 closure with Helpan AI. Migration 0004 lands the Amendment §A.1 columns (`actor_type`, `actor_agent_id`, `delegated_authority_jti`, `initiated_by`) on `step_up_tokens` from the start so ID-10 has nothing to migrate. Factor upgrade (hardware_key for very_high) deferred — only `phone_otp` wired through. JWKS multi-key rotation orchestrator deferred to polish pass. **CRITICAL cross-rail unblock landed:** KP-4 verifier dev can begin |
| **ID-6** | Phone tokens — issue, resolve (Todoku-internal scope), revoke; phone change cooldown logic | §6.3 Phase 6 | None | [x] | Closed 8 May 2026. Routes `POST /v1/phone-tokens` (issue), `POST /v1/phone-tokens/resolve` (Todoku-internal, scope `phone_token:resolve`), `POST /v1/phone-tokens/{jti}/revoke` (operator). Phone tokens are HS256 opaque JWTs (`pht_<ULID>` jti, `aud='todoku'`, 15-min TTL); `/resolve` is the authoritative trust path per INTEGRATION_MAP §7.2 (signature is defence-in-depth). Customer-token JWT now carries `phone_token` claim per Schema Appendix §2.7. Cooldown helpers in `src/domain/phoneCooldown.ts` ready for ID-7 (24h default; 7d when account has active KP balance, per ID-D-08). Single master signing key in v1.0; per-account-per-audience derived key is v1.1 hardening. **CRITICAL cross-rail unblock landed:** Todoku TD-2 send pipeline can begin |
| **ID-7** | Phone management — change-request, change-confirm, two-phone OTP flow, `PHONE_CHANGED` Kafka event | §6.3 Phase 7 | Todoku ID-2 minimal | [ ] | |
| **ID-8** | Tier signal endpoint, Operator console endpoints | §6.3 Phase 8–9 | None | [ ] | |
| **ID-9** | Scan additions — IAD vendor capability sign-off (BR-AI-5), JIT posture documentation, auth JWT TTL enforcement on elevated scopes | Identiti Rail Contract Amendment §A | KYC vendor RFQ (procurement) | [ ] | |
| **ID-10** | **H4 joint with Helpan AI** — internal signing API (`POST /v1/internal/sign`); step-up audience `helpan_authority_issuance` added; cascade-revocation Kafka events confirmed | Helpan AI Delegated Authority Contract §8 | Helpan AI H-3 in flight | [ ] | **CRITICAL — blocks Helpan AI delegated authority issuance** |
| **ID-11** | Cross-rail integration testing | Handoff §14 | All other rails Sprint 5+ | [ ] | |
| **ID-Beta** | Stage 2 closed beta — production deployment, DR drill, runbooks, load test, pen-test C+H resolved | DoD §7.3 | All Identiti sprints done | [ ] | |
| **ID-GA** | Stage 3 production — ODPC registration complete, DPA 2019 sign-off, GA traffic | DoD §7.4 | H14 closed | [ ] | |

**Stage 1 sandbox target:** end of ID-8 (~8 weeks).
**Stage 2 closed beta target:** end of ID-Beta (~14 weeks).
**Stage 3 GA target:** end of ID-GA (~20–24 weeks).

---

## 3. What changes between sprints

After **each sprint closes**:

1. Update the row above: change `[ ]` to `[x]`. Add a Notes-column entry if scope shifted, anything was deferred, or dependencies changed.
2. **Cross-update** the central tracker: `c:\Projects\Platform Rails-instruction pack v1-reboot pack v1.2\RECAP.md` §4.1 — flip the same sprint row's status.
3. If the sprint produced new artefacts (migration files, source modules, tests), add a brief inventory at §5 below.
4. If a cross-rail dependency landed (e.g. ID-5 JWKS becomes consumable by KP), notify the central tracker and the dependent rail's RECAP file.

After **Stage advances** (0→1, 1→2, 2→3):

1. Update the central tracker §1 status table.
2. Update Identiti Rail Contract amendment block if the stage advance produced a contract change.
3. Sign-off per DoD §14 (Stage 0→1 needs Chamia + Silvia).

---

## 4. Source-of-truth pointers

If anything below conflicts, the source documents win:

1. `Platform_Rails_Reboot_Pack_v1_2.md` — programme canonical record (§7 Identiti locked decisions; §16.8 cross-rail wiring)
2. `Identiti_Rail_Contract_v1.0_Scaffold.md` + Amendment §A — wire-level contract, scan integration
3. `Identiti_Rail_Contract_v1.0_Schema_Appendix.md` + Amendment §A — JSON Schemas, claim additions
4. `Claude_Code_Instruction_Pack_Platform_Rails_v1_0.md` + Amendment §A — §6 Identiti build brief
5. `App_Integration_Guide_v1_0.md` + Amendment §A — cross-rail flows
6. `docs/INTEGRATION_MAP.md` — relationship to KP, Todoku, Helpan AI
7. Helpan AI corpus (when rail-side dispatch starts being relevant): `helpan-ai-rail/helpan-ai-delegated-authority-contract-v1.md` §8 (joint integration points pending H4 closure)

---

## 5. Sprint artefacts inventory (update as you go)

| Sprint | Artefacts produced |
|---|---|
| ID-1 | **Migrations:** `drizzle/0001_initial.sql` (app_credentials, idempotency_keys, audit_log; RLS on each), `drizzle/0002_accounts.sql` (platform_accounts with `acc_<uuid v4>` regex check + 7-value AccountState; phone_records with PBKDF2 hash + AES-256-GCM ciphertext + cooldown_until), `drizzle/0003_auth.sql` (auth_challenges with `stp_<ULID>` + nullable account_id + factor/purpose/status enums; sessions with `ses_<ULID>` + jti UNIQUE + session_kind; tier_reason ALTER on platform_accounts). **Foundation modules:** `src/index.ts`, `src/app.ts` (DI factory; plugin order requestContext → authPlugin → idempotencyPlugin → routes; exempt list `/v1/health` + `/.well-known/jwks.json`), `src/config/env.ts`, `src/db/{client,schema}.ts`, `src/lib/{logger,ajv}.ts`, `src/plugins/{requestContext,scope}.ts`, `src/adapters/{credentialStore,idempotencyStore}.ts`, `src/routes/health.ts`. **Tests:** `tests/{health,auth,idempotency}.test.ts` — 12 tests (foundation only); broader test count is 50/50 across the ahead-of-schedule code |
| ID-2 | **Routes:** `POST /v1/customers`, `GET /v1/customers/{uuid}`, `POST /v1/operator/customers/{uuid}/suspend`, `POST /v1/operator/customers/{uuid}/reactivate`. **Modules:** `src/routes/{customers,operator}.ts`, `src/schemas/{customers,operator}.ts`, `src/repositories/customers{,memory}.ts`, `src/domain/{accountUuid,phoneNormalise}.ts`, `src/services/{phoneCrypto,eventProducer,auditLogger}.ts`. **Wire-envelope contract:** `serializeEventValue` + `SerializedRailEvent` interface in `src/services/eventProducer.ts` (locked by `tests/eventEnvelope.test.ts`). **Tests:** `tests/{customers,operator,contracts,eventEnvelope}.test.ts` — 23 tests across these files |
| ID-3 | **Routes:** `POST /v1/auth/challenges`, `POST /v1/auth/customer-token`. **Modules:** `src/routes/auth.ts`, `src/schemas/auth.ts`, `src/repositories/{authChallenges,sessions}{,memory}.ts`, `src/services/{jwtKeys,jwtSigner,otp}.ts`, `src/plugins/scope.ts`. **Tests:** `tests/{auth,auth.flow,contracts2}.test.ts` — 14 tests across these files |
| ID-5 | **Routes:** `POST /v1/stepup/challenges`, `POST /v1/stepup/verify`. **Migration:** `drizzle/0004_step_up_tokens.sql` (creates `step_up_tokens` with Amendment §A.1 columns from the start; ALTERs `auth_challenges` to add `operation_audience` + `operation_risk_tier` so /verify reissues with the audience the customer authorised against). **Modules:** `src/routes/stepup.ts`, `src/schemas/stepup.ts`, `src/repositories/stepUpTokens{,memory}.ts`, `signStepupToken` extension to `src/services/jwtSigner.ts` (nbf=iat; optional `actor` + `initiated_by` claims). **Tests:** `tests/stepup.test.ts` — 16 tests covering happy path, JWKS verification of §16.2 claim shape, all four risk-tier TTLs, single-use, scope enforcement, error contract from ID-3 audit. **Deferred:** `/v1/stepup/tokens/validate` (diagnostic), multi-key rotation orchestrator, factor upgrade rules. **ID-10 dependency:** request-side `actor`/`initiated_by` field on `/v1/stepup/challenges` schema |
| ID-6 | **Routes:** `POST /v1/phone-tokens` (issue), `POST /v1/phone-tokens/resolve` (Todoku-internal), `POST /v1/phone-tokens/{jti}/revoke` (operator). **Migration:** `drizzle/0005_phone_tokens.sql`. **Modules:** `src/routes/phoneTokens.ts`, `src/schemas/phoneTokens.ts`, `src/repositories/phoneTokens{,memory}.ts`, `src/services/phoneTokenSigner.ts` (HS256), `src/domain/phoneCooldown.ts` (helpers for ID-7). **Auth.ts extension:** `/v1/auth/customer-token` now mints a phone_token alongside the customer JWT and embeds it as the §2.7 `phone_token` claim. **CustomersRepo extension:** `findEncryptedPhoneFor(accountUuid)` for /resolve. **Env:** `PHONE_TOKEN_SIGNING_KEY` (32 bytes hex, required). **Test app additions:** `TEST_TODOKU_APP_ID` with scope `phone_token:resolve`. **Tests:** `tests/phoneTokens.test.ts` (15) + `tests/phoneCooldown.test.ts` (7) — happy path issue/resolve/revoke, signature tampering, revoked rejection, audience mismatch, scope enforcement, claim emission on customer-token, idempotent re-revoke, cooldown helpers |
| ID-4 | **Routes:** `POST /v1/customers/:uuid/kyc/iprs`, `GET /v1/customers/:uuid/kyc/artefacts`, `GET /v1/customers/:uuid/kyc/artefacts/:id`. **Migration:** `drizzle/0006_kyc_records.sql` (kyc_records table; cross-account uniqueness on national_id_hash WHERE status='verified'). **Modules:** `src/routes/kyc.ts`, `src/schemas/kyc.ts`, `src/repositories/kycRecords{,memory}.ts`, `src/services/iprsService.ts` (interface + `createStubIprsService` with fixture map), `src/services/kycHash.ts` (PBKDF2 with KYC_HASH_SALT). **Env:** `KYC_HASH_SALT` (required), `IPRS_STUB_MODE` (default true; production boot fails if false without a real adapter). **Tests:** `tests/kyc.test.ts` — 10 tests covering full_match → tier promotion + Kafka events, no_match, document_mismatch, upstream unavailable, idempotent re-submission, cross-account ID collision, unknown account, schema rejection, list/read artefacts. **Deferred:** documents / selfie-liveness / address-proof routes (KYC vendor Track A; BR-AI-5 IAD requirement gates Stage 1 vendor onboarding) |
| ID-8 | (pending — `src/routes/tier.ts` + `tests/tier.test.ts` present, contract-drift audit pending) |
| ID-9 | (partial — `src/routes/operator.ts` + `tests/operator.test.ts` present for suspend/reactivate; scan additions not started) |
| … | |

---

## 6. Session log

Cross-rail or programme-level events that touch this rail without producing a sprint artefact. One line per event; newest at the bottom.

- 8 May 2026 — Todoku consolidated to single folder `C:\Projects\todoku-prod\`; cross-rail Todoku references updated. (No file-path references in this folder; brand-name references unchanged.)
- 8 May 2026 — ID-6 (phone tokens) closed. Cross-rail unblock: Todoku TD-2 send pipeline can begin against `POST /v1/phone-tokens/resolve`. Apps obtain a phone_token via the customer-token JWT (§2.7 claim) or via `POST /v1/phone-tokens` and pass it to Todoku, which calls /resolve to get the encrypted MSISDN.
- 9 May 2026 — ID-4 (KYC + IPRS stub) closed. IPRS-only path shipped; documents / selfie-liveness / address-proof routes deferred until KYC vendor Track A closes. Tier-promotion-on-IPRS now wired; KP can begin consuming `identiti.account.events.TIER_CHANGED` end-to-end (already named on KP-2 as a dependency).

---

*Identiti Rail · Build Progress · 8 May 2026 · update at each sprint close*
