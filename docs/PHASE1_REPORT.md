# Phase 1 report — professional task history

Status: **COMPLETE** (October 2026). Phase 2 has NOT been started.

## What changed
Task history used to be rebuilt in the browser from scattered columns, so many actions never
appeared and resubmissions overwrote earlier rounds. It is now a **stored, append-only event log**
(`task_activity_events`), written by every task action and shown as a table.

## Required report

1. **Completed:** Phase 1 + the gap analysis for the v3 master prompt (`docs/MASTER_PROMPT_GAP_ANALYSIS.md`).
2. **Files created:** `test/task-history.test.js`, `docs/PHASE1_REPORT.md`, `docs/MASTER_PROMPT_GAP_ANALYSIS.md`.
3. **Files modified:** `backend/migrations.js` (002), `backend/db.js` (event write/list, reply id), `backend/server.js` (event on every action, events API, task view authorization), `frontend/app.js` (history table), `frontend/styles.css`, `CHANGELOG.md`.
4. **Files deleted:** none. (The old browser-built feed `renderTaskActivityFeed` is left unused for one release.)
5. **Database (migration 002, additive):** `task_activity_events.old_value`, `.new_value`; index `(task_id, id DESC)`; trigger making history **append-only** (UPDATE refused; DELETE refused unless the session sets `mihir.allow_history_delete`, which no code does); helper `mihir_try_ts()`; **backfill** of past events (created/imported, assigned, submitted, approved/rejected, comments/attachments, closed, cancelled, archived) for tasks without history — marked `metadata.backfilled`, idempotent.
6. **API:** `GET /api/tasks/:id/events?limit&cursor&order=asc|desc&type&actor&source&q&from&to` (keyset paging, facets for filters). **Security fix:** `GET /api/tasks/:id` now requires the caller to be allowed to see the task (Admin, Director, creator, tagged, follow-up, team lead of a tagged person's department) — it previously returned any task to any logged-in user.
7. **Frontend:** history table per task — Date · Time · Person (+ department) · Action · Details (old → new) · Source · Attachment; search, action / person / source filters, newest/oldest, "Load older" paging; loads only when a task is opened; refreshes after changes; scrolls sideways on phones.
8. **Events recorded:** CREATED, TASK_IMPORTED, ASSIGNED, PERSON_ADDED, PERSON_REMOVED, LEVEL_CHANGED, LEVEL_RELEASED, COMMENTED, ATTACHMENT_ADDED, SUBMITTED, APPROVED, REJECTED, COMPLETED, REOPENED, CANCELLED, DEADLINE_CHANGED (old/new), INDIVIDUAL_DEADLINE_CHANGED, FOLLOW_UP, DRAWING_REQUESTED, CHECKLIST_ITEM_ADDED/TOGGLED/REMOVED, SUBTASK_CREATED, ARCHIVED, DELETED. Creation and import events are written **in the same transaction** as the task. Future types (WHATSAPP/EMAIL/VOICE/MEETING/AI) use the same table via `source_type`.
9. **Environment variables:** none.
10. **Tests added:** task-history (8 groups): creation events, every action once with old/new values, resubmission keeps both rounds, filters/search/order/paging, append-only enforced by the database, authorization (outsider 403 on task and history; follow-up person allowed), subtasks/people/cancel, backfill + idempotency, import events.
11. **Results:** full suite 289/289 passed (exit 0); browser checks on desktop + phone (all 9 events shown in order with old→new values, filters, ordering, live refresh after a change elsewhere, sideways scroll on phones), no console errors.
12. **Security:** task detail endpoint authorization gap fixed; history immutable at database level; history API uses the same visibility rule as tasks.
13. **Performance:** history is fetched per opened task, 20 rows per page, indexed; lists are unaffected.
14. **Deployment:** push → Render applies migration 002 automatically (backfill runs once).
15. **Rollback:** Render → previous deploy. Migration 002 is additive; older code ignores the new columns/trigger (it never updates history rows).
16. **Remaining risks:** backfilled events have no actor where old data didn't store one; "time" for backfilled ASSIGNED uses the tagging/escalation time.
17. **Next phase prerequisites:** deploy, open a few existing tasks and confirm their reconstructed history; then Phase 2 (reminder engine: DB-backed scheduling, 10:00/14:00/18:00 windows, 5-hour anti-spam gap, delivery log).
