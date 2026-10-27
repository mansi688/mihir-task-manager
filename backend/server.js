// Business timezone — set BEFORE anything else touches Date. Every deadline, reminder window,
// "today", week and month boundary is calculated in Asia/Kolkata regardless of where the server
// runs (Render runs in UTC: a "17:00" deadline used to be read as 17:00 UTC = 22:30 IST, and
// reminders/overdue flags fired 5.5 hours late).
process.env.TZ = process.env.APP_TIMEZONE || 'Asia/Kolkata';
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
  res.setHeader('X-Request-Id', req.id); // quote this when reporting a problem — it finds the exact log lines
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
  const result = { devices: 0, sent: 0, errors: [] };
  if (!pushConfigured) return result;
  const subs = await db.listPushSubscriptionsForUser(username);
  result.devices = subs.length;
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify({ title, body, taskId: taskId || null }),
        // high urgency = delivered promptly even when the phone is in battery-saving (Doze) mode;
        // TTL = if the phone is off/offline, the push service keeps trying for a day.
        { TTL: 86400, urgency: 'high', timeout: 15000 }
      );
      result.sent++;
    } catch (e) {
      // A 404/410 means the browser itself has invalidated this subscription (uninstalled,
      // permission revoked, etc.) — clean it up instead of retrying it forever.
      // 400/401/403/404/410 are permanent (expired, revoked, or registered with old keys) — remove the device at once
      // so it is never retried. Only temporary errors (429, 5xx, network) keep it.
      if ([400, 401, 403, 404, 410, 413].includes(e.statusCode)) { await db.removePushSubscription(sub.endpoint); result.errors.push(`device removed (${e.statusCode})`); }
      else { console.error(`Push to ${username} failed:`, e.message); result.errors.push(String(e.statusCode || '') + ' ' + e.message); }
    }
  }
  return result;
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
// WhatsApp only for IMPORTANT notifications (each business message costs ≈ ₹0.12–0.15 in India
// since Oct 2026, and routine reminders would flood people's WhatsApp). Everything still goes to
// the in-app bell, web push and the Android app. Override with WHATSAPP_NOTIFY_TYPES (comma list).
const WHATSAPP_NOTIFY_TYPES = new Set(String(process.env.WHATSAPP_NOTIFY_TYPES ||
  'task_assigned,deadline_due_today,deadline_passed,task_overdue_days,task_warning_urgent,task_flagged,admin_late_flag,follow_up')
  .split(',').map(x => x.trim()).filter(Boolean));
