# Automation & jobs

**Engine:** `backend/services/jobs.js` — jobs are rows in `automation_jobs`; workers claim with `FOR UPDATE SKIP LOCKED`
(never twice), every attempt is recorded in `automation_job_runs`, failures retry with exponential backoff
(30 s × 2ⁿ, max 1 h) and end as `dead_letter` after `max_attempts`; a crashed worker's job is recovered after its
10-minute lock expires; recurring schedules enqueue one job per time slot (idempotency key). Admin → System Health
lists problems with Retry.

| Job | When | Does |
|---|---|---|
| REMINDER_RUN | every 5 min | reminder engine (docs/PHASE2_REPORT.md) |
| WEEKLY_DIGEST | Mondays 09:00 IST | Admin digest of outstanding warnings |
| PERIOD_AWARDS | daily 00:30 | leaderboard award snapshots |
| STORAGE_RETENTION | daily 02:30 | deletes expired recordings/voice notes |
| CLEANUP | daily 03:00 | removes completed jobs older than 30 days (failed ones are kept) |
| WHATSAPP_MESSAGE / INGEST_PROCESS / MEETING_PROCESS | on arrival | integrations |

**Workflows in place (Phase 7B):** overdue → assignee, then creator (48 h, deadline passed, overdue 7/12 days) → Admin + HR
(60 h); meeting processed → organiser asked to review action items, participants notified of the summary; email /
WhatsApp commitment → suggestion → review → task. Not built: vendor follow-ups (there is no vendor module yet).
