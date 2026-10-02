# MIHIR Task Manager

A self-hosted task management system built for Mihir Group — task lifecycle, staged
multi-person assignments, approvals, subtasks, escalating reminders, push/WhatsApp/email
notifications, department and HR reporting, and audit logging.

## Project structure

```
backend/    Express server and the SQLite data layer (server.js, db.js)
frontend/   The vanilla-JS web app served to the browser (index.html, app.js, styles.css, PWA files)
scripts/    Command-line tools — backups, real employee import, password resets, demo data
data/       employees-data.json (real company data — see "Real employee data" below)
test/       Automated tests (run with `npm test`)
testlib/    Shared test-server helper used by every test file
e2e/        Playwright browser tests (run with `npm run e2e`)
docs/       All deployment, security, and production-readiness documentation
```

## Quick start

```
npm install
cp .env.example .env
```

Generate a real secret and paste it into `.env` as `JWT_SECRET=...`:
```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Then:
```
npm start
```

Open **http://localhost:4000**. Log in as `admin` / `admin123` — you'll be asked to set a real
password immediately.

Or, on Mac/Linux, just run `./start.sh` — it does all of the above in one step.

## Full documentation

See `docs/DEPLOY.md` for a complete, beginner-friendly walkthrough (GitHub → a real server →
first login), or `docs/DEPLOY_PRODUCTION.md` / `docs/PRODUCTION_CHECKLIST.md` for the condensed,
production-focused version. `docs/PRODUCTION_AUDIT.md` and `docs/SECURITY_AUDIT.md` document
exactly what's been verified and what genuinely still needs real infrastructure to complete.

## Bulk task import (CSV / Excel)

**My Tasks → Import from CSV / Excel.** Upload a `.csv` or `.xlsx` with one task per row; you get
a preview of every row (who was tagged, what was understood, what's wrong) before anything is
created, then one click creates all valid rows together. Download the Excel template from the same
panel — it includes a "How to fill" sheet and a "People" sheet listing everyone's exact username.

Recognised columns (header spelling is flexible — "Due Date", "Assigned To", "Sr No" etc. all work):
Title*, Deadline* (DD/MM/YYYY, day first), Assignees (optional — usernames, names, emails, or a
department name), Task Key, Description, Priority, Deadline Time, Level 2 / Level 3…, Auto Release, Follow Up, Project,
Phase, Checklist (items separated by `|`), Depends On, Parent Task, Individual Deadlines.
Code: `backend/task-import.js`; tests: `test/bulk-task-import.test.js`.

### Re-uploading a schedule (Task Key) and changing deadlines

- A **Task Key** column gives each row a permanent ID. Uploading the file again later creates only
  the rows not imported yet and changes the deadline of rows whose date changed *in the file* — no
  duplicates. A deadline changed inside the app is never undone by re-uploading an unchanged row.
  Closed tasks are never touched. Everyone affected is notified; every change is in the audit log.
- **Change deadline** on any open task (creator or Admin) — `POST /api/tasks/:id/deadline`.
- **Tagging people is optional** — tasks (form or import) can be created untagged and people added
  later with "+ Tag People". Filter "Not tagged yet" on My Tasks / All Tasks finds them.
- Columns whose heading starts with `Info:` are reference-only and ignored by the importer.
- Up to 5,000 rows per file. Large imports use bulk inserts; task lists are batch-loaded, gzip
  compressed and paged in the UI (tested with a 3,808-row schedule: import ~1.3s, lists ~0.3s).

## Export & Archive (Admin → Export & Archive)

- **Saved schedules** — every imported file is kept. *Download with timestamps* returns that same
  spreadsheet with green `Info:` columns filled per row (matched on Task Key): Status, Task ID, Tagged,
  Started, Submitted, Approved, Completed At, Closed By, Done By, Days Taken, Result (on time / N days
  late), Updated. Formulas, dropdowns and filters are kept; the file can be uploaded again as-is.
- **Import column** — rows with `Import = No` are skipped. The Equinox file sets it by formula from a
  cutoff date on its Settings sheet; move the date and re-upload to bring in the next batch.
- **History export** — any period (from the start to today, last month, …): one row per task with
  every timestamp (local time, `APP_TIMEZONE`, default Asia/Kolkata), per-person timeline and comments.
- **Remove finished tasks from the site** — closed/cancelled tasks finished on or before a date leave
  every task screen; attachments, comments, checklists and notifications are deleted. A summary row
  stays, so exports, schedule timestamps, performance, leaderboards and reports are unchanged and
  re-imports never re-create them. In the first week of each month Admin gets a reminder on Today.

## Android app (APK)

`android/` is a small native app that opens the live site, so data and behaviour are identical to
the website and every site update reaches the app without reinstalling. It adds file upload,
downloads (saved to *Downloads/MIHIR Tasks*), the Back button, and opens WhatsApp/phone/email links
in their apps. Build: `./android/build-apk.sh` (defaults to https://mihir-task-manager.onrender.com; bump
`VERSION_CODE` for each update — see the script for the apt packages). Keep `android/mihir-tasks.keystore` safe — updates must be signed with the same key.
Web push notifications don't exist inside Android WebViews; the in-app bell and WhatsApp reminders work.

## Speed on Render free + Supabase (server in Oregon, database in Tokyo)

Every database query crosses the Pacific (~120ms), so the app is built to make few of them:
- **Response cache** (`cacheResponse` in server.js): read endpoints answer from memory until any
  write changes the data version; identical concurrent requests share one computation. A refresh
  with no changes costs 0 queries. Per user — nobody receives someone else's data.
- **Live sync**: clients poll `GET /api/sync` (~4ms, no database) every 5s while visible and reload
  only when the version moved — website and phone app show each other's changes within seconds.
- Reports load only on the page that shows them; core data appears as it arrives; the last data
  is kept on the device (IndexedDB) so a reload shows tasks instantly. Requests time out at 90s,
  queries at 25s (`DB_STATEMENT_TIMEOUT_MS`).
- Per-person/per-task query loops replaced by single queries (leaderboards, ratings, dashboards,
  hourly reminder jobs). Benchmark: `DB_SIMULATED_LATENCY_MS=120 EXPOSE_QUERY_COUNT=1`.
- Biggest remaining win: run the server in the same region as the database (e.g. Render Singapore).

## Push notifications (free, instant) — website / installed web app

Web Push via the browser's own free push service, signed with VAPID keys (`VAPID_PUBLIC_KEY`,
`VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` env vars — generate with `npx web-push generate-vapid-keys`;
changing them makes every device re-subscribe automatically). Users get a one-time
"Turn on notifications for this device" prompt. Works in Chrome on Android (also when installed via
"Install app"), desktop Chrome/Edge/Firefox, and iPhone/iPad after "Add to Home Screen" (iOS 16.4+).
Every in-app notification is also pushed (urgency high, kept 24h if the phone is offline); logging
out removes that device. Test: `test/web-push-delivery.test.js` decrypts a real pushed message.

## Phone notifications inside the APK

The app registers a notifications-only **device token** (`POST /api/device/register`, valid 180
days, revoked by password change/reset or "Log out everywhere") and a background job checks
`GET /api/device/notifications` about every 15 minutes between 07:00 and 22:00 — free, no Firebase.
Android decides the exact timing to save battery; while the app is open the in-app bell is live.

## Removing an account

Accounts → Remove now deletes the account **and everything tied to it** (tasks they created,
tasks where they were the only person tagged, their tags/replies/follow-ups/notifications/
sessions, approval requests they sent). Shared tasks are repaired automatically — levels are
renumbered, the next level released, or the task closed if everyone left is already approved.
Admin sees the full impact before confirming, and chooses separately whether to delete drawings
they uploaded. The audit log is kept. Tests: `test/account-deletion-cascade.test.js`.

## Real employee data

`data/employees-data.json` contains real names and emails and is excluded from git entirely
(`.gitignore`) — it should never be committed to any repository. Run
`node scripts/import-real-employees.js` once to load it into the database, then delete the file
from the server; the accounts it created remain unaffected.

## If `npm install` fails on `better-sqlite3` or `bcrypt`

This almost always means Node.js itself isn't an LTS version — very new (or very old) Node
releases don't have a ready-made binary for these native packages yet, so npm tries to compile
from source and fails without Python/build tools installed. Fix: install the **LTS** version of
Node.js from nodejs.org (not "Current"), then delete `node_modules` and `package-lock.json` and
run `npm install` again.

## Notes

- Uses SQLite (`taskmanager.db`, created automatically at the project root on first run) — no
  separate database server needed. See `docs/DATABASE_MIGRATION.md` for when (if ever) that
  would need to change.
- To reset all data, stop the server and delete `taskmanager.db`, `taskmanager.db-wal`, and
  `taskmanager.db-shm` from the project root, then start it again.
- Run `npm test` any time to confirm everything still works — every change to this project runs
  through the same test suite before being considered done.