// Every notification: web push to the person's devices (+ WhatsApp when important), each channel's
// outcome recorded in notification_deliveries so failures are visible to Admin.
db.setNotificationHook(async ({ username, type, message, task_id, notificationId }) => {
  const user = await db.getUser(username);
  if (!user) return;
  const summary = summarizeNotification(message, 120);
  sendPushToUser(username, 'MIHIR Task Manager', summary, task_id).then(r => {
    if (!r || r.devices === 0) return; // no device subscribed — nothing was attempted
    return db.recordChannelDelivery({ notificationId, recipient: username, taskId: task_id, channel: 'web_push', type,
      status: r.sent > 0 ? 'sent' : 'failed', reason: r.errors.length ? r.errors.join('; ').slice(0, 300) : null });
  }).catch(e => console.error('Push dispatch error:', e.message));
  if (whatsappConfigured && user.phone && WHATSAPP_NOTIFY_TYPES.has(type)) {
    sendWhatsAppMessage(user.phone, summarizeNotification(message, 300))
      .then(() => db.recordChannelDelivery({ notificationId, recipient: username, taskId: task_id, channel: 'whatsapp', type, status: 'sent' }))
      .catch(e => { console.error('WhatsApp dispatch error:', e.message); db.recordChannelDelivery({ notificationId, recipient: username, taskId: task_id, channel: 'whatsapp', type, status: 'failed', reason: e.message.slice(0, 300) }).catch(() => {}); });
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
  // Production default: only this site itself (browsers send no Origin for same-origin page loads,
  // and the Android app loads the same site). Development keeps any origin for local testing.
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
    : (process.env.NODE_ENV === 'production' ? [process.env.APP_BASE_URL || 'https://mihir-task-manager.onrender.com'] : true),
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
// Request bodies: 1MB by default. Only requests carrying a VALID login may send large bodies
// (file attachments, drawings, imports — up to 160MB). This used to be 160MB for every request,
// parsed before any login check: anyone on the internet could exhaust the 512MB server's memory.
// Webhooks (WhatsApp) are verified against the EXACT bytes received, so keep the raw body for them.
const keepRawBody = (req, res, buf) => { if (req.originalUrl.startsWith('/api/integrations/')) req.rawBody = buf; };
const smallJson = express.json({ limit: '1mb', verify: keepRawBody });
const largeJson = express.json({ limit: '160mb', verify: keepRawBody });
app.use((req, res, next) => {
  const len = Number(req.headers['content-length'] || 0);
  if (len <= 1024 * 1024) return smallJson(req, res, next);
  const header = String(req.headers.authorization || '');
  let ok = false;
  if (header.startsWith('Bearer ')) { try { const p = jwt.verify(header.slice(7), JWT_SECRET); ok = p && !p.scope; } catch (e) { ok = false; } }
  if (!ok) return res.status(413).json({ error: 'That upload is too large. Log in again and retry.' });
  return largeJson(req, res, next);
});
// Baseline security headers — conservative choices that don't require auditing the frontend's
// inline scripts/styles (a strict Content-Security-Policy was deliberately NOT added here without
// that audit, since it could silently break this app's vanilla-JS rendering; that's flagged as a
// real follow-up item in PRODUCTION_AUDIT.md rather than shipped untested).
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Microphone/camera allowed for THIS site only (voice tasks, meeting recording, site photos);
  // blocked for anything embedded. (Was microphone=() — which silently broke voice recording.)
  // Geolocation for THIS site only: the opt-in "Start work" location tracking (docs/LOCATION_TRACKING.md).
  res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(self), microphone=(self)');
  if (process.env.NODE_ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
// "no-cache" = the browser may keep a copy but must check with the server (a cheap ETag check)
// before using it. Without it, browsers guess how long to reuse app.js/styles.css, so after a
// deploy one machine can keep running an old cached app.js against the new server and break
// while every other device works fine. Images can still be cached normally.
app.use(express.static(path.join(__dirname, '..', 'frontend'), {
  setHeaders(res, filePath) {
    if (/\.(html|js|css|json)$/i.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
    // Guide videos never change in place (a new video gets a new name), so phones download them once.
    else if (/\.mp4$/i.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=604800');
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
    const key = clientIp(req);
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
// Liveness only: the process is up (never touches the database, so it stays cheap and fast).
app.get('/health', (req, res) => res.json({ status: 'ok' })); // deliberately minimal: public, unauthenticated
// Readiness = the app can actually serve: a real database round-trip (with a 5s cap) and the
// schema migrations applied. (It used to read the users list, which is now served from an
// in-memory cache — it would have said "ready" even with the database down.) No secrets exposed.
async function readiness(req, res) {
  const started = Date.now();
  try {
    const r = await Promise.race([db.ping(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))]);
    res.json({ status: 'ready', database: 'ok', dbLatencyMs: Date.now() - started, schemaVersion: r.schemaVersion, timezone: process.env.TZ, uptimeSec: Math.round(process.uptime()) });
  } catch (e) {
    log('WARN', 'readiness check failed', { requestId: req.id, error: e.message });
    res.status(503).json({ status: 'not ready', database: 'unavailable' });
  }
}
app.get('/ready', readiness);
app.get('/readiness', readiness);
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
// The real client IP. Production traffic reaches the app through Cloudflare and Render's load
// balancer, so the TCP peer (req.ip) is a proxy — every employee looked like ONE address, both in
// the audit log and to the per-IP rate limiter (a busy morning could rate-limit the whole office).
// Cloudflare sets CF-Connecting-IP itself (clients can't forge it through Cloudflare); otherwise
// the left-most X-Forwarded-For entry; locally, the socket address.
function clientIp(req) {
  const cf = str(req.headers['cf-connecting-ip']).trim();
  if (cf) return cf.slice(0, 64);
  const xff = str(req.headers['x-forwarded-for']).split(',')[0].trim();
  if (xff && process.env.TRUST_FORWARDED_FOR !== 'false') return xff.slice(0, 64);
  return (req.ip || '').replace(/^::ffff:/, '');
}
// Centralizes audit logging so every entry automatically captures IP address, device/browser,
// and the actor's department — instead of repeating that lookup at each of the 11 call sites.
async function auditFromReq(req, action, details, actorOverride) {
  const actor = actorOverride || { username: req.user.username, name: req.user.name };
  const actorRecord = await db.getUser(actor.username);
  await db.logAudit({
    actor_username: actor.username,
    actor_name: actor.name,
    actor_team: actorRecord ? actorRecord.team : null,
    action,
    details,
    ip_address: clientIp(req),
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
// Records one task-history event. Never throws: history must not block the action itself — a
// failed write is logged loudly instead. Actor's name and department come from their account.
async function taskEvent(req, taskId, type, details, extra = {}) {
  try {
    const u = req && req.user ? await db.getUser(req.user.username) : null;
    await db.addTaskEvent({
      taskId, type, details, oldValue: extra.old, newValue: extra.new, metadata: extra.meta, source: extra.source || 'web',
      actorUsername: u ? u.username : null, actorName: u ? u.name : (extra.actorName || 'System'), actorTeam: u ? u.team : null,
    }, extra.tx);
  } catch (e) {
    log('ERROR', 'task history write failed', { requestId: req && req.id, taskId, type, error: e.message });
  }
}
const displayName = async (username) => { const u = await db.getUser(username); return u ? u.name : username; };
// Who may see a task (and its history): Admin, Directors, its creator, anyone tagged or following
// it, and team leads of a tagged person's department.
async function canViewTask(user, task) {
  if (user.role === 'admin' || user.role === 'director') return true;
  if (await isInvolvedInTask(user, task)) return true;
  const me = await db.getUser(user.username);
  if (me && me.is_team_lead && me.team) return (await db.listAssignees(task.id)).some(a => a.team === me.team);
  return false;
}
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
// The firm's projects — a new task must pick one.
const PROJECT_OPTIONS = ['Mihir Amara', 'Nyati Equinox', 'Sierra (Tathawade)', 'Mihir Projects'];
// Project heads are always kept informed on every new task of their project (added automatically).
const PROJECT_HEADS = {
  'Mihir Amara': ['suraj.k', 'rahul.p'],
  'Nyati Equinox': ['anil.w', 'siddheshwar.p'],
  'Sierra (Tathawade)': ['dnyaneshwar.k'],
};
// Heads to add for a task: not the creator, not someone already doing the task or already kept informed,
// and only accounts that exist.
async function projectHeadsToAdd(project, creator, alreadyOn) {
  const want = (PROJECT_HEADS[project] || []).filter(u => u !== creator && !alreadyOn.has(u));
  const out = [];
  for (const u of want) if (await db.getUser(u)) out.push(u);
  return out;
}
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
    // Narrow tokens are never logins: phone-app device tokens can ONLY read notifications, and
    // location upload tokens ('loc') can ONLY add points to one work session. Any scoped token is refused.
    if (payload.scope) return res.status(401).json({ error: 'Not logged in.' });
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
   Rooms: 'general' (everyone) and one 'team:<department>' room per department. Every employee can
   read and post in every room — department rooms are where you go to talk to that department.
   Tagging (same idea as task tagging): @username notifies that person, @[Department] notifies
   everyone in that department, @everyone (Admin/Directors only) notifies the whole company.
   A tag notification opens the room it came from.
   Private chats ('p:<id>'): only their members can see them — not the department, not Admin.
   Members are the starter plus everyone tagged in it; tagging a new @person adds them. */
const CHAT_MAX_LEN = 4000;
async function chatDepartments() {
  const fromTeams = (await db.listTeams()).map(t => (t && t.name) || t).filter(Boolean);
  const fromUsers = (await db.listUsers()).map(u => u.team).filter(Boolean);
  return Array.from(new Set([...fromTeams, ...fromUsers])).sort((a, b) => a.localeCompare(b));
}
const privateChatId = (room) => (/^p:(\d{1,9})$/.exec(room) || [])[1];
async function privateRoomInfo(chat) {
  const users = new Map((await db.listUsers()).map(u => [u.username, u]));
  const members = chat.members.map(u => ({ username: u, name: (users.get(u) || {}).name || u }));
  const others = members.filter(m => m.username !== chat.viewer).map(m => m.name.split(' ')[0]);
  const fallback = others.length ? (others.length > 3 ? `${others.slice(0, 3).join(', ')} +${others.length - 3}` : others.join(', ')) : 'Just you';
  return {
    key: `p:${chat.id}`, name: chat.name || fallback, emoji: '🔒', private: true, createdBy: chat.created_by,
    hint: `Private — only ${members.length === 1 ? 'you' : `these ${members.length} people`} can see this chat`, members,
  };
}
async function chatRoomsFor(user) {
  const rooms = [{ key: 'general', name: 'General', emoji: '💬', hint: 'Everyone in the company' }];
  for (const t of await chatDepartments()) {
    rooms.push({ key: `team:${t}`, name: t, emoji: '👥', hint: `${t} department — open to everyone`, mine: !!user.team && user.team === t });
  }
  for (const c of await db.listPrivateChatsFor(user.username)) rooms.push(await privateRoomInfo({ ...c, viewer: user.username }));
  return rooms;
}
async function canUseChatRoom(user, room) {
  if (room === 'general') return true;
  const pid = privateChatId(room);
  if (pid) return db.isPrivateChatMember(pid, user.username); // membership only — no role overrides
  if (!room.startsWith('team:')) return false;
  return (await chatDepartments()).includes(room.slice(5));
}
const canTagEveryone = (user) => user.role === 'admin' || user.role === 'director';
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
  // Tags → notify. Everyone can see every room, so anyone tagged is notified.
  const roomName = room === 'general' ? 'General' : room.startsWith('team:') ? room.slice(5) : 'private chat';
  const allUsers = await db.listUsers();
  const byUsername = new Map(allUsers.map(u => [u.username.toLowerCase(), u]));
  const departments = await chatDepartments();
  const mentioned = new Set();
  const taggedDepartments = new Set();
  let taggedEveryone = false;
  const pid = privateChatId(room);
  // @[Department Name] — brackets allow spaces in the name. (Not in private chats: there only
  // individually tagged people may see the conversation.)
  if (!pid) for (const m of message.matchAll(/@\[([^\]\n]{1,60})\]/g)) {
    const dept = departments.find(d => d.toLowerCase() === m[1].trim().toLowerCase());
    if (dept) taggedDepartments.add(dept);
  }
  // @word — a username, a one-word department name, or @everyone.
  for (const m of message.matchAll(/(^|[^\w@])@([a-zA-Z0-9._-]{2,40})\b/g)) {
    const word = m[2];
    if (word.toLowerCase() === 'everyone') { if (!pid && canTagEveryone(user)) taggedEveryone = true; continue; }
    const u = byUsername.get(word.toLowerCase());
    if (u) { mentioned.add(u.username); continue; }
    if (pid) continue;
    const dept = departments.find(d => d.toLowerCase() === word.toLowerCase());
    if (dept) taggedDepartments.add(dept);
  }
  // Tagging someone in a private chat lets them in (they can then see the whole conversation).
  let addedToPrivate = [];
  if (pid && mentioned.size) addedToPrivate = await db.addPrivateChatMembers(pid, Array.from(mentioned), req.user.username);
  const deptMembers = new Set();
  for (const u of allUsers) {
    if (taggedEveryone || (u.team && taggedDepartments.has(u.team))) deptMembers.add(u.username);
  }
  const snippet = message.length > 80 ? message.slice(0, 79) + '…' : message;
  const notify = new Set([...mentioned, ...deptMembers]);
  notify.delete(req.user.username);
  for (const u of notify) {
    const how = mentioned.has(u) ? (addedToPrivate.includes(u) ? 'added you to a private chat' : 'mentioned you') : taggedEveryone ? 'tagged @everyone' : `tagged your department`;
    const where = pid ? '🔒 a private chat' : `#${roomName}`;
    await db.createNotification({ username: u, type: 'chat_mention', chat_room: room, message: `${req.user.name} ${how} in ${where}: "${snippet}"` });
  }
  mentioned.delete(req.user.username);
  await db.markChatRead(req.user.username, room, id);
  res.json({ id, mentioned: Array.from(mentioned), departments: Array.from(taggedDepartments), everyone: taggedEveryone, notified: notify.size, addedToPrivate });
});
app.post('/api/chat/read', auth(ALL_ROLES), async (req, res) => {
  const room = str((req.body || {}).room).trim() || 'general';
  if (!await canUseChatRoom(await chatUser(req), room)) return res.status(403).json({ error: "You don't have access to this room." });
  await db.markChatRead(req.user.username, room, Number((req.body || {}).lastId) || 0);
  res.json({ ok: true });
});
app.delete('/api/chat/messages/:id', auth(ALL_ROLES), async (req, res) => {
  const msg = await db.getChatMessage(req.params.id);
  if (!msg || msg.deleted_at || !await canUseChatRoom(await chatUser(req), msg.room)) return res.status(404).json({ error: 'Message not found.' });
  if (msg.by_username !== req.user.username && req.user.role !== 'admin') return res.status(403).json({ error: 'You can only delete your own messages.' });
  await db.deleteChatMessage(msg.id);
  if (msg.by_username !== req.user.username) await auditFromReq(req, 'chat_message_deleted', `Deleted a chat message by ${msg.by_name || msg.by_username} in ${msg.room}.`);
  res.json({ ok: true });
});
// Start a private chat with chosen people (individuals only — no departments).
app.post('/api/chat/private', auth(ALL_ROLES), async (req, res) => {
  const body = req.body || {};
  const name = str(body.name).trim().slice(0, 80);
  const wanted = Array.isArray(body.members) ? body.members.map(x => str(x).trim()).filter(Boolean) : [];
  const users = new Map((await db.listUsers()).map(u => [u.username.toLowerCase(), u]));
  const members = Array.from(new Set(wanted.map(w => (users.get(w.toLowerCase()) || {}).username).filter(Boolean))).filter(u => u !== req.user.username);
  if (!members.length) return res.status(400).json({ error: 'Pick at least one person to chat with.' });
  if (members.length > 50) return res.status(400).json({ error: 'A private chat can have at most 50 people.' });
  const id = await db.createPrivateChat({ name, created_by: req.user.username, members });
  for (const u of members) {
    await db.createNotification({ username: u, type: 'chat_mention', chat_room: `p:${id}`, message: `${req.user.name} added you to 🔒 a private chat${name ? ` "${name}"` : ''}.` });
  }
  const chat = await db.getPrivateChat(id);
  res.json(await privateRoomInfo({ ...chat, viewer: req.user.username }));
});
app.post('/api/chat/private/:id/members', auth(ALL_ROLES), async (req, res) => {
  if (!await db.isPrivateChatMember(req.params.id, req.user.username)) return res.status(404).json({ error: 'Chat not found.' });
  const users = new Map((await db.listUsers()).map(u => [u.username.toLowerCase(), u]));
  const wanted = Array.isArray((req.body || {}).members) ? req.body.members : [];
  const names = Array.from(new Set(wanted.map(w => (users.get(str(w).trim().toLowerCase()) || {}).username).filter(Boolean)));
  if (!names.length) return res.status(400).json({ error: 'Pick at least one person to add.' });
  const added = await db.addPrivateChatMembers(req.params.id, names, req.user.username);
  for (const u of added) await db.createNotification({ username: u, type: 'chat_mention', chat_room: `p:${Number(req.params.id)}`, message: `${req.user.name} added you to 🔒 a private chat.` });
  res.json({ added });
});
app.post('/api/chat/private/:id/leave', auth(ALL_ROLES), async (req, res) => {
  if (!await db.isPrivateChatMember(req.params.id, req.user.username)) return res.status(404).json({ error: 'Chat not found.' });
  await db.leavePrivateChat(req.params.id, req.user.username);
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
  await db.createSession({ id: sid, username: user.username, device: req.headers['user-agent'], ip: clientIp(req) });
  // One login = one audit entry. (A front-end bug used to send the same login several times per
  // key press; an old cached copy of the page could still do so until it reloads.)
  if (!(await db.hasRecentAudit(user.username, 'login', clientIp(req), str(req.headers['user-agent']).slice(0, 300), 10))) {
    await auditFromReq(req, 'login', `Logged in.`, { username: user.username, name: user.name });
  }
  const token = sign({ username: user.username, role: user.role, name: user.name, tv: user.token_version || 0, sid });
  res.json({ token, user: { username: user.username, role: user.role, name: user.name, mustChangePassword: !!user.must_change_password, needsGuide: !!user.needs_guide && !user.guide_done_at } });
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
  res.json({ username: user.username, role: user.role, name: user.name, email: user.email, phone: user.phone, team: user.team, designation: user.designation, isTeamLead: !!user.is_team_lead,
    needsGuide: !!user.needs_guide && !user.guide_done_at });
});
// Welcome guide finished (language → video → questions). Score is kept so Admin can see who may need help.
const GUIDE_LANGS = ['en', 'hi', 'mr'];
app.post('/api/auth/guide-complete', auth(ALL_ROLES), async (req, res) => {
  const b = req.body || {};
  const lang = GUIDE_LANGS.includes(b.lang) ? b.lang : null;
  // Skipped: counts as done (it never comes back), recorded without a score so Admin can see who skipped.
  if (b.skipped === true) {
    await db.completeGuide(req.user.username, { lang, score: null, total: null, attempts: 0 });
    await auditFromReq(req, 'guide_skipped', `Skipped the welcome guide${lang ? ` (${({ en: 'English', hi: 'Hindi', mr: 'Marathi' })[lang]})` : ''}.`);
    return res.json({ ok: true, skipped: true });
  }
  const total = Number.isInteger(b.total) && b.total > 0 && b.total <= 20 ? b.total : null;
  const score = Number.isInteger(b.score) && total !== null && b.score >= 0 && b.score <= total ? b.score : null;
  const attempts = Number.isInteger(b.attempts) && b.attempts > 0 && b.attempts <= 50 ? b.attempts : 1;
  if (!lang || total === null || score === null) return res.status(400).json({ error: 'Language and score are required.' });
  await db.completeGuide(req.user.username, { lang, score, total, attempts });
  await auditFromReq(req, 'guide_completed', `Finished the welcome guide in ${({ en: 'English', hi: 'Hindi', mr: 'Marathi' })[lang]} — ${score}/${total} correct${attempts > 1 ? ` (${attempts} tries)` : ''}.`);
  res.json({ ok: true });
});
// Admin: make someone see the welcome guide again on their next visit.
app.post('/api/users/:username/guide-again', auth(['admin']), async (req, res) => {
  const u = await db.getUserFresh(req.params.username);
  if (!u) return res.status(404).json({ error: 'User not found.' });
  await db.requireGuideAgain(u.username);
  await auditFromReq(req, 'guide_reset', `Asked ${u.name} (${u.username}) to watch the welcome guide again.`);
  res.json({ ok: true });
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

// Paged + filtered so the WHOLE history is reachable (it used to show only the newest 200).
// ?limit (<=500) &before_id (next page) &actor &action &q (search) &from &to (YYYY-MM-DD, IST days).
app.get('/api/audit-log', auth(['admin']), async (req, res) => {
  const day = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '') ? d : null;
  const from = day(str(req.query.from)), to = day(str(req.query.to));
  // Backward compatible: without ?format=page this returns the same plain list as before
  // (newest first, default 200). The Audit Log page asks for format=page to get paging + filters.
  const paged = str(req.query.format) === 'page';
  const result = await db.queryAuditLog({
    limit: Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || (paged ? 100 : 200))),
    beforeId: parseInt(req.query.before_id, 10) || null,
    actor: str(req.query.actor).trim() || null,
    action: str(req.query.action).trim() || null,
    q: str(req.query.q).trim().slice(0, 100) || null,
    from: from ? new Date(from + 'T00:00:00+05:30').toISOString() : null,
    to: to ? new Date(to + 'T23:59:59.999+05:30').toISOString() : null,
  });
  res.setHeader('Cache-Control', 'no-store');
  res.json(paged ? result : result.entries);
});

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
    if (u !== req.user.username) await db.createNotification({ username: u, type: 'approval_requested', message: `${req.user.name} sent "${title}" for your approval.`, task_id: null, ref_type: 'approval', ref_id: id });
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
    if (r.username !== req.user.username) await db.createNotification({ username: r.username, type: 'approval_requested', message: `${req.user.name} sent a revised "${request.title}" for your approval.`, task_id: null, ref_type: 'approval', ref_id: request.id });
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
  // History — same transaction as the task itself, so a task can never exist without its creation event.
  const actorRow = await db.getUser(actor.username);
  const ev = (type, details, extra = {}) => db.addTaskEvent({ taskId: id, type, details, actorUsername: actor.username, actorName: actor.name, actorTeam: actorRow ? actorRow.team : null, source: spec.sourceType || 'web', ...extra }, tx);
  const prov = spec.provenance || null;
  const createdDetails = prov
    ? `Task created from ${spec.sourceType} (AI suggestion${prov.confidence != null ? `, ${Math.round(prov.confidence * 100)}% confidence` : ''}${prov.edited ? ', edited' : ''}, approved by ${actor.name}): ${title}`
    : `Task created: ${title}`;
  await ev('CREATED', createdDetails, { newValue: spec.deadline ? `Due ${spec.deadline}` : null, metadata: { priority: spec.priority || 'medium', ...(prov || {}) } });
  for (const t of tagged) await ev('ASSIGNED', `Tagged ${(usersByUsername[t.username] || {}).name || t.username} (Level ${t.stageNum})${t.isReleased ? '' : ' — on hold until the previous level finishes'}`, { metadata: { username: t.username, level: t.stageNum } });
  if (spec.parentTaskId) await db.addTaskEvent({ taskId: spec.parentTaskId, type: 'SUBTASK_CREATED', details: `Subtask created: ${title} (${id})`, actorUsername: actor.username, actorName: actor.name, actorTeam: actorRow ? actorRow.team : null, metadata: { subtask_id: id } }, tx);
  for (const [i, text] of (spec.checklist || []).entries()) await db.addChecklistItem(id, text, i, tx);
  for (const uname of spec.followups || []) {
    await db.addFollowup(id, uname, actor.username, tx);
    if (notify && uname !== actor.username) {
      await db.createNotification({ username: uname, type: 'followup_tagged', message: `${actor.name} asked you to follow up on "${title}".`, task_id: id }, tx);
    }
  }
  // Project heads — always kept informed on their project's tasks.
  const heads = await projectHeadsToAdd(spec.project, actor.username, new Set([...tagged.map(t => t.username), ...(spec.followups || [])]));
  for (const uname of heads) {
    await db.addFollowup(id, uname, actor.username, tx);
    if (notify) await db.createNotification({ username: uname, type: 'followup_tagged', message: `${actor.name} created "${title}" on ${spec.project} — you are kept informed as project head.`, task_id: id }, tx);
  }
  if (heads.length) {
    const names = []; for (const u of heads) { const r = await db.getUser(u); names.push(r ? r.name : u); }
    await ev('FOLLOW_UP', `Kept informed (project head, ${spec.project}): ${names.join(', ')}`, { metadata: { usernames: heads, via: 'project_head' } });
  }
  return tagged;
}

/* ============ TASKS ============
   Anyone can create a task and tag one or more people on it. A task closes only once everyone
   tagged has completed their part — OR whoever created it (plus Admin, as the one retained
   override) force-closes it early. */
// ---- Double-submit protection for creating tasks ----
// A double tap on "Create Task" (or a tap repeated while a slow server is still answering) used to
// create the same task twice. Every New Task form now sends a clientRequestId; the same id never
// creates a second task. Requests without one (an old page still open) are matched on
// person + title + deadline + people within 15 seconds instead.
const taskCreateInFlight = new Map(); // key -> Promise<taskId|null>
function taskCreateKey(req) {
  const b = req.body || {};
  const crid = str(b.clientRequestId).trim().slice(0, 80);
  if (crid) return { key: `${req.user.username}|req|${crid}`, crid };
  const people = (Array.isArray(b.stages) ? b.stages.flatMap(s => (s && Array.isArray(s.usernames)) ? s.usernames : []) : (Array.isArray(b.assignedToList) ? b.assignedToList : [b.assignedTo])).map(u => str(u).trim()).filter(Boolean).sort().join(',');
  return { key: `${req.user.username}|fp|${str(b.title).trim().toLowerCase()}|${str(b.deadline).trim()}|${str(b.parentTaskId).trim()}|${people}`, crid: '' };
}
app.post('/api/tasks', auth(ALL_ROLES), async (req, res) => {
  const { key, crid } = taskCreateKey(req);
  const b = req.body || {};
  // 1. The same request is still being processed — wait for it and answer with its task.
  //    (Checked and claimed with no await in between, so two requests arriving together can't both pass.)
  const running = taskCreateInFlight.get(key);
  if (running) {
    const id = await running;
    if (id) return res.json({ ok: true, id, duplicate: true });
  }
  let done;
  const mine = new Promise(r => { done = r; });
  taskCreateInFlight.set(key, mine);
  let createdId = null;
  const release = () => { done(createdId); setTimeout(() => { if (taskCreateInFlight.get(key) === mine) taskCreateInFlight.delete(key); }, 20000); };
  // 2. Already created earlier (the answer may have been lost on a bad connection).
  let earlier = null;
  try {
    earlier = crid
      ? await db.findTaskByClientRequest(req.user.username, crid)
      : await db.findRecentSameTask(req.user.username, str(b.title).trim(), str(b.deadline).trim(), str(b.parentTaskId).trim(), new Date(Date.now() - 15000).toISOString());
  } catch (e) { earlier = null; }
  if (earlier) { createdId = earlier; release(); return res.json({ ok: true, id: earlier, duplicate: true }); }
  const json = res.json.bind(res);
  res.json = (body) => { if (body && body.ok && body.id) createdId = body.id; return json(body); };
  try {
    await createTaskRoute(req, res, crid);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: 'Could not create the task — please try again.' });
    log('ERROR', 'create task failed', { error: e.message });
  } finally {
    release();
  }
});
async function createTaskRoute(req, res, clientRequestId) {
  const title = str((req.body || {}).title).trim();
  const description = str((req.body || {}).description).trim();
  const priority = ['high', 'medium', 'low'].includes(str((req.body || {}).priority)) ? str((req.body || {}).priority) : 'medium';
  const deadline = str((req.body || {}).deadline).trim();
  const dependsOnTaskId = str((req.body || {}).dependsOnTaskId).trim();
  const parentTaskId = str((req.body || {}).parentTaskId).trim();
  const project = str((req.body || {}).project).trim();
  // Every new task belongs to one of the firm's projects (sub-tasks take their parent's).
  if (!parentTaskId && !PROJECT_OPTIONS.includes(project)) return res.status(400).json({ error: `Pick the project: ${PROJECT_OPTIONS.join(', ')}.` });
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
    if (clientRequestId) await tx.run('UPDATE tasks SET client_request_id=? WHERE id=?', [clientRequestId, id]);
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
}
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
      project: p.project, phase: p.phase, auto_release_stages: p.autoReleaseStages && p.stageGroups.length > 1, import_key: p.taskKey || null, source_ref: str((req.body || {}).fileName).slice(0, 200) || null });
    p.stageGroups.forEach((group, idx) => group.forEach(u => {
      bulk.assignees.push({ task_id: id, username: u, team: (plan.userMap.get(u) || {}).team, stage: idx + 1, is_released: idx === 0, individual_deadline: p.individualDeadlines[u] });
      note(u, idx === 0 ? 'released' : 'onHold', p.title, id);
    }));
    p.checklist.forEach((text, i) => bulk.checklist.push({ task_id: id, text, sort_order: i }));
    p.followups.forEach(u => { bulk.followups.push({ task_id: id, username: u, tagged_by: req.user.username }); note(u, 'followup', p.title, id); });
    const onTask = new Set([...p.stageGroups.flat(), ...p.followups]);
    for (const u of await projectHeadsToAdd(p.project, req.user.username, onTask)) { bulk.followups.push({ task_id: id, username: u, tagged_by: req.user.username }); note(u, 'followup', p.title, id); }
    created.push({ rowNumber: p.rowNumber, id, title: p.title });
  }
  const toUpdate = plan.plans.filter(p => p.errors.length === 0 && p.action === 'update');
  const updated = toUpdate.map(p => ({ rowNumber: p.rowNumber, id: p.existing.id, title: p.existing.title, from: p.existing.deadline, to: p.deadline }));
  try {
    await db.runInTransaction(async (tx) => {
      await db.bulkInsertTasks(tx, bulk);
      await db.bulkUpdateDeadlines(tx, updated.map(u => ({ id: u.id, deadline: u.to })));
      const me = await db.getUser(req.user.username);
      const who = { actorUsername: req.user.username, actorName: req.user.name, actorTeam: me ? me.team : null, source: 'import' };
      const fileName = str((req.body || {}).fileName) || 'a file';
      await db.addTaskEventsBulk(tx, [
        ...bulk.tasks.map(t => ({ ...who, taskId: t.id, type: 'TASK_IMPORTED', details: `Imported from ${fileName}: ${t.title}`, newValue: t.deadline ? `Due ${t.deadline}` : null, metadata: { import_key: t.import_key } })),
        ...bulk.assignees.map(a => ({ ...who, taskId: a.task_id, type: 'ASSIGNED', details: `Tagged ${(plan.userMap.get(a.username) || {}).name || a.username} (Level ${a.stage})`, metadata: { username: a.username, level: a.stage } })),
        ...updated.map(u => ({ ...who, taskId: u.id, type: 'DEADLINE_CHANGED', details: `Deadline changed by re-uploading ${fileName}`, oldValue: u.from, newValue: u.to })),
      ]);
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
  try {
    archived = await db.archiveTasks(ids);
    const me = await db.getUser(req.user.username);
    await db.runInTransaction(tx => db.addTaskEventsBulk(tx, ids.map(id => ({ taskId: id, type: 'ARCHIVED', details: `Removed from task lists (finished on or before ${before}); history kept`, actorUsername: req.user.username, actorName: req.user.name, actorTeam: me ? me.team : null }))));
  }
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
// Tasks this person is only "kept informed" on (not creator, not assigned) — shown under My Tasks → Kept informed.
app.get('/api/tasks/watching', auth(ALL_ROLES), async (req, res) => res.json(await db.listTasksFullLight('watch', req.user.username)));
app.get('/api/tasks/:id', auth(ALL_ROLES), async (req, res) => {
  const task = await db.getTaskFull(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  // Used to return any task to any logged-in user who knew (or guessed) its ID.
  if (!(await canViewTask(req.user, task))) return res.status(403).json({ error: "You're not involved in this task." });
  res.json(task);
});
// Task history: paged + filtered. ?limit (<=100) &cursor &order=asc|desc &type &actor &source &q &from &to
app.get('/api/tasks/:id/events', auth(ALL_ROLES), async (req, res) => {
  const task = await db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  if (!(await canViewTask(req.user, task))) return res.status(403).json({ error: "You're not involved in this task." });
  const day = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '') ? d : null;
  const from = day(str(req.query.from)), to = day(str(req.query.to));
  res.setHeader('Cache-Control', 'no-store');
  res.json(await db.listTaskEvents(task.id, {
    limit: Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25)),
    cursor: str(req.query.cursor) || null, order: str(req.query.order) === 'asc' ? 'asc' : 'desc',
    type: str(req.query.type).trim() || null, actor: str(req.query.actor).trim() || null, source: str(req.query.source).trim() || null,
    q: str(req.query.q).trim().slice(0, 100) || null,
    from: from ? new Date(from + 'T00:00:00+05:30').toISOString() : null, to: to ? new Date(to + 'T23:59:59.999+05:30').toISOString() : null,
  }));
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
  // Someone @mentioned who is not on the task yet is added to "Keep informed", so the task opens for them
  // (they can read it and reply) — before, they got a notification for a task they could not open.
  const addedByMention = [];
  for (const u of mentionedUsernames) {
    if (u !== req.user.username && !notifyTargets.has(u)) {
      if (u !== task.created_by_username) { await db.addFollowup(task.id, u, req.user.username); addedByMention.push(u); }
      await db.createNotification({ username: u, type: 'mentioned_in_comment', message: `${req.user.name} mentioned you in a comment on "${task.title}".`, task_id: task.id });
    }
  }
  if (addedByMention.length) await taskEvent(req, task.id, 'FOLLOW_UP', `Kept informed (mentioned in a comment): ${(await Promise.all(addedByMention.map(displayName))).join(', ')}`, { meta: { usernames: addedByMention, via: 'mention' } });
  await taskEvent(req, task.id, attachmentName ? 'ATTACHMENT_ADDED' : 'COMMENTED', message || (attachmentName ? `Attached ${attachmentName}` : ''), { meta: { reply_id: replyId, ...(attachmentName ? { attachment_name: attachmentName } : {}) } });
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
  await taskEvent(req, task.id, 'DRAWING_REQUESTED', 'Asked the design team for a drawing');
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
  await taskEvent(req, task.id, 'PERSON_ADDED', `Added ${(await Promise.all((Array.isArray(added) ? added : []).map(a => displayName(a && a.username ? a.username : a)))).join(', ')}`, { meta: { usernames: (Array.isArray(added) ? added : []).map(a => (a && a.username) || a) } });
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
  await taskEvent(req, task.id, 'DEADLINE_CHANGED', reason ? `Deadline changed — ${reason}` : 'Deadline changed', { old: task.deadline, new: deadline });
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
  await taskEvent(req, task.id, 'INDIVIDUAL_DEADLINE_CHANGED', `Individual deadline for ${await displayName(req.params.username)}`, { new: deadline || 'removed', meta: { username: req.params.username } });
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
  await taskEvent(req, task.id, 'PERSON_REMOVED', `Removed ${await displayName(req.params.username)}`, { meta: { username: req.params.username } });
  res.json({ ok: true });
});

// "Follow up": anyone involved in the task (its creator, anyone assigned at any level, anyone tagged to be
// kept informed — and Admin/Director) can ask everyone else involved to look into it. People whose part
// is still open are told so; everyone else is asked to look into the task. Each person gets at most one
// follow-up per task every FOLLOW_UP_COOLDOWN_HOURS (default 2), whoever presses it. It is recorded in the
// task history and never changes the task itself (no close/reopen/reassign/deadline).
app.post('/api/tasks/:id/nudge', auth(ALL_ROLES), async (req, res) => {
  const task = await db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  if (task.status !== 'open') return res.status(400).json({ error: 'Only open tasks can be followed up.' });
  if (!(req.user.role === 'director' || await isInvolvedInTask(req.user, task))) {
    return res.status(403).json({ error: 'Only people involved in this task can follow it up.' });
  }
  const assignees = await db.listAssignees(task.id);
  const openPart = new Set(assignees.filter(a => a.is_released && !(a.decision === 'approve' && a.completed_at)).map(a => a.username));
  const involved = new Set([task.created_by_username, ...assignees.map(a => a.username), ...(await db.listFollowups(task.id)).map(f => f.username)].filter(Boolean));
  involved.delete(req.user.username);
  const users = new Map((await db.listUsers()).map(u => [u.username, u]));
  const recipients = [...involved].filter(u => users.has(u));
  if (!recipients.length) return res.status(400).json({ error: 'There is nobody else on this task to follow up.' });
  const from = await displayName(req.user.username);
  const cooldownMs = FOLLOW_UP_COOLDOWN_HOURS * 3600000;
  const now = Date.now();
  const last = await db.lastReminderSentMap(['follow_up'], new Date(now - cooldownMs).toISOString());
  const bucket = Math.floor(now / cooldownMs);
  const sent = [], skipped = [];
  for (const username of recipients) {
    const prev = last.get(`${username}|${task.id}`);
    if (prev) { skipped.push({ username, nextAt: new Date(prev + cooldownMs).toISOString() }); continue; }
    const deliveryId = await db.claimDelivery({ key: `followup:${task.id}:${username}:${bucket}`, recipient: username, taskId: task.id, type: 'follow_up' });
    if (!deliveryId) { skipped.push({ username, nextAt: new Date(now + cooldownMs).toISOString() }); continue; }
    const message = openPart.has(username)
      ? `Follow-up: Your assigned part of "${task.title}" is still open. Please complete it as soon as possible. — ${from}`
      : `Follow-up: ${from} asked everyone on "${task.title}" to look into it.`;
    try {
      const notificationId = await db.createNotification({ username, type: 'follow_up', message, task_id: task.id });
      await db.finishDelivery(deliveryId, { status: 'sent', notificationId });
      sent.push(username);
    } catch (e) {
      await db.finishDelivery(deliveryId, { status: 'failed', reason: e.message.slice(0, 300) });
      log('ERROR', 'follow-up delivery failed', { requestId: req.id, taskId: task.id, recipient: username, error: e.message });
    }
  }
  if (!sent.length) {
    const nextAt = skipped.map(x => x.nextAt).sort()[0];
    return res.status(429).json({ error: `Already followed up recently — the next follow-up is possible after ${new Date(nextAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}.`, nextAt, skipped });
  }
  const names = await Promise.all(sent.map(displayName));
  const skippedNames = await Promise.all(skipped.map(x => displayName(x.username)));
  await taskEvent(req, task.id, 'FOLLOW_UP_SENT', `Follow-up sent to ${names.join(', ')}${skippedNames.length ? ` (not re-sent to ${skippedNames.join(', ')} — followed up less than ${FOLLOW_UP_COOLDOWN_HOURS} h ago)` : ''}`,
    { meta: { recipients: sent, skipped: skipped.map(x => x.username) } });
  res.json({ ok: true, sent, skipped });
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
  await taskEvent(req, task.id, 'FOLLOW_UP', `Follow-up: ${(await Promise.all((usernames || []).map(displayName))).join(', ')}`, { meta: { usernames } });
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
  await taskEvent(req, task.id, 'SUBMITTED', note ? `Submitted their part: ${note}` : 'Submitted their part');
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
  await taskEvent(req, task.id, 'APPROVED', `Approved the part of ${await displayName(req.params.username)}`, { meta: { username: req.params.username } });
    if (!stillOpen) {
      await taskEvent(req, task.id, 'COMPLETED', 'Everyone approved — task closed');
      for (const r of await db.settleClosureRequests(task.id, req.user.username)) {
        if (r.requested_by !== req.user.username) await db.createNotification({ username: r.requested_by, type: 'closure_approved', message: `"${task.title}" is now closed — everyone's part was approved.`, task_id: task.id });
      }
    }
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
  await taskEvent(req, task.id, 'LEVEL_RELEASED', `Released Level ${req.params.stageNum}`, { new: `Level ${req.params.stageNum}` });
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
  await taskEvent(req, task.id, 'LEVEL_CHANGED', `Moved ${await displayName(req.params.username)} to Level ${newLevel}`, { new: `Level ${newLevel}`, meta: { username: req.params.username } });
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
  await taskEvent(req, task.id, 'REJECTED', `Rejected the part of ${await displayName(req.params.username)}${reason ? ': ' + reason : ''}`, { meta: { username: req.params.username } });
  res.json({ ok: true });
});
// Force-close: restricted to whoever created this specific task, plus Admin as the one
// retained override.
// Closing a task by its creator or Admin — shared by the Close button and by approving a closure request.
// Returns { ok: true } or { status, error }.
async function closeTaskByOwner(req, task, how, opts = {}) {
  if (!task) return { status: 404, error: 'Task not found.' };
  if (task.status !== 'open') return { status: 400, error: 'Task is not open.' };
  const isCreator = task.created_by_username && task.created_by_username === req.user.username;
  if (!(req.user.role === 'admin' || isCreator)) return { status: 403, error: 'Only whoever created this task (or Admin) can close it.' };
  if (await db.isTaskBlocked(task.id)) {
    const prereq = await db.getTask(task.depends_on_task_id);
    return { status: 400, error: `This task depends on "${prereq ? prereq.title : task.depends_on_task_id}", which isn't closed yet.` };
  }
  const openSubtasks = await db.listOpenSubtasks(task.id);
  if (openSubtasks.length > 0) {
    return { status: 400, error: `This task has ${openSubtasks.length} open subtask${openSubtasks.length === 1 ? '' : 's'} that must be closed first: ${openSubtasks.map(s => `"${s.title}"`).join(', ')}.` };
  }
  const stillOpenAssignees = (await db.listAssignees(task.id)).filter(a => !(a.decision === 'approve' && a.completed_at));
  const didClose = await db.closeTask(task.id, req.user.name);
  if (!didClose) return { status: 400, error: 'This task was already closed — probably by someone else just now.' };
  await releaseDependentsOf(task);
  if (stillOpenAssignees.length > 0) {
    await auditFromReq(req, 'task_force_closed', `Force-closed "${task.title}"${how ? ` (${how})` : ''} while ${stillOpenAssignees.map(a => a.username).join(', ')} had not yet been approved.`);
  } else {
    await auditFromReq(req, 'task_closed', `Closed "${task.title}"${how ? ` (${how})` : ''} — everyone's part was already approved.`);
  }
  await taskEvent(req, task.id, 'COMPLETED', how ? `Task closed — ${how}` : 'Task closed', { old: 'open', new: 'closed' });
  // anyone still waiting on a closure request for this task gets an answer
  const settled = await db.settleClosureRequests(task.id, req.user.username);
  for (const r of settled) {
    if (r.id !== opts.exceptRequestId && r.requested_by !== req.user.username) await db.createNotification({ username: r.requested_by, type: 'closure_approved', message: `"${task.title}" has been closed by ${req.user.name}.`, task_id: task.id });
  }
  return { ok: true };
}
app.post('/api/tasks/:id/close', auth(ALL_ROLES), async (req, res) => {
  const task = await db.getTask(req.params.id);
  const r = await closeTaskByOwner(req, task, null);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  res.json({ ok: true });
});
// ---- Closure requests ----
// Someone tagged on a task can ask its creator to close it (work finished, no longer needed, a
// duplicate…). The creator — or Admin — approves (the task closes, with the usual close rules) or
// declines with a reason. Everything is notified and written to the task's history.
app.post('/api/tasks/:id/closure-requests', auth(ALL_ROLES), async (req, res) => {
  const task = await db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  if (task.status !== 'open') return res.status(400).json({ error: 'This task is already closed.' });
  const reason = str((req.body || {}).reason).trim();
  if (reason.length < 5) return res.status(400).json({ error: 'Write a short reason (at least 5 characters) so the creator knows why.' });
  if (tooLong(reason, 1000)) return res.status(400).json({ error: 'Reason is too long (max 1000 characters).' });
  if (task.created_by_username === req.user.username) return res.status(400).json({ error: 'You created this task — you can close it yourself with Close Task.' });
  const tagged = (await db.listAssignees(task.id)).some(a => a.username === req.user.username);
  if (!tagged) return res.status(403).json({ error: 'Only people tagged on this task can ask for it to be closed.' });
  if (await db.pendingClosureRequest(task.id, req.user.username)) return res.status(400).json({ error: 'You already asked to close this task — waiting for the creator to decide.' });
  const r = await db.createClosureRequest({ taskId: task.id, username: req.user.username, reason });
  const me = await db.getUser(req.user.username);
  if (task.created_by_username) await db.createNotification({ username: task.created_by_username, type: 'closure_requested', message: `${me ? me.name : req.user.username} asked to close "${task.title}": ${reason.slice(0, 200)}`, task_id: task.id });
  await taskEvent(req, task.id, 'CLOSURE_REQUESTED', `Asked the creator to close this task: ${reason}`);
  await auditFromReq(req, 'closure_requested', `Asked to close "${task.title}" (${task.id}): ${reason.slice(0, 300)}`);
  res.json({ ok: true, request: r });
});
app.get('/api/closure-requests', auth(ALL_ROLES), async (req, res) => {
  const all = req.user.role === 'admin' && req.query.scope === 'all';
  const [toDecide, mine, keptOpen] = await Promise.all([db.listClosureRequestsToDecide(req.user.username, all), db.listMyClosureRequests(req.user.username), db.listClosureRequestsKeptOpen(req.user.username, all)]);
  res.json({ toDecide, mine, keptOpen });
});
async function loadRequestForDecision(req, res) {
  const r = await db.getClosureRequest(Number(req.params.id));
  if (!r) { res.status(404).json({ error: 'Request not found.' }); return null; }
  if (r.status !== 'pending') { res.status(400).json({ error: 'This request has already been answered.' }); return null; }
  const task = await db.getTask(r.task_id);
  if (!task) { res.status(404).json({ error: 'Task not found.' }); return null; }
  const isCreator = task.created_by_username === req.user.username;
  if (!(isCreator || req.user.role === 'admin')) { res.status(403).json({ error: 'Only whoever created this task (or Admin) can decide.' }); return null; }
  return { r, task };
}
app.post('/api/closure-requests/:id/approve', auth(ALL_ROLES), async (req, res) => {
  const x = await loadRequestForDecision(req, res); if (!x) return;
  const note = str((req.body || {}).note).trim().slice(0, 1000);
  const requester = await db.getUser(x.r.requested_by);
  const result = await closeTaskByOwner(req, x.task, `closure requested by ${requester ? requester.name : x.r.requested_by}`, { exceptRequestId: x.r.id });
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  // closeTaskByOwner settled every pending request as 'closed'; mark this one as the approved one
  await db.markClosureApproved(x.r.id, req.user.username, note);
  if (x.r.requested_by !== req.user.username) {
    await db.createNotification({ username: x.r.requested_by, type: 'closure_approved', message: `${req.user.name} approved your request — "${x.task.title}" is now closed.${note ? ` Note: ${note.slice(0, 200)}` : ''}`, task_id: x.task.id });
  }
  res.json({ ok: true });
});
app.post('/api/closure-requests/:id/decline', auth(ALL_ROLES), async (req, res) => {
  const x = await loadRequestForDecision(req, res); if (!x) return;
  const note = str((req.body || {}).note).trim();
  if (note.length < 5) return res.status(400).json({ error: 'Write a reason (at least 5 characters) so they know why the task stays open.' });
  const done = await db.decideClosureRequest(x.r.id, 'declined', req.user.username, note.slice(0, 1000));
  if (!done) return res.status(400).json({ error: 'This request has already been answered.' });
  const requester = await db.getUser(x.r.requested_by);
  await db.createNotification({ username: x.r.requested_by, type: 'closure_declined', message: `${req.user.name} kept "${x.task.title}" open: ${note.slice(0, 200)}`, task_id: x.task.id });
  // Everyone else on the task (assignees at every level, people kept informed) is told too, so nobody
  // treats the task as finished.
  const others = new Set([...(await db.listAssignees(x.task.id)).map(a => a.username), ...(await db.listFollowups(x.task.id)).map(f => f.username)]);
  others.delete(x.r.requested_by); others.delete(req.user.username);
  const askedBy = requester ? requester.name : x.r.requested_by;
  for (const u of others) {
    await db.createNotification({ username: u, type: 'closure_declined', message: `${askedBy} asked to close "${x.task.title}", but ${req.user.name} kept it open: ${note.slice(0, 200)}`, task_id: x.task.id });
  }
  await taskEvent(req, x.task.id, 'CLOSURE_DECLINED', `Declined ${requester ? requester.name : x.r.requested_by}'s request to close: ${note}`);
  await auditFromReq(req, 'closure_declined', `Kept "${x.task.title}" (${x.task.id}) open — declined ${x.r.requested_by}'s closure request: ${note.slice(0, 300)}`);
  res.json({ ok: true });
});
app.post('/api/closure-requests/:id/cancel', auth(ALL_ROLES), async (req, res) => {
  const r = await db.getClosureRequest(Number(req.params.id));
  if (!r) return res.status(404).json({ error: 'Request not found.' });
  if (r.requested_by !== req.user.username) return res.status(403).json({ error: 'Only the person who asked can withdraw it.' });
  const done = await db.decideClosureRequest(r.id, 'cancelled', req.user.username, null);
  if (!done) return res.status(400).json({ error: 'This request has already been answered.' });
  await taskEvent(req, r.task_id, 'CLOSURE_WITHDRAWN', 'Withdrew the request to close this task');
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
  await taskEvent(req, task.id, 'CANCELLED', reason ? `Task cancelled: ${reason}` : 'Task cancelled', { old: 'open', new: 'cancelled' });
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
  await taskEvent(req, task.id, 'DELETED', `Task deleted${(deletedIds || []).length > 1 ? ` (with ${deletedIds.length - 1} subtask(s))` : ''}`, { meta: { deletedIds } });
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
  await taskEvent(req, task.id, 'REOPENED', reason ? `Task reopened: ${reason}` : 'Task reopened', { old: task.status, new: 'open' });
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
  await taskEvent(req, task.id, 'CHECKLIST_ITEM_ADDED', `Checklist item added: ${text}`);
  res.json({ ok: true });
});
app.post('/api/tasks/:id/checklist/:itemId/toggle', auth(ALL_ROLES), async (req, res) => {
  const item = await db.getChecklistItem(req.params.itemId);
  if (!item || item.task_id !== req.params.id) return res.status(404).json({ error: 'Checklist item not found.' });
  await db.toggleChecklistItem(item.id, !item.is_checked);
  await taskEvent(req, req.params.id, 'CHECKLIST_ITEM_TOGGLED', `Checklist item #${req.params.itemId} ticked / unticked`);
  res.json({ ok: true });
});
app.delete('/api/tasks/:id/checklist/:itemId', auth(['admin']), async (req, res) => {
  const item = await db.getChecklistItem(req.params.itemId);
  if (!item || item.task_id !== req.params.id) return res.status(404).json({ error: 'Checklist item not found.' });
  await db.deleteChecklistItem(item.id);
  await taskEvent(req, req.params.id, 'CHECKLIST_ITEM_REMOVED', `Checklist item #${req.params.itemId} removed`);
  res.json({ ok: true });
});

/* ============ NOTIFICATIONS ============ */
app.get('/api/notifications', auth(ALL_ROLES), async (req, res) => {
  const items = await db.listNotifications(req.user.username);
  res.json({ items, unread: await db.countUnreadNotifications(req.user.username), tasks: await db.notificationTaskInfo(req.user.username, items.map(n => n.task_id)),
    refs: await db.notificationRefInfo(req.user.username, items) });
});
app.post('/api/notifications/:id/read', auth(ALL_ROLES), async (req, res) => {
  await db.markNotificationRead(req.params.id, req.user.username);
  res.json({ ok: true });
});
// The Notifications page marks items as seen once they have been on screen for a moment.
app.post('/api/notifications/read', auth(ALL_ROLES), async (req, res) => {
  const ids = Array.isArray((req.body || {}).ids) ? req.body.ids : [];
  if (!ids.length) return res.status(400).json({ error: 'Nothing to mark.' });
  await db.markNotificationsRead(ids, req.user.username);
  res.json({ ok: true, unread: await db.countUnreadNotifications(req.user.username) });
});
// Undo for "mark as seen": puts the notifications back under New.
app.post('/api/notifications/unread', auth(ALL_ROLES), async (req, res) => {
  const ids = Array.isArray((req.body || {}).ids) ? req.body.ids : [];
  if (!ids.length) return res.status(400).json({ error: 'Nothing to undo.' });
  await db.markNotificationsUnread(ids, req.user.username);
  res.json({ ok: true, unread: await db.countUnreadNotifications(req.user.username) });
});
// There is deliberately no "mark all as seen": each notification is seen one by one, so Admin can see who has
// actually read what (below).
app.get('/api/admin/notification-reads', auth(['admin', 'director']), async (req, res) => {
  const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 7));
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const rows = await db.notificationReadSummary(since);
  res.json({ days, people: rows.map(r => ({ ...r, sent: Number(r.sent), seen: Number(r.seen), unseen: Number(r.unseen) })) });
});
app.get('/api/admin/notification-reads/:username', auth(['admin', 'director']), async (req, res) => {
  const u = await db.getUser(req.params.username); if (!u) return res.status(404).json({ error: 'No such person.' });
  res.json({ username: u.username, name: u.name, items: await db.notificationReadsFor(u.username) });
});

/* ============ REMINDER ENGINE (Phase 2) ============
   ONE authoritative engine for every automatic reminder. Each run (every 5 minutes, plus on demand):
     1. COLLECT — every rule proposes messages:
        kept rules : daily "still open" nudge · recurring nudge every 3 h after tagging · 48 h urgent
                     warning (+ creator) · 60 h flag to Admin + HR · 24/12/6/2 h before the deadline ·
                     deadline passed (assignee + creator)
        new rules  : T-3 / T-2 / T-1 at the reminder windows (default 10:00, 14:00, 18:00 IST) ·
                     "due today" · overdue by 3 / 5 / 7 / 12 days (creator copied at 7 and 12)
     2. COMBINE — several messages for the same person + task in one run → ONE message (the most
        important); the rest are recorded as "combined".
     3. SPACE OUT — routine nudges are skipped if that person already got a reminder about that task
        within AUTO_REMINDER_MIN_GAP_HOURS (default 3). Milestones (deadline, overdue, flags) always go.
     4. NEVER TWICE — each message has an idempotency key claimed in notification_deliveries before it
        is sent: restarts, catch-up after the server slept, or two instances can't duplicate it.
   All times are Asia/Kolkata (process TZ). State lives in the database, never in memory. */
// Every automatic reminder and warning goes out only in these daily slots (IST): 9 AM, 3 PM, 6 PM.
// A slot still counts for REMINDER_CATCHUP_HOURS after it starts (the free server may be asleep at the
// exact minute). REMINDER_WINDOWS=none turns slots off (everything sends as soon as it is due).
const REMINDER_WINDOWS = String(process.env.REMINDER_WINDOWS || '09:00,15:00,18:00').split(',').map(s => s.trim()).filter(s => /^\d{1,2}:\d{2}$/.test(s));
const REMINDER_CATCHUP_HOURS = Number(process.env.REMINDER_CATCHUP_HOURS) || 2;
// Slots are 3 hours apart (15:00 → 18:00), so the routine-nudge gap must be shorter than that.
const AUTO_REMINDER_MIN_GAP_HOURS = process.env.AUTO_REMINDER_MIN_GAP_HOURS !== undefined ? Number(process.env.AUTO_REMINDER_MIN_GAP_HOURS) : 2;
// Short enough that a task still open at the next reminder slot (slots are 3 h apart) can be followed up again.
const FOLLOW_UP_COOLDOWN_HOURS = Number(process.env.FOLLOW_UP_COOLDOWN_HOURS) || 2;
const REMINDER_INTERVAL_HOURS = 24;
// Automatic (engine-sent) types — the ones that replace each other per person per task. Follow-ups are
// sent by people and are left alone.
const AUTO_REMINDER_TYPES = ['task_reminder', 'task_reminder_recurring', 'deadline_window', 'deadline_soon', 'deadline_due_today', 'deadline_passed', 'task_overdue_days', 'task_warning_urgent', 'task_warning_creator', 'task_flagged', 'admin_late_flag'];
const REMINDER_TYPES = ['task_reminder', 'task_reminder_recurring', 'deadline_window', 'deadline_soon', 'deadline_due_today', 'deadline_passed', 'task_overdue_days', 'task_warning_urgent', 'task_warning_creator', 'task_flagged', 'admin_late_flag', 'follow_up'];
const pad2 = n => String(n).padStart(2, '0');
const localDateStr = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const dayDiff = (a, b) => Math.round((Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10)) - Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10))) / 86400000);
const fmtDue = dl => { const d = parseDeadline(dl); if (!d) return dl; return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) + (String(dl).includes('T') ? ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : ''); };
// When a deadline actually ends: a date-only deadline ("2026-10-08") lasts the whole day, so it
// ends at 23:59:59 that day — the same rule isDeadlinePassed() uses. (The "due in X hours" tiers used
// to count down to midnight at the START of the day, telling people "due in 2 hours" the evening
// before when they really had the whole next day.)
function deadlineEndInstant(dl) {
  if (!dl) return null;
  if (String(dl).includes('T')) return parseDeadline(dl);
  const d = parseDeadline(dl); if (!d) return null;
  d.setHours(23, 59, 59, 0); return d;
}
// The reminder window that is "now": the latest window at or before now and not older than the
// catch-up period (so a server that slept through 10:00 still sends it at 11:30, but not at 16:00).
function activeReminderWindow(now) {
  let best = null;
  for (const w of REMINDER_WINDOWS) {
    const [h, m] = w.split(':').map(Number);
    const t = new Date(now); t.setHours(h, m, 0, 0);
    if (t <= now && now - t <= REMINDER_CATCHUP_HOURS * 3600000 && (!best || t > best.at)) best = { label: `${pad2(h)}:${pad2(m)}`, at: t };
  }
  return best;
}

