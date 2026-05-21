# Identiti — Decisions on `NEWDOCS_INSTRUCTION_PACK.md` open questions

**Date:** 21 May 2026
**Source pack:** [`NEWDOCS_INSTRUCTION_PACK.md`](NEWDOCS_INSTRUCTION_PACK.md) — Chamia's 21 May newdocs additions.
**Status:** Positions taken below. Q3/Q5/Q6 follow the source pack's recommendations and are settled. Q1/Q2/Q4 are flagged for Chamia confirmation before code lands; tentative positions are recorded so design can proceed in parallel.
**How to read this:** every position is followed by **Why** (reasoning) and **Blast radius** (what code/contract this binds).

---

## Q1 — Rider-KYC promotion semantics (ID-12)

**Question.** Does a successful rider-KYC promote the account to `tier_1`, or is `rider_class` an orthogonal dimension layered on top of the existing 3-tier model?

**Position (tentative — needs Chamia confirmation):** **Orthogonal.** Rider-KYC creates a `rider_class` *capability flag* on the account; it does **not** promote the financial tier.

**Why.**
- The existing 3-tier model (`tier_0 / tier_1 / tier_2`) is calibrated to **financial KYC strength** — IPRS verification, transaction limits, EDD. Tier promotion is what unlocks higher KP transaction ceilings (Reboot Pack KP-D-04).
- Rider-KYC is **role-based** — driving licence, bike registration, M-Pesa probe, insurance. It says "this person can legally and operationally take a ride job," not "this person is more KYC-verified for financial transactions."
- Conflating them creates strange edge cases: a rider with valid licence but no IPRS would auto-promote to tier_1 without IPRS, breaking the existing tier semantic.
- Orthogonal model: `platform_accounts.tier` stays at `tier_0/1/2`. A new column or row in a related table tracks `rider_class` (e.g. `rider_active`, with the artefact details in `rider_kyc_artefacts`).
- A rider who is also tier_1 (IPRS-verified for financial use) is a perfectly valid combination — neither field implies the other.

**Blast radius.**
- ID-12 schema design: `rider_kyc_artefacts` sub-table + a `rider_class` field on `platform_accounts` (or a join table) — NOT a `setTier` call.
- Kafka events: `rider.kyc_verified` is a NEW event type on `identiti.kyc.events`, NOT a `TIER_CHANGED` derivative.
- KP's tier consumer is unaffected.

**If Chamia disagrees and rider-KYC IS tier_1:** the rework is contained — the `setTier` call lands in the rider-verified path, the orthogonal `rider_class` field is dropped, the rider-KYC Kafka event downgrades to a sibling of `TIER_CHANGED`. About a day of rework.

---

## Q2 — KWS 72h TTL vs §A.1 JIT identity posture (ID-16)

**Question.** Reboot Pack §A.1 says no long-lived bearer tokens; 72h is far outside the 5-min step-up / 15-min phone-token / 30-min customer-token band. Document KWS as an explicit exception, or shorten?

**Position (defensible — flag to Chamia but proceed):** **Document as an explicit, narrow exception. Do not shorten.**

**Why.**
- KWS scoped tokens are not user-session tokens. They authorise a **contract-development workflow** (proforma approval, DNS provisioning, SSL issuance) that doesn't fit a 5-min freshness window without making operators sign in 14 times an hour.
- The §A.1 JIT posture is about **AiTM phishing defence** — the threat is a long-lived auth token stolen from a user. KWS tokens are *operator-side* and *scoped to specific operational verbs* (`kws.proforma.read`, `kws.dns.execute` etc.) — different threat model.
- Mitigations that keep the exception narrow:
  - **Revocable.** Per the KWS instruction pack §3.2, KWS tokens are revocable via the existing Identiti revocation surface. A compromised token has a finite life ≤ time-to-detection + revocation latency, NOT 72h.
  - **Per-scope.** Tokens are issued narrowly (e.g. `kws.dns.execute` alone), not as broad bearer credentials. A leaked token unlocks one verb, not the operator's full powers.
  - **Logged with `content_hash`.** KWS-side `proforma_approvals` records the token usage; misuse is traceable.
  - **Operator-only.** Customers never hold these tokens. The attack surface is the KWS Amara console, which is already FIDO2-gated per ID-17.
