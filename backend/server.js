require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const db = require('./db');
const taskImport = require('./task-import');
const taskExport = require('./task-export');

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
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || process.env.APP_BASE_URL || 'https://mihir-task-manager.onrender.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}
async function sendPushToUser(username, title, body, taskId) {
  if (!pushConfigured) return;
  const subs = await db.listPushSubscriptionsForUser(username);
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify({ title, body, taskId: taskId || null }),
        // high urgency = delivered promptly even when the phone is in battery-saving (Doze) mode;
        // TTL = if the phone is off/offline, the push service keeps trying for a day.
        { TTL: 86400, urgency: 'high', timeout: 15000 }
      );
    } catch (e) {
      // A 404/410 means the browser itself has invalidated this subscription (uninstalled,
      // permission revoked, etc.) — clean it up instead of retrying it forever.
      if (e.statusCode === 404 || e.statusCode === 410) await db.removePushSubscription(sub.endpoint);
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
db.setNotificationHook(async ({ username, type, message, task_id }) => {
  const user = await db.getUser(username);
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
// gzip every response — task lists are highly repetitive JSON and shrink ~10x, which matters once
// a full imported schedule (thousands of tasks) is refreshed every few seconds.
app.use(require('compression')());
// Benchmarks only: report how many database queries each request made (sequential requests).
if (process.env.EXPOSE_QUERY_COUNT) {
  app.use((req, res, next) => {
    const start = db.getQueryCount();
    const json = res.json.bind(res);
    res.json = (body) => { res.setHeader('X-Queries', String(db.getQueryCount() - start)); return json(body); };
    next();
  });
}
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
// "no-cache" = the browser may keep a copy but must check with the server (a cheap ETag check)
// before using it. Without it, browsers guess how long to reuse app.js/styles.css, so after a
// deploy one machine can keep running an old cached app.js against the new server and break
// while every other device works fine. Images can still be cached normally.
app.use(express.static(path.join(__dirname, '..', 'frontend'), {
  setHeaders(res, filePath) {
    if (/\.(html|js|css|json)$/i.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
  },
}));
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
app.get('/ready', async (req, res) => {
  try {
    await db.listUsers(); // a cheap, already-exposed read — confirms the database connection is genuinely responsive, not just that the process is alive
    res.json({ status: 'ready' });
  } catch (e) {
    res.status(503).json({ status: 'not ready' });
  }
});
app.get('/version', async (req, res) => {
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
// Same IST conversion as getISTHour, but for the CALENDAR DATE rather than the hour — needed so
// Peak Hours can be scoped to today specifically, in the same timezone its hour buckets already
// use. Without this, the chart was silently mixing today's activity with every previous day's,
// since only the hour-of-day was ever extracted and the actual date was discarded entirely.
function getISTDateString(isoString) {
  const utcMs = new Date(isoString).getTime();
  if (isNaN(utcMs)) return null;
  return new Date(utcMs + IST_OFFSET_MS).toISOString().slice(0, 10);
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
// Multiple attachments: body.attachments = [{ name, data }] (data = data: URL). Every file gets
// the same checks as a single attachment; returns { files } or { error }.
const MAX_FILES_PER_UPLOAD = 10;
function collectUploads(body, maxSizeChars) {
  const list = Array.isArray((body || {}).attachments) ? body.attachments : [];
  if (list.length > MAX_FILES_PER_UPLOAD) return { error: `Attach at most ${MAX_FILES_PER_UPLOAD} files at a time.` };
  const files = [];
  for (const f of list) {
    const name = str((f || {}).name).trim().slice(0, 255) || 'file';
    const data = (f || {}).data;
    const err = validateUploadedFile(data, name, maxSizeChars);
    if (err) return { error: `${name}: ${err}` };
    files.push({ name, data });
  }
  return { files };
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
async function auditFromReq(req, action, details, actorOverride) {
  const actor = actorOverride || { username: req.user.username, name: req.user.name };
  const actorRecord = await db.getUser(actor.username);
  await db.logAudit({
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
// Same fix as the frontend's isOverdue(): a date-only deadline parses to midnight at the START
// of that day, so comparing it directly against "now" would mark something due today as overdue
// the instant it turns midnight — before the day it's actually due has even begun to pass. A
// deadline with a specific time is compared exactly as given; a date-only one is only overdue
// once its entire day has elapsed.
function isDeadlinePassed(deadlineStr, now) {
  if (!deadlineStr) return false;
  now = now || new Date();
  if (deadlineStr.includes('T')) { const d = parseDeadline(deadlineStr); return d && d <= now; }
  const endOfDeadlineDay = new Date(deadlineStr + 'T00:00:00');
  endOfDeadlineDay.setDate(endOfDeadlineDay.getDate() + 1);
  return endOfDeadlineDay <= now;
}
// Shared involvement check: assignee, follow-up person, creator, or Admin. Used to gate both
// commenting/attaching AND viewing a task's attachments — closes a real gap where the reply
// endpoint previously had no server-side check at all (only the UI hid the box), so anyone
// logged in could technically comment on or attach files to a task they had nothing to do with.
async function isInvolvedInTask(user, task) {
  if (user.role === 'admin') return true;
  if (task.created_by_username === user.username) return true;
  if ((await db.listAssignees(task.id)).some(a => a.username === user.username)) return true;
  if ((await db.listFollowups(task.id)).some(f => f.username === user.username)) return true;
  return false;
}
// Called right after a task closes — finds anything that was waiting on it, gives every
// assignee on those now-unblocked tasks a fresh escalation clock (so a 10-day wait doesn't
// immediately read as a 10-day personal delay), and lets them know they can proceed.
async function releaseDependentsOf(closedTask) {
  const dependents = await db.listDependentTasks(closedTask.id);
  for (const dep of dependents) {
    await db.resetEscalationTimersForTask(dep.id);
    const depAssignees = await db.listAssignees(dep.id);
    for (const a of depAssignees) {
      await db.createNotification({ username: a.username, type: 'task_assigned', message: `"${closedTask.title}" is done — you can now proceed with "${dep.title}".`, task_id: dep.id });
    }
  }
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
  return async (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Not logged in.' });
    let payload;
    try { payload = jwt.verify(token, JWT_SECRET); } catch (e) { return res.status(401).json({ error: 'Session expired — please log in again.' }); }
    // Phone-app device tokens can ONLY read that person's notifications (below) — never anything else.
    if (payload.scope === 'device') return res.status(401).json({ error: 'Not logged in.' });
    const user = await db.getUser(payload.username);
    if (!user) return res.status(401).json({ error: 'Session invalid — please log in again.' });
    if ((user.token_version || 0) !== (payload.tv || 0)) return res.status(401).json({ error: 'Session revoked — please log in again.' });
    if (!roles.includes(user.role)) return res.status(403).json({ error: 'Not permitted for this role.' });
    req.user = { username: user.username, role: user.role, name: user.name, sid: payload.sid };
    if (req.method === 'GET' && CACHED_GET_PATHS.some(rx => rx.test(req.path))) return cacheMiddleware(req, res, next);
    next();
  };
}
/* ---- Phone app notifications (free — no Firebase / paid push service) ----
   The Android app checks for new notifications in the background roughly every 15 minutes. Website
   logins expire after 12 hours, so the app gets its own long-lived DEVICE token at login: it can
   only list that person's notifications, and stops working the moment their password changes
   (token_version) or their account is removed. */
app.post('/api/device/register', auth(ALL_ROLES), async (req, res) => {
  const user = await db.getUser(req.user.username);
  const deviceToken = jwt.sign({ username: user.username, tv: user.token_version || 0, scope: 'device' }, JWT_SECRET, { expiresIn: '180d' });
  const latest = await db.getLatestNotificationId(user.username);
  res.json({ deviceToken, username: user.username, latestId: latest });
});
app.get('/api/device/notifications', async (req, res) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Device ') ? header.slice(7) : null;
  let payload;
  try { payload = token && jwt.verify(token, JWT_SECRET); } catch (e) { payload = null; }
  if (!payload || payload.scope !== 'device') return res.status(401).json({ error: 'Device not registered.' });
  const user = await db.getUser(payload.username);
  if (!user || (user.token_version || 0) !== (payload.tv || 0)) return res.status(401).json({ error: 'Device signed out.' });
  const after = Math.max(0, parseInt(req.query.after, 10) || 0);
  const items = await db.listUnreadNotificationsAfter(user.username, after, 20);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ items: items.map(n => ({ id: n.id, message: n.message, task_id: n.task_id, created_at: n.created_at })), latestId: items.length ? Math.max(...items.map(n => n.id)) : after });
});
// Cheapest possible "has anything changed?" — no database work at all. Clients poll this and only
// re-download data when the version moves, so idle screens cost the server (almost) nothing and
// every device — website or phone app — picks up changes within seconds of each other.
app.get('/api/sync', auth(ALL_ROLES), (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ v: `${BOOT_ID}.${db.getDataVersion()}`, c: `${BOOT_ID}.${db.getChatVersion()}` });
});

/* ============ CHAT ROOM ============
   Rooms: 'general' (everyone) and 'team:<department>' (that department's members; Admin sees all).
   Messages can carry files and @mentions — anyone mentioned who can see the room is notified. */
const CHAT_MAX_LEN = 4000;
async function chatRoomsFor(user) {
  const rooms = [{ key: 'general', name: 'General', emoji: '💬', hint: 'Everyone in the company' }];
  let teams = [];
  if (user.role === 'admin') teams = (await db.listTeams()).map(t => t.name || t).filter(Boolean);
  else if (user.team) teams = [user.team];
  for (const t of Array.from(new Set(teams)).sort()) rooms.push({ key: `team:${t}`, name: t, emoji: '👥', hint: `${t} department` });
  return rooms;
}
async function canUseChatRoom(user, room) {
  if (room === 'general') return true;
  if (!room.startsWith('team:')) return false;
  if (user.role === 'admin') return true;
  return !!user.team && room === `team:${user.team}`;
}
async function chatUser(req) { return (await db.getUser(req.user.username)) || { username: req.user.username, role: req.user.role }; }
app.get('/api/chat/rooms', auth(ALL_ROLES), async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const rooms = await chatRoomsFor(await chatUser(req));
  const stats = await db.chatRoomStats(req.user.username, rooms.map(r => r.key));
  res.json(rooms.map(r => { const s = stats.find(x => x.room === r.key) || {}; return { ...r, unread: Number(s.unread || 0), lastId: Number(s.last_id || 0) }; }));
});
app.get('/api/chat/messages', auth(ALL_ROLES), async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const room = str(req.query.room).trim() || 'general';
  if (!await canUseChatRoom(await chatUser(req), room)) return res.status(403).json({ error: "You don't have access to this room." });
  res.json(await db.listChatMessages(room, { afterId: Number(req.query.after) || 0, beforeId: Number(req.query.before) || null, limit: Number(req.query.limit) || 60 }));
});
app.post('/api/chat/messages', auth(ALL_ROLES), async (req, res) => {
  const room = str((req.body || {}).room).trim() || 'general';
  const user = await chatUser(req);
  if (!await canUseChatRoom(user, room)) return res.status(403).json({ error: "You don't have access to this room." });
  const message = str((req.body || {}).message).trim();
  if (tooLong(message, CHAT_MAX_LEN)) return res.status(400).json({ error: `Message is too long (max ${CHAT_MAX_LEN} characters).` });
  const uploads = collectUploads(req.body, MAX_FILE_CHARS);
  if (uploads.error) return res.status(400).json({ error: uploads.error });
  if (!message && uploads.files.length === 0) return res.status(400).json({ error: 'Write a message or attach a file.' });
  const id = await db.addChatMessage({ room, by_username: req.user.username, by_name: req.user.name, message, files: uploads.files });
  // @mentions → notify, but only people who can actually see this room.
  const roomName = room === 'general' ? 'General' : room.slice(5);
  const mentioned = new Set();
  for (const m of message.matchAll(/@([a-zA-Z0-9._-]{3,40})/g)) {
    if (m[1] === req.user.username || mentioned.has(m[1])) continue;
    const u = await db.getUser(m[1]);
    if (u && await canUseChatRoom(u, room)) mentioned.add(u.username);
  }
  const snippet = message.length > 80 ? message.slice(0, 79) + '…' : message;
  for (const u of mentioned) {
    await db.createNotification({ username: u, type: 'chat_mention', message: `${req.user.name} mentioned you in #${roomName}: "${snippet}"` });
  }
  await db.markChatRead(req.user.username, room, id);
  res.json({ id, mentioned: Array.from(mentioned) });
});
app.post('/api/chat/read', auth(ALL_ROLES), async (req, res) => {
  const room = str((req.body || {}).room).trim() || 'general';
  if (!await canUseChatRoom(await chatUser(req), room)) return res.status(403).json({ error: "You don't have access to this room." });
  await db.markChatRead(req.user.username, room, Number((req.body || {}).lastId) || 0);
  res.json({ ok: true });
});
app.delete('/api/chat/messages/:id', auth(ALL_ROLES), async (req, res) => {
  const msg = await db.getChatMessage(req.params.id);
  if (!msg || msg.deleted_at) return res.status(404).json({ error: 'Message not found.' });
  if (msg.by_username !== req.user.username && req.user.role !== 'admin') return res.status(403).json({ error: 'You can only delete your own messages.' });
  await db.deleteChatMessage(msg.id);
  if (msg.by_username !== req.user.username) await auditFromReq(req, 'chat_message_deleted', `Deleted a chat message by ${msg.by_name || msg.by_username} in ${msg.room}.`);
  res.json({ ok: true });
});
app.get('/api/chat/files/:id', auth(ALL_ROLES), async (req, res) => {
  const f = await db.getChatFile(req.params.id);
  if (!f) return res.status(404).json({ error: 'File not found.' });
  if (!await canUseChatRoom(await chatUser(req), f.room)) return res.status(403).json({ error: "You don't have access to this file." });
  res.json({ data: f.data, name: f.name });
});

/* ============ ANNOUNCEMENTS ============
   Circulated to everyone. Admin, Directors and HR can post; everyone reads. An optional date puts
   the announcement on the calendar. Posting notifies everyone (in-app + push). */
const ANNOUNCEMENT_CATEGORIES = ['general', 'holiday', 'event', 'safety', 'policy', 'celebration', 'meeting', 'urgent'];
async function canPostAnnouncements(req) {
  if (req.user.role === 'admin' || req.user.role === 'director') return true;
  const u = await db.getUser(req.user.username);
  return !!(u && isHRTeam(u.team));
}
function cleanAnnouncement(body) {
  const b = body || {};
  const title = str(b.title).trim();
  const text = str(b.body).trim();
  const emoji = str(b.emoji).trim().slice(0, 16);
  const category = ANNOUNCEMENT_CATEGORIES.includes(str(b.category)) ? str(b.category) : 'general';
  const eventDate = str(b.eventDate).trim();
  if (!title) return { error: 'A title is required.' };
  if (tooLong(title, 160)) return { error: 'Title is too long (max 160 characters).' };
  if (tooLong(text, 5000)) return { error: 'Message is too long (max 5000 characters).' };
  if (eventDate && !/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) return { error: 'Date is not valid.' };
  return { value: { title, body: text, emoji, category, event_date: eventDate || null, pinned: !!b.pinned } };
}
app.get('/api/announcements', auth(ALL_ROLES), async (req, res) => {
  res.json({ items: await db.listAnnouncements(), canPost: await canPostAnnouncements(req) });
});
app.post('/api/announcements', auth(ALL_ROLES), async (req, res) => {
  if (!await canPostAnnouncements(req)) return res.status(403).json({ error: 'Only Admin, Directors and HR can post announcements.' });
  const a = cleanAnnouncement(req.body);
  if (a.error) return res.status(400).json({ error: a.error });
  const id = await db.createAnnouncement({ ...a.value, created_by_username: req.user.username, created_by_name: req.user.name });
  await auditFromReq(req, 'announcement_posted', `Posted announcement "${a.value.title}".`);
  const users = await db.listUsers();
  for (const u of users) {
    if (u.username === req.user.username) continue;
    await db.createNotification({ username: u.username, type: 'announcement', message: `${a.value.emoji ? a.value.emoji + ' ' : '📢 '}${a.value.title}` });
  }
  res.json({ id });
});
app.put('/api/announcements/:id', auth(ALL_ROLES), async (req, res) => {
  const existing = await db.getAnnouncement(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Announcement not found.' });
  if (!await canPostAnnouncements(req)) return res.status(403).json({ error: 'Only Admin, Directors and HR can edit announcements.' });
  if (existing.created_by_username !== req.user.username && req.user.role !== 'admin') return res.status(403).json({ error: 'Only the person who posted it (or Admin) can edit it.' });
  const a = cleanAnnouncement(req.body);
  if (a.error) return res.status(400).json({ error: a.error });
  await db.updateAnnouncement(existing.id, a.value);
  res.json({ ok: true });
});
app.delete('/api/announcements/:id', auth(ALL_ROLES), async (req, res) => {
  const existing = await db.getAnnouncement(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Announcement not found.' });
  if (existing.created_by_username !== req.user.username && req.user.role !== 'admin') return res.status(403).json({ error: 'Only the person who posted it (or Admin) can remove it.' });
  await db.deleteAnnouncement(existing.id);
  await auditFromReq(req, 'announcement_removed', `Removed announcement "${existing.title}".`);
  res.json({ ok: true });
});

/* ============ RESPONSE CACHE + LIVE SYNC ============
   Read endpoints answer from memory until something actually changes. Every write anywhere bumps
   db's dataVersion; a cached answer is reused only while the version is unchanged (and it's
   younger than its max age, for things that also depend on the clock, like "overdue" counts or
   "this week"). Identical requests arriving together (several screens refreshing at once) share
   ONE computation instead of each running the same heavy queries — that pile-up is what stalled
   the server for minutes and produced the 520 errors. Entries are per user (key includes the
   username), so nobody ever receives someone else's data. */
const BOOT_ID = Math.random().toString(36).slice(2, 8);
const responseCache = new Map(); // key -> { version, at, body }
const inFlight = new Map();      // key -> Promise<{ status, body }>
const RESPONSE_CACHE_MAX = 400;
function cacheResponse(maxAgeMs = 120000) {
  return async (req, res, next) => {
    if (req.method !== 'GET' || !req.user) return next();
    const key = `${req.user.username}|${req.originalUrl}`;
    const version = db.getDataVersion();
    const hit = responseCache.get(key);
    if (hit && hit.version === version && Date.now() - hit.at < maxAgeMs) { res.setHeader('X-Cache', 'hit'); return res.json(hit.body); }
    const pending = inFlight.get(key);
    if (pending) {
      try { const r = await pending; if (r.status === 200) { res.setHeader('X-Cache', 'shared'); return res.json(r.body); } } catch (e) { /* fall through and compute */ }
      return next();
    }
    let settle;
    const promise = new Promise(resolve => { settle = resolve; });
    inFlight.set(key, promise);
    const json = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode === 200) {
        if (responseCache.size >= RESPONSE_CACHE_MAX) responseCache.delete(responseCache.keys().next().value);
        responseCache.set(key, { version, at: Date.now(), body });
      }
      inFlight.delete(key);
      settle({ status: res.statusCode, body });
      return json(body);
    };
    res.on('close', () => { if (inFlight.get(key) === promise) { inFlight.delete(key); settle({ status: 499 }); } });
    next();
  };
}
// Everything a refreshing screen reads goes through the cache.
const CACHED_GET_PATHS = [
  /^\/api\/tasks$/, /^\/api\/tasks\/mine$/, /^\/api\/tasks\/open-titles$/, /^\/api\/users\/directory$/, /^\/api\/teams$/,
  /^\/api\/projects$/, /^\/api\/drawing-sections$/, /^\/api\/task-phases$/, /^\/api\/notifications$/, /^\/api\/approvals(\/mine)?$/,
  /^\/api\/auth\/me$/, /^\/api\/reports\/[a-z-]+$/,
];
const cacheMiddleware = cacheResponse();

/* ============ AUTH ============ */
// Basic brute-force protection: after 5 consecutive failed attempts on an account, it locks for
// 3 minutes regardless of whether the next attempt would've been correct — same pattern most
// professional login systems use. A successful login always clears the counter.
app.post('/api/auth/login', loginRateLimiter, async (req, res) => {
  const username = str((req.body || {}).username).trim();
  const password = str((req.body || {}).password);
  const user = await db.getUserFresh(username);
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
      await db.recordFailedLogin(user.username);
      const justLocked = await db.getUserFresh(user.username);
      if (justLocked && justLocked.locked_until) {
        await auditFromReq(req, 'account_locked', `Account locked for 3 minutes after 5 failed login attempts.`, { username: user.username, name: user.name });
      }
    }
    return res.status(401).json({ error: 'Invalid username or password.' });
  }
  await db.clearFailedLogins(user.username);
  const sid = genId('SESS');
  await db.createSession({ id: sid, username: user.username, device: req.headers['user-agent'], ip: req.ip });
  await auditFromReq(req, 'login', `Logged in.`, { username: user.username, name: user.name });
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
  const user = await db.getUserFresh(username);
  if (!user || !user.email) return res.json({ ...genericResponse, emailConfigured: true });
  const otp = String(Math.floor(100000 + Math.random() * 900000));
  const otpHash = bcrypt.hashSync(otp, 10);
  const expires = new Date(Date.now() + 10 * 60000).toISOString();
  await db.setPasswordResetOtp(user.username, otpHash, expires);
  try {
    await sendOtpEmail(user.email, otp, user.name);
  } catch (e) {
    console.error('Failed to send password-reset email:', e.message);
  }
  res.json({ ...genericResponse, emailConfigured: true });
});
app.post('/api/auth/reset-with-otp', async (req, res) => {
  const username = str((req.body || {}).username).trim();
  const otp = str((req.body || {}).otp).trim();
  const newPassword = str((req.body || {}).newPassword);
  const user = await db.getUserFresh(username);
  if (!user || !user.password_reset_otp_hash || !user.password_reset_otp_expires) {
    return res.status(400).json({ error: 'No reset code is pending for this account — request a new one.' });
  }
  if (new Date(user.password_reset_otp_expires) < new Date()) {
    await db.clearPasswordResetOtp(username);
    return res.status(400).json({ error: 'That code has expired — request a new one.' });
  }
  if (!bcrypt.compareSync(otp, user.password_reset_otp_hash)) {
    return res.status(400).json({ error: 'Incorrect code.' });
  }
  const pwErr1 = validatePasswordStrength(newPassword); if (pwErr1) return res.status(400).json({ error: pwErr1 });
  await db.setPassword(user.username, bcrypt.hashSync(newPassword, 10));
  await db.clearPasswordResetOtp(username);
  await auditFromReq(req, 'password_reset_via_otp', `Reset their own password using a forgot-password code.`, { username: user.username, name: user.name });
  res.json({ ok: true });
});
app.post('/api/auth/logout-everywhere', auth(ALL_ROLES), async (req, res) => {
  await db.bumpTokenVersion(req.user.username);
  const user = await db.getUserFresh(req.user.username);
  const token = sign({ username: user.username, role: user.role, name: user.name, tv: user.token_version || 0, sid: req.user.sid });
  res.json({ ok: true, token });
});
app.post('/api/auth/change-password', auth(ALL_ROLES), async (req, res) => {
  const newPassword = str((req.body || {}).newPassword);
  const pwErr1 = validatePasswordStrength(newPassword); if (pwErr1) return res.status(400).json({ error: pwErr1 });
  await db.setPassword(req.user.username, bcrypt.hashSync(newPassword, 10));
  await auditFromReq(req, 'password_changed', `Changed their own password.`);
  const user = await db.getUserFresh(req.user.username);
  const token = sign({ username: user.username, role: user.role, name: user.name, tv: user.token_version || 0, sid: req.user.sid });
  res.json({ ok: true, token });
});
app.post('/api/auth/update-name', auth(ALL_ROLES), async (req, res) => {
  const name = str((req.body || {}).name).trim();
  if (!name) return res.status(400).json({ error: 'Name cannot be empty.' });
  if (name.length > 80) return res.status(400).json({ error: 'Name is too long.' });
  await db.updateOwnName(req.user.username, name);
  const user = await db.getUserFresh(req.user.username);
  const token = sign({ username: user.username, role: user.role, name: user.name, tv: user.token_version || 0, sid: req.user.sid });
  res.json({ ok: true, token, name: user.name });
});
app.post('/api/auth/update-email', auth(ALL_ROLES), async (req, res) => {
  const email = str((req.body || {}).email).trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "That doesn't look like a valid email address." });
  await db.updateOwnEmail(req.user.username, email || null);
  res.json({ ok: true, email: email || null });
});
// Phone number for WhatsApp task notifications — E.164 format required (e.g. +919876543210),
// since that's what the WhatsApp Cloud API expects the recipient number to look like.
app.post('/api/auth/update-phone', auth(ALL_ROLES), async (req, res) => {
  const phone = str((req.body || {}).phone).trim();
  if (phone && !/^\+[1-9]\d{7,14}$/.test(phone)) return res.status(400).json({ error: 'Enter your phone number in international format, e.g. +919876543210.' });
  await db.updateOwnPhone(req.user.username, phone || null);
  res.json({ ok: true, phone: phone || null });
});
app.get('/api/push/vapid-public-key', (req, res) => res.json({ publicKey: pushConfigured ? VAPID_PUBLIC_KEY : null }));
// Whether this device's subscription is on file (so the page knows to show "Turn on" or not).
app.post('/api/push/status', auth(ALL_ROLES), async (req, res) => {
  const endpoint = str((req.body || {}).endpoint).trim();
  const subs = await db.listPushSubscriptionsForUser(req.user.username);
  res.json({ configured: pushConfigured, subscribed: !!endpoint && subs.some(x => x.endpoint === endpoint), devices: subs.length });
});
app.post('/api/push/subscribe', auth(ALL_ROLES), async (req, res) => {
  const sub = (req.body || {}).subscription;
  if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return res.status(400).json({ error: 'Invalid push subscription.' });
  await db.savePushSubscription(req.user.username, sub.endpoint, sub.keys.p256dh, sub.keys.auth);
  res.json({ ok: true });
});
app.post('/api/push/unsubscribe', auth(ALL_ROLES), async (req, res) => {
  const endpoint = str((req.body || {}).endpoint).trim();
  if (endpoint) await db.removePushSubscription(endpoint);
  res.json({ ok: true });
});
app.get('/api/auth/me', auth(ALL_ROLES), async (req, res) => {
  const user = await db.getUserFresh(req.user.username);
  res.json({ username: user.username, role: user.role, name: user.name, email: user.email, phone: user.phone, team: user.team, designation: user.designation, isTeamLead: !!user.is_team_lead });
});