async function runReminderEngine(now = new Date(), opts = {}) {
  // Outside the 9 AM / 3 PM / 6 PM slots nothing is sent; anything due waits for the next slot
  // (nothing is marked, so it is picked up then). Admin's "send now" (opts.force) skips this.
  if (REMINDER_WINDOWS.length && !opts.force && !activeReminderWindow(now)) {
    return { remindersSent: 0, escalationsSent: 0, deadlineRemindersSent: 0, combined: 0, suppressed: 0, duplicates: 0, failed: 0, outsideSlot: true };
  }
  const out = []; // { to, taskId, rank, routine, type, message, key, cat, mark }
  const add = (item) => out.push(item);
  const blocked = await db.listBlockedTaskIds();
  const today = localDateStr(now);

  // (a) daily "still open" nudge — routine
  for (const r of await db.listIncompleteAssigneesForOpenTasks()) {
    if (!r.is_released || blocked.has(r.task_id)) continue;
    const since = r.last_reminded_at ? (now - new Date(r.last_reminded_at)) / 3600000 : Infinity;
    if (since >= REMINDER_INTERVAL_HOURS) add({ to: r.username, taskId: r.task_id, rank: 10, routine: true, cat: 'reminder', type: 'task_reminder',
      message: `Reminder — "${r.title}" is still open and waiting on your part.`, key: `daily:${r.task_id}:${r.username}:${today}`,
      mark: () => db.markTaskAssigneeReminded(r.task_id, r.username) });
  }
  // (b) age-based escalation — recurring nudge (routine), 48 h, 60 h (milestones)
  const adminUsernames = await db.listAdminUsernames();
  const hrUsernames = (await db.listUsers()).filter(u => isHRTeam(u.team)).map(u => u.username);
  for (const r of await db.listIncompleteAssigneesForEscalation()) {
    if (!r.is_released || blocked.has(r.task_id) || !r.escalation_baseline_at) continue;
    const hoursElapsed = (now - new Date(r.escalation_baseline_at)) / 3600000;
    const last = r.last_recurring_reminder_at ? new Date(r.last_recurring_reminder_at) : new Date(r.escalation_baseline_at);
    if (hoursElapsed >= 3 && (now - last) / 3600000 >= 3) add({ to: r.username, taskId: r.task_id, rank: 20, routine: true, cat: 'reminder', type: 'task_reminder_recurring',
      message: `Reminder — your part of "${r.title}" is still not done.`, key: `recurring:${r.task_id}:${r.username}:${r.escalation_baseline_at}:${Math.floor(hoursElapsed / 3)}`,
      mark: () => db.markEscalationStage(r.task_id, r.username, 'recurring') });
    const creatorDiffers = r.created_by_username && r.created_by_username !== r.username;
    if (hoursElapsed >= 48 && !r.warning_48hr_sent_at) {
      add({ to: r.username, taskId: r.task_id, rank: 55, cat: 'escalation', type: 'task_warning_urgent',
        message: `Urgent — "${r.title}" has been open 48 hours with your part not done. Complete it now, or you will be flagged to Admin.`,
        key: `esc48:${r.task_id}:${r.username}:${r.escalation_baseline_at}`, mark: () => db.markEscalationStage(r.task_id, r.username, 48) });
      if (creatorDiffers) add({ to: r.created_by_username, taskId: r.task_id, rank: 55, cat: 'escalation', type: 'task_warning_creator',
        message: `${r.username} has not completed their part of "${r.title}" in 48 hours.`, key: `esc48-creator:${r.task_id}:${r.username}:${r.escalation_baseline_at}`, mark: async () => {} });
    }
    if (hoursElapsed >= 60 && !r.flagged_60hr_sent_at) {
      const assigned = new Date(r.escalation_baseline_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      for (const a of new Set(adminUsernames.concat(hrUsernames))) {
        if (a === r.username) continue;
        add({ to: a, taskId: r.task_id, rank: 90, cat: 'escalation', type: 'admin_late_flag', message: `${r.username} has not completed "${r.title}" (assigned ${assigned}) — still incomplete after 60 hours.`,
          key: `esc60-admin:${r.task_id}:${r.username}:${a}:${r.escalation_baseline_at}`, mark: async () => {} });
      }
      add({ to: r.username, taskId: r.task_id, rank: 85, cat: 'escalation', type: 'task_flagged', message: `You are flagged for incompletion of "${r.title}".`,
        key: `esc60:${r.task_id}:${r.username}:${r.escalation_baseline_at}`, mark: () => db.markEscalationStage(r.task_id, r.username, 60) });
    }
  }
  // (c) deadline rules — overall task overdue (creator), per-person tiers / overdue, windows, due today, overdue days
  for (const t of await db.listOpenTasksWithDeadlines()) {
    if (blocked.has(t.id) || !parseDeadline(t.deadline)) continue;
    if (!t.deadline_overdue_notified && isDeadlinePassed(t.deadline, now)) {
      if (t.created_by_username) add({ to: t.created_by_username, taskId: t.id, rank: 75, cat: 'deadline', type: 'deadline_passed',
        message: `"${t.title}" has passed its deadline and is still open.`, key: `overdue-creator:${t.id}:${t.deadline}`, mark: () => db.markDeadlineOverdueNotified(t.id) });
      else await db.markDeadlineOverdueNotified(t.id);
    }
  }
  const win = activeReminderWindow(now);
  const creatorOverdueCopies = new Set();
  for (const r of await db.listIncompleteAssigneesForDeadlineCheck()) {
    if (!r.is_released || blocked.has(r.task_id)) continue;
    const dl = r.individual_deadline || r.task_deadline;
    const dlDate = deadlineEndInstant(dl);
    if (!dl || !dlDate) continue;
    const hoursRemaining = (dlDate - now) / 3600000;
    for (const tier of [{ h: 24, at: r.deadline_reminder_24h_sent_at, rank: 45 }, { h: 12, at: r.deadline_reminder_12h_sent_at, rank: 50 }, { h: 6, at: r.deadline_reminder_6h_sent_at, rank: 60 }, { h: 2, at: r.deadline_reminder_2h_sent_at, rank: 70 }]) {
      if (!tier.at && hoursRemaining > 0 && hoursRemaining <= tier.h) add({ to: r.username, taskId: r.task_id, rank: tier.rank, cat: 'deadline', type: 'deadline_soon',
        message: `"${r.title}" is due in about ${tier.h} hours (${dl}).`, key: `tier${tier.h}:${r.task_id}:${r.username}:${dl}`,
        mark: () => db.markAssigneeDeadlineTierSent(r.task_id, r.username, tier.h) });
    }
    const passed = isDeadlinePassed(dl, now);
    if (!r.deadline_overdue_notified_at && passed) add({ to: r.username, taskId: r.task_id, rank: 75, cat: 'deadline', type: 'deadline_passed',
      message: `Overdue: "${r.title}" has passed ${r.individual_deadline ? 'your individual deadline' : 'its deadline'} and is still open.`,
      key: `overdue:${r.task_id}:${r.username}:${dl}`, mark: () => db.markAssigneeDeadlineOverdueNotified(r.task_id, r.username) });
    if (!win) continue;
    const daysLeft = dayDiff(String(dl).slice(0, 10), today);
    if (daysLeft >= 1 && daysLeft <= 3) {
      const text = daysLeft === 3 ? 'Reminder: 3 days remain to complete this task.' : daysLeft === 2 ? 'Reminder: Only 2 days remain to complete this task.' : 'Urgent: This task is due tomorrow.';
      add({ to: r.username, taskId: r.task_id, rank: daysLeft === 1 ? 48 : 30, routine: true, cat: 'reminder', type: 'deadline_window',
        message: `${text} "${r.title}" — due ${fmtDue(dl)}. Your part is still open.`, key: `window:${r.task_id}:${r.username}:${today}:${win.label}`, mark: async () => {} });
    } else if (daysLeft === 0 && !passed) {
      add({ to: r.username, taskId: r.task_id, rank: 65, cat: 'deadline', type: 'deadline_due_today',
        message: `Due today: Please complete this task — "${r.title}" (due ${fmtDue(dl)}).`, key: `duetoday:${r.task_id}:${r.username}:${dl}`, mark: async () => {} });
    } else if (passed && [3, 5, 7, 12].includes(-daysLeft)) {
      const n = -daysLeft;
      add({ to: r.username, taskId: r.task_id, rank: 80, cat: 'escalation', type: 'task_overdue_days',
        message: `Overdue by ${n} days: "${r.title}" (due ${fmtDue(dl)}) — your part is still open.`, key: `overdue${n}d:${r.task_id}:${r.username}:${dl}`, mark: async () => {} });
      if ((n === 7 || n === 12) && r.created_by_username && r.created_by_username !== r.username && !creatorOverdueCopies.has(`${r.task_id}:${n}`)) {
        creatorOverdueCopies.add(`${r.task_id}:${n}`);
        add({ to: r.created_by_username, taskId: r.task_id, rank: 80, cat: 'escalation', type: 'task_overdue_days',
          message: `"${r.title}" is overdue by ${n} days and still open.`, key: `overdue${n}d-creator:${r.task_id}:${dl}`, mark: async () => {} });
      }
    }
  }
  const stats = await flushReminderOutbox(out, now);
  try { stats.deliveryReminders = await runDeliveryReminders(now, win); } catch (e) { log('ERROR', 'delivery reminders failed', { error: e.message }); }
  return stats;
}
// Deliveries due today (or late) and deliveries waiting for unloading remind the tagged site team at the
// same 9 AM / 3 PM / 6 PM slots — one card per person per delivery, replaced at each slot.
async function runDeliveryReminders(now, win) {
  const today = localDateStr(now);
  const slot = win ? win.label : `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  let sent = 0;
  for (const d of await db.listOpenDeliveriesForReminders()) {
    const due = String(d.expected_at || '').slice(0, 10);
    if (!due) continue;
    let message = null;
    const required = String(d.required_docs == null ? 'challan,signed_challan' : d.required_docs).split(',').filter(Boolean);
    const missing = required.filter(k => DELIVERY_DOC[k] && DELIVERY_DOC[k].dir === 'from_site' && !(d.docs_present || []).includes(k));
    if (d.status === 'unloaded') {
      if (!missing.length) continue;
      message = `Documents pending: "${d.title}" (${d.ref}) — upload ${missing.map(k => DELIVERY_DOC[k].label.toLowerCase()).join(', ')} for head office.`;
    } else if (d.status === 'delivered') message = `Unloading pending: "${d.title}" (${d.ref}) — upload the unloading photos once it is unloaded.`;
    else if (due < today) message = `Late delivery: "${d.title}" (${d.ref}) was due ${fmtDue(d.expected_at)} — upload the delivery photos when it arrives, or tell the purchase team.`;
    else if (due === today) message = `Delivery due today: "${d.title}" (${d.ref})${String(d.expected_at).includes('T') ? ` at ${String(d.expected_at).slice(11, 16)}` : ''} — upload the delivery photos when it arrives.`;
    if (!message) continue;
    for (const u of String(d.receivers || '').split(',').filter(Boolean)) {
      const id = await db.claimDelivery({ key: `dlvrem:${d.id}:${u}:${today}:${slot}`, recipient: u, taskId: d.task_id, type: 'delivery_reminder' });
      if (!id) continue;
      try {
        await db.removeEarlierDeliveryReminders(u, d.ref);
        const notificationId = await db.createNotification({ username: u, type: 'delivery_reminder', message, task_id: d.task_id || null });
        await db.finishDelivery(id, { status: 'sent', notificationId, sentAt: now.toISOString() });
        sent++;
      } catch (e) { await db.finishDelivery(id, { status: 'failed', reason: e.message.slice(0, 300) }); }
    }
  }
  return sent;
}

async function flushReminderOutbox(out, now) {
  const stats = { remindersSent: 0, escalationsSent: 0, deadlineRemindersSent: 0, combined: 0, suppressed: 0, duplicates: 0, failed: 0 };
  const groups = new Map();
  for (const it of out) { const k = `${it.to}|${it.taskId}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(it); }
  const lastSent = await db.lastReminderSentMap(REMINDER_TYPES, new Date(now - 24 * 3600000).toISOString());
  for (const [gk, items] of groups) {
    items.sort((a, b) => b.rank - a.rank);
    // Anti-spam applies to every ROUTINE message individually: if this person got a reminder about
    // this task within the gap, routine nudges are skipped — milestones are never held back.
    const gapActive = AUTO_REMINDER_MIN_GAP_HOURS > 0 && lastSent.has(gk) && now - lastSent.get(gk) < AUTO_REMINDER_MIN_GAP_HOURS * 3600000;
    const held = gapActive ? items.filter(i => i.routine) : [];
    for (const it of held) { await db.recordSkippedDelivery({ key: it.key, recipient: it.to, taskId: it.taskId, type: it.type, reason: `anti-spam: a reminder was sent less than ${AUTO_REMINDER_MIN_GAP_HOURS} h ago` }); await it.mark(); }
    stats.suppressed += held.length;
    const candidates = gapActive ? items.filter(i => !i.routine) : items;
    if (!candidates.length) continue;
    // Take the most important message that has NOT been handled before (an earlier run may already
    // have sent the top one — e.g. "due today" at 10:00 — and the 6-hour warning must still go).
    let primary = null, deliveryId = null;
    for (const it of candidates) {
      const id = await db.claimDelivery({ key: it.key, recipient: it.to, taskId: it.taskId, type: it.type });
      if (id) { primary = it; deliveryId = id; break; }
      stats.duplicates++;
    }
    if (!primary) continue; // everything for this person + task was already handled
    try {
      // Replace this person's earlier automatic reminder/warning about the same task (one card per task).
      await db.removeEarlierAutoNotifications(primary.to, primary.taskId, AUTO_REMINDER_TYPES);
      const notificationId = await db.createNotification({ username: primary.to, type: primary.type, message: primary.message, task_id: primary.taskId });
      await db.finishDelivery(deliveryId, { status: 'sent', notificationId, sentAt: now.toISOString() });
      lastSent.set(gk, now.getTime());
    } catch (e) {
      await db.finishDelivery(deliveryId, { status: 'failed', reason: e.message.slice(0, 300) });
      log('ERROR', 'reminder delivery failed', { key: primary.key, recipient: primary.to, taskId: primary.taskId, error: e.message });
      stats.failed++;
      continue; // not marked — retried on the next run
    }
    for (const it of candidates.slice(candidates.indexOf(primary))) {
      if (it !== primary) { await db.recordSkippedDelivery({ key: it.key, recipient: it.to, taskId: it.taskId, type: it.type, reason: `combined into ${primary.key}` }); stats.combined++; }
      try { await it.mark(); } catch (e) { log('ERROR', 'reminder mark failed', { key: it.key, error: e.message }); }
    }
    if (primary.cat === 'reminder') stats.remindersSent++; else if (primary.cat === 'escalation') stats.escalationsSent++; else stats.deadlineRemindersSent++;
  }
  return stats;
}

