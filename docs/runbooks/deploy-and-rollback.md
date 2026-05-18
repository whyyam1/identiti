# Runbook — Deploy and Rollback

## 1. How deploys happen

Identiti deploys to **Railway**, building from `github.com/whyyam1/identiti`.

- Railway watches `main`. With the Railway GitHub App installed on `whyyam1`,
  every push to `main` triggers a build + deploy. Without it, trigger a deploy
  manually from the Railway dashboard.
- Build is Nixpacks-driven by `railway.json`: `pnpm install --frozen-lockfile`
  → `pnpm build` → start `pnpm start` (`node dist/index.js`).
- Railway gates the release on the healthcheck `GET /v1/health` (auth-exempt).
  A deploy that never answers `200` there is marked failed and is **not**
  promoted — the previous release keeps serving.

## 2. Standard deploy

1. Merge to `main`. CI (`.github/workflows/ci.yml`) must be green:
   lint → format:check → typecheck → test → build.
2. Railway builds the new commit. Watch **Build Logs** then **Deploy Logs**.
3. Confirm the healthcheck goes green and the app logs
   `Identiti API listening` with the expected `step_up_kid` /
   `delegated_authority_kid`.
4. Smoke test: `GET https://<domain>/v1/health` → `200` with the right
   `version` and `environment`.

## 3. Rollback

A deploy is bad if: the healthcheck fails, `/v1/health` is wrong, or a
regression is observed post-release.

**Railway keeps every prior deployment.** To roll back:

1. Railway dashboard → the service → **Deployments**.
2. Find the last known-good deployment.
3. **⋮ → Redeploy** (or "Roll back to this deployment").
4. Railway re-promotes that image; verify `/v1/health`.

Rollback is image-level and does **not** touch the database. If the bad deploy
also ran a migration, see §4 — code rollback alone is not enough.

## 4. Migrations and rollback

Migrations (`drizzle/0001`–`NNNN`) are **not** run on boot. They are applied
out of band (the `postgres` client, `psql`, or `pnpm db:migrate`). Therefore:

- A code rollback does **not** revert schema changes.
- Migrations are written additive / `IF NOT EXISTS` where possible, so a newer
  schema is generally compatible with the previous code revision.
- If a migration must be undone, write and apply a forward "down" migration —
  never edit an already-applied migration file.
- Order of operations for a schema-coupled release: apply the migration first
  (it stays compatible with old code), deploy the code second. Roll back code
  first; only roll back schema if strictly required.

## 5. Environment promotion (dev → staging → production)

`NODE_ENV` decides the strictness of `loadEnv()`:

| Stage | `NODE_ENV` | Extra required env |
|---|---|---|
| Sandbox (now) | `development` | none beyond `DATABASE_URL` + 4 crypto keys |
| Staging | `staging` | + `JWT_*_PEM`, `JWT_DA_*_PEM` (real RS256 keys) |
| Production | `production` | + `KAFKA_BROKERS` |

Promotion = change `NODE_ENV` in Railway Variables and supply the newly
required vars **before** redeploying — otherwise `loadEnv()` throws on boot and
the healthcheck fails (this is exactly the failure seen on the first sandbox
deploy). Full matrix in [`../RAILWAY_DEPLOY.md`](../RAILWAY_DEPLOY.md).

**Load test (ID-Beta):** run against the `staging` deployment, never the
sandbox-with-ephemeral-keys. Drive `/v1/health` plus a representative
authenticated path (e.g. `POST /v1/customers` with a seeded tenant) with
`autocannon` or `k6`; record p50/p95/p99 latency and error rate; compare to the
DoD §7.3 targets. This is an ID-Beta execution item — it needs `staging` up.

## 6. Quick reference

| Situation | Action |
|---|---|
| Healthcheck red on deploy | Check Deploy Logs → almost always a missing/invalid env var → fix Variables → redeploy |
| Regression after a green deploy | §3 rollback to the last good deployment |
| Bad deploy that also migrated | §3 rollback code, then §4 decide on schema |
| Promoting a stage | §5 — set `NODE_ENV` + new vars first, redeploy second |