/* ============ USERS (Admin manages accounts) ============ */
app.get('/api/users', auth(['admin']), async (req, res) => res.json(await db.listUsers()));
app.get('/api/users/directory', auth(ALL_ROLES), async (req, res) => res.json(await db.listUsers()));
app.post('/api/users', auth(['admin']), async (req, res) => {
  const username = str((req.body || {}).username).trim();
  const password = str((req.body || {}).password);
  const name = str((req.body || {}).name).trim();
  const role = ALL_ROLES.includes(str((req.body || {}).role)) ? str((req.body || {}).role) : 'member';
  const team = str((req.body || {}).team).trim();
  const designation = str((req.body || {}).designation).trim();
  if (!/^[a-zA-Z0-9._-]{3,40}$/.test(username)) return res.status(400).json({ error: 'Username must be 3-40 characters: letters, numbers, dots, underscores, or hyphens only.' });
  const pwErr2 = validatePasswordStrength(password); if (pwErr2) return res.status(400).json({ error: pwErr2 });
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  if (await db.getUser(username)) return res.status(409).json({ error: 'That username is already taken.' });
  await db.createUser({ username, password_hash: bcrypt.hashSync(password, 10), role, name, team, designation, must_change_password: true });
  await auditFromReq(req, 'account_created', `Created account "${username}" (${name}), role: ${role}`);
  res.json({ ok: true, username });
});
app.post('/api/users/:username/team', auth(['admin']), async (req, res) => {
  if (!await db.getUser(req.params.username)) return res.status(404).json({ error: 'User not found.' });
  await db.setUserTeam(req.params.username, str((req.body || {}).team).trim());
  res.json({ ok: true });
});
app.post('/api/users/:username/designation', auth(['admin']), async (req, res) => {
  if (!await db.getUser(req.params.username)) return res.status(404).json({ error: 'User not found.' });
  await db.updateUserDesignation(req.params.username, str((req.body || {}).designation).trim());
  res.json({ ok: true });
});
app.post('/api/users/:username/team-lead', auth(['admin']), async (req, res) => {
  if (!await db.getUser(req.params.username)) return res.status(404).json({ error: 'User not found.' });
  const isTeamLead = !!(req.body || {}).isTeamLead;
  await db.setUserTeamLead(req.params.username, isTeamLead);
  await auditFromReq(req, 'team_lead_changed', `${isTeamLead ? 'Made' : 'Removed'} "${req.params.username}" ${isTeamLead ? 'a' : 'as'} team lead`);
  res.json({ ok: true });
});
// Grants a Director visibility into department(s) beyond their own — Admin-only, and only
// meaningful for Director-role accounts (harmlessly ignored for anyone else, since nobody but
// Directors are ever restricted by department in the first place).
app.post('/api/users/:username/visible-departments', auth(['admin']), async (req, res) => {
  const user = await db.getUser(req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const departments = Array.isArray((req.body || {}).departments) ? (req.body || {}).departments.map(d => str(d).trim()).filter(Boolean) : [];
  await db.setVisibleDepartments(req.params.username, departments.join(','));
  await auditFromReq(req, 'director_visibility_changed', `Set "${req.params.username}"'s additional visible departments to: ${departments.length ? departments.join(', ') : '(none)'}`);
  res.json({ ok: true });
});
app.post('/api/users/:username/name', auth(['admin']), async (req, res) => {
  const user = await db.getUser(req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const name = str((req.body || {}).name).trim();
  if (!name) return res.status(400).json({ error: 'Name cannot be empty.' });
  await db.updateUserDisplayName(user.username, name);
  res.json({ ok: true });
});
// Changing the actual login username — touches every table that references it as a functional
// lookup key (see db.renameUsername for the full list and reasoning). Any of that account's
// active sessions stop working the moment this runs (their token still carries the old
// username) — expected, they just log back in with the new one.
app.post('/api/users/:username/rename', auth(['admin']), async (req, res) => {
  const oldUsername = req.params.username;
  const user = await db.getUser(oldUsername);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const newUsername = str((req.body || {}).newUsername).trim();
  if (!/^[a-zA-Z0-9._-]{3,40}$/.test(newUsername)) return res.status(400).json({ error: 'Username must be 3-40 characters: letters, numbers, dots, underscores, or hyphens only.' });
  if (newUsername === oldUsername) return res.status(400).json({ error: "That's already this account's username." });
  if (await db.getUser(newUsername)) return res.status(409).json({ error: 'That username is already taken.' });
  await db.renameUsername(oldUsername, newUsername);
  await auditFromReq(req, 'username_changed', `Renamed account "${oldUsername}" to "${newUsername}"`);
  res.json({ ok: true, newUsername });
});
app.post('/api/users/:username/reset-password', auth(['admin']), async (req, res) => {
  const user = await db.getUser(req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const newPassword = str((req.body || {}).newPassword);
  const pwErr1 = validatePasswordStrength(newPassword); if (pwErr1) return res.status(400).json({ error: pwErr1 });
  await db.forcePasswordReset(user.username, bcrypt.hashSync(newPassword, 10));
  await auditFromReq(req, 'password_reset', `Reset password for "${user.username}"`);
  res.json({ ok: true });
});
// Shows Admin exactly what removing this account will wipe out, before they confirm.
app.get('/api/users/:username/deletion-impact', auth(['admin']), async (req, res) => {
  const user = await db.getUser(req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  res.json({ username: user.username, name: user.name, ...(await db.getAccountDeletionImpact(user.username)) });
});
// Removes the account AND everything tied to it (see db.deleteUserCompletely for the full list).
// This used to refuse outright whenever the person was on any open task, and when it did go
// through it only deleted the login row — leaving their tasks, tags, replies, notifications,
// approvals and sessions behind as orphans pointing at someone who no longer exists. Now shared
// tasks are repaired (untagged, levels renumbered, next level released / task closed where due)
// and everyone affected is told.
app.delete('/api/users/:username', auth(['admin']), async (req, res) => {
  const username = req.params.username;
  if (username === req.user.username) return res.status(400).json({ error: "You can't remove your own account." });
  const target = await db.getUser(username);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (target.role === 'admin') {
    const admins = await db.listAdminUsernames();
    if (admins.length <= 1) return res.status(400).json({ error: "That's the only Admin account — make someone else Admin first." });
  }
  const deleteDrawings = String(req.query.deleteDrawings || (req.body || {}).deleteDrawings || '') === '1' || (req.body || {}).deleteDrawings === true;
  let result;
  try {
    result = await db.deleteUserCompletely(username, { deleteDrawings });
  } catch (e) {
    log('ERROR', 'account deletion failed', { requestId: req.id, username, error: e.message });
    return res.status(500).json({ error: 'Removing the account failed and nothing was changed — please try again.' });
  }
  if (!result) return res.status(404).json({ error: 'User not found.' });
  const who = `${target.name} (${username})`;
  // Notifications happen after the transaction commits, and a failure here must never make the
  // (already completed) removal look like it failed.
  try {
    for (const t of result.orphanedOpenTasks) {
      await db.createNotification({ username: t.created_by_username, type: 'task_deleted', message: `"${t.title}" was removed because ${who}, the only person tagged on it, no longer has an account. Raise it again for someone else if it's still needed.`, task_id: null });
    }
    for (const t of result.repairedTasks) {
      if (t.created_by_username && t.created_by_username !== req.user.username) {
        await db.createNotification({ username: t.created_by_username, type: 'task_reply', message: t.closed ? `${who} was removed from "${t.title}" — everyone left had already been approved, so the task is now closed.` : `${who}'s account was removed, so they're no longer tagged on "${t.title}".`, task_id: t.id });
      }
      for (const u of t.released) {
        await db.createNotification({ username: u, type: 'task_assigned', message: `You're released to start your part of "${t.title}".`, task_id: t.id });
      }
      if (t.closed) await releaseDependentsOf({ id: t.id, title: t.title });
    }
    for (const a of result.approvalsCompleted) {
      if (a.created_by_username) await db.createNotification({ username: a.created_by_username, type: 'approval_approved', message: `"${a.title}" is fully approved.`, task_id: null });
    }
  } catch (e) { log('ERROR', 'post-deletion notifications failed', { requestId: req.id, username, error: e.message }); }
  const s = result.summary;
  await auditFromReq(req, 'account_removed', `Removed account "${username}" (${target.name}) and all related data: ${s.tasksDeleted} task(s) deleted, untagged from ${s.sharedTasksUntagged} shared task(s), ${s.replies} repl(ies), ${s.followups} follow-up tag(s), ${s.approvalsCreated} approval request(s) sent, ${s.approvalReviews} approval reviewer slot(s), ${s.notifications} notification(s)${deleteDrawings ? `, ${s.drawings} drawing(s)` : ' — drawings kept'}.`);
  res.json({ ok: true, removed: s });
});

app.get('/api/audit-log', auth(['admin']), async (req, res) => res.json(await db.listAuditLog(200)));

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
async function computeHistoricalDurationDays(priority) {
  const rows = await db.getApprovedTaskDurationsByPriority(priority);
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
    const hist = await computeHistoricalDurationDays(priority);
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
app.get('/api/reports/tasks-list', auth(['admin']), async (req, res) => res.json(await db.listReportableTasks()));
app.get('/api/reports/task/:id', auth(['admin']), async (req, res) => {
  // "Not generated yet" is a completely normal, expected state here — not an error — so this
  // returns 200 with generated:false rather than a 404, which was showing up as a scary red
  // "Failed to load resource" in the browser console on totally routine use (just clicking a
  // task in the list before ever generating its report).
  const cached = await db.getCachedReport(req.params.id);
  if (!cached) return res.json({ generated: false });
  res.json({ generated: true, ...cached });
});
app.post('/api/reports/task/:id/generate', auth(['admin']), async (req, res) => {
  try {
    const task = await db.getTaskFull(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found.' });
    if (task.status === 'open') return res.status(400).json({ error: 'Task is still open — reports are only for closed or cancelled tasks.' });
    const computed = computeTaskReport(task);
    const suggestions = await generateReportSuggestions(task, computed);
    const report = { ...computed, suggestions };
    await db.saveReport(task.id, report);
    res.json(report);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/reports/peak-hours', auth(['admin', 'director']), async (req, res) => {
  const username = str(req.query.username).trim();
  // A Director's view is scoped to their own department plus whatever Admin has additionally
  // granted them — never company-wide, and never another department's individual unless
  // explicitly granted visibility into it.
  let allowedUsernames = null;
  if (req.user.role === 'director') {
    const allowedTeams = directorAllowedTeams(await db.getUser(req.user.username));
    allowedUsernames = new Set((await db.listUsers()).filter(u => allowedTeams.has(u.team)).map(u => u.username));
    if (username && username !== 'all' && !allowedUsernames.has(username)) {
      return res.status(403).json({ error: "You don't have visibility into that person's data." });
    }
  }
  const data = await db.getAllActivityTimestamps();
  const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, taskCreated: 0, replies: 0, submissions: 0, approvals: 0, logins: 0, total: 0 }));
  // Scoped to TODAY specifically (in IST, matching the hour extraction below) — this used to
  // aggregate activity across the site's ENTIRE history into these same 24 buckets, silently
  // mixing today's pattern with every previous day's. A real, meaningful accuracy bug: "peak
  // hours" should mean today's actual rhythm, not an all-time blur that never changes shape.
  const todayIST = getISTDateString(new Date().toISOString());
  // "total" (and therefore the "busiest hour") only counts genuine work — creating a task,
  // commenting, submitting, approving. A login isn't doing anything; someone who just opens the
  // app and looks around shouldn't register as "an activity" the same as someone who actually
  // submitted or approved work. Logins are still tracked and shown, just not counted here.
  const bucket = (rows, key, countsAsWork) => rows.forEach(r => {
    if (username && username !== 'all' && r.username !== username) return;
    if (allowedUsernames && !allowedUsernames.has(r.username)) return;
    if (getISTDateString(r.created_at) !== todayIST) return;
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
async function computeUserCounts(rows, dateField) {
  const now = Date.now();
  const DAY_MS = 86400000;
  const stats = {};
  (await db.listUsers()).forEach(u => { stats[u.username] = { username: u.username, name: u.name, team: u.team, week: 0, month: 0, quarter: 0, year: 0, allTime: 0 }; });
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
app.get('/api/reports/completion', auth(['admin', 'director']), async (req, res) => {
  const stats = await computeUserCounts(await db.getApprovedCompletions(), 'submitted_at');
  if (req.user.role === 'admin') return res.json(stats);
  const allowed = directorAllowedTeams(await db.getUser(req.user.username));
  res.json(stats.filter(s => allowed.has(s.team)));
});
// A transparent rating, not a black-box score — every number shown is a real, explainable
// component, and both halves are comparative against the COMPANY's own actual activity, not an
// arbitrary fixed target (so someone in a role with naturally fewer/slower tasks isn't punished
// against an unrealistic yardstick). Computed over the quarter (trailing 90 days), since that's
// a natural performance-review cadence. Nobody is scored below 0 or above 5, and anyone with no
// completed work this quarter simply gets "not enough data" rather than a punitive 0.
app.get('/api/reports/ratings', auth(['admin', 'director']), async (req, res) => {
  const completionStats = await computeUserCounts(await db.getApprovedCompletions(), 'submitted_at');
  const activeThisQuarter = completionStats.filter(s => s.quarter > 0);
  const companyAvgQuarterCompletions = activeThisQuarter.length > 0
    ? activeThisQuarter.reduce((sum, s) => sum + s.quarter, 0) / activeThisQuarter.length : 0;
  const responseTimesByUser = await db.getResponseDurationsByUser();
  const allResponseTimes = Object.values(responseTimesByUser).flat();
  const companyAvgResponseDays = allResponseTimes.length > 0 ? allResponseTimes.reduce((a, b) => a + b, 0) / allResponseTimes.length : null;
  const warningCounts = await db.getWarningCountsByUser();

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
    const allowed = directorAllowedTeams(await db.getUser(req.user.username));
    ratings = ratings.filter(r => allowed.has(r.team));
  }
  res.json({ ratings, companyAvgQuarterCompletions: Math.round(companyAvgQuarterCompletions * 10) / 10, companyAvgResponseDays: companyAvgResponseDays !== null ? Math.round(companyAvgResponseDays * 10) / 10 : null });
});

// A THIS-MONTH-scoped leaderboard, using the same rating philosophy as the quarterly ratings
// above (volume vs. company average + timeliness vs. company average, each worth up to 2.5),
// just re-scoped to this month's completions specifically rather than this quarter's — meant to
// be checked continuously through the month, not just at a quarter boundary. Ranked descending
// by rating; ties broken by raw completion count, then alphabetically, so the order is always
// well-defined and never flickers between identical-looking refreshes.
// Shared by the weekly and monthly leaderboards (and reused for quarter/year-end snapshots
// below) — computes the same rating model (volume vs. company average + timeliness), just
// scoped to whichever period field is passed in ('week', 'month', 'quarter', 'year').
async function computeLeaderboard(periodKey) {
  const completionStats = await computeUserCounts(await db.getApprovedCompletions(), 'submitted_at');
  const active = completionStats.filter(s => s[periodKey] > 0);
  const companyAvgCompletions = active.length > 0
    ? active.reduce((sum, s) => sum + s[periodKey], 0) / active.length : 0;
  // Timeliness uses each person's ALL-TIME average response duration for every period — the
  // existing response-duration helper doesn't expose per-completion timestamps for period
  // filtering, and building that out precisely per-period is a real, undone follow-up, not
  // silently pretended away here. Volume (the completion count itself) IS genuinely
  // period-scoped, which is the part that matters most for a leaderboard.
  const responseTimesByUser = await db.getResponseDurationsByUser();
  const allResponseTimes = active.map(s => responseTimesByUser[s.username] || []).flat();
  const companyAvgResponseDays = allResponseTimes.length > 0 ? allResponseTimes.reduce((a, b) => a + b, 0) / allResponseTimes.length : null;

  let leaderboard = active.map(s => {
    const myResponseTimes = responseTimesByUser[s.username] || [];
    const myAvgResponse = myResponseTimes.length > 0 ? myResponseTimes.reduce((a, b) => a + b, 0) / myResponseTimes.length : null;
    const volumeScore = companyAvgCompletions > 0 ? Math.min(2.5, 2.5 * (s[periodKey] / companyAvgCompletions)) : 2.5;
    let timelinessScore = 1.25;
    if (myAvgResponse !== null && companyAvgResponseDays !== null) {
      timelinessScore = myAvgResponse <= companyAvgResponseDays ? 2.5 : Math.max(0, 2.5 * (companyAvgResponseDays / myAvgResponse));
    }
    const rating = Math.round((volumeScore + timelinessScore) * 10) / 10;
    return { username: s.username, name: s.name, team: s.team, rating, completions: s[periodKey] };
  });
  leaderboard.sort((a, b) => b.rating - a.rating || b.completions - a.completions || a.name.localeCompare(b.name));
  return leaderboard.map((r, idx) => ({ ...r, rank: idx + 1 }));
}
// Calendar-aligned quarter/year boundaries — genuinely fixed periods (Jan-Mar, Apr-Jun, etc.,
// or a full Jan-Dec year), distinct from the trailing-window "quarter"/"year" used elsewhere.
function getQuarterInfo(date) {
  const year = date.getFullYear();
  const q = Math.floor(date.getMonth() / 3); // 0-3
  const start = new Date(year, q * 3, 1);
  const end = new Date(year, q * 3 + 3, 1);
  return { label: `Q${q + 1} ${year}`, start, end };
}
function getYearInfo(date) {
  const year = date.getFullYear();
  return { label: String(year), start: new Date(year, 0, 1), end: new Date(year + 1, 0, 1) };
}
async function computeCalendarLeaderboard(startDate, endDate) {
  const rows = await db.getApprovedCompletionsInRange(startDate.toISOString(), endDate.toISOString());
  const counts = {};
  rows.forEach(r => { counts[r.username] = (counts[r.username] || 0) + 1; });
  const users = await db.listUsers();
  const active = Object.keys(counts).map(username => {
    const u = users.find(x => x.username === username);
    return u ? { username, name: u.name, team: u.team, completions: counts[username] } : null;
  }).filter(Boolean);
  active.sort((a, b) => b.completions - a.completions || a.name.localeCompare(b.name));
  return active.map((r, idx) => ({ ...r, rank: idx + 1 }));
}
// Checks whether the quarter/year that just ended has already been snapshotted — if not,
// computes final rankings for THAT completed period specifically (not the current one, which
// has barely started) and stores them permanently. Safe to call repeatedly — does nothing once
// a period has already been recorded, so a daily check never double-awards the same period.
async function checkAndSnapshotPeriodAwards() {
  const now = new Date();
  const periodConfigs = [
    { type: 'quarter', getInfo: getQuarterInfo, prevDate: new Date(now.getFullYear(), now.getMonth() - 3, 1) },
    { type: 'year', getInfo: getYearInfo, prevDate: new Date(now.getFullYear() - 1, 0, 1) },
  ];
  for (const { type, getInfo, prevDate } of periodConfigs) {
    const prevPeriod = getInfo(prevDate);
    const alreadyProcessed = await db.getLastProcessedPeriod(type);
    if (alreadyProcessed === prevPeriod.label) continue; // this period's award already exists
    const ranked = await computeCalendarLeaderboard(prevPeriod.start, prevPeriod.end);
    for (const r of ranked.slice(0, 3)) {
      await db.savePeriodAward({ period_type: type, period_label: prevPeriod.label, rank: r.rank, username: r.username, name: r.name, team: r.team, rating: null, completions: r.completions });
    }
    await db.setLastProcessedPeriod(type, prevPeriod.label);
  }
}
// Checked once a day — cheap, and a missed check just means the award appears a day later than
// the period technically ended, never earlier or duplicated.
setInterval(checkAndSnapshotPeriodAwards, 24 * 60 * 60 * 1000).unref();
app.get('/api/reports/period-awards', auth(['admin']), async (req, res) => {
  const type = req.query.type === 'year' ? 'year' : 'quarter';
  res.json({ awards: await db.listPeriodAwards(type) });
});
app.get('/api/reports/weekly-leaderboard', auth(['admin']), async (req, res) => {
  const now = new Date();
  const weekStart = new Date(now); weekStart.setDate(now.getDate() - now.getDay());
  res.json({ leaderboard: await computeLeaderboard('week'), periodLabel: `Week of ${weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` });
});
app.get('/api/reports/monthly-leaderboard', auth(['admin']), async (req, res) => {
  const now = new Date();
  res.json({ leaderboard: await computeLeaderboard('month'), periodLabel: now.toLocaleString('en-US', { month: 'long', year: 'numeric' }) });
});

// Self-scoped only — always uses the logged-in person's own username, never an admin-chosen
// target, so this can be open to every role without leaking anyone else's numbers. Real,
// computed statistics from this person's own history — not a trained model, just honest counts
// and averages, which is a better fit for a small self-hosted app than a fake "ML" label would be.
// A company-wide, bird's-eye personnel overview — genuinely distinct from my-dashboard below,
// which only ever shows one person (or the whole company summed together) at a time. This
// shows every employee side by side with their real completion count and real warning count, so
// HR/Admin can spot who's been flagged without drilling into each person one at a time.
app.get('/api/reports/hr-roster', auth(ALL_ROLES), async (req, res) => {
  const actingUser = await db.getUser(req.user.username);
  const isHR = actingUser && isHRTeam(actingUser.team);
  if (!(req.user.role === 'admin' || isHR)) return res.status(403).json({ error: 'Only HR Department members and Admin can view the roster.' });
  const completionAll = await computeUserCounts(await db.getApprovedCompletions(), 'submitted_at');
  const warningCounts = await db.getWarningCountsByUser();
  const pendingCounts = await db.getPendingTaskCountsByUser();
  // The threshold requested: 2+ currently pending tasks flags the person red for whoever's
  // looking at this roster — HR and Admin are the only two audiences who ever see this view.
  const PENDING_RED_FLAG_THRESHOLD = 2;
  // The roster is a personnel/employee overview, not a leadership dashboard — Admin and
  // Directors are never shown as entries in it, for anyone viewing it, Admin included.
  const roster = (await db.listUsers()).filter(u => u.role !== 'admin' && u.role !== 'director').map(u => {
    const completion = completionAll.find(s => s.username === u.username) || { allTime: 0 };
    const pendingTaskCount = pendingCounts[u.username] || 0;
    return {
      username: u.username, name: u.name, team: u.team, designation: u.designation,
      role: u.role, isTeamLead: !!u.is_team_lead, tasksCompleted: completion.allTime,
      warningCount: warningCounts[u.username] || 0,
      // Red-flagged either by raw pending-workload volume, or by the more precise, real signal:
      // any task where they've actually hit the 5-day incompletion threshold — the exact
      // mechanism the escalation system itself already uses to notify HR/Admin.
      pendingTaskCount, isPendingRedFlag: pendingTaskCount >= PENDING_RED_FLAG_THRESHOLD || (warningCounts[u.username] || 0) > 0,
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
  const totalTasksCompleted = (await db.listAllTasks()).filter(t => t.status === 'closed').length;
  res.json({ roster, totalTasksCompleted });
});
app.get('/api/reports/my-dashboard', auth(ALL_ROLES), async (req, res) => {
  // Self-scoped for everyone EXCEPT admin, who can pass ?username=X to view any individual's
  // dashboard too — the same real numbers that person sees themselves, not a separate view.
  // A non-admin can never see anyone's numbers but their own, no matter what they pass.
  const requestedUsername = str(req.query.username).trim();
  if (req.user.role === 'admin' && requestedUsername === 'all') {
    // Whole-company aggregate — sums across everyone, not one individual's numbers.
    const completionAll = await computeUserCounts(await db.getApprovedCompletions(), 'submitted_at');
    const approvalAll = await computeUserCounts(await db.getApprovalDecisionStats(), 'decided_at');
    const sumField = (rows, field) => rows.reduce((s, r) => s + r[field], 0);
    const completion = { week: sumField(completionAll, 'week'), month: sumField(completionAll, 'month'), year: sumField(completionAll, 'year'), allTime: sumField(completionAll, 'allTime') };
    const approval = { week: sumField(approvalAll, 'week'), month: sumField(approvalAll, 'month'), year: sumField(approvalAll, 'year'), allTime: sumField(approvalAll, 'allTime') };
    let allDurations = [];
    allDurations = Object.values(await db.getResponseDurationsByUser()).flat();
    const avgResponseDays = allDurations.length > 0 ? allDurations.reduce((a, b) => a + b, 0) / allDurations.length : null;
    let onHoldCount = 0, waitingOnOthersCount = 0, needsActionCount = 0;
    (await db.listAssigneeRowsForOpenTasks()).forEach(row => {
      if (!row.is_released) onHoldCount++;
      else if (row.decision === 'approve' && row.completed_at) waitingOnOthersCount++;
      else needsActionCount++;
    });
    const data = await db.getAllActivityTimestamps();
    const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, total: 0 }));
    ['taskCreated', 'replies', 'submissions', 'approvals'].forEach(key => {
      data[key].forEach(r => { const h = getISTHour(r.created_at); if (!isNaN(h)) hours[h].total++; });
    });
    return res.json({ username: 'all', completion, approval, avgResponseDays, sampleSize: allDurations.length, needsActionCount, onHoldCount, waitingOnOthersCount, peakHours: hours });
  }
  const actingUser = await db.getUser(req.user.username);
  const isHR = actingUser && isHRTeam(actingUser.team);
  const canViewOthers = req.user.role === 'admin' || isHR;
  // The "all" sentinel is handled entirely by the admin-only whole-company branch above — for
  // anyone else (HR included), it must gracefully fall back to their own dashboard, the same
  // as if they'd requested nothing at all, rather than being treated as a literal username to
  // look up (which would incorrectly 404, since no account is actually named "all").
  const username = (canViewOthers && requestedUsername && requestedUsername !== 'all') ? requestedUsername : req.user.username;
  if (username !== req.user.username && !await db.getUser(username)) return res.status(404).json({ error: 'User not found.' });
  const completionAll = await computeUserCounts(await db.getApprovedCompletions(), 'submitted_at');
  const approvalAll = await computeUserCounts(await db.getApprovalDecisionStats(), 'decided_at');
  const completion = completionAll.find(s => s.username === username) || { week: 0, month: 0, year: 0, allTime: 0 };
  const approval = approvalAll.find(s => s.username === username) || { week: 0, month: 0, year: 0, allTime: 0 };

  // Average response time: from being released to actually submitting — a fair "how quickly do
  // I typically act once I'm free to" metric, since it starts counting from release, not from
  // task creation (which could include time this person was on hold and unable to act at all).
  const responseDurations = await db.getMyResponseDurations(username);
  const avgResponseDays = responseDurations.length > 0
    ? responseDurations.reduce((a, b) => a + b, 0) / responseDurations.length
    : null;

  const { openCount: myOpenCount, rows: myRows } = await db.getMyOpenTaskStateCounts(username);
  let onHoldCount = 0, waitingOnOthersCount = 0;
  for (const row of myRows) {
    if (!row.is_released) onHoldCount++;
    else if (row.decision === 'approve' && row.completed_at) waitingOnOthersCount++;
  }
  const needsActionCount = myOpenCount - onHoldCount - waitingOnOthersCount;

  const data = await db.getAllActivityTimestamps();
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
app.get('/api/teams', auth(ALL_ROLES), async (req, res) => res.json(await db.listTeams()));
app.post('/api/teams', auth(['admin']), async (req, res) => {
  const name = str((req.body || {}).name).trim();
  if (!name) return res.status(400).json({ error: 'Department name is required.' });
  if (name.length > 60) return res.status(400).json({ error: 'Department name is too long.' });
  await db.addTeam(name);
  res.json({ ok: true, name });
});
// Never deletes any accounts — anyone in this department just has their Team field cleared,
// same as if it had never been set. Audit-logged since it affects every account in it at once.
app.delete('/api/teams/:name', auth(['admin']), async (req, res) => {
  const name = str(req.params.name).trim();
  if (!(await db.listTeams()).includes(name)) return res.status(404).json({ error: 'Department not found.' });
  const affected = (await db.listUsers()).filter(u => u.team === name).length;
  await db.removeTeam(name);
  await auditFromReq(req, 'department_removed', `Removed department "${name}"${affected > 0 ? ` (unassigned ${affected} account${affected === 1 ? '' : 's'})` : ''}`);
  res.json({ ok: true, affected });
});

/* ============ SEND FOR APPROVAL (document approval requests) ============
   Different model from a regular task: the tagged people directly approve or reject the
   document itself — there's no "submit work" step, since they're deciding, not producing work.
   One rejection kills the request immediately (status: needs_revision); the creator uploads a
   revised document to the SAME request, which resets every reviewer back to pending. */
app.post('/api/approvals', auth(ALL_ROLES), async (req, res) => {
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
  for (const u of reviewers) { if (!await db.getUser(u)) return res.status(400).json({ error: `Unknown user: ${u}` }); }
  const uploadError = validateUploadedFile(fileData, fileName, MAX_FILE_CHARS);
  if (uploadError) return res.status(400).json({ error: uploadError });
  const id = genId('APR');
  await db.createApprovalRequest({ id, title, description, file_data: fileData, file_name: fileName, created_by_username: req.user.username, created_by_name: req.user.name, reviewers });
  for (const u of reviewers) {
    if (u !== req.user.username) await db.createNotification({ username: u, type: 'approval_requested', message: `${req.user.name} sent "${title}" for your approval.`, task_id: null });
  }
  res.json({ ok: true, id });
});
app.get('/api/approvals/mine', auth(ALL_ROLES), async (req, res) => res.json(await db.listApprovalRequestsForUser(req.user.username)));
app.get('/api/approvals', auth(['admin']), async (req, res) => res.json(await db.listAllApprovalRequests()));
app.get('/api/approvals/:id/attachment', auth(ALL_ROLES), async (req, res) => {
  const request = await db.getApprovalRequest(req.params.id);
  if (!request) return res.status(404).json({ error: 'Approval request not found.' });
  const isInvolved = request.created_by_username === req.user.username || req.user.role === 'admin' ||
    (await db.listReviewers(request.id)).some(r => r.username === req.user.username);
  if (!isInvolved) return res.status(403).json({ error: "You're not involved in this approval request." });
  const row = await db.getApprovalFile(req.params.id);
  if (!row || !row.file_data) return res.status(404).json({ error: 'No document on this request.' });
  res.json({ data: row.file_data, name: row.file_name });
});
app.post('/api/approvals/:id/decide', auth(ALL_ROLES), async (req, res) => {
  const request = await db.getApprovalRequest(req.params.id);
  if (!request) return res.status(404).json({ error: 'Approval request not found.' });
  if (request.status !== 'pending') return res.status(400).json({ error: 'This request is not awaiting a decision.' });
  const reviewers = await db.listReviewers(request.id);
  const mine = reviewers.find(r => r.username === req.user.username);
  if (!mine) return res.status(403).json({ error: "You're not tagged as an approver on this request." });
  if (mine.decision) return res.status(400).json({ error: 'You already decided on this request.' });
  const decision = str((req.body || {}).decision);
  if (!['approved', 'rejected'].includes(decision)) return res.status(400).json({ error: 'Decision must be approved or rejected.' });
  const reason = str((req.body || {}).reason).trim();
  if (decision === 'rejected' && reason.length < 5) return res.status(400).json({ error: 'A reason (at least 5 characters) is required to reject.' });
  await db.recordReviewerDecision(request.id, req.user.username, decision, reason);
  if (decision === 'rejected') {
    await db.setApprovalRequestStatus(request.id, 'needs_revision', null);
    await db.addApprovalHistory(request.id, req.user.username, req.user.name, `Rejected: ${reason}`);
    await auditFromReq(req, 'approval_rejected', `Rejected "${request.title}": ${reason}`);
    if (request.created_by_username !== req.user.username) {
      await db.createNotification({ username: request.created_by_username, type: 'approval_rejected', message: `${req.user.name} rejected "${request.title}": ${reason}`, task_id: null });
    }
    return res.json({ ok: true, status: 'needs_revision' });
  }
  await db.addApprovalHistory(request.id, req.user.username, req.user.name, 'Approved');
  const stillPending = (await db.listReviewers(request.id)).some(r => r.decision !== 'approved');
  if (!stillPending) {
    await db.setApprovalRequestStatus(request.id, 'approved', new Date().toISOString());
    await db.addApprovalHistory(request.id, null, null, 'Fully approved by everyone tagged');
    if (request.created_by_username !== req.user.username) {
      await db.createNotification({ username: request.created_by_username, type: 'approval_approved', message: `"${request.title}" is fully approved.`, task_id: null });
    }
  }
  res.json({ ok: true, status: stillPending ? 'pending' : 'approved' });
});
app.post('/api/approvals/:id/revise', auth(ALL_ROLES), async (req, res) => {
  const request = await db.getApprovalRequest(req.params.id);
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
  await db.reviseApprovalRequest(request.id, fileData, fileName);
  await db.resetReviewersForRevision(request.id);
  await db.addApprovalHistory(request.id, req.user.username, req.user.name, `Uploaded a revised document: ${fileName}`);
  const revisedReviewers = await db.listReviewers(request.id);
  for (const r of revisedReviewers) {
    if (r.username !== req.user.username) await db.createNotification({ username: r.username, type: 'approval_requested', message: `${req.user.name} sent a revised "${request.title}" for your approval.`, task_id: null });
  }
  res.json({ ok: true });
});
app.get('/api/reports/approvals', auth(['admin', 'director']), async (req, res) => {
  const stats = await computeUserCounts(await db.getApprovalDecisionStats(), 'decided_at');
  if (req.user.role === 'admin') return res.json(stats);
  const allowed = directorAllowedTeams(await db.getUser(req.user.username));
  res.json(stats.filter(s => allowed.has(s.team)));
});
// Every individual Approve/Reject decision, in full — who decided, what request, who asked
// (the creator), the decision itself, and the exact timestamp. Director-scoped the same way as
// the summary counts above.
app.get('/api/reports/approval-decisions', auth(['admin', 'director']), async (req, res) => {
  let decisions = await db.listApprovalDecisionsDetailed();
  if (req.user.role !== 'admin') {
    const allowed = directorAllowedTeams(await db.getUser(req.user.username));
    const teamByUsername = {};
    (await db.listUsers()).forEach(u => { teamByUsername[u.username] = u.team; });
    decisions = decisions.filter(d => allowed.has(teamByUsername[d.reviewer_username]));
  }
  res.json(decisions);
});

/* ============ PROJECTS & DRAWING LIBRARY ============
   Projects are a lightweight, addable list of names (same pattern as teams/departments) — not a
   full project-management module. Drawings are filed against a project and can be fetched and
   downloaded by anyone who knows the project name. Anyone authenticated can upload or download
   — this is an internal single-company tool, same trust model as the rest of the app. */
app.get('/api/projects', auth(ALL_ROLES), async (req, res) => res.json(await db.listProjects()));
app.post('/api/projects', auth(ALL_ROLES), async (req, res) => {
  const name = str((req.body || {}).name).trim();
  if (!name) return res.status(400).json({ error: 'Project name is required.' });
  if (name.length > 80) return res.status(400).json({ error: 'Project name is too long.' });
  await db.addProject(name);
  res.json({ ok: true, name });
});
app.get('/api/drawing-sections', auth(ALL_ROLES), async (req, res) => res.json(await db.listSections()));
app.get('/api/task-phases', auth(ALL_ROLES), async (req, res) => res.json(await db.listPhases()));
app.get('/api/drawings', auth(ALL_ROLES), async (req, res) => {
  const project = str(req.query.project).trim();
  if (!project) return res.status(400).json({ error: 'A project name is required.' });
  res.json(await db.listDrawingsForProject(project));
});
app.post('/api/drawings', auth(ALL_ROLES), async (req, res) => {
  // Upload restricted to Admin ("Director") or Design team — fetching/downloading stays open
  // to everyone. Anyone else trying to upload gets a clear reason why.
  const actingUser = await db.getUser(req.user.username);
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
  const id = await db.addDrawing({ project, section, title, file_name: fileName, file_data: fileData, uploaded_by_username: req.user.username, uploaded_by_name: req.user.name });
  res.json({ ok: true, id });
});
app.get('/api/drawings/:id/download', auth(ALL_ROLES), async (req, res) => {
  const row = await db.getDrawingFile(req.params.id);
  if (!row || !row.file_data) return res.status(404).json({ error: 'Drawing not found.' });
  res.json({ data: row.file_data, name: row.file_name });
});
app.delete('/api/drawings/:id', auth(ALL_ROLES), async (req, res) => {
  const meta = await db.getDrawingMeta(req.params.id);
  if (!meta) return res.status(404).json({ error: 'Drawing not found.' });
  if (!(req.user.role === 'admin' || meta.uploaded_by_username === req.user.username)) {
    return res.status(403).json({ error: 'Only whoever uploaded this drawing (or Admin) can remove it.' });
  }
  await db.deleteDrawing(req.params.id);
  await auditFromReq(req, 'drawing_removed', `Removed drawing #${req.params.id} from project "${meta.project}"`);
  res.json({ ok: true });
});

// Delegated account creation: a team lead can add a new member to THEIR OWN team without
// needing Admin — mirrors how Mihir Store Management lets a team lead/head add their own
// people. A non-admin lead can only create plain "member" accounts within their own team;
// only Admin can create another Admin, or place someone outside the acting lead's team.
app.post('/api/team/members', auth(ALL_ROLES), async (req, res) => {
  const actingUser = await db.getUser(req.user.username);
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
  if (await db.getUser(username)) return res.status(409).json({ error: 'That username is already taken.' });
  await db.createUser({ username, password_hash: bcrypt.hashSync(password, 10), role, name, team, must_change_password: true });
  res.json({ ok: true, username });
});

// The core of creating a task — the task row, every tagged person (by level), their individual
// deadlines, optional checklist items and follow-up people, and each person's "you were
// tagged" notification — all written through the caller's transaction `tx`. Shared by the
// "+ New Task" form (POST /api/tasks) and bulk CSV/Excel import, so an imported task is
// indistinguishable from one created by hand. Validation happens in the callers, before this.
// `notify: false` skips the per-person notifications (bulk import sends one summary instead).
async function insertTaskRecords(tx, actor, spec, { notify = true } = {}) {
  const { id, title, stageGroups, usersByUsername } = spec;
  await db.createTask({
    id, title, description: spec.description, priority: spec.priority, deadline: spec.deadline,
    created_by: actor.name, created_by_username: actor.username,
    depends_on_task_id: spec.dependsOnTaskId || null, attachment: spec.attachment, attachment_name: spec.attachmentName,
    is_drawing_request: !!spec.isDrawingRequest, parent_task_id: spec.parentTaskId || null,
    project: spec.project || null, phase: spec.phase || null,
  }, tx);
  if (stageGroups.length > 1) await db.setAutoReleaseStages(id, !!spec.autoReleaseStages, tx);
  const tagged = [];
  for (const [idx, group] of stageGroups.entries()) {
    const stageNum = idx + 1;
    const isReleased = stageNum === 1;
    for (const uname of group) {
      const u = usersByUsername[uname];
      await db.addTaskAssignee(id, u.username, u.team, stageNum, isReleased, (spec.individualDeadlines || {})[u.username], tx);
      tagged.push({ username: u.username, stageNum, isReleased });
      if (!notify || u.username === actor.username) continue;
      const message = isReleased
        ? `${actor.name} tagged you on "${title}".`
        : `${actor.name} tagged you on "${title}" — you're on hold for now until Level ${stageNum - 1} finishes their part.`;
      await db.createNotification({ username: u.username, type: 'task_assigned', message, task_id: id }, tx);
    }
  }
  for (const [i, text] of (spec.checklist || []).entries()) await db.addChecklistItem(id, text, i, tx);
  for (const uname of spec.followups || []) {
    await db.addFollowup(id, uname, actor.username, tx);
    if (notify && uname !== actor.username) {
      await db.createNotification({ username: uname, type: 'followup_tagged', message: `${actor.name} asked you to follow up on "${title}".`, task_id: id }, tx);
    }
  }
  return tagged;
}

/* ============ TASKS ============
   Anyone can create a task and tag one or more people on it. A task closes only once everyone
   tagged has completed their part — OR whoever created it (plus Admin, as the one retained
   override) force-closes it early. */
app.post('/api/tasks', auth(ALL_ROLES), async (req, res) => {
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
  // Tagging people is optional — a task can start untagged and have people added later.
  if (!title) return res.status(400).json({ error: 'A title is required.' });
  if (!deadline) return res.status(400).json({ error: 'A deadline is required.' });
  if (!parseDeadline(deadline)) return res.status(400).json({ error: 'Deadline is not a valid date.' });
  if (tooLong(title, 200)) return res.status(400).json({ error: 'Title is too long (max 200 characters).' });
  if (tooLong(description, 5000)) return res.status(400).json({ error: 'Description is too long (max 5000 characters).' });
  if (attachment) {
    const uploadError = validateUploadedFile(attachment, attachmentName, fileLimit);
    if (uploadError) return res.status(400).json({ error: uploadError });
  }
  const uploads = collectUploads(req.body, fileLimit);
  if (uploads.error) return res.status(400).json({ error: uploads.error });
  if (dependsOnTaskId && !await db.getTask(dependsOnTaskId)) return res.status(400).json({ error: 'The task this depends on was not found.' });
  let parentTask = null;
  if (parentTaskId) {
    parentTask = await db.getTask(parentTaskId);
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
      const cursorTask = await db.getTask(cursor);
      if (!cursorTask || !cursorTask.depends_on_task_id) break;
      cursor = cursorTask.depends_on_task_id;
      depth++;
    }
    if (depth >= 500) return res.status(400).json({ error: 'Dependency chain is too long or corrupted.' });
  }
  const usersByUsername = {};
  for (const u of usernames) {
    const user = await db.getUser(u);
    if (!user) return res.status(400).json({ error: `Unknown user: ${u}` });
    usersByUsername[u] = user;
  }
  const id = genId('TASK');
  // Wrapped in a transaction: the task row, every assignee row, and every assignment
  // notification either all commit together or none do — a mid-loop failure (e.g. a database
  // error on one insert) can no longer leave a task half-created with some assignees tagged and
  // others silently missing.
  await db.runInTransaction(async (tx) => {
    await insertTaskRecords(tx, req.user, {
      id, title, description, priority, deadline, dependsOnTaskId, parentTaskId, project, phase,
      attachment, attachmentName, isDrawingRequest, autoReleaseStages, stageGroups, usersByUsername, individualDeadlines,
    });
    if (uploads.files.length) await db.addTaskFiles(id, null, uploads.files, req.user.username, tx);
  });
  // Tell the prerequisite task's creator and assignees that something new now depends on it —
  // clears up "does picking this send a notification?": yes, but only to the task it depends
  // on, not to anyone on the new task itself.
  if (dependsOnTaskId) {
    const prereq = await db.getTask(dependsOnTaskId);
    if (prereq) {
      const notifyTargets = new Set([prereq.created_by_username, ...(await db.listAssignees(dependsOnTaskId)).map(a => a.username)]);
      for (const username of notifyTargets) {
        if (username && username !== req.user.username) {
          await db.createNotification({ username, type: 'task_assigned', message: `"${title}" now depends on "${prereq.title}" finishing first.`, task_id: dependsOnTaskId });
        }
      }
    }
  }
  if (parentTask) {
    const notifyTargets = new Set([parentTask.created_by_username, ...(await db.listAssignees(parentTaskId)).map(a => a.username)]);
    for (const username of notifyTargets) {
      if (username && username !== req.user.username) {
        await db.createNotification({ username, type: 'task_assigned', message: `"${title}" was added as a subtask of "${parentTask.title}" — it must be closed before the main task can close.`, task_id: id });
      }
    }
  }
  await auditFromReq(req, 'task_created', `Created ${parentTask ? 'subtask' : 'task'} "${title}" (${id})${parentTask ? ` under "${parentTask.title}"` : ''}.`);
  res.json({ ok: true, id });
});
/* ============ BULK TASK IMPORT (CSV / Excel) ============
   Two steps, so nothing is ever created by surprise: /preview parses the file and returns every
   row with the people it resolved and any problems; /import re-reads the same file, re-checks
   everything against the live data, and creates all the valid tasks in ONE transaction (all of
   them or none). The importer becomes the creator of every task — the same authority as creating
   them one by one through "+ New Task". */
async function buildImportPlan(body) {
  const parsed = await taskImport.parseImportFile((body || {}).fileData, str((body || {}).fileName));
  const users = await db.listUsers();
  const teams = await db.listTeams();
  const refs = await db.listTaskRefs();
  const plan = taskImport.planImport(parsed.rows, {
    users, teams,
    openTasks: refs.filter(t => t.status === 'open'),
    tasksById: new Map(refs.map(t => [t.id.toUpperCase(), t])),
  });
  // Rows with a Task Key that was imported before update that task instead of duplicating it:
  // only its deadline is changed (people, title etc. stay as they are in the app — they may have
  // been edited there since). A key belonging to a closed/cancelled task is left alone.
  const keyed = plan.plans.filter(p => p.taskKey && p.errors.length === 0);
  const existing = await db.getTasksByImportKeys(Array.from(new Set(keyed.map(p => p.taskKey))));
  const byKey = new Map();
  for (const t of existing) { const cur = byKey.get(t.import_key); if (!cur || (cur.status !== 'open' && t.status === 'open')) byKey.set(t.import_key, t); }
  for (const p of plan.plans) {
    const t = p.taskKey && byKey.get(p.taskKey);
    if (!t) { p.action = 'create'; continue; }
    p.existing = { id: t.id, title: t.title, status: t.status, deadline: t.deadline };
    // Compare with what the FILE said last time, not with the task's current deadline: if the
    // row is the same as last upload but someone moved the deadline inside the app, that app
    // change is kept rather than silently reverted by an unchanged spreadsheet.
    const lastFileDeadline = t.import_deadline || t.deadline;
    if (t.status !== 'open') p.action = 'closed';
    else if (p.deadline && p.deadline !== lastFileDeadline) p.action = 'update';
    else { p.action = 'unchanged'; if (t.deadline !== lastFileDeadline) p.existing.keptAppChange = true; }
  }
  return { parsed, plan };
}
function importCounts(plan) {
  const ok = plan.plans.filter(p => p.errors.length === 0);
  return {
    createCount: ok.filter(p => p.action === 'create').length,
    updateCount: ok.filter(p => p.action === 'update').length,
    unchangedCount: ok.filter(p => p.action === 'unchanged').length,
    closedCount: ok.filter(p => p.action === 'closed').length,
  };
}
function importErrorResponse(res, e) {
  if (e && e.isImportError) return res.status(400).json({ error: e.message });
  log('ERROR', 'task import failed', { error: e && e.message });
  return res.status(500).json({ error: 'Reading the file failed. Check it opens in Excel, then try again.' });
}
app.get('/api/tasks/import/template', auth(ALL_ROLES), async (req, res) => {
  try {
    const users = await db.listUsers();
    if (str(req.query.format) === 'csv') {
      const csv = taskImport.buildTemplateCSV(users);
      return res.json({ name: 'task-import-template.csv', data: 'data:text/csv;base64,' + Buffer.from(csv, 'utf8').toString('base64') });
    }
    const buf = await taskImport.buildTemplateXLSX(users);
    res.json({ name: 'task-import-template.xlsx', data: 'data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,' + buf.toString('base64') });
  } catch (e) { importErrorResponse(res, e); }
});
app.post('/api/tasks/import/preview', auth(ALL_ROLES), async (req, res) => {
  try {
    const { parsed, plan } = await buildImportPlan(req.body);
    res.json({
      totalRows: plan.plans.length, validCount: plan.validCount, errorCount: plan.errorCount, ...importCounts(plan),
      columns: parsed.columns, unknownColumns: parsed.unknownColumns, duplicateColumns: parsed.duplicateColumns, skippedByImportColumn: parsed.skippedByImportColumn,
      rows: plan.plans.map(p => taskImport.planSummary(p, plan.userMap)),
    });
  } catch (e) { importErrorResponse(res, e); }
});
app.post('/api/tasks/import', auth(ALL_ROLES), async (req, res) => {
  let built;
  try { built = await buildImportPlan(req.body); } catch (e) { return importErrorResponse(res, e); }
  const { plan } = built;
  const skipInvalid = !!(req.body || {}).skipInvalid;
  const counts = importCounts(plan);
  if (plan.validCount === 0) return res.status(400).json({ error: 'None of the rows can be imported — fix the problems shown in the preview first.' });
  if (plan.errorCount > 0 && !skipInvalid) {
    return res.status(400).json({ error: `${plan.errorCount} row(s) have problems. Fix them, or choose to import only the ${plan.validCount} valid row(s).` });
  }
  if (counts.createCount + counts.updateCount === 0) return res.json({ ok: true, created: [], updated: [], ...counts, skipped: [] });

  const usedIds = new Set();
  const rowTaskId = new Map(); // rowNumber -> task id (new or existing), for Depends On / Parent Task between rows
  for (const p of plan.plans) if (p.existing) rowTaskId.set(p.rowNumber, p.existing.id);
  const toCreate = plan.order.filter(p => p.errors.length === 0 && p.action === 'create');
  for (const p of toCreate) { let id; do { id = genId('TASK'); } while (usedIds.has(id)); usedIds.add(id); rowTaskId.set(p.rowNumber, id); }
  const refId = r => (!r ? null : r.kind === 'row' ? rowTaskId.get(r.rowNumber) : r.id);
  const bulk = { tasks: [], assignees: [], checklist: [], followups: [] };
  const created = [];
  const taggedByPerson = new Map();
  const note = (u, kind, title, taskId) => {
    if (u === req.user.username) return;
    if (!taggedByPerson.has(u)) taggedByPerson.set(u, { released: [], onHold: [], followup: [], deadline: [], tasks: [] });
    const e = taggedByPerson.get(u); e[kind].push(title); e.tasks.push({ kind, title, taskId });
  };
  for (const p of toCreate) {
    const id = rowTaskId.get(p.rowNumber);
    bulk.tasks.push({ id, title: p.title, description: p.description, priority: p.priority, deadline: p.deadline,
      created_by: req.user.name, created_by_username: req.user.username, depends_on_task_id: refId(p.dependsOn), parent_task_id: refId(p.parent),
      project: p.project, phase: p.phase, auto_release_stages: p.autoReleaseStages && p.stageGroups.length > 1, import_key: p.taskKey || null });
    p.stageGroups.forEach((group, idx) => group.forEach(u => {
      bulk.assignees.push({ task_id: id, username: u, team: (plan.userMap.get(u) || {}).team, stage: idx + 1, is_released: idx === 0, individual_deadline: p.individualDeadlines[u] });
      note(u, idx === 0 ? 'released' : 'onHold', p.title, id);
    }));
    p.checklist.forEach((text, i) => bulk.checklist.push({ task_id: id, text, sort_order: i }));
    p.followups.forEach(u => { bulk.followups.push({ task_id: id, username: u, tagged_by: req.user.username }); note(u, 'followup', p.title, id); });
    created.push({ rowNumber: p.rowNumber, id, title: p.title });
  }
  const toUpdate = plan.plans.filter(p => p.errors.length === 0 && p.action === 'update');
  const updated = toUpdate.map(p => ({ rowNumber: p.rowNumber, id: p.existing.id, title: p.existing.title, from: p.existing.deadline, to: p.deadline }));
  try {
    await db.runInTransaction(async (tx) => {
      await db.bulkInsertTasks(tx, bulk);
      await db.bulkUpdateDeadlines(tx, updated.map(u => ({ id: u.id, deadline: u.to })));
    });
  } catch (e) {
    log('ERROR', 'bulk task import transaction failed', { requestId: req.id, error: e.message });
    return res.status(500).json({ error: 'The import failed and nothing was changed — please try again.' });
  }
  // Notifications after commit. A handful → the normal one-per-task messages; many → one summary
  // per person, so a big import doesn't fire hundreds of phone/WhatsApp alerts at someone.
  try {
    if (updated.length) {
      const assigneeRows = await db.pool.query('SELECT task_id, username, individual_deadline, completed_at FROM task_assignees WHERE task_id = ANY($1::text[])', [updated.map(u => u.id)]);
      const upd = new Map(updated.map(u => [u.id, u]));
      for (const a of assigneeRows.rows) if (!a.completed_at && !a.individual_deadline) note(a.username, 'deadline', `${upd.get(a.task_id).title}" → ${upd.get(a.task_id).to.replace('T', ' ')}`, a.task_id);
    }
    for (const [username, e] of taggedByPerson) {
      if (e.tasks.length <= 3) {
        for (const t of e.tasks) {
          const message = t.kind === 'released' ? `${req.user.name} tagged you on "${t.title}".`
            : t.kind === 'onHold' ? `${req.user.name} tagged you on "${t.title}" — you're on hold for now until the level before you finishes their part.`
            : t.kind === 'deadline' ? `${req.user.name} changed the deadline: "${t.title}.`
            : `${req.user.name} asked you to follow up on "${t.title}".`;
          await db.createNotification({ username, type: t.kind === 'followup' ? 'followup_tagged' : t.kind === 'deadline' ? 'individual_deadline_set' : 'task_assigned', message, task_id: t.taskId });
        }
      } else {
        const parts = [];
        if (e.released.length) parts.push(`tagged you on ${e.released.length} new task(s)`);
        if (e.onHold.length) parts.push(`${e.onHold.length} more where you're on hold until an earlier level finishes`);
        if (e.followup.length) parts.push(`${e.followup.length} to follow up on`);
        if (e.deadline.length) parts.push(`changed the deadline on ${e.deadline.length} of your task(s)`);
        await db.createNotification({ username, type: 'task_assigned', message: `${req.user.name} uploaded a task schedule and ${parts.join(', ')}. Check your task list.`, task_id: null });
      }
    }
  } catch (e) { log('ERROR', 'bulk import notifications failed', { requestId: req.id, error: e.message }); }
  const skipped = plan.plans.filter(p => p.errors.length).map(p => ({ rowNumber: p.rowNumber, title: p.title, errors: p.errors }));
  // Keep this upload as the master copy of the schedule, so it can be downloaded again later with
  // every row's status and timestamps filled in (Export & Archive page).
  try { await db.saveImportFile(str((req.body || {}).fileName) || 'schedule.xlsx', (req.body || {}).fileData, req.user.username); }
  catch (e) { log('ERROR', 'saving schedule master copy failed', { requestId: req.id, error: e.message }); }
  await auditFromReq(req, 'tasks_imported', `Imported "${str((req.body || {}).fileName) || 'a file'}": ${created.length} task(s) created, ${updated.length} deadline(s) changed, ${counts.unchangedCount} unchanged${counts.closedCount ? `, ${counts.closedCount} already closed (left alone)` : ''}${skipped.length ? `, ${skipped.length} row(s) skipped with problems` : ''}.${updated.length ? ' Deadline changes: ' + updated.slice(0, 15).map(u => `${u.id} ${u.from} → ${u.to}`).join('; ') + (updated.length > 15 ? '; …' : '') : ''}`);
  res.json({ ok: true, created: created.sort((a, b) => a.rowNumber - b.rowNumber), updated, unchangedCount: counts.unchangedCount, closedCount: counts.closedCount, skipped });
});
/* ============ HISTORY EXPORT, SCHEDULE TIMESTAMPS, ARCHIVE (Admin) ============ */
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const isLocalDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
// Local calendar date → the instant that day starts / ends in the company's timezone.
const localDayEnd = d => taskExport.deadlineEndsAt(d).toISOString();
const localDayStart = d => new Date(taskExport.deadlineEndsAt(d).getTime() - 86400000 + 60000).toISOString();
async function lookupTasksForSchedule({ keys, titles }) {
  const byKey = new Map(), byTitle = new Map();
  for (const t of await db.getTaskHistory({ keys: Array.from(new Set(keys)) })) {
    const cur = byKey.get(t.import_key);
    if (!cur || (cur.status !== 'open' && t.status === 'open')) byKey.set(t.import_key, t);
  }
  if (titles.length) {
    const counts = new Map();
    const found = await db.getTaskHistory({ titles: Array.from(new Set(titles)) });
    found.forEach(t => counts.set(t.title.toLowerCase(), (counts.get(t.title.toLowerCase()) || 0) + 1));
    found.forEach(t => { if (counts.get(t.title.toLowerCase()) === 1) byTitle.set(t.title.toLowerCase(), t); });
  }
  return { byKey, byTitle };
}
function withTimestampsName(name) {
  const base = String(name || 'schedule.xlsx').replace(/\.(xlsx|xlsm|csv|txt)$/i, '').replace(/ \(with timestamps[^)]*\)$/, '');
  const d = new Date(); const p = n => String(n).padStart(2, '0');
  return `${base} (with timestamps ${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()}).xlsx`;
}
app.get('/api/tasks/history-export', auth(['admin']), async (req, res) => {
  try {
    const mode = str(req.query.mode) === 'all' ? 'all' : 'completed';
    const from = str(req.query.from), to = str(req.query.to), project = str(req.query.project).trim() || null;
    if ((from && !isLocalDate(from)) || (to && !isLocalDate(to))) return res.status(400).json({ error: 'Dates must be YYYY-MM-DD.' });
    const tasks = await db.getTaskHistory({ mode, project, from: from ? localDayStart(from) : null, to: to ? localDayEnd(to) : null });
    const label = `${from || 'start'}_to_${to || new Date().toISOString().slice(0, 10)}`;
    const buf = await taskExport.buildHistoryWorkbook(tasks, { title: `Task history${project ? ' — ' + project : ''}`, from: from ? localDayStart(from) : null, to: to ? localDayEnd(to) : null, mode });
    await auditFromReq(req, 'history_exported', `Exported task history (${mode}, ${label}${project ? ', ' + project : ''}): ${tasks.length} task(s).`);
    res.json({ name: `Task history ${label}${project ? ' ' + project.replace(/[^\w -]+/g, '') : ''}.xlsx`, count: tasks.length, data: `data:${XLSX_MIME};base64,` + buf.toString('base64') });
  } catch (e) { log('ERROR', 'history export failed', { requestId: req.id, error: e.message }); res.status(500).json({ error: 'Export failed — please try again.' }); }
});
app.get('/api/schedules', auth(['admin']), async (req, res) => res.json(await db.listImportFiles()));
app.get('/api/schedules/:id/download', auth(['admin']), async (req, res) => {
  const f = await db.getImportFile(parseInt(req.params.id, 10) || 0);
  if (!f) return res.status(404).json({ error: 'Schedule not found.' });
  if (!/\.(xlsx|xlsm)$/i.test(f.file_name)) return res.status(400).json({ error: 'Timestamps can only be written into Excel (.xlsx) schedules — export the task history instead.' });
  try {
    const { buffer, stats } = await taskExport.fillScheduleTimestamps(taskImport.decodeDataUrl(f.data), lookupTasksForSchedule);
    res.json({ name: withTimestampsName(f.file_name), stats, data: `data:${XLSX_MIME};base64,` + buffer.toString('base64') });
  } catch (e) { if (e.isImportError) return res.status(400).json({ error: e.message }); log('ERROR', 'schedule download failed', { requestId: req.id, error: e.message }); res.status(500).json({ error: 'Building the file failed — please try again.' }); }
});
app.delete('/api/schedules/:id', auth(['admin']), async (req, res) => {
  const n = await db.deleteImportFile(parseInt(req.params.id, 10) || 0);
  if (!n) return res.status(404).json({ error: 'Schedule not found.' });
  await auditFromReq(req, 'schedule_removed', `Removed saved schedule #${req.params.id}.`);
  res.json({ ok: true });
});
// Fill timestamps into any schedule spreadsheet the admin uploads (e.g. one kept on their PC).
app.post('/api/schedules/fill', auth(['admin']), async (req, res) => {
  const { fileData, fileName } = req.body || {};
  if (!/\.(xlsx|xlsm)$/i.test(str(fileName))) return res.status(400).json({ error: 'Choose an Excel (.xlsx) file.' });
  try {
    const { buffer, stats } = await taskExport.fillScheduleTimestamps(taskImport.decodeDataUrl(fileData), lookupTasksForSchedule);
    res.json({ name: withTimestampsName(fileName), stats, data: `data:${XLSX_MIME};base64,` + buffer.toString('base64') });
  } catch (e) { if (e.isImportError) return res.status(400).json({ error: e.message }); log('ERROR', 'schedule fill failed', { requestId: req.id, error: e.message }); res.status(500).json({ error: 'That file couldn\'t be read — save it as .xlsx and try again.' }); }
});
app.get('/api/tasks/archive/preview', auth(['admin']), async (req, res) => {
  const before = str(req.query.before);
  if (!isLocalDate(before)) return res.status(400).json({ error: 'Pick a date.' });
  const ids = await db.listArchivableTaskIds(localDayEnd(before));
  res.json({ count: ids.length, alreadyArchived: await db.countArchivedTasks() });
});
app.post('/api/tasks/archive', auth(['admin']), async (req, res) => {
  const before = str((req.body || {}).before);
  if (!isLocalDate(before)) return res.status(400).json({ error: 'Pick a date.' });
  const ids = await db.listArchivableTaskIds(localDayEnd(before));
  if (!ids.length) return res.json({ ok: true, archived: 0 });
  let archived;
  try { archived = await db.archiveTasks(ids); }
  catch (e) { log('ERROR', 'archiving failed', { requestId: req.id, error: e.message }); return res.status(500).json({ error: 'Removing the tasks failed and nothing was changed — please try again.' }); }
  await auditFromReq(req, 'tasks_archived', `Removed ${archived} completed/cancelled task(s) finished on or before ${before} from the site (history kept for exports and reports).`);
  res.json({ ok: true, archived });
});

app.get('/api/tasks', auth(['admin']), async (req, res) => res.json(await db.listTasksFullLight('all')));
// Minimal open-task list (id + title only, no other details) so EVERY user — not just Admin —
// can pick a company-wide "Depends On" task, since a dependency very often belongs to a
// different team than the one creating the new task. Previously this used each user's own
// task list, so anyone who wasn't Admin almost always saw an empty dropdown.
app.get('/api/tasks/open-titles', auth(ALL_ROLES), async (req, res) => {
  // Includes deadline in the payload so the dropdown can disambiguate tasks that share the same
  // title — e.g. every unedited "Ask for Drawing" task defaults to the literal title "Drawing
  // Request," which made the list look like it only ever showed one confusing repeated entry.
  res.json(await db.listOpenTaskTitles());
});
app.get('/api/tasks/mine', auth(ALL_ROLES), async (req, res) => res.json(await db.listTasksFullLight('user', req.user.username)));
app.get('/api/tasks/:id', auth(ALL_ROLES), async (req, res) => {
  const task = await db.getTaskFull(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  res.json(task);
});
app.get('/api/tasks/:id/attachment', auth(ALL_ROLES), async (req, res) => {
  const task = await db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  if (!(await isInvolvedInTask(req.user, task))) return res.status(403).json({ error: "You're not involved in this task." });
  const row = await db.getTaskAttachment(task.id);
  if (!row || !row.attachment) return res.status(404).json({ error: 'No attachment on this task.' });
  res.json({ data: row.attachment, name: row.attachment_name });
});
app.get('/api/tasks/:id/files/:fileId', auth(ALL_ROLES), async (req, res) => {
  const task = await db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  if (!(await isInvolvedInTask(req.user, task))) return res.status(403).json({ error: "You're not involved in this task." });
  const f = await db.getTaskFile(req.params.fileId);
  if (!f || f.task_id !== task.id || f.reply_id) return res.status(404).json({ error: 'File not found.' });
  res.json({ data: f.data, name: f.name });
});
app.get('/api/tasks/:id/replies/:replyId/files/:fileId', auth(ALL_ROLES), async (req, res) => {
  const task = await db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  if (!(await isInvolvedInTask(req.user, task))) return res.status(403).json({ error: "You're not involved in this task." });
  const f = await db.getTaskFile(req.params.fileId);
  if (!f || f.task_id !== task.id || String(f.reply_id) !== String(req.params.replyId)) return res.status(404).json({ error: 'File not found.' });
  res.json({ data: f.data, name: f.name });
});
app.get('/api/tasks/:id/replies/:replyId/attachment', auth(ALL_ROLES), async (req, res) => {
  const task = await db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  if (!(await isInvolvedInTask(req.user, task))) return res.status(403).json({ error: "You're not involved in this task." });
  const row = await db.getReplyAttachment(req.params.replyId);
  if (!row || row.task_id !== req.params.id || !row.attachment) return res.status(404).json({ error: 'No attachment on this reply.' });
  res.json({ data: row.attachment, name: row.attachment_name });
});
app.post('/api/tasks/:id/reply', auth(ALL_ROLES), async (req, res) => {
  const task = await db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  if (!(await isInvolvedInTask(req.user, task))) return res.status(403).json({ error: "You're not involved in this task, so you can't comment on it." });
  const message = str((req.body || {}).message).trim();
  const { attachment } = req.body || {};
  const attachmentName = str((req.body || {}).attachmentName).trim();
  const replyUploads = collectUploads(req.body, task.is_drawing_request ? MAX_DRAWING_FILE_CHARS : MAX_FILE_CHARS);
  if (replyUploads.error) return res.status(400).json({ error: replyUploads.error });
  if (!message && !attachment && replyUploads.files.length === 0) return res.status(400).json({ error: 'A message or attachment is required.' });
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
  const replyId = await db.addReply(task.id, { by_username: req.user.username, by_name: req.user.name, message, attachment, attachment_name: attachmentName });
  if (replyUploads.files.length) await db.addTaskFiles(task.id, replyId, replyUploads.files, req.user.username);
  // Notify both primary assignees AND anyone tagged for follow-up — follow-up people asked to
  // "keep an eye on this" should hear about replies just like assignees do.
  const notifyTargets = new Set([
    ...(await db.listAssignees(task.id)).map(a => a.username),
    ...(await db.listFollowups(task.id)).map(f => f.username),
  ]);
  for (const u of notifyTargets) {
    if (u !== req.user.username) await db.createNotification({ username: u, type: 'task_reply', message: `${req.user.name} replied on "${task.title}".`, task_id: task.id });
  }
  // @mentions in the comment text: anyone @mentioned who exists as a real account gets notified
  // too, even if they weren't already an assignee or follow-up person — a distinct message so
  // it's clear they were specifically called out, not just part of the general reply notice.
  const mentionedUsernames = new Set();
  const mentionMatches = message.matchAll(/@([a-zA-Z0-9._-]{3,40})/g);
  for (const m of mentionMatches) { if (await db.getUser(m[1])) mentionedUsernames.add(m[1]); }
  for (const u of mentionedUsernames) {
    if (u !== req.user.username && !notifyTargets.has(u)) {
      await db.createNotification({ username: u, type: 'mentioned_in_comment', message: `${req.user.name} mentioned you in a comment on "${task.title}".`, task_id: task.id });
    }
  }
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
app.post('/api/tasks/:id/ask-for-drawing', auth(ALL_ROLES), async (req, res) => {
  const task = await db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  if (task.status !== 'open') return res.status(400).json({ error: 'Task is not open.' });
  const isAssignee = (await db.listAssignees(task.id)).some(a => a.username === req.user.username);
  const isCreator = task.created_by_username === req.user.username;
  if (!(isAssignee || isCreator || req.user.role === 'admin')) {
    return res.status(403).json({ error: "You're not involved in this task yet, so you can't request a drawing on it." });
  }
  const designTeamUsers = (await db.listUsers()).filter(u => (u.team || '').toLowerCase().includes('design'));
  const adminUsers = (await db.listUsers()).filter(u => u.role === 'admin');
  const targets = [...designTeamUsers, ...adminUsers];
  if (targets.length === 0) return res.status(400).json({ error: 'No Design team members or Admin accounts exist yet to tag.' });
  await db.markAsDrawingRequest(task.id);
  for (const u of targets) {
    await db.addTaskAssignee(task.id, u.username, u.team);
    if (u.username !== req.user.username) {
      await db.createNotification({ username: u.username, type: 'task_assigned', message: `${req.user.name} asked for a drawing on "${task.title}" and tagged you.`, task_id: task.id });
    }
  }
  res.json({ ok: true });
});

// Add/remove tagged people on an EXISTING open task — creator/Admin only, since it's a change
// to who's accountable for the work, same authority level as approving or force-closing.
app.post('/api/tasks/:id/assignees', auth(ALL_ROLES), async (req, res) => {
  const task = await db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  if (task.status !== 'open') return res.status(400).json({ error: 'Task is not open.' });
  const isCreator = task.created_by_username && task.created_by_username === req.user.username;
  if (!(req.user.role === 'admin' || isCreator)) return res.status(403).json({ error: 'Only whoever created this task (or Admin) can add people to it.' });
  const rawList = Array.isArray((req.body || {}).usernames) ? req.body.usernames : [];
  const usernames = Array.from(new Set(rawList.map(u => str(u).trim()).filter(Boolean)));
  if (usernames.length === 0) return res.status(400).json({ error: 'Select at least one person to add.' });
  const existing = new Set((await db.listAssignees(task.id)).map(a => a.username));
  let added = 0;
  for (const u of usernames) {
    const user = await db.getUser(u);
    // A bare `return` here previously left the request hanging forever with no response at
    // all — any invalid or already-assigned username in the list would silently freeze the
    // whole request. Skipping just that one username and continuing is both the correct fix
    // and matches how the rest of this loop is meant to behave: add whoever's valid and new,
    // ignore the rest, always send a real response.
    if (!user || existing.has(u)) continue;
    await db.addTaskAssignee(task.id, u, user.team);
    added++;
    await db.createNotification({ username: u, type: 'task_assigned', message: `${req.user.name} tagged you on "${task.title}".`, task_id: task.id });
  }
  res.json({ ok: true, added });
});
// Changes a task's overall deadline — creator or Admin only (same authority as setting it in the
// first place). Everyone on the task is told, reminders restart for the new date, and the change
// (old → new) goes in the audit log.
app.post('/api/tasks/:id/deadline', auth(ALL_ROLES), async (req, res) => {
  const task = await db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  if (task.status !== 'open') return res.status(400).json({ error: 'Only an open task\'s deadline can be changed.' });
  const isCreator = task.created_by_username && task.created_by_username === req.user.username;
  if (!(req.user.role === 'admin' || isCreator)) return res.status(403).json({ error: 'Only whoever created this task (or Admin) can change its deadline.' });
  const deadline = str((req.body || {}).deadline).trim();
  if (!deadline) return res.status(400).json({ error: 'Pick the new deadline.' });
  if (!parseDeadline(deadline)) return res.status(400).json({ error: 'Deadline is not a valid date.' });
  if (deadline === task.deadline) return res.json({ ok: true, unchanged: true });
  const reason = str((req.body || {}).reason).trim();
  if (tooLong(reason, 500)) return res.status(400).json({ error: 'Reason is too long (max 500 characters).' });
  const changed = await db.updateTaskDeadline(task.id, deadline);
  if (!changed) return res.status(409).json({ error: 'This task was just closed or changed by someone else — refresh and try again.' });
  const assignees = await db.listAssignees(task.id);
  for (const a of assignees) {
    if (a.username === req.user.username || a.completed_at) continue;
    await db.createNotification({ username: a.username, type: 'individual_deadline_set',
      message: `${req.user.name} changed the deadline of "${task.title}" to ${deadline.replace('T', ' ')}${a.individual_deadline ? ' (your own individual deadline stays as it was)' : ''}${reason ? ` — ${reason}` : ''}.`, task_id: task.id });
  }
  await auditFromReq(req, 'task_deadline_changed', `Changed deadline of "${task.title}" (${task.id}) from ${task.deadline || 'none'} to ${deadline}${reason ? `: ${reason}` : ''}.`);
  res.json({ ok: true });
});
// Sets or clears one person's individual deadline on an existing task — creator/Admin only,
// same authority level as adding people to a task in the first place.
app.post('/api/tasks/:id/assignees/:username/deadline', auth(ALL_ROLES), async (req, res) => {
  const task = await db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  const isCreator = task.created_by_username && task.created_by_username === req.user.username;
  if (!(req.user.role === 'admin' || isCreator)) return res.status(403).json({ error: 'Only whoever created this task (or Admin) can set an individual deadline.' });
  const assignees = await db.listAssignees(task.id);
  if (!assignees.some(a => a.username === req.params.username)) return res.status(404).json({ error: 'That person is not tagged on this task.' });
  const deadline = str((req.body || {}).deadline).trim();
  if (deadline && !parseDeadline(deadline)) return res.status(400).json({ error: 'Not a valid date.' });
  await db.setIndividualDeadline(task.id, req.params.username, deadline || null);
  if (req.params.username !== req.user.username) {
    await db.createNotification({
      username: req.params.username, type: 'individual_deadline_set',
      message: deadline ? `${req.user.name} set your individual deadline for "${task.title}" to ${deadline}.` : `${req.user.name} cleared your individual deadline for "${task.title}" — the task's overall deadline applies again.`,
      task_id: task.id,
    });
  }
  res.json({ ok: true });
});
app.delete('/api/tasks/:id/assignees/:username', auth(ALL_ROLES), async (req, res) => {
  const task = await db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  if (task.status !== 'open') return res.status(400).json({ error: 'Task is not open.' });
  const isCreator = task.created_by_username && task.created_by_username === req.user.username;
  if (!(req.user.role === 'admin' || isCreator)) return res.status(403).json({ error: 'Only whoever created this task (or Admin) can remove people from it.' });
  const assignees = await db.listAssignees(task.id);
  const target = assignees.find(a => a.username === req.params.username);
  if (!target) return res.status(404).json({ error: 'That person is not tagged on this task.' });
  if (target.submitted_at || target.completed_at) return res.status(400).json({ error: "Can't remove someone who has already submitted or been approved on this task — that's real recorded work and stays on record." });
  await db.removeTaskAssignee(task.id, req.params.username);
  res.json({ ok: true });
});

app.post('/api/tasks/:id/followup', auth(ALL_ROLES), async (req, res) => {
  const task = await db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  const isAssignee = (await db.listAssignees(task.id)).some(a => a.username === req.user.username);
  const isFollowup = (await db.listFollowups(task.id)).some(f => f.username === req.user.username);
  const isCreator = task.created_by_username === req.user.username;
  if (!(isAssignee || isFollowup || isCreator || req.user.role === 'admin')) {
    return res.status(403).json({ error: "You're not involved in this task yet, so you can't tag others for follow-up on it." });
  }
  const rawList = Array.isArray((req.body || {}).usernames) ? req.body.usernames : [];
  const usernames = Array.from(new Set(rawList.map(u => str(u).trim()).filter(Boolean)));
  if (usernames.length === 0) return res.status(400).json({ error: 'Select at least one person to tag for follow-up.' });
  for (const u of usernames) { if (!await db.getUser(u)) return res.status(400).json({ error: `Unknown user: ${u}` }); }
  for (const u of usernames) {
    await db.addFollowup(task.id, u, req.user.username);
    if (u !== req.user.username) {
      await db.createNotification({ username: u, type: 'followup_tagged', message: `${req.user.name} asked you to follow up on "${task.title}".`, task_id: task.id });
    }
  }
  res.json({ ok: true });
});
// Submitting is a REQUEST, not completion — "Mark My Part Done" is gone. An assignee submits
// their part as ready; only the task's creator (or Admin) can actually approve it as done. This
// puts the whole authority to close a task in the creator's hands, exercised either by approving
// every tagged person's part one at a time (which auto-closes once all are approved) or by
// force-closing directly at any time.
app.post('/api/tasks/:id/submit-mine', auth(ALL_ROLES), async (req, res) => {
  const task = await db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  if (task.status !== 'open') return res.status(400).json({ error: 'Task is not open.' });
  const assignees = await db.listAssignees(task.id);
  const mine = assignees.find(a => a.username === req.user.username);
  if (!mine) return res.status(403).json({ error: "You're not tagged on this task." });
  if (!mine.is_released) return res.status(400).json({ error: "You're on hold for now — wait to be released before submitting your part." });
  if (mine.decision === 'approve' && mine.completed_at) return res.status(400).json({ error: 'Your part is already approved.' });
  if (await db.isTaskBlocked(task.id)) return res.status(400).json({ error: "This task depends on another task that isn't closed yet." });
  // A required note describing what was actually done — not a bare click — gives the creator
  // something concrete to check the work against, and discourages submitting to grab an early
  // credit on unfinished work. If the task has a checklist, every item must be checked off
  // first: a real, verifiable signal of progress that a note alone can't fake.
  const note = str((req.body || {}).note).trim();
  if (note.length < 5) return res.status(400).json({ error: 'Briefly describe what you completed (at least 5 characters) before submitting.' });
  const checklist = await db.listChecklistItems(task.id);
  if (checklist.length > 0 && checklist.some(c => !c.is_checked)) {
    return res.status(400).json({ error: 'Check off every checklist item on this task before submitting your part.' });
  }
  await db.markAssigneeSubmitted(task.id, req.user.username, note);
  if (task.created_by_username && task.created_by_username !== req.user.username) {
    await db.createNotification({ username: task.created_by_username, type: 'task_submitted', message: `${req.user.name} submitted their part of "${task.title}" for your approval.`, task_id: task.id });
  }
  res.json({ ok: true });
});
// Approve/reject a specific tagged person's submitted work — restricted to whoever created the
// task, or Admin. Approving is the only thing that actually marks a part "done"; once every
// tagged person is approved, the task closes automatically.
app.post('/api/tasks/:id/approve/:username', auth(ALL_ROLES), async (req, res) => {
  const task = await db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  if (task.status !== 'open') return res.status(400).json({ error: 'Task is not open.' });
  const isCreator = task.created_by_username && task.created_by_username === req.user.username;
  if (!(req.user.role === 'admin' || isCreator)) return res.status(403).json({ error: 'Only whoever created this task (or Admin) can approve work on it.' });
  const assignees = await db.listAssignees(task.id);
  const target = assignees.find(a => a.username === req.params.username);
  if (!target) return res.status(404).json({ error: 'That person is not tagged on this task.' });
  if (target.decision === 'approve' && target.completed_at) return res.status(400).json({ error: 'Already approved — nothing to do.' });
  if (!target.submitted_at) return res.status(400).json({ error: "That person hasn't submitted their part yet — nothing to approve." });
  const didApprove = await db.markAssigneeDone(task.id, req.params.username, req.user.name, 'approve');
  if (!didApprove) return res.status(400).json({ error: 'This was already approved — probably by someone else just now.' });
  if (req.params.username !== req.user.username) {
    await db.createNotification({ username: req.params.username, type: 'task_reply', message: `${req.user.name} approved your part of "${task.title}".`, task_id: task.id });
  }
  // If this approval just completed the stage that person was in, and the creator opted into
  // auto-release for this task, immediately release the next stage (if one exists and isn't
  // already released) — otherwise the creator releases it manually whenever they're ready.
  const stageNum = target.stage || 1;
  if (task.auto_release_stages && await db.isStageFullyApproved(task.id, stageNum) && await db.hasStage(task.id, stageNum + 1) && !await db.isStageReleased(task.id, stageNum + 1)) {
    await db.releaseStage(task.id, stageNum + 1, req.user.name);
    const nextStageAssignees = (await db.listAssignees(task.id)).filter(a => a.stage === stageNum + 1);
    for (const a of nextStageAssignees) {
      await db.createNotification({ username: a.username, type: 'task_assigned', message: `You're released to start your part of "${task.title}".`, task_id: task.id });
    }
  }
  const stillOpen = (await db.listAssignees(task.id)).some(a => !(a.decision === 'approve' && a.completed_at));
  if (!stillOpen) { await db.closeTask(task.id, req.user.name); await releaseDependentsOf(task); }
  await auditFromReq(req, 'task_approved', `Approved ${req.params.username}'s part of "${task.title}"${!stillOpen ? ' — this closed the task, everyone is now approved' : ''}.`);
  res.json({ ok: true, taskClosed: !stillOpen });
});
// Manual stage release — creator/Admin only, for tasks that didn't opt into auto-release, or
// as an override any time. Only allowed once the stage before it is fully approved.
app.post('/api/tasks/:id/release-stage/:stageNum', auth(ALL_ROLES), async (req, res) => {
  const task = await db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  if (task.status !== 'open') return res.status(400).json({ error: 'Task is not open.' });
  const isCreator = task.created_by_username && task.created_by_username === req.user.username;
  if (!(req.user.role === 'admin' || isCreator)) return res.status(403).json({ error: 'Only whoever created this task (or Admin) can release a stage.' });
  const stageNum = parseInt(req.params.stageNum, 10);
  if (!await db.hasStage(task.id, stageNum)) return res.status(404).json({ error: 'That stage does not exist on this task.' });
  if (stageNum > 1 && !await db.isStageFullyApproved(task.id, stageNum - 1)) {
    return res.status(400).json({ error: `Level ${stageNum - 1} isn't fully approved yet.` });
  }
  if (await db.isStageReleased(task.id, stageNum)) return res.status(400).json({ error: `Level ${stageNum} is already released.` });
  const didRelease = await db.releaseStage(task.id, stageNum, req.user.name);
  if (!didRelease) return res.status(400).json({ error: `Level ${stageNum} was already released — probably by someone else just now.` });
  const thisStageAssignees = (await db.listAssignees(task.id)).filter(a => a.stage === stageNum);
  for (const a of thisStageAssignees) {
    await db.createNotification({ username: a.username, type: 'task_assigned', message: `You're released to start your part of "${task.title}".`, task_id: task.id });
  }
  res.json({ ok: true });
});
// Reshuffles a tagged person to a different level (stage) on an existing task — creator/Admin
// only, same authority level as adding people or releasing a stage in the first place. Someone
// who has already completed and been approved at their current level can't be reshuffled (their
// work is done; moving them would leave the task in an inconsistent state), and moving them
// changes their release/on-hold status and escalation clock exactly like a normal stage release
// would, since from their perspective this IS effectively a fresh assignment at a new level.
app.post('/api/tasks/:id/assignees/:username/level', auth(ALL_ROLES), async (req, res) => {
  const task = await db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  if (task.status !== 'open') return res.status(400).json({ error: 'Task is not open.' });
  const isCreator = task.created_by_username && task.created_by_username === req.user.username;
  if (!(req.user.role === 'admin' || isCreator)) return res.status(403).json({ error: 'Only whoever created this task (or Admin) can change someone\'s level.' });

  const assignees = await db.listAssignees(task.id);
  const target = assignees.find(a => a.username === req.params.username);
  if (!target) return res.status(404).json({ error: 'That person is not tagged on this task.' });
  if (target.decision === 'approve' && target.completed_at) {
    return res.status(400).json({ error: `${req.params.username} has already completed and been approved at their current level — can't be reshuffled.` });
  }

  const newLevel = parseInt((req.body || {}).level, 10);
  if (!Number.isInteger(newLevel) || newLevel < 1) return res.status(400).json({ error: 'Level must be a positive whole number.' });
  if (newLevel === target.stage) return res.status(400).json({ error: `${req.params.username} is already at Level ${newLevel}.` });

  const isReleased = newLevel === 1 || await db.isStageFullyApproved(task.id, newLevel - 1);
  const didChange = await db.changeAssigneeStage(task.id, req.params.username, newLevel, isReleased, req.user.name);
  if (!didChange) return res.status(400).json({ error: 'Could not change level — please try again.' });

  await db.createNotification({
    username: req.params.username, type: 'level_changed',
    message: `Your level is now changed to Level ${newLevel} for "${task.title}"${isReleased ? ' — you can start now.' : ` — you're on hold until Level ${newLevel - 1} finishes their part.`}`,
    task_id: task.id,
  });
  await auditFromReq(req, 'assignee_level_changed', `Moved ${req.params.username} to Level ${newLevel} on "${task.title}".`);
  res.json({ ok: true, newLevel, isReleased });
});
app.post('/api/tasks/:id/reject/:username', auth(ALL_ROLES), async (req, res) => {
  const task = await db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  if (task.status !== 'open') return res.status(400).json({ error: 'Task is not open.' });
  const isCreator = task.created_by_username && task.created_by_username === req.user.username;
  if (!(req.user.role === 'admin' || isCreator)) return res.status(403).json({ error: 'Only whoever created this task (or Admin) can reject work on it.' });
  const assignees = await db.listAssignees(task.id);
  const target = assignees.find(a => a.username === req.params.username);
  if (!target) return res.status(404).json({ error: 'That person is not tagged on this task.' });
  if (!target.submitted_at) return res.status(400).json({ error: "That person hasn't submitted anything yet — nothing to reject." });
  const reason = str((req.body || {}).reason).trim();
  if (reason.length < 5) return res.status(400).json({ error: 'A reason (at least 5 characters) is required so the person knows what to fix.' });
  if (!(await db.resetAssigneeSubmission(task.id, req.params.username))) return res.status(400).json({ error: 'This submission was already handled — probably by someone else just now.' });
  await db.addReply(task.id, { by_username: req.user.username, by_name: req.user.name, message: `Rejected ${req.params.username}'s submission: ${reason} — needs to be redone and resubmitted.` });
  if (req.params.username !== req.user.username) {
    await db.createNotification({ username: req.params.username, type: 'task_rejected', message: `${req.user.name} rejected your part of "${task.title}": ${reason} — please redo and resubmit.`, task_id: task.id });
  }
  res.json({ ok: true });
});
// Force-close: restricted to whoever created this specific task, plus Admin as the one
// retained override.
app.post('/api/tasks/:id/close', auth(ALL_ROLES), async (req, res) => {
  const task = await db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  if (task.status !== 'open') return res.status(400).json({ error: 'Task is not open.' });
  const isCreator = task.created_by_username && task.created_by_username === req.user.username;
  if (!(req.user.role === 'admin' || isCreator)) return res.status(403).json({ error: 'Only whoever created this task (or Admin) can force-close it.' });
  if (await db.isTaskBlocked(task.id)) {
    const prereq = await db.getTask(task.depends_on_task_id);
    return res.status(400).json({ error: `This task depends on "${prereq ? prereq.title : task.depends_on_task_id}", which isn't closed yet.` });
  }
  const openSubtasks = await db.listOpenSubtasks(task.id);
  if (openSubtasks.length > 0) {
    return res.status(400).json({ error: `This task has ${openSubtasks.length} open subtask${openSubtasks.length === 1 ? '' : 's'} that must be closed first: ${openSubtasks.map(s => `"${s.title}"`).join(', ')}.` });
  }
  const stillOpenAssignees = (await db.listAssignees(task.id)).filter(a => !(a.decision === 'approve' && a.completed_at));
  const didClose = await db.closeTask(task.id, req.user.name);
  if (!didClose) return res.status(400).json({ error: 'This task was already closed — probably by someone else just now.' });
  await releaseDependentsOf(task);
  if (stillOpenAssignees.length > 0) {
    await auditFromReq(req, 'task_force_closed', `Force-closed "${task.title}" while ${stillOpenAssignees.map(a => a.username).join(', ')} had not yet been approved.`);
  } else {
    await auditFromReq(req, 'task_closed', `Closed "${task.title}" — everyone's part was already approved.`);
  }
  res.json({ ok: true });
});
// Cancel: distinct from closing — for a task that was created by mistake or is being
// abandoned, not one where the work got done. Same authority as force-close (creator or
// Admin), but requires a reason, and never counts toward anyone's completion stats since no
// approval ever happens on a cancelled task.
app.post('/api/tasks/:id/cancel', auth(ALL_ROLES), async (req, res) => {
  const task = await db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  if (task.status !== 'open') return res.status(400).json({ error: 'Task is not open.' });
  const isCreator = task.created_by_username && task.created_by_username === req.user.username;
  if (!(req.user.role === 'admin' || isCreator)) return res.status(403).json({ error: 'Only whoever created this task (or Admin) can cancel it.' });
  const reason = str((req.body || {}).reason).trim();
  if (reason.length < 5) return res.status(400).json({ error: 'A reason (at least 5 characters) is required to cancel a task.' });
  if (!(await db.cancelTask(task.id, req.user.name, reason))) return res.status(400).json({ error: 'This task was already cancelled or closed — probably by someone else just now.' });
  await releaseDependentsOf(task);
  await auditFromReq(req, 'task_cancelled', `Cancelled "${task.title}": ${reason}`);
  const notifyTargets = new Set([
    ...(await db.listAssignees(task.id)).map(a => a.username),
    ...(await db.listFollowups(task.id)).map(f => f.username),
  ]);
  for (const u of notifyTargets) {
    if (u !== req.user.username) await db.createNotification({ username: u, type: 'task_closed', message: `${req.user.name} cancelled "${task.title}": ${reason}`, task_id: task.id });
  }
  res.json({ ok: true });
});
// Genuinely, permanently deletes a task — not a status change like cancel or close. Creator or
// Admin only, and unlike cancel, this works regardless of the task's current status (open,
// closed, or cancelled) since deleting is a cleanup action, not a workflow transition. Any
// subtasks go with it — a subtask can't sensibly outlive a deleted parent — and everyone who
// was tagged or following (across the task and any subtasks swept up with it) is notified
// before their access to it disappears entirely.
app.delete('/api/tasks/:id', auth(ALL_ROLES), async (req, res) => {
  const task = await db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  const isCreator = task.created_by_username && task.created_by_username === req.user.username;
  if (!(req.user.role === 'admin' || isCreator)) return res.status(403).json({ error: 'Only whoever created this task (or Admin) can delete it.' });

  const notifyTargets = new Set([
    ...(await db.listAssignees(task.id)).map(a => a.username),
    ...(await db.listFollowups(task.id)).map(f => f.username),
  ]);
  const deletedIds = await db.deleteTaskCompletely(task.id);
  const subtaskCount = deletedIds.length - 1;
  await auditFromReq(req, 'task_deleted', `Permanently deleted "${task.title}" (${task.id})${subtaskCount > 0 ? ` and ${subtaskCount} subtask(s) with it` : ''}.`);
  for (const u of notifyTargets) {
    if (u !== req.user.username) await db.createNotification({ username: u, type: 'task_deleted', message: `${req.user.name} permanently deleted "${task.title}" — it's no longer on your task list.`, task_id: null });
  }
  res.json({ ok: true, deletedIds });
});
app.post('/api/tasks/:id/reopen', auth(ALL_ROLES), async (req, res) => {
  const task = await db.getTaskFull(req.params.id);
  if (!task || (task.status !== 'closed' && task.status !== 'cancelled')) return res.status(400).json({ error: 'Task is not closed or cancelled.' });
  // Reopening is creator/Admin authority only — same principle as closing itself: whoever
  // created the task (or Admin) is the one accountable for deciding it needs more work, not any
  // tagged assignee.
  const isCreator = task.created_by_username === req.user.username;
  if (!(isCreator || req.user.role === 'admin')) return res.status(403).json({ error: 'Only whoever created this task (or Admin) can reopen it.' });
  const reason = str((req.body || {}).reason).trim();
  if (reason.length < 5) return res.status(400).json({ error: 'A reason (at least 5 characters) is required to reopen a task.' });
  const didReopen = await db.reopenTask(task.id);
  if (!didReopen) return res.status(400).json({ error: 'This task is already open — probably reopened by someone else just now.' });
  for (const a of task.assignees) await db.reopenAssignee(task.id, a.username);
  await auditFromReq(req, 'task_reopened', `Reopened "${task.title}": ${reason}`);
  const reopenAdmins = await db.listAdminUsernames();
  for (const a of reopenAdmins) {
    if (a !== req.user.username) await db.createNotification({ username: a, type: 'task_reopened', message: `${req.user.name} reopened "${task.title}": ${reason}`, task_id: task.id });
  }
  res.json({ ok: true });
});
app.post('/api/tasks/:id/checklist', auth(ALL_ROLES), async (req, res) => {
  const task = await db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  const text = str((req.body || {}).text).trim();
  if (!text) return res.status(400).json({ error: 'Checklist item text is required.' });
  if (tooLong(text, 300)) return res.status(400).json({ error: 'Checklist item is too long (max 300 characters).' });
  const existing = await db.listChecklistItems(task.id);
  await db.addChecklistItem(task.id, text, existing.length);
  res.json({ ok: true });
});
app.post('/api/tasks/:id/checklist/:itemId/toggle', auth(ALL_ROLES), async (req, res) => {
  const item = await db.getChecklistItem(req.params.itemId);
  if (!item || item.task_id !== req.params.id) return res.status(404).json({ error: 'Checklist item not found.' });
  await db.toggleChecklistItem(item.id, !item.is_checked);
  res.json({ ok: true });
});
app.delete('/api/tasks/:id/checklist/:itemId', auth(['admin']), async (req, res) => {
  const item = await db.getChecklistItem(req.params.itemId);
  if (!item || item.task_id !== req.params.id) return res.status(404).json({ error: 'Checklist item not found.' });
  await db.deleteChecklistItem(item.id);
  res.json({ ok: true });
});

/* ============ NOTIFICATIONS ============ */
app.get('/api/notifications', auth(ALL_ROLES), async (req, res) => {
  res.json({ items: await db.listNotifications(req.user.username), unread: await db.countUnreadNotifications(req.user.username) });
});
app.post('/api/notifications/:id/read', auth(ALL_ROLES), async (req, res) => {
  await db.markNotificationRead(req.params.id, req.user.username);
  res.json({ ok: true });
});
app.post('/api/notifications/read-all', auth(ALL_ROLES), async (req, res) => {
  await db.markAllNotificationsRead(req.user.username);
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
async function sendTaskReminders() {
  // Skip anyone whose task is currently blocked on a dependency, or who is on hold in a later
  // stage — they can't act on it yet, so reminding or warning them (or their creator) would be
  // blaming someone for a delay that isn't theirs.
  const allOpenRows = await db.listIncompleteAssigneesForOpenTasks();
  const blockedIds = await db.listBlockedTaskIds();
  const blockedFlags = allOpenRows.map(r => blockedIds.has(r.task_id));
  const rows = allOpenRows.filter((r, idx) => !blockedFlags[idx] && r.is_released);
  let sent = 0;
  for (const r of rows) {
    const hoursSinceLastReminder = r.last_reminded_at ? (Date.now() - new Date(r.last_reminded_at).getTime()) / 3600000 : Infinity;
    if (hoursSinceLastReminder >= REMINDER_INTERVAL_HOURS) {
      await db.createNotification({ username: r.username, type: 'task_reminder', message: `Reminder — "${r.title}" is still open and waiting on your part.`, task_id: r.task_id });
      await db.markTaskAssigneeReminded(r.task_id, r.username);
      sent++;
    }
  }
  return sent;
}
// .unref() on all four background timers below: they still fire exactly as before while the
// server is running (the HTTP listener itself keeps the process alive), but they no longer
// prevent the process from exiting once the server is actually stopped — without this, a
// graceful shutdown (or the test suite closing the server) would hang forever, since these
// intervals alone would keep Node's event loop open indefinitely.
setInterval(sendTaskReminders, REMINDER_INTERVAL_HOURS * 60 * 60 * 1000).unref();

const ESCALATION_CHECK_INTERVAL_HOURS = 1;
async function sendEscalatingTaskReminders() {
  // Same reasoning as sendTaskReminders above — a blocked task's "age" clock keeps ticking in
  // act since the moment it became blocked, so escalating warnings about them specifically would
  // be punishing them for someone else's delay.
  const allEscalationRows = await db.listIncompleteAssigneesForEscalation();
  const escalationBlockedIds = await db.listBlockedTaskIds();
  const escalationBlockedFlags = allEscalationRows.map(r => escalationBlockedIds.has(r.task_id));
  const rows = allEscalationRows.filter((r, idx) => !escalationBlockedFlags[idx] && r.is_released);
  const msPerHour = 3600000;
  const adminUsernames = await db.listAdminUsernames();
  const hrUsernames = (await db.listUsers()).filter(u => isHRTeam(u.team)).map(u => u.username);
  let sent = 0;
  for (const r of rows) {
    // Every clock here starts from escalation_baseline_at specifically — set the moment someone
    // is actually assigned AND released to act (task creation for a Level 1 person, or the exact
    // release moment for anyone in a later stage) — never from when the task itself was created,
    // so someone on hold for days before their stage releases is never penalized for time they
    // couldn't have acted during.
    const hoursElapsed = (Date.now() - new Date(r.escalation_baseline_at).getTime()) / msPerHour;
    const creatorUsername = r.created_by_username;
    const creatorDiffersFromAssignee = creatorUsername && creatorUsername !== r.username;

    // Every 3 hours: a recurring nudge to the person themselves — not a flag to anyone else yet,
    // just repeated until they act. Recurring (not one-time), so it checks time since the LAST
    // reminder, not time since the baseline.
    const lastReminder = r.last_recurring_reminder_at ? new Date(r.last_recurring_reminder_at).getTime() : new Date(r.escalation_baseline_at).getTime();
    const hoursSinceLastReminder = (Date.now() - lastReminder) / msPerHour;
    if (hoursElapsed >= 3 && hoursSinceLastReminder >= 3) {
      await db.createNotification({ username: r.username, type: 'task_reminder_recurring', message: `Reminder — your part of "${r.title}" is still not done.`, task_id: r.task_id });
      await db.markEscalationStage(r.task_id, r.username, 'recurring');
      sent++;
    }

    // 48 hours: an urgent warning — explicitly tells them a flag to Admin is coming if they
    // don't act, but doesn't yet involve anyone else.
    if (hoursElapsed >= 48 && !r.warning_48hr_sent_at) {
      await db.createNotification({ username: r.username, type: 'task_warning_urgent', message: `Urgent — "${r.title}" has been open 48 hours with your part not done. Complete it now, or you will be flagged to Admin.`, task_id: r.task_id });
      if (creatorDiffersFromAssignee) {
        await db.createNotification({ username: creatorUsername, type: 'task_warning_creator', message: `${r.username} has not completed their part of "${r.title}" in 48 hours.`, task_id: r.task_id });
      }
      await db.markEscalationStage(r.task_id, r.username, 48);
      sent++;
    }

    // 60 hours: flags BOTH Admin and HR, naming the task and when it was assigned — a distinct
    // notification from the creator-facing warnings above. The person themselves is deliberately
    // told only that THEY are flagged for THIS task, never that HR/Admin specifically were
    // notified — that visibility detail is intentionally not surfaced to the person being flagged.
    if (hoursElapsed >= 60 && !r.flagged_60hr_sent_at) {
      const assignedDateStr = new Date(r.escalation_baseline_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      const notifiedAlready = new Set([r.username]);
      for (const a of adminUsernames.concat(hrUsernames)) {
        if (notifiedAlready.has(a)) continue;
        notifiedAlready.add(a);
        await db.createNotification({ username: a, type: 'admin_late_flag', message: `${r.username} has not completed "${r.title}" (assigned ${assignedDateStr}) — still incomplete after 60 hours.`, task_id: r.task_id });
      }
      await db.createNotification({ username: r.username, type: 'task_flagged', message: `You are flagged for incompletion of "${r.title}".`, task_id: r.task_id });
      await db.markEscalationStage(r.task_id, r.username, 60);
      sent++;
    }
  }
  return sent;
}
setInterval(sendEscalatingTaskReminders, ESCALATION_CHECK_INTERVAL_HOURS * 60 * 60 * 1000).unref();

// Deadline-based reminders — counting DOWN to a future deadline, the way a calendar app
// reminds you before an event starts, rather than counting UP from creation date. Two nudges
// per task: once when it's within 24 hours of its deadline, and once if the deadline passes
// while it's still open.
async function sendDeadlineReminders() {
  const now = new Date();
  let sent = 0;
  // Task-level: notify the creator once when the OVERALL task deadline passes — Admin/creator
  // cares about the task as a whole, not each tagged person's own individual deadline.
  const tasks = await db.listOpenTasksWithDeadlines();
  const blockedForDeadlines = await db.listBlockedTaskIds();
  for (const t of tasks) {
    const deadlineDate = parseDeadline(t.deadline);
    if (!deadlineDate) continue;
    if (blockedForDeadlines.has(t.id)) continue; // blocked tasks stay exempt from all reminder types
    if (!t.deadline_overdue_notified && isDeadlinePassed(t.deadline, now)) {
      if (t.created_by_username) await db.createNotification({ username: t.created_by_username, type: 'deadline_passed', message: `"${t.title}" has passed its deadline and is still open.`, task_id: t.id });
      await db.markDeadlineOverdueNotified(t.id);
      sent++;
    }
  }
  // Per-person: each assignee's OWN effective deadline (their individual one if set, else the
  // task's overall deadline) drives their own "due soon"/"passed" notifications. For anyone
  // without an individual deadline, this produces exactly the same result as before — the
  // fallback IS the task deadline, so nothing changes for tasks that never used this feature.
  const allDeadlineRows = await db.listIncompleteAssigneesForDeadlineCheck();
  const deadlineBlockedIds = await db.listBlockedTaskIds();
  const deadlineBlockedFlags = allDeadlineRows.map(r => deadlineBlockedIds.has(r.task_id));
  const rows = allDeadlineRows.filter((r, idx) => r.is_released && !deadlineBlockedFlags[idx]);
  for (const r of rows) {
    const effectiveDeadlineStr = r.individual_deadline || r.task_deadline;
    if (!effectiveDeadlineStr) continue;
    const deadlineDate = parseDeadline(effectiveDeadlineStr);
    if (!deadlineDate) continue;
    // Increasingly frequent reminders as the deadline actually nears, replacing the old single
    // "within 24 hours" notice — each tier fires once, independently of the others, so someone
    // who's been on this task for a while still gets a fresh nudge at each real milestone rather
    // than one lone reminder a full day out and then silence until it's overdue.
    const hoursRemaining = (deadlineDate.getTime() - now.getTime()) / 3600000;
    const tiers = [
      { hours: 24, sentAt: r.deadline_reminder_24h_sent_at, label: '24 hours' },
      { hours: 12, sentAt: r.deadline_reminder_12h_sent_at, label: '12 hours' },
      { hours: 6, sentAt: r.deadline_reminder_6h_sent_at, label: '6 hours' },
      { hours: 2, sentAt: r.deadline_reminder_2h_sent_at, label: '2 hours' },
    ];
    for (const tier of tiers) {
      if (!tier.sentAt && hoursRemaining > 0 && hoursRemaining <= tier.hours) {
        await db.createNotification({ username: r.username, type: 'deadline_soon', message: `"${r.title}" is due in about ${tier.label} (${effectiveDeadlineStr}).`, task_id: r.task_id });
        await db.markAssigneeDeadlineTierSent(r.task_id, r.username, tier.hours);
        sent++;
      }
    }
    if (!r.deadline_overdue_notified_at && isDeadlinePassed(effectiveDeadlineStr, now)) {
      const whoseDeadline = r.individual_deadline ? 'your individual deadline' : 'its deadline';
      await db.createNotification({ username: r.username, type: 'deadline_passed', message: `"${r.title}" has passed ${whoseDeadline} and is still open.`, task_id: r.task_id });
      await db.markAssigneeDeadlineOverdueNotified(r.task_id, r.username);
      sent++;
    }
  }
  return sent;
}
setInterval(sendDeadlineReminders, ESCALATION_CHECK_INTERVAL_HOURS * 60 * 60 * 1000).unref();

const WEEKLY_DIGEST_INTERVAL_HOURS = 24 * 7;
async function sendWeeklyWarningDigestToAdmin() {
  const rows = await db.listOutstandingTaskWarnings();
  if (rows.length === 0) return 0;
  const byUser = {};
  rows.forEach(r => { if (!byUser[r.username]) byUser[r.username] = 0; byUser[r.username]++; });
  const ranked = Object.entries(byUser).sort((a, b) => b[1] - a[1]);
  const summary = ranked.map(([username, count]) => `${username} (${count})`).join(', ');
  const admins = (await db.listUsers()).filter(u => u.role === 'admin');
  for (const a of admins) await db.createNotification({ username: a.username, type: 'weekly_warning_digest', message: `Weekly task-warning summary: ${summary}.`, task_id: null });
  return admins.length;
}
setInterval(sendWeeklyWarningDigestToAdmin, WEEKLY_DIGEST_INTERVAL_HOURS * 60 * 60 * 1000).unref();

// Manual triggers — for testing without waiting for the real interval.
app.post('/api/tasks/send-reminders-now', auth(['admin']), async (req, res) => {
  res.json({ ok: true, remindersSent: await sendTaskReminders(), escalationsSent: await sendEscalatingTaskReminders(), deadlineRemindersSent: await sendDeadlineReminders() });
});
app.post('/api/reports/check-period-awards-now', auth(['admin']), async (req, res) => {
  await checkAndSnapshotPeriodAwards();
  res.json({ ok: true });
});
app.post('/api/tasks/send-warning-digest-now', auth(['admin']), async (req, res) => {
  res.json({ ok: true, adminsNotified: await sendWeeklyWarningDigestToAdmin() });
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
  (async () => {
    // The database must be fully initialized (schema created, migrations applied, default
    // accounts seeded) before the server starts accepting real traffic — otherwise the very
    // first request could race against table-creation still in progress.
    await db.init();
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
  })().catch(e => { console.error('Fatal error during startup:', e); process.exit(1); });
}
module.exports = app;
