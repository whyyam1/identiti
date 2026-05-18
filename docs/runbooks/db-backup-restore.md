# Runbook — Database Backup, Restore, and DR Drill

Database: Supabase project `tjqpyblyoslyoplmnlua` (Postgres 17, eu-west-1).
12 tables, RLS on all; the only stateful component of the rail.

## 1. Backups

Supabase manages backups; the coverage depends on the project's plan.

- **Daily backups** — taken automatically; retention is plan-dependent.
- **Point-in-Time Recovery (PITR)** — restore to any moment within the
  retention window. PITR is a paid add-on; **confirm it is enabled before
  Stage 2** — without it the recovery floor is the last daily backup (up to
  ~24 h of potential data loss).

Check / enable in the Supabase dashboard → Database → Backups.

**Action before ID-Beta:** verify PITR is on. A rail holding the platform's
heaviest PII surface (Reboot Pack §ID-D-09) should not run Stage 2 on
daily-snapshot-only recovery.

## 2. What a backup must capture

All 12 tables, but the irreplaceable ones:

- `platform_accounts`, `phone_records` — customer identities + encrypted MSISDNs.
- `app_credentials` — tenant HMAC secrets; losing this locks every consumer out.
- `audit_log` — hash-chained, 7-year retention (Reboot Pack §9.5); legally
  required and non-reconstructable.
- `kyc_records`, `step_up_tokens`, `delegated_authority_signings` — KYC + auth
  history.

Application RS256 keys and crypto keys are **not** in the database — they are
Railway env vars. A DB restore alone does not restore signing capability; see
`key-and-secret-rotation.md`.

## 3. Restore procedure

1. **Stop writes.** In Railway, pause the Identiti service (or scale to 0) so no
   new rows are written mid-restore.
2. **Restore** in the Supabase dashboard → Database → Backups → choose a daily
   backup *or* a PITR timestamp → Restore. Supabase restores in place.
3. **Verify schema** — 12 tables present, migrations `0001`–`0008` all applied:
   ```sh
   node --input-type=module -e "import 'dotenv/config';import postgres from 'postgres';const sql=postgres(process.env.DATABASE_URL,{max:1,prepare:false});const t=await sql\`select count(*)::int n from information_schema.tables where table_schema='public'\`;console.log('tables:',t[0].n);await sql.end()"
   ```
4. **Verify the audit chain** — the hash chain must still be intact end to end;
   a break means a partial/corrupt restore.
5. **Resume** the Railway service. Smoke test `/v1/health`, then one
   authenticated call with a seeded tenant.

If the connection string changed (new project), update `DATABASE_URL` in
Railway Variables and in local `.env` before resuming.

## 4. DR drill (ID-Beta execution item)

The procedure to rehearse at Stage 2 — **do not run against production data**;
use a clone/branch:

1. Create a Supabase branch or a throwaway project from a backup.
2. Point a non-production Identiti instance at it.
3. Simulate loss: restore to a PITR point ~1 h in the past.
4. Measure **RTO** (time to a serving rail) and **RPO** (data-loss window).
5. Record both against the DoD §7.3 targets; file gaps.
6. Confirm the audit-log hash chain survived the restore.

This drill is blocked on having a production-grade deployment to rehearse
against — it is an ID-Beta item, not doable in the dev sandbox.

## 5. Quick reference

| Situation | Action |
|---|---|
| Accidental bad data / bad migration | §3 — restore to a PITR point just before it |
| Project lost entirely | Restore into a new project; update `DATABASE_URL` everywhere (§3 step + Railway/.env) |
| "Is PITR on?" | Supabase dashboard → Database → Backups — **verify before Stage 2** |
| Post-restore sanity | 12 tables, migrations 0001–0008, audit chain intact, `/v1/health` 200 |
