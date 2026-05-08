# Identiti — Integration Map

**Document type:** Inter-rail integration reference
**Owner:** Platform Engineering, KMV
**Audience:** Anyone building, operating, or auditing Identiti
**Companion documents:** `Identiti_Rail_Contract_v1_0_Scaffold.md`, `Identiti_Rail_Contract_v1_0_Schema_Appendix.md`, `Platform_Rails_Reboot_Pack_v1_2.md`, `Claude_Code_Instruction_Pack_Platform_Rails_v1_0.md`

---

## 1. What Identiti does

Identiti is the **identity rail** for the KMV platform. It is the source of truth for every customer-bearing fact that is not money and not a message: who the customer is, what tier of trust they are at, what their authoritative phone number is, whether a sensitive operation has been step-up authorised, and whether they have been screened against sanctions and PEP lists. Identiti issues the **Account UUID** — the universal foreign key that every other rail and every consuming app uses to identify a customer.

**Legal entity:** Identiti Ltd *(home decision pending counsel; recommendation is a separate entity from incorporation)*
**Regulatory class:** DPA 2019; CA-K where applicable (heaviest PII surface on the platform)
**Domain:** `identiti.co.ke`
**Technology:** Node.js 22 LTS, TypeScript 5.x strict, Fastify 4.x, AJV, PostgreSQL 16 (Supabase `identiti` project, `af-south-1`), Drizzle ORM, Kafka (`kafkajs`), Railway

---

## 2. The cardinal rule — Identiti's boundary

> **Identiti owns identity. It does not hold customer funds. It does not run SMS infrastructure.**

What Identiti must NOT do:

- Hold any customer balance, transactional ledger, payment intent, or anything denominated in KES — Kipkiren Pay does that.
- Send SMS, voice, or WhatsApp messages itself. When Identiti needs to deliver an OTP for a step-up challenge or for account verification, it **publishes a Kafka event** (`STEP_UP_REQUIRED`) and Todoku consumes it. Identiti does not call the Todoku HTTP API for OTP delivery.
- Initiate a financial operation. Identiti only **authorises** financial operations by issuing a step-up token to the consuming app, which the app passes to Kipkiren Pay.
- Expose raw MSISDNs to apps or to other rails through any public surface. Apps receive **phone tokens** (opaque JWTs); Todoku receives an **encrypted MSISDN** via the rail-internal `phone-tokens/resolve` endpoint and decrypts in-memory only.
- Retain tier promotions or KYC material indefinitely on a customer who has exercised data subject rights to delete — DPA 2019 governs.

If Identiti finds itself doing any of the above, that is a contract violation and the request must be rejected.

---

## 3. Upstream dependencies — what Identiti relies on

### 3.1 IPRS (Integrated Population Registration Service)

External government dependency. Required by NPS Reg 12(2) for Tier 1+ verification. Track A item — government-mediated access. **Stubbed in development** with `IPRS_STUB_MODE=true` until live access is provisioned. The stub returns deterministic verification responses based on a fixture file; production swaps in the live IPRS adapter.

### 3.2 KYC vendors

External Track A dependency: face match, liveness, ID document validation. Wrapped in `KycVendorService`. Stubbed at v1 build time; swapped in at Stage 2.

### 3.3 Sanctions / PEP screening vendor

External Track A dependency. Wrapped in `SanctionsService`. Called from the KYC submission handler. Stubbed at v1 build time.

### 3.4 Behavioural biometrics SDK

Track A dependency. Identiti consumes risk signals from a platform library distributed to consuming apps. The interface is stubbed in the v1 build sprint; full SDK integration is post-sprint.

### 3.5 Rails

**Identiti has no upstream rail dependencies.** It is the root of the trust graph. Both Kipkiren Pay and Todoku depend on Identiti; Identiti depends on neither.

---

## 4. Downstream consumers — what relies on Identiti

### 4.1 Consuming apps

Every consuming app calls Identiti for: account creation, authentication, KYC submission, step-up initiation/completion, phone token issuance, phone change requests. The full app-facing endpoint list is in §6 of the Claude Code Instruction Pack and the Schema Appendix.

### 4.2 Kipkiren Pay

KP consumes Identiti's tier signal (HTTP cache + Kafka invalidation), verifies step-up tokens against Identiti's JWKS, and reacts to account-state events (`TIER_CHANGED`, `ACCOUNT_SUSPENDED`, `PHONE_CHANGED`) on Kafka.

### 4.3 Todoku

