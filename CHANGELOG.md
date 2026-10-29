# Changelog

All production changes, newest first. Each release lists database changes, environment changes and
rollback notes. Deploy = push to GitHub `main` → Render auto-deploys. Rollback = Render → Events →
previous deploy → Rollback (all migrations are additive).

## [Unreleased] — Pages update themselves after an upload; notifications ring in a background tab
### Fixed
- **Open pages kept running old code after an upload** (until someone pressed reload) — so a fix could be live on the
  server but not on a computer whose tab was already open. The server now fingerprints the app's files at start-up,
  stamps it into the page (`<meta name="app-version">`) and returns it from `/api/sync`; a page running older code
  reloads itself within ~10 s, or shows "✨ A new version is ready — Reload now" if something is being typed / a form,
  draft, file or recording is open.
- **Notification sound didn't ring with the app in a background tab** (the page only checked while visible). Now a
  background tab checks for new notifications every 30 s (notifications only, nothing heavy), rings, and shows the
  count in the tab title ("(12) MIHIR Task Manager"). Sounds are unlocked on the first click, so the browser doesn't
  block them. With the tab closed, only phone-style notifications ("Turn on notifications for this device") ring.

## [Unreleased] — Approvals don't vanish; faster task lists for people with thousands of tasks
### Fixed
- **Approval notifications disappeared** after being opened: tapping a notification marked it seen, which moved a still-
  pending "Awaiting your approval" / closure / document request out of New. Now an approval that still needs your
  decision is **not** marked seen when opened, and stays in New (with ⏳, even if seen earlier) until you approve,
  send back, close / keep open — then it moves to Seen.
- **Speed / stability**: the live logs showed My Tasks taking 3.4–3.8 s on every refresh for the two people with
  ~3,800 open tasks (Anshul, Vaibhav), holding up the single server for everyone. Task lists were rebuilt after *any*
  write (a notification marked seen, a location ping, a reminder). Task lists now have their own version
  (`db.getTaskVersion`, task tables + users only) and are reused until task data actually changes; the "Kept
  informed" list is cached too.

## [Unreleased] — Task updates: latest update + reply; assistant answers questions about one task
### Added
- **Task updates** (Notifications): each card shows the task's **latest comment** (who, when, text, number of files)
  and a **reply box** — type and press Reply (or Enter) to post on the task without opening it; the card then moves
  to Seen. `notificationTaskInfo` now carries `lastUpdate`.
- **Assistant: questions about one task** — "what is the deadline of task industrial DB IPV6", "X kab tak hai",
  "X chi deadline kay": answers the deadline (days left / overdue), shows who is on it (✓ done, ⏳ submitted) and the
  latest update, plus up to 5 other tasks with similar names. Searches every task the person can see.
### Fixed
- The assistant no longer lists every open task (3,800+ for Admin) for a vague question: "all" with no date, project
  or person narrows to the person's own tasks.

## [Unreleased] — Fix: AI calls failing with "model no longer available"
### Fixed
- Live logs showed every ✨ Fix call failing: Google answers `gemini-2.5-flash-lite is no longer available to new users`
  for newly created API keys. Default model is now **gemini-3.5-flash-lite**, and every AI call (Fix, assistant,
  tasks from messages / voice / documents, meetings, rephrasing) goes through one helper that moves to the next model
  (3.5-flash-lite → 3.5-flash → 2.5-flash-lite → 2.5-flash) when a model is missing or retired, and remembers the one
  that works. Other errors (bad key, quota) are reported, not retried. `AI_MODEL` still overrides.

## [Unreleased] — 🎙 Voice assistant (Marathi, Hindi, English)
### Added
- **🎙 Assistant** button on every page (and "🎙 Ask the assistant" on My Tasks) — speak or type one command in
  Marathi, Hindi, English or a mix:
  - **Show tasks**: my pending / overdue / due today / tomorrow / this week, tasks I gave, waiting for my approval,
    a person's tasks, by project ("Amara che pending tasks", "Harsh ke tasks", "show my overdue tasks").
  - **Mark done** ("slab cha kaam jhala", "mark the scaffolding task done") → confirm card with the note → submits
    your part.
  - **Approve / send back** ("approve Ruchita's carpet task", "send back … because photos missing") → confirm card.
  - **Follow up** on a task or all of a person's pending tasks; **comment** on a task; **create** a task (goes to
    Suggestions for review as before).
  - Nothing changes until **Confirm** is pressed; the confirm uses the normal endpoints, so every permission applies.
    Lists only include tasks the person can see.
  - The answer is shown and **read aloud in the same language** (🔊 on / off in the panel; Marathi falls back to a
    Hindi voice where the phone has none).
  - `POST /api/assistant/command` (`backend/assistant.js`, `ai.parseCommand`), counted in the AI budget.

