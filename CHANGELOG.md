# Changelog

All production changes, newest first. Each release lists database changes, environment changes and
rollback notes. Deploy = push to GitHub `main` → Render auto-deploys. Rollback = Render → Events →
previous deploy → Rollback (all migrations are additive).

## [Unreleased] — Search a place on the maps
### Added
- Search box above every location map (Live, History, Places, My Location): saved places first, then
  addresses via `GET /api/location/geocode`; typed coordinates (decimal or degrees-minutes-seconds) and
  pasted Google Maps links are read directly. Pick a result → map centres + orange pin; on Places,
  "Add as a place" or move the place being edited.
- New env (optional): `GEOCODER` (default `nominatim`), `GEOCODER_KEY`, `GEOCODER_EMAIL`, `GEOCODER_COUNTRY` (default `in`).
### Fixed
- Switching between Locations tabs (e.g. Live map → Places) could leave the second map blank, because
  the page redraw reused the map's container. The map is now recreated when that happens.
### Database / rollback
- No database changes. Rollback = previous deploy.

## [Unreleased] — Employee location & movement tracking (off by default)
### Added
- Work-session location tracking behind `ENABLE_LOCATION_TRACKING` (default **off** — deploying changes
  nothing until it is set). Employees accept a versioned notice, then start/stop sessions themselves;
  status is always visible (Android notification, iOS blue indicator, web "Tracking on" pill).
- Locations page: live map, route history + replay, places/geofences (office, site, warehouse, supplier,
  client) with arrival/departure/visit time, reports + CSV, configurable alerts, indoor floors/zones/beacons,
  privacy & policy screen. My Location page: consent, start/stop, own day, who viewed me, export, withdraw.
- Task/project integration: places linked to projects and tasks; confirmed visits auto-link to the
  assignees' open tasks and appear in task history (procurement pickups, deliveries, site visits).
- Indoor: BLE beacon positioning (room/zone level) and a UWB/RTLS vendor connector (desk level, needs hardware).
- Android app 1.5: foreground location service, SQLite offline queue, adaptive battery intervals, BLE scan,
  Stop button in the notification. iOS app source (not compiled — needs a Mac).
- Role-scoped access (Admin all; Directors own + granted departments; team leads own department, each
  switchable), access log of every view, retention purge job, per-person export and deletion.
- docs/LOCATION_TRACKING.md, LOCATION_MOBILE.md, LOCATION_INDOOR.md.
### Fixed
- `scripts/restore-database.js` restores chat and location tables in foreign-key order; command-line
  scripts no longer hang after finishing (pool `allowExitOnIdle`).
### Database: migration 007 — new tables only. Environment: `ENABLE_LOCATION_TRACKING` (off),
`MAP_TILE_URL`, `MAP_TILE_ATTRIBUTION` (optional). Rollback: set the flag to false.

## [2026-10-12] — Chat Room open to all departments + department tagging
### Restored
- The Communicate menu group (Chat Room + Announcements), chat files, task multi-attachments, announcements
  calendar entries and the approvals history view from the Oct 10 build (a7de138). They were dropped when a
  later push replaced that history; this release merges both lines back together.
### Changed
- Chat Room: every employee now sees and can post in General and every department room (their own is marked
  "your dept"). Tags: @person, @[Department] (whole department) and @everyone (Admin/Directors only).
  Tag notifications open the room they came from. docs/CHAT.md.
- 🔒 Private chats: only the starter and the people tagged/added can see them — not their department,
  not Admin. Tagging @person in a private chat adds them.
### Fixed
- Slow login and slow screens: database connections were closed after 30s idle, and re-opening them
  (server in Oregon, database in Tokyo) cost ~1.5–2s on the next load. They now stay open 10 minutes
  with TCP keep-alive, and 4 are kept warm. Optional env: DB_IDLE_TIMEOUT_MS, DB_POOL_WARM.
- "column m.mentions does not exist" errors on every load (chat code didn't match the database).
### Database: migration 006 (chat_private, chat_private_members — new tables, additive). The rest uses the
existing chat tables; migration 005 only adds notifications.chat_room (already applied in production). Environment: none.

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
