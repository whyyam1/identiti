# KWS Phase 2 Delegation Contract (ID-16 — Identiti side)

**Status:** Paper sign-off, no net-new Identiti code.
**Date:** 22 May 2026.
**Source of truth:** Helpan KWS Phase 2 instruction pack §3.2; newdocs `NEWDOCS_INSTRUCTION_PACK.md` ID-16; `docs/NEWDOCS_DECISIONS.md` Q2 + Q6.
**Counterpart memo:** Helpan AI will produce the issuer-side counterpart (`<Helpan AI repo>/docs/KWS_PHASE2_DELEGATION.md`) when KWS-S10 starts. This file is the Identiti-side record.

---

## 1. The decision (Q6, settled 21 May 2026)

**Helpan AI signs KWS-scoped tokens.** Identiti does NOT sign them.

The Reboot Pack §A.5 split is binding:

- **Identiti** = OAuth issuance authority. Owns the customer Account UUID, the customer-token JWT, the step-up JWT, and the delegated-authority JWT (ID-10 surface). Publishes JWKS at `/.well-known/jwks.json`.
- **Helpan AI** = agent registry, scope catalogue, dispatch, audit. Owns `agt_<ULID>`, `daa_<ULID>`, and — Phase 2 — `kws_<ULID>` scoped tokens. Publishes JWKS at its own `/.well-known/jwks.json` (separate KID namespace from Identiti).

Routing KWS scoped tokens through Identiti's `POST /v1/internal/sign` (ID-10) would dilute the split: that surface is intentionally pinned to a single tenant (`HELPAN_AI_APP_ID`) and signs only the `helpan_authority_issuance` audience. KWS scoped tokens are a sibling shape with `kws_*` scopes instead of cross-rail scopes — Helpan AI signs them with its own delegated-authority key class.

## 2. Zero net-new Identiti code

ID-16 ships nothing on this rail. The cross-rail surfaces Helpan AI consumes are already live:

| Surface | What Helpan AI uses it for | Identiti version |
|---|---|---|
| Customer-token JWT (`/v1/auth/customer-token`) | Caller identity at token-mint time | ID-3 (shipped 8 May) |
| Step-up JWT (`/v1/stepup/verify`) | Proves the user authorised the delegation event | ID-5 (shipped 8 May) |
| Step-up `operation_kind` catalogue | `helpan_ai.authority_issuance` covers KWS delegation issuance | ID-10 (shipped 15 May) |
| JWKS (`/.well-known/jwks.json`) | Validates Identiti-signed tokens before issuing a downstream `kws_*` | ID-5 / ID-10 (live since 8 May; 2 keys since 15 May) |
| `actor` + `initiated_by` step-up claims | Records the agent that initiated the KWS workflow on the customer's behalf | ID-10 (request-side wired 15 May) |

If, when KWS-S10 starts, a missing primitive surfaces, this document is updated and a new Identiti sprint is opened.

## 3. 72-hour TTL — narrow §A.1 exception (Q2, confirmed 21 May 2026)

Reboot Pack §A.1 (JIT identity posture) sets the platform-wide ceiling at the step-up freshness band (60s for `very_high`, up to 600s for `low`) and the phone-token band (15 min). KWS scoped tokens are documented as a **narrow, named exception** to this rule.

**Why 72h.** The KWS workflow holds a contract-development session open for the duration of a legal-review window. The Amara console operator presents the user's consent once at session start (a step-up) and then drafts / iterates on a contract over the next 1–3 days, calling KWS endpoints with the scoped token throughout. Forcing a fresh step-up on every API call would either (a) require background OTPs the user cannot answer or (b) require the operator to keep prompting the user mid-draft. Neither is acceptable in the legal-review use case.

**Why this is safe.**

1. The 72h window is held by an **operator** with **FIDO2** (post-ID-17), not by a customer with phone OTP.
2. The scope catalogue is **narrow** — `kws.proforma.{read,write,issue}`, `kws.dispatch.{read,assign}`, `kws.contract.{read,draft}`. None of these scopes touch funds (KP), customer PII (Identiti), or message dispatch (Todoku) directly.
3. The token is **revocable** — Helpan AI publishes a revocation event (`helpan_ai.kws_revoked`) on `helpan_ai.agent.events` that subscribers honour (CAEP-shaped per §A.9). Identiti subscribes and tombstones the token at the audit-log level for traceability; no Identiti-side allow-list to invalidate.
4. The 72h ceiling is hard: tokens past 72h fail Helpan AI's own verifier regardless of revocation state.
5. **All KWS actions are logged.** Each scoped-token use is recorded both at Helpan AI (issuer-side audit) and at the relying KWS service (consumer-side audit). The `traceparent` + `business_op_id` invariant from Reboot Pack §A.11 carries through to KWS audit.

## 4. Cross-rail wire (what actually changes on the wire)

Phase 2 produces no new Identiti endpoints, headers, events, or scopes. The only flow Identiti observes is:

1. Operator presents user-consent step-up at KWS session start. Step-up `operation_kind` is `helpan_ai.authority_issuance` (already in the catalogue) with `operation_audience='helpan_authority_issuance'`. Identiti mints the step-up JWT.
2. Operator calls Helpan AI's `POST /v1/agent/kws/sessions` with the step-up JWT in `X-Stepup-Token`. Helpan AI verifies the JWT against Identiti's JWKS, single-uses the JTI per §16.3, and mints a `kws_<ULID>` scoped token (TTL 72h, scope set per session).
3. Operator calls KWS endpoints with the scoped token; KWS verifies against Helpan AI's JWKS (NOT Identiti's).
4. At revocation (manual or 72h expiry), Helpan AI publishes `helpan_ai.kws_revoked` on `helpan_ai.agent.events`. KWS invalidates; Identiti audit-logs (for `traceparent` join).

No Identiti table changes. No Identiti config knobs.

## 5. When this becomes a sprint

KWS-S10 (per the cross-rail `Platform_Rails_Reboot_Pack_v1_2.md` §16.8 sprint plan). At that point:

- Helpan AI implements `POST /v1/agent/kws/sessions` + the `kws_<ULID>` issuance shape.
- KWS implements the relying-party verification using Helpan AI's JWKS.
- This file is updated with the final scope catalogue and (if needed) any new step-up `operation_kind` values.

If KWS-S10 surfaces a need for a new Identiti primitive (e.g. a new audience, a new operation_kind, a new claim), the work opens as a separate Identiti sprint at that time. The current expectation is: zero.

## 6. References

- Reboot Pack §A.1 (JIT identity posture), §A.5 (Identiti vs Helpan AI split), §A.9 (CAEP-compatible topology), §A.11 (traceparent + business_op_id invariant).
- Newdocs Instruction Pack §ID-16; `docs/NEWDOCS_DECISIONS.md` Q2 + Q6.
- Helpan AI Delegated Authority Contract §8 (the strawman that ID-10 closed against).
- Helpan KWS Phase 2 instruction pack §3.2 (the requesting document).
