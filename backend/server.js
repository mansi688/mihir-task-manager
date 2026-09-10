require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 4000;

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

const webpush = require('web-push');
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const pushConfigured = !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
if (pushConfigured) {
  webpush.setVapidDetails('mailto:admin@example.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}
async function sendPushToUser(username, title, body, taskId) {
  if (!pushConfigured) return;
  const subs = await db.listPushSubscriptionsForUser(username);
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify({ title, body, taskId: taskId || null })
      );
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) await db.removePushSubscription(sub.endpoint);
      else console.error(`Push to ${username} failed:`, e.message);
    }
  }
}

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

function summarizeNotification(message, maxLen) {
  const clean = String(message || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= (maxLen || 120)) return clean;
  return clean.slice(0, (maxLen || 120) - 1).trim() + '…';
}

db.setNotificationHook(async ({ username, type, message, task_id }) => {
  const user = await db.getUser(username);
  if (!user) return;
  const summary = summarizeNotification(message, 120);
  sendPushToUser(username, 'MIHIR Task Manager', summary, task_id).catch(e => console.error('Push dispatch error:', e.message));
  if (user.phone) {
    sendWhatsAppMessage(user.phone, summarizeNotification(message, 300)).catch(e => console.error('WhatsApp dispatch error:', e.message));
  }
});

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const AI_MODEL = 'claude-haiku-4-5-20251001';
async function callClaude(systemPrompt, userPrompt, maxTokens) {
  if (!ANTHROPIC_API_KEY) {
    const err = new Error('AI features need ANTHROPIC_API_KEY set in your .env file.');
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
  console.error('ERROR: Set a real JWT_SECRET in your .env file before starting.');
  process.exit(1);
}

const MAX_FILE_CHARS = 28_000_000;
const MAX_DRAWING_FILE_CHARS = 140_000_000;

app.use(cors({
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()) : true,
}));
app.use(express.json({ limit: '160mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer-when-downgrade');
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
  next();
});
app.use(express.static(path.join(__dirname, '..', 'frontend')));

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
const loginRateLimiter = makeRateLimiter(200, 5 * 60 * 1000);
const aiRateLimiter = makeRateLimiter(30, 5 * 60 * 1000);

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/ready', async (req, res) => {
  try {
    await db.listUsers();
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
const KNOWN_DEFAULT_PASSWORDS = new Set(['admin123', 'mhr123456', 'password', 'password123', 'changeme', '12345678']);
function validatePasswordStrength(password) {
  if (password.length < 8) return 'Password must be at least 8 characters.';
  if (KNOWN_DEFAULT_PASSWORDS.has(password.toLowerCase())) {
    return "That's one of this app's own known temporary passwords — please choose something that isn't default/well-known.";
  }
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return 'Password should include both letters and numbers.';
  }
  return null;
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
function getISTHour(isoString) {
  const utcMs = new Date(isoString).getTime();
  if (isNaN(utcMs)) return NaN;
  return new Date(utcMs + IST_OFFSET_MS).getUTCHours();
}
function genId(prefix) { return prefix + '-' + Math.random().toString(36).slice(2, 8).toUpperCase(); }
function isDataUrl(v) { return typeof v === 'string' && v.startsWith('data:'); }

const DANGEROUS_EXTENSIONS = ['.exe', '.bat', '.cmd', '.com', '.scr', '.msi', '.msp', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.ps1', '.psm1', '.jar', '.app', '.dmg', '.sh', '.apk'];
function validateUploadedFile(dataUrl, fileName, maxSizeChars) {
  if (!isDataUrl(dataUrl)) return 'File is invalid or unreadable.';
  if (dataUrl.length > maxSizeChars) return `File is too large (max ~${Math.round(maxSizeChars / 1_400_000)}MB).`;
  const lower = str(fileName).toLowerCase();
  if (DANGEROUS_EXTENSIONS.some(ext => lower.endsWith(ext))) return 'This file type is not allowed for security reasons.';
  return null;
}
function tooLong(text, max) { return str(text).length > max; }

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
function parseDeadline(deadline) {
  if (!deadline) return null;
  const iso = deadline.includes('T') ? deadline : deadline + 'T00:00:00';
  const d = new Date(iso);
  return isNaN(d) ? null : d;
}
async function isInvolvedInTask(user, task) {
  if (user.role === 'admin') return true;
  if (task.created_by_username === user.username) return true;
  if ((await db.listAssignees(task.id)).some(a => a.username === user.username)) return true;
  if ((await db.listFollowups(task.id)).some(f => f.username === user.username)) return true;
  return false;
}
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

function directorAllowedTeams(user) {
  const granted = (user.visible_departments || '').split(',').map(s => s.trim()).filter(Boolean);
  return new Set([user.team, ...granted].filter(Boolean));
}
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
    const user = await db.getUser(payload.username);
    if (!user) return res.status(401).json({ error: 'Session invalid — please log in again.' });
    if ((user.token_version || 0) !== (payload.tv || 0)) return res.status(401).json({ error: 'Session revoked — please log in again.' });
    if (!roles.includes(user.role)) return res.status(403).json({ error: 'Not permitted for this role.' });
    req.user = { username: user.username, role: user.role, name: user.name, sid: payload.sid };
    next();
  };
}

