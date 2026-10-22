# Changelog

All production changes, newest first. Each release lists database changes, environment changes and
rollback notes. Deploy = push to GitHub `main` → Render auto-deploys. Rollback = Render → Events →
previous deploy → Rollback (all migrations are additive).

## [Unreleased] — Keep open reaches everyone on the task; more colourful app
### Changed
- **Keep open** on a closure request now notifies everyone on the task — every assignee at every level and
  everyone kept informed — not only the person who asked: "<name> asked to close <task>, but <creator> kept it
  open: <note>". (Shows under Approvals in Notifications.)
- The task itself shows it, for everyone on it: a **🔓 Kept open** label on the task row in My Tasks, and inside
  the task an amber box "Closure request declined — this task stays open" with who asked, their reason, who kept
  it open and their note. It disappears once someone asks again or the task closes.
  Task lists (`/api/tasks/mine`, all tasks, single task) include `closureKeptOpen`. No database changes.
- **Professional colour palette** (light and dark), built on the brand colours — navy, blue, teal, with amber as
  the one accent: menu icons coloured by menu section with an amber marker on the active page; a thin
  navy-to-amber rule under the page header; small amber markers on section titles; brand-blue primary buttons;
  task rows carry a quiet stripe in their priority colour (red high, amber medium, green low) with soft priority
  badges; tinted summary boxes (red only when something needs attention); navy-to-blue active filter chip.
  CSS only, plus a `data-priority` attribute on task rows.

## [Unreleased] — Task Closure: "Kept open" section
### Added
- Task Closure page: a **Kept open** section, below "Requests waiting for your decision", listing every request
  you answered with **Keep open** — the task, who asked and why, when you kept it open and your note, whether the
  task is still open or was closed later, and an **Open task ›** button that opens the task on My Tasks. After you
  tap Keep open, the request moves there, is highlighted for a few seconds and scrolled into view. Admin's "All
  tasks" view shows every kept-open request. `GET /api/closure-requests` now also returns `keptOpen`.
  No database changes.

## [Unreleased] — Notifications: counts match the badge; "moved to Seen" with Undo
### Fixed
- The New count on the Notifications page now matches the menu badge. The page used to load only the latest
  100 notifications, so with 338 unseen it showed "New 72" and older unseen ones never appeared. It now loads
  every unseen notification (up to 500; a note appears beyond that) plus the 100 most recently seen.
- Ticking a notification no longer seems to make it vanish: a green bar says it moved to the **Seen** tab, with
  **View in Seen** and **Undo** (10 seconds). The Seen tab lists the most recently seen first, grouped by the
  day you saw it ("Seen Today"), so whatever you just ticked is always at the top.
### Added
- `POST /api/notifications/unread {ids}` — puts notifications back under New (used by Undo). No database changes.

## [Unreleased] — Reminder times 9 AM / 3 PM / 6 PM; Follow up for everyone
### Changed
- **All automatic reminders and warnings now go out only at 9:00 AM, 3:00 PM and 6:00 PM (IST)**: the daily
  "still open" nudge, 3-hourly nudges, due in X hours, due today, the 3-day countdown, overdue, the 48-hour
  "not completed" warning and the 60-hour flag. Anything that becomes due between slots waits for the next slot.
  A slot is still honoured up to 2 hours late if the server was asleep at that minute (Render free plan).
  The Monday weekly warning summary stays at 9:00 AM. Admin's "send reminders now" still sends immediately.
- Routine-nudge spacing lowered from 3 h to 2 h so the 3 PM → 6 PM slots are not skipped.
- **Follow up** (📣) is now available to everyone involved in a task — creator, any assignee at any level, anyone
  kept informed — plus Admin/Director. It notifies everyone else involved: people whose part is open get "your
  part is still open", everyone else gets "<name> asked everyone on <task> to look into it". Each person still
  gets at most one follow-up per task every 5 hours, whoever presses it. Recorded in the task history.
### Environment
- New default `REMINDER_WINDOWS=09:00,15:00,18:00`. If Render has `REMINDER_WINDOWS` set (old value
  10:00,14:00,18:00), delete it or change it to `09:00,15:00,18:00`. `REMINDER_WINDOWS=none` = send any time.
- `AUTO_REMINDER_MIN_GAP_HOURS` default 3 → 2. No database changes.
### Accounts (live database, not code)
- 21 Equinox, Bavdhan employees from the All Employees sheet added with their designations and temporary
  passwords (first name + 4 digits, must change on first login). New team: Quality Department. Audit log #1841.

## [Unreleased] — Notifications: category tabs and clearer cards
### Added
- Category tabs on the Notifications page, each with its count: **All**, **Reminders** (alerts to complete a task —
  still-open nudges, due in X hours, due today, 3-day countdown), **Warnings** (overdue tasks; people who have not
  completed their part — 48-hour warnings, 60-hour flags, weekly summary), **Task updates**, **Approvals** (approvals
  and closure requests), **Messages** (chat mentions, announcements), **Location** and **Other**. Tabs with nothing
  in them stay hidden, except Reminders and Warnings. New/Seen still applies inside every tab.
- Warnings tab: a "People who have not completed their part" panel listing each person with their number of
  incomplete tasks, marked "flagged" after 60 hours.
- Big red/amber tiles at the top for new warnings and reminders; "Mark these N as seen" marks only the open tab.
### Changed
- Cards are colour-coded by category (red warnings, amber reminders, blue tasks, violet approvals, teal messages,
  green location), with plain titles ("Due soon", "Overdue", "Person flagged") and "20 min ago" times. Fourteen
  notification types that used to show as just "Alert" now have proper names and icons.
