# Production runbook

**Service:** Render `mihir-task-manager` (Node 22, `npm start`) · **Database:** Supabase "Task Manager (Mihir)" ·
**Code:** GitHub (auto-deploy on push to `main`).

## Deploy
1. `npm test` locally (all green). 2. `npm run backup` against production (or check last night's GitHub Actions backup).
3. Push to GitHub → Render builds and starts; migrations run automatically on start (transactional, locked).
4. Smoke test: `https://<site>/readiness` → `"status":"ready"` + expected `schemaVersion`; log in; create and
   complete a test task; Admin → **System Health** shows no failed jobs. 5. Add a CHANGELOG.md entry.

## Roll back
Render → Events → previous deploy → **Rollback**. All migrations are additive, so older code runs on the newer schema.
Never drop columns/tables in the same release that stops using them.

## Health & logs
`/health` = process alive (public, minimal). `/readiness` = database round-trip ≤ 5 s + schema version + timezone.
Set Render → Settings → **Health Check Path = `/readiness`** (currently empty). Logs: Render → Logs; JSON lines with
`requestId` (also returned as `X-Request-Id` to the browser — ask users for it when they report a problem).

## Background jobs
Admin → **System Health**: queued / retrying / dead-letter jobs and failed deliveries, with **Retry**.
Jobs: REMINDER_RUN (5 min), WEEKLY_DIGEST (Mon 09:00), PERIOD_AWARDS (00:30), STORAGE_RETENTION (02:30),
CLEANUP (03:00), plus WHATSAPP_MESSAGE / INGEST_PROCESS / MEETING_PROCESS on demand. To pause the worker:
`DISABLE_JOB_WORKER=true` (web keeps working; jobs wait in the table).

## Environment variables
See `.env.example` (every variable the code reads, grouped, with defaults). Changing a variable in Render triggers a redeploy.

## Common problems
| Symptom | Check / fix |
|---|---|
| First visit slow in the morning | Free plan sleeps after 15 min → Render Starter (always on) |
| Reminders late | Server asleep at the window time (free plan) → always-on plan; System Health → REMINDER_RUN jobs |
| AI features say "budget reached" | System Health → AI usage; raise `MONTHLY_AI_BUDGET_INR` or wait for next month |
| WhatsApp messages not answered | Feature flag, `WHATSAPP_APP_SECRET`, Meta webhook subscription, System Health → WHATSAPP_MESSAGE jobs |
| Push not received | System Health → failed deliveries; user must tap "Turn on" on each device |
| 520 errors | Server overloaded or restarting → Render metrics; slow queries are cut at 25 s |
