// HTTP API for location tracking: /api/location/*  (see docs/LOCATION_TRACKING.md for the full list)
//
// Access model (enforced here, on the server — the UI only mirrors it):
//   - Everyone: their own status, consent, sessions, history, export, and who viewed their data.
//   - Admin: everyone. Directors: their own + granted departments (if the policy allows).
//     Team leads: their department (if the policy allows). Nobody else sees other people.
//   - Every view of someone ELSE's location is written to location_access_log, which that person can read.
//   - Location is only ever accepted inside a work session the employee started themselves.
const express = require('express');
const { createLocationService } = require('./service');
const { createIndoorService } = require('./indoor');

const DAY_MS = 86400000;
const PLACE_KINDS = ['office', 'site', 'warehouse', 'supplier', 'client', 'other'];
const RULE_KINDS = ['arrive', 'depart', 'restricted_entry', 'signal_lost', 'speeding', 'overtime'];
const ZONE_KINDS = ['room', 'desk', 'area', 'corridor', 'restricted'];
const MAX_PLAN_CHARS = 12 * 1024 * 1024; // ~9 MB image as a data: URL

function mountLocation(app, deps) {
  const { db, auth, ALL_ROLES, auditFromReq, clientIp, log, jobs, jwt, JWT_SECRET, directorAllowedTeams, featureEnabled, canViewTask } = deps;
  const pool = db.pool;
  const q = (t, p) => pool.query(t, p);
  const service = createLocationService({ pool, db, log });
  const indoor = createIndoorService({ pool, service });
  const router = express.Router();

  // Async errors must answer the request (Express 4 doesn't catch rejected promises by itself).
  const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    log('ERROR', 'location API error', { requestId: req.id, path: req.path, error: e.message });
    res.status(500).json({ error: 'Something went wrong with location tracking. Please try again.' });
  });
  const enabled = (req, res, next) => (featureEnabled() ? next() : res.status(404).json({ error: 'Location tracking is not enabled.' }));
  const str = (v, max) => { const s = v == null ? '' : String(v).trim(); return max ? s.slice(0, max) : s; };
  const numOr = (v, d) => { const n = Number(v); return v === undefined || v === null || v === '' || !Number.isFinite(n) ? d : n; };

  // ---------- access helpers ----------
  async function scopeOf(user) {
    const me = await db.getUser(user.username);
    if (!me) return { all: false, teams: new Set(), self: user.username, role: user.role };
    if (me.role === 'admin') return { all: true, teams: new Set(), self: me.username, role: me.role };
    const s = await service.getSettings();
    const teams = new Set();
    if (me.role === 'director' && s.directorsCanView) for (const t of directorAllowedTeams(me)) teams.add(t);
    if (me.is_team_lead && me.team && s.teamLeadsCanView) teams.add(me.team);
    return { all: false, teams, self: me.username, role: me.role };
  }
  const canSee = (scope, u) => !!u && (scope.all || u.username === scope.self || (!!u.team && scope.teams.has(u.team)));
  const isManager = (scope) => scope.all || scope.teams.size > 0;
  const usersMap = async () => new Map((await db.listUsers()).map(u => [u.username, u]));
  async function visibleUsernames(scope) {
    if (scope.all) return null; // null = no filter
    return (await db.listUsers()).filter(u => canSee(scope, u)).map(u => u.username);
  }
  // Live-map polling would flood the log — one row per viewer/subject/action per 15 minutes.
  const recentAccess = new Map();
  async function logAccess(req, subjects, action, detail) {
    const now = Date.now();
    const rows = [];
    for (const s of new Set(subjects)) {
      if (!s || s === req.user.username) continue;
      const key = `${req.user.username}|${s}|${action}`;
      if (action === 'live_map' && recentAccess.has(key) && now - recentAccess.get(key) < 15 * 60000) continue;
      recentAccess.set(key, now);
      rows.push(s);
    }
    if (!rows.length) return;
    await q(`INSERT INTO location_access_log (viewer_username, viewer_role, subject_username, action, detail, ip_address)
      SELECT $1, $2, s, $3, $4, $5 FROM unnest($6::text[]) AS s`, [req.user.username, req.user.role, action, detail ? String(detail).slice(0, 300) : null, clientIp(req), rows]);
  }
  function range(req, maxDays = 31) {
    // ?day=YYYY-MM-DD (IST) or ?from=&to= (ISO). Defaults to today (IST).
    let from, to;
    if (req.query.day && /^\d{4}-\d{2}-\d{2}$/.test(req.query.day)) { from = service.istDayStart(req.query.day); to = new Date(from.getTime() + DAY_MS); }
    else if (req.query.from) { from = new Date(req.query.from); to = req.query.to ? new Date(req.query.to) : new Date(); }
    else { from = service.istDayStart(service.istParts().day); to = new Date(from.getTime() + DAY_MS); }
    if (isNaN(from) || isNaN(to) || to <= from) { const e = new Error('Invalid date range.'); e.status = 400; throw e; }
    if (to - from > maxDays * DAY_MS) { const e = new Error(`Pick at most ${maxDays} days.`); e.status = 400; throw e; }
    return { from, to };
  }
  const adminOnly = (req, res, next) => (req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Only Admin can do this.' }));
  const placeManagers = (req, res, next) => (req.user.role === 'admin' || req.user.role === 'director' ? next() : res.status(403).json({ error: 'Only Admin or Directors can manage places.' }));

  // ---------- upload auth (phone background service) ----------
  // The native app gets a narrow "location upload" token when the employee starts a session:
  // it can ONLY add points to that one session, and dies when the session ends or the password changes.
  function uploadToken(user, session, hours) {
    return jwt.sign({ scope: 'loc', username: user.username, sid: session.id, tv: user.token_version || 0 }, JWT_SECRET, { expiresIn: `${Math.ceil(hours + 2)}h` });
  }
  const userAuth = auth(ALL_ROLES);
  async function uploadAuth(req, res, next) {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Location ')) {
      return userAuth(req, res, async () => {
        try {
          const sessionId = Number((req.body || {}).sessionId) || null;
          const session = sessionId ? await service.getSession(sessionId) : await service.activeSession(req.user.username);
          if (!session || session.username !== req.user.username) return res.status(409).json({ error: 'No active work session.', sessionActive: false });
          req.locSession = session; next();
        } catch (e) { next(e); }
      });
    }
    let payload;
    try { payload = jwt.verify(header.slice(9), JWT_SECRET); } catch (e) { return res.status(401).json({ error: 'Upload token expired.', sessionActive: false }); }
    if (payload.scope !== 'loc') return res.status(401).json({ error: 'Not an upload token.' });
    const user = await db.getUser(payload.username);
    if (!user || (user.token_version || 0) !== (payload.tv || 0)) return res.status(401).json({ error: 'Signed out — tracking stopped.', sessionActive: false });
    const session = await service.getSession(payload.sid);
    if (!session || session.username !== user.username) return res.status(409).json({ error: 'No active work session.', sessionActive: false });
    req.user = { username: user.username, role: user.role, name: user.name };
    req.locSession = session;
    next();
  }
  const uploadLimiter = (() => {
    const hits = new Map();
    return (req, res, next) => {
      const key = String(req.locSession.id); const now = Date.now();
      const list = (hits.get(key) || []).filter(t => now - t < 60000);
      if (list.length >= 60) return res.status(429).json({ error: 'Too many uploads — slow down.', retryAfterSec: 30 });
      list.push(now); hits.set(key, list); next();
    };
  })();

  // ================= employee =================
  router.get('/me', userAuth, ah(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!featureEnabled()) return res.json({ enabled: false });
    const me = await db.getUser(req.user.username);
    const s = await service.getSettings();
    const [consent, el, active, scope] = await Promise.all([service.consentStatus(me.username), service.eligibility(me), service.activeSession(me.username), scopeOf(req.user)]);
    res.json({
      enabled: true, consent, eligible: el, activeSession: active,
      policy: { version: s.policyVersion, text: s.policyText, retentionDays: s.retention.pointsDays, allowedHours: s.allowedHours, maxSessionHours: s.maxSessionHours,
        viewers: { admin: true, directors: s.directorsCanView, teamLeads: s.teamLeadsCanView } },
      config: await service.clientConfig(),
      canViewOthers: isManager(scope), isAdmin: me.role === 'admin', canManagePlaces: me.role === 'admin' || me.role === 'director',
      map: { tileUrl: process.env.MAP_TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: process.env.MAP_TILE_ATTRIBUTION || '&copy; OpenStreetMap contributors' },
      indoorEnabled: !!s.indoorEnabled,
    });
  }));
  router.post('/consent', enabled, userAuth, ah(async (req, res) => {
    await service.acceptConsent(req.user.username, (req.body || {}).policyVersion, { ip: clientIp(req), device: str(req.headers['user-agent'], 300) });
    await auditFromReq(req, 'location_consent_accepted', `Accepted the location tracking notice (version ${(req.body || {}).policyVersion}).`);
    res.json({ ok: true, consent: await service.consentStatus(req.user.username) });
  }));
  router.post('/consent/withdraw', enabled, userAuth, ah(async (req, res) => {
    await service.withdrawConsent(req.user.username);
    await auditFromReq(req, 'location_consent_withdrawn', 'Withdrew consent for location tracking (any active session was stopped).');
    res.json({ ok: true });
  }));
  router.post('/sessions/start', enabled, userAuth, ah(async (req, res) => {
    const me = await db.getUser(req.user.username);
    const b = req.body || {};
    const { session, resumed } = await service.startSession(me, { platform: b.platform, deviceId: b.deviceId, deviceLabel: b.deviceLabel, appVersion: b.appVersion });
    if (!resumed) await auditFromReq(req, 'location_session_started', `Started a work session with location (${session.platform}${session.device_label ? `, ${session.device_label}` : ''}).`);
    const s = await service.getSettings();
    res.json({ session, resumed, uploadToken: uploadToken(me, session, s.maxSessionHours), config: await service.clientConfig() });
  }));
  router.post('/sessions/stop', enabled, userAuth, ah(async (req, res) => {
    const active = await service.activeSession(req.user.username);
    if (!active) return res.json({ ok: true, alreadyStopped: true });
    await service.endSession(active.id, { reason: 'user', by: req.user.username });
    await auditFromReq(req, 'location_session_stopped', 'Stopped their work session (location recording off).');
    res.json({ ok: true });
  }));
  // The phone's notification "Stop work session" button (it only holds the upload token).
  router.post('/sessions/stop-upload', enabled, uploadAuth, ah(async (req, res) => {
    if (!req.locSession.ended_at) {
      await service.endSession(req.locSession.id, { reason: 'user', by: req.user.username });
      await auditFromReq(req, 'location_session_stopped', 'Stopped their work session from the phone notification.');
    }
    res.json({ ok: true, sessionActive: false });
  }));
  router.post('/points', enabled, express.json({ limit: '2mb' }), uploadAuth, uploadLimiter, ah(async (req, res) => {
    const session = req.locSession;
    if (session.ended_at) {
      // Points recorded before the session ended (e.g. offline) are still accepted; nothing after.
      const r = await service.ingest(session, req.body || {});
      return res.status(r.accepted || r.duplicates ? 200 : 409).json({ ...r, sessionActive: false });
    }
    const r = await service.ingest(session, req.body || {});
    res.json({ ...r, sessionActive: true, config: await service.clientConfig() });
  }));
  router.post('/indoor/sightings', enabled, uploadAuth, uploadLimiter, ah(async (req, res) => {
    if (req.locSession.ended_at) return res.status(409).json({ error: 'No active work session.', sessionActive: false });
    const s = await service.getSettings();
    if (!s.indoorEnabled) return res.status(403).json({ error: 'Indoor positioning is not enabled.' });
    res.json(await indoor.ingestSightings(req.locSession, req.body || {}));
  }));
  router.get('/me/history', enabled, userAuth, ah(async (req, res) => {
    const { from, to } = range(req, 7);
    res.json(await service.history(req.user.username, from, to));
  }));
  router.get('/me/access-log', enabled, userAuth, ah(async (req, res) => {
    const r = await q(`SELECT l.viewer_username, u.name AS viewer_name, l.viewer_role, l.action, l.detail, l.created_at FROM location_access_log l
      LEFT JOIN users u ON u.username = l.viewer_username WHERE l.subject_username = $1 ORDER BY l.created_at DESC LIMIT 200`, [req.user.username]);
    res.json(r.rows);
  }));
  async function exportPerson(username) {
    const one = (t, p) => q(t, p).then(r => r.rows);
    return {
      exportedAt: new Date().toISOString(), username,
      consents: await one('SELECT policy_version, accepted_at, withdrawn_at FROM location_consents WHERE username = $1 ORDER BY accepted_at', [username]),
      sessions: await one('SELECT id, started_at, ended_at, end_reason, platform, device_label, points_count, distance_m FROM location_sessions WHERE username = $1 ORDER BY started_at', [username]),
      points: await one('SELECT session_id, recorded_at, lat, lng, accuracy_m, altitude_m, speed_mps, heading, battery, is_moving, source FROM location_points WHERE username = $1 ORDER BY recorded_at LIMIT 200000', [username]),
      visits: await one('SELECT v.arrived_at, v.departed_at, v.duration_s, g.name AS place FROM geofence_visits v JOIN geofences g ON g.id = v.geofence_id WHERE v.username = $1 AND v.confirmed_at IS NOT NULL ORDER BY v.arrived_at', [username]),
      indoor: await one('SELECT p.recorded_at, f.name AS floor, z.name AS zone, p.x, p.y, p.method FROM indoor_positions p JOIN indoor_floors f ON f.id = p.floor_id LEFT JOIN indoor_zones z ON z.id = p.zone_id WHERE p.username = $1 ORDER BY p.recorded_at', [username]),
      accessLog: await one('SELECT viewer_username, viewer_role, action, detail, created_at FROM location_access_log WHERE subject_username = $1 ORDER BY created_at', [username]),
    };
  }
  router.get('/me/export', enabled, userAuth, ah(async (req, res) => {
    res.setHeader('Content-Disposition', `attachment; filename="my-location-data-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json(await exportPerson(req.user.username));
  }));

  // ================= managers =================
  router.get('/live', enabled, userAuth, ah(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const v = String(service.version());
    if (req.query.v && req.query.v === v) return res.json({ v, unchanged: true });
    const scope = await scopeOf(req.user);
    if (!isManager(scope)) return res.status(403).json({ error: 'You can only see your own location.' });
    const s = await service.getSettings();
    const users = await usersMap();
    const rows = (await q(`SELECT s.*, g.name AS place_name, g.kind AS place_kind FROM location_sessions s LEFT JOIN geofences g ON g.id = s.current_geofence_id
      WHERE s.ended_at IS NULL ORDER BY s.started_at`)).rows.filter(r => canSee(scope, users.get(r.username)));
    const now = Date.now();
    const people = rows.map(r => {
      const u = users.get(r.username) || {};
      // Age of the newest FIX (not of the last upload): an offline phone that just synced an hour of
      // old points is still "no recent fix" — we don't know where they are now.
      const ageMin = r.last_point_at ? (now - new Date(r.last_point_at)) / 60000 : null;
      let status = 'waiting';
      if (r.last_point_at) status = ageMin > s.signalLostMin ? 'lost' : ageMin > s.staleAfterMin ? 'stale' : (r.current_geofence_id ? 'at_place' : (r.last_is_moving || (r.last_speed_mps || 0) > 1 ? 'moving' : 'stationary'));
      return { username: r.username, name: u.name || r.username, team: u.team || null, sessionId: r.id, startedAt: r.started_at, platform: r.platform,
        lat: r.last_lat, lng: r.last_lng, accuracyM: r.last_accuracy_m, speedKmh: r.last_speed_mps != null ? Math.round(r.last_speed_mps * 36) / 10 : null,
        battery: r.last_battery, lastPointAt: r.last_point_at, lastReceivedAt: r.last_received_at, place: r.current_geofence_id ? { id: r.current_geofence_id, name: r.place_name, kind: r.place_kind } : null,
        status, distanceKm: Math.round((r.distance_m || 0) / 100) / 10 };
    });
    // Latest indoor position (last 5 min) for people inside a building with beacons/UWB.
    if (people.length && s.indoorEnabled) {
      const ind = (await q(`SELECT DISTINCT ON (p.username) p.username, p.floor_id, f.name AS floor_name, z.name AS zone_name, z.kind AS zone_kind, p.method, p.recorded_at
        FROM indoor_positions p JOIN indoor_floors f ON f.id = p.floor_id LEFT JOIN indoor_zones z ON z.id = p.zone_id
        WHERE p.username = ANY($1::text[]) AND p.recorded_at > now() - interval '5 minutes' ORDER BY p.username, p.recorded_at DESC`, [people.map(p => p.username)])).rows;
      const byUser = new Map(ind.map(r => [r.username, r]));
      for (const p of people) { const r = byUser.get(p.username); if (r) p.indoor = { floorId: r.floor_id, floor: r.floor_name, zone: r.zone_name, zoneKind: r.zone_kind, method: r.method, at: r.recorded_at }; }
    }
    await logAccess(req, people.map(p => p.username), 'live_map', 'Viewed the live map');
    res.json({ v, people, places: await service.activePlaces(), staleAfterMin: s.staleAfterMin });
  }));
  router.get('/history', enabled, userAuth, ah(async (req, res) => {
    const username = str(req.query.username) || req.user.username;
    const scope = await scopeOf(req.user);
    const subject = await db.getUser(username);
    if (!subject || !canSee(scope, subject)) return res.status(403).json({ error: "You can't see this person's location." });
    const { from, to } = range(req, 7);
    const out = await service.history(username, from, to, { raw: req.query.raw === '1' });
    await logAccess(req, [username], 'history', `Route ${from.toISOString().slice(0, 10)} → ${to.toISOString().slice(0, 10)}`);
    res.json({ username, name: subject.name, from, to, ...out });
  }));
  router.get('/sessions', enabled, userAuth, ah(async (req, res) => {
    const scope = await scopeOf(req.user);
    const { from, to } = range(req, 31);
    const r = await q(`SELECT id, username, started_at, ended_at, end_reason, platform, device_label, points_count, distance_m, last_received_at FROM location_sessions
      WHERE started_at < $2 AND (ended_at IS NULL OR ended_at >= $1) ORDER BY started_at DESC LIMIT 2000`, [from, to]);
    const users = await usersMap();
    res.json(r.rows.filter(x => canSee(scope, users.get(x.username))));
  }));
  router.post('/sessions/:id/stop', enabled, userAuth, ah(async (req, res) => {
    const s = await service.getSession(req.params.id);
    if (!s) return res.status(404).json({ error: 'Session not found.' });
    if (s.username !== req.user.username && req.user.role !== 'admin') return res.status(403).json({ error: 'Only the employee or Admin can stop a session.' });
    await service.endSession(s.id, { reason: s.username === req.user.username ? 'user' : 'admin', by: req.user.username });
    if (s.username !== req.user.username) {
      await auditFromReq(req, 'location_session_stopped_by_admin', `Stopped ${s.username}'s work session.`);
      await db.createNotification({ username: s.username, type: 'location', message: `📍 ${req.user.name} stopped your work session — your location is no longer being recorded.` });
    }
    res.json({ ok: true });
  }));

  // ---------- places ----------
  function placeFromBody(b, partial = false) {
    const out = {};
    if (!partial || b.name !== undefined) { out.name = str(b.name, 120); if (!out.name) throw Object.assign(new Error('Give the place a name.'), { status: 400 }); }
    if (!partial || b.kind !== undefined) { out.kind = PLACE_KINDS.includes(b.kind) ? b.kind : 'site'; }
    if (!partial || b.shape !== undefined || b.polygon !== undefined) {
      const poly = Array.isArray(b.polygon) ? b.polygon.map(p => [Number(p[0]), Number(p[1])]).filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1])) : null;
      out.shape = b.shape === 'polygon' && poly && poly.length >= 3 ? 'polygon' : 'circle';
      out.polygon = out.shape === 'polygon' ? JSON.stringify(poly.slice(0, 200)) : null;
      if (out.shape === 'polygon' && (b.lat === undefined || b.lng === undefined)) {
        b.lat = poly.reduce((s, p) => s + p[0], 0) / poly.length; b.lng = poly.reduce((s, p) => s + p[1], 0) / poly.length;
      }
    }
    if (!partial || b.lat !== undefined || b.lng !== undefined) {
      const lat = Number(b.lat), lng = Number(b.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw Object.assign(new Error('Pick the place on the map.'), { status: 400 });
      out.center_lat = lat; out.center_lng = lng;
    }
    if (!partial || b.radiusM !== undefined) out.radius_m = Math.max(20, Math.min(5000, numOr(b.radiusM, 150)));
    if (b.project !== undefined) out.project = str(b.project, 200) || null;
    if (b.address !== undefined) out.address = str(b.address, 300) || null;
    if (b.notes !== undefined) out.notes = str(b.notes, 1000) || null;
    if (!partial || b.minDwellSeconds !== undefined) out.min_dwell_seconds = Math.max(0, Math.min(3600, Math.round(numOr(b.minDwellSeconds, 120))));
    if (b.restricted !== undefined) out.restricted = !!b.restricted;
    if (b.active !== undefined) out.active = !!b.active;
    return out;
  }
  router.get('/places', enabled, userAuth, ah(async (req, res) => {
    res.json(await service.listPlaces({ includeInactive: req.query.all === '1' && (req.user.role === 'admin' || req.user.role === 'director') }));
  }));
  router.post('/places', enabled, userAuth, placeManagers, ah(async (req, res) => {
    const p = placeFromBody(req.body || {});
    const cols = Object.keys(p);
    const r = await q(`INSERT INTO geofences (${cols.join(', ')}, created_by) VALUES (${cols.map((c, i) => c === 'polygon' ? `$${i + 1}::jsonb` : `$${i + 1}`).join(', ')}, $${cols.length + 1}) RETURNING *`,
      [...cols.map(c => p[c]), req.user.username]);
    service.invalidatePlaces();
    await auditFromReq(req, 'location_place_created', `Added place "${p.name}" (${p.kind}, ${p.shape === 'polygon' ? 'outline' : `${p.radius_m} m radius`}).`);
    res.json(r.rows[0]);
  }));
  router.put('/places/:id', enabled, userAuth, placeManagers, ah(async (req, res) => {
    const p = placeFromBody(req.body || {}, true);
    const cols = Object.keys(p);
    if (!cols.length) return res.status(400).json({ error: 'Nothing to change.' });
    const r = await q(`UPDATE geofences SET ${cols.map((c, i) => `${c} = $${i + 2}${c === 'polygon' ? '::jsonb' : ''}`).join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
      [Number(req.params.id) || 0, ...cols.map(c => p[c])]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Place not found.' });
    service.invalidatePlaces();
    await auditFromReq(req, 'location_place_updated', `Changed place "${r.rows[0].name}".`);
    res.json(r.rows[0]);
  }));
  router.delete('/places/:id', enabled, userAuth, placeManagers, ah(async (req, res) => {
    const r = await q('DELETE FROM geofences WHERE id = $1 RETURNING name', [Number(req.params.id) || 0]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Place not found.' });
    service.invalidatePlaces();
    await auditFromReq(req, 'location_place_deleted', `Deleted place "${r.rows[0].name}" (and its visit history).`);
    res.json({ ok: true });
  }));

  // ---------- visits & reports ----------
  router.get('/visits', enabled, userAuth, ah(async (req, res) => {
    const scope = await scopeOf(req.user);
    const { from, to } = range(req, 92);
    const params = [from, to];
    let where = 'v.confirmed_at IS NOT NULL AND v.arrived_at < $2 AND (v.departed_at IS NULL OR v.departed_at >= $1)';
    if (req.query.placeId) { params.push(Number(req.query.placeId) || 0); where += ` AND v.geofence_id = $${params.length}`; }
    if (req.query.username) { params.push(str(req.query.username)); where += ` AND v.username = $${params.length}`; }
    const users = await usersMap();
    const rows = (await q(`SELECT v.id, v.geofence_id, v.username, v.arrived_at, v.departed_at, v.duration_s, g.name AS place_name, g.kind AS place_kind, g.project,
        (SELECT json_agg(json_build_object('taskId', l.task_id, 'how', l.how, 'title', t.title)) FROM visit_task_links l LEFT JOIN tasks t ON t.id = l.task_id WHERE l.visit_id = v.id) AS tasks
      FROM geofence_visits v JOIN geofences g ON g.id = v.geofence_id WHERE ${where} ORDER BY v.arrived_at DESC LIMIT 5000`, params)).rows
      .filter(r => canSee(scope, users.get(r.username)))
      .map(r => ({ ...r, name: (users.get(r.username) || {}).name || r.username }));
    await logAccess(req, rows.map(r => r.username), 'visits', 'Viewed place visits');
    res.json(rows);
  }));
  router.get('/reports/summary', enabled, userAuth, ah(async (req, res) => {
    const scope = await scopeOf(req.user);
    if (!isManager(scope)) return res.status(403).json({ error: 'Reports are for Admin, Directors and team leads.' });
    const { from, to } = range(req, 92);
    const users = await usersMap();
    const sess = (await q(`SELECT username, COUNT(*)::int AS sessions,
        SUM(EXTRACT(EPOCH FROM (LEAST(COALESCE(ended_at, now()), $2) - GREATEST(started_at, $1))) / 60)::int AS tracked_min,
        SUM(distance_m)::float AS distance_m
      FROM location_sessions WHERE started_at < $2 AND (ended_at IS NULL OR ended_at >= $1) GROUP BY username`, [from, to])).rows;
    const vis = (await q(`SELECT v.username, v.geofence_id, g.name, g.kind, g.project, COUNT(*)::int AS visits,
        SUM(EXTRACT(EPOCH FROM (LEAST(COALESCE(v.departed_at, v.last_inside_at), $2) - GREATEST(v.arrived_at, $1))) / 60)::int AS minutes
      FROM geofence_visits v JOIN geofences g ON g.id = v.geofence_id
      WHERE v.confirmed_at IS NOT NULL AND v.arrived_at < $2 AND (v.departed_at IS NULL OR v.departed_at >= $1)
      GROUP BY v.username, v.geofence_id, g.name, g.kind, g.project`, [from, to])).rows;
    const visible = (u) => canSee(scope, users.get(u));
    const people = new Map();
    for (const r of sess.filter(r => visible(r.username))) people.set(r.username, { username: r.username, name: (users.get(r.username) || {}).name || r.username, team: (users.get(r.username) || {}).team || '', sessions: r.sessions, trackedMin: r.tracked_min || 0, distanceKm: Math.round((r.distance_m || 0) / 100) / 10, visits: 0, placeMin: 0, places: new Set() });
    const places = new Map();
    for (const r of vis.filter(r => visible(r.username))) {
      const p = people.get(r.username) || { username: r.username, name: (users.get(r.username) || {}).name || r.username, team: (users.get(r.username) || {}).team || '', sessions: 0, trackedMin: 0, distanceKm: 0, visits: 0, placeMin: 0, places: new Set() };
      p.visits += r.visits; p.placeMin += r.minutes || 0; p.places.add(r.name); people.set(r.username, p);
      const pl = places.get(r.geofence_id) || { placeId: r.geofence_id, name: r.name, kind: r.kind, project: r.project, visits: 0, minutes: 0, people: new Set() };
      pl.visits += r.visits; pl.minutes += r.minutes || 0; pl.people.add(r.username); places.set(r.geofence_id, pl);
    }
    const byPerson = Array.from(people.values()).map(p => ({ ...p, places: Array.from(p.places) })).sort((a, b) => a.name.localeCompare(b.name));
    const byPlace = Array.from(places.values()).map(p => ({ ...p, people: p.people.size })).sort((a, b) => b.minutes - a.minutes);
    await logAccess(req, byPerson.map(p => p.username), 'report', `Summary report ${from.toISOString().slice(0, 10)} → ${to.toISOString().slice(0, 10)}`);
    if (req.query.format === 'csv') {
      const esc = (v) => { const s2 = v == null ? '' : String(v); return /[",\n]/.test(s2) ? `"${s2.replace(/"/g, '""')}"` : s2; };
      const lines = ['Employee,Username,Department,Sessions,Tracked hours,Distance km,Place visits,Hours at places,Places'];
      for (const p of byPerson) lines.push([p.name, p.username, p.team, p.sessions, (p.trackedMin / 60).toFixed(1), p.distanceKm, p.visits, (p.placeMin / 60).toFixed(1), p.places.join('; ')].map(esc).join(','));
      lines.push('', 'Place,Type,Project,Visits,People,Hours');
      for (const p of byPlace) lines.push([p.name, p.kind, p.project || '', p.visits, p.people, (p.minutes / 60).toFixed(1)].map(esc).join(','));
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="location-report-${from.toISOString().slice(0, 10)}.csv"`);
      return res.send('﻿' + lines.join('\n'));
    }
    res.json({ from, to, byPerson, byPlace });
  }));

  // ---------- alerts ----------
  function ruleFromBody(b) {
    const kind = RULE_KINDS.includes(b.kind) ? b.kind : null;
    if (!kind) throw Object.assign(new Error('Pick what the alert is for.'), { status: 400 });
    const threshold = b.threshold === '' || b.threshold == null ? null : Number(b.threshold);
    if (['speeding', 'overtime'].includes(kind) && !(threshold > 0)) throw Object.assign(new Error(kind === 'speeding' ? 'Set the speed limit (km/h).' : 'Set the number of hours.'), { status: 400 });
    const list = (v) => (Array.isArray(v) ? v.map(x => str(x, 100)).filter(Boolean).slice(0, 200) : []);
    return { name: str(b.name, 120) || kind, kind, geofence_id: b.placeId ? Number(b.placeId) : null, departments: JSON.stringify(list(b.departments)), usernames: JSON.stringify(list(b.usernames)),
      threshold: Number.isFinite(threshold) ? threshold : null, recipients: JSON.stringify(list(b.recipients)), notify_employee: !!b.notifyEmployee, active: b.active === undefined ? true : !!b.active };
  }
  router.get('/alert-rules', enabled, userAuth, adminOnly, ah(async (req, res) => {
    res.json((await q('SELECT r.*, g.name AS place_name FROM location_alert_rules r LEFT JOIN geofences g ON g.id = r.geofence_id ORDER BY r.id')).rows);
  }));
  router.post('/alert-rules', enabled, userAuth, adminOnly, ah(async (req, res) => {
    const r0 = ruleFromBody(req.body || {});
    const r = await q(`INSERT INTO location_alert_rules (name, kind, geofence_id, departments, usernames, threshold, recipients, notify_employee, active, created_by)
      VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7::jsonb,$8,$9,$10) RETURNING *`, [r0.name, r0.kind, r0.geofence_id, r0.departments, r0.usernames, r0.threshold, r0.recipients, r0.notify_employee, r0.active, req.user.username]);
    await auditFromReq(req, 'location_alert_rule_created', `Created location alert "${r0.name}" (${r0.kind}).`);
    res.json(r.rows[0]);
  }));
  router.put('/alert-rules/:id', enabled, userAuth, adminOnly, ah(async (req, res) => {
    const r0 = ruleFromBody(req.body || {});
    const r = await q(`UPDATE location_alert_rules SET name=$2, kind=$3, geofence_id=$4, departments=$5::jsonb, usernames=$6::jsonb, threshold=$7, recipients=$8::jsonb, notify_employee=$9, active=$10
      WHERE id = $1 RETURNING *`, [Number(req.params.id) || 0, r0.name, r0.kind, r0.geofence_id, r0.departments, r0.usernames, r0.threshold, r0.recipients, r0.notify_employee, r0.active]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Alert not found.' });
    await auditFromReq(req, 'location_alert_rule_updated', `Changed location alert "${r0.name}".`);
    res.json(r.rows[0]);
  }));
  router.delete('/alert-rules/:id', enabled, userAuth, adminOnly, ah(async (req, res) => {
    const r = await q('DELETE FROM location_alert_rules WHERE id = $1 RETURNING name', [Number(req.params.id) || 0]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Alert not found.' });
    await auditFromReq(req, 'location_alert_rule_deleted', `Deleted location alert "${r.rows[0].name}".`);
    res.json({ ok: true });
  }));
  router.get('/alerts', enabled, userAuth, ah(async (req, res) => {
    const scope = await scopeOf(req.user);
    const users = await usersMap();
    const rows = (await q(`SELECT e.*, r.name AS rule_name, r.recipients FROM location_alert_events e LEFT JOIN location_alert_rules r ON r.id = e.rule_id
      ORDER BY e.created_at DESC LIMIT 500`)).rows
      .filter(e => scope.all || e.username === req.user.username || (e.recipients || []).includes(req.user.username) || (isManager(scope) && canSee(scope, users.get(e.username))));
    res.json(rows.map(({ recipients, ...e }) => ({ ...e, name: (users.get(e.username) || {}).name || e.username })));
  }));
  router.post('/alerts/:id/ack', enabled, userAuth, ah(async (req, res) => {
    const scope = await scopeOf(req.user);
    const e = (await q('SELECT * FROM location_alert_events WHERE id = $1', [Number(req.params.id) || 0])).rows[0];
    if (!e) return res.status(404).json({ error: 'Alert not found.' });
    if (!(scope.all || (isManager(scope) && canSee(scope, await db.getUser(e.username))))) return res.status(403).json({ error: 'Not allowed.' });
    await q('UPDATE location_alert_events SET acknowledged_by = $2, acknowledged_at = now() WHERE id = $1 AND acknowledged_at IS NULL', [e.id, req.user.username]);
    res.json({ ok: true });
  }));

  // ---------- policy / privacy (Admin) ----------
  router.get('/settings', enabled, userAuth, adminOnly, ah(async (req, res) => res.json(await service.getSettings())));
  router.put('/settings', enabled, userAuth, adminOnly, ah(async (req, res) => {
    const b = req.body || {};
    const patch = {};
    const intIn = (k, lo, hi) => { if (b[k] !== undefined) { const n = Math.round(Number(b[k])); if (!Number.isFinite(n) || n < lo || n > hi) throw Object.assign(new Error(`${k} must be between ${lo} and ${hi}.`), { status: 400 }); patch[k] = n; } };
    intIn('movingIntervalSec', 5, 300); intIn('stationaryIntervalSec', 30, 1800); intIn('distanceFilterM', 5, 500); intIn('uploadEverySec', 15, 900);
    intIn('maxAccuracyM', 10, 500); intIn('maxSessionHours', 1, 24); intIn('staleAfterMin', 2, 120); intIn('signalLostMin', 5, 240);
    if (b.policyText !== undefined) { const t = str(b.policyText, 8000); if (t.length < 50) throw Object.assign(new Error('The notice must explain the tracking (at least 50 characters).'), { status: 400 }); patch.policyText = t; }
    if (b.allowedHours !== undefined) {
      if (b.allowedHours === null) patch.allowedHours = null;
      else if (/^\d{2}:\d{2}$/.test(b.allowedHours.start || '') && /^\d{2}:\d{2}$/.test(b.allowedHours.end || '')) patch.allowedHours = { start: b.allowedHours.start, end: b.allowedHours.end };
      else throw Object.assign(new Error('Working hours must look like 07:00 – 21:00.'), { status: 400 });
    }
    if (b.trackedDepartments !== undefined) patch.trackedDepartments = Array.isArray(b.trackedDepartments) ? b.trackedDepartments.map(x => str(x, 100)).filter(Boolean) : [];
    for (const k of ['teamLeadsCanView', 'directorsCanView', 'indoorEnabled']) if (b[k] !== undefined) patch[k] = !!b[k];
    if (b.retention !== undefined) {
      patch.retention = {};
      for (const [k, lo, hi] of [['pointsDays', 1, 3650], ['visitsDays', 1, 3650], ['indoorDays', 1, 3650], ['accessLogDays', 90, 3650], ['alertDays', 7, 3650]]) {
        if (b.retention[k] !== undefined) { const n = Math.round(Number(b.retention[k])); if (!Number.isFinite(n) || n < lo || n > hi) throw Object.assign(new Error(`Retention ${k} must be between ${lo} and ${hi} days.`), { status: 400 }); patch.retention[k] = n; }
      }
    }
    const before = await service.getSettings();
    const after = await service.updateSettings(patch, req.user.username);
    await auditFromReq(req, 'location_policy_updated', `Changed location tracking policy: ${Object.keys(patch).join(', ')}${after.policyVersion !== before.policyVersion ? ` — notice is now version ${after.policyVersion}; everyone must accept it again before their next session` : ''}.`);
    res.json(after);
  }));
  router.get('/access-log', enabled, userAuth, adminOnly, ah(async (req, res) => {
    const params = [];
    let where = '1=1';
    if (req.query.subject) { params.push(str(req.query.subject)); where += ` AND subject_username = $${params.length}`; }
    if (req.query.viewer) { params.push(str(req.query.viewer)); where += ` AND viewer_username = $${params.length}`; }
    res.json((await q(`SELECT * FROM location_access_log WHERE ${where} ORDER BY created_at DESC LIMIT 1000`, params)).rows);
  }));
  router.get('/export', enabled, userAuth, adminOnly, ah(async (req, res) => {
    const username = str(req.query.username);
    if (!(await db.getUser(username))) return res.status(404).json({ error: 'No such person.' });
    await logAccess(req, [username], 'export', 'Exported all location data');
    await auditFromReq(req, 'location_data_exported', `Exported ${username}'s location data.`);
    res.setHeader('Content-Disposition', `attachment; filename="location-data-${username}.json"`);
    res.json(await exportPerson(username));
  }));
  router.delete('/data/:username', enabled, userAuth, adminOnly, ah(async (req, res) => {
    const username = str(req.params.username);
    const before = req.query.before ? new Date(req.query.before) : null;
    if (before && isNaN(before)) return res.status(400).json({ error: 'Invalid date.' });
    const out = await service.deletePersonData(username, before);
    await auditFromReq(req, 'location_data_deleted', `Deleted ${username}'s location data${before ? ` recorded before ${before.toISOString().slice(0, 10)}` : ' (all)'}: ${JSON.stringify(out)}.`);
    res.json({ ok: true, deleted: out });
  }));

  // ---------- tasks ↔ places/visits ----------
  async function taskOr404(req, res) {
    const task = await db.getTask(req.params.taskId);
    if (!task) { res.status(404).json({ error: 'Task not found.' }); return null; }
    if (!(await canViewTask(req.user, task))) { res.status(403).json({ error: "You can't see this task." }); return null; }
    return task;
  }
  router.get('/tasks/:taskId', enabled, userAuth, ah(async (req, res) => {
    const task = await taskOr404(req, res); if (!task) return;
    const places = (await q('SELECT tp.purpose, tp.added_by, tp.added_at, g.* FROM task_places tp JOIN geofences g ON g.id = tp.geofence_id WHERE tp.task_id = $1 ORDER BY g.name', [task.id])).rows;
    const visits = (await q(`SELECT v.id, v.username, v.arrived_at, v.departed_at, v.duration_s, l.how, g.name AS place_name, g.kind AS place_kind
      FROM visit_task_links l JOIN geofence_visits v ON v.id = l.visit_id JOIN geofences g ON g.id = v.geofence_id WHERE l.task_id = $1 ORDER BY v.arrived_at DESC LIMIT 200`, [task.id])).rows;
    const users = await usersMap();
    // Place + times only (no route) — proof of a site visit / delivery for people on the task.
    await logAccess(req, visits.map(v => v.username), 'task_visits', `Visits on task ${task.id}`);
    res.json({ places, visits: visits.map(v => ({ ...v, name: (users.get(v.username) || {}).name || v.username })) });
  }));
  router.post('/tasks/:taskId/places', enabled, userAuth, ah(async (req, res) => {
    const task = await taskOr404(req, res); if (!task) return;
    if (!(req.user.role === 'admin' || req.user.role === 'director' || task.created_by_username === req.user.username)) return res.status(403).json({ error: 'Only the task creator, Directors or Admin can tie a task to a place.' });
    const g = (await q('SELECT * FROM geofences WHERE id = $1', [Number((req.body || {}).placeId) || 0])).rows[0];
    if (!g) return res.status(404).json({ error: 'Place not found.' });
    await q('INSERT INTO task_places (task_id, geofence_id, purpose, added_by) VALUES ($1,$2,$3,$4) ON CONFLICT (task_id, geofence_id) DO UPDATE SET purpose = EXCLUDED.purpose',
      [task.id, g.id, str((req.body || {}).purpose, 200) || null, req.user.username]);
    await db.addTaskEvent({ taskId: task.id, type: 'place_linked', details: `Tied to place "${g.name}"${(req.body || {}).purpose ? ` — ${str(req.body.purpose, 200)}` : ''}. Visits by people on this task will show here.`, actorUsername: req.user.username, actorName: req.user.name, source: 'web' });
    res.json({ ok: true });
  }));
  router.delete('/tasks/:taskId/places/:placeId', enabled, userAuth, ah(async (req, res) => {
    const task = await taskOr404(req, res); if (!task) return;
    if (!(req.user.role === 'admin' || req.user.role === 'director' || task.created_by_username === req.user.username)) return res.status(403).json({ error: 'Not allowed.' });
    await q('DELETE FROM task_places WHERE task_id = $1 AND geofence_id = $2', [task.id, Number(req.params.placeId) || 0]);
    res.json({ ok: true });
  }));
  router.post('/visits/:id/tasks', enabled, userAuth, ah(async (req, res) => {
    const v = (await q('SELECT v.*, g.name AS place_name FROM geofence_visits v JOIN geofences g ON g.id = v.geofence_id WHERE v.id = $1 AND v.confirmed_at IS NOT NULL', [Number(req.params.id) || 0])).rows[0];
    if (!v) return res.status(404).json({ error: 'Visit not found.' });
    if (v.username !== req.user.username && req.user.role !== 'admin') return res.status(403).json({ error: 'Only the person who made the visit can link it to a task.' });
    const task = await db.getTask(str((req.body || {}).taskId));
    if (!task || !(await canViewTask({ username: v.username, role: (await db.getUser(v.username) || {}).role }, task))) return res.status(404).json({ error: 'Task not found (or not one of yours).' });
    const ins = await q("INSERT INTO visit_task_links (visit_id, task_id, how, linked_by) VALUES ($1,$2,'manual',$3) ON CONFLICT DO NOTHING RETURNING task_id", [v.id, task.id, req.user.username]);
    if (ins.rows[0]) await db.addTaskEvent({ taskId: task.id, type: 'site_visit', details: `Checked in: visit to ${v.place_name} (${fmtTime(v.arrived_at)}${v.departed_at ? ` – ${fmtTime(v.departed_at)}` : ', still there'}).`, actorUsername: req.user.username, actorName: req.user.name, source: 'location' });
    res.json({ ok: true });
  }));

  // Arrival at a place → link the visit to the person's open tasks there (tied to that place, or
  // in that place's project), note it in each task's history, and tell the person.
  service.hooks.onVisitConfirmed.push(async (session, g, visit) => {
    const tasks = (await q(`SELECT DISTINCT t.id, t.title, (EXISTS (SELECT 1 FROM task_places tp WHERE tp.task_id = t.id AND tp.geofence_id = $2)) AS by_place
      FROM tasks t JOIN task_assignees a ON a.task_id = t.id
      WHERE a.username = $1 AND t.status = 'open' AND a.completed_at IS NULL
        AND (EXISTS (SELECT 1 FROM task_places tp WHERE tp.task_id = t.id AND tp.geofence_id = $2) OR ($3::text IS NOT NULL AND t.project = $3))
      LIMIT 50`, [session.username, g.id, g.project || null])).rows;
    const user = await db.getUser(session.username);
    for (const t of tasks) {
      const ins = await q('INSERT INTO visit_task_links (visit_id, task_id, how) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING task_id', [visit.id, t.id, t.by_place ? 'place' : 'project']);
      if (ins.rows[0] && t.by_place) await db.addTaskEvent({ taskId: t.id, type: 'site_visit', details: `Arrived at ${g.name} (${fmtTime(visit.arrived_at)}).`, actorUsername: session.username, actorName: user ? user.name : session.username, actorTeam: user ? user.team : null, source: 'location' });
    }
    if (tasks.length) await db.createNotification({ username: session.username, type: 'location', message: `📍 You're at ${g.name} — ${tasks.length} open task${tasks.length > 1 ? 's' : ''} here: ${tasks.slice(0, 3).map(t => `"${t.title}"`).join(', ')}${tasks.length > 3 ? '…' : ''}`, task_id: tasks.length === 1 ? tasks[0].id : null });
  });
  service.hooks.onVisitEnded.push(async (session, g, visit) => {
    const linked = (await q("SELECT task_id FROM visit_task_links WHERE visit_id = $1 AND how IN ('place','manual')", [visit.id])).rows;
    const user = await db.getUser(session.username);
    for (const l of linked) await db.addTaskEvent({ taskId: l.task_id, type: 'site_visit', details: `Left ${g.name} after ${Math.round((visit.duration_s || 0) / 60)} min.`, actorUsername: session.username, actorName: user ? user.name : session.username, actorTeam: user ? user.team : null, source: 'location' });
  });
  function fmtTime(d) { return new Date(new Date(d).getTime() + 5.5 * 3600000).toISOString().slice(11, 16) + ' IST'; }

  // ---------- indoor (Admin) ----------
  router.get('/indoor/floors', enabled, userAuth, ah(async (req, res) => {
    res.json((await q(`SELECT f.id, f.geofence_id, f.name, f.level, f.width_px, f.height_px, f.meters_per_px, (f.plan_image IS NOT NULL) AS has_plan, g.name AS place_name,
      (SELECT COUNT(*)::int FROM indoor_zones z WHERE z.floor_id = f.id) AS zones, (SELECT COUNT(*)::int FROM indoor_anchors a WHERE a.floor_id = f.id) AS anchors
      FROM indoor_floors f LEFT JOIN geofences g ON g.id = f.geofence_id ORDER BY g.name NULLS LAST, f.level`)).rows);
  }));
  router.get('/indoor/floors/:id', enabled, userAuth, ah(async (req, res) => {
    const f = (await q('SELECT id, geofence_id, name, level, width_px, height_px, meters_per_px FROM indoor_floors WHERE id = $1', [Number(req.params.id) || 0])).rows[0];
    if (!f) return res.status(404).json({ error: 'Floor not found.' });
    const zones = (await q('SELECT * FROM indoor_zones WHERE floor_id = $1 ORDER BY name', [f.id])).rows;
    const anchors = req.user.role === 'admin' ? (await q('SELECT * FROM indoor_anchors WHERE floor_id = $1 ORDER BY label, identifier', [f.id])).rows : [];
    res.json({ ...f, zones, anchors });
  }));
  router.get('/indoor/floors/:id/plan', enabled, userAuth, ah(async (req, res) => {
    const f = (await q('SELECT plan_image FROM indoor_floors WHERE id = $1', [Number(req.params.id) || 0])).rows[0];
    if (!f || !f.plan_image) return res.status(404).json({ error: 'No floor plan uploaded.' });
    res.json({ data: f.plan_image });
  }));
  function floorFromBody(b, partial) {
    const out = {};
    if (!partial || b.name !== undefined) { out.name = str(b.name, 120); if (!out.name) throw Object.assign(new Error('Name the floor.'), { status: 400 }); }
    if (b.level !== undefined) out.level = Math.round(numOr(b.level, 0));
    if (b.placeId !== undefined) out.geofence_id = b.placeId ? Number(b.placeId) : null;
    if (b.planImage !== undefined) {
      if (b.planImage && (!/^data:image\/(png|jpeg|webp|svg\+xml);base64,/.test(b.planImage) || b.planImage.length > MAX_PLAN_CHARS)) throw Object.assign(new Error('Floor plan must be a PNG, JPG, WEBP or SVG image under ~9 MB.'), { status: 400 });
      out.plan_image = b.planImage || null;
    }
    if (b.widthPx !== undefined) out.width_px = Math.round(numOr(b.widthPx, 0)) || null;
    if (b.heightPx !== undefined) out.height_px = Math.round(numOr(b.heightPx, 0)) || null;
    if (b.metersPerPx !== undefined) out.meters_per_px = numOr(b.metersPerPx, null);
    return out;
  }
  router.post('/indoor/floors', enabled, userAuth, adminOnly, ah(async (req, res) => {
    const f = floorFromBody(req.body || {}, false);
    const cols = Object.keys(f);
    const r = await q(`INSERT INTO indoor_floors (${cols.join(', ')}, created_by) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}, $${cols.length + 1}) RETURNING id, name, level`, [...cols.map(c => f[c]), req.user.username]);
    await auditFromReq(req, 'location_floor_created', `Added indoor floor "${f.name}".`);
    res.json(r.rows[0]);
  }));
  router.put('/indoor/floors/:id', enabled, userAuth, adminOnly, ah(async (req, res) => {
    const f = floorFromBody(req.body || {}, true);
    const cols = Object.keys(f);
    if (!cols.length) return res.status(400).json({ error: 'Nothing to change.' });
    const r = await q(`UPDATE indoor_floors SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING id, name`, [Number(req.params.id) || 0, ...cols.map(c => f[c])]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Floor not found.' });
    indoor.invalidate();
    res.json(r.rows[0]);
  }));
  router.delete('/indoor/floors/:id', enabled, userAuth, adminOnly, ah(async (req, res) => {
    const r = await q('DELETE FROM indoor_floors WHERE id = $1 RETURNING name', [Number(req.params.id) || 0]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Floor not found.' });
    indoor.invalidate();
    await auditFromReq(req, 'location_floor_deleted', `Deleted indoor floor "${r.rows[0].name}" with its zones, beacons and positions.`);
    res.json({ ok: true });
  }));
  const pixelPoly = (v) => (Array.isArray(v) ? v.map(p => [Number(p[0]), Number(p[1])]).filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1])).slice(0, 200) : []);
  router.post('/indoor/floors/:id/zones', enabled, userAuth, adminOnly, ah(async (req, res) => {
    const b = req.body || {};
    const poly = pixelPoly(b.polygon);
    if (poly.length < 3) return res.status(400).json({ error: 'Draw the zone with at least 3 corners.' });
    const kind = ZONE_KINDS.includes(b.kind) ? b.kind : 'room';
    const r = await q('INSERT INTO indoor_zones (floor_id, name, kind, polygon, restricted) VALUES ($1,$2,$3,$4::jsonb,$5) RETURNING *',
      [Number(req.params.id) || 0, str(b.name, 120) || 'Zone', kind, JSON.stringify(poly), !!b.restricted || kind === 'restricted']);
    res.json(r.rows[0]);
  }));
  router.put('/indoor/zones/:id', enabled, userAuth, adminOnly, ah(async (req, res) => {
    const b = req.body || {};
    const poly = b.polygon !== undefined ? pixelPoly(b.polygon) : null;
    if (poly && poly.length < 3) return res.status(400).json({ error: 'A zone needs at least 3 corners.' });
    const r = await q(`UPDATE indoor_zones SET name = COALESCE($2, name), kind = COALESCE($3, kind), polygon = COALESCE($4::jsonb, polygon), restricted = COALESCE($5, restricted) WHERE id = $1 RETURNING *`,
      [Number(req.params.id) || 0, b.name !== undefined ? str(b.name, 120) : null, ZONE_KINDS.includes(b.kind) ? b.kind : null, poly ? JSON.stringify(poly) : null, b.restricted !== undefined ? !!b.restricted : null]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Zone not found.' });
    res.json(r.rows[0]);
  }));
  router.delete('/indoor/zones/:id', enabled, userAuth, adminOnly, ah(async (req, res) => {
    await q('DELETE FROM indoor_zones WHERE id = $1', [Number(req.params.id) || 0]);
    res.json({ ok: true });
  }));
  router.post('/indoor/floors/:id/anchors', enabled, userAuth, adminOnly, ah(async (req, res) => {
    const b = req.body || {};
    const kind = b.kind === 'uwb' ? 'uwb' : 'ble';
    let identifier = str(b.identifier, 120).toLowerCase();
    if (kind === 'ble' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\d{1,5}:\d{1,5}$/.test(identifier)) return res.status(400).json({ error: 'iBeacon id must be UUID:major:minor (e.g. f7826da6-4fa2-4e98-8024-bc5b71e0893e:1:12).' });
    if (!identifier) return res.status(400).json({ error: 'Give the anchor an id.' });
    const x = Number(b.x), y = Number(b.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return res.status(400).json({ error: 'Place the beacon on the floor plan.' });
    try {
      const r = await q('INSERT INTO indoor_anchors (floor_id, kind, identifier, label, x, y, tx_power) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
        [Number(req.params.id) || 0, kind, identifier, str(b.label, 120) || null, x, y, b.txPower === undefined || b.txPower === '' ? null : Number(b.txPower)]);
      indoor.invalidate();
      res.json(r.rows[0]);
    } catch (e) { if (e.code === '23505') return res.status(409).json({ error: 'That beacon is already placed.' }); throw e; }
  }));
  router.put('/indoor/anchors/:id', enabled, userAuth, adminOnly, ah(async (req, res) => {
    const b = req.body || {};
    const r = await q('UPDATE indoor_anchors SET label = COALESCE($2, label), x = COALESCE($3, x), y = COALESCE($4, y), tx_power = COALESCE($5, tx_power) WHERE id = $1 RETURNING *',
      [Number(req.params.id) || 0, b.label !== undefined ? str(b.label, 120) : null, numOr(b.x, null), numOr(b.y, null), numOr(b.txPower, null)]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Beacon not found.' });
    indoor.invalidate();
    res.json(r.rows[0]);
  }));
  router.delete('/indoor/anchors/:id', enabled, userAuth, adminOnly, ah(async (req, res) => {
    await q('DELETE FROM indoor_anchors WHERE id = $1', [Number(req.params.id) || 0]);
    indoor.invalidate();
    res.json({ ok: true });
  }));
  router.get('/indoor/tags', enabled, userAuth, adminOnly, ah(async (req, res) => res.json((await q('SELECT * FROM indoor_tags ORDER BY username')).rows)));
  router.post('/indoor/tags', enabled, userAuth, adminOnly, ah(async (req, res) => {
    const tagId = str((req.body || {}).tagId, 120), username = str((req.body || {}).username, 100);
    if (!tagId || !(await db.getUser(username))) return res.status(400).json({ error: 'Give the badge id and pick the person.' });
    await q('INSERT INTO indoor_tags (tag_id, username, assigned_by) VALUES ($1,$2,$3) ON CONFLICT (tag_id) DO UPDATE SET username = EXCLUDED.username, assigned_by = EXCLUDED.assigned_by, assigned_at = now()', [tagId, username, req.user.username]);
    await auditFromReq(req, 'location_badge_assigned', `Assigned indoor badge ${tagId} to ${username}.`);
    res.json({ ok: true });
  }));
  router.delete('/indoor/tags/:tagId', enabled, userAuth, adminOnly, ah(async (req, res) => {
    await q('DELETE FROM indoor_tags WHERE tag_id = $1', [str(req.params.tagId)]);
    res.json({ ok: true });
  }));
  router.get('/indoor/live', enabled, userAuth, ah(async (req, res) => {
    const scope = await scopeOf(req.user);
    if (!isManager(scope)) return res.status(403).json({ error: 'Not allowed.' });
    const users = await usersMap();
    const rows = (await q(`SELECT DISTINCT ON (p.username) p.username, p.x, p.y, p.zone_id, z.name AS zone_name, p.method, p.accuracy_m, p.recorded_at
      FROM indoor_positions p LEFT JOIN indoor_zones z ON z.id = p.zone_id JOIN location_sessions s ON s.id = p.session_id AND s.ended_at IS NULL
      WHERE p.floor_id = $1 AND p.recorded_at > now() - interval '5 minutes' ORDER BY p.username, p.recorded_at DESC`, [Number(req.query.floorId) || 0])).rows
      .filter(r => canSee(scope, users.get(r.username))).map(r => ({ ...r, name: (users.get(r.username) || {}).name || r.username }));
    await logAccess(req, rows.map(r => r.username), 'live_map', 'Viewed indoor positions');
    res.json(rows);
  }));
  router.get('/integration-keys', enabled, userAuth, adminOnly, ah(async (req, res) => res.json((await q('SELECT id, name, key_prefix, created_by, created_at, last_used_at, revoked_at FROM location_integration_keys ORDER BY id')).rows)));
  router.post('/integration-keys', enabled, userAuth, adminOnly, ah(async (req, res) => {
    const name = str((req.body || {}).name, 120);
    if (!name) return res.status(400).json({ error: 'Name the integration (e.g. "Pozyx — head office").' });
    const k = await indoor.createKey(name, req.user.username);
    await auditFromReq(req, 'location_integration_key_created', `Created indoor-positioning integration key "${name}" (${k.key_prefix}…).`);
    res.json(k);
  }));
  router.delete('/integration-keys/:id', enabled, userAuth, adminOnly, ah(async (req, res) => {
    await q('UPDATE location_integration_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [Number(req.params.id) || 0]);
    await auditFromReq(req, 'location_integration_key_revoked', `Revoked indoor-positioning integration key #${req.params.id}.`);
    res.json({ ok: true });
  }));
  // Machine endpoint for UWB/RTLS engines. Header: X-Location-Key: mtk_loc_…
  router.post('/indoor/rtls', enabled, express.json({ limit: '2mb' }), ah(async (req, res) => {
    const key = await indoor.checkKey(req.headers['x-location-key']);
    if (!key) return res.status(401).json({ error: 'Invalid or revoked integration key.' });
    const s = await service.getSettings();
    if (!s.indoorEnabled) return res.status(403).json({ error: 'Indoor positioning is not enabled.' });
    res.json(await indoor.ingestRtls(req.body || {}));
  }));

  app.use('/api/location', router);

  // ---------- background jobs ----------
  if (jobs) {
    jobs.register('LOCATION_MONITOR', async () => (featureEnabled() ? service.monitor() : { skipped: 'disabled' }), { maxAttempts: 2, baseDelayMs: 30000 });
    jobs.register('LOCATION_RETENTION', async () => service.purgeExpired(), { maxAttempts: 3 });
    jobs.every('LOCATION_MONITOR', 2 * 60 * 1000);
    jobs.dailyAt('LOCATION_RETENTION', '02:45'); // runs even if tracking is later switched off
  }
  return { service, indoor };
}

module.exports = { mountLocation };