## [Unreleased] — AI features on with one key
### Changed
- With `AI_API_KEY` set, the AI features are **on by default** — no extra settings: 🎤 Create Task by Voice,
  📋 Tasks from a message, 📎 Tasks from a document or photo (My Tasks), the Suggestions page (review / accept AI
  proposals) and Meetings (record → summary, decisions, action items), plus ✨ Fix on text boxes. Any of them can still
  be switched off with `ENABLE_AI_TASK_EXTRACTION=false`, `ENABLE_VOICE_TASKS=false`, `ENABLE_MEETING_AI=false`.
- The deadline-risk warning wording and the task report suggestions use the same Gemini key when no
  `ANTHROPIC_API_KEY` is set (`ai.complete`), so one key runs every AI feature. All AI use counts in the monthly AI
  budget (`MONTHLY_AI_BUDGET_INR`, default ₹1,000) — Admin → System Health shows the spend.

## [Unreleased] — Writing help: spell-check everywhere and ✨ Fix grammar
### Added
- **Spell-check / autocorrect / auto-capitalise** switched on for every text box (red underlines and right-click
  suggestions on a computer, keyboard autocorrect on phones). Usernames, passwords, codes, numbers, amounts and
  searches are left alone. Free, no setup. `frontend/writing.js`.
- **✨ Fix** chip in the corner of the text box being typed in (comments, task title / description, submission notes,
  closure reasons, chat, announcements, estimation remarks …): one tap fixes spelling, grammar and punctuation in the
  same language (English, Hinglish, Hindi, Marathi — never translated); names, @mentions, numbers, units and codes are
  kept. "↩ Undo fix" restores the original. `POST /api/ai/fix-text` through the existing AI service (Gemini,
  `AI_API_KEY`), logged in AI usage and counted in the monthly AI budget. The chip shows only when the key is set
  (`/api/features` → `aiWriting`).

## [Unreleased] — Comment photos visible in task History
### Fixed
- **Photos / files added to a comment were saved but not shown.** The task's History table only looked at the old
  single attachment of a comment; files added the newer way (several per comment, `task_files`) never appeared, so a
  photo-only comment showed as an empty "Comment" row. History now lists every file of that comment in the
  Attachment column (View), and a comment with only files says "📎 Attached N files". Existing comments are fixed too
  (looked up by the comment). New comments record "Attached <file names>" in History.
- Who can open them is unchanged: the creator, people on the task, people kept informed, and Admin.

## [Unreleased] — Person panel: flagged tasks, then their other open tasks
### Changed
- Flagged / Warnings → tap a person: **🚩 Flagged tasks** first, then a dashed line and **📋 Other open tasks**
  (everything else they have not completed), each with Follow up per task and Follow up all.
  `GET /api/notifications/person/:username/open-tasks` — Admin / Directors see all; others only tasks they created,
  are on or follow.

## [Unreleased] — Steady menu after login
### Fixed
- The menu no longer jumps after login (Accounts Dept first, Estimation / Budget appearing a moment later): until
  their data arrives, Budget / Estimation / Accounts Dept use what the person had last time on this device, or their
  department (Estimation & Billing, Purchase, Accounts, Admin, Directors).

## [Unreleased] — Notifications: person view shows only pending tasks; approvals never show Follow up
### Changed
- Flagged / Warnings: tapping a person shows **only their pending tasks** (completed ones left out) with **Follow up**
  per task and **Follow up all**; the notification list is hidden until "✕ Show all notifications". The list stays
  put after a follow-up (the task shows "Follow up again").
