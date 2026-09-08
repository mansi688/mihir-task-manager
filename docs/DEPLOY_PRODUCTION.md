# DEPLOY_PRODUCTION.md

This doesn't duplicate `DEPLOY.md` (the plain-language walkthrough) or `PRODUCTION_CHECKLIST.md`
(the exact reviewer-mapped checklist) — it's the condensed, ordered version for someone who
already knows the basics and just needs the sequence.

1. **Provision a server** with at least 2 vCPUs (see `PRODUCTION_AUDIT.md` P1-1 for why 1 core
   specifically causes measurable login slowdown under concurrent load) and persistent disk
   storage (never a purely ephemeral free tier — confirmed directly that some providers wipe
   data on every restart with no free persistent-disk option at all).
2. **Install Node 18+.**
3. **Get the code onto the server** (git clone from your private repo, or copy the files).
4. `npm install` — verify `npm audit` reports 0 vulnerabilities before proceeding.
5. **Generate a real JWT_SECRET** (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`)
   and set it in `.env`. Never reuse one from testing/staging.
6. **Configure optional integrations** as needed: SMTP (password recovery), VAPID (push —
   requires real HTTPS to actually work), WhatsApp (requires a real Meta Business account and
   has a real 24-hour-window template rule — see `.env.example` for details on each).
7. `npm start` — the Admin account and legacy placeholder accounts auto-create with mandatory
   first-login password changes.
8. **Import your real employee roster**: `node scripts/import-real-employees.js` (reads
   `employees-data.json`; safe to re-run, never overwrites someone's already-changed password).
9. **Put HTTPS in front of this** (a reverse proxy — nginx or Caddy with Let's Encrypt is the
   standard approach) — required for push notifications to work at all, and good practice
   regardless.
10. **Run a process manager** (pm2 or systemd) so the app restarts automatically if it crashes or
    the server reboots, and so `SIGTERM` reaches the app cleanly (this app now handles graceful
    shutdown correctly — verified this session).
11. **Set up `backup-database.js` on a schedule** (cron), and copy backups off-server
    periodically (see the gap noted in `DISASTER_RECOVERY.md`).
12. **Point your load balancer/monitoring at `/health` and `/ready`** if you have either.
13. **Smoke test**: log in as Admin, create a real task, confirm a notification arrives, confirm
    `npm test` still passes 197/197 on this exact server before calling it done.

## Rollback
See `DISASTER_RECOVERY.md` — the short version: revert the code via git, restart; only restore
the database from backup if data was actually corrupted, not just a code bug.
