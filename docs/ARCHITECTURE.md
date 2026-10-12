# Architecture

```
Browser / installed web app / Android APK (WebView)            Meta WhatsApp      Mail forwarder
          │ HTTPS                                                  │ webhook (signed)   │ POST (secret)
          ▼                                                        ▼                    ▼
Node 22 + Express (Render) ── one process ──────────────────────────────────────────────────────
  routes (backend/server.js) → task engine (insertTaskRecords) → history (task_activity_events)
  reminder engine → notification service → in-app · web push · Android poll · WhatsApp (important only)
  job engine (services/jobs.js, PostgreSQL queue) — reminders, digests, retention, integrations
  ingestion (services/ingestion.js) → AI (services/ai.js: Gemini | mock) → suggestions → human → task engine
  storage (services/storage.js) → Supabase Storage (private bucket, signed URLs)
          │ pg pool
          ▼
PostgreSQL (Supabase) — versioned migrations (backend/migrations.js), append-only history, FKs
```
Principles: one task-creation path for every channel; AI proposes, people decide; every external call can fail
without breaking normal task management; all background work is a retried, visible job; all business time is IST.
