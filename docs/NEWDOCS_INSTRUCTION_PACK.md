# Identiti — Newdocs Instruction Pack (21 May 2026)

**Source:** Chamia's 21 May 2026 additions in `c:\Projects\Platform Rails-instruction pack v1-reboot pack v1.2\newdocs\`.
**Scope:** What Identiti needs to add, change, and execute because of the six new product/rail packs Chamia just landed.
**Read first:** [RECAP.md](../RECAP.md) §1, §2 — current state is ID-1..ID-10 closed, 164/164 tests, deployed Railway dev mode, 5 ID-11 fixtures seeded. This pack only enumerates **net-new work** the newdocs introduce.

---

## Newdocs touching Identiti

| Source pack | File | Why Identiti cares |
|---|---|---|
| Itafika | `newdocs/Itafika-LaaS rail-DevPack/itafika-sprint0-reboot-pack-md.md` (§15 in particular) | NEW rider-KYC primitives (driving licence, motorbike registration, M-Pesa ownership probe, insurance verification). §15 is a brief addressed to Silvia by name. |
| Itafika | `newdocs/Itafika-LaaS rail-DevPack/itafika-dods-mvp-backlog-md.md` (Sprint 2 stories) | Rider onboarding flow — photos upload direct to Identiti signed URLs (Itafika never sees the bytes). |
| LipaStack | `newdocs/LipaStack-DevPack/lipastack-tech-spec-build-pack-v13.md` (§A6, §A9) | NEW KYB orchestration (Identiti to provide), director KYC, step-up audience `lipastack`, 5-min freshness for high-risk actions, JWKS cache 15-min. |
| Hakken | `newdocs/Hakken-Discovery rail-DevPack/hakken-rail-spec-md.md` (§9.1) | NEW cross-app consent surface `GET /v1/consent/:user_uuid` + consent-change + user-retired webhook events. |
| Helpan KWS (Phase 2) | `newdocs/Kipkiren Web Services-Sprint 9-Helpan/helpan_kws_instruction_pack.md` §3.2 | Phase 2 delegation contract: scoped tokens with `kws_*` scopes, TTL = 72h, revocable, logged. Phase 1 does NOT touch Identiti. |
| Todoku productisation | `newdocs/TODOKU-Comms rail-DevPack/todoku-reboot-pack-v1.md` | Confirms Identiti-mediated operator FIDO2/WebAuthn (TD-D-08) is the production target for all Todoku operator portals. |
| KWS Inaugural | `newdocs/kipkiren web services - inaugural pack/kws_architecture_v1.md` (§A) | KWS portal client auth recommended (per agent analysis) to consume Identiti JWKS rather than build its own. ADR-grade decision; no engineering change unless that ADR lands. |

---

## Net-new Identiti tickets

### ID-12 — Rider-KYC extension (Itafika §15)

**Critical path for Itafika MVP.** Itafika sandbox needs this by week 4 (≈18 June 2026); Stage 3 by week 9 (≈23 July 2026).

**New endpoints:**

- `POST /v1/kyc/rider/submit` — body references signed-URL artefact uploads. Itafika never sees the bytes.
- `GET /v1/kyc/rider/{submission_id}` — fetch state.
- `POST /v1/kyc/rider/{submission_id}/retry` — restart a failed submission.

**New artefact kinds** (extend `kyc_records.kind`; recommend a typed sub-table `rider_kyc_artefacts` for type-specific fields):

- `rider_driving_licence` — KE class A/B/C; NTSA TIMS adapter optional (Sprint 2+, not MVP).
- `rider_motorbike_registration` — bike logbook + plate.
- `rider_mpesa_ownership_probe` — KES 10 probe via KP-17 (paired sprint on Kipkiren Pay) to verify the rider's M-Pesa account ownership.
- `rider_insurance` — third-party liability + cargo cover; expiry tracked.

**Cross-account uniqueness:** extend the existing PBKDF2 partial-unique-index pattern from `national_id_hash WHERE status='verified'` to also cover `driving_licence_number_hash` and `bike_registration_number_hash`.

