# Disaster recovery

## Targets (proposed — to be approved by management)
| | Now (Supabase Free) | After Supabase Pro + PITR |
|---|---|---|
| RPO (max data lost) | ≤ 24 h (nightly GitHub backup + Supabase daily) | ≤ 15 min (point-in-time recovery add-on) |
| RTO (time to restore service) | ≤ 2 h | ≤ 2 h |
| Restore test | Monthly (download a nightly backup, `npm run restore` into a scratch database) | Monthly |
| Backup retention | 30 days (GitHub artifacts) + Supabase's own | Per Pro plan + 30 days |
| Owner | Admin (Mihir Sabadra) | |

A backup counts only after a successful test restore.

## Backups
- **Nightly:** `.github/workflows/backup.yml` (02:00 IST) → artifact kept 30 days. Setup: repo secret `DATABASE_URL`.
- **Before every deploy / risky change:** `DATABASE_URL=… npm run backup`.
- Files (recordings, voice notes): Supabase Storage — recordings are temporary by design (30 days); tasks/history do not depend on them.

## Restore (database)
1. Create a new empty database (new Supabase project, or local PostgreSQL to test).
2. `DATABASE_URL="<new empty DB>" npm run restore -- backups/mihir-backup-<time>.json.gz` → refuses non-empty
   targets; restores everything in one transaction; prints OK per table.
3. Render → Environment → `DATABASE_URL` = new database → save (redeploys). 4. `/readiness` ready, log in, spot-check tasks.

## Scenarios
| Failure | Do this |
|---|---|
| Database down (Supabase incident) | Status: status.supabase.com. App shows errors; data safe. If prolonged: restore latest backup to a new project (above). |
| Bad migration | Migrations are transactional — a failed one leaves nothing half-done and the new deploy fails to start; Render keeps the old version. Roll back in Render. |
| Accidental deletion / data corruption | Restore the last good backup into a scratch DB, copy the needed rows back (or switch DATABASE_URL). With Pro + PITR: restore to the minute before. |
| Render outage / service broken | Rollback to previous deploy; if Render is down, deploy the same repo to another Node host with the same env vars. |
| Worker / jobs stuck | System Health → dead-letter jobs → fix cause → Retry. Jobs left "running" by a crashed process are recovered automatically after 10 min. |
| Storage failure | Uploads of recordings fail clearly; tasks unaffected. Meetings can still be processed without storage (recording not kept). |
| External API failure (AI, WhatsApp, push) | Normal task management continues. AI endpoints return a clear message; WhatsApp/ingestion jobs retry with backoff, then dead-letter for manual retry. |
| Credential compromise | See SECURITY.md → rotate, redeploy, review Audit Log. |
