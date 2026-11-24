/* Attendance, leave and payroll (monthly-salary staff).

   ATTENDANCE — everyone checks in and out on the phone: the GPS position and a selfie are saved with each, and the
   position is matched to the Places of the Locations page (sites / office): "not at a site" is flagged, never blocked.
   LOCATION RULE (Settings → "Check in / out only inside a site", on by default): check-in, check-out and coming back
   from a break are accepted only inside the circle of a Place (site / office). People marked "can check in anywhere"
   (drivers, purchase…) are exempt. Between check-in and check-out a person may be out of the site for a BREAK
   (☕ Start break → Back from break) — up to the break allowance (1 hour) a day is free; break time beyond it, and time
   location tracking saw them outside every site outside a break beyond what is left of the allowance, is taken off
   the hours worked (so a long absence turns a full day into a half day or absent).
   A day without a check-in is filled from location tracking when the person was tracked that day (first and last
   position = in / out); a missing check-out is filled from tracking the same way.
   Each day is worked out from the rules in Settings: shift start + grace → late mark; hours ≥ full day → Present,
   ≥ half day → Half day, otherwise Absent; weekly off and holidays are paid; time beyond a full day is overtime.
   HR / Admin can correct any day (with a reason, kept with the day).

   LEAVE — the person asks (paid / unpaid, one day, a range or a half day); HR / Admin approve. Paid leave is limited to
   the yearly quota (Settings, or the person's own quota on their salary).

   PAYROLL — HR / Admin keep each person's salary (Basic, HRA, Conveyance, Special allowance; PF / ESI / PT; OT rate;
   bank details) and advances. For a month, HR / Admin PREPARE the payroll (from attendance and leave), may adjust a line
   (OT hours, other earnings / deductions with a note), Admin APPROVES, Accounts / Admin MARK PAID — advances are then
   recovered and everyone can open their payslip. Salary register and bank transfer sheet download as Excel.
     paid days  = present + weekly offs + holidays + paid leave + ½ per half day − ½ day per N late marks (Settings)
     earned     = each component × paid days ÷ days in month
     OT hours   = time beyond the shift (start → end) on a working day, all of it on a weekly off / holiday
     OT         = OT hours × (person's OT rate, or gross ÷ 30 ÷ full-day hours × OT multiplier)
     PF         = PF % of earned Basic (capped at the PF wage ceiling unless "PF on full basic")      — employee share
     ESI        = ESI % of earned gross + OT when the monthly gross is within the ESI limit          — employee share
     PT         = Maharashtra slabs on earned gross (standard: ≤7,500 nil, ≤10,000 ₹175, above ₹200 — ₹300 in
                  February; women's slab: ≤25,000 nil, above ₹200 / ₹300 in February) — or exempt
     net        = earned + OT + other earnings − PF − ESI − PT − advance instalment − other deductions
   The rates are kept in Settings so Accounts can change them when the law changes.

   WHO — everyone: own attendance, leave and payslips. HR: attendance corrections, leave decisions, salaries, prepare
   payroll. Accounts: see payroll, mark paid, bank sheet. Admin: everything, and approves payroll. */
const ExcelJS = require('exceljs');

