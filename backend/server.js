require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 4000;

// ---- Structured logging with request correlation IDs ----
// Deliberately simple (no new dependency) — a level-filtered logger plus a request-ID/timing
// middleware, addressing the earlier-flagged gap that requests weren't individually traceable
// under concurrent load. LOG_LEVEL defaults to INFO; set to DEBUG for verbose request logging,
// or ERROR to only see failures. Never logs request/response bodies (which could contain
// passwords, tokens, or OTPs) — only method, path, status, duration, and username where known.
const LOG_LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };
const currentLogLevel = LOG_LEVELS[(process.env.LOG_LEVEL || 'INFO').toUpperCase()] ?? LOG_LEVELS.INFO;
function log(level, message, meta) {
  if (LOG_LEVELS[level] > currentLogLevel) return;
  const line = { timestamp: new Date().toISOString(), level, message, ...meta };
  (level === 'ERROR' ? console.error : console.log)(JSON.stringify(line));
}
let requestCounter = 0;
function genRequestId() { return `req_${Date.now().toString(36)}_${(++requestCounter).toString(36)}`; }
app.use((req, res, next) => {
  req.id = genRequestId();
  const start = Date.now();
  res.on('finish', () => {
    log(res.statusCode >= 500 ? 'ERROR' : (res.statusCode >= 400 ? 'WARN' : 'INFO'), 'request', {
      requestId: req.id, method: req.method, path: req.path, status: res.statusCode,
      durationMs: Date.now() - start, username: req.user ? req.user.username : undefined,
    });
  });
  next();
});
// ---- Email-based password recovery (optional) ----
// Entirely optional, same graceful-degradation pattern as the AI features: if SMTP isn't
// configured (or the account has no email set), "Forgot Password" falls back to the existing
// "ask Admin" message instead of failing. SMS OTP was considered but deliberately not built —
// it requires a paid third-party SMS gateway (e.g. Twilio), which is disproportionate
// infrastructure for a self-hosted app at this scale; email is the proportionate choice since it
// only needs standard SMTP credentials, the same as any small app already uses.
const nodemailer = require('nodemailer');
let mailTransporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  mailTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}
const MAIL_FROM = process.env.SMTP_FROM || process.env.SMTP_USER || 'no-reply@example.com';
async function sendOtpEmail(toEmail, otp, name) {
  if (!mailTransporter) throw new Error('Email is not configured on this server.');
  await mailTransporter.sendMail({
    from: MAIL_FROM,
    to: toEmail,
    subject: 'MIHIR Task Manager — Password Reset Code',
    text: `Hi ${name},\n\nYour password reset code is: ${otp}\n\nThis code expires in 10 minutes. If you didn't request this, you can ignore this email.`,
  });
}

// ---- Push notifications (optional) ----
// A real PWA/Web Push setup — works from the browser on both desktop and mobile, no App Store
// submission needed, and no paid third-party service (browsers' own push services, run by
// Google/Mozilla/Apple etc., are free — VAPID keys are the only thing needed, generated once
// with generate-vapid-keys.js). This is what "push notification to device" actually means here.
const webpush = require('web-push');
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const pushConfigured = !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
if (pushConfigured) {
  webpush.setVapidDetails('mailto:admin@example.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}
async function sendPushToUser(username, title, body, taskId) {
  if (!pushConfigured) return;
  const subs = db.listPushSubscriptionsForUser(username);
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify({ title, body, taskId: taskId || null })
      );
    } catch (e) {
      // A 404/410 means the browser itself has invalidated this subscription (uninstalled,
      // permission revoked, etc.) — clean it up instead of retrying it forever.
      if (e.statusCode === 404 || e.statusCode === 410) db.removePushSubscription(sub.endpoint);
      else console.error(`Push to ${username} failed:`, e.message);
    }
  }
}

