// Location tracking — core logic (sessions, ingestion, places/visits engine, alerts, retention).
// HTTP routes live in routes.js; pure geometry in geo.js. All SQL uses the pg pool directly with
// $n placeholders (no `?` conversion), inside the same database as the rest of the app.
const geo = require('./geo');

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const MAX_POINTS_PER_UPLOAD = 500;
const MAX_ACCEPTED_ACCURACY_M = 1000; // anything worse is not a position, it's a guess
const CLOCK_SKEW_MS = 2 * 60 * 1000;

const DEFAULT_POLICY_TEXT = [
  'MIHIR Task Manager records your location ONLY while you have a work session switched on ("Start work") — never outside it.',
  'What is recorded: GPS/network position, time, accuracy, speed, direction and phone battery level, plus arrivals at and departures from company places (offices, sites, warehouses, suppliers). In offices with indoor beacons, the room/zone you are in.',
  'Why: to coordinate site work and deliveries, confirm site visits on tasks, and keep people safe on site.',
  'Who can see it: you; Admin; Directors for the departments they manage; your department\'s team lead (if the company allows it). Every time someone else views your location it is logged, and you can see that log.',
  'How long it is kept: route points for the number of days set by Admin (shown below), then deleted automatically.',
  'Your control: you start and stop sessions yourself; the phone always shows that tracking is on; you can download your data, and you can withdraw this consent at any time (tracking stops immediately).',
].join('\n\n');

const DEFAULT_SETTINGS = {
  policyVersion: 1,
  policyText: DEFAULT_POLICY_TEXT,
  movingIntervalSec: 15,
  stationaryIntervalSec: 120,
  distanceFilterM: 20,
  uploadEverySec: 60,
  maxAccuracyM: 100,          // fixes worse than this are stored but never decide arrivals/departures
  maxSessionHours: 14,
  allowedHours: { start: '06:00', end: '22:00' }, // IST; null = any time
  trackedDepartments: [],     // [] = every department may use tracking
  teamLeadsCanView: true,
  directorsCanView: true,
  staleAfterMin: 10,
  signalLostMin: 20,
  indoorEnabled: false,
  retention: { pointsDays: 90, visitsDays: 365, indoorDays: 30, accessLogDays: 730, alertDays: 365 },
};

