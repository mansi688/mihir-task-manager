# Going Live — the real, current checklist

This replaces the old DEPLOY.md and DEPLOY_PRODUCTION.md, which were written before the
PostgreSQL migration and are now inaccurate (they still describe SQLite behavior). This is the
accurate path, reflecting exactly what this codebase actually does today.

## 1. Your database (Supabase) — confirm it, don't re-create it

You mentioned already having a Supabase project. You need its **connection string**, not just
its dashboard URL:

- Supabase dashboard → your project → **Project Settings → Database**
- Copy the connection string under **Connection string → URI** (use the "Session pooler" or
  direct connection string — either works with this app)
- It looks like: `postgresql://postgres.xxxxx:[YOUR-PASSWORD]@aws-0-xxxx.pooler.supabase.com:5432/postgres`
- This full string is your `DATABASE_URL`

## 2. Push this code to your GitHub repo

Whatever's in this zip needs to fully replace what's currently in your repo — not merge with
it. Every fix in this conversation (the Postgres conversion, the concurrency fix, the pool
crash fix, the button-binding fix, the hour-based escalation system, reshuffling, everything)
only takes effect once this exact code is what Render is actually running.

## 3. Set every environment variable on Render

Render dashboard → your service → **Environment** tab. These are all required or strongly
recommended:

| Variable | Value | Required? |
|---|---|---|
| `DATABASE_URL` | Your Supabase connection string from step 1 | **Required** |
| `JWT_SECRET` | A long random string (generate one below) | **Required** |
| `SMTP_HOST` | e.g. `smtp.gmail.com` | Required for forgot-password |
| `SMTP_PORT` | `587` | Required for forgot-password |
| `SMTP_USER` | Your sending email address | Required for forgot-password |
| `SMTP_PASS` | Your app password (see previous message) | Required for forgot-password |
| `SMTP_FROM` | `MIHIR Task Manager <you@example.com>` | Recommended |
| `ALLOWED_ORIGINS` | Leave unset unless frontend/backend are on different domains | Optional |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | See `scripts/generate-vapid-keys.js` | Optional, only for push notifications |

Generate a real `JWT_SECRET` (run locally, paste the output into Render):
```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Do not set `PGSSLMODE=disable`** for Supabase — Supabase requires SSL, and the app's default
(SSL on) is already correct for it. That variable exists only for local testing against a
Postgres instance with no SSL.

## 4. Deploy and verify it's actually healthy

After Render finishes building:

- Visit `https://your-app.onrender.com/health` — should return `{"status":"ok"}`
- Visit `https://your-app.onrender.com/ready` — should return `{"status":"ready"}`. If this
  returns `503` instead, your `DATABASE_URL` is wrong or Supabase isn't reachable — fix this
  before doing anything else
- Check Render's **Logs** tab for the line `"First run: created default account admin / admin123"`
  — if you see it, the database schema was created successfully for the first time

## 5. Log in as admin and set a real password

- Go to the live URL, log in with `admin` / `admin123`
- You'll be prompted to set a real password immediately — do this now
- Go to **My Profile** and add your own real email address (needed for step 6)

## 6. Confirm email actually works, before relying on it

- Go to **Accounts** (admin-only tab) → **"Send Test Email to My Own Address"**
- Check your inbox. If it doesn't arrive within a minute or two, check spam, then re-check your
  SMTP environment variables
- Only once this test email genuinely arrives should you trust forgot-password for real users

## 7. Create real employee accounts

Two ways:
- **One at a time**: Accounts tab → Add Account. Give each person a temporary password (e.g.
  `MHR123456` or similar) — they'll be forced to set a real one on first login, and it visibly
  no longer forces a hard block if they dismiss it (per an earlier fix), so nobody gets stuck
- **In bulk**: if you have a spreadsheet of real employees, `scripts/import-real-employees.js`
  reads from `data/employees-data.json` — see that script's comments for the exact format

## 8. Seriously consider upgrading off Render's free tier

This was the root cause of the data-loss and instability issues earlier in this project — free
tier spins down after 15 minutes idle (a real, felt delay for whoever hits it first) and has no
persistent disk (though Postgres on Supabase is *not* affected by this — your data survives
regardless, since it's a separate service; only Render's app process itself resets). For a
real company depending on this daily, Render's **Starter** plan (~$7/month) removes the
spin-down entirely and is worth it.

## 9. Roll it out

- Share the live URL with your team
- Give each person their username and temporary password directly (Slack, WhatsApp, in person
  — not email, since forgot-password email isn't a substitute for the *initial* password
  handoff)
- Tell them to change their password on first login, and that "Forgot password" now genuinely
  works if they ever lose access afterward

## Ongoing — what to actually watch

- **Supabase dashboard** → Database → for connection/query health
- **Render Logs** → search for `"Postgres pool error"` occasionally — these are expected and
  harmless on their own (the app recovers automatically), but a sudden high frequency could
  indicate a Supabase-side issue worth investigating
- **Render Logs** → search for `"Fatal error during startup"` — this should never appear; if it
  does, the app failed to reach the database entirely and needs immediate attention