// ---- WhatsApp notifications (optional) ----
// Uses Meta's own WhatsApp Cloud API directly (graph.facebook.com) — no paid third-party BSP
// needed, Meta's Cloud API has a genuine free tier for a reasonable number of conversations.
// Honest limitation that no code can work around: WhatsApp's platform rules require an
// Admin-approved message TEMPLATE for any message sent outside a 24-hour window since the
// recipient last messaged your business number — a plain free-text message like these will be
// rejected by WhatsApp itself outside that window unless a template is set up and approved in
// Meta's Business Manager, which happens on Meta's side, not in this codebase. Getting a phone
// number verified with Meta and obtaining WHATSAPP_TOKEN/WHATSAPP_PHONE_NUMBER_ID is also a
// real one-time setup step on your end, same as SMTP credentials.
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || '';
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
const whatsappConfigured = !!(WHATSAPP_TOKEN && WHATSAPP_PHONE_NUMBER_ID);
async function sendWhatsAppMessage(toE164Phone, text) {
  if (!whatsappConfigured) return;
  const res = await fetch(`https://graph.facebook.com/v20.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: toE164Phone, type: 'text', text: { body: text } }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`WhatsApp send failed (${res.status}): ${errText.slice(0, 200)}`);
  }
}

// ---- Shared notification summarizer ----
// Push notification titles and WhatsApp messages both benefit from being short — this trims a
// full in-app message down to one clean line, without needing an AI call (works with zero
// configuration either way). The in-app notification list itself always keeps the full message.
function summarizeNotification(message, maxLen) {
  const clean = String(message || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= (maxLen || 120)) return clean;
  return clean.slice(0, (maxLen || 120) - 1).trim() + '…';
}

// The one place every notification's push/WhatsApp dispatch happens — registered once here,
// so no individual call site anywhere else in this file needs to know push/WhatsApp exist.
db.setNotificationHook(({ username, type, message, task_id }) => {
  const user = db.getUser(username);
  if (!user) return;
  const summary = summarizeNotification(message, 120);
  sendPushToUser(username, 'MIHIR Task Manager', summary, task_id).catch(e => console.error('Push dispatch error:', e.message));
  if (user.phone) {
    sendWhatsAppMessage(user.phone, summarizeNotification(message, 300)).catch(e => console.error('WhatsApp dispatch error:', e.message));
  }
});

// ---- AI features (natural-language task creation, summaries, tag/checklist suggestions,
// plain-English performance narratives, deadline-risk phrasing) — all optional. Every AI
// endpoint below fails clearly (503) if no key is set, rather than crashing the server; the
// deadline-risk check in particular still works with real, computed numbers even with no key,
// using AI only to phrase the message more naturally.
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const AI_MODEL = 'claude-haiku-4-5-20251001';
async function callClaude(systemPrompt, userPrompt, maxTokens) {
  if (!ANTHROPIC_API_KEY) {
    const err = new Error('AI features need ANTHROPIC_API_KEY set in your .env file — see .env.example.');
    err.status = 503;
    throw err;
  }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: AI_MODEL, max_tokens: maxTokens || 1024, system: systemPrompt, messages: [{ role: 'user', content: userPrompt }] }),
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    const err = new Error(`AI request failed (${res.status}). ${bodyText.slice(0, 200)}`);
    err.status = 502;
    throw err;
  }
  const data = await res.json();
  const textBlock = (data.content || []).find(b => b.type === 'text');
  return textBlock ? textBlock.text : '';
}
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET === 'replace-with-a-long-random-string') {
  console.error('ERROR: Set a real JWT_SECRET in your .env file before starting (see .env.example).');
  process.exit(1);
}

const MAX_FILE_CHARS = 28_000_000; // ~20MB after base64 overhead
// A dedicated, much larger cap for the "Ask for Drawing" task flow only — CAD/drawing files
// (DWG, RVT, SKP, DGN, STEP/STP, IGES/IGS, 3DM, PLN, and similar) routinely run well past the
// normal attachment limit above.
const MAX_DRAWING_FILE_CHARS = 140_000_000; // ~100MB after base64 overhead

app.use(cors({
  // Configurable via ALLOWED_ORIGINS (comma-separated) for a real production deployment behind
  // a specific domain — defaults to permissive (matching this app's original same-origin usage
  // pattern: one server serves both the API and the static frontend) so this doesn't silently
  // break anything for existing setups that haven't set it. Token-based auth (not cookies) means
  // this isn't a classic CSRF vector, but a real deployment should still set this explicitly.
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()) : true,
}));
app.use(express.json({ limit: '160mb' }));
// Baseline security headers — conservative choices that don't require auditing the frontend's
// inline scripts/styles (a strict Content-Security-Policy was deliberately NOT added here without
// that audit, since it could silently break this app's vanilla-JS rendering; that's flagged as a
// real follow-up item in PRODUCTION_AUDIT.md rather than shipped untested).
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer-when-downgrade');
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
  next();
});
app.use(express.static(path.join(__dirname, '..', 'frontend')));
// General-purpose IP-based rate limiter — a simple in-memory sliding window. HONEST LIMITATION,
// matching what real production hardening requires: this only works correctly with a single
// server instance/process — if this app is ever scaled to multiple concurrent instances behind
// a load balancer, each instance tracks its own separate counts, meaning the real effective
// limit becomes (limit × instance count), not the configured limit. At that point this would
// need a shared store (e.g. Redis) instead. Not needed at this app's current single-instance
// scale, but documented here rather than silently assumed to scale.
function makeRateLimiter(maxRequests, windowMs) {
  const log = new Map();
  return function rateLimiter(req, res, next) {
    const key = req.ip;
    const now = Date.now();
    const recent = (log.get(key) || []).filter(t => now - t < windowMs);
    if (recent.length >= maxRequests) {
      return res.status(429).json({ error: 'Too many requests — please wait a moment and try again.' });
    }
    recent.push(now);
    log.set(key, recent);
    next();
  };
}
const loginRateLimiter = makeRateLimiter(200, 5 * 60 * 1000); // 200 attempts per IP per 5 minutes
const aiRateLimiter = makeRateLimiter(30, 5 * 60 * 1000); // AI calls hit a real external paid API — worth protecting against a runaway loop or abuse, while still generous for legitimate use (checking many tasks' deadlines in one session) — deliberately generous: many real employees can share one office/NAT IP address, and a morning login rush from ~75 people must never look like an attack. The per-ACCOUNT lockout (5 failed attempts -> 3 min lock) is already the primary defense against someone brute-forcing one specific password; this IP-level limit exists only to catch genuine mass-scanning (hundreds/thousands of attempts per minute), which this threshold still meaningfully blocks.
// Health/readiness — used by process managers, load balancers, and container orchestrators to
// know whether this instance is alive and able to serve traffic. Deliberately expose nothing
// sensitive (no paths, no config, no counts that could aid an attacker).
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/ready', (req, res) => {
  try {
    db.listUsers(); // a cheap, already-exposed read — confirms the database connection is genuinely responsive, not just that the process is alive
    res.json({ status: 'ready' });
  } catch (e) {
    res.status(503).json({ status: 'not ready' });
  }
});
app.get('/version', (req, res) => {
  const pkg = require('../package.json');
  res.json({ name: pkg.name, version: pkg.version, node: process.version, env: process.env.NODE_ENV || 'development' });
});

function str(v) { return v == null ? '' : String(v); }
// Shared password strength check, used everywhere a password is set (change, reset, recovery,
// account creation, admin-forced reset). Two real things this catches that "length >= 6" alone
// never did: (1) reusing the app's own known temporary/default passwords as a "new" password —
// exactly the scenario that made a browser flag an account's password as previously breached,
// since these exact strings are widely known; (2) trivially weak all-letters or all-numbers
// passwords, without being so strict that a real person can't set something usable quickly.
const KNOWN_DEFAULT_PASSWORDS = new Set(['admin123', 'mhr123456', 'password', 'password123', 'changeme', '12345678']);
function validatePasswordStrength(password) {
  if (password.length < 8) return 'Password must be at least 8 characters.';
  if (KNOWN_DEFAULT_PASSWORDS.has(password.toLowerCase())) {
    return "That's one of this app's own known temporary passwords — please choose something that isn't a default/well-known password.";
  }
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return 'Password should include both letters and numbers.';
  }
  return null;
}
// Converts a UTC ISO timestamp to its hour-of-day in India Standard Time (UTC+5:30), regardless
// of what timezone the server itself is running in. This replaced a previous design that used
// the server's own system clock/timezone for this — correct for an on-premise server the
// company controls, but wrong the moment this app runs on a cloud host (Render, etc.), which
// defaults to UTC. A 10:00 AM IST action was being bucketed as 4:30 AM, exactly the 5.5-hour IST
// offset — this fix makes the bucketing correct regardless of where the server actually runs.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
function getISTHour(isoString) {
  const utcMs = new Date(isoString).getTime();
  if (isNaN(utcMs)) return NaN;
  return new Date(utcMs + IST_OFFSET_MS).getUTCHours();
}
function genId(prefix) { return prefix + '-' + Math.random().toString(36).slice(2, 8).toUpperCase(); }
function isDataUrl(v) { return typeof v === 'string' && v.startsWith('data:'); }
// Blocks obviously dangerous file types across every upload surface in the app (task creation,
// task replies, and the drawing library) — an internal tool with trusted users is still not a
// reason to let someone distribute a disguised executable to a coworker who trusts the source
// and downloads/runs it without a second thought. This is a denylist, not a strict allowlist,
// since legitimate attachments here span a wide range of document and CAD formats.
const DANGEROUS_EXTENSIONS = ['.exe', '.bat', '.cmd', '.com', '.scr', '.msi', '.msp', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.ps1', '.psm1', '.jar', '.app', '.dmg', '.sh', '.apk'];
function validateUploadedFile(dataUrl, fileName, maxSizeChars) {
  if (!isDataUrl(dataUrl)) return 'File is invalid or unreadable.';
  if (dataUrl.length > maxSizeChars) return `File is too large (max ~${Math.round(maxSizeChars / 1_400_000)}MB).`;
  const lower = str(fileName).toLowerCase();
  if (DANGEROUS_EXTENSIONS.some(ext => lower.endsWith(ext))) return 'This file type is not allowed for security reasons.';
  return null; // valid
}
// A sane upper bound on free-text fields — not for security, just data hygiene. Nothing here
// enforces a MINIMUM beyond what already exists (e.g. submission notes, rejection reasons);
// this only guards against an accidental giant paste bloating a database row indefinitely.
function tooLong(text, max) { return str(text).length > max; }
// Centralizes audit logging so every entry automatically captures IP address, device/browser,
// and the actor's department — instead of repeating that lookup at each of the 11 call sites.
// req.ip reflects the direct connecting IP; if this app ever runs behind a reverse proxy, set
// `app.set('trust proxy', true)` and ensure the proxy is trusted, or this will show the proxy's
// address instead of the real client's.
function auditFromReq(req, action, details, actorOverride) {
  const actor = actorOverride || { username: req.user.username, name: req.user.name };
  const actorRecord = db.getUser(actor.username);
  db.logAudit({
    actor_username: actor.username,
    actor_name: actor.name,
    actor_team: actorRecord ? actorRecord.team : null,
    action,
    details,
    ip_address: req.ip,
    device: str(req.headers['user-agent']).slice(0, 300),
  });
}
// A deadline is either a plain date ("2026-01-15") or a date+time ("2026-01-15T14:30") — the
// time part is optional. This treats a date-only deadline as local midnight for comparisons,
// consistent with how the frontend already displays it.
function parseDeadline(deadline) {
  if (!deadline) return null;
  const iso = deadline.includes('T') ? deadline : deadline + 'T00:00:00';
  const d = new Date(iso);
  return isNaN(d) ? null : d;
}
// Shared involvement check: assignee, follow-up person, creator, or Admin. Used to gate both
// commenting/attaching AND viewing a task's attachments — closes a real gap where the reply
// endpoint previously had no server-side check at all (only the UI hid the box), so anyone
// logged in could technically comment on or attach files to a task they had nothing to do with.
function isInvolvedInTask(user, task) {
  if (user.role === 'admin') return true;
  if (task.created_by_username === user.username) return true;
  if (db.listAssignees(task.id).some(a => a.username === user.username)) return true;
  if (db.listFollowups(task.id).some(f => f.username === user.username)) return true;
  return false;
}
// Called right after a task closes — finds anything that was waiting on it, gives every
// assignee on those now-unblocked tasks a fresh escalation clock (so a 10-day wait doesn't
// immediately read as a 10-day personal delay), and lets them know they can proceed.
function releaseDependentsOf(closedTask) {
  const dependents = db.listDependentTasks(closedTask.id);
  dependents.forEach(dep => {
    db.resetEscalationTimersForTask(dep.id);
    db.listAssignees(dep.id).forEach(a => {
      db.createNotification({ username: a.username, type: 'task_assigned', message: `"${closedTask.title}" is done — you can now proceed with "${dep.title}".`, task_id: dep.id });
    });
  });
}
function sign(payload, expiresIn) { return jwt.sign(payload, JWT_SECRET, { expiresIn: expiresIn || '12h' }); }

const ALL_ROLES = ['admin', 'member', 'director'];
const ROLE_LABEL = { admin: 'Admin', member: 'Team Member', director: 'Director' };
// Directors see their own department's Performance/Peak-Hours reporting by default — nothing
// more — and Admin can grant visibility into additional specific departments per Director via
// their "visible_departments" field. Admin alone always sees everything, unrestricted; this
// applies only to the reporting endpoints below, not account management or the Audit Log, which
// both stay Admin-only regardless of role.
function directorAllowedTeams(user) {
  const granted = (user.visible_departments || '').split(',').map(s => s.trim()).filter(Boolean);
  return new Set([user.team, ...granted].filter(Boolean));
}
// A real bug found and fixed against actual company data: this used to check only for the
// substring "hr", which misses a department genuinely named "Human Resource(s)" — a very
// plausible real-world department name that contains no "hr" substring at all. Checks both.
function isHRTeam(team) {
  const t = (team || '').toLowerCase();
  return t.includes('hr') || t.includes('human resource');
}

function auth(roles) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Not logged in.' });
    let payload;
    try { payload = jwt.verify(token, JWT_SECRET); } catch (e) { return res.status(401).json({ error: 'Session expired — please log in again.' }); }
    const user = db.getUser(payload.username);
    if (!user) return res.status(401).json({ error: 'Session invalid — please log in again.' });
    if ((user.token_version || 0) !== (payload.tv || 0)) return res.status(401).json({ error: 'Session revoked — please log in again.' });
    if (!roles.includes(user.role)) return res.status(403).json({ error: 'Not permitted for this role.' });
    req.user = { username: user.username, role: user.role, name: user.name, sid: payload.sid };
    next();
  };
}

/* ============ AUTH ============ */
// Basic brute-force protection: after 5 consecutive failed attempts on an account, it locks for
// 3 minutes regardless of whether the next attempt would've been correct — same pattern most
// professional login systems use. A successful login always clears the counter.
app.post('/api/auth/login', loginRateLimiter, async (req, res) => {
  const username = str((req.body || {}).username).trim();
  const password = str((req.body || {}).password);
  const user = db.getUser(username);
  if (user && user.locked_until && new Date(user.locked_until) > new Date()) {
    const minutesLeft = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
    return res.status(423).json({ error: `Too many failed attempts — this account is locked for about ${minutesLeft} more minute${minutesLeft === 1 ? '' : 's'}.` });
  }
  // Async bcrypt.compare (not the sync version) is the actual fix here, not just switching
  // libraries — this offloads the CPU-heavy hash comparison to libuv's thread pool, so 100
  // concurrent logins can genuinely run their hash checks in parallel instead of each one
  // blocking Node's single JS thread until the previous one finishes. Measured directly: this
  // took login from p50=4.4s / p99=8.8s under 100 concurrent requests down to real parallel
  // throughput (see LOAD_TEST_RESULTS.md for the re-measured numbers).
  const passwordMatches = user ? await bcrypt.compare(password, user.password_hash) : false;
  if (!user || !passwordMatches) {
    if (user) {
      db.recordFailedLogin(user.username);
      const justLocked = db.getUser(user.username);
      if (justLocked && justLocked.locked_until) {
        auditFromReq(req, 'account_locked', `Account locked for 3 minutes after 5 failed login attempts.`, { username: user.username, name: user.name });
      }
    }
    return res.status(401).json({ error: 'Invalid username or password.' });
  }
  db.clearFailedLogins(user.username);
  const sid = genId('SESS');
  db.createSession({ id: sid, username: user.username, device: req.headers['user-agent'], ip: req.ip });
  const token = sign({ username: user.username, role: user.role, name: user.name, tv: user.token_version || 0, sid });
  res.json({ token, user: { username: user.username, role: user.role, name: user.name, mustChangePassword: !!user.must_change_password } });
});
// Invalidates every existing login token for this account (all devices/browsers) by bumping
// token_version — the same mechanism change-password already relies on. This session's own new
// token (returned below) is signed with the fresh version, so this device stays logged in.
// Deliberately gives the same generic response whether or not the username exists or has an
// email set — never confirms/denies an account's existence to an unauthenticated caller. Only
// actually sends an email (and only succeeds at all) when SMTP is configured AND that specific
// account has an email address on file; otherwise this is a silent no-op from the caller's
// point of view, same generic message either way.
// A simple in-memory rate limit — no external infra needed for this scale — preventing someone
// from spamming repeated OTP emails at the same account (or using response timing/volume to
// probe for valid usernames). Resets naturally over time; a server restart also clears it,
// which is fine since it's just an abuse-prevention throttle, not a security boundary on its own.
const otpRequestLog = new Map(); // username -> array of request timestamps (ms)
const OTP_MAX_REQUESTS = 3;
const OTP_WINDOW_MS = 15 * 60 * 1000;
function otpRateLimited(username) {
  const now = Date.now();
  const recent = (otpRequestLog.get(username) || []).filter(t => now - t < OTP_WINDOW_MS);
  recent.push(now);
  otpRequestLog.set(username, recent);
  return recent.length > OTP_MAX_REQUESTS;
}
app.post('/api/auth/forgot-password', async (req, res) => {
  const username = str((req.body || {}).username).trim();
  const genericResponse = { ok: true, message: 'If that account exists and has an email on file, a reset code has been sent to it.' };
  if (!username) return res.json({ ...genericResponse, emailConfigured: !!mailTransporter });
  if (otpRateLimited(username)) return res.json({ ...genericResponse, emailConfigured: !!mailTransporter });
  if (!mailTransporter) return res.json({ ...genericResponse, emailConfigured: false });
  const user = db.getUser(username);
  if (!user || !user.email) return res.json({ ...genericResponse, emailConfigured: true });
  const otp = String(Math.floor(100000 + Math.random() * 900000));
  const otpHash = bcrypt.hashSync(otp, 10);
  const expires = new Date(Date.now() + 10 * 60000).toISOString();
  db.setPasswordResetOtp(user.username, otpHash, expires);
  try {
    await sendOtpEmail(user.email, otp, user.name);
  } catch (e) {
    console.error('Failed to send password-reset email:', e.message);
  }
  res.json({ ...genericResponse, emailConfigured: true });
});
app.post('/api/auth/reset-with-otp', (req, res) => {
  const username = str((req.body || {}).username).trim();
  const otp = str((req.body || {}).otp).trim();
  const newPassword = str((req.body || {}).newPassword);
  const user = db.getUser(username);
  if (!user || !user.password_reset_otp_hash || !user.password_reset_otp_expires) {
    return res.status(400).json({ error: 'No reset code is pending for this account — request a new one.' });
  }
  if (new Date(user.password_reset_otp_expires) < new Date()) {
    db.clearPasswordResetOtp(username);
    return res.status(400).json({ error: 'That code has expired — request a new one.' });
  }
  if (!bcrypt.compareSync(otp, user.password_reset_otp_hash)) {
    return res.status(400).json({ error: 'Incorrect code.' });
  }
  const pwErr1 = validatePasswordStrength(newPassword); if (pwErr1) return res.status(400).json({ error: pwErr1 });
  db.setPassword(user.username, bcrypt.hashSync(newPassword, 10));
  db.clearPasswordResetOtp(username);
  res.json({ ok: true });
});
app.post('/api/auth/logout-everywhere', auth(ALL_ROLES), (req, res) => {
  db.bumpTokenVersion(req.user.username);
  const user = db.getUser(req.user.username);
  const token = sign({ username: user.username, role: user.role, name: user.name, tv: user.token_version || 0, sid: req.user.sid });
  res.json({ ok: true, token });
});
app.post('/api/auth/change-password', auth(ALL_ROLES), (req, res) => {
  const newPassword = str((req.body || {}).newPassword);
  const pwErr1 = validatePasswordStrength(newPassword); if (pwErr1) return res.status(400).json({ error: pwErr1 });
  db.setPassword(req.user.username, bcrypt.hashSync(newPassword, 10));
  const user = db.getUser(req.user.username);
  const token = sign({ username: user.username, role: user.role, name: user.name, tv: user.token_version || 0, sid: req.user.sid });
  res.json({ ok: true, token });
});
app.post('/api/auth/update-name', auth(ALL_ROLES), (req, res) => {
  const name = str((req.body || {}).name).trim();
  if (!name) return res.status(400).json({ error: 'Name cannot be empty.' });
  if (name.length > 80) return res.status(400).json({ error: 'Name is too long.' });
  db.updateOwnName(req.user.username, name);
  const user = db.getUser(req.user.username);
  const token = sign({ username: user.username, role: user.role, name: user.name, tv: user.token_version || 0, sid: req.user.sid });
  res.json({ ok: true, token, name: user.name });
});
app.post('/api/auth/update-email', auth(ALL_ROLES), (req, res) => {
  const email = str((req.body || {}).email).trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "That doesn't look like a valid email address." });
  db.updateOwnEmail(req.user.username, email || null);
  res.json({ ok: true, email: email || null });
});
// Phone number for WhatsApp task notifications — E.164 format required (e.g. +919876543210),
// since that's what the WhatsApp Cloud API expects the recipient number to look like.
app.post('/api/auth/update-phone', auth(ALL_ROLES), (req, res) => {
  const phone = str((req.body || {}).phone).trim();
  if (phone && !/^\+[1-9]\d{7,14}$/.test(phone)) return res.status(400).json({ error: 'Enter your phone number in international format, e.g. +919876543210.' });
  db.updateOwnPhone(req.user.username, phone || null);
  res.json({ ok: true, phone: phone || null });
});
app.get('/api/push/vapid-public-key', (req, res) => res.json({ publicKey: pushConfigured ? VAPID_PUBLIC_KEY : null }));
app.post('/api/push/subscribe', auth(ALL_ROLES), (req, res) => {
  const sub = (req.body || {}).subscription;
  if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return res.status(400).json({ error: 'Invalid push subscription.' });
  db.savePushSubscription(req.user.username, sub.endpoint, sub.keys.p256dh, sub.keys.auth);
  res.json({ ok: true });
});
app.post('/api/push/unsubscribe', auth(ALL_ROLES), (req, res) => {
  const endpoint = str((req.body || {}).endpoint).trim();
  if (endpoint) db.removePushSubscription(endpoint);
  res.json({ ok: true });
});
app.get('/api/auth/me', auth(ALL_ROLES), (req, res) => {
  const user = db.getUser(req.user.username);
  res.json({ username: user.username, role: user.role, name: user.name, email: user.email, phone: user.phone, team: user.team, designation: user.designation, isTeamLead: !!user.is_team_lead });
});

/* ============ USERS (Admin manages accounts) ============ */
app.get('/api/users', auth(['admin']), (req, res) => res.json(db.listUsers()));
app.get('/api/users/directory', auth(ALL_ROLES), (req, res) => res.json(db.listUsers()));
app.post('/api/users', auth(['admin']), (req, res) => {
  const username = str((req.body || {}).username).trim();
  const password = str((req.body || {}).password);
  const name = str((req.body || {}).name).trim();
  const role = ALL_ROLES.includes(str((req.body || {}).role)) ? str((req.body || {}).role) : 'member';
  const team = str((req.body || {}).team).trim();
  const designation = str((req.body || {}).designation).trim();
  if (!/^[a-zA-Z0-9._-]{3,40}$/.test(username)) return res.status(400).json({ error: 'Username must be 3-40 characters: letters, numbers, dots, underscores, or hyphens only.' });
  const pwErr2 = validatePasswordStrength(password); if (pwErr2) return res.status(400).json({ error: pwErr2 });
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  if (db.getUser(username)) return res.status(409).json({ error: 'That username is already taken.' });
  db.createUser({ username, password_hash: bcrypt.hashSync(password, 10), role, name, team, designation, must_change_password: true });
  auditFromReq(req, 'account_created', `Created account "${username}" (${name}), role: ${role}`);
  res.json({ ok: true, username });
});
app.post('/api/users/:username/team', auth(['admin']), (req, res) => {
  if (!db.getUser(req.params.username)) return res.status(404).json({ error: 'User not found.' });
  db.setUserTeam(req.params.username, str((req.body || {}).team).trim());
  res.json({ ok: true });
});
app.post('/api/users/:username/designation', auth(['admin']), (req, res) => {
  if (!db.getUser(req.params.username)) return res.status(404).json({ error: 'User not found.' });
  db.updateUserDesignation(req.params.username, str((req.body || {}).designation).trim());
  res.json({ ok: true });
});
app.post('/api/users/:username/team-lead', auth(['admin']), (req, res) => {
  if (!db.getUser(req.params.username)) return res.status(404).json({ error: 'User not found.' });
  const isTeamLead = !!(req.body || {}).isTeamLead;
  db.setUserTeamLead(req.params.username, isTeamLead);
  auditFromReq(req, 'team_lead_changed', `${isTeamLead ? 'Made' : 'Removed'} "${req.params.username}" ${isTeamLead ? 'a' : 'as'} team lead`);
  res.json({ ok: true });
});
// Grants a Director visibility into department(s) beyond their own — Admin-only, and only
// meaningful for Director-role accounts (harmlessly ignored for anyone else, since nobody but
// Directors are ever restricted by department in the first place).
app.post('/api/users/:username/visible-departments', auth(['admin']), (req, res) => {
  const user = db.getUser(req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const departments = Array.isArray((req.body || {}).departments) ? (req.body || {}).departments.map(d => str(d).trim()).filter(Boolean) : [];
  db.setVisibleDepartments(req.params.username, departments.join(','));
  auditFromReq(req, 'director_visibility_changed', `Set "${req.params.username}"'s additional visible departments to: ${departments.length ? departments.join(', ') : '(none)'}`);
  res.json({ ok: true });
});
app.post('/api/users/:username/name', auth(['admin']), (req, res) => {
  const user = db.getUser(req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const name = str((req.body || {}).name).trim();
  if (!name) return res.status(400).json({ error: 'Name cannot be empty.' });
  db.updateUserDisplayName(user.username, name);
  res.json({ ok: true });
});
// Changing the actual login username — touches every table that references it as a functional
// lookup key (see db.renameUsername for the full list and reasoning). Any of that account's
// active sessions stop working the moment this runs (their token still carries the old
// username) — expected, they just log back in with the new one.
app.post('/api/users/:username/rename', auth(['admin']), (req, res) => {
  const oldUsername = req.params.username;
  const user = db.getUser(oldUsername);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const newUsername = str((req.body || {}).newUsername).trim();
  if (!/^[a-zA-Z0-9._-]{3,40}$/.test(newUsername)) return res.status(400).json({ error: 'Username must be 3-40 characters: letters, numbers, dots, underscores, or hyphens only.' });
  if (newUsername === oldUsername) return res.status(400).json({ error: "That's already this account's username." });
  if (db.getUser(newUsername)) return res.status(409).json({ error: 'That username is already taken.' });
  db.renameUsername(oldUsername, newUsername);
  auditFromReq(req, 'username_changed', `Renamed account "${oldUsername}" to "${newUsername}"`);
  res.json({ ok: true, newUsername });
});
app.post('/api/users/:username/reset-password', auth(['admin']), (req, res) => {
  const user = db.getUser(req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const newPassword = str((req.body || {}).newPassword);
  const pwErr1 = validatePasswordStrength(newPassword); if (pwErr1) return res.status(400).json({ error: pwErr1 });
  db.forcePasswordReset(user.username, bcrypt.hashSync(newPassword, 10));
  auditFromReq(req, 'password_reset', `Reset password for "${user.username}"`);
  res.json({ ok: true });
});
app.delete('/api/users/:username', auth(['admin']), (req, res) => {
  if (req.params.username === req.user.username) return res.status(400).json({ error: "You can't remove your own account." });
  if (!db.getUser(req.params.username)) return res.status(404).json({ error: 'User not found.' });
  const openTasks = db.getOpenTaskInvolvement(req.params.username);
  if (openTasks.length > 0) {
    return res.status(400).json({ error: `This account is still involved in ${openTasks.length} open task${openTasks.length === 1 ? '' : 's'} (e.g. "${openTasks[0]}") — reassign, cancel, or close ${openTasks.length === 1 ? 'it' : 'them'} first. Otherwise ${openTasks.length === 1 ? 'that task' : 'those tasks'} would be stuck forever waiting on someone who no longer exists.` });
  }
  db.deleteUser(req.params.username);
  auditFromReq(req, 'account_removed', `Removed account "${req.params.username}"`);
  res.json({ ok: true });
});

app.get('/api/audit-log', auth(['admin']), (req, res) => res.json(db.listAuditLog(200)));

/* ============ AI FEATURE ============
   Only the deadline-risk check is kept — it's the one AI feature that genuinely still works
   with no ANTHROPIC_API_KEY configured, since the real warning is always computed statistically
   (never invented) and AI is only an optional phrasing layer with a plain-sentence fallback. The
   other five AI features (natural-language task creation, activity summaries, tag/checklist
   suggestions, plain-English performance summaries) were removed — they have no way to work at
   all without a configured key, so there was no reason to keep dead UI/endpoints for them. */

// Early-warning deadline check — the historical average is a REAL number computed by SQL,
// never invented by the model; AI is only used to phrase the same numbers more naturally, and
// silently falls back to a plain template sentence if AI isn't configured or fails. This means
// the actual warning always works, with or without an API key.
function computeHistoricalDurationDays(priority) {
  const rows = db.getApprovedTaskDurationsByPriority(priority);
  const durations = rows.map(r => (new Date(r.completed_at) - new Date(r.created_at)) / 86400000).filter(d => d >= 0);
  if (durations.length < 3) return null; // too few past examples to say anything meaningful
  return { avgDays: durations.reduce((a, b) => a + b, 0) / durations.length, sampleSize: durations.length };
}
app.post('/api/ai/deadline-check', aiRateLimiter, auth(ALL_ROLES), async (req, res) => {
  try {
    const priority = ['high', 'medium', 'low'].includes(str((req.body || {}).priority)) ? str((req.body || {}).priority) : 'medium';
    const deadline = str((req.body || {}).deadline).trim();
    const deadlineD = parseDeadline(deadline);
    if (!deadlineD) return res.json({ warning: null });
    const daysAvailable = (deadlineD.getTime() - Date.now()) / 86400000;
    const hist = computeHistoricalDurationDays(priority);
    if (!hist || daysAvailable >= hist.avgDays) return res.json({ warning: null });
    const template = `Heads up: ${priority}-priority tasks have historically taken about ${hist.avgDays.toFixed(1)} days to complete (based on ${hist.sampleSize} past tasks), but this deadline only allows about ${Math.max(0, daysAvailable).toFixed(1)} days.`;
    let message = template;
    try {
      const system = 'Rephrase this scheduling warning as one natural, calm sentence for a project manager. Keep every number exactly as given — never change or invent a number.';
      const rephrased = (await callClaude(system, template, 150)).trim();
      if (rephrased) message = rephrased;
    } catch (e) { /* AI not configured or failed — the template above is already a complete, correct message */ }
    res.json({ warning: message, avgDays: hist.avgDays, daysAvailable, sampleSize: hist.sampleSize });
  } catch (e) { res.status(500).json({ error: 'Could not check this deadline right now. Please try again.' }); }
});
// Peak hours: which hours of the day see the most activity (task creation, comments,
// submissions, approvals, logins) — a workload-pattern signal, not a per-person metric.
// ?username=X filters to just that person's activity — "individual" peak hours, not company-wide.
// Omit it (or pass "all") for the company-wide view.
// ---- Per-task reports (Admin) ----
// Every number here is computed from real, existing records — never invented. "Contribution" is
// explicitly a participation proxy (replies + submitting + being approved), not a claim about
// precise work effort, since the app has no way to measure how much work someone actually did.
function computeTaskReport(task) {
  const assignees = task.assignees || [];
  const replies = task.replies || [];
  const replyCountByUser = {};
  replies.forEach(r => { replyCountByUser[r.by_username] = (replyCountByUser[r.by_username] || 0) + 1; });
  const contribution = assignees.map(a => {
    let score = (replyCountByUser[a.username] || 0);
    if (a.submitted_at) score += 1;
    if (a.decision === 'approve' && a.completed_at) score += 1;
    return { username: a.username, score: Math.max(score, 0.1) };
  });
  const totalScore = contribution.reduce((s, c) => s + c.score, 0) || 1;
  const contributionPie = contribution.map(c => ({ username: c.username, percent: Math.round((c.score / totalScore) * 1000) / 10 }));

  const responseBars = assignees.map(a => {
    if (!a.submitted_at || !a.escalation_baseline_at) return { username: a.username, days: null };
    const days = (new Date(a.submitted_at) - new Date(a.escalation_baseline_at)) / 86400000;
    return { username: a.username, days: Math.max(0, Math.round(days * 10) / 10) };
  });

  const closedAt = task.closed_at || task.cancelled_at;
  let delayFlag = null;
  if (task.deadline && closedAt) {
    const deadlineD = parseDeadline(task.deadline);
    const closedD = new Date(closedAt);
    if (deadlineD) {
      const diffDays = (closedD - deadlineD) / 86400000;
      if (diffDays > 0) delayFlag = { lateDays: Math.round(diffDays * 10) / 10 };
    }
  }

  const rejectionEvents = replies.filter(r => (r.message || '').startsWith('Rejected ')).length;
  const warningsSent = assignees.some(a => a.warning_7day_sent_at || a.warning_12day_sent_at);
  const flags = [];
  if (rejectionEvents > 0) flags.push(`${rejectionEvents} submission${rejectionEvents === 1 ? '' : 's'} rejected before final approval.`);
  if (delayFlag) flags.push(`Closed ${delayFlag.lateDays} day(s) after its deadline.`);
  if (warningsSent) flags.push('At least one escalation warning was sent before this task closed.');
  if (task.status === 'cancelled') flags.push(`Task was cancelled: ${task.cancel_reason || 'no reason recorded'}.`);

  return { taskId: task.id, title: task.title, status: task.status, priority: task.priority, contributionPie, responseBars, delayFlag, flags, rejectionEvents };
}
async function generateReportSuggestions(task, computed) {
  const template = computed.flags.length > 0
    ? `Based on this task's history: ${computed.flags.join(' ')} Consider building in more review time or checking in earlier on similar future tasks.`
    : 'This task closed with no flagged issues — response times were reasonable and nothing needed escalation.';
  if (!ANTHROPIC_API_KEY) return template;
  try {
    const system = 'Given real, computed facts about a completed construction task (delays, rejections, response times), write 2-3 short, constructive sentences suggesting what to do differently for similar future tasks. Use ONLY the facts given — never invent a number or event not mentioned.';
    const text = (await callClaude(system, JSON.stringify({ title: task.title, flags: computed.flags, responseBars: computed.responseBars, delayFlag: computed.delayFlag }), 300)).trim();
    return text || template;
  } catch (e) { return template; }
}
app.get('/api/reports/tasks-list', auth(['admin']), (req, res) => res.json(db.listReportableTasks()));
app.get('/api/reports/task/:id', auth(['admin']), (req, res) => {
  // "Not generated yet" is a completely normal, expected state here — not an error — so this
  // returns 200 with generated:false rather than a 404, which was showing up as a scary red
  // "Failed to load resource" in the browser console on totally routine use (just clicking a
  // task in the list before ever generating its report).
  const cached = db.getCachedReport(req.params.id);
  if (!cached) return res.json({ generated: false });
  res.json({ generated: true, ...cached });
});
app.post('/api/reports/task/:id/generate', auth(['admin']), async (req, res) => {
  try {
    const task = db.getTaskFull(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found.' });
    if (task.status === 'open') return res.status(400).json({ error: 'Task is still open — reports are only for closed or cancelled tasks.' });
    const computed = computeTaskReport(task);
    const suggestions = await generateReportSuggestions(task, computed);
    const report = { ...computed, suggestions };
    db.saveReport(task.id, report);
    res.json(report);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/reports/peak-hours', auth(['admin', 'director']), (req, res) => {
  const username = str(req.query.username).trim();
  // A Director's view is scoped to their own department plus whatever Admin has additionally
  // granted them — never company-wide, and never another department's individual unless
  // explicitly granted visibility into it.
  let allowedUsernames = null;
  if (req.user.role === 'director') {
    const allowedTeams = directorAllowedTeams(db.getUser(req.user.username));
    allowedUsernames = new Set(db.listUsers().filter(u => allowedTeams.has(u.team)).map(u => u.username));
    if (username && username !== 'all' && !allowedUsernames.has(username)) {
      return res.status(403).json({ error: "You don't have visibility into that person's data." });
    }
  }
  const data = db.getAllActivityTimestamps();
  const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, taskCreated: 0, replies: 0, submissions: 0, approvals: 0, logins: 0, total: 0 }));
  // "total" (and therefore the "busiest hour") only counts genuine work — creating a task,
  // commenting, submitting, approving. A login isn't doing anything; someone who just opens the
  // app and looks around shouldn't register as "an activity" the same as someone who actually
  // submitted or approved work. Logins are still tracked and shown, just not counted here.
  const bucket = (rows, key, countsAsWork) => rows.forEach(r => {
    if (username && username !== 'all' && r.username !== username) return;
    if (allowedUsernames && !allowedUsernames.has(r.username)) return;
    const h = getISTHour(r.created_at);
    if (isNaN(h)) return;
    hours[h][key]++;
    if (countsAsWork) hours[h].total++;
  });
  bucket(data.taskCreated, 'taskCreated', true);
  bucket(data.replies, 'replies', true);
  bucket(data.submissions, 'submissions', true);
  bucket(data.approvals, 'approvals', true);
  bucket(data.logins, 'logins', false);
  res.json(hours);
});

/* ============ PERFORMANCE / COMPLETION REPORT ============
   Objective counts only — how many of an employee's tagged parts were approved as done, over
   the last 7 / 30 / 365 days and all-time. Deliberately not a subjective score or letter grade;
   just the numbers, for whoever's reviewing (Admin) to interpret. */
function computeUserCounts(rows, dateField) {
  const now = Date.now();
  const DAY_MS = 86400000;
  const stats = {};
  db.listUsers().forEach(u => { stats[u.username] = { username: u.username, name: u.name, team: u.team, week: 0, month: 0, quarter: 0, year: 0, allTime: 0 }; });
  rows.forEach(r => {
    if (!stats[r.username]) return;
    const ageDays = (now - new Date(r[dateField]).getTime()) / DAY_MS;
    stats[r.username].allTime++;
    if (ageDays <= 7) stats[r.username].week++;
    if (ageDays <= 30) stats[r.username].month++;
    if (ageDays <= 90) stats[r.username].quarter++;
    if (ageDays <= 365) stats[r.username].year++;
  });
  return Object.values(stats).sort((a, b) => b.month - a.month || b.week - a.week);
}
app.get('/api/reports/completion', auth(['admin', 'director']), (req, res) => {
  const stats = computeUserCounts(db.getApprovedCompletions(), 'submitted_at');
  if (req.user.role === 'admin') return res.json(stats);
  const allowed = directorAllowedTeams(db.getUser(req.user.username));
  res.json(stats.filter(s => allowed.has(s.team)));
});
// A transparent rating, not a black-box score — every number shown is a real, explainable
// component, and both halves are comparative against the COMPANY's own actual activity, not an
// arbitrary fixed target (so someone in a role with naturally fewer/slower tasks isn't punished
// against an unrealistic yardstick). Computed over the quarter (trailing 90 days), since that's
// a natural performance-review cadence. Nobody is scored below 0 or above 5, and anyone with no
// completed work this quarter simply gets "not enough data" rather than a punitive 0.
app.get('/api/reports/ratings', auth(['admin', 'director']), (req, res) => {
  const completionStats = computeUserCounts(db.getApprovedCompletions(), 'submitted_at');
  const activeThisQuarter = completionStats.filter(s => s.quarter > 0);
  const companyAvgQuarterCompletions = activeThisQuarter.length > 0
    ? activeThisQuarter.reduce((sum, s) => sum + s.quarter, 0) / activeThisQuarter.length : 0;
  const responseTimesByUser = {};
  db.listUsers().forEach(u => { responseTimesByUser[u.username] = db.getMyResponseDurations(u.username); });
  const allResponseTimes = Object.values(responseTimesByUser).flat();
  const companyAvgResponseDays = allResponseTimes.length > 0 ? allResponseTimes.reduce((a, b) => a + b, 0) / allResponseTimes.length : null;
  const warningCounts = db.getWarningCountsByUser();

  let ratings = completionStats.map(s => {
    const myResponseTimes = responseTimesByUser[s.username] || [];
    const myAvgResponse = myResponseTimes.length > 0 ? myResponseTimes.reduce((a, b) => a + b, 0) / myResponseTimes.length : null;
    if (s.quarter === 0) return { username: s.username, name: s.name, team: s.team, rating: null, volumeScore: null, timelinessScore: null, quarterCompletions: 0, avgResponseDays: myAvgResponse, warningCount: warningCounts[s.username] || 0 };
    const volumeScore = companyAvgQuarterCompletions > 0 ? Math.min(2.5, 2.5 * (s.quarter / companyAvgQuarterCompletions)) : 2.5;
    let timelinessScore = 1.25; // neutral half-credit if there's no comparable response-time data at all
    if (myAvgResponse !== null && companyAvgResponseDays !== null) {
      // At or faster than the company average gets full marks outright — this avoids a subtle
      // but real bug the previous ratio-based version had: dividing by an artificially-floored
      // denominator crushed the score toward zero for anyone who responded very fast (near
      // same-day), which is the exact opposite of what should happen. Only scale down when
      // genuinely slower than average, where the ratio is well-behaved either way.
      timelinessScore = myAvgResponse <= companyAvgResponseDays ? 2.5 : Math.max(0, 2.5 * (companyAvgResponseDays / myAvgResponse));
    }
    const rating = Math.round((volumeScore + timelinessScore) * 10) / 10;
    return { username: s.username, name: s.name, team: s.team, rating, volumeScore: Math.round(volumeScore * 10) / 10, timelinessScore: Math.round(timelinessScore * 10) / 10, quarterCompletions: s.quarter, avgResponseDays: myAvgResponse, warningCount: warningCounts[s.username] || 0 };
  });
  if (req.user.role !== 'admin') {
    const allowed = directorAllowedTeams(db.getUser(req.user.username));
    ratings = ratings.filter(r => allowed.has(r.team));
  }
  res.json({ ratings, companyAvgQuarterCompletions: Math.round(companyAvgQuarterCompletions * 10) / 10, companyAvgResponseDays: companyAvgResponseDays !== null ? Math.round(companyAvgResponseDays * 10) / 10 : null });
});

// Self-scoped only — always uses the logged-in person's own username, never an admin-chosen
// target, so this can be open to every role without leaking anyone else's numbers. Real,
// computed statistics from this person's own history — not a trained model, just honest counts
// and averages, which is a better fit for a small self-hosted app than a fake "ML" label would be.
// A company-wide, bird's-eye personnel overview — genuinely distinct from my-dashboard below,
// which only ever shows one person (or the whole company summed together) at a time. This
// shows every employee side by side with their real completion count and real warning count, so
// HR/Admin can spot who's been flagged without drilling into each person one at a time.
app.get('/api/reports/hr-roster', auth(ALL_ROLES), (req, res) => {
  const actingUser = db.getUser(req.user.username);
  const isHR = actingUser && isHRTeam(actingUser.team);
  if (!(req.user.role === 'admin' || isHR)) return res.status(403).json({ error: 'Only HR Department members and Admin can view the roster.' });
  const completionAll = computeUserCounts(db.getApprovedCompletions(), 'submitted_at');
  const warningCounts = db.getWarningCountsByUser();
  // The roster is a personnel/employee overview, not a leadership dashboard — Admin and
  // Directors are never shown as entries in it, for anyone viewing it, Admin included.
  const roster = db.listUsers().filter(u => u.role !== 'admin' && u.role !== 'director').map(u => {
    const completion = completionAll.find(s => s.username === u.username) || { allTime: 0 };
    return {
      username: u.username, name: u.name, team: u.team, designation: u.designation,
      role: u.role, isTeamLead: !!u.is_team_lead, tasksCompleted: completion.allTime,
      warningCount: warningCounts[u.username] || 0,
    };
  });
  // Real organizational hierarchy, not alphabetical accident: grouped by department, and within
  // each department the Team Lead is listed first — e.g. Suraj (Estimation's actual lead)
  // correctly appears before Rohit (a regular Estimation team member), rather than "R" simply
  // sorting before "S". Anyone with no department goes last, since they're not part of any
  // department's hierarchy to begin with.
  roster.sort((a, b) => {
    if (!a.team && b.team) return 1;
    if (a.team && !b.team) return -1;
    if (a.team !== b.team) return (a.team || '').localeCompare(b.team || '');
    if (a.isTeamLead !== b.isTeamLead) return a.isTeamLead ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  // A REAL BUG FIX: the company-wide "tasks completed" total must count each TASK once, not
  // sum every person's own individual completion credit — a task with 2 assignees, both
  // approved, was previously being counted as "2 completed tasks" instead of 1. Each person's
  // own tasksCompleted figure above is still correct and unchanged (their own personal credit
  // for their own approved work) — only the company-wide aggregate was wrong.
  const totalTasksCompleted = db.listAllTasks().filter(t => t.status === 'closed').length;
  res.json({ roster, totalTasksCompleted });
});
app.get('/api/reports/my-dashboard', auth(ALL_ROLES), (req, res) => {
  // Self-scoped for everyone EXCEPT admin, who can pass ?username=X to view any individual's
  // dashboard too — the same real numbers that person sees themselves, not a separate view.
  // A non-admin can never see anyone's numbers but their own, no matter what they pass.
  const requestedUsername = str(req.query.username).trim();
  if (req.user.role === 'admin' && requestedUsername === 'all') {
    // Whole-company aggregate — sums across everyone, not one individual's numbers.
    const completionAll = computeUserCounts(db.getApprovedCompletions(), 'submitted_at');
    const approvalAll = computeUserCounts(db.getApprovalDecisionStats(), 'decided_at');
    const sumField = (rows, field) => rows.reduce((s, r) => s + r[field], 0);
    const completion = { week: sumField(completionAll, 'week'), month: sumField(completionAll, 'month'), year: sumField(completionAll, 'year'), allTime: sumField(completionAll, 'allTime') };
    const approval = { week: sumField(approvalAll, 'week'), month: sumField(approvalAll, 'month'), year: sumField(approvalAll, 'year'), allTime: sumField(approvalAll, 'allTime') };
    const allDurations = db.listUsers().flatMap(u => db.getMyResponseDurations(u.username));
    const avgResponseDays = allDurations.length > 0 ? allDurations.reduce((a, b) => a + b, 0) / allDurations.length : null;
    const allOpenTasks = db.listAllTasks().filter(t => t.status === 'open');
    let onHoldCount = 0, waitingOnOthersCount = 0, needsActionCount = 0;
    allOpenTasks.forEach(t => {
      const rows = db.listAssignees(t.id);
      rows.forEach(row => {
        if (!row.is_released) onHoldCount++;
        else if (row.decision === 'approve' && row.completed_at) waitingOnOthersCount++;
        else needsActionCount++;
      });
    });
    const data = db.getAllActivityTimestamps();
    const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, total: 0 }));
    ['taskCreated', 'replies', 'submissions', 'approvals'].forEach(key => {
      data[key].forEach(r => { const h = getISTHour(r.created_at); if (!isNaN(h)) hours[h].total++; });
    });
    return res.json({ username: 'all', completion, approval, avgResponseDays, sampleSize: allDurations.length, needsActionCount, onHoldCount, waitingOnOthersCount, peakHours: hours });
  }
  const actingUser = db.getUser(req.user.username);
  const isHR = actingUser && isHRTeam(actingUser.team);
  const canViewOthers = req.user.role === 'admin' || isHR;
  // The "all" sentinel is handled entirely by the admin-only whole-company branch above — for
  // anyone else (HR included), it must gracefully fall back to their own dashboard, the same
  // as if they'd requested nothing at all, rather than being treated as a literal username to
  // look up (which would incorrectly 404, since no account is actually named "all").
  const username = (canViewOthers && requestedUsername && requestedUsername !== 'all') ? requestedUsername : req.user.username;
  if (username !== req.user.username && !db.getUser(username)) return res.status(404).json({ error: 'User not found.' });
  const completionAll = computeUserCounts(db.getApprovedCompletions(), 'submitted_at');
  const approvalAll = computeUserCounts(db.getApprovalDecisionStats(), 'decided_at');
  const completion = completionAll.find(s => s.username === username) || { week: 0, month: 0, year: 0, allTime: 0 };
  const approval = approvalAll.find(s => s.username === username) || { week: 0, month: 0, year: 0, allTime: 0 };

  // Average response time: from being released to actually submitting — a fair "how quickly do
  // I typically act once I'm free to" metric, since it starts counting from release, not from
  // task creation (which could include time this person was on hold and unable to act at all).
  const responseDurations = db.getMyResponseDurations(username);
  const avgResponseDays = responseDurations.length > 0
    ? responseDurations.reduce((a, b) => a + b, 0) / responseDurations.length
    : null;

  const myOpenTasks = db.listTasksForUser(username).filter(t => t.status === 'open');
  const onHoldCount = myOpenTasks.filter(t => {
    const row = db.listAssignees(t.id).find(a => a.username === username);
    return row && !row.is_released;
  }).length;
  const waitingOnOthersCount = myOpenTasks.filter(t => {
    const row = db.listAssignees(t.id).find(a => a.username === username);
    return row && row.decision === 'approve' && row.completed_at;
  }).length;
  const needsActionCount = myOpenTasks.length - onHoldCount - waitingOnOthersCount;

  const data = db.getAllActivityTimestamps();
  const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, total: 0 }));
  // Same reasoning as the company-wide Peak Hours page: a login isn't work, so it's excluded
  // from this person's own "activity" total — only things they actually did count here.
  ['taskCreated', 'replies', 'submissions', 'approvals'].forEach(key => {
    data[key].forEach(r => {
      if (r.username !== username) return;
      const h = getISTHour(r.created_at);
      if (!isNaN(h)) hours[h].total++;
    });
  });

  res.json({ username, completion, approval, avgResponseDays, sampleSize: responseDurations.length, needsActionCount, onHoldCount, waitingOnOthersCount, peakHours: hours });
});