- Approval notifications never show Follow up. When the request is already decided they say so ("✓ Already decided —
  nothing is waiting for your approval", "✓ This closure request has already been handled", "✓ Task is closed");
  pending ones show Approve / Send back (or Close task / Keep open) as before.

## [Unreleased] — Compliance due dates, sounds, JMR quantity only, view-only estimation files
### Added
- **Compliance due dates** (Accounts Dept → 📅 Compliance; Accounts Department and Admin): TDS deposit 7th, **GST deposit
  20th**, Sales invoices 5th, Electricity bill 10th (or the date on the bill — "Date this month"), PT 15th, PF 15th —
  seeded on first start; add / edit / remove more. Reminders to Accounts + Admin **10 days and 2 days before**, on the
  due date and every day once overdue, until "Done for <month>" is pressed (Admin and Accounts are told; undo kept).
  New `backend/compliance.js`, notification types `compliance_due` / `compliance_done`.
  **Upload the bill / challan** for the month on each item ("📎 Upload bill", or with "Done"); files show on the item
  and with "Last done". Table `compliance_files`.
- **Notification sound** for every new notification (`/sounds/notification.mp3`) and a **cheerful announcement chime**
  (`/sounds/announcement.mp3`) for announcements (also for whoever posts one). Sound on / off button on Notifications.
  Phone push notifications still use the phone's own notification sound.
- PDF attachments in Estimation are drawn page by page with pdf.js (`/vendor/pdfjs`, Apache-2.0) — works on phones.
### Changed
- **JMR: the measurements table is removed** — one "Quantity this JMR" field. JMRs imported from Excel keep their lines
  (shown read-only) unless the quantity is changed.
- **Estimation attachments are view-only** (on-screen viewer, no Download) — except the **HighRise / estimation
  document**, which anyone who can see Estimation can download. `GET /api/estimation/files/:id` returns other
  attachments to Admin only; `/view` says `canDownload`.
### Database
- New tables `compliance_items`, `compliance_periods` — additive.

## [Unreleased] — Department access, Estimation material + remarks, view-only files, follow-up clears notifications
### Changed
- **Who sees which department page:** Accounts Dept = Accounts Department people, Purchase Department and Admin
  (Directors / senior management removed). Estimation = Estimation & Billing people, Purchase Department, Admin and
  Dnyaneshwar Kolekar. Only Estimation & Billing (and Admin) write JMRs / reconciliations; only Accounts (and Admin) record payments.
- **Estimation approvals go only to Dnyaneshwar Kolekar (`dnyaneshwar.k`) and Admin** (no longer the project heads).
- **JMR: rate and BOQ item no. removed, Material added** (form, list, detail, print, CSV, summary, Excel import / template).
  JMR amounts are no longer shown anywhere.
- The measurements help line ("Qty = Nos × L × B × H … Tick 'Less' for deductions") is removed.
- Accounts Dept "Site money" tab no longer shows the JMR billing card.
### Added
- **Remarks when sending for approval** (JMR and reconciliation) — included in the approver's notification — and a
  **Remarks thread** on every JMR / reconciliation (submit, returned and approved notes appear there too). New
  notification type `est_remark`.
- **View-only file viewer for Estimation uploads**: images, PDFs (no toolbar) and Excel / CSV shown as a table, with no
  Download button. `GET /api/estimation/files/:id/view`. (A screenshot cannot be prevented.)
- **Notifications:** pressing **Follow up** marks every unread notification about that task as seen (with Undo), so the
  count goes down. In the Flagged / Warnings person panel each task now has its own **Follow up** button.
### Database
- `est_jmr.material` (TEXT), new table `est_comments` — additive.

## [Unreleased] — Accounts Department: vendor bills, credit period, payment reminders
### Added
- **Vendor bills (accounts payable)** on the Accounts Dept page (Accounts, Purchase, Admin, Directors, Senior management).
  - **Purchase sends the bill** (Admin, Purchase Department, people with delivery access): vendor, bill no. and date,
    amount, project, the delivery it is for and **delivery done on** (required), notes, the **vendor bill photo / PDF**
    (required) and the **credit period** (Immediate / 7 / 15 / 30 / 45 / 60 / 90 days or any number, or a due date).
    Due date = bill date (or delivery date) + credit days. Also from a delivery card: **💳 Send bill to Accounts**
    (vendor, project and delivery date filled in). Accounts is notified.
  - **Reminders to the Accounts Department** at the reminder slots, once a day per bill (one card per bill, replaced
    each day): **15, 5 and 2 days before** the due date ("payment due in N days — overdue in N days"), **on the due
    date**, and **every day once overdue** ("overdue by N days"). Bills on hold or paid are not reminded.
  - **Accounts responds on the bill**: ❓ ask Purchase, 💬 note, 🗓 schedule payment (date), 💸 part payment and ✅ mark
    paid (amount, date, mode, UTR / cheque no., proof), ⏸ hold (reason) / ▶ take off hold. Purchase (whoever sent it)
    and Admin are notified of every update. **Purchase replies** (with files) and Accounts is notified; questions
    waiting for Purchase are flagged and counted on their menu badge.
  - **Documents with the bill**: besides the vendor bill, attach delivery challan, PO, GRN, e-way bill, LR / transport
    receipt, weighbridge slip, quotation, credit / debit note or other — when sending, or later with "+ Add document"
    (Purchase and Accounts; the other side is told). Shown grouped by type on the bill, with the linked delivery's own
    documents (challan, signed challan…) listed alongside.
  - **📣 Follow up** (Purchase / Admin → Accounts), at most once every 2 hours per bill; shows who followed up, when,
    and how many times.
  - Tabs: Overdue · Due in 15 days · Not yet due · On hold · Paid · All · **By vendor** (ageing: not due, 1–30, 31–60,
    61–90, 90+ days overdue) · Contractors & site (the earlier overview). Tiles: outstanding, overdue, due in 15 days,
    paid this month. Search, project filter, CSV. Menu badge: overdue bills (Accounts) / questions (Purchase).
  - **Import bills from Excel / CSV** — outstanding bills already on record: Vendor / Party, Bill no., Bill date,
    Amount (or Balance), Paid, Credit days or Due date, Project / Site, Delivery / PO, Remarks; preview with problems
    listed; fully paid rows come in as paid. Template download.
### API
- `GET /api/payables`, `GET /api/payables/summary`, `POST /api/payables`, `/:id/update`, `/:id/respond`
  `{action: note|query|reply|schedule|partial|paid|hold|resume, …}`, `/:id/followup`, `/:id/delete`, `/:id/files`,
  `GET /api/payables/files/:id`, `POST /api/payables/import/preview`, `POST /api/payables/import`,
  `GET /api/payables/template`.
### Database
- New tables `ap_bills`, `ap_bill_events`, `ap_files`. Additive.

## [Unreleased] — Estimation & Billing (JMR, reconciliation) and Accounts Department pages
### Added
- **Estimation** page (menu → Departments) for the Estimation & Billing Department:
  - **JMR (Joint Measurement Record)** — project, location, work item, BOQ item, contractor, unit, rate, RA bill no.,
    measured on / work period, both representatives, and measurement lines (Description · Nos × L × B × H, or a typed
    quantity; "Less" lines for deductions). Live total and amount; **up to previous (approved) / this JMR / cumulative**
    for the same project + work item + contractor. Print layout with signature blocks; CSV.
  - **Material reconciliation** — material issued to a contractor, returned, balance at site → actual consumption;
    work done × norm → theoretical; wastage allowed % → allowed; excess (recoverable × rate = recovery) or saving;
    "use approved JMR quantity as work done". Print; CSV.
  - **Workflow**: draft → send for approval → approved, or returned with a note (then edit and send again). Approved
    entries are locked (files such as the signed copy can still be added). Approvers: Admin, Directors, Senior
    management and the project's heads; they are notified and see a menu badge; the writer is told the decision.
  - **Import JMR from Excel** (.xlsx / .csv): every sheet is read — details above the table (Project, Location,
    Contractor, Work item, Unit, Rate, BOQ item, RA bill, Date), a measurement table with Description and Nos / L / B /
    H and/or Qty (Particulars, No., Length, Width, Thk… are recognised), section-heading rows start a new work item,
    "Less …" rows / negative numbers are deductions, Total rows skipped; when a row's Qty differs from Nos × L × B × H
    the sheet's Qty is kept and the row is flagged. Preview first (pick project / contractor / location, units, which
    JMRs), then create drafts or open one in the form; the Excel is attached (or used as the HighRise document).
    Downloadable template. `POST /api/estimation/jmr/import/preview`, `GET /api/estimation/jmr/template`.
  - **The HighRise / estimation document (Excel, PDF or any format) is required** to send a JMR or reconciliation for
    approval; it is shown separately from other attachments.
  - **Summary**: approved JMR value, value waiting for approval, recoveries; work done to date by work item and
    contractor.
  - Writers: Estimation & Billing Department and Admin. Viewers also: Accounts, Store, Contracting, Execution, project
    heads, management.
