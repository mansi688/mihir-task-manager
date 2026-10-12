# Chat Room

Menu: **Communicate → Chat Room** (next to **Announcements**). Available to every role.

## Rooms
- **General** — the whole company.
- **One room per department** (`team:<Department>`). Every employee can read and post in every
  department room; your own department is marked *your dept*. Rooms appear automatically for each
  department in Settings and for any department a user belongs to.
- Messages can carry up to 10 files. Authors can delete their own messages; Admin can delete any
  (audited).

## Tagging
| Type | Who is notified |
|---|---|
| `@username` | That person (autocomplete offers names as you type `@`) |
| `@[Department Name]` (or `@Site` for one-word names) | Everyone in that department |
| `@everyone` | Whole company — Admin and Directors only |

The sender is never notified. Tapping a tag notification opens the room the message was posted in.
Messages that tag you or your department are highlighted.

## API
- `GET /api/chat/rooms` → `[{ key, name, emoji, hint, mine, unread, lastId }]`
- `GET /api/chat/messages?room=&after=&before=&limit=`
- `POST /api/chat/messages { room, message, attachments[] }` → `{ id, mentioned[], departments[], everyone, notified }`
- `POST /api/chat/read { room, lastId }`
- `DELETE /api/chat/messages/:id` (author or Admin)
- `GET /api/chat/files/:id`

Live updates come through the separate chat version in `/api/sync` (`c`), so chatting never reloads task screens.

## Private chats 🔒
- **＋ New private chat** → pick people (and optionally a name). Only the starter and those people
  can see it. Nobody else — not their department, not other departments, **not Admin**. It does not
  appear in anyone else's room list, and its messages, files and unread counts are refused (403/404)
  to non-members.
- Tagging **@person** inside a private chat adds that person; they then see the whole conversation.
  `@[Department]` and `@everyone` do nothing in a private chat.
- Members can **Add people** or **Leave**. When the last member leaves, the chat and its messages are deleted.
- Note: whoever manages the database itself (Supabase) can still read any stored data, as with all app data.

API: `POST /api/chat/private { name?, members[] }` → room info · `POST /api/chat/private/:id/members { members[] }`
· `POST /api/chat/private/:id/leave`. Private rooms appear in `GET /api/chat/rooms` (only for members) with
`private: true` and `members`.