function istParts(date = new Date()) {
  const d = new Date(date.getTime() + IST_OFFSET_MS);
  return { day: d.toISOString().slice(0, 10), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
}
function hhmmToMin(s) { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; }
// Start of an IST calendar day as a UTC Date.
function istDayStart(day) { return new Date(new Date(`${day}T00:00:00Z`).getTime() - IST_OFFSET_MS); }

function createLocationService({ pool, db, log = () => {} }) {
  let settingsCache = null;
  let placesCache = null;
  let version = 1; // bumps on every change the live map shows (single-instance in-memory counter)
  const bump = () => { version++; };

  const q = (text, params) => pool.query(text, params);

  // ---------- settings ----------
  function normaliseSettings(raw) {
    const s = { ...DEFAULT_SETTINGS, ...(raw || {}) };
    s.retention = { ...DEFAULT_SETTINGS.retention, ...((raw || {}).retention || {}) };
    return s;
  }
  async function getSettings() {
    if (settingsCache && Date.now() - settingsCache.at < 30000) return settingsCache.value;
    const r = await q('SELECT settings FROM location_settings WHERE id = 1');
    const value = normaliseSettings(r.rows[0] && r.rows[0].settings);
    settingsCache = { at: Date.now(), value };
    return value;
  }
  async function updateSettings(patch, byUsername) {
    const current = await getSettings();
    const next = normaliseSettings({ ...current, ...patch, retention: { ...current.retention, ...(patch.retention || {}) } });
    if (patch.policyText !== undefined && String(patch.policyText).trim() !== String(current.policyText).trim()) next.policyVersion = current.policyVersion + 1;
    else next.policyVersion = current.policyVersion;
    await q(`INSERT INTO location_settings (id, settings, updated_by, updated_at) VALUES (1, $1::jsonb, $2, now())
             ON CONFLICT (id) DO UPDATE SET settings = EXCLUDED.settings, updated_by = EXCLUDED.updated_by, updated_at = now()`, [JSON.stringify(next), byUsername]);
    settingsCache = null;
    return getSettings();
  }
  // What the phone/web tracker needs to know.
  async function clientConfig() {
    const s = await getSettings();
    const cfg = {
      movingIntervalSec: s.movingIntervalSec, stationaryIntervalSec: s.stationaryIntervalSec,
      distanceFilterM: s.distanceFilterM, uploadEverySec: s.uploadEverySec, maxAccuracyM: s.maxAccuracyM,
      indoor: { enabled: !!s.indoorEnabled, uuids: [] },
    };
    if (s.indoorEnabled) {
      const r = await q("SELECT DISTINCT lower(split_part(identifier, ':', 1)) AS uuid FROM indoor_anchors WHERE kind = 'ble'");
      cfg.indoor.uuids = r.rows.map(x => x.uuid).filter(u => /^[0-9a-f-]{32,36}$/.test(u));
    }
    return cfg;
  }

  // ---------- consent ----------
  async function consentStatus(username) {
    const s = await getSettings();
    const r = await q('SELECT * FROM location_consents WHERE username = $1 ORDER BY accepted_at DESC LIMIT 1', [username]);
    const c = r.rows[0];
    const active = !!c && !c.withdrawn_at;
    return { accepted: active && c.policy_version === s.policyVersion, acceptedVersion: active ? c.policy_version : null, acceptedAt: active ? c.accepted_at : null, currentVersion: s.policyVersion };
  }
  async function acceptConsent(username, policyVersion, meta = {}) {
    const s = await getSettings();
    if (Number(policyVersion) !== s.policyVersion) { const e = new Error('The tracking notice has changed — please read the current version.'); e.status = 409; throw e; }
    await q('UPDATE location_consents SET withdrawn_at = now() WHERE username = $1 AND withdrawn_at IS NULL', [username]);
    await q('INSERT INTO location_consents (username, policy_version, ip_address, device) VALUES ($1, $2, $3, $4)', [username, s.policyVersion, meta.ip || null, meta.device || null]);
  }
  async function withdrawConsent(username) {
    await q('UPDATE location_consents SET withdrawn_at = now() WHERE username = $1 AND withdrawn_at IS NULL', [username]);
    const active = await activeSession(username);
    if (active) await endSession(active.id, { reason: 'consent_withdrawn', by: username });
  }

  // ---------- eligibility / sessions ----------
  async function eligibility(user) {
    const s = await getSettings();
    if (s.trackedDepartments.length && !s.trackedDepartments.includes(user.team || '')) return { ok: false, reason: 'Location tracking is not used for your department.' };
    if (s.allowedHours) {
      const start = hhmmToMin(s.allowedHours.start), end = hhmmToMin(s.allowedHours.end);
      const now = istParts().minutes;
      if (start != null && end != null && !(start <= end ? (now >= start && now < end) : (now >= start || now < end))) {
        return { ok: false, reason: `Work sessions can only run between ${s.allowedHours.start} and ${s.allowedHours.end}.` };
      }
    }
    return { ok: true };
  }
  async function activeSession(username) {
    const r = await q('SELECT * FROM location_sessions WHERE username = $1 AND ended_at IS NULL', [username]);
    return r.rows[0] || null;
  }
  async function getSession(id) {
    const r = await q('SELECT * FROM location_sessions WHERE id = $1', [Number(id) || 0]);
    return r.rows[0] || null;
  }
  async function startSession(user, meta = {}) {
    const consent = await consentStatus(user.username);
    if (!consent.accepted) { const e = new Error('Please read and accept the location notice first.'); e.status = 409; e.code = 'consent_required'; throw e; }
    const el = await eligibility(user);
    if (!el.ok) { const e = new Error(el.reason); e.status = 403; throw e; }
    const existing = await activeSession(user.username);
    if (existing) return { session: existing, resumed: true };
    try {
      const r = await q(`INSERT INTO location_sessions (username, platform, device_id, device_label, app_version)
        VALUES ($1, $2, $3, $4, $5) RETURNING *`, [user.username, str(meta.platform, 20) || 'web', str(meta.deviceId, 100) || null, str(meta.deviceLabel, 120) || null, str(meta.appVersion, 40) || null]);
      bump();
      return { session: r.rows[0], resumed: false };
    } catch (e) {
      if (e.code === '23505') return { session: await activeSession(user.username), resumed: true }; // started twice at once
      throw e;
    }
  }
  async function endSession(sessionId, { reason = 'user', by = null } = {}) {
    const r = await q(`UPDATE location_sessions SET ended_at = now(), end_reason = $2, ended_by = $3
      WHERE id = $1 AND ended_at IS NULL RETURNING *`, [sessionId, reason, by]);
    const s = r.rows[0];
    if (!s) return null;
    // Close any stay that was still open; unconfirmed (too short) stays are dropped.
    await q(`DELETE FROM geofence_visits WHERE session_id = $1 AND departed_at IS NULL AND confirmed_at IS NULL`, [s.id]);
    await q(`UPDATE geofence_visits SET departed_at = last_inside_at, duration_s = GREATEST(0, EXTRACT(EPOCH FROM (last_inside_at - arrived_at)))::int, end_reason = 'session_ended'
      WHERE session_id = $1 AND departed_at IS NULL`, [s.id]);
    await q('UPDATE location_sessions SET current_geofence_id = NULL WHERE id = $1', [s.id]);
    bump();
    return s;
  }

  // ---------- places (geofences) ----------
  async function listPlaces({ includeInactive = false } = {}) {
    const r = await q(`SELECT * FROM geofences ${includeInactive ? '' : 'WHERE active'} ORDER BY name`);
    return r.rows;
  }
  async function activePlaces() {
    if (placesCache && Date.now() - placesCache.at < 60000) return placesCache.rows;
    const rows = await listPlaces();
    placesCache = { at: Date.now(), rows };
    return rows;
  }
  function invalidatePlaces() { placesCache = null; bump(); }

  // ---------- ingestion ----------
  // Accepts our own format and the common background-geolocation SDK format (Transistorsoft):
  //   { points: [{ id, t, lat, lng, acc, alt, spd, hdg, bat, moving, src }] }
  //   { location: { uuid, timestamp, coords: { latitude, longitude, accuracy, ... }, battery: { level }, is_moving } }  (or an array)
  function normalisePoints(body) {
    let list = [];
    if (Array.isArray(body.points)) list = body.points;
    else if (Array.isArray(body.location)) list = body.location;
    else if (body.location && typeof body.location === 'object') list = [body.location];
    return list.map((p) => {
      if (p && p.coords) {
        return {
          id: str(p.uuid || p.id || p.timestamp, 80), t: p.timestamp, lat: Number(p.coords.latitude), lng: Number(p.coords.longitude),
          acc: num(p.coords.accuracy), alt: num(p.coords.altitude), spd: num(p.coords.speed), hdg: num(p.coords.heading),
          bat: p.battery && num(p.battery.level), moving: typeof p.is_moving === 'boolean' ? p.is_moving : null, src: 'sdk',
        };
      }
      p = p || {};
      return { id: str(p.id, 80), t: p.t, lat: Number(p.lat), lng: Number(p.lng), acc: num(p.acc), alt: num(p.alt), spd: num(p.spd), hdg: num(p.hdg), bat: num(p.bat), moving: typeof p.moving === 'boolean' ? p.moving : null, src: str(p.src, 20) || null };
    });
  }

  async function ingest(session, body) {
    const settings = await getSettings();
    const raw = normalisePoints(body || {});
    if (raw.length > MAX_POINTS_PER_UPLOAD) { const e = new Error(`At most ${MAX_POINTS_PER_UPLOAD} points per upload.`); e.status = 413; throw e; }
    const now = Date.now();
    const startMs = new Date(session.started_at).getTime() - CLOCK_SKEW_MS;
    const endMs = session.ended_at ? new Date(session.ended_at).getTime() + CLOCK_SKEW_MS : now + CLOCK_SKEW_MS;
    const good = [], rejected = [];
    for (const p of raw) {
      const t = typeof p.t === 'number' ? new Date(p.t) : new Date(p.t);
      if (!p.id) { rejected.push({ id: null, reason: 'missing id' }); continue; }
      if (isNaN(t)) { rejected.push({ id: p.id, reason: 'bad time' }); continue; }
      if (!geo.validLatLng(p.lat, p.lng)) { rejected.push({ id: p.id, reason: 'bad coordinates' }); continue; }
      if (t.getTime() < startMs || t.getTime() > endMs) { rejected.push({ id: p.id, reason: 'outside the work session' }); continue; }
      if (p.acc != null && p.acc > MAX_ACCEPTED_ACCURACY_M) { rejected.push({ id: p.id, reason: 'too inaccurate' }); continue; }
      good.push({ ...p, t, bat: p.bat != null && p.bat > 1 ? p.bat / 100 : p.bat });
    }
    good.sort((a, b) => a.t - b.t);
    let inserted = [];
    if (good.length) {
      const cols = { ids: [], t: [], lat: [], lng: [], acc: [], alt: [], spd: [], hdg: [], bat: [], mov: [], src: [] };
      for (const p of good) {
        cols.ids.push(p.id); cols.t.push(p.t.toISOString()); cols.lat.push(p.lat); cols.lng.push(p.lng); cols.acc.push(p.acc); cols.alt.push(p.alt);
        cols.spd.push(p.spd != null && p.spd >= 0 ? p.spd : null); cols.hdg.push(p.hdg != null && p.hdg >= 0 ? p.hdg : null); cols.bat.push(p.bat); cols.mov.push(p.moving); cols.src.push(p.src);
      }
      const r = await q(`INSERT INTO location_points (session_id, username, client_point_id, recorded_at, lat, lng, accuracy_m, altitude_m, speed_mps, heading, battery, is_moving, source)
        SELECT $1, $2, u.id, u.t, u.lat, u.lng, u.acc, u.alt, u.spd, u.hdg, u.bat, u.mov, u.src
        FROM unnest($3::text[], $4::timestamptz[], $5::float8[], $6::float8[], $7::real[], $8::real[], $9::real[], $10::real[], $11::real[], $12::boolean[], $13::text[])
          AS u(id, t, lat, lng, acc, alt, spd, hdg, bat, mov, src)
        ON CONFLICT (session_id, client_point_id) DO NOTHING
        RETURNING id, client_point_id, recorded_at, lat, lng, accuracy_m, speed_mps, battery, is_moving`,
      [session.id, session.username, cols.ids, cols.t, cols.lat, cols.lng, cols.acc, cols.alt, cols.spd, cols.hdg, cols.bat, cols.mov, cols.src]);
      inserted = r.rows.sort((a, b) => new Date(a.recorded_at) - new Date(b.recorded_at));
    }
    const duplicates = good.length - inserted.length;
    if (inserted.length) await afterInsert(session, inserted, settings);
    return { accepted: inserted.length, duplicates, rejected };
  }

  // Updates the session summary and runs places/alerts on points NEWER than what was already
  // processed (a late offline batch still fills in the route, but can't rewrite past arrivals).
  async function afterInsert(session, points, settings) {
    const watermark = session.last_point_at ? new Date(session.last_point_at).getTime() : 0;
    const fresh = points.filter(p => new Date(p.recorded_at).getTime() > watermark);
    let distance = 0;
    let prev = session.last_lat != null ? { lat: session.last_lat, lng: session.last_lng, recorded_at: session.last_point_at } : null;
    for (const p of fresh) {
      if (prev && (p.accuracy_m == null || p.accuracy_m <= settings.maxAccuracyM)) {
        const d = geo.distanceM(prev.lat, prev.lng, p.lat, p.lng);
        const dt = (new Date(p.recorded_at) - new Date(prev.recorded_at)) / 1000;
        if (dt > 0 && d / dt <= 70 && d >= Math.min(10, (p.accuracy_m || 0) / 2)) distance += d;
      }
      if (p.accuracy_m == null || p.accuracy_m <= settings.maxAccuracyM) prev = p;
    }
    const last = fresh[fresh.length - 1];
    if (last) {
      await q(`UPDATE location_sessions SET last_point_at = $2, last_received_at = now(), last_lat = $3, last_lng = $4, last_accuracy_m = $5,
          last_speed_mps = $6, last_battery = COALESCE($7, last_battery), last_is_moving = $8, points_count = points_count + $9, distance_m = distance_m + $10
        WHERE id = $1`, [session.id, last.recorded_at, last.lat, last.lng, last.accuracy_m, last.speed_mps, last.battery, last.is_moving, points.length, distance]);
    } else {
      await q('UPDATE location_sessions SET last_received_at = now(), points_count = points_count + $2 WHERE id = $1', [session.id, points.length]);
    }
    const usable = fresh.filter(p => p.accuracy_m == null || p.accuracy_m <= settings.maxAccuracyM);
    if (usable.length) {
      await runPlacesEngine(session, usable);
      await checkSpeeding(session, usable);
    }
    bump();
  }

  // ---------- places engine (arrivals / departures) ----------
  async function runPlacesEngine(session, points) {
    const places = await activePlaces();
    if (!places.length) return;
    const openR = await q('SELECT * FROM geofence_visits WHERE username = $1 AND departed_at IS NULL', [session.username]);
    const open = new Map(openR.rows.map(v => [String(v.geofence_id), v]));
    for (const p of points) {
      const t = new Date(p.recorded_at);
      for (const g of places) {
        const state = geo.classifyAgainstGeofence(g, p.lat, p.lng, p.accuracy_m);
        const v = open.get(String(g.id));
        if (state === 'inside') {
          if (!v) {
            const ins = await q(`INSERT INTO geofence_visits (geofence_id, username, session_id, arrived_at, last_inside_at)
              VALUES ($1, $2, $3, $4, $4) ON CONFLICT DO NOTHING RETURNING *`, [g.id, session.username, session.id, t]);
            if (ins.rows[0]) {
              open.set(String(g.id), ins.rows[0]);
              if (Number(g.min_dwell_seconds) <= 0) {
                ins.rows[0].confirmed_at = t;
                await q('UPDATE geofence_visits SET confirmed_at = $2 WHERE id = $1', [ins.rows[0].id, t]);
                await onArrival(session, g, ins.rows[0]);
              }
            }
          } else if (t > new Date(v.last_inside_at)) {
            v.last_inside_at = t; v.outside_streak = 0;
            await q('UPDATE geofence_visits SET last_inside_at = $2, outside_streak = 0 WHERE id = $1', [v.id, t]);
            if (!v.confirmed_at && (t - new Date(v.arrived_at)) / 1000 >= g.min_dwell_seconds) {
              v.confirmed_at = t;
              await q('UPDATE geofence_visits SET confirmed_at = $2 WHERE id = $1', [v.id, t]);
              await onArrival(session, g, v);
            }
          }
        } else if (state === 'outside' && v) {
          v.outside_streak = (v.outside_streak || 0) + 1;
          if (v.outside_streak >= 2) {
            open.delete(String(g.id));
            if (!v.confirmed_at) { await q('DELETE FROM geofence_visits WHERE id = $1', [v.id]); continue; } // drive-by
            const dur = Math.max(0, Math.round((new Date(v.last_inside_at) - new Date(v.arrived_at)) / 1000));
            await q(`UPDATE geofence_visits SET departed_at = last_inside_at, duration_s = $2, outside_streak = $3, end_reason = 'left' WHERE id = $1`, [v.id, dur, v.outside_streak]);
            await onDeparture(session, g, { ...v, duration_s: dur });
          } else {
            await q('UPDATE geofence_visits SET outside_streak = $2 WHERE id = $1', [v.id, v.outside_streak]);
          }
        }
      }
    }
    // The live map shows the place of the most recent confirmed open stay.
    const cur = await q(`SELECT geofence_id FROM geofence_visits WHERE username = $1 AND departed_at IS NULL AND confirmed_at IS NOT NULL ORDER BY arrived_at DESC LIMIT 1`, [session.username]);
    await q('UPDATE location_sessions SET current_geofence_id = $2 WHERE id = $1', [session.id, cur.rows[0] ? cur.rows[0].geofence_id : null]);
  }

  const hooks = { onVisitConfirmed: [], onVisitEnded: [] };
  async function onArrival(session, g, visit) {
    await fireRules('arrive', session, { geofence: g, dedupe: `arrive:${visit.id}`, message: (u) => `${u} arrived at ${g.name} (${istTime(visit.arrived_at)})` });
    if (g.restricted) await fireRules('restricted_entry', session, { geofence: g, message: (u) => `${u} entered restricted place ${g.name}`, dedupe: `restricted:${visit.id}` });
    for (const fn of hooks.onVisitConfirmed) { try { await fn(session, g, visit); } catch (e) { log('ERROR', 'visit hook failed', { error: e.message }); } }
  }
  async function onDeparture(session, g, visit) {
    const mins = Math.round((visit.duration_s || 0) / 60);
    await fireRules('depart', session, { geofence: g, dedupe: `depart:${visit.id}`, message: (u) => `${u} left ${g.name} at ${istTime(visit.last_inside_at)} after ${mins} min` });
    for (const fn of hooks.onVisitEnded) { try { await fn(session, g, visit); } catch (e) { log('ERROR', 'visit hook failed', { error: e.message }); } }
  }

  // ---------- alerts ----------
  async function rulesFor(kind, username, geofenceId) {
    const user = await db.getUser(username);
    const r = await q('SELECT * FROM location_alert_rules WHERE active AND kind = $1', [kind]);
    return r.rows.filter(rule => {
      if (rule.geofence_id && geofenceId != null && String(rule.geofence_id) !== String(geofenceId)) return false;
      const deps = rule.departments || [], users = rule.usernames || [];
      if (!deps.length && !users.length) return true;
      return users.includes(username) || (user && deps.includes(user.team));
    });
  }
  async function fireRules(kind, session, { geofence = null, message, dedupe = null, value = null }) {
    const rules = await rulesFor(kind, session.username, geofence ? geofence.id : null);
    if (!rules.length) return 0;
    const user = await db.getUser(session.username);
    const name = user ? user.name : session.username;
    let fired = 0;
    for (const rule of rules) {
      if (value != null && (rule.threshold == null || value < rule.threshold)) continue; // value rules need a threshold
      const key = `${rule.id}:${dedupe || `${kind}:${session.id}:${geofence ? geofence.id : ''}:${Date.now()}`}`;
      const text = message(name);
      const ins = await q(`INSERT INTO location_alert_events (rule_id, kind, username, session_id, geofence_id, message, dedupe_key)
        VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`, [rule.id, kind, session.username, session.id, geofence ? geofence.id : null, text, key]);
      if (!ins.rows[0]) continue;
      fired++;
      let recipients = Array.isArray(rule.recipients) ? rule.recipients.slice() : [];
      if (!recipients.length) recipients = (await db.listUsers()).filter(u => u.role === 'admin').map(u => u.username);
      if (rule.notify_employee) recipients.push(session.username);
      for (const to of new Set(recipients)) {
        if (to === session.username && !rule.notify_employee) continue;
        await db.createNotification({ username: to, type: 'location_alert', message: `📍 ${text}` });
      }
    }
    return fired;
  }
  async function checkSpeeding(session, points) {
    // "Sustained" = two consecutive fixes over the limit (one spike is GPS noise).
    const withSpeed = points.filter(p => p.speed_mps != null);
    let best = 0, at = null;
    for (let i = 1; i < withSpeed.length; i++) {
      const kmh = Math.min(withSpeed[i].speed_mps, withSpeed[i - 1].speed_mps) * 3.6;
      if (kmh > best) { best = kmh; at = withSpeed[i].recorded_at; }
    }
    if (best <= 0) return;
    const bucket = Math.floor(new Date(at).getTime() / (15 * 60000)); // at most one alert per 15 min
    await fireRules('speeding', session, { value: best, dedupe: `speed:${session.id}:${bucket}`, message: (u) => `${u} travelling at ${Math.round(best)} km/h` });
  }

  // ---------- periodic monitor (job) ----------
  async function monitor(now = new Date()) {
    const s = await getSettings();
    const stats = { autoStopped: 0, signalLost: 0, overtime: 0 };
    const active = (await q('SELECT * FROM location_sessions WHERE ended_at IS NULL')).rows;
    const nowMin = istParts(now).minutes;
    const start = s.allowedHours ? hhmmToMin(s.allowedHours.start) : null, end = s.allowedHours ? hhmmToMin(s.allowedHours.end) : null;
    const outsideHours = start != null && end != null && !(start <= end ? (nowMin >= start && nowMin < end) : (nowMin >= start || nowMin < end));
    for (const sess of active) {
      const hours = (now - new Date(sess.started_at)) / 3600000;
      let reason = null;
      if (hours >= s.maxSessionHours) reason = 'auto_max_hours';
      else if (outsideHours) reason = 'auto_outside_hours';
      if (reason) {
        await endSession(sess.id, { reason, by: 'system' });
        await db.createNotification({ username: sess.username, type: 'location', message: reason === 'auto_max_hours'
          ? `📍 Your work session was stopped automatically after ${s.maxSessionHours} hours — location is no longer being recorded.`
          : '📍 Your work session was stopped automatically (outside working hours) — location is no longer being recorded.' });
        stats.autoStopped++;
        continue;
      }
      const lastHeard = new Date(sess.last_received_at || sess.started_at);
      const silentMin = (now - lastHeard) / 60000;
      const lostRules = await rulesFor('signal_lost', sess.username, null);
      for (const rule of lostRules) {
        const limit = rule.threshold != null ? rule.threshold : s.signalLostMin;
        if (silentMin >= limit) {
          if (await fireOne(rule, sess, 'signal_lost', `no location received for ${Math.round(silentMin)} min (phone off, no signal, or app stopped)`, `lost:${sess.id}:${lastHeard.toISOString()}`)) stats.signalLost++;
        }
      }
      const otRules = await rulesFor('overtime', sess.username, null);
      for (const rule of otRules) {
        if (rule.threshold != null && hours >= rule.threshold) {
          if (await fireOne(rule, sess, 'overtime', `work session running for ${hours.toFixed(1)} h`, `ot:${sess.id}`)) stats.overtime++;
        }
      }
    }
    if (stats.autoStopped) bump();
    return stats;
  }
  async function fireOne(rule, sess, kind, what, dedupe) {
    const user = await db.getUser(sess.username);
    const text = `${user ? user.name : sess.username}: ${what}`;
    const ins = await q(`INSERT INTO location_alert_events (rule_id, kind, username, session_id, message, dedupe_key)
      VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`, [rule.id, kind, sess.username, sess.id, text, `${rule.id}:${dedupe}`]);
    if (!ins.rows[0]) return false;
    let recipients = Array.isArray(rule.recipients) ? rule.recipients.slice() : [];
    if (!recipients.length) recipients = (await db.listUsers()).filter(u => u.role === 'admin').map(u => u.username);
    if (rule.notify_employee) recipients.push(sess.username);
    for (const to of new Set(recipients)) await db.createNotification({ username: to, type: 'location_alert', message: `📍 ${text}` });
    return true;
  }

  // ---------- retention ----------
  async function purgeExpired(now = new Date()) {
    const s = await getSettings();
    const days = (n) => new Date(now.getTime() - Number(n) * 86400000);
    const out = {};
    out.points = (await q('DELETE FROM location_points WHERE recorded_at < $1', [days(s.retention.pointsDays)])).rowCount;
    out.indoor = (await q('DELETE FROM indoor_positions WHERE recorded_at < $1', [days(s.retention.indoorDays)])).rowCount;
    out.visits = (await q('DELETE FROM geofence_visits WHERE arrived_at < $1 AND departed_at IS NOT NULL', [days(s.retention.visitsDays)])).rowCount;
    out.sessions = (await q('DELETE FROM location_sessions WHERE ended_at IS NOT NULL AND ended_at < $1', [days(Math.max(s.retention.visitsDays, s.retention.pointsDays))])).rowCount;
    out.alerts = (await q('DELETE FROM location_alert_events WHERE created_at < $1', [days(s.retention.alertDays)])).rowCount;
    out.accessLog = (await q('DELETE FROM location_access_log WHERE created_at < $1', [days(s.retention.accessLogDays)])).rowCount;
    return out;
  }
  // Admin "delete this person's location data" (e.g. on leaving / on request). Consents are kept
  // as the record of what was agreed; everything positional goes.
  async function deletePersonData(username, before = null) {
    const cut = before ? new Date(before) : null;
    const out = {};
    if (!cut) {
      const active = await activeSession(username);
      if (active) await endSession(active.id, { reason: 'data_deleted', by: 'admin' });
      out.sessions = (await q('DELETE FROM location_sessions WHERE username = $1', [username])).rowCount;
      out.visits = (await q('DELETE FROM geofence_visits WHERE username = $1', [username])).rowCount;
      out.points = (await q('DELETE FROM location_points WHERE username = $1', [username])).rowCount;
      out.indoor = (await q('DELETE FROM indoor_positions WHERE username = $1', [username])).rowCount;
      out.alerts = (await q('DELETE FROM location_alert_events WHERE username = $1', [username])).rowCount;
    } else {
      out.points = (await q('DELETE FROM location_points WHERE username = $1 AND recorded_at < $2', [username, cut])).rowCount;
      out.indoor = (await q('DELETE FROM indoor_positions WHERE username = $1 AND recorded_at < $2', [username, cut])).rowCount;
      out.visits = (await q('DELETE FROM geofence_visits WHERE username = $1 AND arrived_at < $2 AND departed_at IS NOT NULL', [username, cut])).rowCount;
      out.sessions = (await q('DELETE FROM location_sessions WHERE username = $1 AND ended_at IS NOT NULL AND ended_at < $2', [username, cut])).rowCount;
    }
    bump();
    return out;
  }

  // ---------- reads ----------
  async function history(username, from, to, { raw = false } = {}) {
    const pts = (await q(`SELECT id, session_id, recorded_at, lat, lng, accuracy_m, speed_mps, heading, battery, is_moving FROM location_points
      WHERE username = $1 AND recorded_at >= $2 AND recorded_at < $3 ORDER BY recorded_at LIMIT 50000`, [username, from, to])).rows;
    const settings = await getSettings();
    const good = pts.filter(p => p.accuracy_m == null || p.accuracy_m <= settings.maxAccuracyM);
    const sessions = (await q(`SELECT id, started_at, ended_at, end_reason, platform, device_label, points_count, distance_m FROM location_sessions
      WHERE username = $1 AND started_at < $3 AND (ended_at IS NULL OR ended_at >= $2) ORDER BY started_at`, [username, from, to])).rows;
    const visits = (await q(`SELECT v.*, g.name AS place_name, g.kind AS place_kind, g.project FROM geofence_visits v JOIN geofences g ON g.id = v.geofence_id
      WHERE v.username = $1 AND v.confirmed_at IS NOT NULL AND v.arrived_at < $3 AND (v.departed_at IS NULL OR v.departed_at >= $2) ORDER BY v.arrived_at`, [username, from, to])).rows;
    const indoor = (await q(`SELECT p.recorded_at, p.floor_id, p.zone_id, p.x, p.y, p.method, p.accuracy_m, z.name AS zone_name, f.name AS floor_name
      FROM indoor_positions p JOIN indoor_floors f ON f.id = p.floor_id LEFT JOIN indoor_zones z ON z.id = p.zone_id
      WHERE p.username = $1 AND p.recorded_at >= $2 AND p.recorded_at < $3 ORDER BY p.recorded_at LIMIT 5000`, [username, from, to])).rows;
    // Time moving = sum of gaps between consecutive moving fixes (capped so a gap in data isn't counted).
    let movingS = 0;
    for (let i = 1; i < good.length; i++) {
      const dt = (new Date(good[i].recorded_at) - new Date(good[i - 1].recorded_at)) / 1000;
      if (dt > 0 && dt < 600 && (good[i].is_moving || (good[i].speed_mps || 0) > 1)) movingS += dt;
    }
    const route = raw ? good : geo.simplifyRoute(good, 6);
    return {
      points: route.map(p => ({ t: p.recorded_at, lat: p.lat, lng: p.lng, acc: p.accuracy_m, spd: p.speed_mps, hdg: p.heading, bat: p.battery, moving: p.is_moving, s: p.session_id })),
      totalPoints: pts.length, sessions, visits, indoor,
      stats: { distanceM: Math.round(geo.routeDistanceM(good)), movingMinutes: Math.round(movingS / 60), placesVisited: new Set(visits.map(v => v.geofence_id)).size,
        trackedMinutes: Math.round(sessions.reduce((s2, x) => s2 + (Math.min(new Date(x.ended_at || Date.now()), new Date(to)) - Math.max(new Date(x.started_at), new Date(from))) / 60000, 0)) },
    };
  }

  return {
    DEFAULT_SETTINGS, getSettings, updateSettings, clientConfig, consentStatus, acceptConsent, withdrawConsent,
    eligibility, activeSession, getSession, startSession, endSession, listPlaces, activePlaces, invalidatePlaces,
    ingest, monitor, purgeExpired, deletePersonData, history, fireRules, hooks, bump,
    version: () => version, istParts, istDayStart,
  };
}

function istTime(d) { return new Date(new Date(d).getTime() + IST_OFFSET_MS).toISOString().slice(11, 16); }
function str(v, max) { if (v == null) return ''; const s = String(v).trim(); return max ? s.slice(0, max) : s; }
function num(v) { const n = Number(v); return v == null || v === '' || !Number.isFinite(n) ? null : n; }

module.exports = { createLocationService, DEFAULT_SETTINGS, istParts, istDayStart };
