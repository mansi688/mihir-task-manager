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
