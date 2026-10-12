# Phase 0 report — production audit + foundation

Status: **COMPLETE** (October 2026). All quality gates below pass. Phase 1 has NOT been started.

## Technical assessment (summary)

| Area | Finding |
|---|---|
| Architecture | Single Node/Express service (`backend/server.js`) serving API + static PWA (`frontend/`). Render free plan (Oregon, 0.15 CPU / 512 MB). |
| Database | **PostgreSQL only** (Supabase, Tokyo). `pg` pool (max 10, 25 s statement timeout). SQLite is gone from the app; leftover SQLite scripts/docs/dependency removed or corrected. 21 tables, RLS enabled on all; **no foreign keys** (integrity enforced in code — verified: 0 orphans in production). 87 tasks, 26 users, 24 MB. |
| Schema changes | Previously: idempotent `IF NOT EXISTS` statements on every start, no version record. Now: versioned migrations (see docs/MIGRATIONS.md). |
| Files | Attachments stored as base64 text in PostgreSQL (~10 MB of 24 MB). Foundation table `file_objects` created; migration to object storage planned (not done blindly). |
| Timestamps | Existing tables: TEXT ISO-8601 (UTC instants) — kept. New tables: TIMESTAMPTZ. Deadlines: wall-clock text in business time. |
| Timezone | **Bug:** server ran in UTC, so deadlines/reminders/week & month boundaries were 5.5 h late. Fixed: `APP_TIMEZONE` (default Asia/Kolkata) applied process-wide at start. |
| Auth | JWT (12 h) with token_version revocation, bcrypt, per-account lockout (5 fails → 3 min), forced temp-password change. Device tokens (notifications-only) for the APK. |
| Authorization | Role checks per route (admin / director / member / team lead); covered by existing tests. |
| Jobs | Hourly `setInterval` jobs inside the web process (reminders, escalations, awards). To be replaced in Phase 7. |
| Notifications | In-app + web push (VAPID) + Android polling + optional WhatsApp; to be centralised in Phase 2. |
| Logging | Structured JSON lines with request id; no bodies/passwords logged. Now also `X-Request-Id` response header. |
| Tests | 280 automated tests, all passing. |

## Quality gates

| Gate | Result |
|---|---|
| Database architecture understood; PostgreSQL/Supabase confirmed | ✅ |
| Migrations safe (versioned, transactional, advisory-locked, idempotent) | ✅ re-run tested |
| Critical indexes exist | ✅ (+ audit_log indexes; foundation tables indexed) |
| Timezone standardised | ✅ Asia/Kolkata, tested |
| Environment variables documented | ✅ `.env.example` lists every variable the code reads |
| Critical security issues fixed | ✅ see below |
| Health checks work | ✅ `/health` (liveness), `/ready` + `/readiness` (real DB ping, 5 s cap, schema version) |
| Structured logging works | ✅ |
| Existing functionality still works | ✅ 280/280 tests, browser checks desktop + phone |
| Production build passes | ✅ syntax check of all JS; production-mode start; migration 001 applied in 28 ms |

## 1–20 (required report)

