# MIHIR Task Manager — Production Audit

Updated October 2026 from the code in this repository and read-only checks of the live
Render service and Supabase database. Replaces the earlier audit (SQLite era).
Companion documents: `docs/PHASE0_REPORT.md` (what Phase 0 fixed), `docs/IMPLEMENTATION_PLAN.md`.

## 1. Architecture

```
Browser / installed web app / Android APK (WebView)
        │  HTTPS (Cloudflare → Render)
        ▼
Node 22 + Express — ONE process: API + static PWA + background timers   (Render free, Oregon)
        │  pg pool (max 10, 25 s statement timeout)
        ▼
PostgreSQL — Supabase free, ap-northeast-1 (Tokyo)          ~120 ms per query round trip
```
- Code size: backend ≈ 4,000 lines (`server.js`, `db.js`, `task-import.js`, `task-export.js`, `migrations.js`); frontend ≈ 5,000 lines (`app.js`, vanilla JS, morph-based re-render).
- Android app: thin WebView shell (`android/`), built with `android/build-apk.sh`.

## 2. Database (28 tables)

| Group | Tables |
|---|---|
| People & access | users, teams, sessions, push_subscriptions |
| Tasks | tasks, task_assignees, task_checklist_items, task_followups, task_replies, task_phases, projects |
| Approvals | approval_requests, approval_reviewers, approval_history |
| Documents | drawings, drawing_sections, import_files |
| Notifications & audit | notifications, audit_log |
| Reports | period_awards, period_tracking |
| Phase 0 foundation (empty) | schema_migrations, task_activity_events, notification_deliveries, automation_jobs, automation_job_runs, integration_events, ai_usage_events, file_objects |

Facts: 87 tasks, 26 users, 24 MB (≈10 MB of it attached files stored as base64 text). RLS enabled
on all tables (app connects as the owner role). **No foreign keys** — integrity is enforced in code;
0 orphan rows found. Timestamps: TEXT ISO-8601 in older tables, TIMESTAMPTZ in new ones.

## 3. APIs (107 routes)

| Area | Routes | Notes |
|---|---|---|
| Tasks | 34 | create, import/export, assign, submit/approve/reject, deadline, archive, checklist, follow-ups, subtasks |
| Reports | 14 | dashboards, leaderboards, performance, HR roster, peak hours (cached, version-invalidated) |
| Users / teams | 16 | accounts, departments, directory |
| Auth | 9 | login, password change/reset (email OTP), logout everywhere, `/me` |
| Approvals | 6 | document approvals |
| Push / device | 6 | web push subscribe, Android device token + polling |
| Other | 22 | drawings, projects, phases, notifications, schedules, sync, audit log, AI deadline check, health/readiness/version |

No API versioning yet (`/api/...`). Clients: the bundled frontend only.

## 4. Current task history (the thing Phase 1 replaces)

The task "history" is **not stored as history**. The browser rebuilds a timeline each time from
scattered columns: `tasks.created_at`, per-assignee `submitted_at` / `completed_at` / decisions,
`task_replies`, `closed_at` / `cancelled_at`. Consequences:
- deadline changes, people added/removed, level reshuffles, follow-ups, reassignments, imports and
  archive actions **never appear** in a task's history (some appear only in the admin audit log);
- old submission/approval timestamps are overwritten when work is resubmitted, so earlier rounds
  are lost;
- there is no actor/department/source per event, no filtering, no paging.

## 5. Integrations

| Integration | State | Notes |
|---|---|---|
| Web Push (VAPID) | Live (keys set Oct 1) | free; prompt per device |
| Android notifications | Polling every ~15 min (07–22 h) | device token, notifications-only scope |
| Email (SMTP) | Optional | password-reset codes only |
| WhatsApp (Meta Cloud API) | **Outbound only** | reminder messages; **no webhook / no inbound messages** |
| AI (Anthropic, `claude-haiku-4-5`) | One feature | deadline-risk wording; hard-coded provider; **no usage/cost logging** |
| Excel / CSV | Import, export, schedule timestamps | exceljs |
| Gmail, Google Meet, document/audio/video AI | None | future phases |

## 6. Background work

Five `setInterval` timers inside the web process: task reminders, escalations, deadline reminders,
weekly admin digest (hourly/daily), period awards (daily). Not persisted, not retried, run on every
instance, stop while the free server sleeps. → Phase 7 (job engine).

## 7. Deployment

GitHub → Render auto-deploy on push (`npm install`, `node backend/server.js`). No render.yaml, no
CI workflow, no staging environment. A second Render service `mihir-task-manager-1` exists from the
same repo (appears unused). Free plans everywhere: server sleeps after 15 idle minutes; Supabase
free has daily backups without point-in-time restore.

## 8. Risks and technical debt (prioritised)

| # | Risk | Impact | Phase |
|---|---|---|---|
| 1 | Backups: daily only (free), no automated off-site copy | Data-loss window up to 24 h; RPO ≤ 15 min **not achievable on the free plan** | 8 (paid decision) |
| 2 | Timers inside the web process; lost while sleeping; no retry | Missed/duplicate reminders | 2, 7 |
| 3 | Task history incomplete (section 4) | Weak auditability | 1 |
| 4 | Files inside PostgreSQL | DB fills (500 MB free limit); slow backups | 8 (storage) — before any media/AI work |
| 5 | No foreign keys | Integrity depends on code | 8 |
| 6 | Server (Oregon) far from DB (Tokyo) and users (India) | Latency | 8 |
| 7 | AI provider hard-coded, no cost tracking | Uncontrolled cost once AI grows | before 3 |
| 8 | Large files: `server.js` ~2,600 lines, `app.js` ~5,000 lines | Change risk | refactor only where a phase touches code |
| 9 | No staging environment | Changes go straight to production | 8 (can start now) |
| 10 | CORS open by default | Low (bearer tokens) | set `ALLOWED_ORIGINS` |
