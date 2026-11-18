/* User Activity page (Admin, Director) — who isn't using the app, and who isn't working on their tasks.
   Data: GET /api/reports/user-activity?days=N (loaded while the page is open). Loaded before app.js.

   Lists (one person can be in more than one):
   - Never logged in       — account made, no login ever
   - Not logged in lately  — last login N or more days ago
   - Inactive              — logs in, but no work (task, update, file, completion…) in the last N days
   - No task created       — has logged in, never created a task
   - Not working on tasks  — has open assigned tasks with nothing from them for N or more days */

let actData = null;
let actLoading = false;
const ACT_LISTS = [
  { key: 'all', icon: '👥', label: 'Everyone', hint: 'Everybody, with how many days ago they last logged in and how many days they have been inactive (no work). Longest inactive first.' },
  { key: 'never', icon: '🚫', label: 'Never logged in', hint: 'Account made, but they have never logged in.' },
  { key: 'away', icon: '💤', label: 'Not logged in lately', hint: 'Logged in before, but not in the last {d} days.' },
  { key: 'inactive', icon: '😴', label: 'Inactive', hint: 'Logged in within {d} days, but did no work in them — no task made, no update or file, nothing submitted or completed.' },
  { key: 'notask', icon: '✏️', label: 'Never created a task', hint: 'Has logged in, but has never created a task.' },
  { key: 'idle', icon: '⏳', label: 'Not working on assigned tasks', hint: 'Has open tasks assigned with no update, file or submission from them for {d}+ days.' },
];
function actLabel(l, d) { return l.key === 'away' ? `Not logged in for ${d === 7 ? '1 week' : `${d} days`}` : l.label; }
// Whole days by calendar day in India: since the last login (null = never), and inactive (since the last work; with
// no work ever, since the account was made).
function actDaysSince(iso) { return iso ? Math.max(0, Math.round((Date.parse(actIstDay(Date.now())) - Date.parse(actIstDay(Date.parse(iso)))) / 864e5)) : null; }
function actLoginDays(p) { return actDaysSince(p.lastLogin); }
function actInactiveDays(p) { return actDaysSince(p.lastWork || p.createdAt) || 0; }
function actDaysBadge(n, warnAt, label) {
  if (n == null) return '<span class="act-d act-d-bad">Never</span>';
  const cls = n >= warnAt * 2 ? 'act-d-bad' : n >= warnAt ? 'act-d-warn' : 'act-d-ok';
  return `<span class="act-d ${cls}">${n === 0 ? 'Today' : `${n} day${n === 1 ? '' : 's'}`}</span>${label ? `<div class="small muted">${label}</div>` : ''}`;
}
function actTabVisible() { return typeof pageAllowed === 'function' && pageAllowed('activity'); }
function actState() { if (!ui.act) ui.act = { days: 7, list: 'all', q: '', team: '', open: {} }; return ui.act; }
function actEsc(s) { return typeof esc === 'function' ? esc(s) : String(s == null ? '' : s); }
async function actLoad(force) {
  const s = actState();
  if (actLoading || (!force && actData && actData.days === s.days)) return;
  actLoading = true;
  try { actData = await api(`/api/reports/user-activity?days=${s.days}`); }
  catch (e) { actData = { days: s.days, error: e.message, people: [] }; }
  actLoading = false;
  if (ui.adminTab === 'activity') render();
}
function actIn(p, key, d) {
  if (key === 'all') return true;
  if (key === 'never') return p.logins === 0;
  if (key === 'away') return p.logins > 0 && p.daysSinceLogin >= d;
  if (key === 'inactive') return p.logins > 0 && p.daysSinceLogin < d && (p.daysSinceWork == null || p.daysSinceWork >= d);
  if (key === 'notask') return p.logins > 0 && p.tasksCreated === 0;
  if (key === 'idle') return p.idleCount > 0;
  return false;
}
function actIstDay(ms) { return new Date(ms + 330 * 60000).toISOString().slice(0, 10); }
function actWhen(iso, n) {
  if (!iso) return '<span class="muted">Never</span>';
  // "today / yesterday / N days ago" by calendar day in India, not by 24-hour blocks.
  n = Math.round((Date.parse(actIstDay(Date.now())) - Date.parse(actIstDay(Date.parse(iso)))) / 864e5);
  const ago = n === 0 ? 'today' : n === 1 ? 'yesterday' : `${n} days ago`;
  let d = iso; try { d = new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }); } catch (e) {}
  return `${actEsc(d)} <span class="small muted">(${ago})</span>`;
}
function actRows(key) {
  const s = actState(); const d = actData.days;
  const words = String(s.q || '').toLowerCase().split(/\s+/).filter(Boolean);
  let rows = actData.people.filter(p => actIn(p, key, d))
    .filter(p => !s.team || p.team === s.team)
    .filter(p => !words.length || words.every(w => `${p.name} ${p.username} ${p.team || ''} ${p.designation || ''}`.toLowerCase().includes(w)));
  const sorters = {
    all: (a, b) => actInactiveDays(b) - actInactiveDays(a) || (actLoginDays(b) ?? 1e9) - (actLoginDays(a) ?? 1e9),
    never: (a, b) => String(a.createdAt).localeCompare(String(b.createdAt)),
    away: (a, b) => b.daysSinceLogin - a.daysSinceLogin,
    inactive: (a, b) => (b.daysSinceWork == null ? 1e9 : b.daysSinceWork) - (a.daysSinceWork == null ? 1e9 : a.daysSinceWork),
    notask: (a, b) => (a.daysSinceLogin || 0) - (b.daysSinceLogin || 0),
    idle: (a, b) => b.idleCount - a.idleCount,
  };
  return rows.sort(sorters[key]);
}
function actColumns(key) {
  const who = { h: 'Person', v: p => `<b>${actEsc(p.name)}</b><div class="small muted">${actEsc(p.username)}${p.designation ? ` · ${actEsc(p.designation)}` : ''}</div>`, csv: p => p.name };
  const user = { h: 'Username', csv: p => p.username, hide: true };
  const team = { h: 'Department', v: p => actEsc(p.team || '—'), csv: p => p.team || '' };
  const d = actData.days;
  const loginDays = { h: 'Logged in', v: p => actDaysBadge(actLoginDays(p), d, actLoginDays(p) == null ? '' : 'ago'), csv: p => actLoginDays(p) == null ? 'Never' : `${actLoginDays(p)} days ago` };
  const inactDays = { h: 'Inactive for', v: p => actDaysBadge(actInactiveDays(p), d, p.lastWork ? '' : 'no work yet'), csv: p => `${actInactiveDays(p)} days${p.lastWork ? '' : ' (no work yet)'}` };
  const login = { h: 'Last login', v: p => actWhen(p.lastLogin, p.daysSinceLogin), csv: p => p.lastLogin || 'Never' };
  const work = { h: 'Last work', v: p => actWhen(p.lastWork, p.daysSinceWork), csv: p => p.lastWork || 'None' };
  const made = { h: 'Account made', v: p => actWhen(p.createdAt, p.createdAt ? Math.floor((Date.now() - Date.parse(p.createdAt)) / 864e5) : null), csv: p => p.createdAt || '' };
  const counts = { h: 'Tasks made · updates · done', v: p => `${p.tasksCreated} · ${p.updates} · ${p.completed}`, csv: p => `${p.tasksCreated} / ${p.updates} / ${p.completed}` };
  const open = { h: 'Open tasks', v: p => String(p.openTasks), csv: p => p.openTasks, num: true };
  const idle = { h: 'Idle tasks', v: p => `<button type="button" class="btn btn-sm" data-act-open="${actEsc(p.username)}">${p.idleCount} of ${p.openTasks} ${actState().open[p.username] ? '▾' : '▸'}</button>`, csv: p => p.idleCount };
  return {
    all: [who, user, team, loginDays, inactDays, login, work, counts, open],
    never: [who, user, team, loginDays, inactDays, made, open],
    away: [who, user, team, loginDays, inactDays, login, work, open],
    inactive: [who, user, team, loginDays, inactDays, login, work, counts, open],
    notask: [who, user, team, loginDays, inactDays, login, work, counts],
    idle: [who, user, team, loginDays, inactDays, login, work, open, idle],
  }[key];
}
function actIdleList(p) {
  return `<div class="act-idle">${p.idleTasks.map(t => `<div class="act-idle-row"><span>${actEsc(t.title)}</span>
    <span class="small muted">${t.project ? `${actEsc(t.project)} · ` : ''}${t.lastTouch ? `last update by them ${t.idleDays} days ago` : `nothing from them in ${t.idleDays} days`}${t.deadline ? ` · due ${actEsc(String(t.deadline).slice(0, 10))}` : ''}</span></div>`).join('')}
    ${p.idleCount > p.idleTasks.length ? `<div class="small muted">…and ${p.idleCount - p.idleTasks.length} more</div>` : ''}</div>`;
}

