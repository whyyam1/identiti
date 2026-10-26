# Identiti — Canonical Connection Values

**Status:** authoritative. If a rail's config disagrees with this file, the rail is wrong.
**Verified:** 26 Oct 2026, against the live deployment and Identiti source.
**Why this exists:** six rails each guessed Identiti's connection values and most guessed wrong. Two of them hardcoded a wrong JWT issuer **in source**, which would reject every token Identiti issues. This file is the single place to copy from.

---

## 1. The one distinction that causes all of this

**An issuer and an audience are identifiers. A base URL and a JWKS URL are addresses.**

| Kind | Must resolve in DNS? | Example |
|---|---|---|
| **Issuer** (`iss`) | ❌ **No. Never fetched.** | `https://api.id.identiti.co.ke` |
| **Audience** (`aud`) | ❌ **No. Never fetched.** | `https://api.todoku.co.ke` |
| **API base** | ✅ **Yes** — you make HTTP calls to it | `https://identiti-production.up.railway.app` |
| **JWKS URL** | ✅ **Yes** — you fetch keys from it | `…up.railway.app/.well-known/jwks.json` |

A JWT `iss` is a URI used for *string comparison* during verification. It is not an endpoint. `https://api.id.identiti.co.ke` not resolving is **correct and expected** — nothing should ever call it.

**So: do not "fix" the issuer by pointing it at the Railway host.** That breaks verification everywhere at once, because the `iss` claim inside every already-issued token would no longer match. The issuer stays as published below, forever, regardless of where the rail is hosted.

---

## 2. Copy these values

```bash
# ── Addresses (must resolve — these are the ONLY working ones today) ──
IDENTITI_API_BASE   = https://identiti-production.up.railway.app
IDENTITI_JWKS_URL   = https://identiti-production.up.railway.app/.well-known/jwks.json

# ── Identifiers (must NOT be changed; never fetched) ──
IDENTITI_JWT_ISSUER = https://api.id.identiti.co.ke
```

Note the issuer has **`.id.`** in it: `api` **`.id.`** `identiti.co.ke`. The most common error across the platform is dropping that segment.

**Signing keys** (stable, from `secrets/railway-staging.env`; the JWKS no longer rotates on restart):

| Key class | `kid` |
|---|---|
| `step_up` — step-up tokens, customer tokens, audience tokens | `lrnn8c8kQzc0GJsU` |
| `delegated_authority` — Helpan AI `/v1/internal/sign` output | `helpan-da-2026-q2` |

Both are published at the JWKS URL. Algorithm is `RS256` throughout.

---

## 3. ⚠️ No `*.co.ke` host resolves anywhere on this platform

Verified 26 Oct 2026 by direct HTTPS request — every one fails to connect:

| Host | Result |
|---|---|
| `api.id.identiti.co.ke` | ❌ no connection *(fine — issuer only, never called)* |
| `api.identiti.co.ke` | ❌ no connection *(and not a real Identiti value at all — see §4)* |
| `sandbox.id.identiti.co.ke` | ❌ no connection *(GAP-5 — never wired)* |
| `api.helpan.co.ke` | ❌ no connection |
| `helpan.co.ke` | ❌ no connection |
| `hakken.co.ke` | ❌ no connection |
| `identiti-production.up.railway.app` | ✅ **HTTP 200** |

The custom-domain layer was never provisioned for any rail. Every `*.co.ke` value in every rail's config is either an identifier (fine) or a dead address (broken). **Railway hostnames are the only working addresses today.**

When GAP-5 is wired, only the **addresses** change. The issuer does not.

---

## 4. `api.identiti.co.ke` is not an Identiti value

It appears in several rails' configs. It is wrong in both roles:

- **As an address** — it does not resolve, and never did.
- **As an issuer** — Identiti issues `https://api.id.identiti.co.ke`. A verifier pinned to `api.identiti.co.ke` **rejects every Identiti token**, because the `iss` string does not match.

It looks like a plausible guess that propagated by copy-paste between rails. Identiti has never published it.

---

## 5. Known misconfigurations across the rails (26 Oct 2026)

Found by scanning the sibling repos. **Not fixed from the Identiti session — each rail owns its own config.**

### 🔴 Severe — wrong issuer hardcoded in source

| Location | Problem |
|---|---|
| `kipkiren-pay/src/services/stepUpVerifier.ts:39` | `KP_STEP_UP_ISSUER = "https://api.identiti.co.ke"` — **KP will reject every step-up token Identiti issues.** This is the exact cross-rail failure ID-5 and ID-11 exist to catch. |
| `helpan-ai-rail/src/modules/authorities/claimBuilder.ts:22` | `identiti: 'https://api.identiti.co.ke'` — wrong issuer baked into claim construction. |

Both need `https://api.id.identiti.co.ke`.

### 🟠 Dead addresses in live config

| Location | Problem |
|---|---|
| `kipkiren-pay/.env:51-52` | `IDENTITI_API_BASE` + `IDENTITI_JWKS_URL` → `api.identiti.co.ke`. **Live `.env`, not an example.** |
| `kipkiren-pay/.env.example:47-48` | Same, propagates to new deploys. |
| `helpan-ai-rail/.env.example:35`, `:43` | `IDENTITI_JWKS_URL`, `IDENTITI_INTERNAL_SIGN_URL` → dead host. |
| `todoku-prod/.env.example:46`, `:68` | `IDENTITI_API_BASE`, `CUSTOMER_JWT_JWKS_URL` → dead host. |

### 🟡 Wrong issuer in examples and tests

`todoku-prod/.env.example:69` · `helpan-ai-rail/.env.example:36` · `helpan-ai-rail/src/config/env.test.ts:33-34,95-96` · `helpan-ai-rail/src/modules/authorities/claimBuilder.test.ts:4`

The Helpan tests are self-consistent, so they pass while asserting the wrong value — which is why this survived.

### ✅ Already correct

- `helpan-ai-rail/.env:33` — `IDENTITI_JWT_ISSUER=https://api.id.identiti.co.ke`, with a comment at `:38` calling out the issuer host. Someone fixed the live value but not the example or the source constant.
- `octopus-api/src/core/rails/identiti.dto.ts:75` — comment correctly documents `iss=api.id.identiti.co.ke`.

---

## 6. How to check your rail in one command

```bash
# Should print the issuer WITH .id. — anything else is a bug:
grep -rn "identiti.co.ke" . --include="*.ts" --include="*.env*" --exclude-dir=node_modules

# Should return 200 and a JSON body with "rail":"identiti":
curl -s https://identiti-production.up.railway.app/v1/health

# Should return 200 and two keys (kids lrnn8c8kQzc0GJsU + helpan-da-2026-q2):
curl -s https://identiti-production.up.railway.app/.well-known/jwks.json
```

If `/v1/health` returns 200, that proves only that the process is up — **it does not touch the database** (`src/routes/health.ts`). For a real check, run `scripts/smoke-identiti.mjs` with a tenant credential. `/v1/health/deep` is proposed but not built.
