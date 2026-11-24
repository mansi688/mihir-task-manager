/* Attendance & payroll pages.
   - "My Attendance" (everyone): Checked in / out automatically from location tracking (or by GPS on the phone), the month at a glance, leave (balance,
     ask, withdraw) and payslips.
   - "HR & Payroll" (Admin, HR): Today, Register (correct a day), Leave requests, Salaries, Advances,
     Payroll (prepare → send for approval → Admin approves → HR marks paid; register / bank sheet), Rules.
   Data: /api/attendance/*, /api/leave*, /api/payroll/*, /api/payslips/* — loaded while a page is open; the small
   /api/attendance/summary comes with the core data (menu badges, "Waiting for your decision"). Loaded before app.js. */

let attSummary = { canSeeAttendance: false, canSeePayroll: false };
let attMe = null, attLoading = false;
let hrData = {}; // per HR sub-tab: { key, data }
const ATT_CODE = { P: 'P', H: '½', A: 'A', L: 'L', LH: 'L½', U: 'U', WO: 'WO', HO: 'HO', F: '' };
const ATT_LABEL = { P: 'Present', H: 'Half day', A: 'Absent', L: 'Paid leave', LH: 'Half day leave', U: 'Unpaid leave', WO: 'Weekly off', HO: 'Holiday', F: 'Coming' };
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HR_TABS = [['today', 'Today'], ['timelog', 'Time log'], ['register', 'Register'], ['leave', 'Leave'], ['salaries', 'Salaries'], ['advances', 'Advances'], ['payroll', 'Payroll'], ['rules', 'Rules & holidays']];
function attEsc(s) { return typeof esc === 'function' ? esc(s) : String(s == null ? '' : s); }
function inr(n) { if (n == null || n === '') return '—'; const v = Number(n); return '₹' + v.toLocaleString('en-IN', { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 }); }
function attToday() { return typeof istDayKey === 'function' ? istDayKey(new Date().toISOString()) : new Date().toISOString().slice(0, 10); }
function attMonthNow() { return attToday().slice(0, 7); }
function attShiftMonth(p, n) { const [y, m] = p.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; }
function attMonthLabel(p) { try { return new Date(`${p}-15T12:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }); } catch (e) { return p; } }
function attDayLabel(d) { try { return new Date(`${d}T12:00:00+05:30`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }); } catch (e) { return d; } }
function attState() { if (!ui.att) ui.att = { month: attMonthNow(), leaveForm: null, punch: null, slip: null }; return ui.att; }
function hrState() { if (!ui.hr) ui.hr = { tab: 'today', month: attMonthNow(), payMonth: attShiftMonth(attMonthNow(), -1), day: attToday(), q: '', edit: null, salEdit: null, advForm: null, lineEdit: null, holiday: null }; return ui.hr; }
function hrTabVisible() { return !!(attSummary && (attSummary.canSeeAttendance || attSummary.canSeePayroll)); }
function hrBadge() { const s = attSummary || {}; return (s.pendingLeave || []).length + (s.payrollToApprove || []).length + (s.payrollToPay || []).length; }

// Buttons in "Waiting for your decision" (Notifications / Approvals pages)
document.addEventListener('click', async (e) => {
  const lb = e.target.closest && e.target.closest('[data-pd-leave]');
  if (lb) {
    e.preventDefault(); e.stopPropagation(); if (lb.disabled) return;
    const [id, decision] = lb.dataset.pdLeave.split('|'); const note = (document.getElementById(`pdl-${id}`) || {}).value || '';
    lb.disabled = true;
    try { await api(`/api/leave/${id}/decide`, { method: 'POST', body: JSON.stringify({ decision, note }) }); setBanner(decision === 'approve' ? 'Leave approved.' : 'Leave rejected.', 'ok'); hrData.leave = null; await refreshData(); }
    catch (err) { lb.disabled = false; setBanner(err.message); render(); }
    return;
  }
  const pb = e.target.closest && e.target.closest('[data-pd-payroll]');
  if (pb) { e.preventDefault(); e.stopPropagation(); const s = hrState(); s.tab = 'payroll'; s.payMonth = pb.dataset.pdPayroll; ui.adminTab = 'payroll'; window.scrollTo(0, 0); render(); }
}, true);

// ---------- location + selfie
function attGeo(onProgress) {
  // 1) a fresh, accurate GPS fix; 2) if the phone / laptop can't give one, a quicker network fix; 3) the position the
  // running location tracking saw in the last 2 minutes. The server still checks accuracy and the site circle.
  const tracked = () => {
    try {
      const w = window.LocationUI && LocationUI._web && LocationUI._web.last;
      if (w && Date.now() - w.t < 120000) return { lat: w.lat, lng: w.lng, acc: Math.round(w.acc || 0), fromTracking: true };
    } catch (e) { /* ignore */ }
    return nativeFix();
  };
  // MIHIR Android app 1.6+: the phone's best position from Google's fused location / the tracking service
  const nativeFix = () => {
    try {
      if (!window.AndroidBridge || typeof window.AndroidBridge.currentFix !== 'function') return null;
      const f = JSON.parse(window.AndroidBridge.currentFix() || 'null');
      if (f && f.lat != null && Date.now() - Number(f.t || 0) < 120000) return { lat: f.lat, lng: f.lng, acc: Math.round(f.acc || 0), fromTracking: true };
    } catch (e) { /* old app */ }
    return null;
  };
  const once = (opts, ms) => new Promise((resolve) => {
    if (!navigator.geolocation) { resolve({ error: 'no GPS on this device' }); return; }
    let done = false; const fin = (v) => { if (!done) { done = true; resolve(v); } };
    setTimeout(() => fin({ error: 'location took too long' }), ms);
    navigator.geolocation.getCurrentPosition(p => fin({ lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy || 0) }),
      e => fin({ error: e && e.code === 1 ? 'location permission is off for this site' : 'this device could not find its location', code: e && e.code }), opts);
  });
  // Watch the GPS for up to 15 s and keep the most accurate reading — the first reading indoors is often ±150 m
  // and improves to ±10–30 m within seconds. Stops as soon as one is good enough.
  const best = (ms) => new Promise((resolve) => {
    if (!navigator.geolocation || !navigator.geolocation.watchPosition) { resolve(null); return; }
    let top = null, id = null, done = false;
    const fin = () => { if (done) return; done = true; try { navigator.geolocation.clearWatch(id); } catch (e) {} resolve(top || { error: lastErr || 'this device could not find its location', code: lastCode }); };
    let lastErr = null, lastCode = null;
    id = navigator.geolocation.watchPosition(p => {
      const acc = Math.round(p.coords.accuracy || 9999);
      if (!top || acc < top.acc) top = { lat: p.coords.latitude, lng: p.coords.longitude, acc };
      if (typeof onProgress === 'function') onProgress(top.acc);
      if (acc <= 25) fin();
    }, e => { lastErr = e && e.code === 1 ? 'location permission is off for this site' : 'this device could not find its location'; lastCode = e && e.code; if (e && e.code === 1) fin(); },
    { enableHighAccuracy: true, maximumAge: 0, timeout: ms });
    setTimeout(fin, ms);
  });
  return (async () => {
    const a = (await best(15000)) || await once({ enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }, 15000);
    if (!a.error) { const t = tracked(), n = nativeFix(); return [a, t, n].filter(x => x && x.acc).sort((x, y) => x.acc - y.acc)[0] || a; }
    if (a.code === 1) return tracked() || a;
    const b = await once({ enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 }, 12000);
    if (!b.error) return b;
    return tracked() || { error: `${b.error} — on a laptop / desktop turn on Windows location (Settings → Privacy → Location) or use your phone` };
  })();
}
function attSmallJpeg(file) {
  return new Promise((resolve) => {
    const rd = new FileReader();
    rd.onload = () => {
      const img = new Image();
      img.onload = () => { try { const w = Math.min(480, img.width), h = Math.round(img.height * w / img.width); const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').drawImage(img, 0, 0, w, h); resolve(c.toDataURL('image/jpeg', 0.6)); } catch (e) { resolve(null); } };
      img.onerror = () => resolve(null); img.src = rd.result;
    };
    rd.onerror = () => resolve(null); rd.readAsDataURL(file);
  });
}

// ---------- My Attendance
async function attLoad(force) {
  const s = attState();
  if (attLoading || (!force && attMe && attMe.period === s.month)) return;
  attLoading = true;
  try { attMe = await api(`/api/attendance/me?month=${s.month}`); } catch (e) { attMe = { error: e.message, period: s.month }; }
  attLoading = false;
  if (ui.adminTab === 'attendance' || Date.now() - attFrontRenderedAt < 4000) render();
}
function attCalendarHTML(days, opts = {}) {
  if (!days || !days.length) return '';
  const first = new Date(`${days[0].day}T12:00:00Z`).getUTCDay();
  const cells = Array.from({ length: first }, () => '<div class="att-cal-cell empty"></div>').concat(days.map(d => {
    const n = Number(d.day.slice(8));
    const tip = [ATT_LABEL[d.status] || '', d.in ? `in ${d.in}` : '', d.out ? `out ${d.out}` : '', d.late ? `late ${d.late} min` : '', d.ot ? `OT ${Math.round(d.ot / 6) / 10} h` : '', d.holiday || '', ...(d.flags || [])].filter(Boolean).join(' · ');
    return `<div class="att-cal-cell st-${d.status} ${d.day === attToday() ? 'today' : ''}" title="${attEsc(tip)}"><span class="att-cal-n">${n}</span><b>${ATT_CODE[d.status] || ''}</b>${d.in ? `<span class="att-cal-t">${d.in}${d.out ? `–${d.out}` : ''}</span>` : ''}${d.late ? '<i class="att-late" title="Late">●</i>' : ''}${(d.flags || []).includes('not at a site') ? '<i class="att-away" title="Not at a site">📍</i>' : ''}</div>`;
  }));
  return `<div class="att-cal">${WEEKDAYS.map(w => `<div class="att-cal-h">${w}</div>`).join('')}${cells.join('')}</div>`;
}
function attSummaryChips(s) {
  if (!s) return '';
  const c = s.counts || {};
  return `<div class="att-chips">${[['P', c.P], ['H', c.H], ['A', c.A], ['L', (c.L || 0) + (c.LH || 0)], ['U', c.U], ['WO', c.WO], ['HO', c.HO]].filter(([, v]) => v).map(([k, v]) => `<span class="att-chip st-${k}">${ATT_LABEL[k]} <b>${v}</b></span>`).join('')}
    ${s.lateMarks ? `<span class="att-chip">Late <b>${s.lateMarks}</b>${s.lateCutDays ? ` (−${s.lateCutDays} day)` : ''}</span>` : ''}${s.otMinutes ? `<span class="att-chip">OT <b>${Math.round(s.otMinutes / 6) / 10} h</b></span>` : ''}
    <span class="att-chip strong">Paid days so far <b>${s.paidDays}</b></span></div>`;
}
function renderAttendanceView() {
  const s = attState();
  if (!attMe || attMe.period !== s.month) setTimeout(() => attLoad(), 0);
  const d = attMe && attMe.period === s.month ? attMe : null;
  if (!d) return '<div class="card"><div class="empty">Loading…</div></div>';
  if (d.error) return `<div class="card"><div class="err">${attEsc(d.error)}</div></div>`;
  const t = d.todayRec, R = d.rules || {};
  const p = s.punch;
  const isNow = s.month === attMonthNow();
  const lf = s.leaveForm;
  const bal = d.leave.balance;
  return `
  ${attTodayCardHTML(d, p, false)}

  <div class="card">
    <div class="flex-between" style="gap:8px;flex-wrap:wrap;">
      <div class="card-title" style="margin:0;">${attEsc(attMonthLabel(s.month))}</div>
      <div style="display:flex;gap:6px;"><button class="btn btn-sm" data-att-month="-1">‹ Previous</button>${isNow ? '' : '<button class="btn btn-sm" data-att-month="0">This month</button>'}<button class="btn btn-sm" data-att-month="1" ${isNow ? 'disabled' : ''}>Next ›</button></div>
    </div>
    ${attSummaryChips(d.summary)}
    ${attCalendarHTML(d.days)}
    <div class="small muted" style="margin-top:6px;">P present · ½ half day · A absent · L paid leave · U unpaid leave · WO weekly off · HO holiday · ● late · 📍 not at a site. Something wrong? Tell HR — they can correct a day.</div>
  </div>

  <div class="card">
    <div class="flex-between" style="gap:8px;flex-wrap:wrap;">
      <div><div class="card-title" style="margin:0;">Leave</div><div class="small muted">Paid leave ${attEsc(String(d.today).slice(0, 4))}: <b>${bal.left}</b> left of ${bal.quota}${bal.pending ? ` · ${bal.pending} waiting` : ''}</div></div>
      ${lf ? '' : '<button class="btn btn-sm btn-primary" data-att-act="leave-new">+ Ask for leave</button>'}
    </div>
    ${lf ? `<div class="att-form">
      <div class="row">
        <div class="col"><label>From *</label><input type="date" id="lv-from" value="${attEsc(lf.from || '')}"></div>
        <div class="col"><label>To</label><input type="date" id="lv-to" value="${attEsc(lf.to || '')}" ${lf.half ? 'disabled' : ''}></div>
        <div class="col"><label>Kind</label><select id="lv-kind"><option value="paid" ${lf.kind !== 'unpaid' ? 'selected' : ''}>Paid leave</option><option value="unpaid" ${lf.kind === 'unpaid' ? 'selected' : ''}>Unpaid leave</option></select></div>
      </div>
      <label class="att-check"><input type="checkbox" id="lv-half" ${lf.half ? 'checked' : ''}> Half day</label>
      <label>Reason *</label><input type="text" id="lv-reason" value="${attEsc(lf.reason || '')}" placeholder="e.g. Family function in Nashik">
      ${lf.err ? `<div class="err">${attEsc(lf.err)}</div>` : ''}
      <div style="margin-top:8px;display:flex;gap:8px;"><button class="btn btn-primary btn-sm" data-att-act="leave-send">Send to HR</button><button class="btn btn-sm" data-att-act="leave-cancel-form">Cancel</button></div>
    </div>` : ''}
    ${(d.leave.requests || []).length ? `<div class="att-list">${d.leave.requests.map(l => `<div class="att-list-row">
      <div><b>${attEsc(attDayLabel(l.from_day))}${l.to_day !== l.from_day ? ` – ${attEsc(attDayLabel(l.to_day))}` : ''}</b>${l.half_day ? ' (half day)' : ''} · ${l.kind === 'paid' ? 'Paid' : 'Unpaid'} · ${Number(l.days)} day${Number(l.days) === 1 ? '' : 's'}
        <div class="small muted">${attEsc(l.reason || '')}${l.decision_note ? ` — ${attEsc(l.decided_by_name || '')}: “${attEsc(l.decision_note)}”` : ''}</div></div>
      <div style="display:flex;gap:6px;align-items:center;"><span class="bud-chip ${l.status === 'approved' ? 'good' : l.status === 'rejected' ? 'bad' : l.status === 'pending' ? 'warn' : ''}">${attEsc(l.status)}</span>
        ${l.status === 'pending' || (l.status === 'approved' && l.from_day > d.today) ? `<button class="btn btn-sm" data-leave-cancel="${l.id}">Withdraw</button>` : ''}</div>
    </div>`).join('')}</div>` : '<div class="small muted" style="margin-top:6px;">No leave asked yet.</div>'}
  </div>

  <div class="card">
    <div class="card-title">Payslips</div>
    ${(d.payslips || []).length ? `<div class="att-list">${d.payslips.map(p => `<div class="att-list-row"><div><b>${attEsc(p.label)}</b> <span class="small muted">net ${inr(p.net)}</span></div><button class="btn btn-sm" data-slip="${attEsc(p.period)}:${attEsc(d.me.username)}">View payslip</button></div>`).join('')}</div>` : '<div class="small muted">Your payslips appear here once the month is paid.</div>'}
  </div>
  ${typeof ppMyRequestsHTML === 'function' ? ppMyRequestsHTML() : ''}
  ${payslipModalHTML()}${attCameraHTML()}${typeof ppReqModalHTML === 'function' ? ppReqModalHTML() : ''}`;
}
// ---- Clock-in card in the style of a clock-in app: shift, late badge, clock in / out, effective & gross hours.
const attFmtH = (m) => `${Math.floor((m || 0) / 60)}h ${String((m || 0) % 60)}m`;
let attPhotoCache = {};
function attKekaHeadHTML(d, t, R, front) {
  const tl = t && t.timeline;
  const late = tl && tl.lateMin > 0 ? `<span class="keka-late">${Math.floor(tl.lateMin / 60)}:${String(tl.lateMin % 60).padStart(2, '0')}<br>LATE</span>` : '';
  return `<div class="keka-date">${attEsc(new Date(`${d.today}T12:00:00+05:30`).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }))}</div>
  <div class="keka-shift"><div><b>${attEsc(R.shiftStart)} – ${attEsc(R.shiftEnd)}</b> <span class="muted">· Regular shift · full day ${R.fullDayHours} h${R.breakAllowanceMin ? ` · break ${R.breakAllowanceMin} min` : ''}</span></div>${late}</div>
  <div class="keka-inout">
    <div><div class="keka-lbl">Clock in</div><div class="keka-t in">↙ ${t && t.in ? attEsc(t.in) : '—'}${t && t.fromEarlierDay ? ' <small>(yesterday)</small>' : ''}</div></div>
    <div style="text-align:right;"><div class="keka-lbl">Clock out</div><div class="keka-t out">${t && t.out ? '↗ ' + attEsc(t.out) : t && t.in ? '<span class="miss">↗ MISSING</span>' : '—'}</div></div>
  </div>
  <div class="keka-hours"><span>Effective hours <b>${attFmtH(tl ? tl.effectiveMin : 0)}</b></span><span>Gross hours <b>${attFmtH(tl ? tl.grossMin : 0)}</b></span></div>`;
}
function attTimeLogsHTML(d, t) {
  if (!t || !t.in) return '';
  const tl = t.timeline || {};
  const pin = (url) => url ? `<a class="keka-pin" href="${attEsc(url)}" target="_blank" rel="noopener" title="Open in Maps">📍</a>` : '';
  const key = `${d.me.username}|${t.day}`;
  if (tl.hasInPhoto && attPhotoCache[key] === undefined) {
    attPhotoCache[key] = null;
    api(`/api/attendance/photo/${encodeURIComponent(d.me.username)}/${t.day}/in`).then(r => { attPhotoCache[key] = r.data; render(); }).catch(() => { attPhotoCache[key] = false; });
  }
  const thumb = attPhotoCache[key] ? `<img class="keka-thumb" src="${attPhotoCache[key]}" alt="">` : '';
  return `<div class="keka-logs"><div class="keka-h">Time logs</div>
    ${tl.missedChecks ? `<div class="keka-warn">⚠ ${tl.missedChecks} location check${tl.missedChecks === 1 ? '' : 's'} missed today <span class="muted">— keep the work session on and location allowed</span></div>` : ''}
    <div class="keka-tag">${t.inAuto ? 'Automatic clock in' : t.inAway ? 'Remote clock in' : 'Clock in'}</div>
    <div class="keka-row"><span class="keka-ic in">↙</span><div><b>${attEsc(t.in)}</b><div class="small muted">${attEsc(t.inPlace || (t.inAway ? 'Not at a site' : ''))}${t.inNote ? ` · ${attEsc(t.inNote)}` : ''}</div></div><span class="keka-right">${thumb}${pin(tl.inMap)}</span></div>
    ${t.out ? `<div class="keka-row"><span class="keka-ic out">↗</span><div><b>${attEsc(t.out)}</b><div class="small muted">${attEsc(t.outPlace || (t.outAway ? 'Not at a site' : ''))}${t.outAuto ? ' · automatic' : ''}${t.outNote ? ` · ${attEsc(t.outNote)}` : ''}</div></div><span class="keka-right">${pin(tl.outMap)}</span></div>`
      : '<div class="keka-row miss"><span class="keka-ic out">↗</span><div><b>OUT missing</b></div></div>'}
    ${(t.breaks || []).length ? `<div class="keka-tag">Breaks</div>${t.breaks.map(b => `<div class="keka-row"><span class="keka-ic">☕</span><div><b>${attEsc(b.start)} – ${attEsc(b.end || 'now')}</b></div></div>`).join('')}` : ''}
    ${(tl.punches || []).length ? `<div class="keka-tag">Location punch</div>${tl.punches.map(p => `<div class="keka-row"><span class="keka-ic">●</span><div><b>${attEsc(p.at)}</b><div class="small muted">${attEsc(p.place || 'Location recorded')}</div></div><span class="keka-right">${pin(p.map)}</span></div>`).join('')}` : ''}
  </div>`;
}
// The "today" card: used on My Attendance and — in a compact form — at the top of the front page.
let attFrontRenderedAt = 0;
function attWhich() { const t = attMe && attMe.todayRec; return t && t.in && !t.out ? 'out' : 'in'; }
function attTodayCardHTML(d, p, front) {
  const t = d.todayRec, R = d.rules || {};
  const open = !!(t && t.in && !t.out);
  const L = window.LocationUI && LocationUI.attendanceStatus ? LocationUI.attendanceStatus() : { available: false };
  const nowMs = Date.now();
  const leftMs = t && t.onBreak && t.breakBackByIso ? Date.parse(t.breakBackByIso) - nowMs : null;
  const leftMin = leftMs == null ? null : Math.max(0, Math.ceil(leftMs / 60000));
  const breakBox = open ? `<div class="att-break ${t.onBreak ? 'on' : ''}">
      ${t.onBreak ? `<div>☕ <b>On break since ${attEsc(t.breakSince)}</b> — be back by <b>${attEsc(t.breakBackBy)}</b> (<span id="att-break-left" data-back-by="${attEsc(t.breakBackByIso || '')}">${leftMin} min left</span>)</div>
        <div class="small ${leftMin != null && leftMin <= (R.breakRemindMin || 10) ? 'dlv-warn-text' : 'muted'}">Go back to site and tap “Back from break”. If you are not back by ${attEsc(t.breakBackBy)} you are checked out at that time (the hours you worked still count).</div>
        <button type="button" class="btn btn-primary btn-sm" data-att-act="break-end" ${p && p.busy ? 'disabled' : ''}>↩ Back from break</button>`
      : `<div class="small">Break today: <b>${t.breakUsedMin}</b> of ${R.breakAllowanceMin} min used — take it any time of the day${t.breakLeftMin ? '' : ' (used up)'}.</div>
        ${t.breakLeftMin ? `<button type="button" class="btn btn-sm" data-att-act="break-start" ${p && p.busy ? 'disabled' : ''}>☕ Start break</button>` : ''}`}
    </div>` : '';
  // Work session (location tracking) — needed for automatic check-in / out and accurate site tracking.
  let loc = '';
  if (L.available) {
    if (L.loading) loc = '<div class="small muted">Checking location tracking…</div>';
    else if (L.active) loc = `<div class="att-auto-on">🛰 <b>Work session is on</b>${L.lastFix ? ` · last position ${attEsc(new Date(L.lastFix).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }))}` : ''} — location is being recorded.</div>`;
    else loc = `<div class="att-auto-off"><span>⚠ <b>Work session is off</b> — your location is not being recorded and you will not be checked in or out automatically.</span>
        <button type="button" class="btn btn-primary btn-sm" data-att-act="loc-on" ${L.busy ? 'disabled' : ''}>${L.consent ? '▶ Start work session' : '▶ Start work session…'}</button></div>`;
  }
  const oldApp = window.AndroidBridge && typeof window.AndroidBridge.cameraReady !== 'function'
    ? '<div class="small">📱 A new MIHIR app (1.7) fixes the camera: <a href="/app/android" download><b>download and install it</b></a> over this one — you stay logged in.</div>'
    : !window.AndroidBridge && /android/i.test(navigator.userAgent) ? '<div class="small muted">📱 For automatic attendance and the camera install the app: <a href="/app/android" download><b>MIHIR Android app</b></a>.</div>' : '';
  return `<div class="card att-today ${front ? 'att-front' : ''}">
    ${attKekaHeadHTML(d, t, R, front)}
    ${t && t.inNote ? `<div class="small muted">Note at check-in: ${attEsc(t.inNote)}</div>` : ''}
    ${breakBox}
    ${attTimeLogsHTML(d, t)}
    ${loc}
    ${oldApp}
    ${!(t && t.onBreak) ? `<div class="att-punch">
      <button type="button" class="btn btn-primary att-punch-btn ${p && p.busy ? 'disabled' : ''}" data-att-act="punch" ${p && p.busy ? 'disabled' : ''}>${p && p.busy ? '⏳ ' + attEsc(p.msg || 'Working…') : open ? '🏁 Check out' : t && t.out ? '📷 Check in again' : '📷 Check in'}</button>
      ${typeof ppReqModalHTML === 'function' ? '<button type="button" class="btn btn-sm" data-pp-act="req-open">📝 Raise Request</button>' : ''}
      <input type="text" id="att-note" maxlength="200" class="att-note" placeholder="Where / why? (optional) — e.g. visiting Amara site, collecting material" value="${attEsc((attState().note) || '')}">
      <div class="small muted">${!open && R.selfieRequired ? 'Check-in opens the camera for a live photo (not from the gallery; kept until 12 noon the next day). ' : ''}Your GPS position is noted — an accurate fix is not needed to check in or out.${open ? ' Check-out needs no photo.' : ''}${R.autoAttendance ? ` You are also checked in automatically when location sees you on a site, and checked out automatically once you have worked ${R.fullDayHours} h and left the site.` : ''}</div>
    </div>` : ''}
    ${p && p.err ? `<div class="err">${attEsc(p.err)}</div>` : ''}
    ${p && p.done ? `<div class="notice">${attEsc(p.done)}</div>` : ''}
    ${front ? '' : ''}
  </div>`;
}
// Front page: the same card, loaded on demand.
function attFrontCardHTML() {
  attFrontRenderedAt = Date.now();
  if (!attMe) { setTimeout(() => attLoad(), 0); return '<div class="card att-front"><div class="small muted">Loading attendance…</div></div>'; }
  if (attMe.error || !attMe.todayRec && !attMe.rules) return '';
  return attTodayCardHTML(attMe, attState().punch, true) + attCameraHTML() + (typeof ppReqModalHTML === 'function' ? ppReqModalHTML() : '');
}
// ---------- live selfie camera (no gallery / file picker)
let attCamStream = null;
function attCameraHTML() {
  const c = (ui.att || {}).cam; if (!c) return '';
  return `<div class="att-modal att-cam-modal"><div class="att-modal-box att-cam-box">
    <div class="card-title" style="margin:0 0 8px;">Check in — live photo</div>
    ${c.err ? `<div class="err">${attEsc(c.err)}</div>
      <label class="btn btn-primary att-shutter" style="display:inline-block;cursor:pointer;margin:6px 0;">📷 Open the phone camera<input type="file" accept="image/*" capture="user" data-att-cam-file style="display:none;"></label>`
      : '<div class="att-cam-wrap"><video id="att-video" autoplay playsinline muted></video><div class="att-cam-ring"></div></div>'}
    <div class="att-cam-btns">${c.err ? '' : '<button type="button" class="btn btn-primary att-shutter" data-att-cam="shoot" disabled>📸 Take photo</button>'}<button type="button" class="btn" data-att-cam="cancel">Cancel</button></div>
    <div class="small muted" style="margin-top:6px;">Face the camera in good light. The photo is taken now — not from the gallery.</div>
  </div></div>`;
}
function attStopCamera() { try { (attCamStream && attCamStream.getTracks() || []).forEach(t => t.stop()); } catch (e) {} attCamStream = null; }
let attCamStarting = false;
async function attStartCamera() {
  const c = (ui.att || {}).cam; const v = document.getElementById('att-video'); if (!c || !v || attCamStarting) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { c.err = 'The camera cannot be opened inside this page on this phone.'; render(); return; }
  attCamStarting = true;
  try {
    // Try the front camera first; fall back to any camera (some phones refuse the size / facing hint).
    const tries = [{ video: { facingMode: 'user', width: { ideal: 720 }, height: { ideal: 960 } }, audio: false }, { video: { facingMode: 'user' }, audio: false }, { video: true, audio: false }];
    let stream = null, lastErr = null;
    for (const cons of tries) { try { stream = await navigator.mediaDevices.getUserMedia(cons); break; } catch (e) { lastErr = e; if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) break; } }
    if (!stream) throw lastErr || new Error('no camera');
    attCamStream = stream;
    if (!(ui.att || {}).cam) { attStopCamera(); return; }
    attShowStream();
  } catch (e) {
    c.err = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError') ? 'Camera permission is off. Allow the camera for this app (phone Settings → Apps → MIHIR Tasks → Permissions → Camera; in Chrome: ⋮ → Settings → Site settings → Camera) — or use the button below.' : 'The camera could not be opened here — use the button below to take the photo with your phone camera.';
    render();
  } finally { attCamStarting = false; }
}
// Put the running camera stream into the <video> that is on screen now (the page re-draws itself often).
function attShowStream() {
  const vv = document.getElementById('att-video'); if (!vv || !attCamStream) return;
  if (vv.srcObject !== attCamStream) { vv.srcObject = attCamStream; vv.play && vv.play().catch(() => {}); }
  const sh = document.querySelector('[data-att-cam="shoot"]'); if (sh) sh.disabled = false;
}
// Frame from the live video → small JPEG with the time and name written on it.
function attGrabFrame() {
  const v = document.getElementById('att-video'); if (!v || !v.videoWidth) return null;
  const w = Math.min(540, v.videoWidth), h = Math.round(v.videoHeight * w / v.videoWidth);
  const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d');
  g.translate(w, 0); g.scale(-1, 1); g.drawImage(v, 0, 0, w, h); g.setTransform(1, 0, 0, 1, 0, 0);
  const fs = Math.max(12, Math.round(w / 30)), pad = Math.round(fs * 0.6), bandH = fs + pad * 2;
  g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillRect(0, h - bandH, w, bandH);
  g.fillStyle = '#fff'; g.font = `600 ${fs}px sans-serif`; g.textBaseline = 'middle';
  g.fillText(`${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })} · ${session.name}`, pad, h - bandH / 2, w - pad * 2);
  return c.toDataURL('image/jpeg', 0.65);
}
function payslipModalHTML() {
  const sl = (ui.att || {}).slip; if (!sl) return '';
  if (sl.loading) return '<div class="att-modal"><div class="att-modal-box">Loading…</div></div>';
  if (sl.error) return `<div class="att-modal" data-slip-close><div class="att-modal-box"><div class="err">${attEsc(sl.error)}</div><button class="btn btn-sm" data-slip-close>Close</button></div></div>`;
  return `<div class="att-modal"><div class="att-modal-box payslip" id="payslip-box">${payslipBodyHTML(sl.data.line, sl.data.username, sl.data.label, true)}</div></div>`;
}
function payslipBodyHTML(l, u, label, buttons) {
  const row = (k, v) => v ? `<tr><td>${k}</td><td class="num">${inr(v)}</td></tr>` : '';
  return `
    <div class="flex-between"><div><div class="payslip-co">MIHIR GROUP</div><div class="small muted">Payslip · ${attEsc(label)}</div></div>${buttons ? '<div class="noprint" style="display:flex;gap:6px;"><button class="btn btn-sm" data-slip-print>🖨 Print / PDF</button><button class="btn btn-sm" data-slip-close>Close</button></div>' : ''}</div>
    <div class="payslip-grid">
      <div><span>Employee</span><b>${attEsc(l.name)}</b></div><div><span>Code</span><b>${attEsc(l.employee_code || u)}</b></div><div><span>Department</span><b>${attEsc(l.team || '—')}</b></div>
      <div><span>Days in month</span><b>${l.daysInMonth}</b></div><div><span>Paid days</span><b>${l.paidDays}</b></div><div><span>Loss of pay days</span><b>${l.lopDays}</b></div>
      ${l.pan ? `<div><span>PAN</span><b>${attEsc(l.pan)}</b></div>` : ''}${l.uan ? `<div><span>UAN</span><b>${attEsc(l.uan)}</b></div>` : ''}${l.bank && l.bank.account_no ? `<div><span>Bank</span><b>${attEsc(l.bank.bank_name || '')} ••${attEsc(String(l.bank.account_no).slice(-4))}</b></div>` : ''}
    </div>
    ${l.counts ? `<div class="payslip-att"><b>Attendance</b> ${[['Present', (l.counts.P || 0)], ['Half days', l.counts.H], ['Absent', l.counts.A], ['Paid leave', (l.counts.L || 0) + (l.counts.LH || 0)], ['Unpaid leave', l.counts.U], ['Weekly offs', l.counts.WO], ['Holidays', l.counts.HO]].filter(([, v]) => v).map(([k, v]) => `<span>${k} <b>${v}</b></span>`).join('')}${l.lateMarks ? `<span>Late marks <b>${l.lateMarks}</b>${l.lateCutDays ? ` (−${l.lateCutDays} day)` : ''}</span>` : ''}${l.otHours ? `<span>Overtime <b>${l.otHours} h</b></span>` : ''}${l.overBreakMin ? `<span>Break over allowance <b>${Math.round(l.overBreakMin / 6) / 10} h</b></span>` : ''}</div>` : ''}
    <div class="payslip-cols">
      <table><thead><tr><th>Earnings</th><th class="num">Amount</th></tr></thead><tbody>
        ${row('Basic', l.earned.basic)}${row('HRA', l.earned.hra)}${row('Conveyance', l.earned.conveyance)}${row('Special allowance', l.earned.special)}
        ${l.otPay ? `<tr><td>Overtime (${l.otHours} h × ${inr(l.otRate)})</td><td class="num">${inr(l.otPay)}</td></tr>` : ''}${l.otherEarn ? `<tr><td>${attEsc(l.otherEarnNote || 'Other')}</td><td class="num">${inr(l.otherEarn)}</td></tr>` : ''}
        <tr class="tot"><td>Total earnings</td><td class="num">${inr(l.totalEarn)}</td></tr></tbody></table>
      <table><thead><tr><th>Deductions</th><th class="num">Amount</th></tr></thead><tbody>
        ${row('Provident Fund', l.pf)}${row('ESI', l.esi)}${row('Professional Tax', l.pt)}${row('Advance recovery', l.advance)}${l.otherDed ? `<tr><td>${attEsc(l.otherDedNote || 'Other')}</td><td class="num">${inr(l.otherDed)}</td></tr>` : ''}
        <tr class="tot"><td>Total deductions</td><td class="num">${inr(l.totalDed)}</td></tr></tbody></table>
    </div>
    <div class="payslip-net">Net pay <b>${inr(l.net)}</b></div>
    ${l.employerPf != null && (l.employerPf || l.employerEsi) ? `<div class="small muted">Employer contribution (not deducted): PF ${inr(l.employerPf)}${l.employerEsi ? ` · ESI ${inr(l.employerEsi)}` : ''}</div>` : ''}
    <div class="small muted" style="margin-top:6px;">Computer-generated payslip.</div>`;
}
// Every payslip of the month, one per page, in a new window → Print / Save as PDF.
function printAllPayslips(r) {
  if (!r || !(r.slips || []).length) { setBanner('No payslips for this month.'); render(); return; }
  const css = [...document.querySelectorAll('style')].map(x => x.outerHTML).join('') + [...document.querySelectorAll('link[rel="stylesheet"]')].map(l => `<link rel="stylesheet" href="${l.href}">`).join('');
  const w = window.open('', '_blank'); if (!w) { setBanner('Allow pop-ups to print the payslips.'); render(); return; }
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Payslips ${attEsc(r.label)}</title>${css}<style>body{background:#fff;padding:0;margin:0}.slip-page{padding:24px;page-break-after:always;max-width:760px;margin:0 auto}.slip-page:last-child{page-break-after:auto}</style></head><body>
    ${r.slips.map(x => `<div class="slip-page payslip">${payslipBodyHTML(x.line, x.username, r.label, false)}</div>`).join('')}</body></html>`);
  w.document.close(); setTimeout(() => { try { w.focus(); w.print(); } catch (e) {} }, 500);
}
function openPayslip(period, username) {
  const s = attState(); s.slip = { loading: true }; render();
  api(`/api/payslips/${period}/${encodeURIComponent(username)}`).then(d => { s.slip = { data: d }; render(); }).catch(e => { s.slip = { error: e.message }; render(); });
}
function printPayslip() {
  const box = document.getElementById('payslip-box'); if (!box) return;
  const css = [...document.querySelectorAll('style')].map(s => s.outerHTML).join('') + [...document.querySelectorAll('link[rel="stylesheet"]')].map(l => `<link rel="stylesheet" href="${l.href}">`).join('');
  const w = window.open('', '_blank'); if (!w) { setBanner('Allow pop-ups to print the payslip.'); render(); return; }
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Payslip</title>${css}<style>body{background:#fff;padding:24px}.noprint{display:none!important}.att-modal-box{box-shadow:none;max-width:none}</style></head><body>${box.outerHTML}</body></html>`);
  w.document.close(); setTimeout(() => { try { w.focus(); w.print(); } catch (e) {} }, 400);
}
function bindPayslipModal() {
  document.querySelectorAll('[data-slip]').forEach(b => b.onclick = () => { const [p, u] = b.dataset.slip.split(':'); openPayslip(p, u); });
  document.querySelectorAll('[data-slip-close]').forEach(b => b.onclick = (e) => { if (e.target !== b && b.classList.contains('att-modal')) return; attState().slip = null; render(); });
  const pr = document.querySelector('[data-slip-print]'); if (pr) pr.onclick = printPayslip;
}
// Punch / camera / break / work-session buttons — shared by My Attendance and the front page.
function attBindPunch() {
  const s = attState();
  if (!document.querySelector('[data-att-act]') && !document.getElementById('att-video')) return;
  // the page re-draws often: keep the running camera on screen
  if (s.cam && attCamStream) attShowStream(); else if (s.cam && !s.cam.err && document.getElementById('att-video')) setTimeout(attStartCamera, 30);
  const noteEl = document.getElementById('att-note');
  if (noteEl) noteEl.oninput = () => { s.note = noteEl.value; };
  const finish = async (which, geo, r) => {
    const where = r.place ? ` at ${r.place}` : r.away ? ` — not at a site${r.nearest ? ` (${r.nearest.metres} m from ${r.nearest.name})` : ''}` : '';
    s.punch = { done: `${r.resumed ? 'Checked in again' : which === 'in' ? 'Checked in' : 'Checked out'} at ${r.at}${where}${r.late ? ' — marked late' : ''}.${geo && geo.error ? ` Location not saved (${geo.error}).` : ''}` };
    s.note = '';
    if (typeof attSummary !== 'undefined') attSummary = { ...attSummary, [which === 'in' ? 'checkedIn' : 'checkedOut']: true };
    await attLoad(true);
  };
  const doPunch = async (photo) => {
    const which = attWhich();
    s.punch = { busy: true, msg: 'Getting your location…' }; render();
    // Location is noted, never required: wait for a good fix only briefly.
    const geo = await attGeo((acc) => { if (s.punch && s.punch.busy) { s.punch.msg = `Getting your location… ±${acc} m`; const b = document.querySelector('[data-att-act="punch"]'); if (b) b.textContent = '⏳ ' + s.punch.msg; } });
    s.punch.msg = 'Saving…'; render();
    try {
      const r = await api(`/api/attendance/check-${which}`, { method: 'POST', body: JSON.stringify({ ...(geo && !geo.error ? geo : {}), photo: which === 'in' ? photo : undefined, note: s.note || '' }) });
      await finish(which, geo, r);
    } catch (e) { s.punch = { err: e.message + (geo && geo.error ? ` (${geo.error})` : '') }; render(); }
  };
  document.querySelectorAll('[data-att-act="punch"]').forEach(b => b.onclick = () => {
    const which = attWhich();
    if (which === 'out' || !(attMe && attMe.rules && attMe.rules.selfieRequired)) { doPunch(null); return; }   // the live photo is for check-in only
    s.punch = null; s.cam = { which }; render(); setTimeout(attStartCamera, 30);
  });
  document.querySelectorAll('[data-att-cam]').forEach(b => b.onclick = () => {
    if (b.dataset.attCam === 'cancel') { attStopCamera(); s.cam = null; render(); return; }
    const photo = attGrabFrame();
    if (!photo) { s.cam.err = null; const c = s.cam; c.err = 'The camera is not ready yet — wait a second and tap Take photo again, or use the button below.'; render(); return; }
    attStopCamera(); s.cam = null; doPunch(photo);
  });
  document.querySelectorAll('[data-att-cam-file]').forEach(inp => inp.onchange = async () => {
    const f = inp.files && inp.files[0]; if (!f) return;
    const photo = await attSmallJpeg(f);
    if (!photo) { s.cam.err = 'That photo could not be read — take it again.'; render(); return; }
    attStopCamera(); s.cam = null; doPunch(photo);
  });
  document.querySelectorAll('[data-att-act="loc-on"]').forEach(b => b.onclick = async () => {
    const L = window.LocationUI && LocationUI.attendanceStatus ? LocationUI.attendanceStatus() : {};
    if (!L.consent) { ui.adminTab = 'mytracking'; window.scrollTo(0, 0); render(); return; } // consent first, on My Location
    await LocationUI.startWork(); render();
  });
  const brk = async (which) => {
    s.punch = { busy: true, msg: which === 'end' ? 'Saving…' : 'Starting break…' }; render();
    const geo = which === 'end' ? await attGeo() : null;
    try {
      const r = await api(`/api/attendance/break-${which}`, { method: 'POST', body: JSON.stringify(geo && !geo.error ? geo : {}) });
      s.punch = { done: which === 'start' ? `Break started at ${r.at}. Be back by ${r.backBy} (${r.leftMin} min) and tap “Back from break” — you will get a reminder before it ends.` : `Back at ${r.at}${r.place ? ` (${r.place})` : ''}. Break today: ${r.usedMin} of ${r.allowanceMin} min.` };
      await attLoad(true);
    } catch (e) { s.punch = { err: e.message + (geo && geo.error ? ` (${geo.error})` : '') }; render(); }
  };
  document.querySelectorAll('[data-att-act="break-start"]').forEach(b => b.onclick = () => brk('start'));
  document.querySelectorAll('[data-att-act="break-end"]').forEach(b => b.onclick = () => brk('end'));
}
// Count the break time down on screen.
setInterval(() => {
  const el = document.getElementById('att-break-left'); if (!el || !el.dataset.backBy) return;
  const m = Math.max(0, Math.ceil((Date.parse(el.dataset.backBy) - Date.now()) / 60000));
  el.textContent = `${m} min left`;
}, 15000);
function bindAttendanceView() {
  const s = attState();
  bindPayslipModal();
  document.querySelectorAll('[data-att-month]').forEach(b => b.onclick = () => { const n = Number(b.dataset.attMonth); s.month = n === 0 ? attMonthNow() : attShiftMonth(s.month, n); render(); attLoad(true); });
  attBindPunch();
  const act = (n, fn) => document.querySelectorAll(`[data-att-act="${n}"]`).forEach(b => b.onclick = fn);
  act('leave-new', () => { s.leaveForm = { from: attToday(), to: '', kind: 'paid', half: false, reason: '' }; render(); });
  act('leave-cancel-form', () => { s.leaveForm = null; render(); });
  const lf = s.leaveForm;
  if (lf) {
    const bindV = (id, k, ev = 'oninput') => { const el = document.getElementById(id); if (el) el[ev] = () => { lf[k] = el.type === 'checkbox' ? el.checked : el.value; if (k === 'half') render(); }; };
    bindV('lv-from', 'from', 'onchange'); bindV('lv-to', 'to', 'onchange'); bindV('lv-kind', 'kind', 'onchange'); bindV('lv-half', 'half', 'onchange'); bindV('lv-reason', 'reason');
    act('leave-send', async () => {
      try { const r = await api('/api/leave', { method: 'POST', body: JSON.stringify({ from: lf.from, to: lf.half ? lf.from : (lf.to || lf.from), kind: lf.kind, halfDay: lf.half, reason: lf.reason }) });
        s.leaveForm = null; setBanner(`Leave asked — ${r.days} day${r.days === 1 ? '' : 's'}. HR will decide.`, 'ok'); await attLoad(true); }
      catch (e) { lf.err = e.message; render(); }
    });
  }
  document.querySelectorAll('[data-leave-cancel]').forEach(b => b.onclick = async () => {
    try { await api(`/api/leave/${b.dataset.leaveCancel}/cancel`, { method: 'POST' }); setBanner('Leave withdrawn.', 'ok'); await attLoad(true); } catch (e) { setBanner(e.message); render(); }
  });
}

// ---------- HR & Payroll
async function hrLoad(tab, force) {
  const s = hrState();
  if (!s.tlFrom) { s.tlFrom = attToday(); s.tlTo = attToday(); }
  const url = { today: `/api/attendance/today?day=${s.day}`, timelog: `/api/attendance/timelog?from=${s.tlFrom}&to=${s.tlTo}`, register: `/api/attendance/register?month=${s.month}`, leave: '/api/leave', salaries: '/api/payroll/salaries', advances: '/api/payroll/advances',
    payroll: `/api/payroll/runs/${s.payMonth}`, rules: `/api/payroll/settings?year=${s.month.slice(0, 4)}` }[tab];
  if (!url) return;
  const cur = hrData[tab];
  if (!force && cur && cur.key === url) return;
  if (cur && cur.loading === url) return;
  hrData[tab] = { ...(cur || {}), loading: url };
  try { hrData[tab] = { key: url, data: await api(url) }; } catch (e) { hrData[tab] = { key: url, error: e.message }; }
  if (ui.adminTab === 'payroll') render();
}
function hrNeed(tab) { setTimeout(() => hrLoad(tab), 0); const d = hrData[tab]; return d && (d.data || d.error) ? d : null; }
function hrTextFilter(list, text) {
  const words = String(hrState().q || '').toLowerCase().split(/\s+/).filter(Boolean);
  return words.length ? list.filter(r => { const t = String(text(r) || '').toLowerCase(); return words.every(w => t.includes(w)); }) : list;
}
function hrPeopleFilter(list) {
  const words = String(hrState().q || '').toLowerCase().split(/\s+/).filter(Boolean);
  return words.length ? list.filter(p => words.every(w => `${p.name} ${p.username} ${p.team || ''}`.toLowerCase().includes(w))) : list;
}
// ---- Time log: every check-in → check-out pair with timestamps, its length, and the day's totals ----
const tlDur = (m) => m == null ? '—' : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
const TL_HOW = { auto: '🛰', phone: '📱', hr: '✅', corrected: '✏️', break: '☕' };
const TL_HOW_TXT = { auto: 'automatic (arrived at / left a site)', phone: 'tapped on the phone', hr: 'accepted by HR', corrected: 'corrected by HR', break: 'break' };
function tlAddDays(d, n) { return new Date(Date.parse(`${d}T12:00:00+05:30`) + n * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); }
function hrTimeLogHTML() {
  const s = hrState(); const d = hrNeed('timelog'); const l = hrLoadingHTML(d);
  const t = attToday(), monday = tlAddDays(t, -((new Date(`${t}T12:00:00+05:30`).getDay() + 6) % 7));
  const quick = [['Today', t, t], ['Yesterday', tlAddDays(t, -1), tlAddDays(t, -1)], ['This week', monday, t], ['This month', `${t.slice(0, 8)}01`, t]];
  const head = `<div class="card"><div class="flex-between" style="gap:8px;flex-wrap:wrap;align-items:flex-end;">
      <div><div class="card-title" style="margin:0;">Time log</div><div class="small muted">Every check-in and check-out with its time, how long each lasted, and the total.</div></div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:flex-end;">
        ${quick.map(([lbl, f, to]) => `<button type="button" class="btn btn-sm ${s.tlFrom === f && s.tlTo === to ? 'btn-primary' : ''}" data-tl-range="${f}|${to}">${lbl}</button>`).join('')}
        <label class="small">From<input type="date" id="tl-from" value="${attEsc(s.tlFrom)}" max="${t}" style="width:auto;margin:0;"></label>
        <label class="small">To<input type="date" id="tl-to" value="${attEsc(s.tlTo)}" max="${t}" style="width:auto;margin:0;"></label>
        ${d && d.data && d.data.list.length ? '<button type="button" class="btn btn-sm" data-tl-csv>⬇ Excel (CSV)</button>' : ''}
      </div></div>
      <div class="small muted" style="margin-top:6px;">${Object.entries(TL_HOW).map(([k, v]) => `${v} ${TL_HOW_TXT[k]}`).join(' · ')}</div></div>`;
  if (l) return head + l;
  const x = d.data;
  const rows = hrTextFilter(x.list, r => `${r.name} ${r.username} ${r.team}`);
  const people = hrTextFilter(x.people, r => `${r.name} ${r.username} ${r.team}`);
  const pairHTML = (p) => `<div class="tl-pair${p.open ? ' open' : ''}"><span class="mono" title="${attEsc(TL_HOW_TXT[p.inHow] || '')}">${TL_HOW[p.inHow] || ''} ${attEsc(p.in)}</span> → <span class="mono" title="${attEsc(TL_HOW_TXT[p.outHow] || '')}">${p.open ? '<i>still in</i>' : `${TL_HOW[p.outHow] || ''} ${attEsc(p.out)}`}</span> <b>${tlDur(p.min)}</b>${p.inPlace || p.outPlace ? `<span class="small muted"> · ${attEsc([p.inPlace, p.outPlace && p.outPlace !== p.inPlace ? p.outPlace : ''].filter(Boolean).join(' → '))}</span>` : ''}</div>`;
  const gapHTML = (g) => `<div class="tl-gap small">${g.kind === 'break' ? '☕ break' : '↩ out'} ${attEsc(g.from)}–${attEsc(g.to || 'now')} · ${tlDur(g.min)}</div>`;
  const multi = x.from !== x.to;
  return head + `${multi && people.length ? `<div class="card"><div class="card-title">Totals ${attEsc(attDayLabel(x.from))} – ${attEsc(attDayLabel(x.to))}</div><div class="dpr-table-wrap"><table class="dpr-table"><thead><tr><th>Person</th><th class="num">Days</th><th class="num">Check-ins</th><th class="num">Total checked in</th><th class="num">Counted for pay</th></tr></thead><tbody>
      ${people.map(p => `<tr><td><b>${attEsc(p.name)}</b><div class="small muted">${attEsc(p.username)}${p.team ? ` · ${attEsc(p.team)}` : ''}</div></td><td class="num">${p.days}</td><td class="num">${p.pairs}</td><td class="num"><b>${tlDur(p.checkedInMin)}</b></td><td class="num">${tlDur(p.workedMin)}</td></tr>`).join('')}</tbody></table></div></div>` : ''}
    <div class="card">${rows.length ? `<div class="dpr-table-wrap"><table class="dpr-table tl-table"><thead><tr><th>Person</th>${multi ? '<th>Day</th>' : ''}<th>Each check-in → check-out</th><th class="num">Total checked in</th><th class="num">Out / break</th><th class="num">First in – last out</th><th class="num">Counted for pay</th></tr></thead><tbody>
      ${rows.map(r => `<tr><td><b>${attEsc(r.name)}</b><div class="small muted">${attEsc(r.username)}${r.team ? ` · ${attEsc(r.team)}` : ''}</div>${r.status ? `<span class="att-chip st-${attEsc(r.status)}">${attEsc(ATT_LABEL[r.status] || r.status)}</span>` : ''}</td>
        ${multi ? `<td class="small">${attEsc(attDayLabel(r.day))}</td>` : ''}
        <td>${r.pairs.map((p, i) => pairHTML(p) + (r.gaps[i] && i < r.pairs.length - 1 ? gapHTML(r.gaps[i]) : '')).join('')}</td>
        <td class="num"><b>${tlDur(r.checkedInMin)}</b><div class="small muted">${r.pairs.length} check-in${r.pairs.length === 1 ? '' : 's'}</div></td>
        <td class="num small">${r.outMin ? `out ${tlDur(r.outMin)}` : ''}${r.outMin && r.breakMin ? '<br>' : ''}${r.breakMin ? `☕ ${tlDur(r.breakMin)}` : ''}${!r.outMin && !r.breakMin ? '—' : ''}</td>
        <td class="num small mono">${attEsc(r.firstIn)} – ${attEsc(r.lastOut || 'in')}<div class="muted">${tlDur(r.spanMin)}</div></td>
        <td class="num">${tlDur(r.workedMin)}</td></tr>`).join('')}</tbody></table></div>` : `<div class="empty">${x.list.length ? 'No one matches the search.' : 'No check-ins in these dates.'}</div>`}</div>`;
}
function hrTimeLogCsv() {
  const d = hrData.timelog; if (!d || !d.data) return;
  const x = d.data; const rows = hrTextFilter(x.list, r => `${r.name} ${r.username} ${r.team}`);
  const q = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const out = [['Date', 'Name', 'Username', 'Department', 'Check-in #', 'Check-in', 'How in', 'Place in', 'Check-out', 'How out', 'Place out', 'Minutes', 'Duration', 'Day total checked in', 'Day counted for pay'].map(q).join(',')];
  for (const r of rows) r.pairs.forEach((p, i) => out.push([r.day, r.name, r.username, r.team, i + 1, p.in, TL_HOW_TXT[p.inHow] || '', p.inPlace, p.open ? '' : p.out, p.open ? 'still in' : (TL_HOW_TXT[p.outHow] || ''), p.outPlace, p.min, tlDur(p.min), tlDur(r.checkedInMin), tlDur(r.workedMin)].map(q).join(',')));
  const blob = new Blob(['\ufeff' + out.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `time-log_${x.from}_to_${x.to}.csv`; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
function renderHrPayrollView() {
  const s = hrState(); const S = attSummary || {};
  const tabs = HR_TABS.filter(([k]) => ['salaries', 'advances', 'payroll'].includes(k) ? S.canSeePayroll : S.canSeeAttendance);
  if (!tabs.some(([k]) => k === s.tab)) s.tab = tabs[0] ? tabs[0][0] : 'today';
  const badge = { leave: (S.pendingLeave || []).length, payroll: (S.payrollToApprove || []).length + (S.payrollToPay || []).length };
  let body = '';
  try { body = ({ today: hrTodayHTML, timelog: hrTimeLogHTML, register: hrRegisterHTML, leave: hrLeaveHTML, salaries: hrSalariesHTML, advances: hrAdvancesHTML, payroll: hrPayrollHTML, rules: hrRulesHTML }[s.tab] || (() => ''))(); }
  catch (e) { body = `<div class="err">${attEsc(e.message)}</div>`; }
  return `<div class="card"><div class="card-title" style="margin:0;">HR & Payroll</div>
    <div class="dpr-tabs">${tabs.map(([k, l]) => `<button type="button" class="${s.tab === k ? 'on' : ''}" data-hr-tab="${k}">${l}${badge[k] ? ` <span class="badge flag">${badge[k]}</span>` : ''}</button>`).join('')}</div>
    ${s.tab === 'rules' ? '' : `<div style="margin-top:8px;">${hrSearchHTML(HR_SEARCH_PH[s.tab])}</div>`}</div>
    ${body}${payslipModalHTML()}`;
}
const hrLoadingHTML = (d) => !d ? '<div class="card"><div class="empty">Loading…</div></div>' : d.error ? `<div class="card"><div class="err">${attEsc(d.error)}</div></div>` : null;
const HR_SEARCH_PH = { today: 'Search name, username or department…', timelog: 'Search name, username or department…', register: 'Search name, username or department…', leave: 'Search leave by name, type or reason…', salaries: 'Search name, username or department…', advances: 'Search advances by name or note…', payroll: 'Search name, username or department…' };
function hrSearchHTML(ph) { return `<input type="search" id="hr-q" value="${attEsc(hrState().q)}" placeholder="🔍 ${attEsc(ph || 'Search name, username or department…')}" autocomplete="off" data-no-spell style="margin:0 0 8px;">`; }
// Today's chips are filters: tap one to list only those people, tap again (or "show everyone") for all.
const HR_TODAY_FILTERS = [
  ['all', 'Everyone', '', () => true],
  ['in', 'Checked in', 'st-P', p => !!p.in],
  ['notIn', 'Not in', 'st-A', p => !p.in && !['WO', 'HO', 'L', 'U'].includes(p.status)],
  ['late', 'Late', '', p => !!p.late],
  ['away', 'Not at a site', '', p => (p.flags || []).includes('not at a site')],
  ['onLeave', 'On leave', 'st-L', p => ['L', 'U', 'LH'].includes(p.status)],
];
function hrTodayHTML() {
  const s = hrState(); const d = hrNeed('today'); const l = hrLoadingHTML(d); if (l) return l;
  const x = d.data; const t = x.totals;
  const tf = (HR_TODAY_FILTERS.find(f => f[0] === s.todayFilter) || HR_TODAY_FILTERS[0])[3];
  const list = hrPeopleFilter(x.list).filter(tf);
  return `<div class="card">
    <div class="flex-between" style="gap:8px;flex-wrap:wrap;"><div class="card-title" style="margin:0;">${attEsc(attDayLabel(x.day))}</div><input type="date" id="hr-day" value="${attEsc(s.day)}" max="${attToday()}" style="width:auto;margin:0;"></div>
    <div class="att-chips">${HR_TODAY_FILTERS.map(([k, label, cls]) => `<button type="button" class="att-chip ${cls} att-chip-btn ${s.todayFilter === k ? 'on' : ''}" data-hr-tf="${k}" title="${s.todayFilter === k ? 'Show everyone' : `Show only: ${label}`}">${label} <b>${t[k] != null ? t[k] : x.list.length}</b></button>`).join('')}</div>
    ${s.todayFilter && s.todayFilter !== 'all' ? `<div class="small muted" style="margin:4px 0;">Showing <b>${attEsc((HR_TODAY_FILTERS.find(f => f[0] === s.todayFilter) || [])[1] || '')}</b> only · <a href="#" data-hr-tf="all">show everyone</a></div>` : ''}
    ${hrAttemptsHTML(x)}
    <div class="dpr-table-wrap"><table class="dpr-table"><thead><tr><th>Person</th><th>Status</th><th>In</th><th>Out</th><th>Hours</th><th>Break / away</th><th>Where</th><th>How</th></tr></thead><tbody>
    ${list.map(p => `<tr><td><b>${attEsc(p.name)}</b><div class="small muted">${attEsc(p.username)} · ${attEsc(p.team)}</div></td>
      <td><span class="att-chip st-${p.status}">${attEsc(ATT_LABEL[p.status] || p.status)}</span>${p.late ? ` <span class="small dlv-warn-text">late ${p.late} min</span>` : ''}</td>
      <td class="mono">${attEsc(p.in || '—')}</td><td class="mono">${attEsc(p.out || '—')}</td><td>${p.worked != null ? `${Math.floor(p.worked / 60)}h ${p.worked % 60}m` : ''}</td>
      <td class="small">${p.breakMin ? `☕ ${p.breakMin} min` : ''}${p.awayMin ? ` · away ${p.awayMin} min` : ''}${p.overBreak ? ` <span class="dlv-warn-text">(${p.overBreak} over)</span>` : ''}</td>
      <td class="small">${attEsc(p.inPlace || '')}${p.flags.includes('not at a site') ? ' <span class="dlv-warn-text">⚠ not at a site</span>' : ''}${p.flags.includes('from tracking') ? ' <span class="muted">from tracking</span>' : ''}</td>
      <td class="small">${p.inHow ? `In: ${p.inHow === 'auto' ? '🛰 auto' : p.inHow === 'phone' ? `📍 GPS${p.inAcc != null ? ` ±${p.inAcc} m` : ''}` : p.inHow === 'hr' ? '✅ accepted by HR' : '✏️ HR'}` : ''}${p.outHow ? `<br>Out: ${p.outHow === 'auto' ? '🛰 auto' : p.outHow === 'phone' ? `📍 GPS${p.outAcc != null ? ` ±${p.outAcc} m` : ''}` : p.outHow === 'hr' ? '✅ accepted by HR' : '✏️ HR'}` : ''}${p.hasInPhoto || p.hasOutPhoto ? `<div style="margin-top:4px;display:flex;gap:4px;">${p.hasInPhoto ? `<button class="btn btn-sm" data-hr-photo="${attEsc(p.username)}|${attEsc(x.day)}|in">📷 In</button>` : ''}${p.hasOutPhoto ? `<button class="btn btn-sm" data-hr-photo="${attEsc(p.username)}|${attEsc(x.day)}|out">📷 Out</button>` : ''}</div>` : ''}</td></tr>`).join('')}
    </tbody></table></div></div>
    ${ui.hrPhoto ? `<div class="att-modal" data-hr-photo-close><div class="att-modal-box" style="max-width:420px;text-align:center;"><img src="${ui.hrPhoto}" alt="Selfie" style="max-width:100%;border-radius:10px;"><div style="margin-top:8px;"><button class="btn btn-sm" data-hr-photo-close>Close</button></div></div></div>` : ''}`;
}
// Refused check-ins / outs today: one row per person and action (latest attempt), why, where, photo; HR accepts.
function hrAttemptsHTML(x) {
  const all = x.attempts || [];
  if (!all.length) return '';
  // one row per person and action: the FIRST try that has a photo (accepting it marks the time they first tried)
  const seen = new Set(); const rows = [];
  for (const a of all) {
    const k = `${a.username}|${a.action}`; if (seen.has(k)) continue; seen.add(k);
    const mine = all.filter(b => b.username === a.username && b.action === a.action);
    const pick = mine.slice().reverse().find(b => b.has_photo && b.lat != null) || a;
    rows.push({ ...pick, reason: a.reason, tries: mine.length });
  }
  const open = rows.filter(a => !a.done && a.status === 'open');
  return `<details class="att-attempts" ${open.length ? 'open' : ''}><summary><b>⚠ Could not check in / out</b> <span class="badge ${open.length ? 'flag' : ''}">${open.length}</span> <span class="small muted">— refused by the app (weak GPS, outside a site, no photo). When someone tells you they were on site, check the photo and the map, then accept or deny.</span></summary>
    <div class="dpr-table-wrap"><table class="dpr-table"><thead><tr><th>Person</th><th>Tried</th><th>Why it was refused</th><th>Where</th><th></th></tr></thead><tbody>
    ${rows.map(a => `<tr><td><b>${attEsc(a.name || a.username)}</b><div class="small muted">${attEsc(a.username)}${a.team ? ` · ${attEsc(a.team)}` : ''}</div></td>
      <td class="small">${a.action === 'in' ? 'Check-in' : 'Check-out'} <span class="mono">${attEsc(a.at_hm)}</span>${a.tries > 1 ? `<div class="muted">${a.tries} tries</div>` : ''}</td>
      <td class="small">${attEsc(a.reason)}</td>
      <td class="small">${a.acc != null ? `GPS ±${a.acc} m` : 'No location'}${a.nearest ? `<div>${a.nearest_m != null ? `${a.nearest_m >= 1000 ? `${(a.nearest_m / 1000).toFixed(1)} km` : `${a.nearest_m} m`} from ` : ''}${attEsc(a.nearest)}</div>` : ''}${a.map ? `<a href="${attEsc(a.map)}" target="_blank" rel="noopener">🗺 Google Maps</a>` : ''}</td>
      <td class="small" style="white-space:nowrap;">${a.has_photo ? `<button class="btn btn-sm" data-hr-att-photo="${a.id}">📷 Photo</button> ` : ''}
        ${a.done ? `<span class="muted">${a.status === 'accepted' ? '✅ accepted' : '✓ done later'}</span>` : a.status === 'denied' || a.status === 'dismissed' ? '<span class="muted">✖ denied</span>'
          : x.canAccept ? `<button class="btn btn-primary btn-sm" data-hr-att-dec="${a.id}|accept">Accept ${attEsc(a.at_hm)}</button> <button class="btn btn-sm" data-hr-att-dec="${a.id}|deny">Deny</button>` : ''}</td></tr>`).join('')}
    </tbody></table></div></details>`;
}
function hrRegisterHTML() {
  const s = hrState(); const d = hrNeed('register'); const l = hrLoadingHTML(d); if (l) return l;
  const x = d.data; const e = s.edit;
  const people = hrPeopleFilter(x.people);
  return `<div class="card">
    <div class="flex-between" style="gap:8px;flex-wrap:wrap;"><div class="card-title" style="margin:0;">Register · ${attEsc(x.label)}</div>
      <div style="display:flex;gap:6px;"><button class="btn btn-sm" data-hr-month="-1">‹</button><button class="btn btn-sm" data-hr-month="1" ${s.month >= attMonthNow() ? 'disabled' : ''}>›</button></div></div>
    <div class="small muted" style="margin-bottom:6px;">${x.canEdit ? 'Tap a day to correct it.' : ''} P present · ½ half · A absent · L paid leave · U unpaid · WO weekly off · HO holiday · red dot late · 📍 not at a site · ✎ corrected</div>
    ${e ? `<div class="att-form"><b>${attEsc(e.name)} · ${attEsc(attDayLabel(e.day))}</b> <span class="small muted">now: ${attEsc(ATT_LABEL[e.cur.status] || '')}${e.cur.in ? ` · in ${e.cur.in}` : ''}${e.cur.out ? ` · out ${e.cur.out}` : ''}${e.cur.note ? ` · “${attEsc(e.cur.note)}”` : ''}</span>
      <div class="row"><div class="col"><label>Set as</label><select id="hre-status"><option value="">Work it out from in / out</option>${['P', 'H', 'A', 'L', 'U', 'WO', 'HO'].map(k => `<option value="${k}" ${e.status === k ? 'selected' : ''}>${ATT_LABEL[k]}</option>`).join('')}</select></div>
        <div class="col"><label>In</label><input type="time" id="hre-in" value="${attEsc(e.in || '')}"></div><div class="col"><label>Out</label><input type="time" id="hre-out" value="${attEsc(e.out || '')}"></div>
        <div class="col"><label>OT minutes</label><input type="number" id="hre-ot" min="0" value="${attEsc(e.ot == null ? '' : e.ot)}" placeholder="auto"></div></div>
      <label>Reason *</label><input type="text" id="hre-reason" value="${attEsc(e.reason || '')}" placeholder="e.g. Phone dead — confirmed by site in-charge">
      ${e.err ? `<div class="err">${attEsc(e.err)}</div>` : ''}
      <div style="margin-top:8px;display:flex;gap:8px;"><button class="btn btn-primary btn-sm" data-hr-act="edit-save">Save</button><button class="btn btn-sm" data-hr-act="edit-cancel">Cancel</button></div></div>` : ''}
    <div class="att-reg-wrap"><table class="att-reg"><thead><tr><th class="att-reg-name">Person</th>${x.days.map(dd => { const w = new Date(`${dd}T12:00:00Z`).getUTCDay(); return `<th class="${(x.weeklyOff || []).includes(w) || x.holidays[dd] ? 'off' : ''}" title="${attEsc(x.holidays[dd] || WEEKDAYS[w])}">${Number(dd.slice(8))}<br><span>${WEEKDAYS[w][0]}</span></th>`; }).join('')}<th>Paid</th><th>LOP</th><th>Late</th><th>OT h</th></tr></thead>
    <tbody>${people.map(p => `<tr><td class="att-reg-name"><b>${attEsc(p.name)}</b><div class="small muted">${attEsc(p.team)}</div></td>
      ${p.days.map(dd => `<td class="st-${dd.status}${x.canEdit && dd.status !== 'F' ? ' edit' : ''}" ${x.canEdit && dd.status !== 'F' ? `data-hr-cell="${attEsc(p.username)}|${dd.day}"` : ''} title="${attEsc([ATT_LABEL[dd.status], dd.in && `in ${dd.in}`, dd.out && `out ${dd.out}`, dd.late && `late ${dd.late} min`, ...(dd.flags || []), dd.note].filter(Boolean).join(' · '))}">${ATT_CODE[dd.status]}${dd.late ? '<i class="att-late">●</i>' : ''}${(dd.flags || []).includes('not at a site') ? '<i class="att-away">📍</i>' : ''}${(dd.flags || []).includes('corrected') ? '<i class="att-fix">✎</i>' : ''}</td>`).join('')}
      <td class="num"><b>${p.summary.paidDays}</b></td><td class="num">${p.summary.lopDays - (p.days.filter(dd => dd.status === 'F').length) > 0 ? p.summary.lopDays - p.days.filter(dd => dd.status === 'F').length : 0}</td><td class="num">${p.summary.lateMarks || ''}</td><td class="num">${p.summary.otMinutes ? Math.round(p.summary.otMinutes / 6) / 10 : ''}</td></tr>`).join('')}</tbody></table></div>
  </div>`;
}
function hrLeaveHTML() {
  const d = hrNeed('leave'); const l = hrLoadingHTML(d); if (l) return l;
  const x = d.data; const all = hrTextFilter(x.list, r => `${personName(r.username)} ${r.username} ${r.kind} ${r.reason || ''} ${r.status}`);
  const pend = all.filter(r => r.status === 'pending'), rest = all.filter(r => r.status !== 'pending');
  const row = (r) => `<div class="att-list-row"><div><b>${attEsc(personName(r.username))}</b> · ${r.kind === 'paid' ? 'Paid' : 'Unpaid'} · ${attEsc(attDayLabel(r.from_day))}${r.to_day !== r.from_day ? ` – ${attEsc(attDayLabel(r.to_day))}` : ''}${r.half_day ? ' (half day)' : ''} · ${Number(r.days)} day${Number(r.days) === 1 ? '' : 's'}
      <div class="small muted">${attEsc(r.reason || '')}${r.decision_note ? ` — ${attEsc(r.decided_by_name || '')}: “${attEsc(r.decision_note)}”` : ''}</div></div>
    ${r.status === 'pending' && x.canDecide ? `<div class="leave-dec"><input type="text" id="lvn-${r.id}" placeholder="Note (needed to reject)"><button class="btn btn-sm btn-primary" data-leave-decide="${r.id}|approve">✓ Approve</button><button class="btn btn-sm btn-danger" data-leave-decide="${r.id}|reject">✗ Reject</button></div>` : `<span class="bud-chip ${r.status === 'approved' ? 'good' : r.status === 'rejected' ? 'bad' : r.status === 'pending' ? 'warn' : ''}">${attEsc(r.status)}</span>`}</div>`;
  return `<div class="card"><div class="card-title">Waiting for a decision <span class="badge flag">${pend.length}</span></div>${pend.length ? `<div class="att-list">${pend.map(row).join('')}</div>` : '<div class="small muted">Nothing waiting.</div>'}</div>
    <div class="card"><div class="card-title">Recent (45 days)</div>${rest.length ? `<div class="att-list">${rest.map(row).join('')}</div>` : '<div class="small muted">None.</div>'}</div>`;
}
function hrSalariesHTML() {
  const s = hrState(); const d = hrNeed('salaries'); const l = hrLoadingHTML(d); if (l) return l;
  const x = d.data; const e = s.salEdit;
  const people = hrPeopleFilter(x.people);
  const withSal = x.people.filter(p => p.salary && p.salary.active).length;
  const inp = (k, label, type = 'number', ph = '') => `<div class="col"><label>${label}</label><input type="${type}" data-sal="${k}" value="${attEsc(e[k] == null ? '' : e[k])}" placeholder="${attEsc(ph)}" ${type === 'number' ? 'min="0" step="any"' : ''}></div>`;
  return `<div class="card">
    <div class="flex-between" style="gap:8px;flex-wrap:wrap;"><div><div class="card-title" style="margin:0;">Salaries</div><div class="small muted">${withSal} of ${x.people.length} people are on the payroll. Only people with a salary here are paid.</div></div></div>
    ${e ? `<div class="att-form"><b>${attEsc(e.name)}</b> <span class="small muted">${attEsc(e.username)}</span>
      <div class="row">${inp('basic', 'Basic *')}${inp('hra', 'HRA')}${inp('conveyance', 'Conveyance')}${inp('special', 'Special allowance')}</div>
      <div class="small">Monthly gross: <b>${inr((Number(e.basic) || 0) + (Number(e.hra) || 0) + (Number(e.conveyance) || 0) + (Number(e.special) || 0))}</b></div>
      <div class="row">
        <div class="col"><label>PF</label><select data-sal="pf_applicable"><option value="true" ${e.pf_applicable !== false ? 'selected' : ''}>Deduct PF</option><option value="false" ${e.pf_applicable === false ? 'selected' : ''}>No PF</option></select></div>
        <div class="col"><label>ESI</label><select data-sal="esi_mode"><option value="auto" ${e.esi_mode === 'auto' ? 'selected' : ''}>Auto (within the ESI limit)</option><option value="yes" ${e.esi_mode === 'yes' ? 'selected' : ''}>Always</option><option value="no" ${e.esi_mode === 'no' ? 'selected' : ''}>Never</option></select></div>
        <div class="col"><label>Professional tax</label><select data-sal="pt_slab"><option value="standard" ${e.pt_slab === 'standard' ? 'selected' : ''}>Standard slab</option><option value="women" ${e.pt_slab === 'women' ? 'selected' : ''}>Women's slab</option><option value="exempt" ${e.pt_slab === 'exempt' ? 'selected' : ''}>Exempt</option></select></div>
        ${inp('ot_rate', 'OT rate / hour', 'number', 'auto')}${inp('paid_leave_per_year', 'Paid leave / year', 'number', 'from rules')}</div>
      <div class="row">${inp('employee_code', 'Employee code', 'text')}${inp('joined_on', 'Joined on', 'date')}${inp('pan', 'PAN', 'text')}${inp('uan', 'UAN (PF)', 'text')}${inp('esi_no', 'ESI no.', 'text')}</div>
      <div class="row">${inp('bank_name', 'Bank', 'text')}${inp('account_no', 'Account no.', 'text')}${inp('ifsc', 'IFSC', 'text', 'HDFC0001234')}
        <div class="col"><label>On payroll</label><select data-sal="active"><option value="true" ${e.active !== false ? 'selected' : ''}>Yes</option><option value="false" ${e.active === false ? 'selected' : ''}>No (left / on hold)</option></select></div></div>
      ${e.err ? `<div class="err">${attEsc(e.err)}</div>` : ''}
      <div style="margin-top:8px;display:flex;gap:8px;"><button class="btn btn-primary btn-sm" data-hr-act="sal-save">Save salary</button><button class="btn btn-sm" data-hr-act="sal-cancel">Cancel</button></div></div>` : ''}
    <div class="dpr-table-wrap"><table class="dpr-table"><thead><tr><th>Person</th><th class="num">Gross / month</th><th>PF</th><th>ESI</th><th>PT</th><th>Bank</th><th></th></tr></thead><tbody>
    ${people.map(p => { const sl = p.salary; return `<tr class="${sl && !sl.active ? 'muted' : ''}"><td><b>${attEsc(p.name)}</b><div class="small muted">${attEsc(p.username)} · ${attEsc(p.team)}</div></td>
      <td class="num">${sl ? inr(sl.gross) : '<span class="muted">not set</span>'}</td><td>${sl ? (sl.pf_applicable ? 'Yes' : 'No') : ''}</td><td>${sl ? attEsc(sl.esi_mode) : ''}</td><td>${sl ? attEsc(sl.pt_slab) : ''}</td>
      <td class="small">${sl && sl.account_no ? `${attEsc(sl.bank_name || '')} ••${attEsc(String(sl.account_no).slice(-4))}` : ''}</td>
      <td>${x.canEdit ? `<button class="btn btn-sm" data-sal-edit="${attEsc(p.username)}">${sl ? 'Edit' : '+ Set salary'}</button>` : ''}</td></tr>`; }).join('')}</tbody></table></div></div>`;
}
function hrAdvancesHTML() {
  const s = hrState(); const d = hrNeed('advances'); const l = hrLoadingHTML(d); if (l) return l;
  const x = d.data; const f = s.advForm;
  const advList = hrTextFilter(x.list, a => `${personName(a.username)} ${a.username} ${a.reason || ''} ${a.status || ''}`);
  return `<div class="card"><div class="flex-between" style="gap:8px;flex-wrap:wrap;"><div><div class="card-title" style="margin:0;">Salary advances</div><div class="small muted">Recovered from salary each month, an instalment at a time, when the month is paid.</div></div>${x.canEdit && !f ? '<button class="btn btn-sm btn-primary" data-hr-act="adv-new">+ Advance</button>' : ''}</div>
    ${f ? `<div class="att-form"><div class="row">
      <div class="col"><label>Person *</label><select id="adv-user"><option value="">— pick —</option>${(userDirectory || []).slice().sort((a, b) => a.name.localeCompare(b.name)).map(u => `<option value="${attEsc(u.username)}" ${f.username === u.username ? 'selected' : ''}>${attEsc(u.name)} · ${attEsc(u.username)}</option>`).join('')}</select></div>
      <div class="col"><label>Amount *</label><input type="number" id="adv-amount" min="0" value="${attEsc(f.amount || '')}"></div>
      <div class="col"><label>Per month *</label><input type="number" id="adv-inst" min="0" value="${attEsc(f.instalment || '')}"></div>
      <div class="col"><label>Given on</label><input type="date" id="adv-date" value="${attEsc(f.given_on || attToday())}"></div></div>
      <label>Reason</label><input type="text" id="adv-reason" value="${attEsc(f.reason || '')}">
      ${f.err ? `<div class="err">${attEsc(f.err)}</div>` : ''}
      <div style="margin-top:8px;display:flex;gap:8px;"><button class="btn btn-primary btn-sm" data-hr-act="adv-save">Save</button><button class="btn btn-sm" data-hr-act="adv-cancel">Cancel</button></div></div>` : ''}
    ${advList.length ? `<div class="dpr-table-wrap"><table class="dpr-table"><thead><tr><th>Person</th><th>Given</th><th class="num">Amount</th><th class="num">Per month</th><th class="num">Recovered</th><th class="num">Left</th><th>Status</th><th></th></tr></thead><tbody>
      ${advList.map(a => `<tr><td><b>${attEsc(personName(a.username))}</b><div class="small muted">${attEsc(a.reason || '')}</div></td><td>${attEsc(attDayLabel(a.given_on))}</td><td class="num">${inr(a.amount)}</td><td class="num">${inr(a.instalment)}</td><td class="num">${inr(a.recovered)}</td><td class="num"><b>${inr(Math.max(0, a.amount - a.recovered))}</b></td><td>${attEsc(a.status)}</td><td>${x.canEdit && a.status === 'open' ? `<button class="btn btn-sm" data-adv-close="${a.id}">Close</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<div class="small muted">No advances.</div>'}</div>`;
}
function hrPayrollHTML() {
  const s = hrState(); const d = hrNeed('payroll'); const l = hrLoadingHTML(d); if (l) return l;
  const x = d.data; const run = x.run; const m = x.me || {}; const t = x.totals || {};
  const le = s.lineEdit;
  const status = !run ? 'Not prepared' : run.status === 'draft' ? (run.submitted_at ? 'Waiting for Admin approval' : 'Draft') : run.status === 'approved' ? 'Approved — to pay' : 'Paid';
  const lines = hrPeopleFilter(x.lines || []);
  return `<div class="card">
    <div class="flex-between" style="gap:8px;flex-wrap:wrap;">
      <div><div class="card-title" style="margin:0;">Payroll · ${attEsc(x.label)}</div><div class="small muted">Status: <b>${attEsc(status)}</b>${run && run.prepared_at ? ` · prepared ${attEsc(new Date(run.prepared_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }))}` : ''}${run && run.paid_note ? ` · ${attEsc(run.paid_note)}` : ''}</div></div>
      <div style="display:flex;gap:6px;"><button class="btn btn-sm" data-hr-paymonth="-1">‹</button><button class="btn btn-sm" data-hr-paymonth="1" ${s.payMonth >= attMonthNow() ? 'disabled' : ''}>›</button></div>
    </div>
    <div class="pay-steps">
      ${m.canPrepare && (!run || run.status === 'draft') ? `<button class="btn btn-sm ${run ? '' : 'btn-primary'}" data-pay-act="prepare">${run ? '↻ Prepare again (from latest attendance)' : '⚙ Prepare payroll'}</button>` : ''}
      ${m.canPrepare && run && run.status === 'draft' && !run.submitted_at ? '<button class="btn btn-sm btn-primary" data-pay-act="submit">📤 Send to Admin for approval</button>' : ''}
      ${m.canApprove && run && run.status === 'draft' ? '<button class="btn btn-sm btn-primary" data-pay-act="approve">✓ Approve</button>' : ''}
      ${m.canApprove && run && run.status === 'approved' ? '<button class="btn btn-sm" data-pay-act="reopen">↩ Reopen</button>' : ''}
      ${m.canPay && run && run.status === 'approved' ? '<input type="text" id="pay-note" placeholder="Payment ref (NEFT batch / cheque) — optional" style="width:auto;min-width:220px;margin:0;"><button class="btn btn-sm btn-primary" data-pay-act="paid">💸 Mark paid</button>' : ''}
      ${run ? '<button class="btn btn-sm" data-pay-act="all-slips">🖨 All payslips</button><button class="btn btn-sm" data-pay-export="register">⬇ Salary register</button>' : ''}
      ${m.canPay && run && run.status !== 'draft' ? '<button class="btn btn-sm" data-pay-export="bank">⬇ Bank transfer sheet</button>' : ''}
    </div>
    ${s.payMonth === attMonthNow() && run ? '<div class="small dlv-warn-text">⚠ This month is not over — the remaining days are counted as present.</div>' : ''}
    ${run ? `<div class="att-chips"><span class="att-chip">People <b>${t.people}</b></span><span class="att-chip">Earnings <b>${inr(t.gross)}</b></span><span class="att-chip">PF <b>${inr(t.pf)}</b></span><span class="att-chip">ESI <b>${inr(t.esi)}</b></span><span class="att-chip">PT <b>${inr(t.pt)}</b></span><span class="att-chip">Advances <b>${inr(t.advance)}</b></span><span class="att-chip strong">Net pay <b>${inr(t.net)}</b></span><span class="att-chip">Employer PF + ESI <b>${inr((t.employerPf || 0) + (t.employerEsi || 0))}</b></span></div>` : '<div class="small muted" style="margin-top:8px;">Prepare the payroll to work out every salary from attendance, leave and advances.</div>'}
    ${le ? `<div class="att-form"><b>Adjust ${attEsc(le.name)}</b>
      <div class="row"><div class="col"><label>OT hours</label><input type="number" step="any" min="0" id="ple-ot" value="${attEsc(le.ot_hours == null ? '' : le.ot_hours)}" placeholder="from attendance"></div>
        <div class="col"><label>Other earning ₹</label><input type="number" min="0" id="ple-ee" value="${attEsc(le.other_earn || '')}"></div><div class="col"><label>For</label><input type="text" id="ple-een" value="${attEsc(le.other_earn_note || '')}" placeholder="e.g. Site allowance"></div></div>
      <div class="row"><div class="col"><label>Other deduction ₹</label><input type="number" min="0" id="ple-dd" value="${attEsc(le.other_ded || '')}"></div><div class="col"><label>For</label><input type="text" id="ple-ddn" value="${attEsc(le.other_ded_note || '')}" placeholder="e.g. Canteen"></div></div>
      ${le.err ? `<div class="err">${attEsc(le.err)}</div>` : ''}
      <div style="margin-top:8px;display:flex;gap:8px;"><button class="btn btn-primary btn-sm" data-pay-act="line-save">Save and recalculate</button><button class="btn btn-sm" data-pay-act="line-cancel">Cancel</button></div></div>` : ''}
    ${run ? `<div class="dpr-table-wrap"><table class="dpr-table pay-table"><thead><tr><th>Person</th><th class="num">Paid / days</th><th class="num">Gross earned</th><th class="num">OT</th><th class="num">Other +</th><th class="num">PF</th><th class="num">ESI</th><th class="num">PT</th><th class="num">Advance</th><th class="num">Other −</th><th class="num">Net</th><th></th></tr></thead><tbody>
      ${lines.map(p => `<tr><td><b>${attEsc(p.name)}</b><div class="small muted">${attEsc(p.team)}${p.lateMarks ? ` · ${p.lateMarks} late` : ''}${p.lopDays ? ` · LOP ${p.lopDays}` : ''}</div></td>
        <td class="num">${p.paidDays} / ${p.daysInMonth}</td><td class="num">${inr(p.earned.gross)}</td><td class="num">${p.otPay ? `${inr(p.otPay)}<div class="small muted">${p.otHours} h</div>` : ''}</td><td class="num">${p.otherEarn ? inr(p.otherEarn) : ''}</td>
        <td class="num">${p.pf ? inr(p.pf) : ''}</td><td class="num">${p.esi ? inr(p.esi) : ''}</td><td class="num">${p.pt ? inr(p.pt) : ''}</td><td class="num">${p.advance ? inr(p.advance) : ''}</td><td class="num">${p.otherDed ? inr(p.otherDed) : ''}</td>
        <td class="num"><b>${inr(p.net)}</b></td><td style="white-space:nowrap;">${m.canPrepare && run.status === 'draft' ? `<button class="btn btn-sm" data-pay-line="${attEsc(p.username)}">Adjust</button> ` : ''}<button class="btn btn-sm" data-slip="${attEsc(x.period)}:${attEsc(p.username)}">Payslip</button></td></tr>`).join('')}</tbody></table></div>` : ''}
  </div>`;
}
function hrRulesHTML() {
  const s = hrState(); const d = hrNeed('rules'); const l = hrLoadingHTML(d); if (l) return l;
  const x = d.data; const S = { ...x.settings, ...(ui.hrRules || {}) }; const ed = x.canEdit;
  const f = (k, label, type = 'number', extra = '') => `<div class="col"><label>${label}</label><input type="${type}" data-rule="${k}" value="${attEsc(S[k])}" ${ed ? '' : 'disabled'} ${extra}></div>`;
  const h = s.holiday || {};
  return `<div class="card"><div class="card-title">Attendance rules</div>
    <div class="row">${f('shiftStart', 'Shift starts', 'time')}${f('shiftEnd', 'Shift ends', 'time')}${f('graceMin', 'Late after (minutes grace)')}${f('lateMarksPerHalfDay', 'Late marks = ½ day cut (0 = off)')}</div>
    <div class="row">${f('fullDayHours', 'Full day (hours)', 'number', 'step="0.5"')}${f('halfDayHours', 'Half day (hours)', 'number', 'step="0.5"')}${f('otAfterMin', 'OT counts after (minutes beyond the shift end)')}${f('otMultiplier', 'OT rate × (of hourly pay)', 'number', 'step="0.25"')}</div>
    <div class="row">${f('paidLeavePerYear', 'Paid leave per year')}
      <div class="col"><label>Weekly off</label><div class="att-week">${WEEKDAYS.map((w, i) => `<label><input type="checkbox" data-rule-off="${i}" ${(S.weeklyOff || []).includes(i) ? 'checked' : ''} ${ed ? '' : 'disabled'}> ${w}</label>`).join('')}</div></div>
      <div class="col"><label>Live photo at check-in (not at check-out)</label><select data-rule="selfieRequired" ${ed ? '' : 'disabled'}><option value="true" ${S.selfieRequired ? 'selected' : ''}>Required (deleted 12 noon next day)</option><option value="false" ${!S.selfieRequired ? 'selected' : ''}>Not needed</option></select></div>
      <div class="col"><label>Automatic check-in / out (location)</label><select data-rule="autoAttendance" ${ed ? '' : 'disabled'}><option value="true" ${S.autoAttendance !== false ? 'selected' : ''}>On</option><option value="false" ${S.autoAttendance === false ? 'selected' : ''}>Off</option></select></div></div>
    <div class="row">
      <div class="col"><label>Automatic check-out</label><select data-rule="autoOutMode" ${ed ? '' : 'disabled'}>${[['leave', 'Every time they leave all sites (coming back = check in again)'], ['fullday', 'Only after a full day is worked'], ['off', 'Never — they check out themselves']].map(([v, l]) => `<option value="${v}" ${(S.autoOutMode || 'leave') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      ${f('breakAllowanceMin', 'Break allowed a day (minutes, in total, any time)')}
      ${f('breakRemindMin', 'Break reminder before it ends (minutes)')}
    </div>
    <div class="row">${f('maxSessionHours', 'A work session is closed after (hours)')}${f('siteTransferMin', 'After a full day: check out once away from every site for (minutes)')}</div>
    <div class="small muted">Sites and the office are the Places on the Locations page (${x.placesCount} now)${x.placesCount ? '' : ' — <b>none yet, so check-in is allowed anywhere until Admin adds them</b>'}. Check-in and check-out work from anywhere (a visit to another site, the head office, a shop) and are flagged 📍 when not at a site. Only break time beyond the allowance is not counted as work; time away from a site never is deducted. If someone does not come back from a break in time they are checked out when the break time ended — their hours so far still count (8 h = full day, 4 h = half day).</div>
    <div class="card-title" style="margin-top:12px;">PF / ESI</div>
    <div class="row">${f('pfPercent', 'PF employee %', 'number', 'step="0.01"')}${f('employerPfPercent', 'PF employer %', 'number', 'step="0.01"')}${f('pfWageCeiling', 'PF wage ceiling ₹')}
      <div class="col"><label>PF on</label><select data-rule="pfOnFullBasic" ${ed ? '' : 'disabled'}><option value="false" ${!S.pfOnFullBasic ? 'selected' : ''}>Basic up to the ceiling</option><option value="true" ${S.pfOnFullBasic ? 'selected' : ''}>Full basic</option></select></div></div>
    <div class="row">${f('esiEmployeePercent', 'ESI employee %', 'number', 'step="0.01"')}${f('esiEmployerPercent', 'ESI employer %', 'number', 'step="0.01"')}${f('esiGrossLimit', 'ESI applies up to gross ₹')}</div>
    <div class="small muted">Professional tax uses the Maharashtra slabs (standard: up to ₹7,500 nil, up to ₹10,000 ₹175, above ₹200 — ₹300 in February; women's slab: up to ₹25,000 nil). Check these rates with your CA when the law changes.</div>
    ${ed ? '<div style="margin-top:10px;"><button class="btn btn-primary btn-sm" data-hr-act="rules-save">Save rules</button></div>' : ''}
  </div>
  <div class="card"><div class="card-title">Can check in from anywhere</div>
    <div class="small muted" style="margin-top:-4px;">No longer needed — everyone can check in and out from anywhere now (away from a site is flagged 📍). This list is kept only for reference.</div>
    ${ed ? `<div class="row" style="align-items:flex-end;"><div class="col"><select id="any-user"><option value="">— pick a person —</option>${(userDirectory || []).filter(u => !(x.anywhere || []).some(a => a.username === u.username)).slice().sort((a, b) => a.name.localeCompare(b.name)).map(u => `<option value="${attEsc(u.username)}">${attEsc(u.name)} · ${attEsc(u.username)}${u.team ? ` (${attEsc(u.team)})` : ''}</option>`).join('')}</select></div><div class="col" style="flex:0;"><button class="btn btn-sm btn-primary" data-hr-act="any-add">+ Add</button></div></div>` : ''}
    ${(x.anywhere || []).length ? `<div class="att-list">${x.anywhere.map(a => `<div class="att-list-row"><div><b>${attEsc(a.name)}</b> <span class="small muted">${attEsc(a.username)} · ${attEsc(a.team || '')}</span></div>${ed ? `<button class="btn btn-sm" data-any-del="${attEsc(a.username)}">✕</button>` : ''}</div>`).join('')}</div>` : '<div class="small muted">Nobody — everyone checks in inside a site.</div>'}
  </div>
  <div class="card"><div class="card-title">Holidays ${attEsc(x.year)}</div>
    ${ed ? `<div class="row" style="align-items:flex-end;"><div class="col"><label>Date</label><input type="date" id="hol-day" value="${attEsc(h.day || '')}"></div><div class="col" style="flex:2;"><label>Holiday</label><input type="text" id="hol-name" value="${attEsc(h.name || '')}" placeholder="e.g. Diwali (Laxmi Puja)"></div><div class="col" style="flex:0;"><button class="btn btn-sm btn-primary" data-hr-act="hol-add">+ Add</button></div></div>` : ''}
    ${x.holidays.length ? `<div class="att-list">${x.holidays.map(hh => `<div class="att-list-row"><div><b>${attEsc(attDayLabel(hh.day))}</b> · ${attEsc(hh.name)}</div>${ed ? `<button class="btn btn-sm" data-hol-del="${attEsc(hh.day)}">✕</button>` : ''}</div>`).join('')}</div>` : '<div class="small muted">No holidays added for this year.</div>'}
  </div>`;
}
function bindHrPayrollView() {
  const s = hrState();
  bindPayslipModal();
  const reload = (tab) => { hrLoad(tab || s.tab, true); };
  document.querySelectorAll('[data-hr-tab]').forEach(b => b.onclick = () => { s.tab = b.dataset.hrTab; s.edit = null; s.salEdit = null; s.lineEdit = null; render(); });
  document.querySelectorAll('[data-hr-tf]').forEach(b => b.onclick = (e) => { e.preventDefault(); const k = b.dataset.hrTf; s.todayFilter = s.todayFilter === k ? 'all' : k; render(); });
  const q = document.getElementById('hr-q'); if (q) q.oninput = () => { s.q = q.value; const pos = q.selectionStart; render(); const n = document.getElementById('hr-q'); if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch (e) {} } };
  document.querySelectorAll('[data-tl-range]').forEach(b => b.onclick = () => { const [f, t] = b.dataset.tlRange.split('|'); s.tlFrom = f; s.tlTo = t; render(); });
  const tlf = document.getElementById('tl-from'), tlt = document.getElementById('tl-to');
  if (tlf) tlf.onchange = () => { if (tlf.value) { s.tlFrom = tlf.value; if (s.tlTo < s.tlFrom) s.tlTo = s.tlFrom; render(); } };
  if (tlt) tlt.onchange = () => { if (tlt.value) { s.tlTo = tlt.value; if (s.tlFrom > s.tlTo) s.tlFrom = s.tlTo; render(); } };
  document.querySelectorAll('[data-tl-csv]').forEach(b => b.onclick = hrTimeLogCsv);
  const dayInp = document.getElementById('hr-day'); if (dayInp) dayInp.onchange = () => { if (dayInp.value) { s.day = dayInp.value; render(); } };
  document.querySelectorAll('[data-hr-month]').forEach(b => b.onclick = () => { s.month = attShiftMonth(s.month, Number(b.dataset.hrMonth)); s.edit = null; render(); });
  document.querySelectorAll('[data-hr-paymonth]').forEach(b => b.onclick = () => { s.payMonth = attShiftMonth(s.payMonth, Number(b.dataset.hrPaymonth)); s.lineEdit = null; render(); });
  document.querySelectorAll('[data-hr-photo]').forEach(b => b.onclick = async () => { const [u, d, w] = b.dataset.hrPhoto.split('|'); try { const r = await api(`/api/attendance/photo/${encodeURIComponent(u)}/${d}/${w}`); ui.hrPhoto = r.data; render(); } catch (e) { setBanner(e.message); render(); } });
  document.querySelectorAll('[data-hr-att-photo]').forEach(b => b.onclick = async () => { try { const r = await api(`/api/attendance/attempts/${b.dataset.hrAttPhoto}/photo`); ui.hrPhoto = r.data; render(); } catch (e) { setBanner(e.message); render(); } });
  document.querySelectorAll('[data-hr-att-dec]').forEach(b => b.onclick = async () => {
    const [id, dec] = b.dataset.hrAttDec.split('|'); b.disabled = true;
    try { await api(`/api/attendance/attempts/${id}/${dec}`, { method: 'POST' }); setBanner(dec === 'accept' ? 'Accepted — the attendance is marked.' : 'Denied — the person is told.', 'ok'); await hrLoad('today', true); }
    catch (e) { setBanner(e.message); b.disabled = false; render(); }
  });
  document.querySelectorAll('[data-hr-photo-close]').forEach(b => b.onclick = (e) => { if (e.target !== b) return; ui.hrPhoto = null; render(); });
  const act = (n, fn) => document.querySelectorAll(`[data-hr-act="${n}"]`).forEach(b => b.onclick = fn);
  // register corrections
  document.querySelectorAll('[data-hr-cell]').forEach(c => c.onclick = () => {
    const [u, day] = c.dataset.hrCell.split('|'); const reg = hrData.register && hrData.register.data; if (!reg) return;
    const p = reg.people.find(x => x.username === u); const cur = p.days.find(x => x.day === day);
    s.edit = { username: u, name: p.name, day, cur, status: '', in: cur.in, out: cur.out, ot: null, reason: '' }; render(); window.scrollTo(0, 0);
  });
  if (s.edit) {
    const e = s.edit; const bindE = (id, k) => { const el = document.getElementById(id); if (el) el.oninput = el.onchange = () => { e[k] = el.value; }; };
    bindE('hre-status', 'status'); bindE('hre-in', 'in'); bindE('hre-out', 'out'); bindE('hre-ot', 'ot'); bindE('hre-reason', 'reason');
    act('edit-cancel', () => { s.edit = null; render(); });
    act('edit-save', async () => {
      try { await api('/api/attendance/correct', { method: 'POST', body: JSON.stringify({ username: e.username, day: e.day, status: e.status, in: e.in, out: e.out, otMinutes: e.ot, reason: e.reason }) });
        s.edit = null; setBanner('Day corrected.', 'ok'); reload('register'); }
      catch (err) { e.err = err.message; render(); }
    });
  }
  // leave
  document.querySelectorAll('[data-leave-decide]').forEach(b => b.onclick = async () => {
    const [id, decision] = b.dataset.leaveDecide.split('|'); const note = (document.getElementById(`lvn-${id}`) || {}).value || '';
    if (b.disabled) return; b.disabled = true;
    try { await api(`/api/leave/${id}/decide`, { method: 'POST', body: JSON.stringify({ decision, note }) }); setBanner(decision === 'approve' ? 'Leave approved.' : 'Leave rejected.', 'ok'); reload('leave'); await refreshData(); }
    catch (err) { b.disabled = false; setBanner(err.message); render(); }
  });
  // salaries
  document.querySelectorAll('[data-sal-edit]').forEach(b => b.onclick = () => {
    const p = hrData.salaries.data.people.find(x => x.username === b.dataset.salEdit);
    const sl = p.salary || {};
    s.salEdit = { username: p.username, name: p.name, basic: sl.basic != null ? Number(sl.basic) : '', hra: sl.hra != null ? Number(sl.hra) : '', conveyance: sl.conveyance != null ? Number(sl.conveyance) : '', special: sl.special != null ? Number(sl.special) : '',
      pf_applicable: sl.pf_applicable !== false, esi_mode: sl.esi_mode || 'auto', pt_slab: sl.pt_slab || 'standard', ot_rate: sl.ot_rate != null ? Number(sl.ot_rate) : '', paid_leave_per_year: sl.paid_leave_per_year != null ? Number(sl.paid_leave_per_year) : '',
      employee_code: sl.employee_code || '', joined_on: sl.joined_on || '', pan: sl.pan || '', uan: sl.uan || '', esi_no: sl.esi_no || '', bank_name: sl.bank_name || '', account_no: sl.account_no || '', ifsc: sl.ifsc || '', active: sl.active !== false };
    render(); window.scrollTo(0, 0);
  });
  if (s.salEdit) {
    document.querySelectorAll('[data-sal]').forEach(el => el.oninput = el.onchange = () => { const k = el.dataset.sal; s.salEdit[k] = el.tagName === 'SELECT' && (k === 'pf_applicable' || k === 'active') ? el.value === 'true' : el.value;
      if (['basic', 'hra', 'conveyance', 'special'].includes(k)) { const t = document.querySelector('.att-form .small b'); if (t) t.textContent = inr(['basic', 'hra', 'conveyance', 'special'].reduce((a, c) => a + (Number(s.salEdit[c]) || 0), 0)); } });
    act('sal-cancel', () => { s.salEdit = null; render(); });
    act('sal-save', async () => {
      try { await api(`/api/payroll/salaries/${encodeURIComponent(s.salEdit.username)}`, { method: 'POST', body: JSON.stringify(s.salEdit) }); setBanner('Salary saved.', 'ok'); s.salEdit = null; reload('salaries'); }
      catch (err) { s.salEdit.err = err.message; render(); }
    });
  }
  // advances
  act('adv-new', () => { s.advForm = { given_on: attToday() }; render(); });
  act('adv-cancel', () => { s.advForm = null; render(); });
  if (s.advForm) {
    const f = s.advForm; [['adv-user', 'username'], ['adv-amount', 'amount'], ['adv-inst', 'instalment'], ['adv-date', 'given_on'], ['adv-reason', 'reason']].forEach(([id, k]) => { const el = document.getElementById(id); if (el) el.oninput = el.onchange = () => { f[k] = el.value; }; });
    act('adv-save', async () => { try { await api('/api/payroll/advances', { method: 'POST', body: JSON.stringify(f) }); s.advForm = null; setBanner('Advance recorded.', 'ok'); reload('advances'); } catch (err) { f.err = err.message; render(); } });
  }
  document.querySelectorAll('[data-adv-close]').forEach(b => b.onclick = async () => { try { await api(`/api/payroll/advances/${b.dataset.advClose}/close`, { method: 'POST' }); reload('advances'); } catch (e) { setBanner(e.message); render(); } });
  // payroll
  const pay = async (path, okMsg, body) => {
    try { await api(`/api/payroll/runs/${s.payMonth}/${path}`, { method: 'POST', body: JSON.stringify(body || {}) }); setBanner(okMsg, 'ok'); reload('payroll'); await refreshData(); }
    catch (e) { setBanner(e.message); render(); }
  };
  document.querySelectorAll('[data-pay-act]').forEach(b => b.onclick = async () => {
    const a = b.dataset.payAct;
    if (a === 'prepare') { b.disabled = true; b.textContent = 'Working…'; return pay('prepare', 'Payroll prepared — check the lines, then send it to Admin.'); }
    if (a === 'submit') return pay('submit', 'Sent to Admin for approval.');
    if (a === 'approve') return pay('approve', 'Payroll approved — HR has been told.');
    if (a === 'reopen') return pay('reopen', 'Reopened for changes.');
    if (a === 'paid') { const note = (document.getElementById('pay-note') || {}).value || ''; return pay('paid', 'Marked paid — everyone can now see their payslip.', { note }); }
    if (a === 'all-slips') { try { const r = await api(`/api/payroll/runs/${s.payMonth}/payslips`); printAllPayslips(r); } catch (e) { setBanner(e.message); render(); } return; }
    if (a === 'line-cancel') { s.lineEdit = null; render(); return; }
    if (a === 'line-save') {
      const le = s.lineEdit; const v = (id) => (document.getElementById(id) || {}).value;
      try { await api(`/api/payroll/runs/${s.payMonth}/lines/${encodeURIComponent(le.username)}`, { method: 'POST', body: JSON.stringify({ ot_hours: v('ple-ot'), other_earn: v('ple-ee'), other_earn_note: v('ple-een'), other_ded: v('ple-dd'), other_ded_note: v('ple-ddn') }) });
        s.lineEdit = null; setBanner('Recalculated.', 'ok'); reload('payroll'); }
      catch (e) { le.err = e.message; render(); }
    }
  });
  document.querySelectorAll('[data-pay-line]').forEach(b => b.onclick = () => {
    const p = hrData.payroll.data.lines.find(x => x.username === b.dataset.payLine);
    s.lineEdit = { username: p.username, name: p.name, ...(p.manual || {}) }; render(); window.scrollTo(0, 0);
  });
  document.querySelectorAll('[data-pay-export]').forEach(b => b.onclick = async () => { try { const r = await api(`/api/payroll/runs/${s.payMonth}/export${b.dataset.payExport === 'bank' ? '?kind=bank' : ''}`); downloadDataUrl(r.data, r.name); } catch (e) { setBanner(e.message); render(); } });
  // rules
  document.querySelectorAll('[data-rule]').forEach(el => el.oninput = el.onchange = () => { ui.hrRules = { ...(ui.hrRules || {}), [el.dataset.rule]: el.tagName === 'SELECT' ? (el.value === 'true' ? true : el.value === 'false' ? false : el.value) : el.value }; });
  document.querySelectorAll('[data-rule-off]').forEach(el => el.onchange = () => { const cur = new Set(((ui.hrRules || {}).weeklyOff) || (hrData.rules.data.settings.weeklyOff || [])); el.checked ? cur.add(Number(el.dataset.ruleOff)) : cur.delete(Number(el.dataset.ruleOff)); ui.hrRules = { ...(ui.hrRules || {}), weeklyOff: [...cur] }; });
  act('rules-save', async () => { try { await api('/api/payroll/settings', { method: 'POST', body: JSON.stringify(ui.hrRules || {}) }); ui.hrRules = null; setBanner('Rules saved.', 'ok'); reload('rules'); } catch (e) { setBanner(e.message); render(); } });
  const hd = document.getElementById('hol-day'), hn = document.getElementById('hol-name');
  if (hd) hd.onchange = () => { s.holiday = { ...(s.holiday || {}), day: hd.value }; };
  if (hn) hn.oninput = () => { s.holiday = { ...(s.holiday || {}), name: hn.value }; };
  act('any-add', async () => { const u = (document.getElementById('any-user') || {}).value; if (!u) return; try { await api(`/api/attendance/anywhere/${encodeURIComponent(u)}`, { method: 'POST', body: JSON.stringify({ anywhere: true }) }); reload('rules'); } catch (e) { setBanner(e.message); render(); } });
  document.querySelectorAll('[data-any-del]').forEach(b => b.onclick = async () => { try { await api(`/api/attendance/anywhere/${encodeURIComponent(b.dataset.anyDel)}`, { method: 'POST', body: JSON.stringify({ anywhere: false }) }); reload('rules'); } catch (e) { setBanner(e.message); render(); } });
  act('hol-add', async () => { try { await api('/api/payroll/holidays', { method: 'POST', body: JSON.stringify(s.holiday || {}) }); s.holiday = null; reload('rules'); } catch (e) { setBanner(e.message); render(); } });
  document.querySelectorAll('[data-hol-del]').forEach(b => b.onclick = async () => { try { await api(`/api/payroll/holidays/${b.dataset.holDel}`, { method: 'DELETE' }); reload('rules'); } catch (e) { setBanner(e.message); render(); } });
}
// Never leave the camera on when the person moves to another page.

let attCamMiss = 0;
setInterval(() => {
  if (!attCamStream) { attCamMiss = 0; return; }
  if (typeof ui === 'undefined' || !ui.att || !ui.att.cam) { attStopCamera(); return; }
  // the camera window is no longer on screen (the person went to another page) → close it
  if (!document.getElementById('att-video')) { if (++attCamMiss >= 2) { attStopCamera(); ui.att.cam = null; attCamMiss = 0; } } else attCamMiss = 0;
}, 1500);
