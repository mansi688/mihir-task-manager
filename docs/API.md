# API additions (Phases 0–8)
All under the existing `/api`, Bearer token unless noted. Existing endpoints are unchanged (backward compatible).

| Method & path | Who | Purpose |
|---|---|---|
| GET /readiness, /ready | public | DB round-trip, schema version, timezone |
| GET /api/audit-log?format=page&actor&action&q&from&to&before_id | Admin | paged audit log (plain list without `format=page`) |
| GET /api/tasks/:id/events?limit&cursor&order&type&actor&source&q | can view task | task history |
| POST /api/tasks/:id/nudge | anyone involved in the task, Admin, Director | Follow up — notifies everyone else involved (5 h gap per person) |
| POST /api/tasks/send-reminders-now {at?} | Admin | run reminder engine (optionally "as of" a time) |
| GET /api/notifications/deliveries?status | Admin | delivery log |
| GET /api/notifications | everyone | Your notifications; `tasks` (status, who waits for your approval, pending closure id, people's deadlines), `refs` (approval requests / payments they point to) |
| GET /api/admin/notification-reads?days= | Admin, Director | Per person: sent, seen, not seen now, oldest not seen, last seen |
| GET /api/admin/notification-reads/:username | Admin, Director | That person's latest 60 notifications with seen times |
| GET /api/admin/jobs?status · POST /api/admin/jobs/:id/retry · POST /api/admin/jobs/run-now | Admin | jobs |
| GET /api/admin/system | Admin | health, jobs, deliveries, integrations, features, AI usage |
| GET /api/features | any | which optional features are on |
| POST /api/ingestion {text} | any (flag) | message → suggestions |
| POST /api/ingestion/voice {audio: dataURL} | any (flag) | voice → transcript + suggestions |
| POST /api/ingestion/file {file: dataURL, name} | any (flag) | document / photo / video → suggestions |
| GET /api/suggestions · POST /api/suggestions/:id/accept {title,deadline,assignees,priority,project} · POST …/ignore | owner/Admin | review |
| GET/POST /api/integrations/whatsapp/webhook | Meta (verify token / signature) | WhatsApp inbound |
| POST /api/integrations/email/inbound | forwarder (X-Inbound-Secret) | email inbound |
| POST /api/meetings · GET /api/meetings · GET /api/meetings/:id · GET …/recording · POST …/retry | organiser/participants/Admin | meetings |
| GET /api/chat/rooms · GET /api/chat/unread · GET/POST /api/chat/rooms/:room/messages · POST …/read · DELETE /api/chat/messages/:id | any (delete: own / Admin) | company chat (docs/CHAT.md) |
| GET /api/tasks/watching | everyone | Tasks you are only "kept informed" on |
| GET /api/deliveries | everyone (Admin/Purchase/Director/Accounts see all) | Deliveries you are on, with files, payments, `paid`, `balance`; `seesAll` flag |
| POST /api/deliveries | Admin, Purchase Department | Add a delivery (optionally from a task) |
| POST /api/deliveries/:id/update | Admin, Purchase Department | Edit details, re-tag site team, add files; `budget_amount`, `budget_note`, `required_docs[]` (after unloading only these three) |
| POST /api/deliveries/:id/status | Admin, Purchase Department | `dispatched` or `cancelled` (with reason) |
| POST /api/deliveries/:id/proof | tagged site team, Admin, Purchase | `delivered` then `unloaded`, photos required |
| GET /api/deliveries/:id/files/:fileId | people on the delivery | Attachment / proof photo |
| POST /api/deliveries/:id/documents | to-site types: Admin/Purchase; from-site types: tagged site team or Admin/Purchase | `{type, note, attachments}` — type from `docTypes` in GET /api/deliveries |
| POST /api/deliveries/:id/files/:fileId/delete | uploader or Admin/Purchase | Remove a document or attachment (not proof photos or bills) |
| POST /api/deliveries/:id/payments | tagged site team, Admin/Purchase | `{amount, purpose, mode, paid_to, paid_at, note, attachments}` — bill photo required unless `no_bill_reason` (≥5 chars). Returns `{paid, balance, overBudget}` |
| POST /api/deliveries/:id/payments/:pid/delete | payer within 48 h, or Admin/Purchase | Removes the payment and its bill |
| GET /api/payables | Accounts, Purchase, Admin, Directors, Senior mgmt | Vendor bills with balance, days left / overdue, conversation, files |
| GET /api/payables/summary | everyone | `canView`, `canAdd`, `canPay`, `overdue`, `dueSoon`, `questions` |
| POST /api/payables | Purchase, Admin | Send a bill: vendor, bill_no, bill_date, amount, credit_days or due_date, project, delivery_id, delivery_done_on, attachments (bill required) |
| POST /api/payables/:id/respond | Accounts (schedule/partial/paid/hold/resume/query), Purchase (reply), all (note) | Conversation and payments; the other side is notified |
| POST /api/payables/:id/followup | Purchase, Admin | Reminds Accounts (once per 2 h per bill) |
| POST /api/payables/import/preview · /import | Purchase, Accounts, Admin | Outstanding bills from Excel / CSV |
| GET /api/estimation | Estimation & Billing, Admin, Directors, Senior mgmt, project heads, Accounts, Store, Contracting, Execution | JMRs (lines, previous / cumulative qty, files) and reconciliations (with calculations) |
| GET /api/estimation/summary | everyone | `canView`, `canEdit`, `toApprove`, `returned` (menu + badge) |
| POST /api/estimation/jmr · /recon | Estimation & Billing, Admin | Create (draft, or `submit: true`); `source_files` = HighRise / estimation document (required to submit) |
| POST /api/estimation/{jmr,recon}/:id/update · /submit · /delete | writer / Admin | Edit (draft or returned), send for approval, remove |
| POST /api/estimation/{jmr,recon}/:id/decide | Admin, Directors, Senior mgmt, project heads | `{decision: approve\|return, note}` |
| POST /api/estimation/{jmr,recon}/:id/files | writers, approvers | `{attachments, kind: source\|attachment}` |
| GET /api/budget | everyone (Director/Admin/Accounts/Purchase see all) | Allotted money, payments with bills and status, per-person totals; `canAllot`, `canVerify`, `seesAll` |
| POST /api/budget/allot | Director, Admin | `{username, kind: allot\|return, amount, mode, reference, note}` → `{balance}` |
| POST /api/budget/allotments/:id/delete | Director, Admin | Remove an allotted / returned entry |
| POST /api/budget/payments | money holder, site team on the delivery, Purchase, Director/Admin | Payment with bill, optional `delivery_id` → `{wallet}` |
| POST /api/budget/payments/:id/verify | Director, Admin (not own) | `{status: verified\|query\|rejected\|pending, note}` |
| POST /api/budget/payments/:id/reply | the payer | Answer a question `{note, attachments}` → back to "to verify" |
| POST /api/budget/payments/:id/delete | payer (48 h, not verified), Purchase (not verified), Director/Admin | Remove a payment |
| POST /api/budget/request-topup | anyone | `{amount, note}` → told to whoever allots them money (or Directors) |
| GET /api/budget/bills/:fileId | see-all roles, the payer, people on the delivery | Bill image / PDF |
