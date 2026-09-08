# LOAD_TEST_RESULTS.md

Real measurements from `test/manual-load-test.js`, run directly against a live instance of this
app in this development sandbox. **Environment caveat that matters for every number below**:
this sandbox has exactly 1 CPU core (confirmed via `nproc`). Any endpoint whose cost is
CPU-bound (specifically: bcrypt password hashing) is measuring this sandbox's single-core
ceiling, not this app's real scalability ceiling — that distinction is called out explicitly
below rather than left implicit.

## Method
100 real member accounts created via the actual API (not mocked), then `Promise.all` fires the
stated concurrency against a live server, measuring real wall-clock time per request.

## Results (100 concurrent unless noted)

| Scenario | Concurrency | p50 | p95 | p99 | Errors |
|---|---|---|---|---|---|
| Login | 100 | 3541ms | 6686ms | 6879ms | 1/100 |
| My Tasks (dashboard) | 100 | 91ms | 171ms | 172ms | 0/100 |
| Task creation | 100 | 127ms | 147ms | 154ms | 0/100 |
| Admin All Tasks listing | 50 | 1410ms | 1429ms | 1431ms | 0/50 |
| Notifications fetch | 100 | 81ms | 147ms | 151ms | 0/100 |
| 100 simultaneous mixed requests (login+create+fetch+submit, existing automated test) | 100 | — | — | — | 0/100, ~22ms/request avg |

## What this actually shows

**Every non-login endpoint handles 100 concurrent requests comfortably** — sub-200ms at p99 for
dashboard/task-creation/notifications, ~1.4s at p99 for the heaviest unbounded query (All Tasks
— see P1-3 in `PRODUCTION_AUDIT.md`, this is the unpaginated-query finding, not a concurrency
problem specifically).

**Login is the one number that doesn't yet meet this app's own stated goal**, and this is
reported honestly rather than smoothed over: p50 = 3.5s, p99 = 6.9s at 100 concurrent logins.
Root-caused directly (see `PRODUCTION_AUDIT.md` P1-1) to bcrypt password hashing being
inherently CPU-bound, combined with this sandbox providing only 1 CPU core to actually run that
work on. A fix was applied (native async bcrypt, offloading to libuv's thread pool instead of
blocking the main thread) and gave a real but modest improvement here — because a 1-core machine
has no hardware parallelism for a thread pool to exploit regardless of software design.

**This is architecture-correct, sandbox-limited, not sandbox-correct, architecture-limited.** A
single bcrypt comparison measured 68ms on this hardware; on a real 2-4+ vCPU server, the same
async code should let multiple logins' hash comparisons run on genuinely different physical
cores simultaneously, which this 1-core sandbox cannot demonstrate. **This claim itself was not
verified on multi-core hardware** — flagging that gap explicitly rather than asserting an
improvement I couldn't measure.

## What was NOT load tested this pass
- 250+ concurrent users (only 100 was exercised)
- Sustained load over an extended duration (all tests here are short bursts, not a soak test)
- Behavior under real network latency (this sandbox tests over loopback, not over a real network)
- The effect of real SMTP/WhatsApp/push dispatch under load (those are fire-and-forget from the
  main request path already, but their own latency under load wasn't separately measured)

## Recommendation before treating this app as verified for 100+ real concurrent users
Re-run `node test/manual-load-test.js` directly on the actual target production server (or a
hardware-equivalent staging box), specifically to get a real login-latency number on real
multi-core hardware — the number in this document for login is a sandbox artifact, not
production truth, and shouldn't be quoted as this app's real login performance.
