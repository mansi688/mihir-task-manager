# MULTI_INSTANCE_READINESS.md

## Direct answer
This app currently runs safely as **exactly 1 server instance**. It has not been made safe to
run as 2+ concurrent instances behind a load balancer, and doing so today would cause real,
specific bugs — listed below, not just a vague warning.

## Every piece of process-local state found

### 1. Rate limiters (login, AI) — `server.js`
In-memory `Map`-backed sliding windows. With 2+ instances, each tracks its own count
independently — the real effective limit becomes (configured limit × instance count), and a
request could be routed to whichever instance has capacity left, defeating the limit's purpose.
**Fix if scaling out**: move to a shared store (Redis is the standard choice) keyed the same way.

### 2. OTP request rate limiting — `server.js`
Same problem, same fix, for password-recovery OTP requests specifically.

### 3. Scheduled background jobs — `server.js` (4 separate `setInterval` calls)
Daily task reminders, age-based escalation (3/5/7/12-day), deadline-based reminders, and the
weekly Admin warning digest. **This is the most serious multi-instance gap found**: each running
instance would independently fire all four jobs on its own timer, with no coordination between
instances. Running 2 instances today (without the fix below) would send every reminder,
escalation, and digest **twice** — a real, user-visible bug, not a theoretical one.
**Fix if scaling out**: either (a) run these jobs in exactly one dedicated worker process, not
inside every web-serving instance, or (b) add a database-backed claim/lock (e.g., a
`scheduled_job_runs` table with a unique constraint on job name + time window, and each instance
attempts to claim the run before executing it) so only one instance's attempt succeeds per cycle.

### 4. Push/WhatsApp/email dispatch
These are already fire-and-forget from the main request (verified elsewhere: they don't block
the response, and a failure in one doesn't fail the surrounding transaction) — this part is
already safe to run from any instance, since each dispatch is tied to a specific, already-created
notification row, not a shared in-memory queue. No fix needed here for multi-instance readiness
specifically.

### 5. The database itself
better-sqlite3's synchronous, single-writer model is the deepest architectural blocker to
multi-instance scaling — see `DATABASE_MIGRATION.md`. Two Node processes writing to the same
SQLite file is not the same safety guarantee as one process's serialized synchronous writes;
WAL mode helps with concurrent *reads* but multiple *processes* writing needs to be tested
explicitly, not assumed safe by extension of the single-process guarantee already verified.

## What is NOT a multi-instance problem
- JWT-based sessions are stateless by design — any instance can validate any token, since the
  secret is shared via `.env`, not stored in memory per-instance.
- The notification/audit-log data itself lives in the shared database, not in process memory.

## Recommendation
At this app's actual current scale (~75-100 employees, one company), a single well-provisioned
instance is the right architecture — verified via load testing to handle 100 concurrent requests
correctly. If real growth ever requires horizontal scaling, the background-job duplication issue
(item 3) is the one that would cause an actual incorrect production behavior on day one of adding
a second instance, and must be fixed before scaling out — the rate-limiter issue (items 1-2) is a
security-hardening degradation, not a correctness bug, and could be tolerated slightly longer if
truly necessary, but shouldn't be left indefinitely either.
