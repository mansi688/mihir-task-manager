# Deploying MIHIR Task Manager — Step by Step

Written for someone doing this for the first time. No prior GitHub or
server experience assumed. Follow the steps in order.

---

## Part 1 — Get the code onto GitHub

**1. Create a free GitHub account** (skip if you already have one)
Go to https://github.com/join and sign up.

**2. Create a new, empty repository**
- Click the **+** in the top-right corner → **New repository**.
- Name it something like `mihir-task-manager`.
- Leave it **Private** (this app holds real company task data — don't make it Public).
- Do **not** check "Add a README" — you already have one.
- Click **Create repository**. Leave this page open; you'll need the URL it shows you.

**3. Install Git on your computer** (skip if `git --version` already works in a terminal)
- Windows: https://git-scm.com/download/win — install with default options.
- Mac: open Terminal and type `git --version` — macOS will offer to install it if missing.

**4. Push this project to your new repository**
Open a terminal, navigate into the unzipped project folder, then run these commands one at a
time (replace `YOUR-GITHUB-URL` with the URL GitHub showed you in step 2 — it looks like
`https://github.com/yourname/mihir-task-manager.git`):

```
cd path/to/taskmanager-updated
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin YOUR-GITHUB-URL
git push -u origin main
```

If it asks you to log in, follow the prompts (GitHub may ask you to authenticate via your
browser). Once it finishes, refresh the GitHub page — you'll see all your files there.

**Important — your `.env` file is never pushed.** It's deliberately excluded (see
`.gitignore`) because it holds your real secrets (JWT key, email password if configured).
Nobody looking at your GitHub repo will see those. You'll create a fresh `.env` on whatever
server actually runs the app, using `.env.example` as the template.

---

## Part 2 — Run it somewhere real

You have two realistic options. Pick based on your situation.

### Option A — Run it on a computer you already control (simplest, free)

This could be an office PC, a spare machine, or a cheap VPS (DigitalOcean, Linode, etc.) you
already have. The app just needs Node.js installed and to stay running.

1. **Install Node.js** (version 18 or newer) from https://nodejs.org — pick the "LTS" version.
2. **Get the code onto that machine.** Either:
   - `git clone YOUR-GITHUB-URL` (if Git is installed there too), or
   - copy the unzipped project folder over directly (USB drive, file share, whatever's easiest).
3. **Install dependencies:**
   ```
   cd taskmanager-updated
   npm install
   ```
4. **Create your real `.env` file:**
   ```
   cp .env.example .env
   ```
   Then open `.env` in a text editor and set a real `JWT_SECRET` — generate one by running:
   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
   and pasting the output in.

   Everything else in `.env` is optional — the app works completely fine with all of it left
   blank. Set these up later, whenever you actually want the feature:
   - **Email password recovery**: `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`/`SMTP_FROM`
   - **AI deadline-risk phrasing**: `ANTHROPIC_API_KEY`
   - **Push notifications**: `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` — generate these with
     `node scripts/generate-vapid-keys.js` and paste the two lines it prints into `.env`. **Important:**
     browsers only allow push notifications over HTTPS (or on `localhost` for testing) — if
     you're running this on a plain office machine over HTTP (Option A below, at its own IP
     address), push notifications won't work until you put a proper HTTPS certificate in front
     of it (a reverse proxy like Caddy or nginx with Let's Encrypt is the usual way). Everything
     else in this app works fine over plain HTTP; this is the one feature that specifically needs it.
   - **WhatsApp task notifications**: `WHATSAPP_TOKEN`/`WHATSAPP_PHONE_NUMBER_ID` — requires a
     WhatsApp Business Cloud API account set up on Meta's side first (a genuine free tier
     exists). One real limitation worth knowing before you set this up: WhatsApp requires an
     Admin-approved message template for anything sent outside a 24-hour window since the
     recipient last messaged your business number — a plain notification will be rejected by
     WhatsApp itself outside that window unless you've set up an approved template in Meta's
     Business Manager. That's a rule of the WhatsApp platform, not something this app controls.
5. **Start it:**
   ```
   npm start
   ```
   The app is now running at `http://localhost:4000`. Anyone on the same office network can
   reach it at `http://THAT-COMPUTER'S-IP-ADDRESS:4000`.
6. **Keep it running even after you close the terminal / restart the machine** — this matters
   for a real deployment. The simplest approach on Linux/Mac is `pm2`:
   ```
   npm install -g pm2
   pm2 start server.js --name mihir-task-manager
   pm2 save
   pm2 startup
   ```
   Follow the one extra command `pm2 startup` prints out — that makes it auto-start if the
   machine reboots. On Windows, look into `pm2` with `pm2-windows-startup`, or use Task
   Scheduler to run `npm start` at login.

### Option B — Use a hosting provider (a bit more setup, works from anywhere)