- **Accounts Dept** page (Accounts Department, Admin, Directors, Senior management) — a starting point bringing
  together contractor billing from approved JMRs (by contractor, less reconciliation recoveries, CSV), site payments
  from Budget, and invoices received with material from site. The Accounts workflow will be added as described.
### API
- `GET /api/estimation`, `GET /api/estimation/summary`; `POST /api/estimation/{jmr|recon}` (with `lines`,
  `attachments`, `source_files`, `submit`); `/:id/update`, `/:id/submit`, `/:id/decide` `{decision: approve|return,
  note}`, `/:id/delete`, `/:id/files` `{attachments, kind: source|attachment}`; `GET /api/estimation/files/:id`,
  `POST /api/estimation/files/:id/delete`.
### Database
- New tables `est_jmr`, `est_jmr_lines`, `est_recon`, `est_files` (created on start). Additive.

## [Unreleased] — Notifications: act from them, Flagged tab, who has seen; project required
### Added
- **Approve right from a notification.** Any notification about a task where someone's part waits for your approval shows
  "✓ Approve / ↩ Send back" (with a reason); a pending closure request shows "✓ Close task / Keep open"; an approval
  request shows "✓ Approve / ✗ Reject"; a payment to verify shows "✓ Verify / ✗ Not accepted". Acting marks it seen.