Todoku resolves phone tokens against Identiti's rail-internal `phone-tokens/resolve` endpoint, and consumes step-up and account events on Kafka (e.g. to send the OTP SMS triggered by an Identiti step-up challenge).

---

## 5. Cross-rail interfaces

### 5.1 Outbound HTTP — calls Identiti makes

| Target | Endpoint | When | Auth |
|---|---|---|---|
| IPRS | (vendor-specific) | On Tier 1+ KYC submission | IPRS-defined |
| KYC vendor | (vendor-specific) | On Tier 2 KYC submission | Vendor-defined |
| Sanctions vendor | (vendor-specific) | On every Tier 1+ KYC submission and on a periodic re-screen schedule | Vendor-defined |

**Identiti makes no rail-to-rail HTTP calls.** It does not call Kipkiren Pay. It does not call Todoku. Communication outbound to other rails is **always via Kafka**.

### 5.2 Inbound HTTP — endpoints exposed to other rails

| Endpoint | Caller | Auth | Purpose |
|---|---|---|---|
| `GET /.well-known/jwks.json` | Kipkiren Pay (and any rail verifying RS256 step-up tokens) | None — public | Publish Identiti's RS256 public key set so step-up token signatures can be verified locally without an HTTP round-trip per token |
| `GET /v1/accounts/{account_uuid}/tier` | Kipkiren Pay | HMAC-SHA-256 (rail-prefix `Identiti`); `KIPKIREN_PAY` app credential | Tier and limits lookup. Cached by KP for 60 seconds; invalidated on Kafka `TIER_CHANGED`. Short response, no PII |
| `POST /v1/phone-tokens/resolve` | Todoku only | HMAC-SHA-256; `TODOKU` app credential; scope `phone_token:resolve` | Resolve a phone token JTI to an encrypted MSISDN. Returns ciphertext only; Todoku decrypts in-memory inside the vendor adapter and never persists or logs the plaintext |

The `phone-tokens/resolve` endpoint is **not available to consuming apps**. The `app_credentials.scopes` for any non-Todoku tenant excludes `phone_token:resolve` and the route handler enforces the scope check.

### 5.3 Kafka — topics published by Identiti

| Topic | Event type | Trigger |
|---|---|---|
| `identiti.account.events` | `ACCOUNT_CREATED` | New platform account created |
| `identiti.account.events` | `TIER_CHANGED` | Account tier promoted or demoted |
| `identiti.account.events` | `ACCOUNT_SUSPENDED` | Account suspended by operator |
| `identiti.account.events` | `ACCOUNT_REACTIVATED` | Account reactivated |
| `identiti.phone.events` | `PHONE_CHANGED` | Phone number successfully changed (after two-phone OTP cooldown flow) |
| `identiti.kyc.events` | `KYC_APPROVED` | KYC record approved; tier promotion triggered |
| `identiti.kyc.events` | `KYC_REJECTED` | KYC record rejected |
| `identiti.step_up.events` | `STEP_UP_REQUIRED` | Step-up challenge initiated; downstream rail (Todoku) sends the OTP |

These are consumed by Kipkiren Pay and Todoku as listed in their respective integration maps.

### 5.4 Kafka — topics consumed by Identiti

**None at v1.** Identiti is the upstream root. It publishes; it does not subscribe to other rails.

---

## 6. The Account UUID — Identiti's most important deliverable

The Account UUID is a **ULID issued by Identiti at account creation**. It is permanent, never reused, never reissued. It is the universal foreign key:

- Kipkiren Pay's `accounts.id` IS the Account UUID.
- Todoku's `messages.phone_token_jti` references a phone token issued against the Account UUID.
- Every consuming app stores the Account UUID against its internal user record.

A consequence: Identiti must treat Account UUID issuance as a write that cannot be undone. Account suspension is reversible; Account UUID retraction is not. Operator console exposes suspend/reactivate, never delete.

---

## 7. The two token surfaces Identiti issues

### 7.1 Step-up tokens (RS256)

- **Algorithm:** RS256 (RSA-SHA-256 asymmetric)
- **Key custody:** Private key in secrets manager; public key in JWKS
- **Rotation:** 90-day cadence; previous key retained in JWKS for 24-hour overlap
- **Claims:** `iss=identiti`, `sub=<account_uuid>`, `aud=<rail>` (e.g. `kipkiren_pay`), `intended_operation`, `factors_used[]`, `jti=<ULID>`, `iat`, `exp` (issued + 5 minutes)
- **Single-use enforcement:** by JTI; verified by the consuming rail in its `step_up_tokens` table with a unique constraint
- **Verification:** consuming rails verify locally against JWKS — no per-token HTTP round-trip to Identiti

