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
| GET /api/deliveries | everyone (Admin/Purchase/Director see all) | Deliveries you are on, with file list |
| POST /api/deliveries | Admin, Purchase Department | Add a delivery (optionally from a task) |
| POST /api/deliveries/:id/update | Admin, Purchase Department | Edit details, re-tag site team, add files; `budget_amount`, `budget_note`, `required_docs[]` (after unloading only these three) |
| POST /api/deliveries/:id/status | Admin, Purchase Department | `dispatched` or `cancelled` (with reason) |
| POST /api/deliveries/:id/proof | tagged site team, Admin, Purchase | `delivered` then `unloaded`, photos required |
| GET /api/deliveries/:id/files/:fileId | people on the delivery | Attachment / proof photo |
| POST /api/deliveries/:id/documents | to-site types: Admin/Purchase; from-site types: tagged site team or Admin/Purchase | `{type, note, attachments}` — type from `docTypes` in GET /api/deliveries |
| POST /api/deliveries/:id/files/:fileId/delete | uploader or Admin/Purchase | Remove a document or attachment (not proof photos or bills) |
| POST /api/deliveries/:id/payments | tagged site team, Admin/Purchase | `{amount, purpose, mode, paid_to, paid_at, note, attachments}` — bill photo required unless `no_bill_reason` (≥5 chars). Returns `{paid, balance, overBudget}` |
| POST /api/deliveries/:id/payments/:pid/delete | payer within 48 h, or Admin/Purchase | Removes the payment and its bill |
