# Security

## Secrets
All secrets live only in Render → Environment (never in Git): `DATABASE_URL`, `JWT_SECRET`, `VAPID_PRIVATE_KEY`,
`AI_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `WHATSAPP_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`,
`EMAIL_INBOUND_SECRET`, `SMTP_PASS`. None is ever sent to the browser. `.env` is git-ignored. Rotate any secret
that is exposed (an old VAPID key was found in Git history in Phase 0 and rotated on 1 Oct 2026).

## Authentication
bcrypt password hashes; JWT (12 h) with `token_version` revocation (password change/reset, "log out everywhere");
5 wrong passwords → 3-minute lock; temporary passwords must be changed; password rules ≥ 8 chars, letters + digits.
Android background notifications use a separate notifications-only device token.

## Authorization (enforced on the server, never only in the UI)
Roles: Admin, Director, Team Lead, Member. Task details and history: Admin, Director, creator, tagged people,
follow-up people, team leads of a tagged person's department. AI suggestions: only their owner (or Admin) can
create/ignore them. Meetings: organiser, participants, Admin; recording playback: organiser/Admin only.
Admin-only: accounts, all tasks, audit log, jobs, deliveries, system page, exports.

## Request protections
1 MB body limit unless the request carries a valid login (then up to 160 MB for files); per-IP rate limits on
login/reset and AI endpoints (real client IP behind Cloudflare/Render); parameterised SQL everywhere; HTML escaped
on output; security headers (nosniff, frame-deny, strict referrer, HSTS in production, microphone/camera
only for this site); CORS restricted to the site in production; generic error messages (no stack traces).

## Webhooks & integrations
WhatsApp: `X-Hub-Signature-256` HMAC verified on the raw body with the app secret; every Meta message id processed
once (replay protection); unknown phone numbers ignored. Email: shared secret header; unknown senders ignored;
Message-ID processed once. AI never touches the database or sends messages — it only proposes; a person confirms.
Only names/usernames, project names and the message itself are sent to the AI provider (paid API tier: inputs not
used for training).

## Data
History (`task_activity_events`) is append-only at database level. Audit log of logins and admin actions (one
entry per login, real IP + device). Files in a private Supabase Storage bucket, downloaded via 5-minute signed URLs
after the app's own permission check. Meeting recordings deleted after 30 days.

## Incident handling
1. Suspected leaked secret → rotate it in Render (and at the provider), redeploy, "log out everywhere" for affected
   users if JWT_SECRET changed (everyone is logged out automatically). 2. Suspicious logins → Audit Log (filter
   "Logged In", check IP/device) → reset that password. 3. Abuse of webhooks → switch the feature flag off.
4. Record what happened in CHANGELOG.md.
