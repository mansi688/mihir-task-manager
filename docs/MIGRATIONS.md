# Database migrations

Two layers, both run automatically at server start (`db.init()`):

1. **Legacy startup schema** (`backend/db.js`): `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`
   statements that existed before Phase 0. Idempotent; left unchanged.
2. **Versioned migrations** (`backend/migrations.js`), recorded in `schema_migrations`. All new schema
   changes go here.

## Rules for every migration

- **Additive & backwards-compatible.** New tables, nullable/defaulted columns, indexes. Never drop or
  rewrite a column in the same release that stops using it; removals happen in a later release.
- **Idempotent.** `IF NOT EXISTS`, guarded `UPDATE … WHERE`, so re-running is harmless.
- **Atomic.** Each migration runs in one transaction; on error it is rolled back, nothing is recorded,
  and the server refuses to start (Render keeps the previous version running).
- **Single runner.** A PostgreSQL advisory lock serialises migrations when two instances start
  together (old + new during a Render deploy).
- **Never edit a shipped migration** — add a new one with the next number.
- **Large tables:** create indexes `CONCURRENTLY` in a migration of its own (outside a transaction)
  once tables grow beyond ~100k rows; avoid `ALTER … TYPE` rewrites on big tables.

## Before any destructive change (drop / rename / type change)

1. `npm run backup` against production and keep the file off-site.
2. Test-restore that backup into a scratch database (`npm run restore`), run the migration there first.
3. Ship the code that no longer needs the old column **first**; drop it in a later release.

## Status

| Version | Name | Applied |
|---|---|---|
| 001 | foundation: activity, notification deliveries, jobs, integrations, AI usage, files, task source | Phase 0 |
