# Identiti — Operations Runbooks

Operational procedures for the Identiti rail. These are **ID-Beta (Stage 2)**
prerequisites — Stage 2 closed beta requires runbooks, a DR drill, a load test,
and pen-test resolution (DoD §7.3). The runbooks below are the parts writable
ahead of the Stage-2 gate; the DR drill and pen-test themselves still need a
production-grade deployment and an external firm respectively.

| Runbook | Covers |
|---|---|
| [`deploy-and-rollback.md`](deploy-and-rollback.md) | Deploying to Railway; rolling back a bad deploy; environment promotion |
| [`db-backup-restore.md`](db-backup-restore.md) | Supabase backups, point-in-time recovery, the DR drill procedure |
| [`key-and-secret-rotation.md`](key-and-secret-rotation.md) | Rotating RS256 signing keys, HMAC tenant secrets, crypto keys, the DB password |

## Conventions

- **Sandbox** = the current Railway dev-mode deploy. **Staging/Production** =
  later Stage advances (`NODE_ENV=staging` / `production`).
- All deploys build from `github.com/whyyam1/identiti` via Nixpacks
  (`railway.json`). See [`../RAILWAY_DEPLOY.md`](../RAILWAY_DEPLOY.md) for the
  env-var matrix.
- Database is Supabase project `tjqpyblyoslyoplmnlua` (Postgres 17, eu-west-1).
- These runbooks are living documents — correct them the first time reality
  diverges from what's written.

## Not yet covered (Stage 2 gate)

- **DR drill** — needs a production-grade deployment to rehearse against; the
  *procedure* is in `db-backup-restore.md §4`, the *drill itself* is an ID-Beta
  execution item.
- **Load test** — needs the `staging` deployment; plan in
  `deploy-and-rollback.md §5`.
- **Pen-test resolution** — needs an external testing firm (Track A
  procurement, Reboot Pack §13.5).
- **Incident response** — author once Stage 2 on-call rotation is defined.