const DEFAULTS = {
  shiftStart: '09:30', shiftEnd: '18:30', graceMin: 15, fullDayHours: 8, halfDayHours: 4, weeklyOff: [0],
  lateMarksPerHalfDay: 3, otAfterMin: 30, otMultiplier: 1, paidLeavePerYear: 18, selfieRequired: true,
  locationRequired: true, breakAllowanceMin: 60, autoAttendance: true, gpsMaxAccM: 100, checkoutAfterShiftMin: 30, siteTransferMin: 20,
  maxSessionHours: 16, breakRemindMin: 10, autoOutAfterFullDay: true, autoOutMode: 'leave',
  pfPercent: 12, pfWageCeiling: 15000, pfOnFullBasic: false, employerPfPercent: 12,
  esiEmployeePercent: 0.75, esiEmployerPercent: 3.25, esiGrossLimit: 21000,
};
const STATUS_LABEL = { P: 'Present', H: 'Half day', A: 'Absent', L: 'Paid leave', LH: 'Half day leave', U: 'Unpaid leave', WO: 'Weekly off', HO: 'Holiday', F: 'Coming' };
const pad = (n) => String(n).padStart(2, '0');
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const IST_MS = 330 * 60000;
const istDay = (d = new Date()) => new Date(new Date(d).getTime() + IST_MS).toISOString().slice(0, 10);
const istHM = (iso) => iso ? new Date(new Date(iso).getTime() + IST_MS).toISOString().slice(11, 16) : '';
const dayStartUtc = (day) => new Date(Date.parse(`${day}T00:00:00+05:30`));
const daysInMonth = (period) => { const [y, m] = period.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
const monthDays = (period) => Array.from({ length: daysInMonth(period) }, (_, i) => `${period}-${pad(i + 1)}`);
const weekday = (day) => new Date(`${day}T12:00:00Z`).getUTCDay();
const minutesOf = (hm) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const validPeriod = (v) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(v || '')) ? String(v) : null;
const validDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null;
const monthLabel = (p) => { try { return new Date(`${p}-15T12:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }); } catch (e) { return p; } };
function haversine(aLat, aLng, bLat, bLng) {
  const R = 6371000, t = Math.PI / 180;
  const dLat = (bLat - aLat) * t, dLng = (bLng - aLng) * t;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * t) * Math.cos(bLat * t) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
// Maharashtra professional tax for one month
function ptFor(gross, slab, period) {
  if (slab === 'exempt' || gross <= 0) return 0;
  const feb = period.slice(5) === '02';
  if (slab === 'women') return gross <= 25000 ? 0 : feb ? 300 : 200;
  if (gross <= 7500) return 0;
  if (gross <= 10000) return 175;
  return feb ? 300 : 200;
}

function mountPayroll(app, deps) {
  const { db, auth, ALL_ROLES, auditFromReq, str } = deps;
  const q = (sql, params = []) => db.pool.query(sql, params);
  const rows = async (sql, params) => (await q(sql, params)).rows;
  const one = async (sql, params) => (await q(sql, params)).rows[0] || null;
  const now = () => new Date().toISOString();
  const notify = async (users, except, type, message, ref) => { for (const u of new Set(users)) if (u && u !== except) await db.createNotification({ username: u, type, message, task_id: null, ...(ref || {}) }); };

  // ---------- who
  async function me(user) {
    const u = await db.getUser(user.username);
    const team = String((u && u.team) || '');
    const admin = user.role === 'admin';
    const hr = /(^|\b)hr\b|human resource/i.test(team);
    // HR & Payroll is for the HR Department and Admin only: HR prepares and marks paid, Admin approves.
    return { username: user.username, name: (u && u.name) || user.name, team, admin, hr, accounts: false,
      canSeePayroll: admin || hr, canPrepare: admin || hr, canApprove: admin, canPay: admin || hr,
      canEditAttendance: admin || hr, canDecideLeave: admin || hr, canSeeAttendance: admin || hr };
  }
  async function deciders() { return (await db.listUsers()).filter(u => u.role === 'admin' || /(^|\b)hr\b|human resource/i.test(u.team || '')).map(u => u.username); }

  // ---------- settings & holidays
  // Kept for 30 s (every page asks); saving the rules clears it.
  let settingsCache = null;
  async function settings() {
    if (settingsCache && Date.now() - settingsCache.at < 30000) return { ...settingsCache.v };
    const v = await settingsFromDb();
    settingsCache = { at: Date.now(), v };
    return { ...v };
  }
  async function settingsFromDb() {
    const r = await one('SELECT data FROM payroll_settings WHERE id=1');
    return { ...DEFAULTS, ...((r && r.data) || {}) };
  }
  async function holidaysBetween(from, to) { return rows('SELECT day, name FROM payroll_holidays WHERE day BETWEEN $1 AND $2 ORDER BY day', [from, to]); }

  // ---------- places (Locations page) for the site check
  async function places() {
    try { return await rows('SELECT id, name, kind, center_lat, center_lng, radius_m FROM geofences WHERE active = true'); } catch (e) { return []; }
  }
  function placeFor(lat, lng, acc, list, slackCap = 100) {
    if (lat == null || lng == null || !list.length) return { place: null, away: list.length > 0, nearest: null };
    let best = null;
    for (const g of list) {
      const d = haversine(lat, lng, g.center_lat, g.center_lng);
      if (!best || d - g.radius_m < best.d - best.g.radius_m) best = { g, d };
    }
    const slack = Math.min(Number(acc) || 0, slackCap);
    if (best && best.d <= best.g.radius_m + slack) return { place: best.g.name, away: false, nearest: null, metres: Math.round(best.d), radius: best.g.radius_m };
    return { place: null, away: true, nearest: best ? { name: best.g.name, metres: Math.round(best.d) } : null };
  }
  // First and last tracked position of each person on each day of a range (Locations tracking)
  async function trackingSpans(usernames, from, to) {
    if (!usernames.length) return {};
    try {
      const rs = await rows(`SELECT username, to_char(recorded_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS day, MIN(recorded_at) AS first_at, MAX(recorded_at) AS last_at, COUNT(*)::int AS n
        FROM location_points WHERE username = ANY($1::text[]) AND recorded_at >= $2 AND recorded_at < $3 GROUP BY username, day`,
      [usernames, dayStartUtc(from).toISOString(), new Date(dayStartUtc(to).getTime() + 864e5).toISOString()]);
      const out = {};
      for (const r of rs) if (r.n >= 2) out[`${r.username}|${r.day}`] = { first: new Date(r.first_at).toISOString(), last: new Date(r.last_at).toISOString() };
      return out;
    } catch (e) { return {}; }
  }
  async function leavesBetween(usernames, from, to) {
    if (!usernames.length) return [];
    return rows("SELECT * FROM leave_requests WHERE status='approved' AND username = ANY($1::text[]) AND to_day >= $2 AND from_day <= $3", [usernames, from, to]);
  }

  // ---------- one day, worked out
  function evalDay(day, rec, span, ctx) {
    const S = ctx.settings, today = ctx.today;
    const off = (S.weeklyOff || []).includes(weekday(day));
    const hol = ctx.holidays[day] || null;
    const leave = ctx.leaves.find(l => l.from_day <= day && l.to_day >= day) || null;
    let inAt = rec && rec.check_in_at ? rec.check_in_at : null, outAt = rec && rec.check_out_at ? rec.check_out_at : null;
    let source = inAt ? 'phone' : null;
    // Strict: a day counts only from its check-in / check-out (automatic from location, or by GPS on the phone) —
    // never guessed from where the phone was.
    if (inAt) source = rec.in_source === 'auto' ? 'auto' : 'phone';
    if (rec && rec.manual_in) { inAt = rec.manual_in; source = 'corrected'; }
    if (rec && rec.manual_out) { outAt = rec.manual_out; source = 'corrected'; }
    const spanMin = inAt && outAt ? Math.max(0, Math.round((Date.parse(outAt) - Date.parse(inAt)) / 60000)) : null;
    const breakMin = rec ? breakMinutes(rec.breaks, outAt) : 0, awayMin = rec ? Number(rec.away_minutes || 0) : 0;
    // Only breaks the person took (up to the allowance a day is free) reduce the hours. Time spent away from a site
    // (visiting another site, the head office, a shop for material) is work — it is shown, never deducted.
    const extra = Math.max(0, breakMin - Number(S.breakAllowanceMin || 0));
    const worked = spanMin == null ? null : rec && (rec.manual_in || rec.manual_out) ? spanMin : Math.max(0, spanMin - extra);
    const startMin = minutesOf(S.shiftStart);
    const inMin = inAt ? minutesOf(istHM(inAt)) : null;
    const late = inAt && !off && !hol && startMin != null && inMin != null && inMin > startMin + Number(S.graceMin || 0) ? inMin - startMin : 0;
    const full = Number(S.fullDayHours || 8) * 60, half = Number(S.halfDayHours || 4) * 60;
    let status, flags = [];
    if (day > today) status = off ? 'WO' : hol ? 'HO' : 'F';
    else if (off || hol) status = off ? 'WO' : 'HO';
    else if (inAt) {
      if (worked == null) { status = 'P'; if (day < today) flags.push('no check-out'); }
      else status = worked >= full ? 'P' : worked >= half ? 'H' : 'A';
    } else status = 'A';
    // leave covers a day that is not off / a holiday
    if (leave && status !== 'WO' && status !== 'HO') {
      if (leave.half_day) { if (status === 'A' || status === 'F' || status === 'H') status = leave.kind === 'paid' ? 'LH' : (status === 'H' ? 'H' : 'U'); }
      else status = leave.kind === 'paid' ? 'L' : 'U';
    }
    // Overtime: time beyond the shift (shift start → shift end, e.g. 9:30–18:30 = 9 h) on a working day; all of it on
    // a weekly off / holiday.
    let ot = 0;
    const shiftLen = Math.max(full, (minutesOf(S.shiftEnd) || 0) - (minutesOf(S.shiftStart) || 0));
    if (worked != null) {
      if (off || hol) ot = worked;
      else if (worked - shiftLen >= Number(S.otAfterMin || 0)) ot = worked - shiftLen;
    }
    if (rec && rec.status_override) { status = rec.status_override; flags.push('corrected'); }
    if (rec && rec.ot_minutes_override != null) ot = Number(rec.ot_minutes_override);
    if (rec && (rec.in_away || rec.out_away)) flags.push('not at a site');
    if (breakMin) flags.push(`break ${breakMin} min`);
    if (awayMin) flags.push(`${awayMin} min away from sites (counted as work)`);
    if (extra && worked != null) flags.push(`${extra} min over the break allowance not counted`);
    if (source === 'tracking') flags.push('from tracking');
    const how = (src) => src === 'auto' ? 'auto' : src === 'manual' ? 'phone' : src === 'hr' ? 'hr' : '';
    return { day, status, in: inAt ? istHM(inAt) : '', out: outAt ? istHM(outAt) : '', inHow: rec && rec.manual_in ? 'corrected' : how(rec && rec.check_in_at ? (rec.in_source || 'manual') : ''), outHow: rec && rec.manual_out ? 'corrected' : how(rec && rec.check_out_at ? (rec.out_source || 'manual') : ''), inAcc: rec && rec.in_acc != null ? Number(rec.in_acc) : null, outAcc: rec && rec.out_acc != null ? Number(rec.out_acc) : null, worked, breakMin, awayMin, overBreak: extra, late: status === 'P' || status === 'H' ? late : 0, ot: Math.max(0, ot), source, flags,
      inPlace: rec && rec.in_place || '', outPlace: rec && rec.out_place || '', inNote: rec && rec.in_note || '', outNote: rec && rec.out_note || '', hasInPhoto: !!(rec && rec.has_in_photo), hasOutPhoto: !!(rec && rec.has_out_photo),
      note: rec && rec.override_reason || '', holiday: hol, leaveKind: leave ? leave.kind : null };
  }
  // A month for a set of people → { username: [days…] }
  async function monthFor(usernames, period, onlyDays) {
    const days = onlyDays && onlyDays.length ? onlyDays : monthDays(period), from = days[0], to = days[days.length - 1];
    const [S, hols, recs, leaves] = await Promise.all([settings(), holidaysBetween(from, to), usernames.length ? rows(`SELECT username, day, check_in_at, check_out_at, in_source, out_source, in_acc, out_acc, in_place, out_place, in_note, out_note, in_away, out_away, status_override, override_reason, ot_minutes_override, manual_in, manual_out, breaks, away_minutes,
      (in_photo IS NOT NULL) AS has_in_photo, (out_photo IS NOT NULL) AS has_out_photo FROM attendance_days WHERE username = ANY($1::text[]) AND day BETWEEN $2 AND $3`, [usernames, from, to]) : [],
      leavesBetween(usernames, from, to)]);
    const holidays = Object.fromEntries(hols.map(h => [h.day, h.name]));
    const today = istDay();
    const recByKey = new Map(recs.map(r => [`${r.username}|${r.day}`, r]));
    const out = {};
    for (const u of usernames) {
      const ctx = { settings: S, holidays, today, leaves: leaves.filter(l => l.username === u) };
      out[u] = days.map(d => evalDay(d, recByKey.get(`${u}|${d}`) || null, null, ctx));
    }
    return { days: out, settings: S, holidays };
  }
  function summarise(list, S) {
    const c = { P: 0, H: 0, A: 0, L: 0, LH: 0, U: 0, WO: 0, HO: 0, F: 0 };
    let late = 0, ot = 0;
    for (const d of list) { c[d.status] = (c[d.status] || 0) + 1; if (d.late) late++; ot += d.ot || 0; }
    const lateCut = Number(S.lateMarksPerHalfDay) > 0 ? Math.floor(late / Number(S.lateMarksPerHalfDay)) * 0.5 : 0;
    const paid = c.P + c.WO + c.HO + c.L + c.F + c.H * 0.5 + c.LH * 1 - lateCut;
    // LH: half leave (paid) + the other half worked/absent — a half day leave on an otherwise absent day pays half
    const lhAbsentHalf = list.filter(d => d.status === 'LH' && !d.in).length * 0.5;
    const paidDays = Math.max(0, r2(paid - lhAbsentHalf));
    const overBreak = list.reduce((a, d) => a + (d.overBreak || 0), 0);
    return { counts: c, lateMarks: late, lateCutDays: lateCut, otMinutes: ot, overBreakMin: overBreak, paidDays, lopDays: r2(list.length - paidDays), daysInMonth: list.length };
  }

  // ---------- leave balance
  async function leaveBalance(username, year) {
    const [S, sal, used, pending] = await Promise.all([settings(), one('SELECT paid_leave_per_year FROM salary_structures WHERE username=$1', [username]),
      one("SELECT COALESCE(SUM(days),0)::float AS d FROM leave_requests WHERE username=$1 AND kind='paid' AND status='approved' AND substr(from_day,1,4)=$2", [username, String(year)]),
      one("SELECT COALESCE(SUM(days),0)::float AS d FROM leave_requests WHERE username=$1 AND kind='paid' AND status='pending' AND substr(from_day,1,4)=$2", [username, String(year)])]);
    const quota = sal && sal.paid_leave_per_year != null ? Number(sal.paid_leave_per_year) : Number(S.paidLeavePerYear || 0);
    return { quota, used: r2(used ? used.d : 0), pending: r2(pending ? pending.d : 0), left: r2(quota - (used ? used.d : 0)) };
  }
  // Working days a leave covers (weekly offs and holidays don't count)
  async function leaveDays(from, to, half) {
    if (half) return 0.5;
    const S = await settings();
    const hol = new Set((await holidaysBetween(from, to)).map(h => h.day));
    let n = 0;
    for (let t = Date.parse(`${from}T12:00:00Z`); t <= Date.parse(`${to}T12:00:00Z`); t += 864e5) {
      const d = new Date(t).toISOString().slice(0, 10);
      if (!(S.weeklyOff || []).includes(weekday(d)) && !hol.has(d)) n++;
    }
    return n;
  }

  // ---------- breaks & sessions
  function closeOpenBreak(breaks, at, place) { return (Array.isArray(breaks) ? breaks : []).map(b => b.end ? b : { ...b, end: at, back_place: place || null }); }
  function breakMinutes(breaks, outAt) {
    let m = 0;
    for (const b of Array.isArray(breaks) ? breaks : []) { const end = b.end || outAt || (b.start && new Date().toISOString()); if (b.start && end) m += Math.max(0, (Date.parse(end) - Date.parse(b.start)) / 60000); }
    return Math.round(m);
  }
  // Minutes location tracking saw the person outside every site between check-in and check-out, outside breaks.
  async function awayMinutes(username, fromIso, toIso, breaks, placeList) {
    if (!placeList.length) return 0;
    let pts;
    try { pts = await rows('SELECT recorded_at, lat, lng, accuracy_m FROM location_points WHERE username=$1 AND recorded_at BETWEEN $2 AND $3 ORDER BY recorded_at', [username, fromIso, toIso]); } catch (e) { return 0; }
    if (!pts || pts.length < 2) return 0;
    const inBreak = (t) => (breaks || []).some(b => b.start && Date.parse(b.start) <= t && t <= Date.parse(b.end || toIso));
    let away = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const t = new Date(pts[i].recorded_at).getTime(), t2 = new Date(pts[i + 1].recorded_at).getTime();
      if (inBreak(t)) continue;
      const w = placeFor(Number(pts[i].lat), Number(pts[i].lng), Number(pts[i].accuracy_m || 0), placeList);
      if (w.away) away += Math.min(30, (t2 - t) / 60000); // a gap in tracking counts at most 30 minutes
    }
    return Math.round(away);
  }

  // ======================= ATTENDANCE =======================
  const cleanGeo = (b) => {
    const lat = Number(b.lat), lng = Number(b.lng), acc = Number(b.acc);
    return isFinite(lat) && isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng, acc: isFinite(acc) ? Math.round(acc) : null } : null;
  };
  const cleanPhoto = (p) => {
    const s = String(p || '');
    if (!s) return null;
    if (!/^data:image\/(jpeg|jpg|png|webp);base64,/i.test(s)) return 'bad';
    if (s.length > 700000) return 'big';
    return s;
  };
  const maxSessionMs = (S) => Math.max(4, Number(S.maxSessionHours || 16)) * 3600000;
  // The person's open work session: checked in, not yet checked out — it may have started yesterday (night work) or
  // at another site; it is one session until a check-out. `stale` = it has run past the maximum session length.
  async function openRecord(username, S) {
    const rec = await one('SELECT * FROM attendance_days WHERE username=$1 AND check_in_at IS NOT NULL AND check_out_at IS NULL ORDER BY check_in_at DESC LIMIT 1', [username]);
    if (!rec) return null;
    rec.stale = Date.now() - Date.parse(rec.check_in_at) >= maxSessionMs(S);
    return rec;
  }
  const breaksOf = (rec) => (Array.isArray(rec && rec.breaks) ? rec.breaks : []);
  // Automatic check-out: 'leave' = every time the person leaves all sites (any time of day; coming back is a new
  // check-in), 'fullday' = only once the full day's hours are worked, 'off' = never.
  const outMode = (S) => S.autoOutMode || (S.autoOutAfterFullDay === false ? 'off' : 'leave');
  // Every check-in → check-out pair of a day with timestamps, place, how it happened and its length; the gaps between
  // them (checked out and back, or a break). Corrected days (HR set the in / out time) are one pair.
  function segmentsOf(rec, nowIso) {
    if (!rec || !(rec.manual_in || rec.check_in_at)) return { pairs: [], gaps: [] };
    const nowT = nowIso || new Date().toISOString();
    const mins = (a, b) => Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 60000));
    const srcName = (x) => x === 'auto' ? 'auto' : x === 'hr' ? 'hr' : x === 'break' ? 'break' : x === 'corrected' ? 'corrected' : x ? 'phone' : '';
    if (rec.manual_in || rec.manual_out) {
      const i = rec.manual_in || rec.check_in_at, o = rec.manual_out || rec.check_out_at || null;
      return { pairs: [{ inIso: i, in: istHM(i), inHow: 'corrected', inPlace: rec.in_place || '', outIso: o, out: o ? istHM(o) : '', outHow: o ? 'corrected' : '', outPlace: o ? rec.out_place || '' : '', min: mins(i, o || nowT), open: !o }], gaps: [] };
    }
    const pairs = [], gaps = [];
    let cur = { inIso: rec.check_in_at, inHow: srcName(rec.in_source || 'manual'), inPlace: rec.in_place || '' };
    const brs = breaksOf(rec).filter(b => b.start).slice().sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    for (const b of brs) {
      if (!cur) break;
      if (Date.parse(b.start) < Date.parse(cur.inIso)) continue;
      pairs.push({ ...cur, in: istHM(cur.inIso), outIso: b.start, out: istHM(b.start), outHow: b.gap ? srcName(b.out_src || 'manual') : 'break', outPlace: b.gap ? (b.out_place || '') : '', min: mins(cur.inIso, b.start) });
      gaps.push({ fromIso: b.start, from: istHM(b.start), toIso: b.end || null, to: b.end ? istHM(b.end) : '', min: mins(b.start, b.end || rec.check_out_at || nowT), kind: b.gap ? 'out' : 'break' });
      cur = b.end ? { inIso: b.end, inHow: b.gap ? srcName(b.in_src || 'manual') : 'break', inPlace: b.gap ? (b.in_place || '') : (b.back_place || '') } : null;
    }
    if (cur) {
      const o = rec.check_out_at || null;
      pairs.push({ ...cur, in: istHM(cur.inIso), outIso: o, out: o ? istHM(o) : '', outHow: o ? srcName(rec.out_source || 'manual') : '', outPlace: o ? rec.out_place || '' : '', min: mins(cur.inIso, o || nowT), open: !o });
    }
    return { pairs, gaps };
  }
  // Break time already used by the CLOSED breaks of a record, and what is left of the day's allowance.
  const closedBreakMin = (rec) => Math.round(breaksOf(rec).filter(b => b.end).reduce((m, b) => m + Math.max(0, (Date.parse(b.end) - Date.parse(b.start)) / 60000), 0));
  const breakLeftMin = (rec, S) => Math.max(0, Number(S.breakAllowanceMin || 0) - closedBreakMin(rec));
  // Hours counted as worked if the session ended at `at` (same rule as the day's status).
  function workedMinutesAt(rec, at, S) {
    const end = Date.parse(at);
    const span = Math.max(0, (end - Date.parse(rec.check_in_at)) / 60000);
    let br = 0;
    for (const b of breaksOf(rec)) if (b.start && Date.parse(b.start) < end) br += Math.max(0, (Math.min(b.end ? Date.parse(b.end) : end, end) - Date.parse(b.start)) / 60000);
    return Math.round(span - Math.max(0, br - Number(S.breakAllowanceMin || 0)));
  }
  async function punch(req, res, which) {
    const b = req.body || {};
    const S = await settings();
    const username = req.user.username;
    const geo = cleanGeo(b);
    const note = str(b.note).trim().slice(0, 200) || null;
    const placeList = await places();
    // Check-in / out is allowed at ANY time and from ANY place (a visit to another site, the head office, a shop for
    // material): what is recorded is the time, where the phone was and the note. Being away from a site is flagged,
    // never refused. Only the LIVE PHOTO is required — at check-in only (taken in the app, not from the gallery).
    const where = placeFor(geo && geo.lat, geo && geo.lng, geo && geo.acc, placeList, 15);
    const away = !!(geo && where.away);
    const t = now();
    if (which === 'in') {
      const photo = cleanPhoto(b.photo);
      if (photo === 'bad') return res.status(400).json({ error: 'The photo could not be read — take it again.' });
      if (photo === 'big') return res.status(400).json({ error: 'The photo is too large — take it again.' });
      if (S.selfieRequired && !photo) return res.status(400).json({ error: 'Take a live photo to check in.', needPhoto: true });
      const open = await openRecord(username, S);
      if (open && open.stale) await closeStale(open, S);
      else if (open) return res.status(400).json({ error: `You are already checked in since ${istHM(open.check_in_at)}${open.day !== istDay() ? ' (yesterday)' : ''}. Check out first.` });
      const day = istDay();
      const rec = await one('SELECT * FROM attendance_days WHERE username=$1 AND day=$2', [username, day]);
      if (rec && rec.check_in_at) {
        // Back again after checking out earlier today (e.g. a trip for material): the session continues; the gap is
        // kept as a break so it is not counted as worked time beyond the break allowance.
        const gap = breaksOf(rec).concat([{ start: rec.check_out_at, end: t, gap: true, out_src: rec.out_source || 'manual', out_place: rec.out_place || null, in_src: 'manual', in_place: where.place || null }]);
        const re = await q('UPDATE attendance_days SET check_out_at=NULL, out_source=NULL, out_place=NULL, out_away=NULL, out_note=NULL, breaks=$3, updated_at=$4 WHERE username=$1 AND day=$2 AND check_out_at IS NOT NULL RETURNING day',
          [username, day, JSON.stringify(gap), t]);
        if (!re.rows[0]) return res.status(400).json({ error: 'You are already checked in today.' });
        return res.json({ ok: true, at: istHM(t), place: where.place, away, nearest: where.nearest, noLocation: !geo, late: false, resumed: true });
      }
      const ins = await q(`INSERT INTO attendance_days(username, day, check_in_at, in_lat, in_lng, in_acc, in_place, in_away, in_photo, in_note, in_source, created_at, updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'manual',$3,$3) ON CONFLICT (username, day) DO UPDATE SET check_in_at=EXCLUDED.check_in_at, in_lat=EXCLUDED.in_lat, in_lng=EXCLUDED.in_lng, in_acc=EXCLUDED.in_acc,
        in_place=EXCLUDED.in_place, in_away=EXCLUDED.in_away, in_photo=EXCLUDED.in_photo, in_note=EXCLUDED.in_note, in_source='manual', updated_at=EXCLUDED.updated_at
        WHERE attendance_days.check_in_at IS NULL RETURNING check_in_at`,
      [username, day, t, geo && geo.lat, geo && geo.lng, geo && geo.acc, where.place, away, photo, note]);
      if (!ins.rows[0]) return res.status(400).json({ error: 'You are already checked in today.' });
      const late = minutesOf(istHM(t)) > minutesOf(S.shiftStart) + Number(S.graceMin || 0);
      return res.json({ ok: true, at: istHM(t), place: where.place, away, nearest: where.nearest, noLocation: !geo, late });
    }
    // check-out: closes the open session, whichever day or site it began on. No photo.
    const rec = await openRecord(username, S);
    if (!rec) {
      const done = await one('SELECT check_out_at FROM attendance_days WHERE username=$1 AND day=$2 AND check_out_at IS NOT NULL', [username, istDay()]);
      return res.status(400).json({ error: done ? `You already checked out today at ${istHM(done.check_out_at)}.` : 'Check in first.' });
    }
    if (rec.stale) { await closeStale(rec, S); return res.status(400).json({ error: 'Your work session was closed automatically at the maximum session length. Ask HR if the time needs correcting.' }); }
    // an open break ends at check-out; the time tracking saw away from every site is kept for the day (information only)
    const breaks = closeOpenBreak(rec.breaks, t, where.place);
    const awayMin = await awayMinutes(username, rec.check_in_at, t, breaks, placeList);
    const up = await q("UPDATE attendance_days SET check_out_at=$3, out_lat=$4, out_lng=$5, out_acc=$6, out_place=$7, out_away=$8, out_note=$9, breaks=$10, away_minutes=$11, out_source='manual', updated_at=$3 WHERE username=$1 AND day=$2 AND check_out_at IS NULL RETURNING check_out_at",
      [username, rec.day, t, geo && geo.lat, geo && geo.lng, geo && geo.acc, where.place, away, note, JSON.stringify(breaks), awayMin]);
    if (!up.rows[0]) return res.status(400).json({ error: 'You are already checked out.' });
    res.json({ ok: true, at: istHM(t), place: where.place, away, nearest: where.nearest, noLocation: !geo, late: false });
  }
  // ☕ Breaks: start any time, anywhere; the day has breakAllowanceMin (1 hour) in total. A reminder comes shortly
  // before it runs out; if the person is not back by then the session is checked out at the moment the break time
  // ended — the hours worked up to then still count (full day / half day by hours), nobody is marked absent for it.
  app.post('/api/attendance/break-start', auth(ALL_ROLES), async (req, res) => {
    const S = await settings();
    const rec = await openRecord(req.user.username, S);
    if (!rec || rec.stale) return res.status(400).json({ error: 'Check in first.' });
    const breaks = breaksOf(rec);
    if (breaks.some(b => !b.end)) return res.status(400).json({ error: 'You are already on a break.' });
    const left = breakLeftMin(rec, S);
    if (left <= 0) return res.status(400).json({ error: `Your ${Number(S.breakAllowanceMin || 0)} minutes of break for today are used up.` });
    const t = now();
    breaks.push({ start: t });
    await q('UPDATE attendance_days SET breaks=$3, updated_at=$4 WHERE username=$1 AND day=$2 AND check_out_at IS NULL', [req.user.username, rec.day, JSON.stringify(breaks), t]);
    const deadline = new Date(Date.parse(t) + left * 60000).toISOString();
    res.json({ ok: true, at: istHM(t), usedMin: breakMinutes(breaks, null), allowanceMin: Number(S.breakAllowanceMin || 0), leftMin: left, backBy: istHM(deadline), backByIso: deadline });
  });
  app.post('/api/attendance/break-end', auth(ALL_ROLES), async (req, res) => {
    const S = await settings();
    const rec = await openRecord(req.user.username, S);
    const breaks = breaksOf(rec);
    if (!rec || !breaks.some(b => !b.end)) return res.status(400).json({ error: 'You are not on a break.' });
    const geo = cleanGeo(req.body || {}); const placeList = await places();
    const where = placeFor(geo && geo.lat, geo && geo.lng, geo && geo.acc, placeList, 15);
    const t = now(); const closed = closeOpenBreak(breaks, t, where.place);
    await q('UPDATE attendance_days SET breaks=$3, updated_at=$4 WHERE username=$1 AND day=$2 AND check_out_at IS NULL', [req.user.username, rec.day, JSON.stringify(closed), t]);
    const used = breakMinutes(closed, null), allow = Number(S.breakAllowanceMin || 0);
    res.json({ ok: true, at: istHM(t), usedMin: used, allowanceMin: allow, overMin: Math.max(0, used - allow), leftMin: Math.max(0, allow - used), place: where.place });
  });
  app.post('/api/attendance/check-in', auth(ALL_ROLES), (req, res) => punch(req, res, 'in'));
  app.post('/api/attendance/check-out', auth(ALL_ROLES), (req, res) => punch(req, res, 'out'));

  // Own page: today, the month, leave balance and requests, payslips.
  app.get('/api/attendance/me', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user);
    const period = validPeriod(req.query.month) || istDay().slice(0, 7);
    const today = istDay();
    // Everything at once — one round trip to the database instead of a dozen in a row.
    const [mo, rec, anywhere, placeList, balance, requests, slips] = await Promise.all([
      monthFor([m.username], period),
      one(`SELECT day, check_in_at, check_out_at, in_place, out_place, in_away, out_away, in_source, out_source, in_note, out_note, breaks, in_lat, in_lng, out_lat, out_lng, (in_photo IS NOT NULL) AS has_in_photo FROM attendance_days WHERE username=$1 AND ((check_in_at IS NOT NULL AND check_out_at IS NULL) OR day=$2)
        ORDER BY (check_out_at IS NULL AND check_in_at IS NOT NULL) DESC, day DESC LIMIT 1`, [m.username, today]),
      one('SELECT att_anywhere FROM users WHERE username=$1', [m.username]),
      places(),
      leaveBalance(m.username, period.slice(0, 4)),
      rows('SELECT * FROM leave_requests WHERE username=$1 ORDER BY created_at DESC LIMIT 30', [m.username]),
      rows(`SELECT r.period, r.status, l.net FROM payroll_lines l JOIN payroll_runs r ON r.id=l.run_id WHERE l.username=$1 AND r.status IN ('approved','paid') ORDER BY r.period DESC LIMIT 24`, [m.username]),
    ]);
    const list = mo.days[m.username];
    const S = mo.settings;
    const brs = rec && Array.isArray(rec.breaks) ? rec.breaks : [];
    const ob = brs.find(b => !b.end);
    // Time logs (like a clock-in app): every check-in / check-out of the day with place, photo and map.
    let timeline = null;
    if (rec && rec.check_in_at) {
      const nowIso = new Date().toISOString(), endIso = rec.check_out_at || nowIso;
      const map = (la, ln) => la != null && ln != null ? `https://www.google.com/maps?q=${la},${ln}` : null;
      // Only check-in / check-out are shown — where the phone went in between is not tracked (attendance only).
      const punches = [], missed = 0;
      const spanMin = Math.max(0, Math.round((Date.parse(endIso) - Date.parse(rec.check_in_at)) / 60000));
      const brMin = breakMinutes(brs, rec.check_out_at || null);
      timeline = { punches: punches.slice(-40), missedChecks: missed, grossMin: spanMin, effectiveMin: Math.max(0, spanMin - Math.max(0, brMin - Number(S.breakAllowanceMin || 0))),
        inMap: map(rec.in_lat, rec.in_lng), outMap: map(rec.out_lat, rec.out_lng), hasInPhoto: !!rec.has_in_photo,
        lateMin: Math.max(0, (minutesOf(istHM(rec.check_in_at)) || 0) - ((minutesOf(S.shiftStart) || 0) + Number(S.graceMin || 0))) };
    }
    const left = rec ? breakLeftMin(rec, S) : Number(S.breakAllowanceMin || 0);
    const deadline = ob ? new Date(Date.parse(ob.start) + left * 60000).toISOString() : null;
    const sessionEnd = rec && rec.check_in_at && !rec.check_out_at ? new Date(Date.parse(rec.check_in_at) + maxSessionMs(S)).toISOString() : null;
    res.json({
      me: { username: m.username, name: m.name, canSeeAttendance: m.canSeeAttendance, canSeePayroll: m.canSeePayroll },
      today, period, todayRec: rec ? { day: rec.day, in: istHM(rec.check_in_at), out: istHM(rec.check_out_at), inIso: rec.check_in_at || null, inPlace: rec.in_place, outPlace: rec.out_place, inAway: rec.in_away, outAway: rec.out_away, inAuto: rec.in_source === 'auto', outAuto: rec.out_source === 'auto',
        inNote: rec.in_note || '', outNote: rec.out_note || '', fromEarlierDay: rec.day !== today, sessionEndsIso: sessionEnd, timeline,
        onBreak: !!ob, breakSince: ob ? istHM(ob.start) : '', breakStartIso: ob ? ob.start : null, breakBackByIso: deadline, breakBackBy: deadline ? istHM(deadline) : '', breakLeftMin: left,
        breakUsedMin: breakMinutes(brs, null), breaks: brs.filter(b => !b.gap).map(b => ({ start: istHM(b.start), end: b.end ? istHM(b.end) : '' })) } : null,
      locationRule: { required: !!S.locationRequired && !(anywhere && anywhere.att_anywhere), anywhere: !!(anywhere && anywhere.att_anywhere), places: placeList.map(p => p.name) },
      rules: { shiftStart: S.shiftStart, shiftEnd: S.shiftEnd, graceMin: S.graceMin, fullDayHours: S.fullDayHours, halfDayHours: S.halfDayHours, selfieRequired: !!S.selfieRequired, weeklyOff: S.weeklyOff, lateMarksPerHalfDay: S.lateMarksPerHalfDay, breakAllowanceMin: Number(S.breakAllowanceMin || 0), autoAttendance: !!S.autoAttendance, checkoutAfterShiftMin: Number(S.checkoutAfterShiftMin || 30), gpsMaxAccM: Number(S.gpsMaxAccM || 100), maxSessionHours: Number(S.maxSessionHours || 16), breakRemindMin: Number(S.breakRemindMin || 10), autoOutAfterFullDay: S.autoOutAfterFullDay !== false, autoOutMode: outMode(S) },
      days: list, summary: summarise(list.filter(d => d.day <= today), S), holidays: mo.holidays,
      leave: { balance, requests },
      payslips: slips.filter(p => p.status === 'paid').map(p => ({ period: p.period, net: Number(p.net), label: monthLabel(p.period) })),
    });
  });
  // Small counts for menus and the "waiting for your decision" list
  app.get('/api/attendance/summary', auth(ALL_ROLES), async (req, res) => {
    const [m, rec] = await Promise.all([me(req.user), one('SELECT check_in_at, check_out_at FROM attendance_days WHERE username=$1 AND ((check_in_at IS NOT NULL AND check_out_at IS NULL) OR day=$2) ORDER BY (check_out_at IS NULL AND check_in_at IS NOT NULL) DESC, day DESC LIMIT 1', [req.user.username, istDay()])]);
    const out = { checkedIn: !!(rec && rec.check_in_at), checkedOut: !!(rec && rec.check_out_at), canSeeAttendance: m.canSeeAttendance, canSeePayroll: m.canSeePayroll, canPrepare: m.canPrepare, canApprove: m.canApprove, canPay: m.canPay };
    const [pl, ap, pp] = await Promise.all([
      m.canDecideLeave ? rows("SELECT id, username, from_day, to_day, half_day, kind, days, reason, created_at FROM leave_requests WHERE status='pending' ORDER BY created_at") : null,
      m.canApprove ? rows("SELECT period FROM payroll_runs WHERE status='draft' AND submitted_at IS NOT NULL") : null,
      m.canPay ? rows("SELECT period FROM payroll_runs WHERE status='approved'") : null]);
    if (pl) out.pendingLeave = pl;
    if (ap) out.payrollToApprove = ap.map(r => r.period);
    if (pp) out.payrollToPay = pp.map(r => r.period);
    res.json(out);
  });
  // HR view: everyone today
  // Time log: for each person and day, every check-in → check-out pair with timestamps and length, the gaps between
  // them, the total time checked in and the hours counted for pay. HR / Admin / Accounts see everyone; others themselves.
  app.get('/api/attendance/timelog', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user);
    const today = istDay();
    const to = validDay(req.query.to) || today, from = validDay(req.query.from) || to;
    if (from > to) return res.status(400).json({ error: 'The start date is after the end date.' });
    const days = []; for (let d = from; d <= to && days.length <= 62; d = istDay(new Date(Date.parse(d + 'T12:00:00Z') + 864e5))) days.push(d);
    if (days.length > 62) return res.status(400).json({ error: 'Pick at most 62 days.' });
    const all = await db.listUsers();
    const users = m.canSeeAttendance ? all : all.filter(u => u.username === m.username);
    const recs = await rows(`SELECT * FROM attendance_days WHERE day BETWEEN $1 AND $2 ${m.canSeeAttendance ? '' : 'AND username=$3'} AND (check_in_at IS NOT NULL OR manual_in IS NOT NULL)`,
      m.canSeeAttendance ? [from, to] : [from, to, m.username]);
    const byKey = Object.fromEntries(recs.map(r => [`${r.username}|${r.day}`, r]));
    const who = users.filter(u => recs.some(r => r.username === u.username));
    const mo = who.length ? await monthFor(who.map(u => u.username), from.slice(0, 7), days) : { days: {} };
    const nowIso = new Date().toISOString();
    const list = [];
    for (const u of who) for (const d of days) {
      const rec = byKey[`${u.username}|${d}`]; if (!rec) continue;
      const ev = (mo.days[u.username] || []).find(x => x.day === d) || {};
      const { pairs, gaps } = segmentsOf(rec, nowIso);
      const inMin = pairs.reduce((a, p) => a + p.min, 0);
      list.push({ username: u.username, name: u.name, team: u.team || '', day: d, status: ev.status || '', pairs, gaps,
        firstIn: pairs.length ? pairs[0].in : '', lastOut: pairs.length && !pairs[pairs.length - 1].open ? pairs[pairs.length - 1].out : '',
        checkedInMin: inMin, outMin: gaps.filter(g => g.kind === 'out').reduce((a, g) => a + g.min, 0), breakMin: gaps.filter(g => g.kind === 'break').reduce((a, g) => a + g.min, 0),
        spanMin: pairs.length ? Math.max(0, Math.round((Date.parse(pairs[pairs.length - 1].outIso || nowIso) - Date.parse(pairs[0].inIso)) / 60000)) : 0,
        workedMin: ev.worked != null ? ev.worked : null, open: pairs.some(p => p.open) });
    }
    list.sort((a, b) => a.day === b.day ? a.name.localeCompare(b.name) : b.day.localeCompare(a.day));
    const per = {};
    for (const r of list) { const p = per[r.username] || (per[r.username] = { username: r.username, name: r.name, team: r.team, days: 0, pairs: 0, checkedInMin: 0, workedMin: 0 }); p.days++; p.pairs += r.pairs.length; p.checkedInMin += r.checkedInMin; p.workedMin += r.workedMin || 0; }
    res.json({ from, to, all: m.canSeeAttendance, list, people: Object.values(per).sort((a, b) => a.name.localeCompare(b.name)) });
  });
  app.get('/api/attendance/today', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user);
    if (!m.canSeeAttendance) return res.status(403).json({ error: 'Only Admin, HR and Accounts see everyone\'s attendance.' });
    const day = validDay(req.query.day) || istDay();
    const users = await db.listUsers();
    const mo = await monthFor(users.map(u => u.username), day.slice(0, 7), [day]);
    const S = mo.settings;
    const list = users.map(u => {
      const d = mo.days[u.username].find(x => x.day === day);
      return { username: u.username, name: u.name, team: u.team || '', ...d };
    }).sort((a, b) => (a.in ? 0 : 1) - (b.in ? 0 : 1) || String(a.in).localeCompare(String(b.in)) || a.name.localeCompare(b.name));
    const count = (f) => list.filter(f).length;
    const attempts = await attemptsFor(day).catch(() => []);
    res.json({ day, list, attempts, canAccept: m.canEditAttendance, shiftStart: S.shiftStart, totals: { in: count(x => x.in), notIn: count(x => !x.in && !['WO', 'HO', 'L', 'U'].includes(x.status)), late: count(x => x.late), away: count(x => x.flags.includes('not at a site')), onLeave: count(x => ['L', 'U', 'LH'].includes(x.status)) } });
  });
  // HR view: the month register
  app.get('/api/attendance/register', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user);
    if (!m.canSeeAttendance) return res.status(403).json({ error: 'Only Admin, HR and Accounts see the register.' });
    const period = validPeriod(req.query.month) || istDay().slice(0, 7);
    const users = await db.listUsers();
    const mo = await monthFor(users.map(u => u.username), period);
    const today = istDay();
    res.json({ period, label: monthLabel(period), days: monthDays(period), holidays: mo.holidays, weeklyOff: mo.settings.weeklyOff, canEdit: m.canEditAttendance,
      people: users.map(u => ({ username: u.username, name: u.name, team: u.team || '', days: mo.days[u.username], summary: summarise(mo.days[u.username].filter(d => d.day <= today), mo.settings) })) });
  });
  app.get('/api/attendance/photo/:username/:day/:which', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user);
    if (req.params.username !== m.username && !m.canSeeAttendance) return res.status(403).json({ error: 'Not allowed.' });
    const r = await one(`SELECT ${req.params.which === 'out' ? 'out_photo' : 'in_photo'} AS p FROM attendance_days WHERE username=$1 AND day=$2`, [req.params.username, req.params.day]);
    if (!r || !r.p) return res.status(404).json({ error: 'No photo.' });
    res.json({ data: r.p });
  });
  // HR: refused check-ins / outs of a day — why, where (Google Maps link), the live photo; accept or dismiss.
  app.get('/api/attendance/attempts', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user);
    if (!m.canSeeAttendance) return res.status(403).json({ error: 'Only HR and Admin see this.' });
    const day = validDay(req.query.day) || istDay();
    res.json({ day, canAccept: m.canEditAttendance, list: await attemptsFor(day) });
  });
  async function attemptsFor(day) {
    const list = await rows(`SELECT a.id, a.username, u.name, u.team, a.day, a.action, a.at, a.reason, a.lat, a.lng, a.acc, a.nearest, a.nearest_m,
      (a.photo IS NOT NULL) AS has_photo, a.status, a.decided_by, a.decided_at, a.client
      FROM attendance_attempts a LEFT JOIN users u ON u.username = a.username WHERE a.day = $1 ORDER BY a.at DESC LIMIT 500`, [day]).catch(() => []);
    const recs = await rows('SELECT username, check_in_at, check_out_at FROM attendance_days WHERE day=$1', [day]);
    const byUser = Object.fromEntries(recs.map(r => [r.username, r]));
    return list.map(a => {
      const r = byUser[a.username] || {};
      const done = a.action === 'in' ? !!r.check_in_at : !!r.check_out_at;
      return { ...a, at_hm: istHM(a.at), done, map: a.lat != null ? `https://www.google.com/maps?q=${a.lat},${a.lng}` : null };
    });
  }
  app.get('/api/attendance/attempts/:id/photo', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user);
    if (!m.canSeeAttendance) return res.status(403).json({ error: 'Not allowed.' });
    const r = await one('SELECT photo FROM attendance_attempts WHERE id=$1', [Number(req.params.id) || 0]);
    if (!r || !r.photo) return res.status(404).json({ error: 'No photo (photos are deleted the next day).' });
    res.json({ data: r.photo });
  });
  app.post('/api/attendance/attempts/:id/:decision', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user);
    if (!m.canEditAttendance) return res.status(403).json({ error: 'Only HR and Admin can accept a check-in.' });
    const decision = req.params.decision;
    if (!['accept', 'deny', 'dismiss'].includes(decision)) return res.status(404).json({ error: 'Unknown action.' });
    const a = await one('SELECT * FROM attendance_attempts WHERE id=$1', [Number(req.params.id) || 0]);
    if (!a) return res.status(404).json({ error: 'That attempt is gone.' });
    if (a.username === m.username && !m.admin) return res.status(403).json({ error: 'Someone else in HR must accept your own check-in.' });
    const t = now();
    if (decision !== 'accept') {
      await q("UPDATE attendance_attempts SET status='denied', decided_by=$4, decided_at=$5 WHERE username=$1 AND day=$2 AND action=$3 AND status='open'", [a.username, a.day, a.action, m.username, t]);
      await auditFromReq(req, 'attendance_attempt_denied', `${m.name} denied the ${a.action === 'in' ? 'check-in' : 'check-out'} of ${a.username} on ${a.day} at ${istHM(a.at)}`);
      await notify([a.username], m.username, 'attendance', `${m.name} did not accept your ${a.action === 'in' ? 'check-in' : 'check-out'} of ${istHM(a.at)}.`).catch(() => {});
      return res.json({ ok: true });
    }
    const near = a.nearest || null;
    if (a.action === 'in') {
      const ins = await one(`INSERT INTO attendance_days(username, day, check_in_at, in_lat, in_lng, in_acc, in_place, in_away, in_photo, in_source, created_at, updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,false,$8,'hr',$9,$9) ON CONFLICT (username, day) DO UPDATE SET check_in_at=EXCLUDED.check_in_at, in_lat=EXCLUDED.in_lat, in_lng=EXCLUDED.in_lng,
        in_acc=EXCLUDED.in_acc, in_place=EXCLUDED.in_place, in_away=false, in_photo=EXCLUDED.in_photo, in_source='hr', updated_at=EXCLUDED.updated_at
        WHERE attendance_days.check_in_at IS NULL RETURNING check_in_at`, [a.username, a.day, a.at, a.lat, a.lng, a.acc, near, a.photo, t]);
      if (!ins) return res.status(400).json({ error: 'Already checked in that day.' });
    } else {
      const rec = await one('SELECT * FROM attendance_days WHERE username=$1 AND day=$2', [a.username, a.day]);
      if (!rec || !rec.check_in_at) return res.status(400).json({ error: 'There is no check-in that day — accept the check-in first.' });
      if (rec.check_out_at) return res.status(400).json({ error: 'Already checked out that day.' });
      if (a.at <= rec.check_in_at) return res.status(400).json({ error: 'This check-out is before the check-in.' });
      const breaks = closeOpenBreak(rec.breaks, a.at, near);
      await q("UPDATE attendance_days SET check_out_at=$3, out_lat=$4, out_lng=$5, out_acc=$6, out_place=$7, out_away=false, out_photo=$8, breaks=$9, out_source='hr', updated_at=$10 WHERE username=$1 AND day=$2 AND check_out_at IS NULL",
        [a.username, a.day, a.at, a.lat, a.lng, a.acc, near, a.photo, JSON.stringify(breaks), t]);
    }
    await q("UPDATE attendance_attempts SET status='accepted', decided_by=$4, decided_at=$5 WHERE username=$1 AND day=$2 AND action=$3 AND status='open'", [a.username, a.day, a.action, m.username, t]);
    await auditFromReq(req, 'attendance_attempt_accepted', `${m.name} accepted the ${a.action === 'in' ? 'check-in' : 'check-out'} of ${a.username} on ${a.day} at ${istHM(a.at)} (refused: ${String(a.reason).slice(0, 100)})`);
    await notify([a.username], m.username, 'attendance', `${m.name} accepted your ${a.action === 'in' ? 'check-in' : 'check-out'} of ${istHM(a.at)}.`).catch(() => {});
    res.json({ ok: true });
  });
  // HR / Admin correct a day
  app.post('/api/attendance/correct', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user);
    if (!m.canEditAttendance) return res.status(403).json({ error: 'Only HR and Admin can correct attendance.' });
    const b = req.body || {};
    const username = str(b.username).trim(), day = validDay(b.day);
    if (!day || !(await db.getUser(username))) return res.status(400).json({ error: 'Pick the person and the day.' });
    const reason = str(b.reason).trim();
    if (reason.length < 3) return res.status(400).json({ error: 'Write why it is corrected.' });
    const status = str(b.status).trim();
    if (status && !STATUS_LABEL[status]) return res.status(400).json({ error: 'Unknown status.' });
    const toIso = (hm) => { const mm = minutesOf(hm); return mm == null ? null : new Date(dayStartUtc(day).getTime() + mm * 60000).toISOString(); };
    const inIso = b.in ? toIso(b.in) : null, outIso = b.out ? toIso(b.out) : null;
    if (inIso && outIso && outIso <= inIso) return res.status(400).json({ error: 'Out must be after in.' });
    const ot = b.otMinutes === '' || b.otMinutes == null ? null : Math.max(0, Math.round(Number(b.otMinutes) || 0));
    await q(`INSERT INTO attendance_days(username, day, status_override, override_reason, override_by, override_at, ot_minutes_override, manual_in, manual_out, created_at, updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$6,$6) ON CONFLICT (username, day) DO UPDATE SET status_override=EXCLUDED.status_override, override_reason=EXCLUDED.override_reason,
      override_by=EXCLUDED.override_by, override_at=EXCLUDED.override_at, ot_minutes_override=EXCLUDED.ot_minutes_override, manual_in=EXCLUDED.manual_in, manual_out=EXCLUDED.manual_out, updated_at=EXCLUDED.updated_at`,
    [username, day, status || null, reason.slice(0, 300), m.username, now(), ot, inIso, outIso]);
    await auditFromReq(req, 'attendance_corrected', `Attendance of ${username} on ${day} corrected${status ? ` to ${STATUS_LABEL[status]}` : ''}${b.in ? ` in ${b.in}` : ''}${b.out ? ` out ${b.out}` : ''}: ${reason.slice(0, 120)}`);
    res.json({ ok: true });
  });

  // HR / Admin: who may check in anywhere (drivers, purchase…)
  app.post('/api/attendance/anywhere/:username', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user);
    if (!m.canPrepare) return res.status(403).json({ error: 'Only HR and Admin change this.' });
    const u = await db.getUser(req.params.username); if (!u) return res.status(404).json({ error: 'User not found.' });
    const on = !!(req.body || {}).anywhere;
    await q('UPDATE users SET att_anywhere=$2 WHERE username=$1', [u.username, on]);
    await auditFromReq(req, 'attendance_anywhere', `${u.name} ${on ? 'can now check in from anywhere' : 'must check in inside a site again'}.`);
    res.json({ ok: true });
  });

  // ======================= LEAVE =======================
  app.post('/api/leave', auth(ALL_ROLES), async (req, res) => {
    const b = req.body || {};
    const from = validDay(b.from), to = validDay(b.to || b.from);
    if (!from || !to || to < from) return res.status(400).json({ error: 'Pick the leave dates.' });
    const half = !!b.halfDay && from === to;
    const kind = b.kind === 'unpaid' ? 'unpaid' : 'paid';
    const reason = str(b.reason).trim();
    if (reason.length < 3) return res.status(400).json({ error: 'Write the reason for the leave.' });
    if (Date.parse(to) - Date.parse(from) > 60 * 864e5) return res.status(400).json({ error: 'At most 60 days in one request.' });
    const clash = await one("SELECT id FROM leave_requests WHERE username=$1 AND status IN ('pending','approved') AND to_day >= $2 AND from_day <= $3", [req.user.username, from, to]);
    if (clash) return res.status(400).json({ error: 'You already asked for leave on some of these days.' });
    const days = await leaveDays(from, to, half);
    if (!days) return res.status(400).json({ error: 'Those days are weekly offs / holidays — no leave needed.' });
    if (kind === 'paid') {
      const bal = await leaveBalance(req.user.username, from.slice(0, 4));
      if (days > bal.left - bal.pending) return res.status(400).json({ error: `Only ${r2(bal.left - bal.pending)} paid leave day(s) left this year — ask for unpaid leave for the rest.` });
    }
    const r = await one(`INSERT INTO leave_requests(username, from_day, to_day, half_day, kind, days, reason, status, created_at) VALUES($1,$2,$3,$4,$5,$6,$7,'pending',$8) RETURNING id`,
      [req.user.username, from, to, half, kind, days, reason.slice(0, 500), now()]);
    await notify(await deciders(), req.user.username, 'leave_requested', `${req.user.name} asked for ${kind} leave: ${from}${to !== from ? ` to ${to}` : ''}${half ? ' (half day)' : ''} — ${days} day${days === 1 ? '' : 's'}. "${reason.slice(0, 100)}"`, { ref_type: 'leave', ref_id: r.id });
    res.json({ ok: true, id: r.id, days });
  });
  app.post('/api/leave/:id/cancel', auth(ALL_ROLES), async (req, res) => {
    const l = await one('SELECT * FROM leave_requests WHERE id=$1', [Number(req.params.id) || 0]);
    if (!l || l.username !== req.user.username) return res.status(404).json({ error: 'Not found.' });
    if (l.status !== 'pending' && !(l.status === 'approved' && l.from_day > istDay())) return res.status(400).json({ error: 'Only a pending leave, or an approved one that has not started, can be withdrawn.' });
    await q("UPDATE leave_requests SET status='cancelled', decided_at=$2 WHERE id=$1", [l.id, now()]);
    res.json({ ok: true });
  });
  app.post('/api/leave/:id/decide', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user);
    if (!m.canDecideLeave) return res.status(403).json({ error: 'Only HR and Admin decide leave.' });
    const l = await one('SELECT * FROM leave_requests WHERE id=$1', [Number(req.params.id) || 0]);
    if (!l) return res.status(404).json({ error: 'Not found.' });
    if (l.status !== 'pending') return res.status(409).json({ error: 'This request was already answered.' });
    if (l.username === m.username && !m.admin) return res.status(403).json({ error: 'Your own leave is decided by Admin.' });
    const decision = req.body && req.body.decision === 'approve' ? 'approved' : req.body && req.body.decision === 'reject' ? 'rejected' : null;
    if (!decision) return res.status(400).json({ error: 'Approve or reject.' });
    const note = str((req.body || {}).note).trim();
    if (decision === 'rejected' && note.length < 3) return res.status(400).json({ error: 'Write why it is rejected.' });
    await q('UPDATE leave_requests SET status=$2, decided_by=$3, decided_by_name=$4, decided_at=$5, decision_note=$6 WHERE id=$1', [l.id, decision, m.username, m.name, now(), note.slice(0, 300) || null]);
    await notify([l.username], m.username, 'leave_decided', `${m.name} ${decision} your ${l.kind} leave (${l.from_day}${l.to_day !== l.from_day ? ` to ${l.to_day}` : ''})${note ? `: ${note.slice(0, 120)}` : '.'}`);
    res.json({ ok: true });
  });
  app.get('/api/leave', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user);
    if (!m.canDecideLeave && !m.canSeeAttendance) return res.status(403).json({ error: 'Not allowed.' });
    const list = await rows("SELECT * FROM leave_requests WHERE status='pending' OR created_at > $1 ORDER BY (status='pending') DESC, created_at DESC LIMIT 200", [new Date(Date.now() - 45 * 864e5).toISOString()]);
    res.json({ canDecide: m.canDecideLeave, list });
  });

  // ======================= SETTINGS & HOLIDAYS =======================
  app.get('/api/payroll/settings', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user);
    if (!m.canSeeAttendance) return res.status(403).json({ error: 'Not allowed.' });
    const y = String(req.query.year || istDay().slice(0, 4));
    const anywhere = (await rows('SELECT username, name, team FROM users WHERE att_anywhere = true ORDER BY name'));
    res.json({ settings: await settings(), defaults: DEFAULTS, holidays: await holidaysBetween(`${y}-01-01`, `${y}-12-31`), canEdit: m.canPrepare, year: y, anywhere, placesCount: (await places()).length });
  });
  app.post('/api/payroll/settings', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user);
    if (!m.canPrepare) return res.status(403).json({ error: 'Only HR and Admin change the rules.' });
    const b = req.body || {}; const cur = await settings(); const next = { ...cur };
    const hm = (v) => /^\d{2}:\d{2}$/.test(String(v || '')) ? String(v) : null;
    const num = (v, lo, hi) => { const n = Number(v); return isFinite(n) && n >= lo && n <= hi ? n : null; };
    for (const [k, f] of Object.entries({ shiftStart: hm, shiftEnd: hm })) if (b[k] != null) { const v = f(b[k]); if (!v) return res.status(400).json({ error: `${k}: use HH:MM.` }); next[k] = v; }
    const ranges = { breakAllowanceMin: [0, 240], graceMin: [0, 180], fullDayHours: [1, 16], halfDayHours: [0.5, 12], maxSessionHours: [4, 24], breakRemindMin: [1, 30], lateMarksPerHalfDay: [0, 31], otAfterMin: [0, 600], otMultiplier: [0, 5], paidLeavePerYear: [0, 60],
      pfPercent: [0, 30], pfWageCeiling: [0, 1000000], employerPfPercent: [0, 30], esiEmployeePercent: [0, 10], esiEmployerPercent: [0, 20], esiGrossLimit: [0, 1000000] };
    for (const [k, [lo, hi]] of Object.entries(ranges)) if (b[k] != null && b[k] !== '') { const v = num(b[k], lo, hi); if (v == null) return res.status(400).json({ error: `${k} must be between ${lo} and ${hi}.` }); next[k] = v; }
    if (b.weeklyOff != null) next.weeklyOff = (Array.isArray(b.weeklyOff) ? b.weeklyOff : []).map(Number).filter(n => n >= 0 && n <= 6);
    if (b.autoAttendance != null) next.autoAttendance = !!b.autoAttendance;
    if (b.selfieRequired != null) next.selfieRequired = !!b.selfieRequired;
    if (b.autoOutAfterFullDay != null) next.autoOutAfterFullDay = !!b.autoOutAfterFullDay;
    if (b.autoOutMode != null) { if (!['leave', 'fullday', 'off'].includes(b.autoOutMode)) return res.status(400).json({ error: 'Unknown automatic check-out rule.' }); next.autoOutMode = b.autoOutMode; }
    if (b.checkoutAfterShiftMin != null) next.checkoutAfterShiftMin = Math.max(0, Math.min(240, Math.round(Number(b.checkoutAfterShiftMin) || 0)));
    if (b.siteTransferMin != null) next.siteTransferMin = Math.max(0, Math.min(120, Math.round(Number(b.siteTransferMin) || 0)));
    if (b.gpsMaxAccM != null) next.gpsMaxAccM = Math.max(20, Math.min(200, Math.round(Number(b.gpsMaxAccM) || 100)));
    if (b.locationRequired != null) next.locationRequired = !!b.locationRequired;
    if (b.pfOnFullBasic != null) next.pfOnFullBasic = !!b.pfOnFullBasic;
    if (next.halfDayHours > next.fullDayHours) return res.status(400).json({ error: 'Half-day hours cannot be more than full-day hours.' });
    await q('INSERT INTO payroll_settings(id, data, updated_by, updated_at) VALUES(1,$1,$2,$3) ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data, updated_by=EXCLUDED.updated_by, updated_at=EXCLUDED.updated_at', [next, m.username, now()]);
    settingsCache = null;
    await auditFromReq(req, 'payroll_settings', 'Changed the attendance / payroll rules.');
    res.json({ ok: true, settings: next });
  });
  app.post('/api/payroll/holidays', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user);
    if (!m.canPrepare) return res.status(403).json({ error: 'Only HR and Admin keep the holiday list.' });
    const day = validDay((req.body || {}).day), name = str((req.body || {}).name).trim();
    if (!day || !name) return res.status(400).json({ error: 'Pick the date and write the holiday.' });
    await q('INSERT INTO payroll_holidays(day, name) VALUES($1,$2) ON CONFLICT (day) DO UPDATE SET name=EXCLUDED.name', [day, name.slice(0, 100)]);
    res.json({ ok: true });
  });
  app.delete('/api/payroll/holidays/:day', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user);
    if (!m.canPrepare) return res.status(403).json({ error: 'Only HR and Admin keep the holiday list.' });
    await q('DELETE FROM payroll_holidays WHERE day=$1', [req.params.day]);
    res.json({ ok: true });
  });

  // ======================= SALARIES & ADVANCES =======================
  const salaryCols = ['basic', 'hra', 'conveyance', 'special', 'pf_applicable', 'esi_mode', 'pt_slab', 'ot_rate', 'paid_leave_per_year', 'bank_name', 'account_no', 'ifsc', 'pan', 'uan', 'esi_no', 'employee_code', 'joined_on', 'active'];
  app.get('/api/payroll/salaries', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user);
    if (!m.canSeePayroll) return res.status(403).json({ error: 'Not allowed.' });
    const users = await db.listUsers();
    const sal = await rows('SELECT * FROM salary_structures');
    res.json({ canEdit: m.canPrepare, people: users.map(u => {
      const s = sal.find(x => x.username === u.username) || null;
      return { username: u.username, name: u.name, team: u.team || '', salary: s ? { ...s, gross: r2(Number(s.basic) + Number(s.hra) + Number(s.conveyance) + Number(s.special)) } : null };
    }) });
  });
  app.post('/api/payroll/salaries/:username', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user);
    if (!m.canPrepare) return res.status(403).json({ error: 'Only HR and Admin keep salaries.' });
    const u = await db.getUser(req.params.username); if (!u) return res.status(404).json({ error: 'User not found.' });
    const b = req.body || {};
    const money = (v) => { const n = Number(v || 0); return isFinite(n) && n >= 0 && n < 10000000 ? r2(n) : null; };
    const v = {
      basic: money(b.basic), hra: money(b.hra), conveyance: money(b.conveyance), special: money(b.special),
      pf_applicable: b.pf_applicable !== false && b.pf_applicable !== 'false', esi_mode: ['auto', 'yes', 'no'].includes(b.esi_mode) ? b.esi_mode : 'auto',
      pt_slab: ['standard', 'women', 'exempt'].includes(b.pt_slab) ? b.pt_slab : 'standard',
      ot_rate: b.ot_rate === '' || b.ot_rate == null ? null : money(b.ot_rate), paid_leave_per_year: b.paid_leave_per_year === '' || b.paid_leave_per_year == null ? null : Math.min(60, Math.max(0, Number(b.paid_leave_per_year) || 0)),
      bank_name: str(b.bank_name).trim().slice(0, 80) || null, account_no: str(b.account_no).replace(/\s+/g, '').slice(0, 30) || null, ifsc: str(b.ifsc).trim().toUpperCase().slice(0, 15) || null,
      pan: str(b.pan).trim().toUpperCase().slice(0, 12) || null, uan: str(b.uan).trim().slice(0, 20) || null, esi_no: str(b.esi_no).trim().slice(0, 20) || null,
      employee_code: str(b.employee_code).trim().slice(0, 20) || null, joined_on: validDay(b.joined_on), active: b.active !== false && b.active !== 'false',
    };
    if ([v.basic, v.hra, v.conveyance, v.special].some(x => x == null)) return res.status(400).json({ error: 'Salary amounts must be numbers.' });
    if (v.basic <= 0) return res.status(400).json({ error: 'Basic salary is required.' });
    if (v.ifsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(v.ifsc)) return res.status(400).json({ error: 'IFSC looks wrong (e.g. HDFC0001234).' });
    await q(`INSERT INTO salary_structures(username, ${salaryCols.join(', ')}, updated_by, updated_at) VALUES($1, ${salaryCols.map((_, i) => `$${i + 2}`).join(', ')}, $${salaryCols.length + 2}, $${salaryCols.length + 3})
      ON CONFLICT (username) DO UPDATE SET ${salaryCols.map(c => `${c}=EXCLUDED.${c}`).join(', ')}, updated_by=EXCLUDED.updated_by, updated_at=EXCLUDED.updated_at`,
    [u.username, ...salaryCols.map(c => v[c]), m.username, now()]);
    await auditFromReq(req, 'salary_changed', `Salary of ${u.username} saved (gross ₹${r2(v.basic + v.hra + v.conveyance + v.special)}).`);
    res.json({ ok: true });
  });
  app.get('/api/payroll/advances', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user);
    if (!m.canSeePayroll) return res.status(403).json({ error: 'Not allowed.' });
    res.json({ canEdit: m.canPrepare, list: (await rows('SELECT * FROM salary_advances ORDER BY (status=\'open\') DESC, given_on DESC LIMIT 300')).map(a => ({ ...a, amount: Number(a.amount), instalment: Number(a.instalment), recovered: Number(a.recovered) })) });
  });
  app.post('/api/payroll/advances', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user);
    if (!m.canPrepare) return res.status(403).json({ error: 'Only HR and Admin record advances.' });
    const b = req.body || {};
    const u = await db.getUser(str(b.username)); if (!u) return res.status(400).json({ error: 'Pick the person.' });
    const amount = r2(b.amount), inst = r2(b.instalment || b.amount);
    if (!(amount > 0)) return res.status(400).json({ error: 'Enter the amount.' });
    if (!(inst > 0) || inst > amount) return res.status(400).json({ error: 'The monthly instalment must be more than 0 and not more than the amount.' });
    const given = validDay(b.given_on) || istDay();
    await q("INSERT INTO salary_advances(username, amount, instalment, recovered, given_on, reason, status, created_by, created_at) VALUES($1,$2,$3,0,$4,$5,'open',$6,$7)", [u.username, amount, inst, given, str(b.reason).trim().slice(0, 300) || null, m.username, now()]);
    await auditFromReq(req, 'advance_given', `Advance ₹${amount} to ${u.username} (₹${inst} a month).`);
    res.json({ ok: true });
  });
  app.post('/api/payroll/advances/:id/close', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user);
    if (!m.canPrepare) return res.status(403).json({ error: 'Only HR and Admin change advances.' });
    await q("UPDATE salary_advances SET status='closed' WHERE id=$1", [Number(req.params.id) || 0]);
    res.json({ ok: true });
  });

  // ======================= PAYROLL =======================
  function computeLine(u, s, list, S, period, manual, advances) {
    const sum = summarise(list, S);
    const D = sum.daysInMonth, f = D ? sum.paidDays / D : 0;
    const comp = { basic: Number(s.basic), hra: Number(s.hra), conveyance: Number(s.conveyance), special: Number(s.special) };
    const monthlyGross = comp.basic + comp.hra + comp.conveyance + comp.special;
    const earned = Object.fromEntries(Object.entries(comp).map(([k, v]) => [k, r2(v * f)]));
    const earnedGross = r2(earned.basic + earned.hra + earned.conveyance + earned.special);
    const otHours = manual && manual.ot_hours != null && manual.ot_hours !== '' ? r2(manual.ot_hours) : r2(sum.otMinutes / 60);
    const otRate = s.ot_rate != null ? Number(s.ot_rate) : r2(monthlyGross / 30 / Number(S.fullDayHours || 8) * Number(S.otMultiplier || 1));
    const otPay = r2(otHours * otRate);
    const otherEarn = r2(manual && manual.other_earn), otherDed = r2(manual && manual.other_ded);
    const pfWage = S.pfOnFullBasic ? earned.basic : Math.min(earned.basic, Number(S.pfWageCeiling || 15000));
    const pf = s.pf_applicable ? Math.round(pfWage * Number(S.pfPercent || 0) / 100) : 0;
    const employerPf = s.pf_applicable ? Math.round(pfWage * Number(S.employerPfPercent || 0) / 100) : 0;
    const esiOn = s.esi_mode === 'yes' || (s.esi_mode !== 'no' && monthlyGross <= Number(S.esiGrossLimit || 21000));
    const esiBase = earnedGross + otPay;
    const esi = esiOn ? Math.ceil(esiBase * Number(S.esiEmployeePercent || 0) / 100) : 0;
    const employerEsi = esiOn ? Math.ceil(esiBase * Number(S.esiEmployerPercent || 0) / 100) : 0;
    const pt = ptFor(earnedGross, s.pt_slab || 'standard', period);
    let advance = 0; const advParts = [];
    for (const a of advances) { const left = r2(a.amount - a.recovered); if (left <= 0) continue; const take = r2(Math.min(left, a.instalment)); advance = r2(advance + take); advParts.push({ id: a.id, amount: take }); }
    const totalEarn = r2(earnedGross + otPay + otherEarn);
    const advanceCut = r2(Math.min(advance, Math.max(0, totalEarn - pf - esi - pt - otherDed)));
    if (advanceCut < advance) { let rest = advanceCut; for (const p of advParts) { p.amount = r2(Math.min(p.amount, rest)); rest = r2(rest - p.amount); } }
    const totalDed = r2(pf + esi + pt + advanceCut + otherDed);
    return {
      name: u.name, team: u.team || '', employee_code: s.employee_code || '', daysInMonth: D, paidDays: sum.paidDays, lopDays: sum.lopDays, counts: sum.counts, lateMarks: sum.lateMarks, lateCutDays: sum.lateCutDays, overBreakMin: sum.overBreakMin,
      monthly: { ...comp, gross: r2(monthlyGross) }, earned: { ...earned, gross: earnedGross }, otHours, otRate: r2(otRate), otPay, otherEarn, otherEarnNote: (manual && manual.other_earn_note) || '',
      pf, esi, pt, advance: advanceCut, advParts, otherDed, otherDedNote: (manual && manual.other_ded_note) || '', employerPf, employerEsi,
      totalEarn, totalDed, net: r2(totalEarn - totalDed), bank: { bank_name: s.bank_name || '', account_no: s.account_no || '', ifsc: s.ifsc || '' }, pan: s.pan || '', uan: s.uan || '', esi_no: s.esi_no || '',
    };
  }
  async function prepare(period, m) {
    const sal = await rows('SELECT * FROM salary_structures WHERE active = true');
    const users = (await db.listUsers()).filter(u => sal.some(s => s.username === u.username));
    const mo = await monthFor(users.map(u => u.username), period);
    let run = await one('SELECT * FROM payroll_runs WHERE period=$1', [period]);
    if (run && run.status !== 'draft') throw Object.assign(new Error(`${monthLabel(period)} is already ${run.status} — Admin can reopen it first.`), { status: 409 });
    if (!run) run = await one("INSERT INTO payroll_runs(period, status, prepared_by, prepared_at) VALUES($1,'draft',$2,$3) RETURNING *", [period, m.username, now()]);
    else await q('UPDATE payroll_runs SET prepared_by=$2, prepared_at=$3, submitted_at=NULL WHERE id=$1', [run.id, m.username, now()]);
    const old = await rows('SELECT username, manual FROM payroll_lines WHERE run_id=$1', [run.id]);
    await q('DELETE FROM payroll_lines WHERE run_id=$1', [run.id]);
    const advances = (await rows("SELECT * FROM salary_advances WHERE status='open'")).map(a => ({ ...a, amount: Number(a.amount), instalment: Number(a.instalment), recovered: Number(a.recovered) }));
    for (const u of users) {
      const s = sal.find(x => x.username === u.username);
      const manual = (old.find(o => o.username === u.username) || {}).manual || {};
      const line = computeLine(u, s, mo.days[u.username], mo.settings, period, manual, advances.filter(a => a.username === u.username && a.given_on <= `${period}-31`));
      await q('INSERT INTO payroll_lines(run_id, username, data, manual, net) VALUES($1,$2,$3,$4,$5)', [run.id, u.username, line, manual, line.net]);
    }
    return run;
  }
  async function runView(period, m) {
    const run = await one('SELECT * FROM payroll_runs WHERE period=$1', [period]);
    if (!run) return { period, label: monthLabel(period), run: null, lines: [] };
    const lines = (await rows('SELECT username, data, manual, net FROM payroll_lines WHERE run_id=$1 ORDER BY username', [run.id])).map(l => ({ username: l.username, ...l.data, manual: l.manual || {} }));
    const tot = (k) => r2(lines.reduce((a, l) => a + (Number(k(l)) || 0), 0));
    return { period, label: monthLabel(period), run, lines, totals: { people: lines.length, gross: tot(l => l.totalEarn), pf: tot(l => l.pf), esi: tot(l => l.esi), pt: tot(l => l.pt), advance: tot(l => l.advance), ded: tot(l => l.totalDed), net: tot(l => l.net), employerPf: tot(l => l.employerPf), employerEsi: tot(l => l.employerEsi) } };
  }
  app.get('/api/payroll/runs', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user);
    if (!m.canSeePayroll) return res.status(403).json({ error: 'Not allowed.' });
    const runs = await rows(`SELECT r.*, (SELECT COUNT(*)::int FROM payroll_lines l WHERE l.run_id=r.id) AS people, (SELECT COALESCE(SUM(net),0)::float FROM payroll_lines l WHERE l.run_id=r.id) AS net FROM payroll_runs r ORDER BY period DESC LIMIT 36`);
    res.json({ me: { canPrepare: m.canPrepare, canApprove: m.canApprove, canPay: m.canPay }, runs: runs.map(r => ({ ...r, label: monthLabel(r.period) })) });
  });
  app.get('/api/payroll/runs/:period', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user);
    if (!m.canSeePayroll) return res.status(403).json({ error: 'Not allowed.' });
    const period = validPeriod(req.params.period); if (!period) return res.status(400).json({ error: 'Pick the month.' });
    res.json({ me: { canPrepare: m.canPrepare, canApprove: m.canApprove, canPay: m.canPay }, ...(await runView(period, m)) });
  });
  app.post('/api/payroll/runs/:period/prepare', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user);
    if (!m.canPrepare) return res.status(403).json({ error: 'Only HR and Admin prepare payroll.' });
    const period = validPeriod(req.params.period); if (!period) return res.status(400).json({ error: 'Pick the month.' });
    if (period > istDay().slice(0, 7)) return res.status(400).json({ error: 'That month has not started yet.' });
    try { await prepare(period, m); } catch (e) { if (e.status) return res.status(e.status).json({ error: e.message }); throw e; }
    await auditFromReq(req, 'payroll_prepared', `Prepared the payroll for ${monthLabel(period)}.`);
    res.json({ ok: true, ...(await runView(period, m)) });
  });
  app.post('/api/payroll/runs/:period/lines/:username', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user);
    if (!m.canPrepare) return res.status(403).json({ error: 'Only HR and Admin adjust payroll.' });
    const period = validPeriod(req.params.period);
    const run = period && await one('SELECT * FROM payroll_runs WHERE period=$1', [period]);
    if (!run) return res.status(404).json({ error: 'Prepare the month first.' });
    if (run.status !== 'draft') return res.status(409).json({ error: 'This month is already approved.' });
    const b = req.body || {};
    const num = (v) => v === '' || v == null ? null : r2(v);
    const manual = { ot_hours: num(b.ot_hours), other_earn: num(b.other_earn) || 0, other_earn_note: str(b.other_earn_note).trim().slice(0, 120), other_ded: num(b.other_ded) || 0, other_ded_note: str(b.other_ded_note).trim().slice(0, 120) };
    if ((manual.other_earn && !manual.other_earn_note) || (manual.other_ded && !manual.other_ded_note)) return res.status(400).json({ error: 'Write what the other earning / deduction is for.' });
    await q('UPDATE payroll_lines SET manual=$3 WHERE run_id=$1 AND username=$2', [run.id, req.params.username, manual]);
    await prepare(period, m);
    res.json({ ok: true, ...(await runView(period, m)) });
  });
  app.post('/api/payroll/runs/:period/submit', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user);
    if (!m.canPrepare) return res.status(403).json({ error: 'Only HR and Admin send payroll for approval.' });
    const run = await one('SELECT * FROM payroll_runs WHERE period=$1', [validPeriod(req.params.period)]);
    if (!run || run.status !== 'draft') return res.status(400).json({ error: 'Prepare the month first.' });
    await q('UPDATE payroll_runs SET submitted_at=$2, submitted_by=$3 WHERE id=$1', [run.id, now(), m.username]);
    await notify((await db.listUsers()).filter(u => u.role === 'admin').map(u => u.username), m.username, 'payroll_submitted', `${m.name} sent the ${monthLabel(run.period)} payroll for your approval.`);
    res.json({ ok: true });
  });
  app.post('/api/payroll/runs/:period/approve', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user);
    if (!m.canApprove) return res.status(403).json({ error: 'Only Admin approves payroll.' });
    const run = await one('SELECT * FROM payroll_runs WHERE period=$1', [validPeriod(req.params.period)]);
    if (!run || run.status !== 'draft') return res.status(400).json({ error: 'There is no prepared payroll to approve for this month.' });
    await q("UPDATE payroll_runs SET status='approved', approved_by=$2, approved_at=$3 WHERE id=$1", [run.id, m.username, now()]);
    await notify(await deciders(), m.username, 'payroll_approved', `${monthLabel(run.period)} payroll approved by ${m.name} — ready to pay (bank sheet on the HR & Payroll page).`);
    await auditFromReq(req, 'payroll_approved', `Approved the payroll for ${monthLabel(run.period)}.`);
    res.json({ ok: true });
  });
  app.post('/api/payroll/runs/:period/reopen', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user);
    if (!m.canApprove) return res.status(403).json({ error: 'Only Admin reopens payroll.' });
    const run = await one('SELECT * FROM payroll_runs WHERE period=$1', [validPeriod(req.params.period)]);
    if (!run || run.status !== 'approved') return res.status(400).json({ error: 'Only an approved, unpaid month can be reopened.' });
    await q("UPDATE payroll_runs SET status='draft', approved_by=NULL, approved_at=NULL, submitted_at=NULL WHERE id=$1", [run.id]);
    res.json({ ok: true });
  });
  app.post('/api/payroll/runs/:period/paid', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user);
    if (!m.canPay) return res.status(403).json({ error: 'Only HR and Admin mark payroll paid.' });
    const run = await one('SELECT * FROM payroll_runs WHERE period=$1', [validPeriod(req.params.period)]);
    if (!run || run.status !== 'approved') return res.status(400).json({ error: 'Admin must approve the payroll first.' });
    const lines = await rows('SELECT username, data FROM payroll_lines WHERE run_id=$1', [run.id]);
    for (const l of lines) for (const p of (l.data.advParts || [])) {
      if (!(p.amount > 0)) continue;
      await q('INSERT INTO salary_advance_recoveries(advance_id, run_id, amount, created_at) VALUES($1,$2,$3,$4)', [p.id, run.id, p.amount, now()]);
      await q("UPDATE salary_advances SET recovered = recovered + $2, status = CASE WHEN recovered + $2 >= amount THEN 'closed' ELSE status END WHERE id=$1", [p.id, p.amount]);
    }
    await q("UPDATE payroll_runs SET status='paid', paid_by=$2, paid_at=$3, paid_note=$4 WHERE id=$1", [run.id, m.username, now(), str((req.body || {}).note).trim().slice(0, 300) || null]);
    for (const l of lines) await notify([l.username], null, 'payslip_ready', `Your payslip for ${monthLabel(run.period)} is ready — net ₹${Number(l.data.net).toLocaleString('en-IN')}. Open My Attendance → Payslips.`);
    await auditFromReq(req, 'payroll_paid', `Marked the ${monthLabel(run.period)} payroll paid (${lines.length} people).`);
    res.json({ ok: true });
  });
  // Payslip: own (once paid) or anyone's for payroll viewers
  app.get('/api/payslips/:period/:username', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user);
    const period = validPeriod(req.params.period); if (!period) return res.status(400).json({ error: 'Pick the month.' });
    const self = req.params.username === m.username;
    if (!self && !m.canSeePayroll) return res.status(403).json({ error: 'Not allowed.' });
    const run = await one('SELECT * FROM payroll_runs WHERE period=$1', [period]);
    if (!run || (self && !m.canSeePayroll && run.status !== 'paid')) return res.status(404).json({ error: 'No payslip for that month yet.' });
    const l = await one('SELECT data FROM payroll_lines WHERE run_id=$1 AND username=$2', [run.id, req.params.username]);
    if (!l) return res.status(404).json({ error: 'No payslip for that month.' });
    const d = { ...l.data };
    if (self && !m.canSeePayroll) { d.employerPf = undefined; d.employerEsi = undefined; }
    res.json({ period, label: monthLabel(period), status: run.status, username: req.params.username, line: d });
  });
  // Every payslip of a month in one go (HR / Accounts / Admin) — printed or saved as one PDF from the page.
  app.get('/api/payroll/runs/:period/payslips', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user);
    if (!m.canSeePayroll) return res.status(403).json({ error: 'Not allowed.' });
    const period = validPeriod(req.params.period);
    const run = period && await one('SELECT * FROM payroll_runs WHERE period=$1', [period]);
    if (!run) return res.status(404).json({ error: 'Prepare the month first.' });
    const lines = await rows('SELECT username, data FROM payroll_lines WHERE run_id=$1 ORDER BY username', [run.id]);
    res.json({ period, label: monthLabel(period), status: run.status, slips: lines.map(l => ({ username: l.username, line: l.data })).sort((a, b) => String(a.line.name).localeCompare(String(b.line.name))) });
  });
  app.get('/api/payroll/runs/:period/export', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user);
    if (!m.canSeePayroll) return res.status(403).json({ error: 'Not allowed.' });
    const period = validPeriod(req.params.period);
    const v = period && await runView(period, m);
    if (!v || !v.run) return res.status(404).json({ error: 'Prepare the month first.' });
    const wb = new ExcelJS.Workbook();
    const head = (ws, cols) => { const r = ws.addRow(cols); r.font = { bold: true }; r.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF7' } }; }); };
    if (req.query.kind === 'bank') {
      if (!m.canPay) return res.status(403).json({ error: 'Only HR and Admin download the bank sheet.' });
      if (v.run.status === 'draft') return res.status(400).json({ error: 'Admin must approve the payroll first.' });
      const ws = wb.addWorksheet('Bank transfer');
      head(ws, ['Sr', 'Employee', 'Code', 'Bank', 'Account no', 'IFSC', 'Amount', 'Narration']);
      v.lines.forEach((l, i) => ws.addRow([i + 1, l.name, l.employee_code, l.bank.bank_name, l.bank.account_no, l.bank.ifsc, l.net, `Salary ${v.label}`]));
      ws.addRow([]); ws.addRow(['', 'Total', '', '', '', '', v.totals.net, '']);
      ws.columns = [{ width: 5 }, { width: 28 }, { width: 10 }, { width: 18 }, { width: 22 }, { width: 14 }, { width: 14 }, { width: 26 }];
      ws.getColumn(5).numFmt = '@';
    } else {
      const ws = wb.addWorksheet('Salary register');
      head(ws, ['Employee', 'Code', 'Department', 'Days', 'Paid days', 'LOP', 'Basic', 'HRA', 'Conveyance', 'Special', 'Gross earned', 'OT hrs', 'OT pay', 'Other earnings', 'PF', 'ESI', 'PT', 'Advance', 'Other deductions', 'Total deductions', 'Net pay', 'Employer PF', 'Employer ESI']);
      for (const l of v.lines) ws.addRow([l.name, l.employee_code, l.team, l.daysInMonth, l.paidDays, l.lopDays, l.earned.basic, l.earned.hra, l.earned.conveyance, l.earned.special, l.earned.gross, l.otHours, l.otPay, l.otherEarn, l.pf, l.esi, l.pt, l.advance, l.otherDed, l.totalDed, l.net, l.employerPf, l.employerEsi]);
      const t = v.totals; ws.addRow([]); ws.addRow(['Total', '', '', '', '', '', '', '', '', '', '', '', '', '', t.pf, t.esi, t.pt, t.advance, '', t.ded, t.net, t.employerPf, t.employerEsi]).font = { bold: true };
      ws.columns.forEach((c, i) => { c.width = i < 3 ? 22 : 12; });
    }
    const buf = await wb.xlsx.writeBuffer();
    res.json({ name: `${req.query.kind === 'bank' ? 'Bank-transfer' : 'Salary-register'}-${period}.xlsx`, data: 'data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,' + Buffer.from(buf).toString('base64') });
  });

  // ======================= AUTOMATIC CHECK-IN / CHECK-OUT (location tracking) =======================
  // Uses the Places engine of location tracking, which only reports a CONFIRMED arrival (inside the place for its
  // minimum stay, from accurate fixes) and a CONFIRMED departure (several accurate fixes clearly outside, over a few
  // minutes). Leaving a site is NOT a break and NOT a check-out — people go to other sites, the head office, a shop for
  // material and come back. What the system does:
  //   arrival  → checked in at the time of the first fix inside (once a day) — unless a session is already open
  //              (from earlier today, or from last night: a night shift is one session); coming back from a break
  //   sweep    → every 5 minutes:
  //              · a break whose time is nearly over → reminder; over → checked out at the moment the break time ended
  //              · 8 hours worked and the person has left every site (and not arrived at another within
  //                siteTransferMin) → work session complete, checked out at the time they left
  //              · a session open for maxSessionHours (16) → closed
  // Every write is conditional (check_in_at IS NULL / check_out_at IS NULL), so repeated or parallel uploads can never
  // check someone in twice or move a time.
  async function autoArrive(username, g, visit) {
    const S = await settings();
    if (!S.autoAttendance) return null;
    const at = new Date(visit.arrived_at).toISOString();
    // A session that is already open continues — walking into another site is not a new check-in.
    let open = await openRecord(username, S);
    if (open && open.stale) { await closeStale(open, S); open = null; }
    if (open) {
      const ob = breaksOf(open).find(b => !b.end);
      if (!ob) return null;
      const closed = closeOpenBreak(open.breaks, at, g.name);
      const up = await q('UPDATE attendance_days SET breaks=$3, updated_at=$4 WHERE username=$1 AND day=$2 AND check_out_at IS NULL RETURNING day', [username, open.day, JSON.stringify(closed), now()]);
      return up.rows[0] ? 'back' : null;
    }
    const day = istDay(at);
    // Checked out earlier today (left the site) and now arrived at a site again → checked in again; the time away is
    // kept as the gap between the two check-in / check-out pairs.
    const done = await one('SELECT * FROM attendance_days WHERE username=$1 AND day=$2 AND check_in_at IS NOT NULL AND check_out_at IS NOT NULL', [username, day]);
    if (done) {
      if (outMode(S) !== 'leave' || Date.parse(at) <= Date.parse(done.check_out_at) || done.manual_out) return null;
      const gap = breaksOf(done).concat([{ start: done.check_out_at, end: at, gap: true, out_src: done.out_source || 'manual', out_place: done.out_place || null, in_src: 'auto', in_place: g.name }]);
      const re = await q("UPDATE attendance_days SET check_out_at=NULL, out_source=NULL, out_place=NULL, out_away=NULL, out_note=NULL, breaks=$3, updated_at=$4 WHERE username=$1 AND day=$2 AND check_out_at=$5 RETURNING day",
        [username, day, JSON.stringify(gap), now(), done.check_out_at]);
      if (re.rows[0]) { await db.createNotification({ username, type: 'attendance', message: `✅ Checked in again automatically at ${istHM(at)} — ${g.name}.`, task_id: null }); return 'in'; }
      return null;
    }
    const ins = await q(`INSERT INTO attendance_days(username, day, check_in_at, in_lat, in_lng, in_place, in_away, in_source, created_at, updated_at)
      VALUES($1,$2,$3,$4,$5,$6,false,'auto',$7,$7) ON CONFLICT (username, day) DO UPDATE SET check_in_at=EXCLUDED.check_in_at, in_lat=EXCLUDED.in_lat,
        in_lng=EXCLUDED.in_lng, in_place=EXCLUDED.in_place, in_away=false, in_source='auto', updated_at=EXCLUDED.updated_at
      WHERE attendance_days.check_in_at IS NULL RETURNING day`, [username, day, at, g.center_lat, g.center_lng, g.name, now()]);
    if (ins.rows[0]) {
      await db.createNotification({ username, type: 'attendance', message: `✅ Checked in automatically at ${istHM(at)} — ${g.name}.`, task_id: null });
      return 'in';
    }
    return null;
  }
  async function stillInsideSomewhere(username) {
    try { return !!(await one('SELECT 1 FROM geofence_visits WHERE username=$1 AND departed_at IS NULL AND confirmed_at IS NOT NULL LIMIT 1', [username])); } catch (e) { return false; }
  }
  async function autoCheckOut(username, day, at, placeName, why) {
    const rec = await one('SELECT * FROM attendance_days WHERE username=$1 AND day=$2', [username, day]);
    if (!rec || !rec.check_in_at || rec.check_out_at) return false;
    if (Date.parse(at) < Date.parse(rec.check_in_at)) at = rec.check_in_at;
    // A break still open when the session closes ends where the session ends.
    const breaks = breaksOf(rec).filter(b => b.start && Date.parse(b.start) < Date.parse(at)).map(b => b.end && Date.parse(b.end) <= Date.parse(at) ? b : { ...b, end: at });
    const placeList = await places();
    const away = await awayMinutes(username, rec.check_in_at, at, breaks, placeList);
    const up = await q("UPDATE attendance_days SET check_out_at=$3, out_place=$4, out_away=false, breaks=$5, away_minutes=$6, out_source='auto', updated_at=$7 WHERE username=$1 AND day=$2 AND check_out_at IS NULL RETURNING day",
      [username, day, at, placeName || rec.in_place || null, JSON.stringify(breaks), away, now()]);
    if (up.rows[0]) await db.createNotification({ username, type: 'attendance', message: `🏁 Checked out automatically at ${istHM(at)}${placeName ? ` — ${placeName}` : ''}${why ? ` (${why})` : ''}.`, task_id: null });
    return !!up.rows[0];
  }
  // A session that ran for the maximum length (forgotten check-out): closed at the last moment the phone was seen
  // (tracking), else at the end of that day's shift — never later than the limit.
  async function closeStale(rec, S) {
    const limit = new Date(Date.parse(rec.check_in_at) + maxSessionMs(S)).toISOString();
    let end = null, placeName = null;
    try {
      const r = await one('SELECT MAX(recorded_at) AS last FROM location_points WHERE username=$1 AND recorded_at BETWEEN $2 AND $3', [rec.username, rec.check_in_at, limit]);
      if (r && r.last) end = new Date(r.last).toISOString();
    } catch (e) { end = null; }
    if (!end) {
      const shiftEnd = new Date(dayStartUtc(rec.day).getTime() + (minutesOf(S.shiftEnd) || 1080) * 60000).toISOString();
      end = shiftEnd > rec.check_in_at ? shiftEnd : limit;
    }
    if (end > limit) end = limit;
    return autoCheckOut(rec.username, rec.day, end, placeName, `session closed after ${Number(S.maxSessionHours || 16)} hours`);
  }
  // 8 hours worked, then out of every site's radius (and not arrived at another within siteTransferMin) → the work
  // session is complete: checked out at the time the person left.
  async function fullDayExit(rec, S, nowDate) {
    const mode = outMode(S);
    if (mode === 'off') return false;
    // the latest (re)start of this session: its check-in, or coming back after a check-out earlier today
    const restarts = breaksOf(rec).filter(b => b.gap && b.end).map(b => b.end);
    const since = [rec.check_in_at, ...restarts].sort().pop();
    if (await stillInsideSomewhere(rec.username)) return false;
    let v = null;
    try {
      v = await one(`SELECT v.last_inside_at, g.name FROM geofence_visits v JOIN geofences g ON g.id = v.geofence_id
        WHERE v.username=$1 AND v.confirmed_at IS NOT NULL AND v.end_reason='left' AND v.last_inside_at >= $2 ORDER BY v.last_inside_at DESC LIMIT 1`, [rec.username, since]);
    } catch (e) { v = null; }
    if (!v) return false;
    const leftAt = new Date(v.last_inside_at).toISOString();
    if (nowDate - Date.parse(leftAt) < Number(S.siteTransferMin || 0) * 60000) return false; // may be walking to another site
    if (mode === 'fullday' && workedMinutesAt(rec, leftAt, S) < Number(S.fullDayHours || 8) * 60) return false;
    return autoCheckOut(rec.username, rec.day, leftAt, v.name, mode === 'fullday' ? 'full day worked and left the site' : 'left the site');
  }
  // The hook of a departure: the check-out itself waits for siteTransferMin (done by the sweep) unless that is 0.
  async function autoLeave(username, g, visit) {
    const S = await settings();
    if (!S.autoAttendance) return null;
    // Normally the sweep (every 5 minutes) does this once the person has really stayed away for siteTransferMin: deciding
    // here could check someone out while a later fix of the same upload shows them arriving at another site.
    if (Number(S.siteTransferMin || 0) > 0) return null;
    const rec = await openRecord(username, S);
    if (!rec || rec.stale) return null;
    return (await fullDayExit(rec, S, new Date())) ? 'out' : null;
  }
  // Attendance photos are deleted at 12:00 (noon, IST) on the day after they were taken.
  async function purgeOldPhotos(nowDate = new Date()) {
    const cutoff = istDay(new Date(nowDate.getTime() - 12 * 3600000)); // days before this one are past their noon-next-day
    const r = await q('UPDATE attendance_days SET in_photo=NULL, out_photo=NULL WHERE day < $1 AND (in_photo IS NOT NULL OR out_photo IS NOT NULL)', [cutoff]);
    await q('UPDATE attendance_attempts SET photo=NULL WHERE day < $1 AND photo IS NOT NULL', [cutoff]).catch(() => null);
    return r.rowCount;
  }
  async function autoSweep(nowDate = new Date()) {
    await purgeOldPhotos(nowDate).catch(() => 0);
    const S = await settings();
    if (!S.autoAttendance) return { skipped: 'off' };
    const open = await rows('SELECT * FROM attendance_days WHERE check_in_at IS NOT NULL AND check_out_at IS NULL');
    let closed = 0, reminded = 0;
    for (const r of open) {
      r.stale = nowDate - Date.parse(r.check_in_at) >= maxSessionMs(S);
      if (r.stale) { if (await closeStale(r, S)) closed++; continue; }
      let brs = breaksOf(r);
      // An "automatic break" left over from the old rules is not a break — it only meant the person had left a site.
      if (brs.some(b => b.auto && !b.end)) {
        brs = brs.filter(b => !(b.auto && !b.end));
        await q('UPDATE attendance_days SET breaks=$3 WHERE username=$1 AND day=$2 AND check_out_at IS NULL', [r.username, r.day, JSON.stringify(brs)]);
        r.breaks = brs;
      }
      const ob = brs.find(b => !b.end);
      if (ob) {
        const deadline = Date.parse(ob.start) + breakLeftMin(r, S) * 60000;
        if (nowDate >= deadline) {
          // Break time is over and the person did not come back: checked out when the break time ended.
          if (await autoCheckOut(r.username, r.day, new Date(deadline).toISOString(), ob.back_place || null, 'break time was over')) closed++;
          continue;
        }
        const minsLeft = Math.ceil((deadline - nowDate) / 60000);
        const remind = Number(S.breakRemindMin || 10);
        const flag = minsLeft <= 2 ? 'r2' : minsLeft <= remind ? 'r1' : null;
        if (flag && !ob[flag]) {
          ob[flag] = true;
          const up = await q('UPDATE attendance_days SET breaks=$3 WHERE username=$1 AND day=$2 AND check_out_at IS NULL RETURNING day', [r.username, r.day, JSON.stringify(brs)]);
          if (up.rows[0]) {
            await db.createNotification({ username: r.username, type: 'attendance', message: `☕ Your break ends in ${minsLeft} min (${istHM(new Date(deadline).toISOString())}). Go back to site and tap "Back from break" — otherwise you will be checked out at ${istHM(new Date(deadline).toISOString())}.`, task_id: null });
            reminded++;
          }
        }
        continue;
      }
      if (await fullDayExit(r, S, nowDate)) closed++;
    }
    return { open: open.length, closed, reminded };
  }
  // Admin / HR: run the automatic check-out sweep now (it also runs every 5 minutes).
  app.post('/api/attendance/auto-run', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user);
    if (!m.canEditAttendance) return res.status(403).json({ error: 'Only HR and Admin.' });
    res.json(await autoSweep());
  });
  function attachLocation(service, jobs) {
    if (!service || !service.hooks) return;
    service.hooks.onVisitConfirmed.push(async (session, g, visit) => { await autoArrive(session.username, g, visit); });
    service.hooks.onVisitEnded.push(async (session, g, visit) => { await autoLeave(session.username, g, visit); });
    if (jobs) {
      jobs.register('ATTENDANCE_AUTO', async () => autoSweep(), { maxAttempts: 2, baseDelayMs: 60000 });
      jobs.every('ATTENDANCE_AUTO', 5 * 60 * 1000);
    }
  }
  return { attachLocation, autoSweep, autoArrive, autoLeave };
}

module.exports = { mountPayroll, ptFor, DEFAULTS, STATUS_LABEL };