/* ============ AUTH ============ */
app.post('/api/auth/login', loginRateLimiter, async (req, res) => {
  const username = str((req.body || {}).username).trim();
  const password = str((req.body || {}).password);
  const user = await db.getUser(username);
  if (user && user.locked_until && new Date(user.locked_until) > new Date()) {
    const minutesLeft = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
    return res.status(423).json({ error: `Too many failed attempts — account locked for ${minutesLeft} more minute(s).` });
  }
  const passwordMatches = user ? await bcrypt.compare(password, user.password_hash) : false;
  if (!user || !passwordMatches) {
    if (user) {
      await db.recordFailedLogin(user.username);
      const justLocked = await db.getUser(user.username);
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

const otpRequestLog = new Map();
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
  const user = await db.getUser(username);
  if (!user || !user.email) return res.json({ ...genericResponse, emailConfigured: true });
  const otp = String(Math.floor(100000 + Math.random() * 900000));
  const otpHash = bcrypt.hashSync(otp, 10);
  const expires = new Date(Date.now() + 10 * 60000).toISOString();
  await db.setPasswordResetOtp(user.username, otpHash, expires);
  try { await sendOtpEmail(user.email, otp, user.name); } catch (e) { console.error('Failed to send password-reset email:', e.message); }
  res.json({ ...genericResponse, emailConfigured: true });
});
app.post('/api/auth/reset-with-otp', async (req, res) => {
  const username = str((req.body || {}).username).trim();
  const otp = str((req.body || {}).otp).trim();
  const newPassword = str((req.body || {}).newPassword);
  const user = await db.getUser(username);
  if (!user || !user.password_reset_otp_hash || !user.password_reset_otp_expires) {
    return res.status(400).json({ error: 'No reset code is pending for this account.' });
  }
  if (new Date(user.password_reset_otp_expires) < new Date()) {
    await db.clearPasswordResetOtp(username);
    return res.status(400).json({ error: 'That code has expired.' });
  }
  if (!bcrypt.compareSync(otp, user.password_reset_otp_hash)) {
    return res.status(400).json({ error: 'Incorrect code.' });
  }
  const pwErr = validatePasswordStrength(newPassword); if (pwErr) return res.status(400).json({ error: pwErr });
  await db.setPassword(user.username, bcrypt.hashSync(newPassword, 10));
  await db.clearPasswordResetOtp(username);
  await auditFromReq(req, 'password_reset_via_otp', `Reset own password using reset code.`, { username: user.username, name: user.name });
  res.json({ ok: true });
});
app.post('/api/auth/logout-everywhere', auth(ALL_ROLES), async (req, res) => {
  await db.bumpTokenVersion(req.user.username);
  const user = await db.getUser(req.user.username);
  const token = sign({ username: user.username, role: user.role, name: user.name, tv: user.token_version || 0, sid: req.user.sid });
  res.json({ ok: true, token });
});
app.post('/api/auth/change-password', auth(ALL_ROLES), async (req, res) => {
  const newPassword = str((req.body || {}).newPassword);
  const pwErr = validatePasswordStrength(newPassword); if (pwErr) return res.status(400).json({ error: pwErr });
  await db.setPassword(req.user.username, bcrypt.hashSync(newPassword, 10));
  await auditFromReq(req, 'password_changed', `Changed their own password.`);
  const user = await db.getUser(req.user.username);
  const token = sign({ username: user.username, role: user.role, name: user.name, tv: user.token_version || 0, sid: req.user.sid });
  res.json({ ok: true, token });
});
app.post('/api/auth/update-name', auth(ALL_ROLES), async (req, res) => {
  const name = str((req.body || {}).name).trim();
  if (!name) return res.status(400).json({ error: 'Name cannot be empty.' });
  if (name.length > 80) return res.status(400).json({ error: 'Name is too long.' });
  await db.updateOwnName(req.user.username, name);
  const user = await db.getUser(req.user.username);
  const token = sign({ username: user.username, role: user.role, name: user.name, tv: user.token_version || 0, sid: req.user.sid });
  res.json({ ok: true, token, name: user.name });
});
app.post('/api/auth/update-email', auth(ALL_ROLES), async (req, res) => {
  const email = str((req.body || {}).email).trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email address.' });
  await db.updateOwnEmail(req.user.username, email || null);
  res.json({ ok: true, email: email || null });
});
app.post('/api/auth/update-phone', auth(ALL_ROLES), async (req, res) => {
  const phone = str((req.body || {}).phone).trim();
  if (phone && !/^\+[1-9]\d{7,14}$/.test(phone)) return res.status(400).json({ error: 'Enter phone number in international format, e.g. +919876543210.' });
  await db.updateOwnPhone(req.user.username, phone || null);
  res.json({ ok: true, phone: phone || null });
});
app.get('/api/push/vapid-public-key', (req, res) => res.json({ publicKey: pushConfigured ? VAPID_PUBLIC_KEY : null }));
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
  const user = await db.getUser(req.user.username);
  res.json({ username: user.username, role: user.role, name: user.name, email: user.email, phone: user.phone, team: user.team, designation: user.designation, isTeamLead: !!user.is_team_lead });
});

