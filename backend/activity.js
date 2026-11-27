/* User Activity — who isn't using the app, and who isn't working on their tasks. Admin (and Director) only.

   GET /api/reports/user-activity?days=7 → { days, generatedAt, people: [...] } — one row per account (Admin
   accounts left out), with:
     lastLogin   — the last time they logged in (sessions; a login lasts 12 hours, so people log in daily)
     lastActive  — the last time they used the app at all (users.last_active_at, kept by every request)
     lastWork    — the last real work: a task made, an update / reply, a file, their part submitted or completed,
                   or any other recorded action (audit log, logins / password / guide actions not counted)
     tasksCreated, updates, completed — all-time counts
     openTasks   — their open assigned tasks; idleTasks — those with nothing from them for `days` days
   The page splits people into lists from these (never logged in, not logged in for long, logged in but doing
   nothing, never created a task, not working on assigned tasks). */
const { pageAllowedFor } = require('../frontend/access');
const NOT_WORK = ['login', 'logout', 'account_locked', 'password_changed', 'password_reset', 'password_reset_via_pin',
  'recovery_pin_set', 'guide_completed', 'guide_skipped', 'guide_reset'];

// Last time each person used the app — written at most every 5 minutes per person. Mounted before the routes.
// The newest MIHIR Android app: the versionCode INSIDE android/MIHIR-Tasks.apk (read from the APK itself, so the
// number can never differ from the file people download), its SHA-256 for the app's self-update check.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const APK_FILE = path.join(__dirname, '..', 'android', 'MIHIR-Tasks.apk');
const APK = { versionCode: 0, versionName: '', sha256: '', size: 0 };
// minimal Android binary-XML reader: the manifest's versionCode / versionName attributes
function readApkVersion(manifest) {
  const u16 = (o) => manifest.readUInt16LE(o), u32 = (o) => manifest.readUInt32LE(o);
  const count = u32(16), flags = u32(24), strStart = u32(28), utf8 = !!(flags & 0x100);
  const str = (i) => {
    let o = 8 + strStart + u32(36 + 4 * i);
    if (utf8) { let n = manifest[o++]; if (n & 0x80) o++; let m = manifest[o++]; if (m & 0x80) m = ((m & 0x7f) << 8) | manifest[o++]; return manifest.toString('utf8', o, o + m); }
    const n = u16(o); return manifest.toString('utf16le', o + 2, o + 2 + 2 * n);
  };
  let vc = -1, vn = -1; for (let i = 0; i < count; i++) { const v = str(i); if (v === 'versionCode') vc = i; if (v === 'versionName') vn = i; }
  const out = {};
  for (let o = 0; o + 20 <= manifest.length; o += 4) {
    const name = u32(o + 4), size = u16(o + 12), type = manifest[o + 15];
    if (size !== 8) continue;
    if (name === vc && type === 0x10 && out.versionCode == null) out.versionCode = u32(o + 16);
    if (name === vn && type === 0x03 && out.versionName == null) { const raw = u32(o + 8); if (raw < count) out.versionName = str(raw); }
  }
  return out;
}
async function loadApkInfo() {
  try {
    const buf = fs.readFileSync(APK_FILE);
    const zip = await require('jszip').loadAsync(buf);
    const v = readApkVersion(Buffer.from(await zip.file('AndroidManifest.xml').async('uint8array')));
    Object.assign(APK, { versionCode: v.versionCode || 0, versionName: v.versionName || '', sha256: crypto.createHash('sha256').update(buf).digest('hex'), size: buf.length });
  } catch (e) { /* no APK in this build */ }
  return APK;
}
const apkReady = loadApkInfo();
function trackActivity(app, db) {
  const touched = new Map();
  app.use('/api', (req, res, next) => {
    res.on('finish', () => {
      const u = req.user && req.user.username;
      if (!u || res.statusCode >= 400) return;
      const now = Date.now();
      // which app the person uses: "android-8" (MIHIR app, versionCode) / "web" — Admin sees who still has an old app
      const appTag = String(req.headers['x-mihir-app'] || '').slice(0, 24).replace(/[^a-z0-9.-]/gi, '') || null;
      const t = touched.get(u);
      if (t && now - t.at < 5 * 60e3 && (!appTag || appTag === t.app)) return;
      touched.set(u, { at: now, app: appTag || (t && t.app) || null });
      db.pool.query('UPDATE users SET last_active_at=$1, app_client=COALESCE($3, app_client) WHERE username=$2', [new Date(now).toISOString(), u, appTag]).catch(() => {});
    });
    next();
  });
}

