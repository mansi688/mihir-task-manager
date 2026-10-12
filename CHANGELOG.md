# Changelog

All production changes, newest first. Each release lists database changes, environment changes and
rollback notes. Deploy = push to GitHub `main` → Render auto-deploys. Rollback = Render → Events →
previous deploy → Rollback (all migrations are additive).

## [Unreleased] — Company chat
### Added
- Chat for everyone: All Company room + one room per department, open to all; @person, @[Department] and
  @everyone (Admin/Directors) tags with notifications that open the room; task IDs become links; unread badges;
  delete own messages (Admin: any, audited). docs/CHAT.md.
### Database: migration 005 (chat_messages, chat_reads, notifications.chat_room — additive). Environment: none.

## [Documents] / photos / video → tasks
### Added
- 📎 Tasks from a document or photo (PDF, Word, Excel, CSV, photos, short videos) in the app and via WhatsApp; files kept privately 90 days; per-type AI cost tracking.
### Database: none. Environment: `UPLOAD_RETENTION_DAYS` (optional).

## [Phases 7A, 8, 5, voice, WhatsApp, email, meetings]
### Added
- Job engine on PostgreSQL (retries, backoff, dead-letter, crash recovery, Admin retry); all background work runs as jobs.
- Migration 003 (foreign keys, safely validated) and 004 (ingestion items, AI suggestions, meeting sessions, AI cost in ₹).
- AI service (Gemini Flash-Lite / mock) with budget + usage log; universal ingestion → suggestions → human review → task.
- Voice tasks, "Tasks from a message", Suggestions page, Meetings page (consent notice, 30-day recording retention),
  WhatsApp inbound (signed webhook, CONFIRM/CANCEL, voice notes), email → task endpoint, System Health page.
- Supabase Storage service (private bucket, signed URLs, retention), feature flags (all off by default),
  nightly backup GitHub Action, Android app v1.4 (microphone permission).
- Docs: ARCHITECTURE, API, SECURITY, PRODUCTION_RUNBOOK, DISASTER_RECOVERY, AI, WHATSAPP, EMAIL, MEETINGS,
  AUTOMATION, TESTING, PRODUCTION_READINESS_REPORT.
### Fixed
- Microphone was blocked by the Permissions-Policy header; CORS open in production; restore order with foreign keys.
### Tests: 313/313. Database: migrations 003–004 (additive). Environment: see .env.example (all new features OFF by default).

## [Phase 2] — reminder engine, Follow Up
### Added
- One database-backed reminder engine (every 5 min): kept all existing rules; new T-3/T-2/T-1 windows
  (10:00/14:00/18:00 IST), "due today", overdue 3/5/7/12 days; combining; anti-spam gap; idempotency keys;
  catch-up after sleep; delivery log (`notification_deliveries`) for in-app, web push and WhatsApp.
- 📣 Follow up button (`POST /api/tasks/:id/nudge`, 5-hour gap per person, history event).
- `GET /api/notifications/deliveries` (Admin).
### Changed
- "Ask for Follow-up" renamed "Keep someone informed" (same behaviour).
- WhatsApp only for important notification types (`WHATSAPP_NOTIFY_TYPES`).
- History table times always shown in IST.
### Fixed
- Date-only deadlines: "due in X hours" now counts to the end of the deadline day.
### Tests: 297/297 passing. Database: no migration. Environment: optional reminder variables (see .env.example).

## [Phase 1] — task history
### Added
- Stored, append-only task history (`task_activity_events`) written by every task action; history table
  with filters, search, ordering and paging; `GET /api/tasks/:id/events`.
- Migration 002: old/new values, append-only trigger, backfill of past events.
- docs/MASTER_PROMPT_GAP_ANALYSIS.md, docs/PHASE1_REPORT.md.
### Security
- `GET /api/tasks/:id` now checks that the caller may see the task.
### Database: migration 002 (additive). Environment: none.

## [Phase 0] — audit + foundation
### Added
- Versioned migrations (`backend/migrations.js`, `schema_migrations`), migration 001 foundation tables:
  task_activity_events, notification_deliveries, automation_jobs, automation_job_runs,
  integration_events, ai_usage_events, file_objects; `tasks.source_type` / `tasks.source_ref`.
- PostgreSQL backup/restore scripts (`npm run backup`, `npm run restore`), tested round-trip.
- `/readiness` (real DB ping), `X-Request-Id` header, audit log paging/filters (`format=page`).
- Approvals: Open / Closed tabs with compact rows.
- Docs: PRODUCTION_AUDIT.md, IMPLEMENTATION_PLAN.md (with management decisions recorded), PHASE0_REPORT.md, MIGRATIONS.md.
### Fixed
- Server timezone → Asia/Kolkata (deadlines/reminders were 5.5 h late on UTC host).
- Unauthenticated 160 MB request bodies (memory exhaustion) → 1 MB unless logged in.
- Login sent several times per Enter press (duplicate audit entries + sessions); same bug in
  password reset/change, people picker, @mentions.
- Real client IP behind Cloudflare/Render (audit log + rate limiting).
### Removed
- Unused root `db.js`, SQLite-only demo scripts, `better-sqlite3` dependency.
### Database: migration 001 (additive). Environment: none required (new optional variables in `.env.example`).

## 2026-10-02 — Person filter, push notifications
- All Tasks person filter + summary; web push prompt; Android background notifications (v1.3 APK);
  VAPID keys set on Render (Oct 1). Starter accounts no longer re-created on restart.

## 2026-10-01 — Performance and reliability
- Response cache + `/api/sync` live sync, batched queries, request/query timeouts, IndexedDB instant
  start, Open/Closed task tabs, sidebar collapse, Export & Archive, Equinox schedule import.