**New Kafka events** on `identiti.kyc.events` (extend the existing topic catalogue):

- `rider.kyc_verified` — full rider class verified.
- `rider.kyc_rejected` — with reason code.
- `rider.kyc_expiring_soon` — 30 days before licence/insurance expiry (cron-driven).
- `rider.licence_expired` — automatic.
- `rider.insurance_expired` — automatic.

**Tier promotion path — needs a decision:** does successful rider-KYC promote to `tier_1`, or is `rider_class` an orthogonal dimension layered on top? See Open Question 1.

**Exit criteria:**

- Sandbox-ready by Itafika S2: routes return correct responses; signed-URL upload flow tested against `IPRS_STUB_MODE`-style stub for NTSA; cross-account uniqueness on driving licence + bike registration enforced.
- Stage 3 by Itafika S5: real NTSA TIMS adapter or documented cut-over; KYC vendor IAD requirement (BR-AI-5, Track A) still gates rider document images at v1.

### ID-13 — KYB (Know Your Business) extension (LipaStack)

**LipaStack Sprint 1 dependency.** Without this Identiti cannot onboard the LipaStack merchant cohort.

**New endpoints (proposed family `/v1/kyb/*` — see Open Question 5):**

- `POST /v1/kyb/initiate` — body includes business registration documents, ownership structure, director Identiti UUIDs.
- `GET /v1/kyb/{kyb_id}` — fetch state.
- `POST /v1/kyb/{kyb_id}/retry`.

**Director KYC:** reuse existing `POST /v1/customers/:uuid/kyc/iprs` per director. KYB combines all director verdicts + business-registry probe (BRS / e-Citizen — Track A adapter).

**Kafka events** on a new `identiti.kyb.events` topic:

- `kyb.verified` — final verdict.
- `kyb.rejected` — with reason code.
- `kyb.pending_info` — clarification required.

**LipaStack side caches the verdict** in `merchants.kyb_state` JSONB; webhooks invalidate.

**Capacity caution:** LipaStack expects external-merchant volumes materially above KMV portfolio scale by month 6+. Capacity-planning conversation needed between Silvia and LipaStack engineering before LipaStack KP-Beta.

### ID-14 — Cross-app consent surface (Hakken)

**Hakken HK-4 dependency** (Identiti integration sprint). Decoupled from the rider-KYC and KYB work — paper-only design can run in parallel.

**New endpoint:**

- `GET /v1/consent/:user_uuid` — returns `[{ app_id, scope, granted_at, revoked_at? }, ...]`. Schema TBD jointly with Hakken; the contract above is a starting strawman.

**New Kafka events** on a new `identiti.consent.events` topic:

- `consent_granted` — `(account_uuid, app_id, scope)`.
- `consent_revoked` — `(account_uuid, app_id, scope, reason)`.
- `scope_degraded` — consuming app cuts a scope without full revocation.

**Cross-rail consumers** (Hakken first):

- Webhook out: `POST <consumer>/webhooks/identiti/consent-change`.
- Pull: `GET /v1/consent/:user_uuid` with 60s consumer-side cache.

