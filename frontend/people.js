/* People: front-page celebrations & who's out, the People directory page (HR edits dates, imports a list, decides
   attendance requests) and the "Raise Request" form (fix a missed clock-out / wrong time).
   Data: /api/people/*, /api/attendance/requests*. Loaded after payroll.js, before app.js uses it. */
let ppOverview = null, ppOverviewAt = 0, ppOverviewBusy = false;
let ppDir = null, ppReqs = null, ppReqsBusy = false;
function ppState() { if (!ui.pp) ui.pp = { q: '', edit: null, req: null, importText: '', importMsg: '', msg: '' }; return ui.pp; }
const ppEsc = (s) => typeof esc === 'function' ? esc(s) : String(s == null ? '' : s);
const ppDM = (md) => { try { return new Date(`2000-${md}T12:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }); } catch (e) { return md; } };
const ppDay = (d) => { try { return new Date(`${d}T12:00:00+05:30`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }); } catch (e) { return d; } };
const ppInitials = (n) => String(n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
async function ppLoadOverview(force) {
  if (ppOverviewBusy || (!force && ppOverview && Date.now() - ppOverviewAt < 300000)) return;
  ppOverviewBusy = true;
  try { ppOverview = await api('/api/people/overview'); ppOverviewAt = Date.now(); } catch (e) { ppOverview = ppOverview || { error: e.message }; }
  ppOverviewBusy = false; render();
}
async function ppLoadDir(force) { if (!force && ppDir) return; try { ppDir = await api('/api/people/directory'); } catch (e) { ppDir = { error: e.message, list: [] }; } render(); }
async function ppLoadReqs(force) {
  if (ppReqsBusy || (!force && ppReqs)) return; ppReqsBusy = true;
  try { ppReqs = await api('/api/attendance/requests'); } catch (e) { ppReqs = { error: e.message, mine: [], waiting: [] }; }
  ppReqsBusy = false; render();
}
// ---------- front page: celebrations + who's out
function peopleFrontHTML() {
  if (!ppOverview) { setTimeout(() => ppLoadOverview(), 0); return ''; }
  else if (Date.now() - ppOverviewAt > 300000) setTimeout(() => ppLoadOverview(true), 0);
  const o = ppOverview; if (o.error) return '';
  const cel = (o.celebrations || []).filter(c => c.inDays <= 7);
  const todayC = cel.filter(c => c.inDays === 0), soon = cel.filter(c => c.inDays > 0).slice(0, 5);
  const line = (c) => `<div class="pp-row"><span class="pp-av">${c.type === 'birthday' ? '🎂' : '🎉'}</span><div><b>${ppEsc(c.name)}</b><div class="small muted">${c.type === 'birthday' ? 'Birthday' : `${c.years} year${c.years === 1 ? '' : 's'} with MIHIR`} · ${c.inDays === 0 ? '<b>Today</b>' : c.inDays === 1 ? 'Tomorrow' : ppEsc(ppDay(c.day))}</div></div></div>`;
  const out = o.outToday || [];
  return `<div class="card pp-front">
    <div class="pp-cols">
      <div><div class="card-title" style="margin:0 0 6px;">🎈 Celebrations</div>
        ${todayC.length ? todayC.map(line).join('') : '<div class="small muted">No birthdays or anniversaries today.</div>'}
        ${soon.length ? `<div class="small muted" style="margin:8px 0 2px;">Coming up</div>${soon.map(line).join('')}` : ''}</div>
      <div><div class="card-title" style="margin:0 0 6px;">🌴 Who's out today</div>
        ${o.holidayToday ? `<div class="pp-holiday">🎊 Holiday today — <b>${ppEsc(o.holidayToday)}</b></div>` : o.weeklyOffToday ? '<div class="small muted">Weekly off today.</div>' : ''}
        ${out.length ? out.map(l => `<div class="pp-row"><span class="pp-av">${ppEsc(ppInitials(l.name))}</span><div><b>${ppEsc(l.name)}</b><div class="small muted">${l.half ? 'Half day' : 'On'} leave${l.to > o.today ? ` · until ${ppEsc(ppDay(String(l.to)))}` : ''}${l.team ? ` · ${ppEsc(l.team)}` : ''}</div></div></div>`).join('') : (o.holidayToday || o.weeklyOffToday ? '' : '<div class="small muted">Everyone is in today.</div>')}
        ${(o.holidays || []).length ? `<div class="small muted" style="margin:8px 0 2px;">Next holidays</div>${o.holidays.slice(0, 3).map(h => `<div class="small">🗓 ${ppEsc(ppDay(h.day))} — ${ppEsc(h.name)}</div>`).join('')}` : ''}</div>
    </div></div>`;
}
// ---------- Raise Request
function ppReqModalHTML() {
  const r = ppState().req; if (!r) return '';
  const kinds = { missed_out: 'Forgot to clock out', missed_in: 'Forgot to clock in', wrong_time: 'Wrong clock-in / out time', other: 'Other' };
  const today = typeof attToday === 'function' ? attToday() : new Date().toISOString().slice(0, 10);
  return `<div class="att-modal"><div class="att-modal-box" style="max-width:440px;text-align:left;">
    <div class="card-title" style="margin:0 0 8px;">Raise Request</div>
    <div class="small muted" style="margin-bottom:8px;">HR checks it and corrects your day. Give the times that were correct.</div>
    <label>Day</label><input type="date" data-pp-f="day" value="${ppEsc(r.day)}" max="${ppEsc(today)}">
    <label>What went wrong</label><select data-pp-f="kind">${Object.entries(kinds).map(([k, l]) => `<option value="${k}" ${r.kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <div class="row"><div class="col"><label>Correct clock-in</label><input type="time" data-pp-f="inTime" value="${ppEsc(r.inTime)}"></div><div class="col"><label>Correct clock-out</label><input type="time" data-pp-f="outTime" value="${ppEsc(r.outTime)}"></div></div>
    <label class="att-check"><input type="checkbox" data-pp-f="outNextDay" ${r.outNextDay ? 'checked' : ''}> Clock-out was the next morning (night work)</label>
    <label>Reason *</label><input type="text" data-pp-f="reason" maxlength="300" value="${ppEsc(r.reason)}" placeholder="e.g. Phone was off at the site, left at 6:30 pm">
    ${r.err ? `<div class="err">${ppEsc(r.err)}</div>` : ''}
    <div style="margin-top:10px;display:flex;gap:8px;"><button class="btn btn-primary btn-sm" data-pp-act="req-send" ${r.busy ? 'disabled' : ''}>${r.busy ? 'Sending…' : 'Send to HR'}</button><button class="btn btn-sm" data-pp-act="req-close">Cancel</button></div>
  </div></div>`;
}
function ppMyRequestsHTML() {
  if (!ppReqs) { setTimeout(() => ppLoadReqs(), 0); return ''; }
  const mine = ppReqs.mine || []; if (!mine.length) return '';
  return `<div class="card"><div class="card-title">My attendance requests</div><div class="att-list">${mine.slice(0, 8).map(r => `<div class="att-list-row"><div><b>${ppEsc(ppDay(r.day))}</b> · ${ppEsc(r.kindLabel)}<div class="small muted">${r.inTime ? `in ${ppEsc(r.inTime)} ` : ''}${r.outTime ? `out ${ppEsc(r.outTime)}` : ''} — ${ppEsc(r.reason)}${r.note ? ` · HR: “${ppEsc(r.note)}”` : ''}</div></div>
    <div style="display:flex;gap:6px;align-items:center;"><span class="bud-chip ${r.status === 'approved' ? 'good' : r.status === 'rejected' ? 'bad' : r.status === 'pending' ? 'warn' : ''}">${ppEsc(r.status)}</span>${r.status === 'pending' ? `<button class="btn btn-sm" data-pp-act="req-withdraw" data-id="${r.id}">Withdraw</button>` : ''}</div></div>`).join('')}</div></div>`;
}
// ---------- People page
function renderPeopleView() {
  const s = ppState();
  if (!ppDir) { setTimeout(() => ppLoadDir(), 0); return '<div class="card"><div class="empty">Loading…</div></div>'; }
  if (!ppReqs) setTimeout(() => ppLoadReqs(), 0);
  if (!ppOverview) setTimeout(() => ppLoadOverview(), 0);
  if (ppDir.error) return `<div class="card"><div class="err">${ppEsc(ppDir.error)}</div></div>`;
  const words = s.q.toLowerCase().split(/\s+/).filter(Boolean);
  const list = ppDir.list.filter(p => !words.length || words.every(w => `${p.name} ${p.username} ${p.team} ${p.designation}`.toLowerCase().includes(w)));
  const hr = ppDir.canEdit;
  const waiting = (ppReqs && ppReqs.waiting) || [];
  const cel = ((ppOverview && ppOverview.celebrations) || []).slice(0, 12);
  return `
  ${hr && waiting.length ? `<div class="card"><div class="card-title">📝 Attendance requests waiting for you <span class="badge flag">${waiting.length}</span></div><div class="att-list">${waiting.map(r => `<div class="att-list-row"><div><b>${ppEsc(r.name)}</b> · ${ppEsc(ppDay(r.day))} · ${ppEsc(r.kindLabel)}<div class="small muted">${r.inTime ? `in ${ppEsc(r.inTime)} ` : ''}${r.outTime ? `out ${ppEsc(r.outTime)}${r.outNextDay ? ' (next day)' : ''}` : ''} — ${ppEsc(r.reason)}</div></div>
      <div style="display:flex;gap:6px;"><button class="btn btn-primary btn-sm" data-pp-act="req-approve" data-id="${r.id}">Approve</button><button class="btn btn-sm" data-pp-act="req-reject" data-id="${r.id}">Reject</button></div></div>`).join('')}</div>${s.msg ? `<div class="err">${ppEsc(s.msg)}</div>` : ''}</div>` : ''}
  ${cel.length ? `<div class="card"><div class="card-title">🎈 Next 30 days</div><div class="pp-chips">${cel.map(c => `<span class="att-chip">${c.type === 'birthday' ? '🎂' : '🎉'} ${ppEsc(c.name)} · ${ppEsc(ppDay(c.day))}${c.type === 'anniversary' ? ` · ${c.years} yr` : ''}</span>`).join('')}</div></div>` : ''}
  <div class="card"><div class="flex-between" style="gap:8px;flex-wrap:wrap;"><div class="card-title" style="margin:0;">People <span class="small muted">(${list.length})</span></div>
    <input type="search" data-pp-q value="${ppEsc(s.q)}" placeholder="🔍 Search name, team, designation…" style="max-width:320px;" autocomplete="off" data-no-spell></div>
    <div class="pp-grid">${list.map(p => {
      const ed = hr && s.edit && s.edit.username === p.username;
      return `<div class="pp-person"><div class="pp-av big">${ppEsc(ppInitials(p.name))}</div><div class="pp-info"><b>${ppEsc(p.name)}</b>
        <div class="small muted">${ppEsc(p.designation || '—')}${p.team ? ` · ${ppEsc(p.team)}` : ''}</div>
        ${p.phone ? `<div class="small"><a href="tel:${ppEsc(p.phone)}">📞 ${ppEsc(p.phone)}</a></div>` : ''}${p.email ? `<div class="small">✉ ${ppEsc(p.email)}</div>` : ''}
        <div class="small muted">${p.birthday ? `🎂 ${ppEsc(ppDM(p.birthday))}` : ''}${p.joined ? ` · Joined ${ppEsc(p.joined.length === 10 ? ppDay(p.joined) : p.joined)}` : ''}</div>
        ${hr ? (ed ? `<div class="pp-edit"><label>Date of birth</label><input type="date" data-pp-e="dob" value="${ppEsc(s.edit.dob)}"><label>Joining date</label><input type="date" data-pp-e="joinDate" value="${ppEsc(s.edit.joinDate)}">
          <label>Designation</label><input type="text" data-pp-e="designation" value="${ppEsc(s.edit.designation)}" maxlength="80"><label>Phone</label><input type="text" data-pp-e="phone" value="${ppEsc(s.edit.phone)}" maxlength="30">
          ${s.edit.err ? `<div class="err">${ppEsc(s.edit.err)}</div>` : ''}<div style="display:flex;gap:6px;margin-top:6px;"><button class="btn btn-primary btn-sm" data-pp-act="edit-save">Save</button><button class="btn btn-sm" data-pp-act="edit-cancel">Cancel</button></div></div>`
          : `<button class="btn btn-sm" style="margin-top:4px;" data-pp-act="edit" data-u="${ppEsc(p.username)}">✏️ Edit</button>`) : ''}</div></div>`;
    }).join('')}</div></div>
  ${hr ? `<div class="card"><div class="card-title">Import birthdays & joining dates</div>
    <div class="small muted">One person per line: <span class="mono">username, date of birth, joining date</span> — dates as 15-08-1990 or 1990-08-15; leave one blank to keep it.</div>
    <textarea data-pp-import rows="5" style="width:100%;margin-top:6px;" placeholder="ravi.k, 15-08-1990, 01-04-2022">${ppEsc(s.importText)}</textarea>
    <button class="btn btn-primary btn-sm" style="margin-top:6px;" data-pp-act="import">Import</button>${s.importMsg ? `<div class="notice" style="margin-top:6px;white-space:pre-line;">${ppEsc(s.importMsg)}</div>` : ''}</div>` : ''}
  ${ppReqModalHTML()}`;
}
// ---------- events (one delegated listener: the page re-draws itself, so nothing is bound per element)
document.addEventListener('input', (e) => {
  const s = ppState(), t = e.target;
  if (t.matches && t.matches('[data-pp-f]') && s.req) s.req[t.dataset.ppF] = t.type === 'checkbox' ? t.checked : t.value;
  else if (t.matches && t.matches('[data-pp-e]') && s.edit) s.edit[t.dataset.ppE] = t.value;
  else if (t.matches && t.matches('[data-pp-import]')) s.importText = t.value;
  else if (t.matches && t.matches('[data-pp-q]')) { s.q = t.value; const pos = t.selectionStart; render(); const n = document.querySelector('[data-pp-q]'); if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch (x) { /* ignore */ } } }
});
document.addEventListener('change', (e) => { const t = e.target; if (t.matches && t.matches('[data-pp-f]')) { const s = ppState(); if (s.req) s.req[t.dataset.ppF] = t.type === 'checkbox' ? t.checked : t.value; } });
document.addEventListener('click', async (e) => {
  const b = e.target.closest && e.target.closest('[data-pp-act]'); if (!b) return;
  const s = ppState(), act = b.dataset.ppAct, id = b.dataset.id;
  const reload = async () => { ppReqs = null; ppDir = null; await Promise.all([ppLoadReqs(true), ppLoadDir(true), (typeof attLoad === 'function' ? attLoad(true) : null)]); };
  try {
    if (act === 'req-open') { const day = typeof attToday === 'function' ? attToday() : ''; s.req = { day, kind: 'missed_out', inTime: '', outTime: '', outNextDay: false, reason: '' }; render(); }
    else if (act === 'req-close') { s.req = null; render(); }
    else if (act === 'req-send') {
      s.req.busy = true; s.req.err = ''; render();
      try { await api('/api/attendance/requests', { method: 'POST', body: JSON.stringify(s.req) }); s.req = null; setBanner('Request sent to HR.', 'ok'); await reload(); }
      catch (x) { s.req.busy = false; s.req.err = x.message; render(); }
    } else if (act === 'req-withdraw') { await api(`/api/attendance/requests/${id}/withdraw`, { method: 'POST' }); await reload(); }
    else if (act === 'req-approve' || act === 'req-reject') {
      let note = ''; if (act === 'req-reject') { note = window.prompt('Why is it rejected? (the person will see this)') || ''; if (!note) return; }
      s.msg = ''; try { await api(`/api/attendance/requests/${id}/${act === 'req-approve' ? 'approve' : 'reject'}`, { method: 'POST', body: JSON.stringify({ note }) }); await reload(); } catch (x) { s.msg = x.message; render(); }
    } else if (act === 'edit') { const p = ppDir.list.find(x => x.username === b.dataset.u); s.edit = { username: p.username, dob: p.dob || '', joinDate: p.joinDate || '', designation: p.designation || '', phone: p.phone || '' }; render(); }
    else if (act === 'edit-cancel') { s.edit = null; render(); }
    else if (act === 'edit-save') {
      const { username, dob, joinDate, designation, phone } = s.edit;
      try { await api(`/api/people/${encodeURIComponent(username)}/profile`, { method: 'POST', body: JSON.stringify({ dob, joinDate, designation, phone }) }); s.edit = null; ppOverview = null; await reload(); }
      catch (x) { s.edit.err = x.message; render(); }
    } else if (act === 'import') {
      try { const r = await api('/api/people/dates/import', { method: 'POST', body: JSON.stringify({ text: s.importText }) }); s.importMsg = `${r.updated} updated.${r.errors.length ? '\n' + r.errors.join('\n') : ''}`; if (r.updated) { s.importText = ''; ppOverview = null; ppDir = null; ppLoadDir(true); } render(); }
      catch (x) { s.importMsg = x.message; render(); }
    }
  } catch (x) { if (typeof setBanner === 'function') setBanner(x.message); }
});