### 7.2 Phone tokens (HS256, opaque)

- **Algorithm:** HS256 with a per-account-per-audience derived key
- **Audience at v1:** `todoku` (only)
- **TTL:** 15 minutes
- **Verification:** Todoku does **not** verify the JWT signature. It calls `POST /v1/phone-tokens/resolve` and treats Identiti's response as authoritative
- **Why this asymmetry:** step-up tokens are read locally by the rail accepting risk; phone tokens are read by a rail that needs the resolved MSISDN and the resolution itself is the authorisation

---

## 8. The OTP flow — why Identiti does not call Todoku directly

When a step-up challenge needs an OTP delivered to the customer:

1. App calls `POST /v1/step-up/initiate` on Identiti.
2. Identiti generates an OTP (`crypto.randomInt`, 6 digits, 5-minute TTL), stores its bcrypt hash, and **publishes** `STEP_UP_REQUIRED` to `identiti.step_up.events` with the Account UUID, the challenge ID, and the OTP plaintext (encrypted-at-rest within the Kafka payload using a Todoku-specific public key).
3. Todoku consumes the event, resolves the Account UUID's phone via the same internal channel, sends the SMS through its envelope-enforced send path.
4. The user replies with the OTP.
5. App calls `POST /v1/step-up/complete` with the OTP; Identiti verifies the bcrypt hash; Identiti issues the step-up JWT.

This shape exists because **Identiti must not be a comms provider** and Todoku must not be allowed to bypass envelope enforcement, rate limits, vendor diversity, and SIMjacker filtering for an OTP send. The Kafka boundary preserves both rules.

---

## 9. DPA 2019 obligations — non-negotiable

- ODPC registration for Identiti Ltd before Stage 3 production go-live.
- Designated Data Protection Officer.
- DPIAs on every new processing activity that touches PII.
- Data subject rights handling: access, rectification, erasure, portability — exposed via the operator console; SLA per the Act.
- 72-hour breach notification to ODPC.
- 7-year retention on security and financial events; tier-by-tier retention on KYC material per DPIA outcomes.

These are hard preconditions for Stage 3, not "nice to have." They constrain how operations work, not just how the API works.

---

## 10. Out of scope for Identiti at v1

Customer self-serve tier promotion. Federated identity (Apple / Google / Facebook OAuth). Cross-border IPRS equivalents. Corporate / institutional Tier 3. Identity attestation to non-platform consumers (i.e. externalisation). Biometric sample export.

---

## 11. Agentic AI threat landscape and integration responses

**Authority:** Agentic AI Signal Scan (Chamia, 4 May 2026); Scan Integration Memo v1.0 (7 May 2026); Identiti Rail Contract Amendment §A (7 May 2026).

This section captures the v1.0 integration responses to the agentic AI threat landscape as it lands on Identiti specifically. Detailed contract language is in the Rail Contract Scaffold and Schema Appendix amendments; this section is the orientation guide.

### 11.1 The threats Identiti must withstand

| Threat | Source | Identiti exposure |
|---|---|---|
| Deepfake-as-a-Service ($10–50/attack; 8,065 injection attacks against one institution in 8 months) | Sumsub 2025; WEF Cybercrime Atlas Jan 2026 | KYC liveness pipeline — synthetic streams via virtual camera drivers bypass passive liveness |
| Synthetic identity fraud (21% of first-party frauds 2025; AI agents managing 18-month dormant profiles) | Sumsub 2025 | KYC at onboarding — IPRS validates real-person; post-onboarding monitoring is the gap |
| Adversary-in-the-Middle (AiTM) session-token theft (80% of MFA bypasses) | Microsoft Digital Defense Report 2025 | Authentication JWT — long-lived tokens are the primary AiTM target |
| Voice-cloning vishing for OTP authorisation (442% rise H2 2024) | CrowdStrike; FBI advisory May 2025 | Step-up OTP delivered via voice — impersonation of "KMV calling about your account" |
| Non-human identity at scale (50:1 to 144:1 NHI:human in enterprises) | CSA, Strata | Authenticating AI agents acting on user behalf — superseded by Helpan AI rail |

### 11.2 v1.0 integration responses (in this rail's contract)