Providers like **Render.com** or **Railway.app** offer straightforward Node.js hosting with a
free or cheap tier. The general steps (specifics vary slightly by provider):

1. Sign up and connect your GitHub account.
2. Create a new "Web Service" and point it at your `mihir-task-manager` repository.
3. Set the **Start Command** to `npm start` and the **Build Command** to `npm install`.
4. Add your environment variables (`JWT_SECRET`, and optionally SMTP/AI/push/WhatsApp) in the
   provider's dashboard — this replaces having a local `.env` file.
5. **Important for SQLite specifically, confirmed directly from Render's own documentation as
   of 2026:** a Render **Free** web service cannot attach a persistent disk at all — that's a
   paid-tier feature only (~$0.25/GB/month, on top of a paid web service starting around
   $7/month). A free-tier deployment's filesystem is wiped on every restart, and free instances
   restart automatically after 15 minutes of no traffic — so a free Render web service will
   silently lose your entire database on a routine basis, not just occasionally. If you need a
   genuinely free option, see Option C below instead; if you're ready to pay for real
   persistence, budget for both the web service and the disk add-on together.
6. Deploy. The provider gives you a public URL once it's built and running.

### Option C — Free, temporary, and safe: for testing with other users right now

If what you actually need is "let a few people try this out this week," not a permanent
production deployment yet, this is the simplest genuinely free path — and it has **zero risk of
losing data**, since the database never leaves your own computer's real disk:

1. Run the app normally on your own computer: `npm install`, set up `.env`, `npm start` — same
   as Option A, step 1-5, just on your own machine rather than a server.
2. Install a free tunneling tool — **Cloudflare Tunnel** (`cloudflared`) or **ngrok** are the two
   most common, both have a genuinely free tier, no credit card required:
   - Cloudflare Tunnel: `cloudflared tunnel --url http://localhost:4000`
   - ngrok: `ngrok http 4000` (free accounts get a temporary public URL that changes each time
     you restart it)
3. Either command prints a public `https://...` URL. Share that with whoever you want to test
   with — they'll reach your app running on your own machine, over a real HTTPS connection
   (which also means push notifications will actually work for this test, unlike plain HTTP).
4. **The catch, and it's a real one**: your computer has to stay on and connected to the
   internet for the whole testing period — closing your laptop or losing your connection takes
   the app down for everyone until you reconnect. Fine for a short test with a few people; not a
   real production setup.

When you're ready to move past testing into something that stays up permanently, that's when a
small paid VPS (Option A on a $4-6/month box) or a paid hosting-provider plan with persistent
disk (Option B) becomes worth it — genuinely free *and* always-on *and* persistent isn't
realistically available for this kind of app; you get to pick two of the three.

---

## Part 3 — First-login setup (same either way)

1. Open the app in a browser.
2. Log in as `admin` / `admin123` — you'll immediately be asked to set a real password.
3. **Import your real employee roster:**
   ```
   node scripts/import-real-employees.js
   ```
   Creates every real employee account with permanent password `MHR123456`, correct department
   and designation, and correctly detects Directors and team leads from job titles. Safe to
   re-run any time — it updates existing accounts rather than duplicating them, and specifically
   never creates a duplicate for whoever is already your Admin account. It reads from
   `employees-data.json` in this same folder — if your roster changes, edit that file (or
   re-generate it from an updated spreadsheet) and re-run the script.

   **This file contains real names and emails — it's now excluded from git entirely
   (added to `.gitignore`)**, specifically so it can never end up committed to a repository, even
   a private one that later gets made public or shared by mistake. Once you've imported everyone
   and confirmed the roster looks right in Accounts, **delete `employees-data.json` from the
   server** — the accounts are already created in the database at that point, so deleting this
   file doesn't affect them, it just stops real personal data from sitting around in a plain-text
   file any longer than it needs to. If your roster ever changes, re-generate a fresh copy of
   this file from an updated spreadsheet, re-run the import, then delete it again.
4. If you want the demo dataset to show off the reminders/warnings/reports features, run:
   ```
   node scripts/seed-demo-data.js
   ```
   Remove it again any time with `node scripts/remove-demo-data.js`.

---

## Keeping it backed up

See `backup-database.js` and `restore-database.js` in this project — run
`node scripts/backup-database.js` regularly (a scheduled task/cron job is ideal), and **actually test a
restore at least once** so you know it genuinely works before you ever need it for real.

---

## Updating the app later

Whenever you get an updated version of this project:

1. `git pull` (if you cloned via Git) or copy the new files over the old ones (except `.env`
   and your database file — never overwrite those).
2. `npm install` again, in case new dependencies were added.
3. Restart the server (`pm2 restart mihir-task-manager`, or however you start it).

Your data (the database file) is completely separate from the application code, so updating
the code never touches your existing tasks/accounts/history.
