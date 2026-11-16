/* Attendance & payroll pages.
   - "My Attendance" (everyone): Check in / Check out with GPS and a selfie, the month at a glance, leave (balance,
     ask, withdraw) and payslips.
   - "HR & Payroll" (Admin, HR, Accounts): Today, Register (correct a day), Leave requests, Salaries, Advances,
     Payroll (prepare → send for approval → Admin approves → Accounts marks paid; register / bank sheet), Rules.
   Data: /api/attendance/*, /api/leave*, /api/payroll/*, /api/payslips/* — loaded while a page is open; the small
   /api/attendance/summary comes with the core data (menu badges, "Waiting for your decision"). Loaded before app.js. */

let attSummary = { canSeeAttendance: false, canSeePayroll: false };
let attMe = null, attLoading = false;
let hrData = {}; // per HR sub-tab: { key, data }
const ATT_CODE = { P: 'P', H: '½', A: 'A', L: 'L', LH: 'L½', U: 'U', WO: 'WO', HO: 'HO', F: '' };
const ATT_LABEL = { P: 'Present', H: 'Half day', A: 'Absent', L: 'Paid leave', LH: 'Half day leave', U: 'Unpaid leave', WO: 'Weekly off', HO: 'Holiday', F: 'Coming' };
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HR_TABS = [['today', 'Today'], ['register', 'Register'], ['leave', 'Leave'], ['salaries', 'Salaries'], ['advances', 'Advances'], ['payroll', 'Payroll'], ['rules', 'Rules & holidays']];
function attEsc(s) { return typeof esc === 'function' ? esc(s) : String(s == null ? '' : s); }
function inr(n) { return n == null || n === '' ? '—' : '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 }); }
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
function attGeo() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) { resolve({ error: 'no GPS on this device' }); return; }
    let done = false; const fin = (v) => { if (!done) { done = true; resolve(v); } };
    setTimeout(() => fin({ error: 'location took too long' }), 15000);
    navigator.geolocation.getCurrentPosition(p => fin({ lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy || 0) }),
      e => fin({ error: e && e.code === 1 ? 'location permission is off' : 'location not available' }), { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
  });
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
  if (ui.adminTab === 'attendance') render();
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
  <div class="card att-today">
    <div class="flex-between" style="gap:10px;flex-wrap:wrap;">
      <div><div class="card-title" style="margin:0;">Today · ${attEsc(attDayLabel(d.today))}</div>
        <div class="small muted">Shift ${attEsc(R.shiftStart)}–${attEsc(R.shiftEnd)} · late after ${attEsc(R.shiftStart)} + ${R.graceMin} min · full day ${R.fullDayHours} h</div></div>
      <div class="att-punch-state">
        ${t && t.in ? `<span class="att-chip st-P">In <b>${attEsc(t.in)}</b>${t.inPlace ? ` · ${attEsc(t.inPlace)}` : t.inAway ? ' · ⚠ not at a site' : ''}</span>` : ''}
        ${t && t.out ? `<span class="att-chip">Out <b>${attEsc(t.out)}</b>${t.outPlace ? ` · ${attEsc(t.outPlace)}` : t.outAway ? ' · ⚠ not at a site' : ''}</span>` : ''}
      </div>
    </div>
    ${!(t && t.out) ? `<div class="att-punch">
      <label class="btn btn-primary att-punch-btn ${p && p.busy ? 'disabled' : ''}">${p && p.busy ? '⏳ ' + attEsc(p.msg || 'Working…') : t && t.in ? '📷 Check out' : '📷 Check in'}
        <input type="file" id="att-selfie" accept="image/*" capture="user" hidden ${p && p.busy ? 'disabled' : ''}></label>
      <div class="small muted">Takes a selfie and your location${R.selfieRequired ? '' : ' (selfie optional)'} — allow the camera and location when the phone asks.</div>
    </div>` : '<div class="small" style="margin-top:8px;">✅ Done for today.</div>'}
    ${p && p.err ? `<div class="err">${attEsc(p.err)}</div>` : ''}
    ${p && p.done ? `<div class="notice">${attEsc(p.done)}</div>` : ''}
  </div>

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
  ${payslipModalHTML()}`;
}
function payslipModalHTML() {
  const sl = (ui.att || {}).slip; if (!sl) return '';
  if (sl.loading) return '<div class="att-modal"><div class="att-modal-box">Loading…</div></div>';
  if (sl.error) return `<div class="att-modal" data-slip-close><div class="att-modal-box"><div class="err">${attEsc(sl.error)}</div><button class="btn btn-sm" data-slip-close>Close</button></div></div>`;
  const l = sl.data.line, u = sl.data.username;
  const row = (k, v) => v ? `<tr><td>${k}</td><td class="num">${inr(v)}</td></tr>` : '';
  return `<div class="att-modal"><div class="att-modal-box payslip" id="payslip-box">
    <div class="flex-between"><div><div class="payslip-co">MIHIR GROUP</div><div class="small muted">Payslip · ${attEsc(sl.data.label)}</div></div><div class="noprint" style="display:flex;gap:6px;"><button class="btn btn-sm" data-slip-print>🖨 Print / PDF</button><button class="btn btn-sm" data-slip-close>Close</button></div></div>
    <div class="payslip-grid">
      <div><span>Employee</span><b>${attEsc(l.name)}</b></div><div><span>Code</span><b>${attEsc(l.employee_code || u)}</b></div><div><span>Department</span><b>${attEsc(l.team || '—')}</b></div>
      <div><span>Days in month</span><b>${l.daysInMonth}</b></div><div><span>Paid days</span><b>${l.paidDays}</b></div><div><span>Loss of pay days</span><b>${l.lopDays}</b></div>
      ${l.pan ? `<div><span>PAN</span><b>${attEsc(l.pan)}</b></div>` : ''}${l.uan ? `<div><span>UAN</span><b>${attEsc(l.uan)}</b></div>` : ''}${l.bank && l.bank.account_no ? `<div><span>Bank</span><b>${attEsc(l.bank.bank_name || '')} ••${attEsc(String(l.bank.account_no).slice(-4))}</b></div>` : ''}
    </div>
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
    <div class="small muted" style="margin-top:6px;">Computer-generated payslip.</div>
  </div></div>`;
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
function bindAttendanceView() {
  const s = attState();
  bindPayslipModal();
  document.querySelectorAll('[data-att-month]').forEach(b => b.onclick = () => { const n = Number(b.dataset.attMonth); s.month = n === 0 ? attMonthNow() : attShiftMonth(s.month, n); render(); attLoad(true); });
  const inp = document.getElementById('att-selfie');
  if (inp) inp.onchange = async () => {
    const file = inp.files && inp.files[0]; if (!file) return;
    const which = attMe && attMe.todayRec && attMe.todayRec.in ? 'out' : 'in';
    s.punch = { busy: true, msg: 'Getting your location…' }; render();
    const [geo, photo] = await Promise.all([attGeo(), attSmallJpeg(file)]);
    s.punch.msg = 'Saving…'; render();
    try {
      const r = await api(`/api/attendance/check-${which}`, { method: 'POST', body: JSON.stringify({ ...(geo && !geo.error ? geo : {}), photo }) });
      const where = r.place ? ` at ${r.place}` : r.away ? ` — not at any site${r.nearest ? ` (${r.nearest.metres} m from ${r.nearest.name})` : ''}` : '';
      s.punch = { done: `${which === 'in' ? 'Checked in' : 'Checked out'} at ${r.at}${where}${r.late ? ' — marked late' : ''}.${geo && geo.error ? ` Location not saved (${geo.error}).` : ''}` };
      if (typeof attSummary !== 'undefined') attSummary = { ...attSummary, [which === 'in' ? 'checkedIn' : 'checkedOut']: true };
      await attLoad(true);
    } catch (e) { s.punch = { err: e.message }; render(); }
  };
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
  const url = { today: `/api/attendance/today?day=${s.day}`, register: `/api/attendance/register?month=${s.month}`, leave: '/api/leave', salaries: '/api/payroll/salaries', advances: '/api/payroll/advances',
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
function hrPeopleFilter(list) {
  const words = String(hrState().q || '').toLowerCase().split(/\s+/).filter(Boolean);
  return words.length ? list.filter(p => words.every(w => `${p.name} ${p.username} ${p.team || ''}`.toLowerCase().includes(w))) : list;
}
function renderHrPayrollView() {
  const s = hrState(); const S = attSummary || {};
  const tabs = HR_TABS.filter(([k]) => ['salaries', 'advances', 'payroll'].includes(k) ? S.canSeePayroll : S.canSeeAttendance);
  if (!tabs.some(([k]) => k === s.tab)) s.tab = tabs[0] ? tabs[0][0] : 'today';
  const badge = { leave: (S.pendingLeave || []).length, payroll: (S.payrollToApprove || []).length + (S.payrollToPay || []).length };
  let body = '';
  try { body = ({ today: hrTodayHTML, register: hrRegisterHTML, leave: hrLeaveHTML, salaries: hrSalariesHTML, advances: hrAdvancesHTML, payroll: hrPayrollHTML, rules: hrRulesHTML }[s.tab] || (() => ''))(); }
  catch (e) { body = `<div class="err">${attEsc(e.message)}</div>`; }
  return `<div class="card"><div class="card-title" style="margin:0;">HR & Payroll</div>
    <div class="dpr-tabs">${tabs.map(([k, l]) => `<button type="button" class="${s.tab === k ? 'on' : ''}" data-hr-tab="${k}">${l}${badge[k] ? ` <span class="badge flag">${badge[k]}</span>` : ''}</button>`).join('')}</div></div>
    ${body}${payslipModalHTML()}`;
}
const hrLoadingHTML = (d) => !d ? '<div class="card"><div class="empty">Loading…</div></div>' : d.error ? `<div class="card"><div class="err">${attEsc(d.error)}</div></div>` : null;
function hrSearchHTML(ph) { return `<input type="search" id="hr-q" value="${attEsc(hrState().q)}" placeholder="🔍 ${attEsc(ph || 'Search name, username or department…')}" autocomplete="off" data-no-spell style="margin:0 0 8px;">`; }
function hrTodayHTML() {
  const s = hrState(); const d = hrNeed('today'); const l = hrLoadingHTML(d); if (l) return l;
  const x = d.data; const t = x.totals;
  const list = hrPeopleFilter(x.list);
  return `<div class="card">
    <div class="flex-between" style="gap:8px;flex-wrap:wrap;"><div class="card-title" style="margin:0;">${attEsc(attDayLabel(x.day))}</div><input type="date" id="hr-day" value="${attEsc(s.day)}" max="${attToday()}" style="width:auto;margin:0;"></div>
    <div class="att-chips"><span class="att-chip st-P">Checked in <b>${t.in}</b></span><span class="att-chip st-A">Not in <b>${t.notIn}</b></span><span class="att-chip">Late <b>${t.late}</b></span><span class="att-chip">Not at a site <b>${t.away}</b></span><span class="att-chip st-L">On leave <b>${t.onLeave}</b></span></div>
    ${hrSearchHTML()}
    <div class="dpr-table-wrap"><table class="dpr-table"><thead><tr><th>Person</th><th>Status</th><th>In</th><th>Out</th><th>Hours</th><th>Where</th><th>Selfie</th></tr></thead><tbody>
    ${list.map(p => `<tr><td><b>${attEsc(p.name)}</b><div class="small muted">${attEsc(p.username)} · ${attEsc(p.team)}</div></td>
      <td><span class="att-chip st-${p.status}">${attEsc(ATT_LABEL[p.status] || p.status)}</span>${p.late ? ` <span class="small dlv-warn-text">late ${p.late} min</span>` : ''}</td>
      <td class="mono">${attEsc(p.in || '—')}</td><td class="mono">${attEsc(p.out || '—')}</td><td>${p.worked != null ? `${Math.floor(p.worked / 60)}h ${p.worked % 60}m` : ''}</td>
      <td class="small">${attEsc(p.inPlace || '')}${p.flags.includes('not at a site') ? ' <span class="dlv-warn-text">⚠ not at a site</span>' : ''}${p.flags.includes('from tracking') ? ' <span class="muted">from tracking</span>' : ''}</td>
      <td>${p.hasInPhoto ? `<button class="btn btn-sm" data-hr-photo="${attEsc(p.username)}|${attEsc(x.day)}|in">In</button>` : ''}${p.hasOutPhoto ? ` <button class="btn btn-sm" data-hr-photo="${attEsc(p.username)}|${attEsc(x.day)}|out">Out</button>` : ''}</td></tr>`).join('')}
    </tbody></table></div></div>
    ${ui.hrPhoto ? `<div class="att-modal" data-hr-photo-close><div class="att-modal-box" style="max-width:420px;text-align:center;"><img src="${ui.hrPhoto}" alt="Selfie" style="max-width:100%;border-radius:10px;"><div style="margin-top:8px;"><button class="btn btn-sm" data-hr-photo-close>Close</button></div></div></div>` : ''}`;
}
function hrRegisterHTML() {
  const s = hrState(); const d = hrNeed('register'); const l = hrLoadingHTML(d); if (l) return l;
  const x = d.data; const e = s.edit;
  const people = hrPeopleFilter(x.people);
  return `<div class="card">
    <div class="flex-between" style="gap:8px;flex-wrap:wrap;"><div class="card-title" style="margin:0;">Register · ${attEsc(x.label)}</div>
      <div style="display:flex;gap:6px;"><button class="btn btn-sm" data-hr-month="-1">‹</button><button class="btn btn-sm" data-hr-month="1" ${s.month >= attMonthNow() ? 'disabled' : ''}>›</button></div></div>
    <div class="small muted" style="margin-bottom:6px;">${x.canEdit ? 'Tap a day to correct it.' : ''} P present · ½ half · A absent · L paid leave · U unpaid · WO weekly off · HO holiday · red dot late · 📍 not at a site · ✎ corrected</div>
    ${hrSearchHTML()}
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
  const x = d.data; const pend = x.list.filter(r => r.status === 'pending'), rest = x.list.filter(r => r.status !== 'pending');
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
    ${hrSearchHTML()}
    <div class="dpr-table-wrap"><table class="dpr-table"><thead><tr><th>Person</th><th class="num">Gross / month</th><th>PF</th><th>ESI</th><th>PT</th><th>Bank</th><th></th></tr></thead><tbody>
    ${people.map(p => { const sl = p.salary; return `<tr class="${sl && !sl.active ? 'muted' : ''}"><td><b>${attEsc(p.name)}</b><div class="small muted">${attEsc(p.username)} · ${attEsc(p.team)}</div></td>
      <td class="num">${sl ? inr(sl.gross) : '<span class="muted">not set</span>'}</td><td>${sl ? (sl.pf_applicable ? 'Yes' : 'No') : ''}</td><td>${sl ? attEsc(sl.esi_mode) : ''}</td><td>${sl ? attEsc(sl.pt_slab) : ''}</td>
      <td class="small">${sl && sl.account_no ? `${attEsc(sl.bank_name || '')} ••${attEsc(String(sl.account_no).slice(-4))}` : ''}</td>
      <td>${x.canEdit ? `<button class="btn btn-sm" data-sal-edit="${attEsc(p.username)}">${sl ? 'Edit' : '+ Set salary'}</button>` : ''}</td></tr>`; }).join('')}</tbody></table></div></div>`;
}
function hrAdvancesHTML() {
  const s = hrState(); const d = hrNeed('advances'); const l = hrLoadingHTML(d); if (l) return l;
  const x = d.data; const f = s.advForm;
  return `<div class="card"><div class="flex-between" style="gap:8px;flex-wrap:wrap;"><div><div class="card-title" style="margin:0;">Salary advances</div><div class="small muted">Recovered from salary each month, an instalment at a time, when the month is paid.</div></div>${x.canEdit && !f ? '<button class="btn btn-sm btn-primary" data-hr-act="adv-new">+ Advance</button>' : ''}</div>
    ${f ? `<div class="att-form"><div class="row">
      <div class="col"><label>Person *</label><select id="adv-user"><option value="">— pick —</option>${(userDirectory || []).slice().sort((a, b) => a.name.localeCompare(b.name)).map(u => `<option value="${attEsc(u.username)}" ${f.username === u.username ? 'selected' : ''}>${attEsc(u.name)} · ${attEsc(u.username)}</option>`).join('')}</select></div>
      <div class="col"><label>Amount *</label><input type="number" id="adv-amount" min="0" value="${attEsc(f.amount || '')}"></div>
      <div class="col"><label>Per month *</label><input type="number" id="adv-inst" min="0" value="${attEsc(f.instalment || '')}"></div>
      <div class="col"><label>Given on</label><input type="date" id="adv-date" value="${attEsc(f.given_on || attToday())}"></div></div>
      <label>Reason</label><input type="text" id="adv-reason" value="${attEsc(f.reason || '')}">
      ${f.err ? `<div class="err">${attEsc(f.err)}</div>` : ''}
      <div style="margin-top:8px;display:flex;gap:8px;"><button class="btn btn-primary btn-sm" data-hr-act="adv-save">Save</button><button class="btn btn-sm" data-hr-act="adv-cancel">Cancel</button></div></div>` : ''}
    ${x.list.length ? `<div class="dpr-table-wrap"><table class="dpr-table"><thead><tr><th>Person</th><th>Given</th><th class="num">Amount</th><th class="num">Per month</th><th class="num">Recovered</th><th class="num">Left</th><th>Status</th><th></th></tr></thead><tbody>
      ${x.list.map(a => `<tr><td><b>${attEsc(personName(a.username))}</b><div class="small muted">${attEsc(a.reason || '')}</div></td><td>${attEsc(attDayLabel(a.given_on))}</td><td class="num">${inr(a.amount)}</td><td class="num">${inr(a.instalment)}</td><td class="num">${inr(a.recovered)}</td><td class="num"><b>${inr(Math.max(0, a.amount - a.recovered))}</b></td><td>${attEsc(a.status)}</td><td>${x.canEdit && a.status === 'open' ? `<button class="btn btn-sm" data-adv-close="${a.id}">Close</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<div class="small muted">No advances.</div>'}</div>`;
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
      ${run ? '<button class="btn btn-sm" data-pay-export="register">⬇ Salary register</button>' : ''}
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
    ${run ? `${hrSearchHTML()}<div class="dpr-table-wrap"><table class="dpr-table pay-table"><thead><tr><th>Person</th><th class="num">Paid / days</th><th class="num">Gross earned</th><th class="num">OT</th><th class="num">Other +</th><th class="num">PF</th><th class="num">ESI</th><th class="num">PT</th><th class="num">Advance</th><th class="num">Other −</th><th class="num">Net</th><th></th></tr></thead><tbody>
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
      <div class="col"><label>Selfie</label><select data-rule="selfieRequired" ${ed ? '' : 'disabled'}><option value="true" ${S.selfieRequired ? 'selected' : ''}>Required</option><option value="false" ${!S.selfieRequired ? 'selected' : ''}>Optional</option></select></div></div>
    <div class="card-title" style="margin-top:12px;">PF / ESI</div>
    <div class="row">${f('pfPercent', 'PF employee %', 'number', 'step="0.01"')}${f('employerPfPercent', 'PF employer %', 'number', 'step="0.01"')}${f('pfWageCeiling', 'PF wage ceiling ₹')}
      <div class="col"><label>PF on</label><select data-rule="pfOnFullBasic" ${ed ? '' : 'disabled'}><option value="false" ${!S.pfOnFullBasic ? 'selected' : ''}>Basic up to the ceiling</option><option value="true" ${S.pfOnFullBasic ? 'selected' : ''}>Full basic</option></select></div></div>
    <div class="row">${f('esiEmployeePercent', 'ESI employee %', 'number', 'step="0.01"')}${f('esiEmployerPercent', 'ESI employer %', 'number', 'step="0.01"')}${f('esiGrossLimit', 'ESI applies up to gross ₹')}</div>
    <div class="small muted">Professional tax uses the Maharashtra slabs (standard: up to ₹7,500 nil, up to ₹10,000 ₹175, above ₹200 — ₹300 in February; women's slab: up to ₹25,000 nil). Check these rates with your CA when the law changes.</div>
    ${ed ? '<div style="margin-top:10px;"><button class="btn btn-primary btn-sm" data-hr-act="rules-save">Save rules</button></div>' : ''}
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
  const q = document.getElementById('hr-q'); if (q) q.oninput = () => { s.q = q.value; const pos = q.selectionStart; render(); const n = document.getElementById('hr-q'); if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch (e) {} } };
  const dayInp = document.getElementById('hr-day'); if (dayInp) dayInp.onchange = () => { if (dayInp.value) { s.day = dayInp.value; render(); } };
  document.querySelectorAll('[data-hr-month]').forEach(b => b.onclick = () => { s.month = attShiftMonth(s.month, Number(b.dataset.hrMonth)); s.edit = null; render(); });
  document.querySelectorAll('[data-hr-paymonth]').forEach(b => b.onclick = () => { s.payMonth = attShiftMonth(s.payMonth, Number(b.dataset.hrPaymonth)); s.lineEdit = null; render(); });
  document.querySelectorAll('[data-hr-photo]').forEach(b => b.onclick = async () => { const [u, d, w] = b.dataset.hrPhoto.split('|'); try { const r = await api(`/api/attendance/photo/${encodeURIComponent(u)}/${d}/${w}`); ui.hrPhoto = r.data; render(); } catch (e) { setBanner(e.message); render(); } });
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
    if (a === 'approve') return pay('approve', 'Payroll approved — Accounts has been told.');
    if (a === 'reopen') return pay('reopen', 'Reopened for changes.');
    if (a === 'paid') { const note = (document.getElementById('pay-note') || {}).value || ''; return pay('paid', 'Marked paid — everyone can now see their payslip.', { note }); }
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
  document.querySelectorAll('[data-rule]').forEach(el => el.oninput = el.onchange = () => { ui.hrRules = { ...(ui.hrRules || {}), [el.dataset.rule]: el.tagName === 'SELECT' ? el.value === 'true' : el.value }; });
  document.querySelectorAll('[data-rule-off]').forEach(el => el.onchange = () => { const cur = new Set(((ui.hrRules || {}).weeklyOff) || (hrData.rules.data.settings.weeklyOff || [])); el.checked ? cur.add(Number(el.dataset.ruleOff)) : cur.delete(Number(el.dataset.ruleOff)); ui.hrRules = { ...(ui.hrRules || {}), weeklyOff: [...cur] }; });
  act('rules-save', async () => { try { await api('/api/payroll/settings', { method: 'POST', body: JSON.stringify(ui.hrRules || {}) }); ui.hrRules = null; setBanner('Rules saved.', 'ok'); reload('rules'); } catch (e) { setBanner(e.message); render(); } });
  const hd = document.getElementById('hol-day'), hn = document.getElementById('hol-name');
  if (hd) hd.onchange = () => { s.holiday = { ...(s.holiday || {}), day: hd.value }; };
  if (hn) hn.oninput = () => { s.holiday = { ...(s.holiday || {}), name: hn.value }; };
  act('hol-add', async () => { try { await api('/api/payroll/holidays', { method: 'POST', body: JSON.stringify(s.holiday || {}) }); s.holiday = null; reload('rules'); } catch (e) { setBanner(e.message); render(); } });
  document.querySelectorAll('[data-hol-del]').forEach(b => b.onclick = async () => { try { await api(`/api/payroll/holidays/${b.dataset.holDel}`, { method: 'DELETE' }); reload('rules'); } catch (e) { setBanner(e.message); render(); } });
}