1. **Phase completed:** Phase 0 (plus two user requests: approval Open/Closed tabs; audit-log duplicate-login fix).
2. **Files created:** `backend/migrations.js`, `docs/MIGRATIONS.md`, `docs/PHASE0_REPORT.md`, `test/phase0-foundation.test.js`; `scripts/backup-database.js` and `scripts/restore-database.js` rewritten for PostgreSQL.
3. **Files modified:** `backend/server.js`, `backend/db.js`, `frontend/app.js`, `frontend/styles.css`, `testlib/helpers.js`, `test/individual-deadline-tiers.test.js`, `test/individual-deadlines.test.js`, `.env.example`, `README.md`, `package.json`/lock, `docs/DISASTER_RECOVERY.md`, `docs/GUIDE.md` (superseded note), `docs/PRODUCTION_CHECKLIST.md` (removed a committed key).
4. **Files deleted / moved:** root `db.js` (unused duplicate — verified nothing loads it); `scripts/seed-demo-data.js`, `scripts/remove-demo-data.js` (SQLite-only, could not run); `test/manual-load-test.js` → `scripts/load-benchmark.js` (a manual tool that the test runner kept executing).
5. **Database changes:** migration 001 — tables `schema_migrations`, `task_activity_events`, `notification_deliveries`, `automation_jobs`, `automation_job_runs`, `integration_events`, `ai_usage_events`, `file_objects`; columns `tasks.source_type` (default `web`, back-filled `import` for imported tasks) and `tasks.source_ref`; indexes on `audit_log(created_at)`, `(actor_username, created_at)`, `(action)`. All additive.
6. **API changes:** `/readiness` added (alias of `/ready`, now a real DB ping). `/api/audit-log` accepts `format=page`, `limit`, `before_id`, `actor`, `action`, `q`, `from`, `to`; **without `format=page` it returns the same list as before** (backward compatible). Request bodies > 1 MB require a valid login (413 otherwise).
7. **Frontend changes:** approvals Open / Closed tabs with compact rows (collapse after deciding); new Audit Log page (filters, search, paging, device column); fixed handlers that stacked on every redraw (login, password reset/change, people picker, @mentions) + double-submit guard on login.
8. **Environment variables:** new `APP_TIMEZONE`, `DB_POOL_MAX`, `DB_STATEMENT_TIMEOUT_MS`, `TRUST_FORWARDED_FOR`, `VAPID_SUBJECT`; all documented in `.env.example`. No production change required (defaults are correct).
9. **Tests added:** phase0-foundation (migrations + re-run, health/readiness/request id, body limits incl. forged token, timezone, audit: one login per press, real IP, paging, filters, admin-only, legacy format; task source). Test helpers now build dates in business time.
10. **Tests executed:** full suite (`npm test`), browser checks (login duplicate count, approvals flow, audit page), backup → restore round-trip, production-mode start.
11. **Results:** 280 passed, 0 failed. Backup/restore: all tables OK; restore refuses non-empty targets; restored DB logs in and creates tasks.
12. **Security issues found:** (a) unauthenticated 160 MB request bodies — memory exhaustion of the 512 MB server (**critical**); (b) client IP = proxy IP → wrong audit IPs and one shared rate-limit bucket for the whole office; (c) login sent 5–12× per Enter press → duplicate sessions/audit; (d) readiness check served from cache; (e) old VAPID private key committed to Git (Sept 8); (f) CORS allows any origin by default.
13. **Security issues fixed:** (a)–(d) fixed; (e) key already rotated on Oct 1 (inactive), removed from current docs — still in Git history, harmless now; (f) documented — set `ALLOWED_ORIGINS` in Render (low risk: bearer tokens, not cookies).
14. **Performance impact:** neutral to positive — 1 MB default body parser, audit queries indexed and paged (no more fixed 200-row load), user lookups cached.
15. **Deployment changes:** none required. On first start the server applies migration 001 automatically (≈30 ms). `better-sqlite3` removed → faster, safer Render builds.
16. **Rollback procedure:** Render → Events → previous deploy → Rollback. Migration 001 is additive; the older code ignores the new tables/columns. Take `npm run backup` before deploying (docs/DISASTER_RECOVERY.md).
17. **Remaining risks:** no foreign keys; files inside PostgreSQL; free plans (server sleeps; no point-in-time restore); background jobs inside the web process (Phase 7); no automated off-site backup yet (Phase 8); server/database in different regions (latency).
18. **Paid services required:** none for Phase 0.
19. **Cost estimate:** ₹0. (Phase 8 will evaluate Supabase Pro ≈ $25/month for point-in-time recovery and Render Starter ≈ $7/month.)
20. **Next phase prerequisites:** deploy this build; confirm `/readiness` shows `schemaVersion 001` in production; take and test-restore one production backup; then Phase 1 (task history table) can start — it will populate `task_activity_events`.
