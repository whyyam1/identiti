# Deploying Identiti to Railway

How to deploy the Identiti rail API to Railway. The repo is self-contained
(see `vendor/platform-shared/VENDORED.md`) so Railway builds it with no
private registry and no auth token.

## Build pipeline (already wired)

| Concern | How |
|---|---|
| Builder | Nixpacks (`railway.json`) |
| Package manager | pnpm 10.33.0, pinned via `packageManager` in `package.json` |
| Node version | 22 (`.nvmrc` + `engines.node`) |
| Build | Nixpacks auto-runs `pnpm install` then `pnpm build` (→ `dist/`) |
| Start | `pnpm start` → `node dist/index.js` (`railway.json`) |
| Health check | `GET /v1/health` (`railway.json`; auth-exempt) |
| Port | Railway injects `PORT`; the app binds `0.0.0.0:$PORT`. **Do not set `PORT` manually.** |

Nothing about the build needs configuring in the Railway UI — `railway.json`
carries it. Only environment variables need to be set.

## Deploy steps

1. **Railway → New Project.** Paste the public repo URL into the create box:
   `https://github.com/whyyam1/identiti`. (For auto-redeploy on every push,
   also install the Railway GitHub App on the `whyyam1` account — optional.)
2. **Set environment variables** (Variables tab) — see the checklist below.
3. **Deploy.** Railway builds with Nixpacks and starts the service.
4. **Verify:** `GET https://<your-railway-domain>/v1/health` → `200`.

Migrations `0001`–`0008` are **already applied** to the Supabase database, so
there is no migration step at deploy time. Future migrations are applied
manually (the app does not auto-migrate on boot).

## Environment variables

Pick a profile. `NODE_ENV` decides which variables are mandatory.

### Profile A — `development` (fastest first boot / smoke test)

RSA keys are generated ephemerally at startup; Kafka falls back to in-memory.
Minimal set — good for confirming the service boots and `/v1/health` answers.

| Variable | Value |
|---|---|
| `NODE_ENV` | `development` |
| `DATABASE_URL` | Supabase session-pooler string (the one in local `.env`) |
| `PHONE_ENCRYPTION_KEY` | 32-byte hex — `openssl rand -hex 32` |
| `PHONE_HASH_SALT` | 32-byte hex — `openssl rand -hex 32` |
| `PHONE_TOKEN_SIGNING_KEY` | 32-byte hex — `openssl rand -hex 32` |
| `KYC_HASH_SALT` | 32-byte hex — `openssl rand -hex 32` |

⚠️ **Caveat:** ephemeral RSA keys are regenerated on every restart/redeploy —
the JWKS changes and all previously issued JWTs stop verifying. Fine for a
solo smoke test; not fine once another rail integrates. Move to Profile B
before that.

### Profile B — `staging` (proper sandbox)

Everything in Profile A **except** `NODE_ENV=staging`, **plus** real RSA
keypairs so tokens survive restarts. Kafka may stay empty (staging tolerates
it; KP/Todoku aren't consuming yet).

| Variable | Value |
|---|---|
| `NODE_ENV` | `staging` |
| `JWT_PRIVATE_KEY_PEM` | RS256 private key — step-up + customer tokens |
| `JWT_PUBLIC_KEY_PEM` | matching public key |
| `JWT_DA_PRIVATE_KEY_PEM` | RS256 private key — delegated-authority signing (ID-10) |
| `JWT_DA_PUBLIC_KEY_PEM` | matching public key |
| `JWT_DA_KID` | literal kid, e.g. `helpan-da-2026-q2` |

Generate each keypair:

```sh
openssl genrsa -out priv.pem 2048
openssl rsa -in priv.pem -pubout -out pub.pem
```

Paste the **full PEM** (including the `-----BEGIN/END-----` lines) into the
Railway variable value — Railway's variable editor accepts multi-line values.
Single-line `\n`-escaped PEMs are also accepted (the loader un-escapes them).

### Optional variables (sensible defaults; override only if needed)

| Variable | Default | Notes |
|---|---|---|
| `LOG_LEVEL` | `info` (non-dev) | `debug` / `info` / `warn` / `error` |
| `RAIL_VERSION` | `0.1.0` | surfaced on `/v1/health` |
| `AUTH_HMAC_TOLERANCE_SECONDS` | `300` | HMAC timestamp skew window |
| `IDEMPOTENCY_TTL_SECONDS` | `86400` | 24h, per Rail Contract §6 |
| `JWT_ISSUER` | `https://api.id.identiti.co.ke` | token `iss` claim |
| `HELPAN_AI_APP_ID` | `helpan_ai_internal` | tenant allowed to call `POST /v1/internal/sign` |
| `OTP_BCRYPT_ROUNDS` | `10` | OTP hash cost |
| `IPRS_STUB_MODE` | `true` | keep `true` — no real IPRS adapter is wired (Reboot Pack §7 ID-D-06) |
| `KAFKA_BROKERS` | empty | comma-separated brokers; **required only when `NODE_ENV=production`** |
| `KAFKA_CLIENT_ID` | `identiti` | |
| `KAFKA_SSL` | `false` | |
| `KAFKA_SASL_MECHANISM` / `_USERNAME` / `_PASSWORD` | empty | leave blank to disable SASL |

`production` additionally requires `KAFKA_BROKERS` to be non-empty — don't use
`NODE_ENV=production` for the sandbox until a Kafka cluster is provisioned.

## Recommended path

1. First deploy with **Profile A** — confirm the service boots and
   `/v1/health` returns `200`.
2. Switch to **Profile B** (`NODE_ENV=staging` + four PEM vars) for a stable
   sandbox other rails can integrate against.

## Post-deploy note — tenant credentials

The Supabase database has the schema but **no `app_credentials` rows**. Every
authenticated endpoint will return `401` until tenant rows are seeded (the
`/v1/health` and `/.well-known/jwks.json` paths are auth-exempt and work
regardless). Seeding tenants is a separate task from this deploy.