// (Scheduling: the REMINDER_RUN job — see JOB ENGINE below.)
// Every 5 minutes. Safe to restart at any time: everything it needs is in the database.



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

// Manual triggers — for testing without waiting for the real interval.
app.post('/api/tasks/send-reminders-now', auth(['admin']), async (req, res) => {
  // Optional ?at=<ISO time> (Admin) runs the engine as if it were that moment — used to verify windows.
  const at = str((req.body || {}).at || req.query.at);
  // With ?at= it behaves exactly like the scheduled run at that moment (slots apply); without it, Admin
  // is asking to send right now, so the 9 AM / 3 PM / 6 PM slots are skipped.
  const valid = at && !isNaN(new Date(at));
  const now = valid ? new Date(at) : new Date();
  res.json({ ok: true, ...(await runReminderEngine(now, { force: !valid })) });
});
// Admin: background jobs (queued / running / completed / failed / retrying / dead-letter) and retry.
app.get('/api/admin/jobs', auth(['admin']), async (req, res) => {
  const status = ['queued', 'running', 'completed', 'failed', 'retrying', 'dead_letter', 'cancelled'].includes(str(req.query.status)) ? str(req.query.status) : null;
  res.json({ counts: await jobs.counts(), jobs: await jobs.list({ status, limit: Math.min(500, parseInt(req.query.limit, 10) || 100) }) });
});
app.post('/api/admin/jobs/:id/retry', auth(['admin']), async (req, res) => {
  const ok = await jobs.retry(parseInt(req.params.id, 10) || 0);
  if (!ok) return res.status(400).json({ error: 'Only failed, retrying or dead-letter jobs can be retried.' });
  await auditFromReq(req, 'job_retried', `Retried background job #${req.params.id}.`);
  res.json({ ok: true });
});
// Runs due jobs now (Admin) — used to verify the worker without waiting for the timer.
app.post('/api/admin/jobs/run-now', auth(['admin']), async (req, res) => { await jobs.tick(); res.json({ ok: true, counts: await jobs.counts() }); });
// Admin visibility: recent notification deliveries (failed / cancelled / sent).
app.get('/api/notifications/deliveries', auth(['admin']), async (req, res) => {
  const status = ['pending', 'processing', 'sent', 'failed', 'retrying', 'cancelled'].includes(str(req.query.status)) ? str(req.query.status) : null;
  res.json(await db.listDeliveries({ status, limit: Math.min(500, parseInt(req.query.limit, 10) || 100) }));
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
/* ============ INTEGRATIONS: storage, AI, ingestion (Phases 5–6) ============ */
// Job engine first — integrations below register their background jobs on it.
const { createJobEngine } = require('./services/jobs');
const jobs = createJobEngine({ pool: db.pool, log });
const { flags: featureFlags } = require('./services/features');
const { createStorage } = require('./services/storage');
const { createAI } = require('./services/ai');
const { createIngestion } = require('./services/ingestion');
const storage = createStorage({ pool: db.pool });
const ai = createAI({ pool: db.pool, log, onBudgetAlert: async ({ spent, budget }) => {
  const month = new Date().toISOString().slice(0, 7);
  for (const u of await db.listAdminUsernames()) {
    const id = await db.claimDelivery({ key: `ai-budget-alert:${month}:${u}`, recipient: u, type: 'ai_budget' });
    if (!id) continue;
    const nid = await db.createNotification({ username: u, type: 'ai_budget', message: `AI spending this month is ₹${spent.toFixed(0)} of the ₹${budget} budget. AI features stop when the budget is reached.` });
    await db.finishDelivery(id, { status: 'sent', notificationId: nid });
  }
} });
// The ONE task-creation path for AI-sourced tasks — same validation and insertTaskRecords() as "+ New Task".
async function createTaskFromSpec(user, spec) {
  const title = str(spec.title).trim();
  if (!title) return { status: 400, error: 'A title is required.' };
  if (tooLong(title, 200)) return { status: 400, error: 'Title is too long (max 200 characters).' };
  if (!spec.deadline || !parseDeadline(spec.deadline)) return { status: 400, error: 'Deadline is not a valid date.' };
  const usernames = Array.from(new Set(spec.assignees || []));
  const usersByUsername = {};
  for (const u of usernames) { const row = await db.getUser(u); if (!row) return { status: 400, error: `Unknown person: ${u}` }; usersByUsername[u] = row; }
  const actor = await db.getUser(user.username);
  const id = genId('TASK');
  await db.runInTransaction(async (tx) => {
    await insertTaskRecords(tx, { username: actor.username, name: actor.name }, {
      id, title, description: spec.description || null, priority: ['low', 'medium', 'high'].includes(spec.priority) ? spec.priority : 'medium',
      deadline: spec.deadline, project: spec.project || null, stageGroups: usernames.length ? [usernames] : [], usersByUsername,
      sourceType: spec.sourceType || 'web', provenance: spec.provenance || null,
    });
  });
  await db.pool.query('UPDATE tasks SET source_type=$1, source_ref=$2 WHERE id=$3', [spec.sourceType || 'web', spec.provenance && spec.provenance.ingestion_id ? `ingestion:${spec.provenance.ingestion_id}` : null, id]);
  return { status: 200, id };
}
const ingestion = createIngestion({ db, pool: db.pool, ai, storage, createTask: createTaskFromSpec, log });
const { documentToInput } = require('./services/documents');
const UPLOAD_RETENTION_DAYS = Number(process.env.UPLOAD_RETENTION_DAYS) || 90;
// One routine for every file (app upload or WhatsApp media): read it, keep it privately if storage
// is configured, run it through the same suggestion pipeline.
async function ingestFile({ buffer, mime, name, source, sourceRef = null, username, metadata = {} }) {
  const input = await documentToInput(buffer, mime, name);
  let fileId = null;
  if (storage.configured) {
    try { fileId = (await storage.put(buffer, { mime, originalName: name || null, ownerType: source === 'whatsapp' ? 'whatsapp' : 'upload', uploadedBy: username, retention: `days:${UPLOAD_RETENTION_DAYS}` })).id; }
    catch (e) { log('WARN', 'uploaded file not stored', { error: e.message }); }
  }
  const item = await ingestion.receive({ source, sourceRef, submittedBy: username, contentType: input.contentType, text: input.kind === 'text' ? input.text : null, fileId,
    metadata: { ...metadata, file_name: name || null, mime, bytes: buffer.length } });
  if (item.duplicate) return { item, duplicate: true, suggestions: await ingestion.listForItem(item.id) };
  const r = await ingestion.process(item.id, input.kind === 'media' ? { media: { buffer, mime: input.mime, contentType: input.contentType } } : {});
  return { item, ...r };
}
const aiErrorStatus = (e) => (e.code === 'AI_BUDGET' ? 429 : e.code === 'AI_NOT_CONFIGURED' ? 503 : 502);
const dataUrlToBuffer = (d) => { const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(str(d)); if (!m) return null; return { mime: m[1] || 'application/octet-stream', buffer: m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3])) }; };
const aiCallLimiter = makeRateLimiter(60, 60 * 60 * 1000); // per client IP: at most 60 AI requests an hour