**Joint design point — see Open Question 4.** Decide whether consent storage is canonical in Identiti (Hakken's assumption) or per-app with Identiti aggregating.

**Bundled with this ticket:** `user-retired` webhook — `POST <consumer>/webhooks/identiti/user-retired`. Likely already partially defined via account-state events (`ACCOUNT_SUSPENDED`); confirm whether retirement is a new state or a sub-type.

### ID-15 — LipaStack step-up audience + operation-kind catalogue

**Trivial config change. Bundle with the next migration touching `step_up_tokens`.**

- Add `lipastack` to the audience whitelist.
- New `operation_kind` values: `lipastack.payout.high_value`, `lipastack.admin.key_rotation`, `lipastack.merchant.dispute_decision`, plus others as LipaStack Sprint 5+ defines them.
- LipaStack consumes via cached JWKS (15-min TTL) — standard JIT identity posture per §A.1.

### ID-16 — KWS delegation contract (Helpan KWS Phase 2)

**Phase-2 work; document now so it ships without rework.** KWS Sprint 9 (Phase 1) does NOT consume Identiti.

**Proposed contract:**

- Scope namespace `kws_*` — e.g. `kws.proforma.read`, `kws.client_services.read`, `kws.audit.write`, `kws.dns.execute`, `kws.ssl.provision`.
- TTL: **72h** (KWS instruction pack §3.2). High vs the §A.1 JIT band — see Open Question 2.
- Revocable: yes, via existing revocation surface.
- Logged alongside `content_hash` in KWS-side `proforma_approvals`.

**Identiti-side signing path:** open. The two candidates are: (a) Identiti directly via a KWS-specific operation kind on `/v1/internal/sign` (ID-10 surface), or (b) Helpan AI signs (consistent with §A.5 Helpan-as-agent-authority split). Recommendation: (b), consistent with how Helpan AI agents are issued today. Coordinate with Helpan AI rail before Phase 2 kicks off.

### ID-17 — Operator session + step-up surface for cross-rail consumers

**Single highest-leverage ticket in this pack.** Unblocks: Todoku TD-Beta operator FIDO2 swap-in; Itafika ops dashboard; KWS Amara admin role; LipaStack admin portal. Currently four rails are each waiting on the same Identiti-mediated operator-auth surface.

**Decision needed (Open Question 3):** sub-surface of existing `/v1/auth/challenges` + `/v1/stepup/verify` (with `operation_kind=operator.<rail>.<action>` values), or a separate `/v1/operator/auth/*` family?

**Recommendation:** sub-surface. Adds operation-kind values:

- `operator.todoku.template_approve`, `operator.todoku.tenant_provision`, `operator.todoku.fraud_block_lift`
- `operator.itafika.kyc_decision`, `operator.itafika.dispatch_override`
- `operator.kws.proforma_approve`, `operator.kws.dispatch_assign`
- `operator.lipastack.merchant_freeze`, `operator.lipastack.dispute_decide`

**New factor:** `hardware_key` (WebAuthn / FIDO2). Current `auth_challenges.factor` enum supports `phone_otp` only (per ID-5 close notes); add `hardware_key` and an adapter. TD-D-08 mandates FIDO2/WebAuthn; SMS 2FA explicitly prohibited.

---

## Existing surfaces affected

| Surface | Change |
|---|---|
| `/.well-known/jwks.json` | No schema change; downstream consumer list grows (Lipastack, Itafika, KWS Phase 2). |
| `step_up_tokens` table | No schema change (audience is already a string). New `operation_kind` catalogue entries. |
| `kyc_records` table | Extend `kind` enum or add typed sub-table `rider_kyc_artefacts`. New KYB sub-table family. |
| `auth_challenges.factor` enum | Add `hardware_key`. |
| Operator console | New endpoints for the cross-rail operator surface (ID-17). |
| Webhook topology | Add `consent-change` + `user-retired` event types. |

---

## Cross-rail wiring deltas

| Direction | Change |
|---|---|
| Identiti → Hakken | NEW consent webhooks + `GET /v1/consent/:user_uuid` (ID-14). JWT validation locally on Hakken side; Hakken caches consent 60s. |
| Identiti → LipaStack | NEW KYB orchestration (ID-13); new step-up audience `lipastack` (ID-15); existing step-up + tier signal + Account UUID. |
| Identiti → Itafika | NEW rider-KYC extension (ID-12); existing tier signal + Account UUID + customer-token. |
| Identiti → KWS (Phase 2) | NEW scoped-delegation tokens (ID-16, paper for now). Phase 1 = no integration. |
| Identiti → Todoku / KWS / Itafika / LipaStack | NEW operator session surface (ID-17). Multi-consumer; sub-surface design recommended. |
| Identiti → KP | No new Identiti-side work — KP-15 Hakken analytical surface consumes existing tier-signal + `TIER_CHANGED` events. |
| Identiti → Helpan AI | No new Identiti-side endpoints — Helpan KWS Phase 2 reuses ID-10 delegated-authority signing if (a) above; otherwise no Identiti work at all if Helpan signs. |

---

## Recommended sequencing

Given current state (ID-1..ID-10 closed; staging cutover prepared but pending operator paste; 18–21 May backlog cleanly exhausted):

1. **Reconciliation ADRs (paper, ~half a day):**
   - ID-17 operator surface shape (sub-surface vs separate family).
   - ID-16 KWS delegation TTL — 72h vs §A.1 JIT band.
   - ID-13 KYB sub-surface vs extension of `/v1/customers/:uuid/kyc`.
   - ID-12 rider-KYC tier semantics (tier_1 vs orthogonal `rider_class`).
2. **ID-12 Rider-KYC extension** — Itafika S2 (week 4) sandbox deadline is the binding programme-level constraint. Start as soon as the Railway staging cutover is unblocked.
3. **ID-14 Consent surface** — joint design session with Hakken before HK-0 starts. Paper-only first; build during HK-3/HK-4.
4. **ID-15 LipaStack audience** — trivial; bundle with the next migration touching `step_up_tokens`.
5. **ID-13 KYB extension** — LipaStack Sprint 1 dependency. Director-KYC-only at first; full business-registry adapter follows.
6. **ID-17 Operator FIDO2** — high leverage; unblocks four rails. Sequence after ID-12 to keep Itafika MVP critical path moving.
7. **ID-16 KWS delegation contract** — Phase 2; spec it, don't build until KWS-S10.

---

## Open questions for Chamia

1. **Rider-KYC promotion semantics** — does successful rider-KYC promote the account to `tier_1`, or is `rider_class` a separate orthogonal dimension layered on top of the existing 3-tier model?
2. **KWS 72h TTL vs JIT §A.1** — §A.1 says no long-lived bearer tokens; 72h is well outside the 5-min step-up / 15-min phone-token band. Document KWS as an explicit exception, or shorten?
3. **Operator surface shape (ID-17)** — sub-surface of `/v1/auth/challenges` + `/v1/stepup/verify` with `operation_kind=operator.<rail>.<action>`, or new `/v1/operator/auth/*` family?
4. **Consent storage canonical location (ID-14)** — Identiti canonical (Hakken's assumption), or aggregated from per-app sources?
5. **KYB sub-surface (ID-13)** — extend `/v1/customers/:uuid/kyc/iprs` with `subject_type=business|director`, or new `/v1/kyb/*` family? Recommend new family.
6. **KWS delegation signer (ID-16)** — Identiti directly via `/v1/internal/sign` (ID-10), or Helpan AI signs per §A.5 split? Recommend (b).

---

## File pointers

Absolute paths — open in the IDE to read:

- Itafika §15 rider-KYC brief: `c:\Projects\Platform Rails-instruction pack v1-reboot pack v1.2\newdocs\Itafika-LaaS rail-DevPack\itafika-sprint0-reboot-pack-md.md`
- Itafika rider onboarding flow: `c:\Projects\Platform Rails-instruction pack v1-reboot pack v1.2\newdocs\Itafika-LaaS rail-DevPack\itafika-dods-mvp-backlog-md.md`
- LipaStack KYB / step-up §A6 / §A9: `c:\Projects\Platform Rails-instruction pack v1-reboot pack v1.2\newdocs\LipaStack-DevPack\lipastack-tech-spec-build-pack-v13.md`
- Hakken consent surface §9.1: `c:\Projects\Platform Rails-instruction pack v1-reboot pack v1.2\newdocs\Hakken-Discovery rail-DevPack\hakken-rail-spec-md.md`
- Helpan KWS delegation §3.2 (Phase 2): `c:\Projects\Platform Rails-instruction pack v1-reboot pack v1.2\newdocs\Kipkiren Web Services-Sprint 9-Helpan\helpan_kws_instruction_pack.md`
- Todoku operator-auth target: `c:\Projects\Platform Rails-instruction pack v1-reboot pack v1.2\newdocs\TODOKU-Comms rail-DevPack\todoku-reboot-pack-v1.md`

---

*Identiti rail · newdocs instruction pack · 21 May 2026.*