/* ============ TEAMS / DEPARTMENTS ============
   A real, addable list of department names (Site, Estimation, Purchase, etc.), separate from
   the free-text `team` column already on each user — existing free text still works untouched,
   this just gives Admin (and team leads adding their own people) a consistent list to pick from
   and grow, instead of everyone retyping department names from memory. */
app.get('/api/teams', auth(ALL_ROLES), (req, res) => res.json(db.listTeams()));
app.post('/api/teams', auth(['admin']), (req, res) => {
  const name = str((req.body || {}).name).trim();
  if (!name) return res.status(400).json({ error: 'Department name is required.' });
  if (name.length > 60) return res.status(400).json({ error: 'Department name is too long.' });
  db.addTeam(name);
  res.json({ ok: true, name });
});
// Never deletes any accounts — anyone in this department just has their Team field cleared,
// same as if it had never been set. Audit-logged since it affects every account in it at once.
app.delete('/api/teams/:name', auth(['admin']), (req, res) => {
  const name = str(req.params.name).trim();
  if (!db.listTeams().includes(name)) return res.status(404).json({ error: 'Department not found.' });
  const affected = db.listUsers().filter(u => u.team === name).length;
  db.removeTeam(name);
  auditFromReq(req, 'department_removed', `Removed department "${name}"${affected > 0 ? ` (unassigned ${affected} account${affected === 1 ? '' : 's'})` : ''}`);
  res.json({ ok: true, affected });
});