- Compared to revoking §A.1 entirely: keeping it as the default and listing KWS as a documented exception is much safer than weakening §A.1 platform-wide.

**Action.** When `docs/H4_HELPAN_AI_JOINT.md` was Identiti's sign-off on Helpan AI's contract, ID-16 should produce an analogous doc: `docs/KWS_PHASE2_DELEGATION.md` recording the 72h exception with the four mitigations above.

**Blast radius.** Paper only; no code change to §A.1 itself. ID-16 ships its own ADR/sign-off doc when KWS-S10 lands.

---

## Q3 — Operator surface shape (ID-17)

**Question.** Sub-surface of `/v1/auth/challenges` + `/v1/stepup/verify` with `operation_kind=operator.<rail>.<action>`, or a separate `/v1/operator/auth/*` family?

**Position (per pack recommendation, settled):** **Sub-surface.** Reuse the existing step-up flow with operator-scoped `operation_kind` values.

**Why.**
- The step-up surface already encodes the right primitives: audience-bound JWT, single-use JTI, audit-logged, FIDO2 factor extensible.
- A separate `/v1/operator/auth/*` family duplicates: challenge initiate, factor verify, JWT mint, JWKS publish. Nothing gained.
- Operator step-up *is* step-up with `factor=hardware_key`. The action being authorised varies by `operation_kind` (`operator.todoku.template_approve` etc.) — the same dimension already used for customer-side step-up.
- Auditing is already keyed off (audience, operation_kind) — operator events fit cleanly.

**Blast radius.**
- ID-17 adds `hardware_key` to the `auth_challenges.factor` enum (currently `phone_otp` only).
- ID-17 adds operator-flavoured operation_kind values per the pack: `operator.todoku.template_approve`, `operator.itafika.kyc_decision`, etc.
- New WebAuthn factor adapter — the biggest single chunk of ID-17.

---

## Q4 — Consent storage canonical location (ID-14)