| Response | Where | Scan item |
|---|---|---|
| **IAD on KYC vendor RFQ** — Injection-Attack Detection mandatory; ISO 25456 / CEN/TS 18099 alignment | Identiti Rail Contract Amendment §A.1 | ID-1 |
| **Authentication JWT TTL policy** — 30 min standard customer / 5 min elevated; 15 min standard service / 5 min elevated; no silent refresh on elevated | Identiti Rail Contract Amendment §A.2; Schema Appendix Amendment §A.4 | ID-5 |
| **JIT identity posture documented** — phone tokens 15-min, step-up 5-min single-use; no long-lived bearer tokens; no static service accounts | Identiti Rail Contract Amendment §A.3; Schema Appendix Amendment §A.5 | ID-8 |
| **`actor` claim on step-up JWT** — distinguishes subject (delegating user) from actor (executing entity, human or agent); implements emerging CSA / IMDA / OAuth 2.1 standard | Identiti Schema Appendix Amendment §A.1 | ID-4 part 1 |
| **`initiated_by` claim on step-up JWT** — names originating intent class (human / agent / system); enables cross-rail audit reconstruction | Identiti Schema Appendix Amendment §A.2 | KP-5, XR-1 |

### 11.3 v1.1 roadmap items

| Item | Where | Scan item |
|---|---|---|
| **CAEP real-time revocation** — supplements expiry-only revocation with active push-revocation events via Kafka | Identiti Rail Contract Amendment §A.5 | ID-4 part 2 |
| **Continuous behavioural monitoring** — post-onboarding velocity / device-fingerprint / step-up pattern inconsistency | Identiti Rail Contract Amendment §A.6 (under behavioural biometrics SDK) | ID-3 |

### 11.4 Items superseded by Helpan AI

The scan flagged "Identiti has no framework for authenticating AI agents" (ID-2) as a v1.1 roadmap item. **The Helpan AI rail (4th platform rail) is the framework.** The split is canonical:

- **Identiti is the OAuth issuance authority** — the regulator-friendly identity layer.
- **Helpan AI is the agent scope catalogue + agent registry + agent action dispatch layer.**

Apps consuming third-party agent OAuth tokens see Identiti as the issuer (per OAuth 2.0 / OIDC discovery) and Helpan AI as the scope authority.

### 11.5 Items raised for counsel / regulator engagement (out of artefact scope)

- DPA 2019 §31 (automated decision-making with significant effects) under agentic AI — counsel agenda item per Scan Integration Memo §3.

### 11.6 Cross-rail dependencies (`actor` and `initiated_by` propagation)

When the step-up JWT carries `actor` and / or `initiated_by` claims (per §11.2), Kipkiren Pay and Todoku consume them and propagate to their own audit logs. The cross-rail audit chain is:

```
Identiti step-up JWT (actor.type, actor.agent_id, delegated_authority_jti, initiated_by)
     │
     ├── consumed by Kipkiren Pay
     │     • payments.actor_type, .actor_agent_id, .delegated_authority_jti, .initiated_by
     │     • payouts (same)
     │     • audit_log entries
     │
     └── consumed by Todoku (where send is part of the same business operation)
           • messages.actor_type, .actor_agent_id, .delegated_authority_jti, .initiated_by
           • audit_log entries
```

This enables CBK / ODPC / internal-investigation reconstruction of agent-initiated business operations across all three rails.

---

## 12. Authoritative source documents

If anything in this map conflicts with the documents below, the source documents win and this map is wrong:

1. `Platform_Rails_Reboot_Pack_v1_2.md` — §7 (Identiti locked decisions), §16.8 (cross-rail wiring)
2. `Identiti_Rail_Contract_v1_0_Scaffold.md` + Amendment §A — endpoint list, error codes, response envelope, scan integration
3. `Identiti_Rail_Contract_v1_0_Schema_Appendix.md` + Amendment §A — JSON Schemas, scan-integration claim additions
4. `Claude_Code_Instruction_Pack_Platform_Rails_v1_0.md` + Amendment §A — §6 (Identiti build brief), §8 (cross-rail wiring), scan-integration build items
5. `App_Integration_Guide_v1_0.md` + Amendment §A — cross-rail lifecycle flows; scan-integration cross-rail patterns
6. `helpan-ai-rail/agentic_ai_scan.html` — Agentic AI Signal Scan (Chamia, 4 May 2026)
7. `helpan-ai-rail/helpan-ai-scan-integration-memo-v1.md` — Master plan for scan integration (7 May 2026)

---

*Integration map for Identiti. Reference document; not a contract. The contract is the Rail Contract v1.0 + Amendment §A.*