/* ============ SEND FOR APPROVAL (document approval requests) ============
   Different model from a regular task: the tagged people directly approve or reject the
   document itself — there's no "submit work" step, since they're deciding, not producing work.
   One rejection kills the request immediately (status: needs_revision); the creator uploads a
   revised document to the SAME request, which resets every reviewer back to pending. */
app.post('/api/approvals', auth(ALL_ROLES), (req, res) => {
  const title = str((req.body || {}).title).trim();
  const description = str((req.body || {}).description).trim();
  const fileName = str((req.body || {}).fileName).trim();
  const { fileData } = req.body || {};
  const rawReviewers = Array.isArray((req.body || {}).reviewers) ? (req.body || {}).reviewers : [];
  const reviewers = Array.from(new Set(rawReviewers.map(u => str(u).trim()).filter(Boolean)));
  if (!title) return res.status(400).json({ error: 'A title is required.' });
  if (tooLong(title, 200)) return res.status(400).json({ error: 'Title is too long (max 200 characters).' });
  if (tooLong(description, 5000)) return res.status(400).json({ error: 'Description is too long (max 5000 characters).' });
  if (reviewers.length === 0) return res.status(400).json({ error: 'Tag at least one person to approve this.' });
  if (!fileData) return res.status(400).json({ error: 'A document is required.' });
  for (const u of reviewers) { if (!db.getUser(u)) return res.status(400).json({ error: `Unknown user: ${u}` }); }
  const uploadError = validateUploadedFile(fileData, fileName, MAX_FILE_CHARS);
  if (uploadError) return res.status(400).json({ error: uploadError });
  const id = genId('APR');
  db.createApprovalRequest({ id, title, description, file_data: fileData, file_name: fileName, created_by_username: req.user.username, created_by_name: req.user.name, reviewers });
  reviewers.forEach(u => {
    if (u !== req.user.username) db.createNotification({ username: u, type: 'approval_requested', message: `${req.user.name} sent "${title}" for your approval.`, task_id: null });
  });
  res.json({ ok: true, id });
});
app.get('/api/approvals/mine', auth(ALL_ROLES), (req, res) => res.json(db.listApprovalRequestsForUser(req.user.username)));
app.get('/api/approvals', auth(['admin']), (req, res) => res.json(db.listAllApprovalRequests()));
app.get('/api/approvals/:id/attachment', auth(ALL_ROLES), (req, res) => {
  const request = db.getApprovalRequest(req.params.id);
  if (!request) return res.status(404).json({ error: 'Approval request not found.' });
  const isInvolved = request.created_by_username === req.user.username || req.user.role === 'admin' ||
    db.listReviewers(request.id).some(r => r.username === req.user.username);
  if (!isInvolved) return res.status(403).json({ error: "You're not involved in this approval request." });
  const row = db.getApprovalFile(req.params.id);
  if (!row || !row.file_data) return res.status(404).json({ error: 'No document on this request.' });
  res.json({ data: row.file_data, name: row.file_name });
});
app.post('/api/approvals/:id/decide', auth(ALL_ROLES), (req, res) => {
  const request = db.getApprovalRequest(req.params.id);
  if (!request) return res.status(404).json({ error: 'Approval request not found.' });
  if (request.status !== 'pending') return res.status(400).json({ error: 'This request is not awaiting a decision.' });
  const reviewers = db.listReviewers(request.id);
  const mine = reviewers.find(r => r.username === req.user.username);
  if (!mine) return res.status(403).json({ error: "You're not tagged as an approver on this request." });
  if (mine.decision) return res.status(400).json({ error: 'You already decided on this request.' });
  const decision = str((req.body || {}).decision);
  if (!['approved', 'rejected'].includes(decision)) return res.status(400).json({ error: 'Decision must be approved or rejected.' });
  const reason = str((req.body || {}).reason).trim();
  if (decision === 'rejected' && reason.length < 5) return res.status(400).json({ error: 'A reason (at least 5 characters) is required to reject.' });
  db.recordReviewerDecision(request.id, req.user.username, decision, reason);
  if (decision === 'rejected') {
    db.setApprovalRequestStatus(request.id, 'needs_revision', null);
    db.addApprovalHistory(request.id, req.user.username, req.user.name, `Rejected: ${reason}`);
    auditFromReq(req, 'approval_rejected', `Rejected "${request.title}": ${reason}`);
    if (request.created_by_username !== req.user.username) {
      db.createNotification({ username: request.created_by_username, type: 'approval_rejected', message: `${req.user.name} rejected "${request.title}": ${reason}`, task_id: null });
    }
    return res.json({ ok: true, status: 'needs_revision' });
  }
  db.addApprovalHistory(request.id, req.user.username, req.user.name, 'Approved');
  const stillPending = db.listReviewers(request.id).some(r => r.decision !== 'approved');
  if (!stillPending) {
    db.setApprovalRequestStatus(request.id, 'approved', new Date().toISOString());
    db.addApprovalHistory(request.id, null, null, 'Fully approved by everyone tagged');
    if (request.created_by_username !== req.user.username) {
      db.createNotification({ username: request.created_by_username, type: 'approval_approved', message: `"${request.title}" is fully approved.`, task_id: null });
    }
  }
  res.json({ ok: true, status: stillPending ? 'pending' : 'approved' });
});
app.post('/api/approvals/:id/revise', auth(ALL_ROLES), (req, res) => {
  const request = db.getApprovalRequest(req.params.id);
  if (!request) return res.status(404).json({ error: 'Approval request not found.' });
  if (request.created_by_username !== req.user.username && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only whoever sent this (or Admin) can upload a revision.' });
  }
  if (request.status !== 'needs_revision') return res.status(400).json({ error: 'This request is not awaiting a revision.' });
  const fileName = str((req.body || {}).fileName).trim();
  const { fileData } = req.body || {};
  if (!fileData) return res.status(400).json({ error: 'A revised document is required.' });
  const uploadError = validateUploadedFile(fileData, fileName, MAX_FILE_CHARS);
  if (uploadError) return res.status(400).json({ error: uploadError });
  db.reviseApprovalRequest(request.id, fileData, fileName);
  db.resetReviewersForRevision(request.id);
  db.addApprovalHistory(request.id, req.user.username, req.user.name, `Uploaded a revised document: ${fileName}`);
  db.listReviewers(request.id).forEach(r => {
    if (r.username !== req.user.username) db.createNotification({ username: r.username, type: 'approval_requested', message: `${req.user.name} sent a revised "${request.title}" for your approval.`, task_id: null });
  });
  res.json({ ok: true });
});
app.get('/api/reports/approvals', auth(['admin', 'director']), (req, res) => {
  const stats = computeUserCounts(db.getApprovalDecisionStats(), 'decided_at');
  if (req.user.role === 'admin') return res.json(stats);
  const allowed = directorAllowedTeams(db.getUser(req.user.username));
  res.json(stats.filter(s => allowed.has(s.team)));
});
// Every individual Approve/Reject decision, in full — who decided, what request, who asked
// (the creator), the decision itself, and the exact timestamp. Director-scoped the same way as
// the summary counts above.
app.get('/api/reports/approval-decisions', auth(['admin', 'director']), (req, res) => {
  let decisions = db.listApprovalDecisionsDetailed();
  if (req.user.role !== 'admin') {
    const allowed = directorAllowedTeams(db.getUser(req.user.username));
    const teamByUsername = {};
    db.listUsers().forEach(u => { teamByUsername[u.username] = u.team; });
    decisions = decisions.filter(d => allowed.has(teamByUsername[d.reviewer_username]));
  }
  res.json(decisions);
});