/* ============ USERS ============ */
app.get('/api/users', auth(['admin']), async (req, res) => res.json(await db.listUsers()));
app.get('/api/users/directory', auth(ALL_ROLES), async (req, res) => res.json(await db.listUsers()));
app.post('/api/users', auth(['admin']), async (req, res) => {
  const username = str((req.body || {}).username).trim();
  const password = str((req.body || {}).password);
  const name = str((req.body || {}).name).trim();
  const role = ALL_ROLES.includes(str((req.body || {}).role)) ? str((req.body || {}).role) : 'member';
  const team = str((req.body || {}).team).trim();
  const designation = str((req.body || {}).designation).trim();
  if (!/^[a-zA-Z0-9._-]{3,40}$/.test(username)) return res.status(400).json({ error: 'Username must be 3-40 characters.' });
  const pwErr = validatePasswordStrength(password); if (pwErr) return res.status(400).json({ error: pwErr });
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  if (await db.getUser(username)) return res.status(409).json({ error: 'Username already taken.' });
  await db.createUser({ username, password_hash: bcrypt.hashSync(password, 10), role, name, team, designation, must_change_password: true });
  await auditFromReq(req, 'account_created', `Created account "${username}" (${name})`);
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
  await auditFromReq(req, 'team_lead_changed', `${isTeamLead ? 'Made' : 'Removed'} "${req.params.username}" team lead`);
  res.json({ ok: true });
});
app.post('/api/users/:username/visible-departments', auth(['admin']), async (req, res) => {
  const user = await db.getUser(req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const departments = Array.isArray((req.body || {}).departments) ? (req.body || {}).departments.map(d => str(d).trim()).filter(Boolean) : [];
  await db.setVisibleDepartments(req.params.username, departments.join(','));
  await auditFromReq(req, 'director_visibility_changed', `Set visible departments for "${req.params.username}"`);
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
app.post('/api/users/:username/rename', auth(['admin']), async (req, res) => {
  const oldUsername = req.params.username;
  const user = await db.getUser(oldUsername);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const newUsername = str((req.body || {}).newUsername).trim();
  if (!/^[a-zA-Z0-9._-]{3,40}$/.test(newUsername)) return res.status(400).json({ error: 'Invalid username format.' });
  if (newUsername === oldUsername) return res.status(400).json({ error: 'Same username.' });
  if (await db.getUser(newUsername)) return res.status(409).json({ error: 'Username taken.' });
  await db.renameUsername(oldUsername, newUsername);
  await auditFromReq(req, 'username_changed', `Renamed account "${oldUsername}" to "${newUsername}"`);
  res.json({ ok: true, newUsername });
});
app.post('/api/users/:username/reset-password', auth(['admin']), async (req, res) => {
  const user = await db.getUser(req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const newPassword = str((req.body || {}).newPassword);
  const pwErr = validatePasswordStrength(newPassword); if (pwErr) return res.status(400).json({ error: pwErr });
  await db.forcePasswordReset(user.username, bcrypt.hashSync(newPassword, 10));
  await auditFromReq(req, 'password_reset', `Reset password for "${user.username}"`);
  res.json({ ok: true });
});
app.delete('/api/users/:username', auth(['admin']), async (req, res) => {
  if (req.params.username === req.user.username) return res.status(400).json({ error: "Cannot remove your own account." });
  if (!await db.getUser(req.params.username)) return res.status(404).json({ error: 'User not found.' });
  const openTasks = await db.getOpenTaskInvolvement(req.params.username);
  if (openTasks.length > 0) {
    return res.status(400).json({ error: `Account involved in ${openTasks.length} open tasks.` });
  }
  await db.deleteUser(req.params.username);
  await auditFromReq(req, 'account_removed', `Removed account "${req.params.username}"`);
  res.json({ ok: true });
});

app.get('/api/audit-log', auth(['admin']), async (req, res) => res.json(await db.listAuditLog(200)));

/* ============ AI ============ */
async function computeHistoricalDurationDays(priority) {
  const rows = await db.getApprovedTaskDurationsByPriority(priority);
  const durations = rows.map(r => (new Date(r.completed_at) - new Date(r.created_at)) / 86400000).filter(d => d >= 0);
  if (durations.length < 3) return null;
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
    let aiMessage = null;
    if (daysAvailable < 1) {
      aiMessage = 'Warning: This task is due in less than 24 hours.';
    } else if (hist && daysAvailable < hist.avgDays) {
      aiMessage = `Notice: Similar ${priority}-priority tasks historically take about ${hist.avgDays.toFixed(1)} days (based on ${hist.sampleSize} past completed tasks), but this deadline gives only ${daysAvailable.toFixed(1)} days.`;
    }
    res.json({ warning: aiMessage, historical: hist, daysAvailable });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    log('ERROR', 'Deadline check error', { error: e.message });
    res.status(500).json({ error: 'Failed to evaluate deadline.' });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

db.init().then(() => {
  app.listen(PORT, () => {
    log('INFO', `Server listening on port ${PORT}`);
  });
}).catch(err => {
  log('ERROR', 'Failed to initialize database', { error: err.message });
  process.exit(1);
});