function mountActivity(app, { db, auth, ALL_ROLES }) {
  app.get('/api/reports/user-activity', auth(ALL_ROLES), async (req, res) => {
    const me = await db.getUser(req.user.username);
    if (!pageAllowedFor('activity', req.user.role, me && me.team)) return res.status(403).json({ error: 'Only Admin and senior management see user activity.' });
    const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 7));
    const now = Date.now();
    const cutoff = new Date(now - days * 864e5).toISOString();
    const q = async (sql, p) => (await db.pool.query(sql, p || [])).rows;
    const [users, logins, created, replies, files, done, submitted, audit, open] = await Promise.all([
      q("SELECT username, name, team, role, designation, created_at, last_active_at, app_client FROM users WHERE role <> 'admin' ORDER BY name"),
      q('SELECT username u, MAX(created_at) last, COUNT(*)::int n FROM sessions GROUP BY username'),
      q('SELECT created_by_username u, MAX(created_at) last, COUNT(*)::int n FROM tasks WHERE created_by_username IS NOT NULL GROUP BY 1'),
      q('SELECT by_username u, MAX(created_at) last, COUNT(*)::int n FROM task_replies WHERE by_username IS NOT NULL GROUP BY 1'),
      q('SELECT uploaded_by u, MAX(created_at) last FROM task_files WHERE uploaded_by IS NOT NULL GROUP BY 1'),
      q('SELECT username u, MAX(completed_at) last, COUNT(*)::int n FROM task_assignees WHERE completed_at IS NOT NULL GROUP BY 1'),
      q('SELECT username u, MAX(submitted_at) last FROM task_assignees WHERE submitted_at IS NOT NULL GROUP BY 1'),
      q('SELECT actor_username u, MAX(created_at) last FROM audit_log WHERE actor_username IS NOT NULL AND NOT (action = ANY($1)) GROUP BY 1', [NOT_WORK]),
      // Open, released assignments, with the last thing this person did on each task.
      q(`SELECT ta.username u, t.id, t.title, t.project, t.deadline, ta.individual_deadline,
                COALESCE(ta.released_at, t.created_at) since,
                GREATEST(
                  (SELECT MAX(r.created_at) FROM task_replies r WHERE r.task_id=t.id AND r.by_username=ta.username),
                  (SELECT MAX(f.created_at) FROM task_files f WHERE f.task_id=t.id AND f.uploaded_by=ta.username),
                  ta.submitted_at) last_touch
         FROM task_assignees ta JOIN tasks t ON t.id = ta.task_id
         WHERE t.status = 'open' AND t.archived_at IS NULL AND ta.completed_at IS NULL AND COALESCE(ta.is_released, 1) = 1`),
    ]);
    const by = (rows) => { const m = new Map(); rows.forEach(r => m.set(r.u, r)); return m; };
    const L = by(logins), C = by(created), R = by(replies), F = by(files), D = by(done), S = by(submitted), A = by(audit);
    const openBy = new Map();
    open.forEach(r => { if (!openBy.has(r.u)) openBy.set(r.u, []); openBy.get(r.u).push(r); });
    const maxIso = (...xs) => xs.filter(Boolean).sort().pop() || null;
    const daysSince = (iso) => iso ? Math.floor((now - Date.parse(iso)) / 864e5) : null;
    const people = users.map(u => {
      const lastLogin = (L.get(u.username) || {}).last || null;
      const lastWork = maxIso((C.get(u.username) || {}).last, (R.get(u.username) || {}).last, (F.get(u.username) || {}).last,
        (D.get(u.username) || {}).last, (S.get(u.username) || {}).last, (A.get(u.username) || {}).last);
      const lastActive = maxIso(u.last_active_at, lastLogin);
      const mine = openBy.get(u.username) || [];
      const idle = mine.map(t => ({ id: t.id, title: t.title, project: t.project, deadline: t.individual_deadline || t.deadline,
        since: t.since, lastTouch: t.last_touch, idleDays: daysSince(t.last_touch || t.since) }))
        .filter(t => (t.lastTouch || t.since || '') < cutoff)
        .sort((a, b) => (b.idleDays || 0) - (a.idleDays || 0));
      return {
        username: u.username, name: u.name, team: u.team, role: u.role, designation: u.designation, createdAt: u.created_at,
        lastLogin, logins: (L.get(u.username) || {}).n || 0, lastActive, lastWork,
        daysSinceLogin: daysSince(lastLogin), daysSinceActive: daysSince(lastActive), daysSinceWork: daysSince(lastWork),
        tasksCreated: (C.get(u.username) || {}).n || 0, updates: (R.get(u.username) || {}).n || 0, completed: (D.get(u.username) || {}).n || 0,
        openTasks: mine.length, idleTasks: idle.slice(0, 20), idleCount: idle.length,
        app: u.app_client || null, oldApp: /^android-\d+$/.test(u.app_client || '') && Number(u.app_client.split('-')[1]) < APK.versionCode,
      };
    });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ days, generatedAt: new Date(now).toISOString(), people, latestAndroid: APK.versionCode });
  });
}

module.exports = { APK, apkReady, mountActivity, trackActivity };