/* ============ PROJECTS & DRAWING LIBRARY ============
   Projects are a lightweight, addable list of names (same pattern as teams/departments) — not a
   full project-management module. Drawings are filed against a project and can be fetched and
   downloaded by anyone who knows the project name. Anyone authenticated can upload or download
   — this is an internal single-company tool, same trust model as the rest of the app. */
app.get('/api/projects', auth(ALL_ROLES), (req, res) => res.json(db.listProjects()));
app.post('/api/projects', auth(ALL_ROLES), (req, res) => {
  const name = str((req.body || {}).name).trim();
  if (!name) return res.status(400).json({ error: 'Project name is required.' });
  if (name.length > 80) return res.status(400).json({ error: 'Project name is too long.' });
  db.addProject(name);
  res.json({ ok: true, name });
});
app.get('/api/drawing-sections', auth(ALL_ROLES), (req, res) => res.json(db.listSections()));
app.get('/api/task-phases', auth(ALL_ROLES), (req, res) => res.json(db.listPhases()));
app.get('/api/drawings', auth(ALL_ROLES), (req, res) => {
  const project = str(req.query.project).trim();
  if (!project) return res.status(400).json({ error: 'A project name is required.' });
  res.json(db.listDrawingsForProject(project));
});
app.post('/api/drawings', auth(ALL_ROLES), (req, res) => {
  // Upload restricted to Admin ("Director") or Design team — fetching/downloading stays open
  // to everyone. Anyone else trying to upload gets a clear reason why.
  const actingUser = db.getUser(req.user.username);
  const isDesignTeam = actingUser && (actingUser.team || '').toLowerCase().includes('design');
  if (!(req.user.role === 'admin' || isDesignTeam)) {
    return res.status(403).json({ error: 'Only Admin or Design team members can upload drawings.' });
  }
  const project = str((req.body || {}).project).trim();
  const section = str((req.body || {}).section).trim();
  const title = str((req.body || {}).title).trim();
  const fileName = str((req.body || {}).fileName).trim();
  const { fileData } = req.body || {};
  if (!project) return res.status(400).json({ error: 'A project name is required.' });
  if (!fileData) return res.status(400).json({ error: 'A file is required.' });
  if (tooLong(project, 80)) return res.status(400).json({ error: 'Project name is too long.' });
  if (tooLong(section, 60)) return res.status(400).json({ error: 'Section name is too long.' });
  if (tooLong(title, 200)) return res.status(400).json({ error: 'Title is too long (max 200 characters).' });
  const uploadError = validateUploadedFile(fileData, fileName, MAX_DRAWING_FILE_CHARS);
  if (uploadError) return res.status(400).json({ error: uploadError });
  const id = db.addDrawing({ project, section, title, file_name: fileName, file_data: fileData, uploaded_by_username: req.user.username, uploaded_by_name: req.user.name });
  res.json({ ok: true, id });
});
app.get('/api/drawings/:id/download', auth(ALL_ROLES), (req, res) => {
  const row = db.getDrawingFile(req.params.id);
  if (!row || !row.file_data) return res.status(404).json({ error: 'Drawing not found.' });
  res.json({ data: row.file_data, name: row.file_name });
});
app.delete('/api/drawings/:id', auth(ALL_ROLES), (req, res) => {
  const meta = db.getDrawingMeta(req.params.id);
  if (!meta) return res.status(404).json({ error: 'Drawing not found.' });
  if (!(req.user.role === 'admin' || meta.uploaded_by_username === req.user.username)) {
    return res.status(403).json({ error: 'Only whoever uploaded this drawing (or Admin) can remove it.' });
  }
  db.deleteDrawing(req.params.id);
  auditFromReq(req, 'drawing_removed', `Removed drawing #${req.params.id} from project "${meta.project}"`);
  res.json({ ok: true });
});

// Delegated account creation: a team lead can add a new member to THEIR OWN team without
// needing Admin — mirrors how Mihir Store Management lets a team lead/head add their own
// people. A non-admin lead can only create plain "member" accounts within their own team;
// only Admin can create another Admin, or place someone outside the acting lead's team.
app.post('/api/team/members', auth(ALL_ROLES), (req, res) => {
  const actingUser = db.getUser(req.user.username);
  const isLeadOrAdmin = actingUser && (actingUser.role === 'admin' || actingUser.is_team_lead);
  if (!isLeadOrAdmin) return res.status(403).json({ error: 'Only Admin or a team lead can add team members.' });
  const username = str((req.body || {}).username).trim();
  const password = str((req.body || {}).password);
  const name = str((req.body || {}).name).trim();
  const isAdmin = actingUser.role === 'admin';
  const team = isAdmin ? (str((req.body || {}).team).trim() || null) : actingUser.team;
  if (!isAdmin && !team) return res.status(400).json({ error: "You're not assigned to a team yet — ask Admin to assign you one first." });
  const requestedRole = str((req.body || {}).role).trim();
  const role = isAdmin && ALL_ROLES.includes(requestedRole) ? requestedRole : 'member';
  if (!/^[a-zA-Z0-9._-]{3,40}$/.test(username)) return res.status(400).json({ error: 'Username must be 3-40 characters: letters, numbers, dots, underscores, or hyphens only.' });
  const pwErr2 = validatePasswordStrength(password); if (pwErr2) return res.status(400).json({ error: pwErr2 });
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  if (db.getUser(username)) return res.status(409).json({ error: 'That username is already taken.' });
  db.createUser({ username, password_hash: bcrypt.hashSync(password, 10), role, name, team, must_change_password: true });
  res.json({ ok: true, username });
});

/* ============ TASKS ============
   Anyone can create a task and tag one or more people on it. A task closes only once everyone
   tagged has completed their part — OR whoever created it (plus Admin, as the one retained
   override) force-closes it early. */