// Pasted text → suggestions (manual / upload source).
app.post('/api/ingestion', auth(ALL_ROLES), aiCallLimiter, async (req, res) => {
  if (!featureFlags().aiTaskExtraction) return res.status(403).json({ error: 'AI task extraction is not enabled.' });
  const text = str((req.body || {}).text).trim();
  if (!text) return res.status(400).json({ error: 'Paste or type the message first.' });
  if (tooLong(text, 20000)) return res.status(400).json({ error: 'That text is too long (max 20,000 characters).' });
  try {
    const item = await ingestion.receive({ source: 'manual', submittedBy: req.user.username, text });
    const r = await ingestion.process(item.id);
    res.json({ ingestionId: item.id, suggestions: r.suggestions, language: r.language });
  } catch (e) { log('ERROR', 'ingestion failed', { requestId: req.id, error: e.message }); res.status(aiErrorStatus(e)).json({ error: e.code ? e.message : 'Could not read that message right now — please create the task manually.' }); }
});
// Voice → transcript (original language) + task suggestions, answered immediately for the preview.
app.post('/api/ingestion/voice', auth(ALL_ROLES), aiCallLimiter, async (req, res) => {
  if (!featureFlags().voiceTasks) return res.status(403).json({ error: 'Voice tasks are not enabled.' });
  const audio = dataUrlToBuffer((req.body || {}).audio);
  if (!audio || !audio.buffer.length) return res.status(400).json({ error: 'No recording received.' });
  if (!/^audio\//.test(audio.mime)) return res.status(400).json({ error: 'That is not an audio recording.' });
  if (audio.buffer.length > 5 * 1024 * 1024) return res.status(413).json({ error: 'Recording too long — keep voice tasks under about 3 minutes.' });
  try {
    const item = await ingestion.receive({ source: 'voice', submittedBy: req.user.username, contentType: 'audio', metadata: { bytes: audio.buffer.length, mime: audio.mime } });
    const r = await ingestion.process(item.id, { audio });
    res.json({ ingestionId: item.id, transcript: r.transcript, language: r.language, suggestions: r.suggestions, minConfidence: ingestion.MIN_CONF });
  } catch (e) { log('ERROR', 'voice ingestion failed', { requestId: req.id, error: e.message }); res.status(aiErrorStatus(e)).json({ error: e.code ? e.message : 'Voice processing failed. Please try again or create the task manually.' }); }
});
// Which optional features this page should show (no secrets — on/off only).
app.get('/api/features', auth(ALL_ROLES), (req, res) => {
  const f = featureFlags();
  res.json({ aiTaskExtraction: f.aiTaskExtraction && ai.configured, voiceTasks: f.voiceTasks && ai.configured, meetingAi: f.meetingAi && ai.configured, storage: storage.configured, meetingRetentionDays: MEETING_RETENTION_DAYS, locationTracking: f.locationTracking });
});
// Document / photo / video → suggestions (PDF, Word, Excel, CSV, images, short videos).
app.post('/api/ingestion/file', auth(ALL_ROLES), aiCallLimiter, async (req, res) => {
  if (!featureFlags().aiTaskExtraction) return res.status(403).json({ error: 'AI task extraction is not enabled.' });
  const f = dataUrlToBuffer((req.body || {}).file);
  const name = str((req.body || {}).name).slice(0, 200);
  if (!f || !f.buffer.length) return res.status(400).json({ error: 'No file received.' });
  if (f.buffer.length > 15 * 1024 * 1024) return res.status(413).json({ error: 'File too large — the limit is 15 MB.' });
  try {
    const r = await ingestFile({ buffer: f.buffer, mime: f.mime, name, source: 'upload', username: req.user.username });
    res.json({ ingestionId: r.item.id, transcript: r.transcript || null, language: r.language || null, suggestions: r.suggestions || [] });
  } catch (e) {
    if (e.code === 'UNSUPPORTED_FILE') return res.status(415).json({ error: e.message });
    log('ERROR', 'file ingestion failed', { requestId: req.id, error: e.message });
    res.status(aiErrorStatus(e)).json({ error: e.code ? e.message : 'Could not read that file right now — please create the task manually.' });
  }
});
app.get('/api/suggestions', auth(ALL_ROLES), async (req, res) => res.json(await ingestion.listPending(req.user, { all: str(req.query.all) === '1' })));
app.post('/api/suggestions/:id/accept', auth(ALL_ROLES), async (req, res) => {
  const b = req.body || {};
  const edits = {};
  if (b.title != null) edits.title = str(b.title);
  if (b.deadline != null) edits.deadline = str(b.deadline);
  if (Array.isArray(b.assignees)) edits.assignees = b.assignees.map(str).filter(Boolean);
  if (b.priority != null) edits.priority = str(b.priority);
  if (b.project != null) edits.project = str(b.project);
  if (b.description != null) edits.description = str(b.description);
  const r = await ingestion.accept(parseInt(req.params.id, 10) || 0, req.user, edits);
  if (r.status !== 200) return res.status(r.status).json({ error: r.error });
  res.json({ ok: true, taskId: r.taskId });
});
app.post('/api/suggestions/:id/ignore', auth(ALL_ROLES), async (req, res) => {
  const r = await ingestion.ignore(parseInt(req.params.id, 10) || 0, req.user);
  if (r.status !== 200) return res.status(r.status).json({ error: r.error });
  res.json({ ok: true });
});
// Admin: one place to see whether everything is healthy.
app.get('/api/admin/system', auth(['admin']), async (req, res) => {
  let database = 'ok'; try { await db.ping(); } catch (e) { database = 'unavailable'; }
  const failedDeliveries = (await db.listDeliveries({ status: 'failed', limit: 20 }));
  res.json({
    database, schemaVersion: (await db.ping().catch(() => ({}))).schemaVersion || null, timezone: process.env.TZ, uptimeSec: Math.round(process.uptime()),
    jobs: { counts: await jobs.counts(), problems: (await jobs.list({ limit: 200 })).filter(j => ['failed', 'dead_letter', 'retrying'].includes(j.status)).slice(0, 20) },
    deliveries: { failed: failedDeliveries },
    integrations: { webPush: !!pushConfigured, whatsappSending: !!whatsappConfigured, email: !!process.env.SMTP_HOST, ai: ai.configured ? `${ai.provider} (${ai.model})` : null, storage: storage.configured },
    features: featureFlags(),
    ai: ai.configured ? await ai.usageSummary() : null,
  });
});

/* ---------- WhatsApp inbound (Meta WhatsApp Cloud API) ---------- */
const crypto = require('crypto');
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || '';
const WHATSAPP_APP_SECRET = process.env.WHATSAPP_APP_SECRET || '';
const APP_URL = process.env.APP_BASE_URL || 'https://mihir-task-manager.onrender.com';
const last10 = p => String(p || '').replace(/\D/g, '').slice(-10);
function safeEqual(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); }
app.get('/api/integrations/whatsapp/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && WHATSAPP_VERIFY_TOKEN && safeEqual(req.query['hub.verify_token'] || '', WHATSAPP_VERIFY_TOKEN)) return res.status(200).send(String(req.query['hub.challenge'] || ''));
  res.sendStatus(403);
});
app.post('/api/integrations/whatsapp/webhook', async (req, res) => {
  if (!featureFlags().whatsapp) return res.sendStatus(403);
  if (!WHATSAPP_APP_SECRET) return res.sendStatus(503);
  const sig = str(req.headers['x-hub-signature-256']);
  const expected = 'sha256=' + crypto.createHmac('sha256', WHATSAPP_APP_SECRET).update(req.rawBody || Buffer.from('')).digest('hex');
  if (!sig || !safeEqual(sig, expected)) { log('WARN', 'whatsapp webhook signature rejected', { requestId: req.id }); return res.sendStatus(401); }
  const messages = [];
  for (const entry of (req.body && req.body.entry) || []) for (const ch of entry.changes || []) for (const m of ((ch.value || {}).messages) || []) messages.push(m);
  for (const m of messages) {
    if (!m.id) continue;
    // Replay / retry protection: each Meta message id is handled once.
    const ins = await db.pool.query(`INSERT INTO integration_events (provider, event_type, external_id, payload) VALUES ('whatsapp', $1, $2, $3::jsonb)
      ON CONFLICT (provider, external_id) WHERE external_id IS NOT NULL DO NOTHING RETURNING id`, [m.type || 'message', m.id, JSON.stringify(m)]);
    if (ins.rows[0]) await jobs.enqueue('WHATSAPP_MESSAGE', { eventId: ins.rows[0].id }, { key: `wa:${m.id}` });
  }
  res.sendStatus(200); // answer Meta fast; the work happens in the job
  setImmediate(() => jobs.tick().catch(() => {}));
});
async function whatsappReply(phone, text) { if (whatsappConfigured) await sendWhatsAppMessage(phone, text); }
async function downloadWhatsAppMedia(mediaId) {
  const meta = await fetch(`https://graph.facebook.com/v20.0/${encodeURIComponent(mediaId)}`, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
  if (!meta.ok) throw new Error(`WhatsApp media lookup failed (${meta.status})`);
  const info = await meta.json();
  const file = await fetch(info.url, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
  if (!file.ok) throw new Error(`WhatsApp media download failed (${file.status})`);
  return { buffer: Buffer.from(await file.arrayBuffer()), mime: info.mime_type || 'audio/ogg' };
}
const confirmable = (s, minConf) => s.deadline && Number(s.confidence) >= minConf && !(s.unresolved_names || []).length;
function describeSuggestions(list, minConf) {
  const lines = [];
  list.forEach((s, i) => {
    lines.push(`${list.length > 1 ? `${i + 1}. ` : ''}Task: ${s.title}`);
    lines.push(`Assigned: ${(s.assignees || []).join(', ') || '—'}${(s.unresolved_names || []).length ? ` (not found: ${s.unresolved_names.join(', ')})` : ''}`);
    lines.push(`Due: ${s.deadline || 'not given'}`);
    if (!confirmable(s, minConf)) lines.push('⚠ Needs checking in the app before it can be created.');
    lines.push('');
  });
  return lines.join('\n');
}
jobs.register('WHATSAPP_MESSAGE', async ({ eventId }) => {
  const ev = (await db.pool.query('SELECT * FROM integration_events WHERE id=$1', [eventId])).rows[0];
  if (!ev || ev.status === 'processed') return { skipped: true };
  const m = ev.payload; const phone = m.from;
  const user = (await db.listUsers()).find(u => u.phone && last10(u.phone) === last10(phone));
  const done = (status, error) => db.pool.query('UPDATE integration_events SET status=$2, error=$3, processed_at=now() WHERE id=$1', [eventId, status, error || null]);
  if (!user) { await done('ignored', 'unknown sender'); return { ignored: 'unknown sender' }; }
  const text = m.type === 'text' ? str((m.text || {}).body).trim() : '';
  const latestPending = async () => (await db.pool.query(`SELECT s.* FROM ai_suggestions s JOIN ingestion_items i ON i.id = s.ingestion_id
    WHERE i.source='whatsapp' AND s.owner_username=$1 AND s.status='pending' AND i.created_at > now() - interval '24 hours'
      AND i.id = (SELECT MAX(i2.id) FROM ingestion_items i2 JOIN ai_suggestions s2 ON s2.ingestion_id = i2.id WHERE i2.source='whatsapp' AND s2.owner_username=$1 AND s2.status='pending')
    ORDER BY s.id`, [user.username])).rows;
  const cmd = /^(confirm|yes|ok|ha|haan|ho|हो|हाँ)(\s+(\d+|all))?\s*$/i.exec(text);
  if (cmd) {
    const pending = await latestPending();
    if (!pending.length) { await whatsappReply(phone, 'There is nothing waiting for confirmation.'); await done('processed'); return { confirmed: 0 }; }
    const pick = cmd[3] && /^\d+$/.test(cmd[3]) ? [pending[Number(cmd[3]) - 1]].filter(Boolean) : pending;
    const created = [], needApp = [];
    for (const s of pick) {
      if (!confirmable(s, ingestion.MIN_CONF)) { needApp.push(s.title); continue; }
      const r = await ingestion.accept(s.id, { username: user.username, role: user.role, name: user.name });
      if (r.status === 200) created.push(`${r.taskId} — ${s.title}`); else needApp.push(s.title);
    }
    await whatsappReply(phone, [created.length ? `Created:\n${created.join('\n')}` : '', needApp.length ? `Please complete in the app: ${needApp.join('; ')}\n${APP_URL}` : ''].filter(Boolean).join('\n\n'));
    await done('processed'); return { confirmed: created.length };
  }
  if (/^(cancel|no|nahi|nako|रद्द)\s*$/i.test(text)) {
    const pending = await latestPending();
    for (const s of pending) await ingestion.ignore(s.id, { username: user.username, role: user.role });
    await whatsappReply(phone, pending.length ? 'Cancelled — nothing was created.' : 'There is nothing to cancel.');
    await done('processed'); return { cancelled: pending.length };
  }
  let audio = null, fileId = null;
  if (m.type === 'audio' || m.type === 'voice') {
    audio = await downloadWhatsAppMedia((m.audio || m.voice || {}).id);
    if (storage.configured) { try { fileId = (await storage.put(audio.buffer, { mime: audio.mime, ownerType: 'whatsapp', uploadedBy: user.username, retention: `days:${Number(process.env.WHATSAPP_MEDIA_RETENTION_DAYS) || 30}` })).id; } catch (e) { log('WARN', 'whatsapp media not stored', { error: e.message }); } }
  } else if (['document', 'image', 'video'].includes(m.type)) {
    const meta = m[m.type] || {};
    let file;
    try { file = await downloadWhatsAppMedia(meta.id); }
    catch (e) { throw e; } // retried by the job engine
    if (file.buffer.length > 16 * 1024 * 1024) { await whatsappReply(phone, 'That file is larger than 16 MB — please share it in the app instead.'); await done('ignored', 'too large'); return { ignored: 'too large' }; }
    let r;
    try {
      r = await ingestFile({ buffer: file.buffer, mime: meta.mime_type || file.mime, name: meta.filename || `${m.type}`, source: 'whatsapp', sourceRef: m.id, username: user.username,
        metadata: { from: phone, caption: meta.caption || null } });
    } catch (e) {
      if (e.code === 'UNSUPPORTED_FILE') { await whatsappReply(phone, e.message); await done('ignored', 'unsupported file'); return { ignored: 'unsupported file' }; }
      throw e;
    }
    if (!r.suggestions || !r.suggestions.length) await whatsappReply(phone, "I couldn't find a task in that file. If one is needed, please create it in the app.");
    else {
      const ok = r.suggestions.some(s2 => confirmable(s2, ingestion.MIN_CONF));
      await whatsappReply(phone, `Task${r.suggestions.length > 1 ? 's' : ''} prepared from your ${m.type}:\n\n${describeSuggestions(r.suggestions, ingestion.MIN_CONF)}${ok ? 'Reply CONFIRM to create, or CANCEL.' : `Please review in the app: ${APP_URL}`}`);
    }
    await done('processed');
    return { suggestions: (r.suggestions || []).length };
  } else if (m.type !== 'text') {
    await whatsappReply(phone, 'I can read text, voice notes, documents, photos and short videos. Please send the task in one of those forms.');
    await done('ignored', `unsupported type ${m.type}`); return { ignored: m.type };
  }
  const item = await ingestion.receive({ source: 'whatsapp', sourceRef: m.id, submittedBy: user.username, contentType: audio ? 'audio' : 'text', text: text || null, fileId, metadata: { from: phone } });
  const r = await ingestion.process(item.id, { audio });
  if (!r.suggestions || !r.suggestions.length) await whatsappReply(phone, "I couldn't find a task in that message. If one is needed, please create it in the app.");
  else {
    const ok = r.suggestions.some(s => confirmable(s, ingestion.MIN_CONF));
    await whatsappReply(phone, `Task${r.suggestions.length > 1 ? 's' : ''} prepared:\n\n${describeSuggestions(r.suggestions, ingestion.MIN_CONF)}${ok ? `Reply CONFIRM to create${r.suggestions.length > 1 ? ' (or CONFIRM 1, CONFIRM 2…)' : ''}, or CANCEL.` : `Please review in the app: ${APP_URL}`}`);
  }
  await done('processed');
  return { suggestions: (r.suggestions || []).length };
}, { maxAttempts: 4 });

/* ---------- Email → task (provider-agnostic inbound) ----------
   The company task mailbox (e.g. tasks@mihirgroup.com) forwards each message as JSON to this endpoint
   (Cloudflare Email Worker, Mailgun/SendGrid inbound parse, or a small IMAP poller). Only emails from
   known employee addresses are accepted; each Message-ID is processed once. */
const EMAIL_INBOUND_SECRET = process.env.EMAIL_INBOUND_SECRET || '';
const emailAddress = v => { const m = /<([^>]+)>/.exec(String(v || '')); return (m ? m[1] : String(v || '')).trim().toLowerCase(); };
app.post('/api/integrations/email/inbound', async (req, res) => {
  if (!featureFlags().emailIngestion) return res.status(403).json({ error: 'Email ingestion is not enabled.' });
  if (!EMAIL_INBOUND_SECRET || !safeEqual(str(req.headers['x-inbound-secret']), EMAIL_INBOUND_SECRET)) return res.sendStatus(401);
  const b = req.body || {};
  const messageId = str(b.message_id || b.messageId).trim();
  const from = emailAddress(b.from);
  if (!messageId || !from) return res.status(400).json({ error: 'message_id and from are required.' });
  const user = (await db.listUsers()).find(u => u.email && u.email.toLowerCase() === from);
  if (!user) { log('INFO', 'email from unknown sender ignored', { requestId: req.id }); return res.status(202).json({ ignored: 'unknown sender' }); }
  const subject = str(b.subject).slice(0, 300);
  const body = str(b.text || '').slice(0, 20000);
  const item = await ingestion.receive({ source: 'email', sourceRef: messageId, submittedBy: user.username, text: `Subject: ${subject}\n\n${body}`,
    metadata: { from, to: b.to || null, cc: b.cc || null, subject, attachments: (b.attachments || []).map(a => ({ name: str(a.name || a.filename), size: a.size || null })) } });
  if (item.duplicate) return res.json({ duplicate: true, ingestionId: item.id });
  await jobs.enqueue('INGEST_PROCESS', { itemId: item.id, notifyLabel: `your email "${subject}"` }, { key: `ingest:${item.id}`, relatedUsername: user.username });
  res.status(202).json({ accepted: true, ingestionId: item.id });
  setImmediate(() => jobs.tick().catch(() => {}));
});
jobs.register('INGEST_PROCESS', async ({ itemId, notifyLabel }) => {
  const r = await ingestion.process(itemId);
  const item = (await db.pool.query('SELECT submitted_by FROM ingestion_items WHERE id=$1', [itemId])).rows[0];
  const n = (r.suggestions || []).length;
  if (item && n && !r.alreadyProcessed) await db.createNotification({ username: item.submitted_by, type: 'ai_suggestions', message: `${n} task suggestion${n > 1 ? 's' : ''} from ${notifyLabel || 'a message'} ${n > 1 ? 'are' : 'is'} ready to review in "Suggestions".` });
  return { suggestions: n };
}, { maxAttempts: 4 });

/* ---------- Meetings: record → transcript → action items → review ---------- */
const MEETING_RETENTION_DAYS = Number(process.env.MEETING_RECORDING_RETENTION_DAYS) || 30;
async function canSeeMeeting(user, m) { return user.role === 'admin' || m.created_by === user.username || (m.participants || []).includes(user.username); }
async function processMeeting(meetingId, audio) {
  const m = (await db.pool.query('SELECT * FROM meeting_sessions WHERE id=$1', [meetingId])).rows[0];
  if (!m) throw new Error('meeting not found');
  if (!audio && m.file_id) audio = await storage.download(m.file_id);
  if (!audio) throw new Error('meeting recording is not available');
  await db.pool.query("UPDATE meeting_sessions SET status='processing', error=NULL WHERE id=$1", [meetingId]);
  try {
    const item = await ingestion.receive({ source: 'meeting', sourceRef: `meeting:${meetingId}`, submittedBy: m.created_by, contentType: 'audio', fileId: m.file_id, metadata: { meetingId } });
    const r = await ingestion.process(item.id, { audio, mode: 'meeting', meetingId });
    await db.pool.query(`UPDATE meeting_sessions SET status='ready', transcript=$2, summary=$3, decisions=$4::jsonb, risks=$5::jsonb, language=$6 WHERE id=$1`,
      [meetingId, r.transcript || null, r.summary || null, JSON.stringify(r.decisions || []), JSON.stringify(r.risks || []), r.language || null]);
    const n = (r.suggestions || []).length;
    await db.createNotification({ username: m.created_by, type: 'ai_suggestions', message: `Meeting "${m.title}" is processed — ${n} action item${n === 1 ? '' : 's'} to review.` });
    for (const p of (m.participants || []).filter(p => p !== m.created_by)) await db.createNotification({ username: p, type: 'meeting_summary', message: `Summary of "${m.title}" is available.` });
    return { suggestions: n };
  } catch (e) {
    await db.pool.query("UPDATE meeting_sessions SET status='failed', error=$2 WHERE id=$1", [meetingId, String(e.message).slice(0, 500)]);
    throw e;
  }
}
jobs.register('MEETING_PROCESS', async ({ meetingId }) => processMeeting(meetingId), { maxAttempts: 3, baseDelayMs: 120000 });
app.post('/api/meetings', auth(ALL_ROLES), aiCallLimiter, async (req, res) => {
  if (!featureFlags().meetingAi) return res.status(403).json({ error: 'Meeting assistant is not enabled.' });
  const b = req.body || {};
  const title = str(b.title).trim().slice(0, 200) || `Meeting ${new Date().toLocaleDateString('en-GB')}`;
  const audio = dataUrlToBuffer(b.audio);
  if (!audio || !audio.buffer.length || !/^audio\//.test(audio.mime)) return res.status(400).json({ error: 'No meeting recording received.' });
  const users = await db.listUsers();
  const participants = Array.from(new Set((Array.isArray(b.participants) ? b.participants : []).map(str).filter(u => users.some(x => x.username === u))));
  let fileId = null;
  if (storage.configured) fileId = (await storage.put(audio.buffer, { mime: audio.mime, ownerType: 'meeting', uploadedBy: req.user.username, retention: `days:${MEETING_RETENTION_DAYS}` })).id;
  const startedAt = b.startedAt && !isNaN(new Date(b.startedAt)) ? new Date(b.startedAt) : null;
  const endedAt = b.endedAt && !isNaN(new Date(b.endedAt)) ? new Date(b.endedAt) : new Date();
  const m = (await db.pool.query(`INSERT INTO meeting_sessions (title, created_by, participants, started_at, ended_at, duration_sec, file_id)
    VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7) RETURNING *`, [title, req.user.username, JSON.stringify(participants), startedAt, endedAt, startedAt ? Math.round((endedAt - startedAt) / 1000) : null, fileId])).rows[0];
  if (fileId) {
    if (m.file_id) await db.pool.query("UPDATE file_objects SET owner_id=$2 WHERE id=$1", [fileId, String(m.id)]);
    await jobs.enqueue('MEETING_PROCESS', { meetingId: m.id }, { key: `meeting:${m.id}`, relatedUsername: req.user.username });
    setImmediate(() => jobs.tick().catch(() => {}));
    return res.status(202).json({ meeting: m, processing: 'queued' });
  }
  // No file storage configured: process now and keep only the transcript (the recording is not kept).
  try { await processMeeting(m.id, audio); }
  catch (e) { return res.status(aiErrorStatus(e)).json({ error: e.code ? e.message : 'Meeting processing failed. The meeting was saved — please try again later.', meetingId: m.id }); }
  res.json({ meeting: (await db.pool.query('SELECT * FROM meeting_sessions WHERE id=$1', [m.id])).rows[0], processing: 'done' });
});
app.get('/api/meetings', auth(ALL_ROLES), async (req, res) => {
  const r = await db.pool.query(`SELECT id, title, created_by, participants, started_at, ended_at, duration_sec, status, created_at,
      (file_id IS NOT NULL) AS has_recording FROM meeting_sessions
    WHERE $1::boolean OR created_by=$2 OR participants ? $2 ORDER BY created_at DESC LIMIT 100`, [req.user.role === 'admin', req.user.username]);
  res.json(r.rows);
});
app.get('/api/meetings/:id', auth(ALL_ROLES), async (req, res) => {
  const m = (await db.pool.query('SELECT * FROM meeting_sessions WHERE id=$1', [parseInt(req.params.id, 10) || 0])).rows[0];
  if (!m) return res.status(404).json({ error: 'Meeting not found.' });
  if (!(await canSeeMeeting(req.user, m))) return res.status(403).json({ error: "You weren't part of this meeting." });
  const suggestions = (await db.pool.query('SELECT * FROM ai_suggestions WHERE meeting_id=$1 ORDER BY id', [m.id])).rows;
  const file = m.file_id ? await storage.get(m.file_id) : null;
  res.json({ ...m, recordingAvailable: !!file, retentionDays: MEETING_RETENTION_DAYS, suggestions });
});
app.get('/api/meetings/:id/recording', auth(ALL_ROLES), async (req, res) => {
  const m = (await db.pool.query('SELECT * FROM meeting_sessions WHERE id=$1', [parseInt(req.params.id, 10) || 0])).rows[0];
  if (!m) return res.status(404).json({ error: 'Meeting not found.' });
  if (!(req.user.role === 'admin' || m.created_by === req.user.username)) return res.status(403).json({ error: 'Only the organiser or Admin can play the recording.' });
  if (!m.file_id || !(await storage.get(m.file_id))) return res.status(404).json({ error: 'The recording is no longer kept (deleted after the retention period, or never stored).' });
  res.json({ url: await storage.signedUrl(m.file_id, 300) });
});
app.post('/api/meetings/:id/retry', auth(ALL_ROLES), async (req, res) => {
  const m = (await db.pool.query('SELECT * FROM meeting_sessions WHERE id=$1', [parseInt(req.params.id, 10) || 0])).rows[0];
  if (!m) return res.status(404).json({ error: 'Meeting not found.' });
  if (!(req.user.role === 'admin' || m.created_by === req.user.username)) return res.status(403).json({ error: 'Not allowed.' });
  if (m.status !== 'failed' || !m.file_id) return res.status(400).json({ error: 'Only a failed meeting with a stored recording can be retried.' });
  await jobs.enqueue('MEETING_PROCESS', { meetingId: m.id }, { key: `meeting:${m.id}:retry:${Date.now()}` });
  setImmediate(() => jobs.tick().catch(() => {}));
  res.json({ ok: true });
});

/* ============ DELIVERIES ============
   backend/deliveries.js — material to be delivered and unloaded on site, with photo proof. */
const { mountDeliveries, DOC_TYPES: DELIVERY_DOC_TYPES } = require('./deliveries');
const DELIVERY_DOC = Object.fromEntries(DELIVERY_DOC_TYPES.map(d => [d.key, d]));
mountDeliveries(app, { db, auth, ALL_ROLES, auditFromReq, taskEvent, collectUploads, MAX_FILE_CHARS, displayName, str, releaseDependentsOf });

/* ============ EMPLOYEE LOCATION TRACKING ============
   backend/location/* — off unless ENABLE_LOCATION_TRACKING=true (docs/LOCATION_TRACKING.md). */
const { mountLocation } = require('./location/routes');
mountLocation(app, {
  db, auth, ALL_ROLES, auditFromReq, clientIp, log, jobs, jwt, JWT_SECRET, directorAllowedTeams, canViewTask,
  featureEnabled: () => featureFlags().locationTracking,
});
// Leaflet (map library) served from our own origin — no third-party script CDN.
app.use('/vendor/leaflet', express.static(path.join(__dirname, '..', 'node_modules', 'leaflet', 'dist'), { maxAge: '7d' }));

/* ============ JOB ENGINE (Phase 7A) ============
   All background work runs as database jobs (backend/services/jobs.js): scheduled, retried with
   backoff, dead-lettered when it keeps failing, visible to Admin on the System page. The worker loop
   runs only in the real server process (not when tests load this module). */
jobs.register('REMINDER_RUN', async (payload) => runReminderEngine(payload.at ? new Date(payload.at) : new Date()), { maxAttempts: 3, baseDelayMs: 60000 });
jobs.register('WEEKLY_DIGEST', async () => ({ sent: await sendWeeklyWarningDigestToAdmin() }), { maxAttempts: 3 });
jobs.register('PERIOD_AWARDS', async () => { await checkAndSnapshotPeriodAwards(); return { ok: true }; }, { maxAttempts: 3 });
jobs.register('CLEANUP', async () => ({ removedCompletedJobs: await jobs.cleanup(30) }), { maxAttempts: 2 });
jobs.every('REMINDER_RUN', 5 * 60 * 1000);
jobs.weeklyOn('WEEKLY_DIGEST', 1, '09:00');   // Mondays 09:00 IST
jobs.dailyAt('PERIOD_AWARDS', '00:30');
jobs.dailyAt('CLEANUP', '03:00');
jobs.register('STORAGE_RETENTION', async () => ({ deleted: await storage.purgeExpired() }), { maxAttempts: 3 });
jobs.dailyAt('STORAGE_RETENTION', '02:30');
const JOB_TICK_MS = Number(process.env.JOB_TICK_SECONDS || 15) * 1000;

if (require.main === module) {
  (async () => {
    // The database must be fully initialized (schema created, migrations applied, default
    // accounts seeded) before the server starts accepting real traffic — otherwise the very
    // first request could race against table-creation still in progress.
    await db.init();
    const server = app.listen(PORT, () => console.log(`MIHIR Task Manager server running on http://localhost:${PORT}`));
    if (process.env.DISABLE_JOB_WORKER !== 'true') {
      setInterval(() => jobs.tick(), JOB_TICK_MS).unref();
      setTimeout(() => jobs.tick(), 5000).unref(); // shortly after start: catch up whatever was due while asleep
    }
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
module.exports.jobs = jobs;
