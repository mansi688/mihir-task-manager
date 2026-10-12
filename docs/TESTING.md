# Testing
`npm test` — 319 automated tests (Node test runner + real PostgreSQL in an isolated schema per test file).
Key suites: task-history, reminder-engine (windows, combining, anti-spam, idempotency, follow-up), job-engine
(retries, dead-letter, SKIP LOCKED, crash recovery), integrations (AI ingestion, voice, WhatsApp signatures/duplicates/
CONFIRM, email, meetings, retention — external services replaced by stand-ins), documents (real .docx/.xlsx files, PDF, photo, WhatsApp document/video), web-push-delivery (decrypts a real
pushed message), phase0-foundation (migrations, limits, timezone, audit), account deletion, import/export, security.
Manual tools (not part of `npm test`): `scripts/load-benchmark.js`, `npm run e2e` (Playwright against a running server).
Not testable here (needs real accounts): live Gemini responses, live Meta/WhatsApp delivery, live Supabase Storage,
APK on a physical phone — verify after switching each on (see docs/AI.md, WHATSAPP.md, EMAIL.md, MEETINGS.md).