app.post('/api/tasks', auth(ALL_ROLES), (req, res) => {
  const title = str((req.body || {}).title).trim();
  const description = str((req.body || {}).description).trim();
  const priority = ['high', 'medium', 'low'].includes(str((req.body || {}).priority)) ? str((req.body || {}).priority) : 'medium';
  const deadline = str((req.body || {}).deadline).trim();
  const dependsOnTaskId = str((req.body || {}).dependsOnTaskId).trim();
  const parentTaskId = str((req.body || {}).parentTaskId).trim();
  const project = str((req.body || {}).project).trim();
  const phase = str((req.body || {}).phase).trim();
  const { attachment } = req.body || {};
  const attachmentName = str((req.body || {}).attachmentName).trim();
  // "Ask for Drawing" tasks allow a much larger attachment — CAD/drawing files routinely exceed
  // the normal 20MB task-attachment limit. Every other task still uses MAX_FILE_CHARS.
  const isDrawingRequest = !!(req.body || {}).isDrawingRequest;
  const fileLimit = isDrawingRequest ? MAX_DRAWING_FILE_CHARS : MAX_FILE_CHARS;
  const autoReleaseStages = !!(req.body || {}).autoReleaseStages;
  // Stages: an ordered list of groups, e.g. [{usernames:[...]}, {usernames:[...]}]. Stage 1 (the
  // first group) starts released; every later stage starts on hold until the stage before it is
  // fully approved. Most tasks won't use this — if the request sends the older flat
  // assignedToList instead, everyone is simply treated as one released stage, unchanged from
  // before staging existed.
  const rawStages = Array.isArray((req.body || {}).stages) ? (req.body || {}).stages : null;
  const rawList = Array.isArray((req.body || {}).assignedToList) ? (req.body || {}).assignedToList : [(req.body || {}).assignedTo];
  const stageGroups = rawStages && rawStages.length > 0
    ? rawStages.map(s => Array.from(new Set((Array.isArray(s.usernames) ? s.usernames : []).map(u => str(u).trim()).filter(Boolean)))).filter(g => g.length > 0)
    : [Array.from(new Set(rawList.map(u => str(u).trim()).filter(Boolean)))];
  const usernames = Array.from(new Set(stageGroups.flat()));
  // Optional per-person deadline, e.g. { "bob": "2026-09-01" } — falls back to the overall task
  // deadline for anyone not listed here. Used by deadline reminders and the Reports delay flag
  // instead of the shared task deadline, so Admin still only ever sees one deadline on the task
  // itself while each person's own warnings/performance are judged against their own date.
  const rawIndividualDeadlines = (req.body || {}).individualDeadlines;
  const individualDeadlines = {};
  if (rawIndividualDeadlines && typeof rawIndividualDeadlines === 'object') {
    for (const [uname, d] of Object.entries(rawIndividualDeadlines)) {
      const cleaned = str(d).trim();
      if (!cleaned) continue;
      if (!parseDeadline(cleaned)) return res.status(400).json({ error: `"${uname}"'s individual deadline is not a valid date.` });
      individualDeadlines[uname] = cleaned;
    }
  }
  if (!title || usernames.length === 0) return res.status(400).json({ error: 'Title and at least one tagged person are required.' });
  if (!deadline) return res.status(400).json({ error: 'A deadline is required.' });
  if (!parseDeadline(deadline)) return res.status(400).json({ error: 'Deadline is not a valid date.' });
  if (tooLong(title, 200)) return res.status(400).json({ error: 'Title is too long (max 200 characters).' });
  if (tooLong(description, 5000)) return res.status(400).json({ error: 'Description is too long (max 5000 characters).' });
  if (attachment) {
    const uploadError = validateUploadedFile(attachment, attachmentName, fileLimit);
    if (uploadError) return res.status(400).json({ error: uploadError });
  }
  if (dependsOnTaskId && !db.getTask(dependsOnTaskId)) return res.status(400).json({ error: 'The task this depends on was not found.' });
  let parentTask = null;
  if (parentTaskId) {
    parentTask = db.getTask(parentTaskId);
    if (!parentTask) return res.status(400).json({ error: 'The parent task was not found.' });
    if (parentTask.status !== 'open') return res.status(400).json({ error: 'Cannot add a subtask to a task that is already closed or cancelled.' });
  }
  // Defensive cycle guard: this is structurally unreachable today — a new task's ID doesn't
  // exist yet when the dependency dropdown is built, and dependsOnTaskId is fixed at creation
  // and never editable afterward, so every dependency edge can only ever point from a newer
  // task to an already-existing older one. That makes a genuine cycle mathematically impossible
  // under the current design. This check stays in anyway as a safety net for if dependencies
  // are ever made editable later, walking the chain with a hard depth limit so a corrupt chain
  // can never cause an infinite loop.
  if (dependsOnTaskId) {
    let cursor = dependsOnTaskId, depth = 0;
    while (cursor && depth < 500) {
      const cursorTask = db.getTask(cursor);
      if (!cursorTask || !cursorTask.depends_on_task_id) break;
      cursor = cursorTask.depends_on_task_id;
      depth++;
    }
    if (depth >= 500) return res.status(400).json({ error: 'Dependency chain is too long or corrupted.' });
  }
  const usersByUsername = {};
  for (const u of usernames) {
    const user = db.getUser(u);
    if (!user) return res.status(400).json({ error: `Unknown user: ${u}` });
    usersByUsername[u] = user;
  }
  const id = genId('TASK');
  // Wrapped in a transaction: the task row, every assignee row, and every assignment
  // notification either all commit together or none do — a mid-loop failure (e.g. a database
  // error on one insert) can no longer leave a task half-created with some assignees tagged and
  // others silently missing.
  db.runInTransaction(() => {
    db.createTask({
      id, title, description, priority, deadline, created_by: req.user.name, created_by_username: req.user.username,
      depends_on_task_id: dependsOnTaskId || null, attachment, attachment_name: attachmentName, is_drawing_request: isDrawingRequest,
      parent_task_id: parentTaskId || null, project: project || null, phase: phase || null,
    });
    if (stageGroups.length > 1) db.setAutoReleaseStages(id, autoReleaseStages);
    stageGroups.forEach((group, idx) => {
      const stageNum = idx + 1;
      const isReleased = stageNum === 1;
      group.forEach(uname => {
        const u = usersByUsername[uname];
        db.addTaskAssignee(id, u.username, u.team, stageNum, isReleased, individualDeadlines[u.username]);
        if (u.username === req.user.username) return;
        const message = isReleased
          ? `${req.user.name} tagged you on "${title}".`
          : `${req.user.name} tagged you on "${title}" — you're on hold for now until Level ${stageNum - 1} finishes their part.`;
        db.createNotification({ username: u.username, type: 'task_assigned', message, task_id: id });
      });
    });
  });
  // Tell the prerequisite task's creator and assignees that something new now depends on it —
  // clears up "does picking this send a notification?": yes, but only to the task it depends
  // on, not to anyone on the new task itself.
  if (dependsOnTaskId) {
    const prereq = db.getTask(dependsOnTaskId);
    if (prereq) {
      const notifyTargets = new Set([prereq.created_by_username, ...db.listAssignees(dependsOnTaskId).map(a => a.username)]);
      notifyTargets.forEach(username => {
        if (username && username !== req.user.username) {
          db.createNotification({ username, type: 'task_assigned', message: `"${title}" now depends on "${prereq.title}" finishing first.`, task_id: dependsOnTaskId });
        }
      });
    }
  }
  if (parentTask) {
    const notifyTargets = new Set([parentTask.created_by_username, ...db.listAssignees(parentTaskId).map(a => a.username)]);
    notifyTargets.forEach(username => {
      if (username && username !== req.user.username) {
        db.createNotification({ username, type: 'task_assigned', message: `"${title}" was added as a subtask of "${parentTask.title}" — it must be closed before the main task can close.`, task_id: id });
      }
    });
  }
  res.json({ ok: true, id });
});
app.get('/api/tasks', auth(['admin']), (req, res) => res.json(db.listAllTasks().map(t => db.getTaskFullLight(t.id))));
// Minimal open-task list (id + title only, no other details) so EVERY user — not just Admin —
// can pick a company-wide "Depends On" task, since a dependency very often belongs to a
// different team than the one creating the new task. Previously this used each user's own
// task list, so anyone who wasn't Admin almost always saw an empty dropdown.
app.get('/api/tasks/open-titles', auth(ALL_ROLES), (req, res) => {
  // Includes deadline in the payload so the dropdown can disambiguate tasks that share the same
  // title — e.g. every unedited "Ask for Drawing" task defaults to the literal title "Drawing
  // Request," which made the list look like it only ever showed one confusing repeated entry.
  res.json(db.listAllTasks().filter(t => t.status === 'open').map(t => ({ id: t.id, title: t.title, deadline: t.deadline })));
});
app.get('/api/tasks/mine', auth(ALL_ROLES), (req, res) => res.json(db.listTasksForUser(req.user.username).map(t => db.getTaskFullLight(t.id))));
app.get('/api/tasks/:id', auth(ALL_ROLES), (req, res) => {
  const task = db.getTaskFull(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  res.json(task);
});
app.get('/api/tasks/:id/attachment', auth(ALL_ROLES), (req, res) => {
  const task = db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  if (!isInvolvedInTask(req.user, task)) return res.status(403).json({ error: "You're not involved in this task." });
  const row = db.getTaskAttachment(task.id);
  if (!row || !row.attachment) return res.status(404).json({ error: 'No attachment on this task.' });
  res.json({ data: row.attachment, name: row.attachment_name });
});
app.get('/api/tasks/:id/replies/:replyId/attachment', auth(ALL_ROLES), (req, res) => {
  const task = db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  if (!isInvolvedInTask(req.user, task)) return res.status(403).json({ error: "You're not involved in this task." });
  const row = db.getReplyAttachment(req.params.replyId);
  if (!row || row.task_id !== req.params.id || !row.attachment) return res.status(404).json({ error: 'No attachment on this reply.' });
  res.json({ data: row.attachment, name: row.attachment_name });
});
app.post('/api/tasks/:id/reply', auth(ALL_ROLES), (req, res) => {
  const task = db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  if (!isInvolvedInTask(req.user, task)) return res.status(403).json({ error: "You're not involved in this task, so you can't comment on it." });
  const message = str((req.body || {}).message).trim();
  const { attachment } = req.body || {};
  const attachmentName = str((req.body || {}).attachmentName).trim();
  if (!message && !attachment) return res.status(400).json({ error: 'A message or attachment is required.' });
  if (tooLong(message, 5000)) return res.status(400).json({ error: 'Message is too long (max 5000 characters).' });
  // A task originally flagged as a drawing request (or later marked one via "Ask for Drawing"
  // on an existing task) keeps the larger CAD file-size allowance for every reply too — not
  // just its very first attachment. Otherwise a 100MB drawing could be requested, but a
  // follow-up drawing reply would still be capped at the normal 20MB.
  const fileLimit = task.is_drawing_request ? MAX_DRAWING_FILE_CHARS : MAX_FILE_CHARS;
  if (attachment) {
    const uploadError = validateUploadedFile(attachment, attachmentName, fileLimit);
    if (uploadError) return res.status(400).json({ error: uploadError });
  }
  db.addReply(task.id, { by_username: req.user.username, by_name: req.user.name, message, attachment, attachment_name: attachmentName });
  // Notify both primary assignees AND anyone tagged for follow-up — follow-up people asked to
  // "keep an eye on this" should hear about replies just like assignees do.
  const notifyTargets = new Set([
    ...db.listAssignees(task.id).map(a => a.username),
    ...db.listFollowups(task.id).map(f => f.username),
  ]);
  notifyTargets.forEach(u => {
    if (u !== req.user.username) db.createNotification({ username: u, type: 'task_reply', message: `${req.user.name} replied on "${task.title}".`, task_id: task.id });
  });
  // @mentions in the comment text: anyone @mentioned who exists as a real account gets notified
  // too, even if they weren't already an assignee or follow-up person — a distinct message so
  // it's clear they were specifically called out, not just part of the general reply notice.
  const mentionedUsernames = new Set();
  const mentionMatches = message.matchAll(/@([a-zA-Z0-9._-]{3,40})/g);
  for (const m of mentionMatches) { if (db.getUser(m[1])) mentionedUsernames.add(m[1]); }
  mentionedUsernames.forEach(u => {
    if (u !== req.user.username && !notifyTargets.has(u)) {
      db.createNotification({ username: u, type: 'mentioned_in_comment', message: `${req.user.name} mentioned you in a comment on "${task.title}".`, task_id: task.id });
    }
  });
  res.json({ ok: true });
});

// Follow-up tagging: a lighter-weight tag than being a primary assignee — anyone already
// involved (an assignee, an existing follow-up person, the creator, or Admin) can tag more
// people to keep an eye on a task. Follow-up people get notified of activity and can
// comment/attach files, but are never part of the "everyone must complete their part" count
// and never get a close button.
// "Ask for Drawing" on an EXISTING task (not just at creation): tags Design Team + Admin onto
// this task as regular assignees (so it now also needs their sign-off to fully close) and
// flags it as a drawing request so every future reply on it gets the larger CAD file-size
// allowance too. Restricted to people already involved, same reasoning as follow-up tagging.
app.post('/api/tasks/:id/ask-for-drawing', auth(ALL_ROLES), (req, res) => {
  const task = db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  if (task.status !== 'open') return res.status(400).json({ error: 'Task is not open.' });
  const isAssignee = db.listAssignees(task.id).some(a => a.username === req.user.username);
  const isCreator = task.created_by_username === req.user.username;
  if (!(isAssignee || isCreator || req.user.role === 'admin')) {
    return res.status(403).json({ error: "You're not involved in this task yet, so you can't request a drawing on it." });
  }
  const designTeamUsers = db.listUsers().filter(u => (u.team || '').toLowerCase().includes('design'));
  const adminUsers = db.listUsers().filter(u => u.role === 'admin');
  const targets = [...designTeamUsers, ...adminUsers];
  if (targets.length === 0) return res.status(400).json({ error: 'No Design team members or Admin accounts exist yet to tag.' });
  db.markAsDrawingRequest(task.id);
  targets.forEach(u => {
    db.addTaskAssignee(task.id, u.username, u.team);
    if (u.username !== req.user.username) {
      db.createNotification({ username: u.username, type: 'task_assigned', message: `${req.user.name} asked for a drawing on "${task.title}" and tagged you.`, task_id: task.id });
    }
  });
  res.json({ ok: true });
});

// Add/remove tagged people on an EXISTING open task — creator/Admin only, since it's a change
// to who's accountable for the work, same authority level as approving or force-closing.
app.post('/api/tasks/:id/assignees', auth(ALL_ROLES), (req, res) => {
  const task = db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  if (task.status !== 'open') return res.status(400).json({ error: 'Task is not open.' });
  const isCreator = task.created_by_username && task.created_by_username === req.user.username;
  if (!(req.user.role === 'admin' || isCreator)) return res.status(403).json({ error: 'Only whoever created this task (or Admin) can add people to it.' });
  const rawList = Array.isArray((req.body || {}).usernames) ? req.body.usernames : [];
  const usernames = Array.from(new Set(rawList.map(u => str(u).trim()).filter(Boolean)));
  if (usernames.length === 0) return res.status(400).json({ error: 'Select at least one person to add.' });
  const existing = new Set(db.listAssignees(task.id).map(a => a.username));
  let added = 0;
  usernames.forEach(u => {
    const user = db.getUser(u);
    if (!user || existing.has(u)) return;
    db.addTaskAssignee(task.id, u, user.team);
    added++;
    db.createNotification({ username: u, type: 'task_assigned', message: `${req.user.name} tagged you on "${task.title}".`, task_id: task.id });
  });
  res.json({ ok: true, added });
});
// Sets or clears one person's individual deadline on an existing task — creator/Admin only,
// same authority level as adding people to a task in the first place.
app.post('/api/tasks/:id/assignees/:username/deadline', auth(ALL_ROLES), (req, res) => {
  const task = db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  const isCreator = task.created_by_username && task.created_by_username === req.user.username;
  if (!(req.user.role === 'admin' || isCreator)) return res.status(403).json({ error: 'Only whoever created this task (or Admin) can set an individual deadline.' });
  const assignees = db.listAssignees(task.id);
  if (!assignees.some(a => a.username === req.params.username)) return res.status(404).json({ error: 'That person is not tagged on this task.' });
  const deadline = str((req.body || {}).deadline).trim();
  if (deadline && !parseDeadline(deadline)) return res.status(400).json({ error: 'Not a valid date.' });
  db.setIndividualDeadline(task.id, req.params.username, deadline || null);
  res.json({ ok: true });
});
app.delete('/api/tasks/:id/assignees/:username', auth(ALL_ROLES), (req, res) => {
  const task = db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  if (task.status !== 'open') return res.status(400).json({ error: 'Task is not open.' });
  const isCreator = task.created_by_username && task.created_by_username === req.user.username;
  if (!(req.user.role === 'admin' || isCreator)) return res.status(403).json({ error: 'Only whoever created this task (or Admin) can remove people from it.' });
  const assignees = db.listAssignees(task.id);
  const target = assignees.find(a => a.username === req.params.username);
  if (!target) return res.status(404).json({ error: 'That person is not tagged on this task.' });
  if (target.submitted_at || target.completed_at) return res.status(400).json({ error: "Can't remove someone who has already submitted or been approved on this task — that's real recorded work and stays on record." });
  if (assignees.length <= 1) return res.status(400).json({ error: 'A task needs at least one tagged person — add someone else first.' });
  db.removeTaskAssignee(task.id, req.params.username);
  res.json({ ok: true });
});

app.post('/api/tasks/:id/followup', auth(ALL_ROLES), (req, res) => {
  const task = db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  const isAssignee = db.listAssignees(task.id).some(a => a.username === req.user.username);
  const isFollowup = db.listFollowups(task.id).some(f => f.username === req.user.username);
  const isCreator = task.created_by_username === req.user.username;
  if (!(isAssignee || isFollowup || isCreator || req.user.role === 'admin')) {
    return res.status(403).json({ error: "You're not involved in this task yet, so you can't tag others for follow-up on it." });
  }
  const rawList = Array.isArray((req.body || {}).usernames) ? req.body.usernames : [];
  const usernames = Array.from(new Set(rawList.map(u => str(u).trim()).filter(Boolean)));
  if (usernames.length === 0) return res.status(400).json({ error: 'Select at least one person to tag for follow-up.' });
  for (const u of usernames) { if (!db.getUser(u)) return res.status(400).json({ error: `Unknown user: ${u}` }); }
  usernames.forEach(u => {
    db.addFollowup(task.id, u, req.user.username);
    if (u !== req.user.username) {
      db.createNotification({ username: u, type: 'followup_tagged', message: `${req.user.name} asked you to follow up on "${task.title}".`, task_id: task.id });
    }
  });
  res.json({ ok: true });
});
// Submitting is a REQUEST, not completion — "Mark My Part Done" is gone. An assignee submits
// their part as ready; only the task's creator (or Admin) can actually approve it as done. This
// puts the whole authority to close a task in the creator's hands, exercised either by approving
// every tagged person's part one at a time (which auto-closes once all are approved) or by
// force-closing directly at any time.
app.post('/api/tasks/:id/submit-mine', auth(ALL_ROLES), (req, res) => {
  const task = db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  if (task.status !== 'open') return res.status(400).json({ error: 'Task is not open.' });
  const assignees = db.listAssignees(task.id);
  const mine = assignees.find(a => a.username === req.user.username);
  if (!mine) return res.status(403).json({ error: "You're not tagged on this task." });
  if (!mine.is_released) return res.status(400).json({ error: "You're on hold for now — wait to be released before submitting your part." });
  if (mine.decision === 'approve' && mine.completed_at) return res.status(400).json({ error: 'Your part is already approved.' });
  if (db.isTaskBlocked(task.id)) return res.status(400).json({ error: "This task depends on another task that isn't closed yet." });
  // A required note describing what was actually done — not a bare click — gives the creator
  // something concrete to check the work against, and discourages submitting to grab an early
  // credit on unfinished work. If the task has a checklist, every item must be checked off
  // first: a real, verifiable signal of progress that a note alone can't fake.
  const note = str((req.body || {}).note).trim();
  if (note.length < 5) return res.status(400).json({ error: 'Briefly describe what you completed (at least 5 characters) before submitting.' });
  const checklist = db.listChecklistItems(task.id);
  if (checklist.length > 0 && checklist.some(c => !c.is_checked)) {
    return res.status(400).json({ error: 'Check off every checklist item on this task before submitting your part.' });
  }
  db.markAssigneeSubmitted(task.id, req.user.username, note);
  if (task.created_by_username && task.created_by_username !== req.user.username) {
    db.createNotification({ username: task.created_by_username, type: 'task_submitted', message: `${req.user.name} submitted their part of "${task.title}" for your approval.`, task_id: task.id });
  }
  res.json({ ok: true });
});
// Approve/reject a specific tagged person's submitted work — restricted to whoever created the
// task, or Admin. Approving is the only thing that actually marks a part "done"; once every
// tagged person is approved, the task closes automatically.
app.post('/api/tasks/:id/approve/:username', auth(ALL_ROLES), (req, res) => {
  const task = db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  if (task.status !== 'open') return res.status(400).json({ error: 'Task is not open.' });
  const isCreator = task.created_by_username && task.created_by_username === req.user.username;
  if (!(req.user.role === 'admin' || isCreator)) return res.status(403).json({ error: 'Only whoever created this task (or Admin) can approve work on it.' });
  const assignees = db.listAssignees(task.id);
  const target = assignees.find(a => a.username === req.params.username);
  if (!target) return res.status(404).json({ error: 'That person is not tagged on this task.' });
  if (target.decision === 'approve' && target.completed_at) return res.status(400).json({ error: 'Already approved — nothing to do.' });
  if (!target.submitted_at) return res.status(400).json({ error: "That person hasn't submitted their part yet — nothing to approve." });
  db.markAssigneeDone(task.id, req.params.username, req.user.name, 'approve');
  if (req.params.username !== req.user.username) {
    db.createNotification({ username: req.params.username, type: 'task_reply', message: `${req.user.name} approved your part of "${task.title}".`, task_id: task.id });
  }
  // If this approval just completed the stage that person was in, and the creator opted into
  // auto-release for this task, immediately release the next stage (if one exists and isn't
  // already released) — otherwise the creator releases it manually whenever they're ready.
  const stageNum = target.stage || 1;
  if (task.auto_release_stages && db.isStageFullyApproved(task.id, stageNum) && db.hasStage(task.id, stageNum + 1) && !db.isStageReleased(task.id, stageNum + 1)) {
    db.releaseStage(task.id, stageNum + 1, req.user.name);
    db.listAssignees(task.id).filter(a => a.stage === stageNum + 1).forEach(a => {
      db.createNotification({ username: a.username, type: 'task_assigned', message: `You're released to start your part of "${task.title}".`, task_id: task.id });
    });
  }
  const stillOpen = db.listAssignees(task.id).some(a => !(a.decision === 'approve' && a.completed_at));
  if (!stillOpen) { db.closeTask(task.id, req.user.name); releaseDependentsOf(task); }
  res.json({ ok: true, taskClosed: !stillOpen });
});
// Manual stage release — creator/Admin only, for tasks that didn't opt into auto-release, or
// as an override any time. Only allowed once the stage before it is fully approved.
app.post('/api/tasks/:id/release-stage/:stageNum', auth(ALL_ROLES), (req, res) => {
  const task = db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  if (task.status !== 'open') return res.status(400).json({ error: 'Task is not open.' });
  const isCreator = task.created_by_username && task.created_by_username === req.user.username;
  if (!(req.user.role === 'admin' || isCreator)) return res.status(403).json({ error: 'Only whoever created this task (or Admin) can release a stage.' });
  const stageNum = parseInt(req.params.stageNum, 10);
  if (!db.hasStage(task.id, stageNum)) return res.status(404).json({ error: 'That stage does not exist on this task.' });
  if (stageNum > 1 && !db.isStageFullyApproved(task.id, stageNum - 1)) {
    return res.status(400).json({ error: `Level ${stageNum - 1} isn't fully approved yet.` });
  }
  if (db.isStageReleased(task.id, stageNum)) return res.status(400).json({ error: `Level ${stageNum} is already released.` });
  db.releaseStage(task.id, stageNum, req.user.name);
  db.listAssignees(task.id).filter(a => a.stage === stageNum).forEach(a => {
    db.createNotification({ username: a.username, type: 'task_assigned', message: `You're released to start your part of "${task.title}".`, task_id: task.id });
  });
  res.json({ ok: true });
});
app.post('/api/tasks/:id/reject/:username', auth(ALL_ROLES), (req, res) => {
  const task = db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  if (task.status !== 'open') return res.status(400).json({ error: 'Task is not open.' });
  const isCreator = task.created_by_username && task.created_by_username === req.user.username;
  if (!(req.user.role === 'admin' || isCreator)) return res.status(403).json({ error: 'Only whoever created this task (or Admin) can reject work on it.' });
  const assignees = db.listAssignees(task.id);
  const target = assignees.find(a => a.username === req.params.username);
  if (!target) return res.status(404).json({ error: 'That person is not tagged on this task.' });
  if (!target.submitted_at) return res.status(400).json({ error: "That person hasn't submitted anything yet — nothing to reject." });
  const reason = str((req.body || {}).reason).trim();
  if (reason.length < 5) return res.status(400).json({ error: 'A reason (at least 5 characters) is required so the person knows what to fix.' });
  db.resetAssigneeSubmission(task.id, req.params.username);
  db.addReply(task.id, { by_username: req.user.username, by_name: req.user.name, message: `Rejected ${req.params.username}'s submission: ${reason} — needs to be redone and resubmitted.` });
  if (req.params.username !== req.user.username) {
    db.createNotification({ username: req.params.username, type: 'task_reply', message: `${req.user.name} rejected your part of "${task.title}": ${reason} — please redo and resubmit.`, task_id: task.id });
  }
  res.json({ ok: true });
});
// Force-close: restricted to whoever created this specific task, plus Admin as the one
// retained override.
app.post('/api/tasks/:id/close', auth(ALL_ROLES), (req, res) => {
  const task = db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  if (task.status !== 'open') return res.status(400).json({ error: 'Task is not open.' });
  const isCreator = task.created_by_username && task.created_by_username === req.user.username;
  if (!(req.user.role === 'admin' || isCreator)) return res.status(403).json({ error: 'Only whoever created this task (or Admin) can force-close it.' });
  if (db.isTaskBlocked(task.id)) {
    const prereq = db.getTask(task.depends_on_task_id);
    return res.status(400).json({ error: `This task depends on "${prereq ? prereq.title : task.depends_on_task_id}", which isn't closed yet.` });
  }
  const openSubtasks = db.listOpenSubtasks(task.id);
  if (openSubtasks.length > 0) {
    return res.status(400).json({ error: `This task has ${openSubtasks.length} open subtask${openSubtasks.length === 1 ? '' : 's'} that must be closed first: ${openSubtasks.map(s => `"${s.title}"`).join(', ')}.` });
  }
  const stillOpenAssignees = db.listAssignees(task.id).filter(a => !(a.decision === 'approve' && a.completed_at));
  db.closeTask(task.id, req.user.name);
  releaseDependentsOf(task);
  if (stillOpenAssignees.length > 0) {
    auditFromReq(req, 'task_force_closed', `Force-closed "${task.title}" while ${stillOpenAssignees.map(a => a.username).join(', ')} had not yet been approved.`);
  }
  res.json({ ok: true });
});
// Cancel: distinct from closing — for a task that was created by mistake or is being
// abandoned, not one where the work got done. Same authority as force-close (creator or
// Admin), but requires a reason, and never counts toward anyone's completion stats since no
// approval ever happens on a cancelled task.
app.post('/api/tasks/:id/cancel', auth(ALL_ROLES), (req, res) => {
  const task = db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  if (task.status !== 'open') return res.status(400).json({ error: 'Task is not open.' });
  const isCreator = task.created_by_username && task.created_by_username === req.user.username;
  if (!(req.user.role === 'admin' || isCreator)) return res.status(403).json({ error: 'Only whoever created this task (or Admin) can cancel it.' });
  const reason = str((req.body || {}).reason).trim();
  if (reason.length < 5) return res.status(400).json({ error: 'A reason (at least 5 characters) is required to cancel a task.' });
  db.cancelTask(task.id, req.user.name, reason);
  releaseDependentsOf(task);
  auditFromReq(req, 'task_cancelled', `Cancelled "${task.title}": ${reason}`);
  const notifyTargets = new Set([
    ...db.listAssignees(task.id).map(a => a.username),
    ...db.listFollowups(task.id).map(f => f.username),
  ]);
  notifyTargets.forEach(u => {
    if (u !== req.user.username) db.createNotification({ username: u, type: 'task_closed', message: `${req.user.name} cancelled "${task.title}": ${reason}`, task_id: task.id });
  });
  res.json({ ok: true });
});
app.post('/api/tasks/:id/reopen', auth(ALL_ROLES), (req, res) => {
  const task = db.getTaskFull(req.params.id);
  if (!task || (task.status !== 'closed' && task.status !== 'cancelled')) return res.status(400).json({ error: 'Task is not closed or cancelled.' });
  // Reopening is creator/Admin authority only — same principle as closing itself: whoever
  // created the task (or Admin) is the one accountable for deciding it needs more work, not any
  // tagged assignee.
  const isCreator = task.created_by_username === req.user.username;
  if (!(isCreator || req.user.role === 'admin')) return res.status(403).json({ error: 'Only whoever created this task (or Admin) can reopen it.' });
  const reason = str((req.body || {}).reason).trim();
  if (reason.length < 5) return res.status(400).json({ error: 'A reason (at least 5 characters) is required to reopen a task.' });
  db.reopenTask(task.id);
  task.assignees.forEach(a => db.reopenAssignee(task.id, a.username));
  auditFromReq(req, 'task_reopened', `Reopened "${task.title}": ${reason}`);
  db.listAdminUsernames().forEach(a => {
    if (a !== req.user.username) db.createNotification({ username: a, type: 'task_reopened', message: `${req.user.name} reopened "${task.title}": ${reason}`, task_id: task.id });
  });
  res.json({ ok: true });
});
app.post('/api/tasks/:id/checklist', auth(ALL_ROLES), (req, res) => {
  const task = db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  const text = str((req.body || {}).text).trim();
  if (!text) return res.status(400).json({ error: 'Checklist item text is required.' });
  if (tooLong(text, 300)) return res.status(400).json({ error: 'Checklist item is too long (max 300 characters).' });
  const existing = db.listChecklistItems(task.id);
  db.addChecklistItem(task.id, text, existing.length);
  res.json({ ok: true });
});
app.post('/api/tasks/:id/checklist/:itemId/toggle', auth(ALL_ROLES), (req, res) => {
  const item = db.getChecklistItem(req.params.itemId);
  if (!item || item.task_id !== req.params.id) return res.status(404).json({ error: 'Checklist item not found.' });
  db.toggleChecklistItem(item.id, !item.is_checked);
  res.json({ ok: true });
});
app.delete('/api/tasks/:id/checklist/:itemId', auth(['admin']), (req, res) => {
  const item = db.getChecklistItem(req.params.itemId);
  if (!item || item.task_id !== req.params.id) return res.status(404).json({ error: 'Checklist item not found.' });
  db.deleteChecklistItem(item.id);
  res.json({ ok: true });
});

/* ============ NOTIFICATIONS ============ */
app.get('/api/notifications', auth(ALL_ROLES), (req, res) => {
  res.json({ items: db.listNotifications(req.user.username), unread: db.countUnreadNotifications(req.user.username) });
});
app.post('/api/notifications/:id/read', auth(ALL_ROLES), (req, res) => {
  db.markNotificationRead(req.params.id, req.user.username);
  res.json({ ok: true });
});
app.post('/api/notifications/read-all', auth(ALL_ROLES), (req, res) => {
  db.markAllNotificationsRead(req.user.username);
  res.json({ ok: true });
});

/* ============ REMINDERS ============
   Two independent layers:
     1. A plain daily nudge for anyone with an incomplete part on an open task, at most once
        every REMINDER_INTERVAL_HOURS.
     2. Escalating, one-time-each-stage reminders: 3 days (a differently-worded nudge to the
        assignee), 7 days (a WARNING to the assignee AND a separate notification to whoever
        created the task), 12 days (the same warning raised again to the creator). Plus a
        weekly digest to every Admin account ranking who has the most outstanding warnings. */
const REMINDER_INTERVAL_HOURS = 24;
function sendTaskReminders() {
  // Skip anyone whose task is currently blocked on a dependency, or who is on hold in a later
  // stage — they can't act on it yet, so reminding or warning them (or their creator) would be
  // blaming someone for a delay that isn't theirs.
  const rows = db.listIncompleteAssigneesForOpenTasks().filter(r => !db.isTaskBlocked(r.task_id) && r.is_released);
  let sent = 0;
  rows.forEach(r => {
    const hoursSinceLastReminder = r.last_reminded_at ? (Date.now() - new Date(r.last_reminded_at).getTime()) / 3600000 : Infinity;
    if (hoursSinceLastReminder >= REMINDER_INTERVAL_HOURS) {
      db.createNotification({ username: r.username, type: 'task_reminder', message: `Reminder — "${r.title}" is still open and waiting on your part.`, task_id: r.task_id });
      db.markTaskAssigneeReminded(r.task_id, r.username);
      sent++;
    }
  });
  return sent;
}
// .unref() on all four background timers below: they still fire exactly as before while the
// server is running (the HTTP listener itself keeps the process alive), but they no longer
// prevent the process from exiting once the server is actually stopped — without this, a
// graceful shutdown (or the test suite closing the server) would hang forever, since these
// intervals alone would keep Node's event loop open indefinitely.
setInterval(sendTaskReminders, REMINDER_INTERVAL_HOURS * 60 * 60 * 1000).unref();

const ESCALATION_CHECK_INTERVAL_HOURS = 1;
function sendEscalatingTaskReminders() {
  // Same reasoning as sendTaskReminders above — a blocked task's "age" clock keeps ticking in
  // the database (created_at doesn't change), but the person tagged on it has been unable to
  // act since the moment it became blocked, so escalating warnings about them specifically would
  // be punishing them for someone else's delay.
  const rows = db.listIncompleteAssigneesForEscalation().filter(r => !db.isTaskBlocked(r.task_id) && r.is_released);
  const msPerDay = 86400000;
  const adminUsernames = db.listAdminUsernames();
  let sent = 0;
  rows.forEach(r => {
    const ageDays = (Date.now() - new Date(r.escalation_baseline_at).getTime()) / msPerDay;
    const creatorUsername = r.created_by_username;
    const creatorDiffersFromAssignee = creatorUsername && creatorUsername !== r.username;
    // Day 3: a reminder to the person themselves — not yet a flag to anyone else.
    if (ageDays >= 3 && !r.reminder_3day_sent_at) {
      db.createNotification({ username: r.username, type: 'task_reminder_3day', message: `Still open after 3 days — your part of "${r.title}" needs finishing.`, task_id: r.task_id });
      db.markEscalationStage(r.task_id, r.username, 3);
      sent++;
    }
    // Day 5: first flag to Admin specifically — a distinct notification from the creator-facing
    // warnings below, so Admin sees late people even on tasks they didn't create themselves.
    if (ageDays >= 5 && !r.warning_5day_sent_at) {
      adminUsernames.forEach(a => {
        if (a !== r.username) db.createNotification({ username: a, type: 'admin_late_flag', message: `${r.username} has not completed their part of "${r.title}" in 5 days.`, task_id: r.task_id });
      });
      db.markEscalationStage(r.task_id, r.username, 5);
      sent++;
    }
    // Day 7: warn the person, notify the creator (existing), and flag Admin again.
    if (ageDays >= 7 && !r.warning_7day_sent_at) {
      db.createNotification({ username: r.username, type: 'task_warning', message: `Warning — "${r.title}" has been open 7 days with your part not done.`, task_id: r.task_id });
      if (creatorDiffersFromAssignee) {
        db.createNotification({ username: creatorUsername, type: 'task_warning_creator', message: `${r.username} has not completed their part of "${r.title}" in 7 days.`, task_id: r.task_id });
      }
      adminUsernames.forEach(a => {
        if (a !== r.username && a !== creatorUsername) db.createNotification({ username: a, type: 'admin_late_flag', message: `Still flagged — ${r.username} has not completed their part of "${r.title}" in 7 days.`, task_id: r.task_id });
      });
      db.markEscalationStage(r.task_id, r.username, 7);
      sent++;
    }
    // Day 12: notify the creator again (existing), and flag Admin a third time.
    if (ageDays >= 12 && !r.warning_12day_sent_at) {
      if (creatorDiffersFromAssignee) {
        db.createNotification({ username: creatorUsername, type: 'task_warning_creator', message: `Still not done — ${r.username} has now not completed their part of "${r.title}" in 12 days.`, task_id: r.task_id });
      }
      adminUsernames.forEach(a => {
        if (a !== r.username && a !== creatorUsername) db.createNotification({ username: a, type: 'admin_late_flag', message: `Still flagged — ${r.username} has not completed their part of "${r.title}" in 12 days.`, task_id: r.task_id });
      });
      db.markEscalationStage(r.task_id, r.username, 12);
      sent++;
    }
  });
  return sent;
}
setInterval(sendEscalatingTaskReminders, ESCALATION_CHECK_INTERVAL_HOURS * 60 * 60 * 1000).unref();

// Deadline-based reminders — counting DOWN to a future deadline, the way a calendar app
// reminds you before an event starts, rather than counting UP from creation date. Two nudges
// per task: once when it's within 24 hours of its deadline, and once if the deadline passes
// while it's still open.
function sendDeadlineReminders() {
  const now = new Date();
  let sent = 0;
  // Task-level: notify the creator once when the OVERALL task deadline passes — Admin/creator
  // cares about the task as a whole, not each tagged person's own individual deadline.
  const tasks = db.listOpenTasksWithDeadlines();
  tasks.forEach(t => {
    const deadlineDate = parseDeadline(t.deadline);
    if (!deadlineDate) return;
    if (db.isTaskBlocked(t.id)) return; // blocked tasks stay exempt from all reminder types
    if (!t.deadline_overdue_notified && deadlineDate <= now) {
      if (t.created_by_username) db.createNotification({ username: t.created_by_username, type: 'deadline_passed', message: `"${t.title}" has passed its deadline and is still open.`, task_id: t.id });
      db.markDeadlineOverdueNotified(t.id);
      sent++;
    }
  });
  // Per-person: each assignee's OWN effective deadline (their individual one if set, else the
  // task's overall deadline) drives their own "due soon"/"passed" notifications. For anyone
  // without an individual deadline, this produces exactly the same result as before — the
  // fallback IS the task deadline, so nothing changes for tasks that never used this feature.
  const rows = db.listIncompleteAssigneesForDeadlineCheck().filter(r => r.is_released && !db.isTaskBlocked(r.task_id));
  rows.forEach(r => {
    const effectiveDeadlineStr = r.individual_deadline || r.task_deadline;
    if (!effectiveDeadlineStr) return;
    const deadlineDate = parseDeadline(effectiveDeadlineStr);
    if (!deadlineDate) return;
    if (!r.deadline_reminder_sent_at && deadlineDate > now && (deadlineDate.getTime() - now.getTime()) <= 24 * 3600000) {
      db.createNotification({ username: r.username, type: 'deadline_soon', message: `"${r.title}" is due soon (${effectiveDeadlineStr}).`, task_id: r.task_id });
      db.markAssigneeDeadlineReminderSent(r.task_id, r.username);
      sent++;
    }
    if (!r.deadline_overdue_notified_at && deadlineDate <= now) {
      const whoseDeadline = r.individual_deadline ? 'your individual deadline' : 'its deadline';
      db.createNotification({ username: r.username, type: 'deadline_passed', message: `"${r.title}" has passed ${whoseDeadline} and is still open.`, task_id: r.task_id });
      db.markAssigneeDeadlineOverdueNotified(r.task_id, r.username);
      sent++;
    }
  });
  return sent;
}
setInterval(sendDeadlineReminders, ESCALATION_CHECK_INTERVAL_HOURS * 60 * 60 * 1000).unref();

const WEEKLY_DIGEST_INTERVAL_HOURS = 24 * 7;
function sendWeeklyWarningDigestToAdmin() {
  const rows = db.listOutstandingTaskWarnings();
  if (rows.length === 0) return 0;
  const byUser = {};
  rows.forEach(r => { if (!byUser[r.username]) byUser[r.username] = 0; byUser[r.username]++; });
  const ranked = Object.entries(byUser).sort((a, b) => b[1] - a[1]);
  const summary = ranked.map(([username, count]) => `${username} (${count})`).join(', ');
  const admins = db.listUsers().filter(u => u.role === 'admin');
  admins.forEach(a => db.createNotification({ username: a.username, type: 'weekly_warning_digest', message: `Weekly task-warning summary: ${summary}.`, task_id: null }));
  return admins.length;
}
setInterval(sendWeeklyWarningDigestToAdmin, WEEKLY_DIGEST_INTERVAL_HOURS * 60 * 60 * 1000).unref();

// Manual triggers — for testing without waiting for the real interval.
app.post('/api/tasks/send-reminders-now', auth(['admin']), (req, res) => {
  res.json({ ok: true, remindersSent: sendTaskReminders(), escalationsSent: sendEscalatingTaskReminders(), deadlineRemindersSent: sendDeadlineReminders() });
});
app.post('/api/tasks/send-warning-digest-now', auth(['admin']), (req, res) => {
  res.json({ ok: true, adminsNotified: sendWeeklyWarningDigestToAdmin() });
});

// Safety net: an uncaught error thrown inside an `async (req, res) => {...}` route handler
// becomes a rejected promise, not a synchronous throw — Express 4 does NOT catch those on its
// own, and an unhandled rejection can crash the entire Node process, taking the app down for
// every single user over one bad request. This was found and fixed for a specific bug in this
// file already; this handler is the general-purpose backstop so the same CLASS of bug (a typo,
// a future endpoint, anything) logs an error instead of ending the server for everyone.
process.on('unhandledRejection', (err) => {
  console.error('Unhandled promise rejection (server stayed up):', err);
});
// A genuinely uncaught synchronous exception is a different, more serious case than an
// unhandled rejection — Node's own guidance is not to keep running after one, since the
// process may be in an undefined state. Logs the real error, then exits so a process manager
// (pm2, systemd, a container orchestrator) can restart clean, rather than either silently
// crashing with no record of why, or limping along in a potentially corrupted state.
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception — exiting for a clean restart:', err);
  process.exit(1);
});

