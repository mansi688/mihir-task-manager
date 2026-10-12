# MIHIR Task Manager — Implementation Plan (Phases 0–8)

Basis: the two roadmap documents ("Master Production Hardening Prompt" and "Phases 3–8 /
integrations") and `docs/PRODUCTION_AUDIT.md`. Principle carried through every phase:
**do not add AI faster than reliability, security, auditability and control.**

## Order of work

The two documents number phases differently. This plan keeps both numberings but fixes one
execution order:

```
STAGE A — foundation (no integrations, no new AI)
  Phase 0   Audit + foundation ........................ DONE (docs/PHASE0_REPORT.md)
  Phase 1   Task history / activity table
  Phase 2   Central notifications + deadline engine + Follow-Up redesign
  Phase 7A  Central job / worker engine (replaces the 5 setInterval timers)
  Phase 8   Production hardening: backups, object storage, staging, security, monitoring, cost

STAGE B — integrations (each behind a feature flag, default OFF)
  Phase 5-core  Universal ingestion engine + AI provider layer + review screen + AI cost control
  Phase 3   Gmail add-on            (an ingestion provider)
  Phase 4   WhatsApp Cloud API      (text first, then documents/images, then audio/video)
  Phase 6   Meeting Workspace       (Google Meet artifacts first)
  Phase 7B  Advanced automation workflows (escalation, vendor/meeting/Gmail follow-ups)
```

Why Phase 5-core comes before Gmail/WhatsApp: the roadmap requires that "Gmail-specific logic must
not spread through the task engine" and that everything enters through `/api/ingestion`. Building
the common pipeline (canonical object → extraction → AI interpretation → draft → human review →
task) first means Gmail and WhatsApp become thin adapters instead of two separate implementations.

Why Phase 8 storage comes before any media: WhatsApp media, recordings and documents must go to
object storage (Supabase Storage), never into PostgreSQL — which already holds ~10 MB of files.

## Phase-by-phase

### Phase 1 — Task history (Stage A)
- Write a `task_activity_events` row for **every** state change (created, assigned/reassigned,
  person added/removed, level change, comment, submitted, approved, rejected, completed, reopened,
  cancelled, deadline changed, follow-up, attachment, imported, archived), with actor, department,
  source and details. One helper used by every route — no scattered inserts.
- **Backfill** existing history (created / submitted / approved / closed / cancelled / comments)
  from current columns, marked `metadata.backfilled = true`. Nothing deleted.
- History table UI: Date · Time · Person · Department · Action · Details · Source · Attachment;
  sort, search, date/person/action/source filters, paging, newest/oldest, mobile scroll.
- API: `GET /api/tasks/:id/events` (paged, filtered, authorised like the task).
- Exit: old history still visible, every action produces exactly one event, authorization tests.

### Phase 2 — Notifications + deadline engine + Follow-Up (Stage A)
- One notification service: every notification → `notifications` (in-app) + one
  `notification_deliveries` row per channel (web push, Android poll, email; WhatsApp later), with
  status, attempts, failure reason and **idempotency key** (task + recipient + type + date + window).
- Deadline rule (IST): T-3, T-2, T-1 → 3 reminders/day at configurable windows (default 10:00,
  14:00, 18:00); T → "due today"; after T → overdue. Only open, not-yet-approved assignees.
- Follow-Up button redesign: notifies all open assignees once, records recipients, cooldown
  (`FOLLOW_UP_COOLDOWN_HOURS`, default 5), history event; never changes task state.
- No app-level "notifications off" setting (browser/OS permission remains outside our control).
- Decided: the existing 24/12/6/2-hour tiers and 3/5/7/12-day warnings are **kept** alongside the new
  rule, de-duplicated per person/task/hour. Follow-up cooldown **5 hours**.

### Phase 7A — Job engine (Stage A)
- PostgreSQL-backed queue (`automation_jobs`, `automation_job_runs`): claim with
  `FOR UPDATE SKIP LOCKED`, retries with exponential backoff, max attempts → dead-letter,
  idempotency keys, admin "Jobs" page (queued / running / failed / dead-letter, retry button).
- Worker runs in the same Render service at first (no extra cost); can move to a Render Background
  Worker later without code changes. Scheduler enqueues reminder windows; the old timers are removed
  (one authoritative reminder mechanism). No Redis/Kafka/Kubernetes.

### Phase 8 — Hardening (Stage A)
- Backups: scheduled `npm run backup` (GitHub Actions, free) → off-site copy; monthly test restore;
  RPO/RTO targets agreed with management (see paid decisions).
- Object storage: Supabase Storage bucket + `file_objects`; new uploads go there; existing base64
  files migrated in batches after a backup.
- Foreign keys added as `NOT VALID` then validated; staging environment; `ALLOWED_ORIGINS`;
  feature-flag module; SECURITY.md, PRODUCTION_RUNBOOK.md, full DISASTER_RECOVERY.md; error alerts;
  uptime monitor; server region move (recommended).

### Phase 5-core — Ingestion + AI layer (Stage B, flags OFF by default)
- `POST /api/ingestion` → `ingestion_items` (canonical object: source, source_id, content_type,
  content, sender, recipients, attachments, metadata, original + normalized text, language).
- `AIProvider` interface (`extractTask`, `transcribe`, `summarize`, `translate`) with a Claude
  provider first; Gemini/OpenAI addable later. Every call logged to `ai_usage_events`
  (provider, model, tokens, ₹ cost, user, source, task). `MONTHLY_AI_BUDGET` +
  `AI_COST_ALERT_THRESHOLD` → admin alert → non-critical AI paused.
- Deterministic first: dates ("Friday", "उद्या"), people (directory match) and projects parsed
  without AI where possible; AI only for what rules can't do; cheaper model by default.
- `ai_suggestions` → **Review screen**: AI SUGGESTION · task · assignee · deadline · source ·
  confidence · [Create task] [Edit] [Ignore]. Nothing is created without a human.
- Every created task keeps source links (View Source) and an activity event with model + confidence
  + approver.

### Phase 3 — Gmail
- Personal Gmail (decided): forward/CC to one company task inbox → `/api/ingestion` → Review screen
  (details in "Phase adjustments" above). Stores message id, thread id, sender, link — never mailboxes.

### Phase 4 — WhatsApp
- Official Meta WhatsApp Cloud API only (the app already sends via it). Add the inbound webhook:
  signature (`X-Hub-Signature-256`) check, replay protection, idempotency on message id → ingestion.
- Confirmation in WhatsApp: "Task detected … [YES] [EDIT] [CANCEL]". Text first; then PDF/DOC/XLS/
  images; then audio (speech-to-text, Marathi/Hindi/English, original transcript preserved) and video
  (audio track + selective key frames only).

### Phase 6 — Meeting Workspace
- In-app recording or uploaded recording (no Workspace — decided) → transcript → candidate tasks with
  confidence → [Create] [Ignore] → summary, decisions, risks.

### Phase 7B — Advanced workflows
- Overdue → assignee → after X h manager; vendor pending → follow-up suggestion → human approves →
  WhatsApp/email; meeting completed → summary + tasks; email commitment → draft → review.

## Feature flags (all default OFF until tested)

`ENABLE_GMAIL_INTEGRATION`, `ENABLE_WHATSAPP_INTEGRATION`, `ENABLE_AI_TASK_EXTRACTION`,
`ENABLE_MEETING_AI`, `ENABLE_AUTO_TASK_CREATION` (stays OFF — human approval always),
`ENABLE_AI_BUDGET_LIMIT` (ON when AI is enabled).

## Release process (every phase)

local → automated tests → staging → backup → migration → deploy → smoke test (`/readiness`,
login, create/complete a task) → report (completed, files, DB, env, tests, security, deploy,
rollback, next). Existing task management must keep working if any integration fails.

## Decisions (recorded October 2026)

| # | Decision | What it means for the build |
|---|---|---|
| 1 | **Keep** today's 24/12/6/2-hour deadline tiers and 3/5/7/12-day escalation warnings, **and add** the new T-3…overdue rule | Phase 2 runs both rule sets through ONE notification service with idempotency keys; when two rules would notify the same person about the same task within the same hour, only one message is sent (no spam). |
| 2 | Reminder windows 10:00 / 14:00 / 18:00 IST; **follow-up cooldown 5 hours** | `REMINDER_WINDOWS=10:00,14:00,18:00`, `FOLLOW_UP_COOLDOWN_HOURS=5` (both configurable). |
| 3 | Free plan now; **Supabase Pro when the project is ready** | Until then RPO is up to 24 h: Phase 8 adds a scheduled off-site backup (GitHub Actions, free) to narrow it. Switching to Pro + point-in-time recovery is a settings change, no code change. |
| 4 | `mihir-task-manager-1` is deleted (confirmed) | Staging = a new free Render service (`mihir-task-manager-staging`) created in Phase 8. Its database cannot be a third free Supabase project (both free slots are used); use a free Neon PostgreSQL database or a local database. Render's free PostgreSQL expires after 30 days — not suitable. |
| 5 | Personal Gmail accounts; company email address on the company domain | Google Workspace features (Workspace Marketplace add-ons, Meet transcripts/recordings API) are **not** available. Phase 3 and Phase 6 adjusted below. **Open question:** where is the company-domain mailbox hosted (Google, Zoho, GoDaddy/Titan, Hostinger…)? |
| 6 | One WhatsApp Business account in the company's name | Sufficient: one business number serves every employee (see Phase 4). |
| 7 | Cheapest AI provider | Default **Google Gemini Flash-Lite** (paid tier), behind the provider abstraction so it can be swapped. |

### Phase adjustments from these decisions

**Phase 3 (email → task) without Google Workspace.** Primary route that works with any mailbox,
personal Gmail and phones: employees **forward or CC** an email to one company task address
(e.g. `tasks@<company domain>` or a dedicated company Gmail inbox). The app reads only that
inbox, converts each email into an ingestion item and shows the Review screen to the sender.
No OAuth on employees' personal mailboxes; only the forwarded message is stored (with message id,
thread id, sender, link). A Gmail add-on for personal accounts stays optional for later (it requires
Google's OAuth app verification once more than a test group uses it).

**Phase 4 (WhatsApp) — one business account is enough.**
- One WhatsApp Business Account + one dedicated phone number (a number not active on the regular
  WhatsApp app). Every employee chats with that one company number; the app recognises the
  employee from the phone number on their profile — unknown numbers are ignored.
- Message templates are written once by Admin (drafts provided in Phase 4) and **approved by Meta**,
  not by an internal person.
- Cost in India since 1 Oct 2026 (Meta, approximate, plus GST): employee → company messages free;
  company replies: 1,000 free per number per month, then ≈ ₹0.12–0.15 each; automated reminders
  (utility templates) ≈ ₹0.12–0.15 each. Therefore WhatsApp is used for task creation/confirmation
  and important alerts; the frequent reminders stay on free in-app/push notifications unless
  management chooses otherwise. Monthly WhatsApp cost is shown on the Admin dashboard.

**Phase 5-core (AI).** Default provider Google Gemini **2.5 Flash-Lite** (≈ $0.10 per million input
tokens, $0.40 per million output tokens, as published in 2026). A typical email/WhatsApp task
extraction ≈ 1,500 input + 300 output tokens ≈ ₹0.02; 1,000 extractions/month ≈ ₹25. Voice notes and
video cost more (audio is priced higher) and are counted separately. Use the **paid** API tier for
company data (free-tier inputs may be used by the provider to improve its products). Rules first
(dates, people, projects), AI only when needed; usage + ₹ cost logged per call; monthly budget.

**Phase 6 (meetings) without Workspace.** Meet's recording/transcript API is not available on
personal accounts, so the Meeting Workspace starts with **in-app recording** (phone or laptop
microphone — also covers site meetings that are not online) or uploading a recording → transcript
(Gemini audio) → task candidates with confidence → [Create] [Ignore] → summary, decisions, risks.

**Phase 8 additions.** Set Render's health-check path to `/readiness` (currently empty — Render
cannot detect a broken deploy); staging service; scheduled backups.

## Paid services (none bought without approval)

Evaluated in Phase 8 with the full template (purpose, why free is insufficient, monthly/annual
cost, reliability, privacy, lock-in, alternatives). Likely candidates: Supabase Pro (backups /
point-in-time recovery / no pausing), Render Starter (no sleeping), Meta WhatsApp conversation
charges, AI usage. Stage A itself needs no paid service.

## Documentation schedule

Created/updated with the phase that changes them (not all at once): ARCHITECTURE.md, DATABASE.md,
API.md (Phase 1–2), AUTOMATION.md (7A), SECURITY.md, DEPLOYMENT.md, PRODUCTION_RUNBOOK.md,
DISASTER_RECOVERY.md, TESTING.md (8), INGESTION.md, AI.md (5-core), GMAIL.md (3), WHATSAPP.md (4),
MEETINGS.md (6). CHANGELOG.md on every release.
