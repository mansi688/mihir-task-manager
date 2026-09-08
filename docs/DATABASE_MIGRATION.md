# DATABASE_MIGRATION.md

## Current architecture
better-sqlite3, WAL mode, single file on disk. All queries are synchronous — this is a
deliberate property, not an oversight: it means a single Node process executes route handlers
without interleaving between separate synchronous statements, which has been relied on
throughout this project as a genuine (tested) concurrency-safety property, not just an
assumption.

## Can this exact architecture safely support 100 concurrent users?
**YES, WITH CONDITIONS.**
- Verified: 100 simultaneous mixed requests (login, task creation, fetching, submitting) complete
  correctly with zero data corruption and ~22ms/request average (see the existing automated
  concurrent-load test).
- Verified: task creation is now atomic (this session's fix).
- Condition 1: the real server needs more than 1 CPU core for password-hashing throughput to be
  acceptable under concurrent login load (see PRODUCTION_AUDIT.md P1-1 and
  LOAD_TEST_RESULTS.md) — this is a hosting/provisioning requirement, not a SQLite limitation.
- Condition 2: SQLite requires genuinely persistent disk storage — confirmed directly (from
  Render's own documentation) that some free hosting tiers provide none at all. This has been
  DEPLOY.md's explicit guidance from early in this project.
- Condition 3: `listAllTasks()` has no query limit (PRODUCTION_AUDIT.md P1-3) — not a correctness
  risk at 100 users today, but a genuine scaling concern as task history accumulates over years.

## Is PostgreSQL necessary right now?
**No** — not at this app's actual scale (~75-100 real employees, one company). SQLite in WAL
mode on real persistent storage has been genuinely load-tested here, not just assumed safe.

## When PostgreSQL WOULD become necessary
- Running multiple concurrent application server instances behind a load balancer (SQLite's
  single-writer model doesn't extend across separate processes/machines the way a real client-
  server database does).
- A need for read replicas, or write throughput genuinely exceeding what one machine's disk I/O
  can serve.
- Hundreds of thousands+ of tasks/notifications where even well-indexed SQLite queries on a
  single file become the bottleneck.

## Migration path, if/when needed
1. Replace `better-sqlite3`'s synchronous API with an async Postgres client (`pg` or a lightweight
   ORM) — this touches every one of `db.js`'s ~90 functions, since the calling convention changes
   from synchronous return values to Promises. This is the single largest cost of migrating.
2. Re-establish the concurrency-safety guarantee a different way: SQLite's safety here came from
   single-threaded synchronous execution; Postgres would need real transactions and appropriate
   row-level locking (`SELECT ... FOR UPDATE` where two people might race on the same row, e.g.
   simultaneous approval attempts) to get the same guarantee back.
3. Schema translates largely as-is — better-sqlite3's schema already uses standard SQL types;
   the main changes needed are SQLite-specific pragmas (WAL mode, `PRAGMA foreign_keys`) which
   have direct Postgres equivalents, and any implicit type-looseness SQLite allows that Postgres
   enforces strictly (would surface during migration testing, not something to guess at in
   advance).
4. Data migration: export every table to CSV/SQL insert statements, import into Postgres,
   re-verify row counts and a sample of real records match exactly before cutting over.
5. Re-run the entire existing test suite against the new backend before considering the migration
   complete — all 197 current tests exercise real behavior, not implementation details, so they
   should transfer directly as a correctness check.

**Do not attempt this migration incrementally while the app is live** — it's an all-or-nothing
cutover given how deeply the synchronous calling convention is woven through the codebase.