- **Flagged** is its own tab (60-hour flags), separate from Warnings. Warning and flagged notifications show how long the
  task has been incomplete — "Incomplete for 2 days 5 hours past the deadline · open 4 days" (or "Due in …"), or that it
  has since been completed.
- In Warnings / Flagged, **tap a person's name** to see their incomplete tasks with the same durations and an Open button.
- **Who has seen** (Admin / Director, on the Notifications page): per person — notifications sent in the last 7 / 30 / 90
  days, how many seen, % seen, how many not seen now, the oldest not seen, when they last opened one — and **View** for
  their latest 60 notifications with the time each was seen (or "Not seen · 3 days").
  `GET /api/admin/notification-reads?days=`, `GET /api/admin/notification-reads/:username`.
### Changed
- **"Mark all as seen" removed everywhere** (button and `POST /api/notifications/read-all`). A notification is seen only
  when it is opened or its ◯ is tapped, so "seen" means the person actually looked at it.
- **Project is required on every new task** and is one of: Mihir Amara, Nyati Equinox, Sierra (Tathawade), Mihir
  Projects (dropdown on the form; checked by the server; sub-tasks keep their parent's). Existing tasks are unchanged.
  The Deliveries project suggestions use the same list.
- **Project heads are always kept informed** on every new task of their project — added automatically to "Keep
  informed" (they see the task, its updates and can follow up; no part to submit, no reminders), notified once, and
  shown under the Project field on the form: Mihir Amara → Suraj Kathale (suraj.k), Rahul Paigude (rahul.p);
  Nyati Equinox → Anil Wagh (anil.w), Siddheshwar Puri (siddheshwar.p); Sierra (Tathawade) → Dnyaneshwar Kolekar
  (dnyaneshwar.k). Not added when they created the task or are already on it; also applies to bulk import. The list is
  `PROJECT_HEADS` in `backend/server.js` (and the same in `frontend/app.js`).
### Database
- `notifications.ref_type`, `ref_id` (which approval request / payment a notification is about). Additive.

## [Unreleased] — Bandwidth: push clean-up and lighter refreshing
### Fixed
- **Push notifications to dead devices were retried for ever.** Only 404/410 removed a registration; devices returning
  400/401/403/413 (expired, revoked, old keys) stayed and were retried on every notification. Those are now removed on
  the first failure, and each person keeps only their 5 newest devices.
- **Locations: the places list was re-requested on every redraw** while it loaded (and for ever after a failure). Now one
  request at a time, at most once a minute.
### Changed
- Background refresh is lighter: the app checks for changes every 10 s (was 5 s; Chat 4 s, was 2 s), refreshes at most
  every 15 s however many changes happen (was on every change), and forces a full refresh every 5 minutes (was 1).
  People / teams / projects / sections / phases / features reload at most every 10 minutes in the background,
  announcements / suggestions / open titles every 5, and the full task list (Admin) every 3 minutes unless All Tasks or
  Today is open. Your own actions still refresh immediately.

## [Unreleased] — Allotted money (per person, monthly + top-ups) with bill verification
### Changed
- **Budget is now per person, not per delivery.** A Director (or Admin) allots money to someone on site — a monthly
  amount, top-ups any time, and money they return. That person pays porters / transport / unloading labour on the
  Director's behalf and records every payment with a photo of the bill (or a reason when there is none) — for a
  delivery they are on, or not for a delivery. The per-delivery budget fields are gone from the delivery form and card;
  the delivery's 💰 Payments tab lists what was paid for it, with each payment's verification status.
- **Budget tab** rebuilt around this:
  - **To verify** (Director / Admin): each payment with its bill photo, who paid whom, the delivery, the payer's balance;
    ✓ Verify, ❓ Ask (question goes to the payer, who answers and can add the bill — it comes back to verify), ✗ Not
    accepted (not counted; the money stays with the person). "Verify all with a bill". Menu badge = payments waiting.
  - **People & balances**: per person for the month — carried forward, allotted, paid, verified, to verify, not
    accepted, balance (negative = paid from own pocket); Statement and + Top up buttons.
  - **Statement**: month-by-month ledger per person with running balance — allotted / returned / each payment, bills,
    status. Unused money carries forward.
  - **All payments** (status / purpose / bill filters, CSV download), **Receipts** (bill gallery + payments without a
    bill), **Summary** (per person, purpose, project, mode).
  - The person holding money sees "Your money" (carried forward, allotted, paid, balance in hand, verified, waiting),
    **+ Record a payment**, **🙋 Ask for top-up** (goes to whoever allots them money), and questions to answer.
- Payments are checked by whoever allotted the person money (otherwise the Directors). Verified payments can only be
  removed by a Director / Admin. Deleting a delivery keeps its payments (and bills) in the statement.
- Who sees all: Directors, Admin, Accounts, the purchase side; everyone else sees their own money and payments.
### API
- `GET /api/budget`; `POST /api/budget/allot` `{username, kind: allot|return, amount, mode, reference, note}`;
  `POST /api/budget/allotments/:id/delete`; `POST /api/budget/payments` (optional `delivery_id`);
  `POST /api/budget/payments/:id/verify` `{status: verified|query|rejected|pending, note}`;
  `POST /api/budget/payments/:id/reply` `{note, attachments}`; `POST /api/budget/payments/:id/delete`;
  `POST /api/budget/request-topup` `{amount, note}`; `GET /api/budget/bills/:fileId`.
### Database
- New table `budget_allotments`; `delivery_payments.delivery_id` now nullable, plus `delivery_ref`, `delivery_title`,
  `verify_status` (default `pending`), `verify_note`, `verified_by`, `verified_at`, `reply_note`;
  `delivery_files.delivery_id` nullable (bills of payments without a delivery); `users.budget_topup_asked_at`. Additive.

## [Unreleased] — Budget tab and delivery sounds
### Added
- **Budget** page in the menu (after Deliveries): every delivery's porter / transport budget against what was actually
  paid. Filters: period (this month, last month, last 30 days, this year, all time, custom dates), project / site,
  paid by, search. Tiles: total budget, spent, balance or over budget, all expenses in the period, deliveries over
  budget, payments without a bill.
  - **Budget vs spent** — one row per delivery: budget, spent, difference, % used, bills attached, status (within
    budget / over budget / nothing spent yet / no budget set); click a delivery to open its 💰 tab.
  - **All expenses** — every payment: date, delivery, project, what for, paid to, mode, who paid, amount, bill;
    filter by purpose, mode, with / without bill; **Download expenses (CSV)**.
  - **Receipts** — bill photos as a gallery (open full size / download) and the list of payments without a bill.
  - **Summary** — paid per person, by purpose, by payment mode, and budget vs spent per project.
  - Menu badge for the purchase side: deliveries over budget + payments without a bill in the last 30 days.
- **Accounts Department** can see every delivery, its documents, payments and bills (read-only) to match receipts.
- **Sounds**: a ring when a delivery is placed (for the person adding it and the site team notified) and a
  "your package is delivered" chime when delivery is confirmed (for the person confirming and the people notified).
  🔔 Sounds on / off button on the Deliveries page (remembered per device). Files: `frontend/sounds/`.
  Sounds play while the app is open; phone push notifications use the phone's own notification sound.

## [Unreleased] — Delivery documents and budget
### Added
- **Documents on every delivery**, in their own tab on the delivery card, split into **📤 Sent to site** (delivery
  challan, PO, vendor invoice, e-way bill, Porter booking, other — uploaded by the purchase side; the site team is
  notified and can open / download / print them) and **📥 From site to head office** (signed/stamped challan, GRN,
  invoice received with material, weighbridge slip, shortage/damage report, other — uploaded by the tagged site team;
  the person who added the delivery and the task creator are notified, with "all required documents from site are in"
  when the set is complete).
- **Required vs optional** per delivery: ticked on the delivery form (default: delivery challan + signed challan);
  unticked types stay optional and can still be uploaded. Cards show "📄 n documents pending"; new
  **Documents pending** tab on the Deliveries page; after unloading, the site team gets a **"Documents pending"**
  reminder at the 9 AM / 3 PM / 6 PM slots (for 30 days) until the required from-site documents are uploaded.
- **Budget & payments** tab: the purchase side sets a porter / transport budget (and note) per delivery; the site team
  records each payment (amount, what for, paid to, mode, date) with a **photo of the bill** (stamped with date, time and
  DLV number) — or a reason when there is no bill. Paid and balance are worked out; over-budget shows in red and the
  purchase side is notified with the running total. Payer can remove their own payment within 48 h; purchase any time.
- **Delivery budget** summary on the Deliveries page: total budget, total paid, balance, deliveries over budget,
  payments without a bill, and **paid per person**.
- After unloading the purchase side can still change the budget and the documents list (other details stay locked).
### Database
- `deliveries.budget_amount NUMERIC(12,2)`, `budget_note`, `required_docs` (default `challan,signed_challan`);
  `delivery_files.doc_type`, `note`, `payment_id`; new table `delivery_payments`. All additive (created on start).
### Rollback
- Previous deploy; the new columns/table are simply unused.

## [Unreleased] — Delivery reminders and follow-up
### Added
- **Delivery reminders** for the tagged site team at the same 9 AM / 3 PM / 6 PM slots, under Notifications →
  Deliveries: "Delivery due today", "Late delivery" (date passed, no proof yet) and "Unloading pending"
  (delivered, not unloaded). One card per person per delivery — each slot's reminder replaces the last one.
- **📣 Follow up on a delivery** (purchase side / Admin): reminds the tagged site team ("please confirm the delivery
  with photos" / "please upload the unloading photos"). Everyone on the delivery sees "Followed up by … · time
  · n times"; the button turns grey ("Follow up again") and can be used again after 10 minutes.
  `POST /api/deliveries/:id/followup`. New columns `deliveries.last_followup_at/_by`, `followup_count`.
### Changed
- Vendor / supplier suggestion is only **Kratex Tradetech India** (any vendor can still be typed in).

## [Unreleased] — Deliveries: task closes when added; delete; site team performance; full name list
### Changed
- **Adding a task to Deliveries closes the task.** Its own work is done (vendor decided etc.), so the task is
  closed and only the delivery is tracked from then on — the site team tagged on it, not the people who did the
  task (no reminders or warnings about the task, nobody marked late for the delivery wait). If the task has an
  open subtask or depends on an unfinished task it is kept open and the reason is shown. The form says the task
  will be closed and warns if anyone's submitted part is still waiting for approval (approve first if they
  should get credit). Recorded in the task history and the Audit Log.
- Deliveries menu badge: for the purchase side, every delivery not yet unloaded; for the site team, the ones
  waiting for their proof.
### Added
- **Delete a delivery** (Admin / purchase side), with confirmation; photos and attachments are removed, the site
  team is told, and if adding it had closed its task you can re-open the task in the same step.
  `POST /api/deliveries/:id/delete {reopenTask}`. New column `deliveries.closed_task`.
- **Site team performance** on the Deliveries page (This month / Last 30 days / All time): per tagged person —
  deliveries tagged on, confirmed, on time (delivery confirmed with photos on or before the delivery date, %),
  late / overdue, still pending, photos they uploaded, average time from delivery to unloading. The purchase side
  sees everyone; a site person sees their own row.
- Vendor / supplier field suggests **Kratex Tradetech India** (also the example text) plus every vendor used before.
### Fixed
- The "site team to receive it" list stopped at about 40 names (around "M"); it now lists everyone, in a
  scrolling box with search.

## [Unreleased] — Deliveries tab; one reminder card per task; Follow up from notifications; mentions can open the task
### Added
- **Deliveries tab** (Tasks → Deliveries). For material whose task work is done (vendor decided etc.) and only
  delivery to site is pending: **🚚 Add to delivery** on the task copies only its title; tag the site team, set the
  date (time optional). Transport details can be added now or later: transport (Porter / vendor vehicle / own /
  courier), Porter order ID, delivery ID / challan / invoice no., driver name and phone (tap to call), vehicle
  number, vendor, quantity, where on site, notes, attachments.
  - Statuses: Scheduled → On the way → Delivered (unloading pending) → Unloaded, or Cancelled (with reason).
  - The tagged site people confirm **delivery** with photos, then **unloading** with photos (photos required,
    optional note). Every photo is stamped with the date, time, delivery number and person before upload, and the
    server keeps the upload time too. The timeline on each delivery shows who did what and when, with the photos.
  - Only **Admin, the Purchase Department, and people Admin gives delivery access** (Accounts → "🚚 Can manage
    deliveries" — e.g. the purchase head's assistant who sits in another department) add, edit, mark on the way
    or cancel deliveries. The driver does not use the app — the purchase side types in the driver's name, phone
    and vehicle. Anyone can be tagged; everyone tagged is added to the linked task's "Keep informed" list, so
    they can open the task. New column `users.manage_deliveries`; `POST /api/users/:username/delivery-access` (Admin).
  - Notifications (new **Deliveries** tab in Notifications): delivery coming, driver details added, on the way,
    cancelled, delivered and unloaded (to whoever added it, the site team and the task creator — "the task can
    now be closed"). Task history records it; the task shows "🚚 DLV-… · status — Open delivery".
  - Menu badge: deliveries waiting for your proof. New tables `deliveries`, `delivery_files` (created on start).
- **Follow up from notifications**: every notification about an open task has a 📣 **Follow up** button. After it
  is used it turns grey ("Followed up 11:15 am · Follow up again") and can be pressed again — e.g. when the same
  task comes back at the next reminder slot because it is still incomplete. Follow-up gap per person lowered
  from 5 h to 2 h (`FOLLOW_UP_COOLDOWN_HOURS`) so a re-follow-up at the next slot goes through.
### Changed
- **One reminder card per task.** A new slot's automatic reminder or warning (9 AM → 3 PM → 6 PM) now replaces
  the earlier one for the same person and task instead of adding another copy, so the notification count stays
  small. The delivery log still records every send. On start-up the server also removes old stacked copies
  (keeps the newest per person per task) in the background — the live database had about 261,000 such copies.
### Fixed
- **"Open task" showed nothing** for people who were only @mentioned in a comment or kept informed. Mentioning
  someone who is not on the task now adds them to "Keep informed", and tasks you are kept informed on are listed
  under My Tasks → **👀 Kept informed** (they do not count as your own work on Today). Open task finds them, and if
  a task was just added it refreshes once before giving a clear message.
- New endpoints: `GET /api/tasks/watching`; `/api/deliveries` (+ `/:id/update`, `/:id/status`, `/:id/proof`,
  `/:id/files/:fileId`). `GET /api/notifications` also returns `tasks` (status + your last follow-up per task).

## [Unreleased] — Welcome guide (language → video → questions → login); stability fixes
### Added
- **Welcome guide for first-time logins.** The first time a new account logs in, before anything else, the app
  shows "Welcome — choose your language" (English / हिंदी / मराठी), the explanatory video in that language, then 5
  simple questions in the same language (4 of 5 passes; wrong answers show the correct answer and why, with **Try
  the questions again** / **Watch the video again**, and after two tries **Continue anyway** — the score is
  kept). The questions can be opened any time — watching the video first is suggested, not required.
- **Different questions for each person:** a bank of 15 questions per language (same questions in all three);
  each person gets 5 of them, picked from their username, with the answers in a shuffled order — people sitting
  together get different questions. Every new try picks a fresh set; reloading mid-quiz keeps the same set.
- **How "first time" is known:** a flag on the account on the server (`needs_guide`) — set for the 76 employee
  accounts created on 10 and 21 Oct and for every account created from now on, cleared for good when the person
  finishes or skips the guide. So it never comes back for that person, on any phone, even after clearing the
  browser. Existing employees never see it automatically. (Before login we cannot know who is using the phone, so
  it does not open by itself on the login screen.)
- **Skip video** button (with a "Skip the guide?" confirmation): opened from the login screen it goes back to the
  login box; on a first login it counts as done and is recorded as skipped.
- Anyone can watch it any time: **📺 Watch the app guide** on the login screen and **App guide** in the menu.
  A guide finished from the login screen counts for the very next login on that phone only.
- Accounts page: each person shows **Guide ✓ HI 4/5**, **Guide skipped** or **Guide pending**, and **Guide again** asks someone to
  repeat it. Finishing, skipping and Admin's "guide again" are in the Audit Log.
- Videos are served from `frontend/guide/` (720p web copies, 10–14 MB each, cached by phones for a week; a new
  video must get a new file name — bump `GUIDE_VIDEO_VERSION` in `guide.js`).
### Fixed
- **Reset Password box closed by itself.** On Accounts, the new-password box was shown by changing the page
  directly, so the 5-second background refresh hid it again — often before the first key press. It is now part of
  the page state: it stays open until **Set** or **Cancel**, keeps what was typed, and shows errors inline.
- **Background refresh never interrupts typing**: it now pauses whenever the cursor is in any text, password or
  dropdown field — even an empty one — and for 3 seconds after leaving it or tapping anything.
- Today page progress details and the private-chat people search no longer reset on a background refresh.
- The app keeps working even if `guide.js` fails to load.
### Database (additive, applied automatically on start)
- `users`: `needs_guide`, `guide_done_at`, `guide_lang`, `guide_score`, `guide_total`, `guide_attempts`.
  Already added to the live database, with `needs_guide=1` for the 76 new employee accounts (audit log entry).
- New endpoints: `POST /api/auth/guide-complete`, `POST /api/users/:username/guide-again` (Admin).

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
