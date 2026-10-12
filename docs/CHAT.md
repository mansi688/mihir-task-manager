# Company chat

**Menu → Chat** (everyone). Rooms: **All Company** plus one room per department (created automatically from the
department list). Everyone can read and post in every room — so Site can talk directly to Estimation, Purchase, etc.

## Tagging (same idea as tagging people/departments on tasks)
- Type `@` → pick a person (`@rohit.k`) or a whole department (`@[Estimation Department]`).
- `@everyone` (whole company) — Admin and Directors only.
- Tagged people get a bell notification + phone push; tapping it opens that room. Messages that tag you are highlighted.
- Mention a task ID (e.g. `TASK-AB12CD`) and it becomes a link to that task.
- WhatsApp is **not** used for chat tags (cost) — in-app + push only.

## Behaviour
Unread counts per room (red `@n` when you were tagged) and in the menu; Enter sends, Shift+Enter = new line;
"Load earlier messages" pages back; new messages arrive through the normal live sync (a few seconds), also while typing.
Delete: your own messages; Admin can delete any message (recorded in the Audit Log). Deleted messages show as
"message deleted". Limit: 2,000 characters per message, 30 messages a minute per person.

## Technical
Migration 005: `chat_messages` (room = `general` or `dept:<name>`, mentions, mention_teams, soft delete),
`chat_reads` (per-person read marker; not counted as a data change, so reading never makes other screens refresh),
`notifications.chat_room`. API: `GET /api/chat/rooms`, `GET /api/chat/unread`,
`GET|POST /api/chat/rooms/:room/messages` (`before`, `after`, `limit`), `POST /api/chat/rooms/:room/read`,
`DELETE /api/chat/messages/:id`. Tests: `test/chat.test.js`.
If a department is renamed or removed, its old room's messages stay in the database but the room is no longer listed.