**Question.** Identiti canonical (Hakken's assumption), or aggregated from per-app sources?

**Position (tentative — needs Chamia confirmation):** **Identiti canonical.** Identiti stores the authoritative consent record; consuming apps cache and invalidate via webhook.

**Why.**
- Identiti is already the trust root for cross-rail identity (Account UUID). Consent attaches naturally to identity.
- Single source of truth simplifies the legal posture under DPA 2019. ODPC investigators expect one authoritative place to read the consent ledger.
- Per-app storage fragments. A "did the user consent to scope X on app Y at time Z" query becomes N round-trips.
- Hakken's HK-4 assumption already points here; not contradicting it keeps that sprint un-blocked.
- The aggregated/derived model still works if needed — but it imposes ordering and timeliness constraints that the canonical model doesn't.

**Blast radius.**
- New `consent_grants` table in Identiti: `(account_uuid, app_id, scope, granted_at, revoked_at NULL, revoke_reason, revoked_by)`.
- Schema enforces "one open grant per (account, app, scope)" via partial-unique index (same pattern as `tier_history`).
- New `identiti.consent.events` Kafka topic for `consent_granted` / `consent_revoked` / `scope_degraded`.
- Webhook delivery: reuse the pattern Helpan AI uses (HMAC-signed, retry schedule 30s→24h).

**If Chamia disagrees:** ID-14 becomes a pure aggregator surface — `GET /v1/consent/:user_uuid` reads from per-app sources (likely Helpan AI's OAuth registry first). The webhook side falls away. ~2 days of rework.

---

## Q5 — KYB sub-surface (ID-13)

**Question.** Extend `/v1/customers/:uuid/kyc/iprs` with `subject_type=business|director`, or new `/v1/kyb/*` family?

**Position (per pack recommendation, settled):** **New family `/v1/kyb/*`.**

**Why.**
- KYB is fundamentally different from individual KYC: business-registry probe (BRS / e-Citizen), ownership structure, director-aggregation, ongoing director-KYC re-evaluation as boards change.
- Forcing it into `/v1/customers/:uuid/kyc/iprs` with a `subject_type` discriminator creates schema confusion — the URL says "customer," the body says "business."
- A clean `/v1/kyb/{kyb_id}` family with its own resource model fits LipaStack's natural domain (merchants, not customers).
- Director-KYC reuses the existing customer-KYC path (each director is an individual customer with their own `acc_<uuid>`); the KYB orchestration COMPOSES those verdicts.

**Blast radius.**
- New `kyb_records` family of tables (or one fat table with JSONB ownership) — design TBD at ID-13 kick-off.
- New `identiti.kyb.events` topic for `kyb.verified`, `kyb.rejected`, `kyb.pending_info`.
- Existing customer-KYC surface (`/v1/customers/:uuid/kyc/iprs`) unchanged.

---

## Q6 — KWS delegation signer (ID-16)

**Question.** Identiti directly via `/v1/internal/sign` (ID-10 surface), or Helpan AI signs per the §A.5 split?

**Position (per pack recommendation, settled):** **Helpan AI signs.**

**Why.**
- Reboot Pack §A.5 codifies the split: **Identiti = OAuth issuance authority** (the credential primitives); **Helpan AI = agent registry, scope catalogue, dispatch, audit** (the agent surface).
- KWS scoped tokens (`kws.proforma.read`, `kws.dns.execute`, etc.) are agent-flavoured — the holder is "the KWS Amara console operator acting as an agent on the customer's behalf in a contract-development workflow."
- Routing KWS through Identiti's `/v1/internal/sign` (ID-10) would dilute the split: ID-10 is specifically Helpan-AI-only by design (HMAC tenant pin to `HELPAN_AI_APP_ID`).
- Helpan AI already signs the `daa_<ULID>` delegated-authority tokens — KWS scoped tokens are a sibling shape with `kws_*` scopes instead of cross-rail scopes. Same machinery.

**Blast radius.**
- ZERO net-new code in Identiti for ID-16.
- ID-16 becomes a Helpan AI sprint that consumes Identiti's existing JWKS publish + customer-token validation surfaces. Identiti just keeps publishing.
- A short Identiti-side `docs/KWS_PHASE2_DELEGATION.md` records the joint contract when KWS-S10 firms up.

---

## Net effect on ID-12..ID-17 build plan

Given the positions above:

| Sprint | Status after this doc |
|---|---|
| ID-12 Rider-KYC | Tier semantics tentatively orthogonal (Q1). Code can be scaffolded assuming orthogonal; rework is ~1 day if Chamia disagrees. |
| ID-13 KYB | New family `/v1/kyb/*` settled (Q5). Schema design TBD at kick-off; capacity-planning conversation flagged. |
| ID-14 Consent surface | Identiti canonical tentatively (Q4). Schema design proceeds against canonical assumption; flag to Hakken at HK-0. |
| ID-15 LipaStack audience | Trivial config — **shipping today** alongside this doc. No design questions. |
| ID-16 KWS delegation | Helpan AI signs (Q6) — zero net-new Identiti code. Paper sign-off doc when KWS-S10 firms. 72h exception documented (Q2). |
| ID-17 Operator surface | Sub-surface of step-up (Q3) — settled. Biggest piece is the WebAuthn / FIDO2 factor adapter. |

## Outstanding asks for Chamia

1. Confirm **Q1** (rider-KYC tier semantics). I'm building against `orthogonal rider_class`.
2. Confirm **Q4** (consent canonical in Identiti). I'm building against Identiti canonical.
3. Note **Q2** — KWS 72h documented as a deliberate, narrow exception; if you want it tightened, say so before KWS-S10.
