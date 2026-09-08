# SECURITY_AUDIT.md

## Authentication
- Passwords hashed with bcrypt (cost 10), now via the native library (see PRODUCTION_AUDIT.md P1-1).
- JWT-based sessions, 12-hour expiry, token versioning for "log out everywhere," verified by test.
- Account lockout after 5 failed logins (3 minutes), verified by test.
- New: IP-based login rate limiting (200 req/5min), tuned to never block realistic shared-office
  traffic while still throttling genuine mass-scanning — verified by test.
- Password recovery: OTP-based, rate-limited per account (3 requests/15min), never reveals
  whether a username exists (verified: identical response for real vs. fake usernames), OTP
  hashed at rest, expires in 10 minutes, single-use.
- Mandatory first-login password change for every account (temporary/imported accounts included)
  — verified: old temp password rejected after the real one is set.

## Authorization
- Every state-changing endpoint checked server-side, not just hidden in the UI — verified
  directly across this project's test history via real API attacks (non-creator reopen attempts,
  cross-department dashboard access, follow-up-only users attempting to close/approve, admin-only
  endpoint access by non-admins) — all correctly rejected.
- Director role: department-scoped by default, expandable only by Admin, verified a Director
  cannot grant themselves additional access.
- HR roster: correctly excludes Admin/Director entries for every viewer, including Admin.
- No formal authorization matrix table was produced this session (the prompt's ask) — the
  underlying checks exist and are tested per-endpoint, but a single consolidated matrix document
  was not built due to scope; recommend building one before treating RBAC as fully documented.

## Input validation
- Centralized `str()` coercion and length/type checks used broadly; malformed JSON and unexpected
  types are rejected with clean 400s, not crashes (verified: global error handler test).
- File uploads: size limits, dangerous-extension blocking, on-demand (not eager) attachment
  loading. Filenames/MIME types from the browser are not trusted for authorization decisions.
  **Verified directly this pass**: attachments are stored as base64 data inside the database
  itself, never written to disk under a user-supplied filename — meaning path traversal isn't
  merely mitigated here, it's structurally not applicable to this design at all.

## Known, honestly-unresolved gaps
- No formal SQL injection sweep was performed this session — better-sqlite3's prepared
  statements are used consistently throughout (parameterized queries, not string concatenation),
  which is the correct pattern, but a line-by-line confirmation across every query was not
  re-verified in this pass.
- No strict Content-Security-Policy (see PRODUCTION_AUDIT.md P2-1) — deliberately not added
  without a frontend audit first.
- No dedicated XSS sweep beyond the existing `esc()` escaping pattern already used throughout
  task titles/descriptions/replies — not independently re-verified this session.
- CSRF: this app uses Bearer tokens (Authorization header), not cookies, for authentication,
  which is not vulnerable to classic CSRF (a malicious site cannot make the browser
  automatically attach a token it doesn't have). If cookie-based auth is ever introduced, CSRF
  protection would become a hard requirement, not optional.

## npm audit
0 vulnerabilities, verified from a clean install this session — including a real vulnerability
(qs array-limit bypass) found and fixed during this session's own dependency changes via an
explicit `overrides` pin to the first patched version (6.16.0).
