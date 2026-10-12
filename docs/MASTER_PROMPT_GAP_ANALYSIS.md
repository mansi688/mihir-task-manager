# Master Development Prompt (v3) — audit & gap analysis

October 2026. Answers the 16 required items of the "Master Development Prompt" against the actual
code. Detailed inventories: `docs/PRODUCTION_AUDIT.md`; Phase 0 results: `docs/PHASE0_REPORT.md`;
plan & decisions: `docs/IMPLEMENTATION_PLAN.md`.

## 1. Current architecture
Single Node 22 + Express service (API + static PWA + background timers) on Render free (Oregon);
PostgreSQL on Supabase free (Tokyo). **Frontend is plain JavaScript (no React/Vite)** — a single-page
PWA (`frontend/app.js`) with DOM morphing. Per the "do not migrate technologies" rule it stays.
Android: thin WebView wrapper APK (already built; no further native work planned).

## 2. Existing functionality
Tasks (create, levels, assign/reassign, deadlines + per-person deadlines, priority, project/phase,
checklist, attachments, subtasks, dependencies, comments/@mentions, follow-up people, submit →
approve/reject, close/cancel/reopen, archive), bulk Excel/CSV import with Task Keys, export with
timestamps, document approvals, drawings library, calendar, dashboards/leaderboards/HR/peak-hours
reports, person filter, audit log, in-app + web-push + Android notifications, WhatsApp outbound
reminders, AI deadline-risk wording.

## 3. Database schema
28 tables (see PRODUCTION_AUDIT §2). PKs on all; **no foreign keys**; RLS enabled on all tables
(app uses owner role); versioned migrations since Phase 0.

## 4. Task-history implementation
Not stored: rebuilt in the browser from scattered columns; many actions never appear; resubmissions
overwrite earlier rounds (PRODUCTION_AUDIT §4). → Phase 1 (this release).

## 5. Authentication / authorization
JWT (12 h) + token_version revocation, bcrypt, lockout (5 fails → 3 min), forced temporary-password
change, per-route role checks (admin / director / member / team lead), notifications-only device
tokens. **Gap found:** `GET /api/tasks/:id` returned any task to any logged-in user (fixed in Phase 1).

## 6. Deployment
GitHub → Render auto-deploy (`npm install`, `npm start`); no health-check path configured; no staging;
free server sleeps after 15 idle minutes.

## 7. Notifications / reminders
In-app table + web push + Android polling + optional WhatsApp/email. Rules already present: 24/12/6/2-h
before deadline, 3/5/7/12-day escalation, overdue, weekly admin digest. **Run by in-memory
`setInterval` timers** (lost while sleeping, not restart-safe, no delivery log, no anti-spam gap).

## 8. Bugs found (all fixed in Phase 0 unless noted)
Server timezone UTC (reminders 5.5 h late); login/password forms sent many times per Enter press;
expanded rows collapsed on refresh; deleted accounts re-created on restart; readiness check served
from cache; SQLite-only backup scripts; date-dependent tests.

## 9. Security issues found
Unauthenticated 160 MB bodies (fixed); proxy IP used for audit/rate limiting (fixed); old VAPID key
in Git history (rotated); readiness false-positive (fixed); task details readable by any user
(**fixed in Phase 1**); CORS open by default (configure `ALLOWED_ORIGINS`).

## 10. Already implemented from this specification
Reminder tiers 24/12/6/2 h and 3/5/7/12 d; IST timezone; one company WhatsApp number (outbound);
health endpoint + readiness; structured logs; request size limits; rate limiting; password hashing;
backup/restore scripts (tested); responsive UI; search/filter/sort; overdue/completed/my tasks;
source column on tasks; foundation tables for notifications/jobs/AI usage/files.

## 11. Missing
Persisted append-only task history with old/new values (Phase 1); 10:00/14:00/18:00 windows +
5-hour anti-spam + delivery log + restart-safe scheduling (reminder engine); always-on hosting;
common task-creation service + AI service layer; voice assistant; WhatsApp inbound; email → task
(mail host unknown); meeting recording → tasks (consent notice, 30-day retention); Supabase Storage
for files; foreign keys; staging.

## 12. Implementation order (this document's STEP 1–12, merged with earlier decisions)
1 Audit ✅ · 2 Fix bugs/security ✅ · 3 **Task history** (now) · 4 Core task management gaps
(edit title/priority with history, reopen rules, filters) · 5 Reminder engine (DB-backed, windows,
5-h gap, delivery log) · 6 Production reliability (always-on host, Supabase Storage, scheduled
backups, staging, FKs) · 7 Common task-creation service + AI service (Gemini Flash-Lite) ·
8 Voice assistant · 9 WhatsApp inbound · 10 Email → task · 11 Meeting recording → tasks ·
12 Full production test.

## 13. Files that will need modification
`backend/server.js` (routes, reminder engine), `backend/db.js`, `backend/migrations.js`, new
`backend/services/` (task-creation, notifications, ai, storage), `frontend/app.js`,
`frontend/styles.css`, `.env.example`, docs, tests.

## 14. Database migrations required
002 task history (old/new values, append-only guard, backfill) · 003 reminder engine (windows,
anti-spam keys on notification_deliveries) · 004 foreign keys (NOT VALID → VALIDATE) ·
005 ingestion items / AI suggestions · 006 meetings (sessions, transcripts, retention) — each only
when its phase starts.

## 15. Environment variables (new, by phase)
`REMINDER_WINDOWS`, `FOLLOW_UP_COOLDOWN_HOURS` (reminders) · `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `STORAGE_BUCKET` (files) · `AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL`,
`MONTHLY_AI_BUDGET_INR` (AI) · `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET` (inbound webhook) ·
mail-host settings (email → task) · `MEETING_RECORDING_RETENTION_DAYS` (default 30).

## 16. Estimated monthly cost (prices to be re-checked before purchase; ≈ ₹85–90 per US$)

| Item | Option | ≈ ₹/month |
|---|---|---|
| Always-on backend | Render Starter ($7) — no server admin needed | 600–650 |
|  | or small VPS (e.g. Hetzner/DigitalOcean, $4–6) + PM2 — cheaper, but we manage OS updates, firewall, HTTPS | 350–550 |
| Database | Supabase Free (now) | 0 |
|  | Supabase Pro ($25) — daily backups + PITR add-on extra | ≈ 2,150–2,250 |
| AI | Gemini Flash-Lite, text + voice notes at company scale | 50–300 |
| WhatsApp | inbound free; ~₹0.12–0.15 per business message beyond free allowance | 50–300 |
| **Total without Supabase Pro** | | **≈ 500–1,300** ✅ within budget |
| **Total with Supabase Pro** | | **≈ 2,700–3,500** ⚠ above ₹2,500 |

Recommendation: always-on Render Starter + Supabase Free + nightly off-site backup (free) keeps the
target; move to Supabase Pro when management accepts ≈ ₹2,700–3,500/month or when data/risk demands it.