function renderActivityView() {
  const s = actState();
  if (!actData || actData.days !== s.days) { setTimeout(() => actLoad(), 0); if (!actData) return '<div class="empty">Loading…</div>'; }
  if (actData.error) return `<div class="err">${actEsc(actData.error)}</div>`;
  const d = actData.days;
  const teams = [...new Set(actData.people.map(p => p.team).filter(Boolean))].sort();
  const list = ACT_LISTS.find(l => l.key === s.list) || ACT_LISTS[0];
  const rows = actRows(list.key);
  const cols = actColumns(list.key).filter(c => !c.hide);
  const total = (k) => actData.people.filter(p => actIn(p, k, d) && (!s.team || p.team === s.team)).length;
  const people = actData.people.filter(p => !s.team || p.team === s.team).length;
  return `
  <div class="card">
    <div class="act-top">
      <div><b>User activity</b> <span class="small muted">· ${people} people${s.team ? ` in ${actEsc(s.team)}` : ''} (Admin accounts not counted)</span></div>
      <div class="act-days">Period: ${[3, 7, 15, 30].map(n => `<button type="button" class="btn btn-sm ${d === n ? 'btn-primary' : ''}" data-act-days="${n}">${n} days</button>`).join('')}</div>
    </div>
    <div class="act-tiles">${ACT_LISTS.map(l => `<button type="button" class="act-tile ${l.key === list.key ? 'active' : ''}" data-act-list="${l.key}">
      <span class="act-tile-n">${total(l.key)}</span><span class="act-tile-l">${l.icon} ${actLabel(l, d)}</span></button>`).join('')}</div>
    <div class="act-filters">
      <input type="search" id="act-q" placeholder="Search name, username or department…" value="${actEsc(s.q)}" autocomplete="off">
      <select id="act-team"><option value="">All departments</option>${teams.map(t => `<option value="${actEsc(t)}" ${s.team === t ? 'selected' : ''}>${actEsc(t)}</option>`).join('')}</select>
      <div class="act-btns"><button type="button" class="btn btn-sm btn-primary" data-act-pdf>📄 PDF of all lists</button><button type="button" class="btn btn-sm" data-act-csv>⬇ This list (Excel)</button></div>
    </div>
  </div>
  <div class="card">
    <div class="act-list-head"><b>${list.icon} ${actLabel(list, d)}</b> <span class="pill-count">${rows.length}</span>
      <div class="small muted">${actEsc(list.hint.replace('{d}', d))}</div></div>
    ${rows.length ? `<div class="dpr-table-wrap"><table class="dpr-table act-table"><thead><tr>${cols.map(c => `<th>${c.h}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(p => `<tr>${cols.map(c => `<td>${c.v(p)}</td>`).join('')}</tr>${list.key === 'idle' && s.open[p.username] ? `<tr class="act-sub"><td colspan="${cols.length}">${actIdleList(p)}</td></tr>` : ''}`).join('')}</tbody></table></div>`
      : '<div class="empty">Nobody in this list 🎉</div>'}
    <div class="small muted" style="margin-top:8px;">Logins are counted from the app's login records. "Work" = creating a task, posting an update or file, submitting or completing a part, or any other recorded action (approvals, deliveries, DPR…). Updated ${actEsc(new Date(actData.generatedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }))}.</div>
  </div>`;
}

function actCsv() {
  const s = actState(); const list = ACT_LISTS.find(l => l.key === s.list) || ACT_LISTS[0];
  const cols = actColumns(list.key);
  const rows = actRows(list.key);
  const cell = (v) => { const t = String(v == null ? '' : v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const lines = [cols.map(c => cell(c.h)).join(',')].concat(rows.map(p => cols.map(c => cell(c.csv(p))).join(',')));
  if (list.key === 'idle') { lines.push('', 'Person,Task,Project,Days with nothing from them'); rows.forEach(p => p.idleTasks.forEach(t => lines.push([p.name, t.title, t.project || '', t.idleDays].map(cell).join(',')))); }
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = `${list.label.replace(/\s+/g, '-')}-${actData.days}days-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

// One printable report of every list (Save as PDF from the print window) — to share with Admin.
// Always includes "Not logged in for 1 week"; the other lists use the period chosen on the page.
function actPdf() {
  if (!actData || !actData.people) return;
  const s = actState(); const d = actData.days;
  const scope = actData.people.filter(p => !s.team || p.team === s.team);
  const plain = (iso) => { if (!iso) return 'Never'; try { return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }); } catch (e) { return iso; } };
  const ago = (iso) => { if (!iso) return ''; const n = Math.round((Date.parse(actIstDay(Date.now())) - Date.parse(actIstDay(Date.parse(iso)))) / 864e5); return n === 0 ? 'today' : n === 1 ? 'yesterday' : `${n} days ago`; };
  const when = (iso) => iso ? `${actEsc(plain(iso))}<br><span class="m">${ago(iso)}</span>` : '<span class="m">Never</span>';
  const sorted = (key) => { const keep = ui.act; ui.act = { ...s, list: key, q: '' }; const r = actRows(key); ui.act = keep; return r; };
  const week = scope.filter(p => p.logins > 0 && p.daysSinceLogin >= 7).sort((a, b) => b.daysSinceLogin - a.daysSinceLogin);
  const sections = [
    { title: '🚫 Never logged in', hint: 'Account made, but never logged in.', rows: sorted('never'), cols: [['Account made', p => when(p.createdAt)], ['Open tasks', p => p.openTasks]] },
    { title: '💤 Not logged in for 1 week', hint: 'Logged in before, but not in the last 7 days.', rows: week, cols: [['Last login', p => when(p.lastLogin)], ['Last work', p => when(p.lastWork)], ['Open tasks', p => p.openTasks]] },
    ...(d !== 7 ? [{ title: `💤 Not logged in for ${d} days`, hint: `Logged in before, but not in the last ${d} days.`, rows: sorted('away'), cols: [['Last login', p => when(p.lastLogin)], ['Last work', p => when(p.lastWork)], ['Open tasks', p => p.openTasks]] }] : []),
    { title: '😴 Inactive', hint: `Logged in within ${d} days, but did no work in them (no task made, no update or file, nothing submitted or completed).`, rows: sorted('inactive'), cols: [['Last login', p => when(p.lastLogin)], ['Last work', p => when(p.lastWork)], ['Tasks made · updates · done', p => `${p.tasksCreated} · ${p.updates} · ${p.completed}`]] },
    { title: '✏️ Logged in, never created a task', hint: 'Has logged in, but has never created a task.', rows: sorted('notask'), cols: [['Last login', p => when(p.lastLogin)], ['Last work', p => when(p.lastWork)], ['Updates · done', p => `${p.updates} · ${p.completed}`]] },
    { title: '⏳ Not working on assigned tasks', hint: `Open tasks assigned to them with no update, file or submission from them for ${d}+ days.`, rows: sorted('idle'), cols: [['Last work', p => when(p.lastWork)], ['Idle tasks', p => `${p.idleCount} of ${p.openTasks}`]], tasks: true },
  ];
  const dd = (n, empty) => n == null ? `<b>${empty || 'Never'}</b>` : `<b>${n === 0 ? 'Today' : `${n} day${n === 1 ? '' : 's'}`}</b>`;
  const dayCols = [['Logged in', p => `${dd(actLoginDays(p))}${actLoginDays(p) == null ? '' : '<br><span class="m">ago</span>'}`], ['Inactive for', p => `${dd(actInactiveDays(p))}${p.lastWork ? '' : '<br><span class="m">no work yet</span>'}`]];
  sections.forEach(x => { x.cols = dayCols.concat(x.cols); });
  sections.push({ title: '👥 Everyone', hint: 'Everybody, longest inactive first: days since the last login and days without any work.', rows: sorted('all'),
    cols: dayCols.concat([['Last login', p => when(p.lastLogin)], ['Last work', p => when(p.lastWork)], ['Tasks made · updates · done', p => `${p.tasksCreated} · ${p.updates} · ${p.completed}`]]) });
  const now = new Date();
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>User activity report ${actEsc(now.toISOString().slice(0, 10))}</title><style>
    *{box-sizing:border-box} body{-webkit-print-color-adjust:exact;print-color-adjust:exact;font-family:Arial,Helvetica,sans-serif;color:#1d2433;margin:0;padding:24px;font-size:12px}
    h1{font-size:20px;margin:0 0 2px} .m{color:#6b7280;font-size:11px} .sub{color:#6b7280;margin-bottom:14px}
    .sum{width:100%;border-collapse:collapse;margin:8px 0 18px} .sum td{border:1px solid #d7dce4;padding:6px 8px} .sum td.n{text-align:right;font-weight:700;width:70px;font-size:14px}
    h2{page-break-after:avoid;font-size:15px;margin:18px 0 2px;padding-top:6px;border-top:2px solid #2D5FA8} h2 .c{background:#2D5FA8;color:#fff;border-radius:10px;padding:1px 8px;font-size:11px;margin-left:6px}
    table.t{width:100%;border-collapse:collapse;margin-top:6px} .t th{text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.3px;color:#6b7280;border-bottom:1px solid #9aa3b2;padding:5px 6px}
    .t td{border-bottom:1px solid #e3e6ec;padding:5px 6px;vertical-align:top} .t tr{page-break-inside:avoid} .none{color:#15803d;padding:6px 0}
    .tasks{margin:2px 0 0;padding-left:14px} .tasks li{margin:1px 0}
    .foot{margin-top:20px;color:#6b7280;font-size:10px} @page{size:A4;margin:12mm} @media print{body{padding:0}}
  </style></head><body>
    <h1>MIHIR Task Manager — User activity report</h1>
    <div class="sub">${actEsc(now.toLocaleString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }))} · Period: last ${d} days · ${scope.length} people${s.team ? ` in ${actEsc(s.team)}` : ''} (Admin accounts not counted)</div>
    <table class="sum">${sections.map(x => `<tr><td>${x.title}</td><td class="n">${x.rows.length}</td></tr>`).join('')}</table>
    ${sections.map(x => `<h2>${x.title}<span class="c">${x.rows.length}</span></h2><div class="m">${actEsc(x.hint)}</div>
      ${x.rows.length ? `<table class="t"><thead><tr><th>#</th><th>Name</th><th>Username</th><th>Department</th>${x.cols.map(c => `<th>${c[0]}</th>`).join('')}</tr></thead><tbody>
      ${x.rows.map((p, i) => `<tr><td>${i + 1}</td><td><b>${actEsc(p.name)}</b>${p.designation ? `<br><span class="m">${actEsc(p.designation)}</span>` : ''}${x.tasks && p.idleTasks.length ? `<ul class="tasks">${p.idleTasks.map(t => `<li>${actEsc(t.title)} <span class="m">— ${t.idleDays} days${t.project ? ` · ${actEsc(t.project)}` : ''}</span></li>`).join('')}${p.idleCount > p.idleTasks.length ? `<li class="m">…and ${p.idleCount - p.idleTasks.length} more</li>` : ''}</ul>` : ''}</td><td>${actEsc(p.username)}</td><td>${actEsc(p.team || '—')}</td>${x.cols.map(c => `<td>${c[1](p)}</td>`).join('')}</tr>`).join('')}
      </tbody></table>` : '<div class="none">Nobody in this list.</div>'}`).join('')}
    <div class="foot">Logins come from the app's login records. "Work" = creating a task, posting an update or file, submitting or completing a part, or any other recorded action (approvals, deliveries, DPR…).</div>
  </body></html>`;
  const w = window.open('', '_blank');
  if (!w) { if (typeof setBanner === 'function') { setBanner('Allow pop-ups to save the PDF.'); render(); } return; }
  w.document.write(html); w.document.close();
  setTimeout(() => { try { w.focus(); w.print(); } catch (e) {} }, 400);
}

function bindActivityView() {
  const s = actState();
  document.querySelectorAll('[data-act-days]').forEach(b => { b.onclick = () => { s.days = Number(b.dataset.actDays); render(); actLoad(true); }; });
  document.querySelectorAll('[data-act-list]').forEach(b => { b.onclick = () => { s.list = b.dataset.actList; render(); }; });
  document.querySelectorAll('[data-act-open]').forEach(b => { b.onclick = () => { s.open[b.dataset.actOpen] = !s.open[b.dataset.actOpen]; render(); }; });
  document.querySelectorAll('[data-act-csv]').forEach(b => { b.onclick = actCsv; });
  document.querySelectorAll('[data-act-pdf]').forEach(b => { b.onclick = actPdf; });
  const q = document.getElementById('act-q');
  if (q && !q.dataset.bound) { q.dataset.bound = '1'; let t = null; q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { s.q = q.value; render(); }, 180); }); }
  const tm = document.getElementById('act-team');
  if (tm) tm.onchange = () => { s.team = tm.value; render(); };
}