### Fixed
- The page redraw could drop an untagged element (such as a day heading) when it lined up with a card that has an id
  (seen as the missing "Today" heading after switching tab). Front-end only; no database or environment changes.

## [Unreleased] — Notifications: New and Seen tabs
### Changed
- The Notifications page has two tabs: **New** (opens first; only notifications not yet seen) and **Seen**. The "All"
  tab is gone. Tapping the round Seen button slides the notification out of New; it then appears only under Seen,
  with the date and time it was seen. "Mark all as seen" empties New. Front-end only.

## [Unreleased] — Task Closure page (closure requests)
### Added
- **Task Closure** page (Tasks → Task Closure, with a count of requests waiting for you). People tagged on a task can
  ask its creator to close it, with a reason — from inside the task (🔒 Ask to close) or from the page.
- The creator (or Admin, who can switch to all tasks) closes it (✓ Close task, optional note) or keeps it open with
  a reason (Keep open). The usual close rules still apply (no open subtasks, not blocked by another task).
- The requester can withdraw a waiting request. Everyone involved is notified; requests, declines and withdrawals
  appear in the task's history and the Audit Log. Closing a task any other way answers its waiting requests.
- API: `POST /api/tasks/:id/closure-requests`, `GET /api/closure-requests[?scope=all]`,
  `POST /api/closure-requests/:id/approve|decline|cancel`.
### Fixed
- An open task could close by itself after an action showed a message at the top of the page (e.g. "Request sent"),
  because the message shifted the page layout. The message now has a fixed place.
### Database / rollback
- Adds table `task_closure_requests` automatically at start-up. Additive.

## [Unreleased] — A task is never created twice by a double tap
### Fixed
- Tapping **Create Task** twice (or again while a slow server was still answering) could create the same task twice —
  10 such pairs were found in production, 8 of them under 3 seconds apart.
  - The button now locks and shows "Creating…" until the server answers (also Add Subtask and Send for Approval).
  - Every New Task / subtask form sends a one-time `clientRequestId`; the server never creates a second task for the
    same id (also when two requests arrive at the same moment, or a retry follows a lost answer).
  - Pages still open from before this update (no id) are protected too: same person, title, deadline and people
    within 15 seconds returns the task already created.
### Database / rollback
- Adds column `tasks.client_request_id` (TEXT, nullable) and an index, automatically at start-up. Additive.

## [Unreleased] — Round "Seen" button on notifications
### Changed
- Each notification has a round button on the right. Tap it to mark that notification as seen: it turns into a green
  ✓ and the notification shows "✓ Seen <date>, <time>". Just looking at the page no longer marks anything seen.
- Opening a notification (tapping it to go to the task, chat or page it is about) also marks it seen.
  "Mark all as seen" still marks everything at once.
### Database / rollback
- No database changes. Front-end only.

## [Unreleased] — Notifications page, Approvals page, ✓ seen marks
### Changed
- **Notifications** is now its own page in the menu (Overview → Notifications, with the unread count) instead of
  the bell panel. Items are grouped by day; filters All / New / Seen; "Mark all as seen". On a phone the menu
  button shows the unread count.
- A notification gets a green **✓ Seen <time>** once it has been on screen for about a second (or is tapped).
  Opening the page no longer marks everything read at once — only what you actually saw.
- **Approvals** is its own page (Tasks → Approvals, with a count): task parts waiting for your approval
  (Approve / Reject / Open task), levels ready to release, your own parts waiting, and document approvals
  (Send for Approval + requests, moved from My Tasks). Admin can switch between tasks they created and all tasks.
- My Tasks keeps all tasks; it shows a short "N items waiting for your approval → Open Approvals" note instead
  of the document approval cards. Approving inside a task still works as before.
### Added
- `POST /api/notifications/read {ids}` marks several notifications seen; `notifications.read_at` stores when.
### Database / rollback
- Adds column `notifications.read_at` (TEXT, nullable) automatically at start-up. Additive; rollback = previous deploy.

## [Unreleased] — Expanded tasks close when you're done with them
### Changed
- An expanded (opened) task card now closes when you go to another page (menu, back button or a
  notification), so coming back shows the list collapsed; the new page starts at the top.
- An expanded task card that is scrolled completely out of view for over half a second closes by itself —
  except while you are typing in it or it has unsent text. The screen does not jump when a card above closes.
- Cards that stay on screen still stay open through the automatic refreshes.
### Database / rollback
- Front-end only. Rollback = previous deploy.

## [Unreleased] — Map search: robust (fallback services, projects, short links)
### Changed
- Street search is now a chain of services: Google Places (if `GOOGLE_MAPS_API_KEY`) → MapTiler (if `MAPTILER_KEY`)
  → Photon (free, search-as-you-type) → Nominatim (backup). A busy or failing service is rested and the next
  one answers, so "The map search service is busy" no longer stops the search. Old `GEOCODER=nominatim` still works.
- Saved places are matched on the server by name, project and address (any word order) on every map.
- Nothing found → retried with simpler words. A company project with no place yet gets a hint.
- Short Google links (`maps.app.goo.gl`, as shared on WhatsApp) are opened and read.
- Typing: saved places appear at once; street results follow; arrow keys move through results.
- Admin: Privacy & policy → Map search card with "Test map search" (`GET /api/location/geocode/test`).
### Database / rollback
- No database changes. New optional env: `GOOGLE_MAPS_API_KEY`, `MAPTILER_KEY`. Rollback = previous deploy.

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