// Express 4 DOES automatically route a synchronous throw inside a non-async route handler to
// this — the default behavior without this middleware would be Express's own error page, which
// can include a stack trace. This replaces that with one clean, non-technical JSON message for
// every unexpected error, while still logging the real details server-side for diagnosis.
// Respects a well-behaved lower-level error's own status (e.g. body-parser correctly flags
// malformed JSON as 400, a client mistake — that must stay a 4xx, not get miscategorized as a
// 500 "something went wrong on our end" when the problem was actually the client's request).
app.use((err, req, res, next) => {
  log('ERROR', 'unhandled request error', { requestId: req.id, method: req.method, path: req.path, error: err.message });
  if (res.headersSent) return next(err);
  const status = (err.status || err.statusCode) && (err.status || err.statusCode) < 500 ? (err.status || err.statusCode) : 500;
  const message = status < 500
    ? 'That request could not be understood — please check the data and try again.'
    : 'Something went wrong while processing that. Your other data was not affected — please try again.';
  res.status(status).json({ error: message, requestId: req.id });
});

// Only starts listening when this file is run directly (`node server.js`), not when it's
// `require()`d — e.g. by the test suite, which needs the Express app itself without binding a
// real port. Running the app normally (`node server.js` or `npm start`) behaves identically to
// before, since require.main === module is exactly the condition that's true in that case.
if (require.main === module) {
  const server = app.listen(PORT, () => console.log(`MIHIR Task Manager server running on http://localhost:${PORT}`));
  // Graceful shutdown: stop accepting new connections, let in-flight requests finish, then exit
  // cleanly — important so a deploy/restart never cuts off someone mid-request (e.g. mid-approval).
  function shutdown(signal) {
    console.log(`\n${signal} received — shutting down gracefully...`);
    server.close(() => {
      console.log('Server closed, no longer accepting new connections.');
      process.exit(0);
    });
    // Safety net: if something is stuck and close() never fires (e.g. a hung connection), force
    // exit after 10s rather than leaving the process running forever on a signal it should honor.
    setTimeout(() => { console.log('Forcing shutdown after 10s timeout.'); process.exit(1); }, 10000).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
module.exports = app;
