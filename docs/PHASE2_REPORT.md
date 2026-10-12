# Phase 2 report — notifications, reminder engine, Follow Up

Status: **COMPLETE** (October 2026). Phase 7A (job engine) has NOT been started.

## What changed
Three independent in-memory timers (daily nudge, age escalation, deadline tiers) are replaced by ONE
database-backed reminder engine, with a delivery log, idempotency keys, combining, anti-spam spacing,
the new window rules, and a redesigned Follow Up button.

## Rules (all Asia/Kolkata)

| Rule | Kind | Recipient |
|---|---|---|
| Daily "still open" nudge (once per 24 h) | routine | assignee |
| Recurring nudge every 3 h after tagging | routine | assignee |
| 48 h open → urgent warning | milestone | assignee + creator |
| 60 h open → flagged | milestone | assignee; Admin + HR |
| 24 / 12 / 6 / 2 h before the deadline | milestone | assignee |
| Deadline passed (once) | milestone | assignee + creator |
| **T-3 / T-2 / T-1 at 10:00, 14:00, 18:00** | routine | assignee |
| **Due today** (once, first window of the day) | milestone | assignee |
| **Overdue by 3 / 5 / 7 / 12 days** | milestone | assignee; creator at 7 and 12 |

Only released, unblocked people whose part is not yet approved are reminded (on-hold levels, blocked
tasks, approved people and closed/cancelled tasks get nothing).

## How messages are decided
1. Collect every rule's proposal. 2. Group by person + task; send ONE — the most important not yet
sent — and record the rest as "combined". 3. Routine nudges are skipped when the person got a reminder
about that task within `AUTO_REMINDER_MIN_GAP_HOURS` (default 3); milestones are never held back.
4. Each message's idempotency key is claimed in `notification_deliveries` before sending, so restarts,
catch-up after sleep, retries or two instances never duplicate it. A missed window is sent on wake-up
if ≤ `REMINDER_CATCHUP_HOURS` (2) old. Failed sends are recorded and retried on the next run.

**Why the automatic gap is 3 h, not 5 h:** the 10:00 / 14:00 / 18:00 windows are 4 h apart; a 5 h gap
would silently turn them into two a day. The 5 h rule applies to the **Follow Up** button as decided;
the automatic gap is configurable.

## Required report
1. **Completed:** Phase 2.
2. **Files created:** `test/reminder-engine.test.js`, `docs/PHASE2_REPORT.md`.
3. **Files modified:** `backend/server.js` (engine, notification hook, Follow Up, deliveries API),
   `backend/db.js` (delivery claim/finish/skip/log, notification id, creator in deadline query),
   `frontend/app.js` (Follow Up button, renamed "Keep someone informed", history labels), `.env.example`,
   `test/daily-reminders.test.js`, `test/hour-based-escalation.test.js`, `test/individual-deadline-tiers.test.js`.
4. **Files deleted:** none. Removed: `sendTaskReminders`, `sendEscalatingTaskReminders`, `sendDeadlineReminders` and their timers (one authoritative engine).
5. **Database:** none new (uses Phase 0's `notification_deliveries`; its unique idempotency index enforces "never twice").
6. **API:** `POST /api/tasks/:id/nudge` (Follow Up; creator / Admin / Director; 429 inside the 5 h gap);
   `GET /api/notifications/deliveries?status=` (Admin); `POST /api/tasks/send-reminders-now` now runs the engine and accepts `at` (Admin, for verification). Old fields `remindersSent`, `escalationsSent`, `deadlineRemindersSent` kept; added `combined`, `suppressed`, `duplicates`, `failed`.
7. **Frontend:** 📣 **Follow up** button; the old "Ask for Follow-up" (adds watchers) renamed **Keep someone informed** — unchanged behaviour, still used by the Excel "Follow Up" column.
8. **Environment variables (optional):** `REMINDER_WINDOWS`, `REMINDER_CATCHUP_HOURS`, `AUTO_REMINDER_MIN_GAP_HOURS`, `FOLLOW_UP_COOLDOWN_HOURS`, `WHATSAPP_NOTIFY_TYPES`.
9. **Tests added:** reminder-engine (7 scenarios: spec wording per rule, one message per person/task, exclusions, idempotent re-run, three windows a day, catch-up within 2 h and not later, delivery log + Admin-only, Follow Up). Older reminder tests updated for combining (documented in each file).
10. **Results:** full suite 297/297 passed (exit 0); browser check: Follow up sends to open people, second press refused with the next allowed time, history row recorded, no console errors.
11. **Bugs found and fixed:** (c) history table showed the device's timezone — now always IST. (a) date-only deadlines counted "due in X hours" to midnight at the START of the day ("2 hours left" the evening before); now to the end of the day, like overdue. (b) **every** notification was also sent on WhatsApp — now only important types (cost + flooding).
12. **Security:** Follow Up limited to creator / Admin / Director; deliveries log Admin-only; no message content exposed in logs.
13. **Performance:** one engine run every 5 minutes (a few queries + one per message); per-task loops unchanged from before.
14. **Always-on notifications:** there is no in-app setting to disable notifications (verified). Browser/OS permission remains outside the app's control.
15. **Deployment:** push → Render. No migration. Behaviour starts immediately; the first run happens ~20 s after start.
16. **Rollback:** Render → previous deploy (the delivery log simply stops growing).
17. **Remaining risks:** on the free Render plan the server sleeps — windows are sent on wake-up only if ≤ 2 h late; **reliable timing needs always-on hosting** (decision pending). Push/WhatsApp failures are logged but only in-app messages are retried automatically (channel retries → Phase 7A).
18. **Next phase:** 7A — move the engine (and the weekly digest / awards timers) onto the database job queue with retries, dead-letter and an Admin "Jobs" page.
