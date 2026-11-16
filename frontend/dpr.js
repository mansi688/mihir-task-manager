/* Daily Progress page (DPR) — work done and material in / out at site, day by day, with time stamps.
   Admin, the site team (Execution), Store and Purchase see it; Admin, site and Store add entries and import the
   site's Excel; Purchase reads. Data: GET /api/dpr?from&to&project (loaded while the page is open).
   Loaded after payables.js and before app.js. */

let dprData = null;
let dprLoading = false;
const DPR_KINDS = { work: 'Work progress', inward: 'Material inward', outward: 'Material outward' };
const DPR_ICON = { work: '🏗', inward: '📥', outward: '📤' };
const DPR_PARTY = { work: 'Contractor / agency', inward: 'Received from', outward: 'Issued to' };
const DPR_REF = { work: 'Ref', inward: 'Challan / GRN no.', outward: 'Gate pass / ref' };
function dprEsc(s) { return typeof esc === 'function' ? esc(s) : String(s == null ? '' : s); }
function dprTabVisible() {
  if (!session) return false;
  return session.role === 'admin' || /execution|site|store|purchase/i.test(String(session.team || ''));
}
function dprToday() { return typeof istDayKey === 'function' ? istDayKey(new Date().toISOString()) : new Date().toISOString().slice(0, 10); }
function dprAddDays(ymd, n) { const [y, m, d] = String(ymd).split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); }
function dprDay(ymd) { try { return new Date(`${ymd}T12:00:00+05:30`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }); } catch (e) { return ymd; } }
function dprNum(n) { return n == null || n === '' ? '' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: 3 }); }
function dprNowHM() { const d = new Date(Date.now() + 330 * 60000); return d.toISOString().slice(11, 16); }
function dprState() {
  if (!ui.dpr) { const t = dprToday(); ui.dpr = { from: dprAddDays(t, -6), to: t, project: '', kind: 'all', q: '', form: null, imp: null }; }
  return ui.dpr;
}
function dprKey() { const s = dprState(); return `${s.from}|${s.to}|${s.project}`; }
function dprMe() { return (dprData && dprData.me) || { canEdit: false }; }
async function dprLoad(force) {
  const s = dprState(); const key = dprKey();
  if (dprLoading || (!force && dprData && dprData.key === key)) return;
  dprLoading = true;
  try {
    const d = await api(`/api/dpr?from=${s.from}&to=${s.to}${s.project ? `&project=${encodeURIComponent(s.project)}` : ''}`);
    dprData = { ...d, key };
  } catch (e) { dprData = { key, error: e.message, reports: [], materials: [] }; }
  dprLoading = false;
  if (ui.adminTab === 'dpr') render();
}
function dprMatches(e) {
  const s = dprState();
  if (s.kind !== 'all' && s.kind !== 'materials' && e.kind !== s.kind) return false;
  const words = String(s.q || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [e.item, e.description, e.party, e.ref, e.location, e.remarks, e.unit, e.created_by_name, e.created_by, DPR_KINDS[e.kind]].filter(Boolean).join(' ').toLowerCase();
  return words.every(w => hay.includes(w));
}
function dprEntryTable(kind, list, me) {
  if (!list.length) return '';
  return `<div class="dpr-kind"><div class="dpr-kind-head">${DPR_ICON[kind]} ${DPR_KINDS[kind]} <span class="small muted">${list.length}</span></div>
    <div class="dpr-table-wrap"><table class="dpr-table"><thead><tr><th>Time</th><th>${kind === 'work' ? 'Activity' : 'Material'}</th><th class="num">Qty</th><th>Unit</th><th>${DPR_PARTY[kind]}</th><th>${DPR_REF[kind]}</th><th>Location</th><th>Remarks</th><th>By</th><th></th></tr></thead>
    <tbody>${list.map(e => `<tr>
      <td class="mono">${dprEsc(e.at_time || '—')}</td>
      <td><b>${dprEsc(e.item)}</b>${e.description ? `<div class="small muted">${dprEsc(e.description)}</div>` : ''}</td>
      <td class="num">${dprNum(e.qty)}</td><td>${dprEsc(e.unit || '')}</td>
      <td>${kind === 'outward' ? `<b>${dprEsc(e.party || '')}</b>` : dprEsc(e.party || '')}</td>
      <td class="mono small">${dprEsc(e.ref || '')}</td><td class="small">${dprEsc(e.location || '')}</td><td class="small">${dprEsc(e.remarks || '')}</td>
      <td class="small muted" title="${dprEsc(e.source === 'import' ? 'Imported' : 'Typed')} ${dprEsc(new Date(e.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }))}">${dprEsc(e.created_by_name || e.created_by || '')}${e.source === 'import' ? ' ⬆' : ''}</td>
      <td>${me.admin || (me.canEdit && e.created_by === me.username) ? `<button type="button" class="dpr-del" data-dpr-del="${e.id}" title="Remove this entry">✕</button>` : ''}</td>
    </tr>`).join('')}</tbody></table></div></div>`;
}
function dprFormHTML() {
  const f = dprState().form; if (!f) return '';
  const projects = (dprData && dprData.projects) || PROJECT_OPTIONS;
  const k = f.kind || 'work';
  const inp = (id, key, label, ph = '', type = 'text', extra = '') => `<div class="col"><label for="${id}">${label}</label><input type="${type}" id="${id}" data-dprf="${key}" value="${dprEsc(f[key] == null ? '' : f[key])}" placeholder="${dprEsc(ph)}" ${extra}></div>`;
  return `<div class="card dpr-form" id="dpr-form">
    <div class="flex-between" style="gap:8px;flex-wrap:wrap;"><div class="card-title" style="margin:0;">Add to the DPR</div><button class="btn btn-sm" data-dpr-act="form-cancel">Cancel</button></div>
    <div class="dpr-seg">${Object.entries(DPR_KINDS).map(([key, label]) => `<button type="button" class="${k === key ? 'on' : ''}" data-dpr-kind-form="${key}">${DPR_ICON[key]} ${label}</button>`).join('')}</div>
    <div class="row">
      <div class="col"><label for="dprf-project">Project *</label><select id="dprf-project" data-dprf="project"><option value="">— pick —</option>${projects.map(p => `<option ${f.project === p ? 'selected' : ''}>${dprEsc(p)}</option>`).join('')}</select></div>
      ${inp('dprf-date', 'date', 'Date *', '', 'date', `max="${dprToday()}"`)}
      ${inp('dprf-time', 'time', 'Time', '', 'time')}
    </div>
    <div class="row">
      ${inp('dprf-item', 'item', k === 'work' ? 'Activity *' : 'Material *', k === 'work' ? 'e.g. Block work 150 mm' : 'e.g. Cement OPC 53')}
      ${inp('dprf-qty', 'qty', 'Qty', '', 'number', 'step="any" min="0"')}
      ${inp('dprf-unit', 'unit', 'Unit', 'bags / MT / sqm / cum / nos')}
    </div>
    <div class="row">
      ${inp('dprf-party', 'party', `${DPR_PARTY[k]}${k === 'outward' ? ' *' : ''}`, k === 'outward' ? 'Person or contractor the material was given to' : k === 'inward' ? 'Supplier / vendor' : 'Contractor or team')}
      ${inp('dprf-ref', 'ref', DPR_REF[k], k === 'inward' ? 'e.g. GT-4411' : k === 'outward' ? 'e.g. GP-118' : '')}
      ${inp('dprf-location', 'location', 'Location', 'Tower / floor / area')}
    </div>
    ${inp('dprf-remarks', 'remarks', 'Remarks', '')}
    ${f.err ? `<div class="err">${dprEsc(f.err)}</div>` : ''}
    <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;"><button class="btn btn-primary" data-dpr-act="save" ${f.saving ? 'disabled' : ''}>${f.saving ? 'Saving…' : 'Save entry'}</button>
      <button class="btn" data-dpr-act="save-next" ${f.saving ? 'disabled' : ''}>Save and add another</button></div>
  </div>`;
}
function dprImportHTML() {
  const im = dprState().imp; if (!im) return '';
  const projects = (dprData && dprData.projects) || PROJECT_OPTIONS;
  const r = im.result;
  return `<div class="card dpr-form" id="dpr-import">
    <div class="flex-between" style="gap:8px;flex-wrap:wrap;"><div class="card-title" style="margin:0;">⬆ Import the site's DPR (Excel / CSV)</div><button class="btn btn-sm" data-dpr-act="imp-cancel">Close</button></div>
    <div class="small muted" style="margin-bottom:8px;">Sheets named Work progress / Material inward / Material outward — or one sheet with a <b>Type</b> column. Material / Activity is the only column that must be there; time, qty, unit, issued to, challan / gate pass, location and remarks are picked up when present. <a href="#" data-dpr-act="template">Download the template</a>.</div>
    <div class="row">
      <div class="col"><label>Project <span class="muted small">(if the file does not say)</span></label><select id="dpri-project"><option value="">—</option>${projects.map(p => `<option ${im.project === p ? 'selected' : ''}>${dprEsc(p)}</option>`).join('')}</select></div>
      <div class="col"><label>Date <span class="muted small">(if the file does not say)</span></label><input type="date" id="dpri-date" value="${dprEsc(im.date || '')}" max="${dprToday()}"></div>
      <div class="col"><label>File</label><label class="btn btn-sm" style="display:inline-block;">📎 ${im.fileName ? dprEsc(im.fileName) : 'Choose the Excel / CSV'}<input type="file" id="dpri-file" accept=".xlsx,.xlsm,.csv" hidden></label></div>
    </div>
    ${im.err ? `<div class="err">${dprEsc(im.err)}</div>` : ''}
    ${im.busy ? '<div class="small muted">Reading the file…</div>' : ''}
    ${r ? `<div class="dpr-preview">
      ${r.saved ? `<div class="notice">✅ Saved ${r.added} entr${r.added === 1 ? 'y' : 'ies'}${r.duplicates ? ` — ${r.duplicates} were already there and were skipped` : ''}.</div>` : `<div><b>${r.rows}</b> row${r.rows === 1 ? '' : 's'} read from ${dprEsc((r.sheetsRead || []).join(', '))}${(r.sheetsSkipped || []).length ? ` <span class="small muted">(skipped: ${dprEsc(r.sheetsSkipped.join(', '))})</span>` : ''}</div>`}
      <table class="dpr-table" style="margin-top:6px;"><thead><tr><th>Date</th><th>Project</th><th class="num">🏗 Work</th><th class="num">📥 Inward</th><th class="num">📤 Outward</th></tr></thead>
        <tbody>${(r.days || []).map(d => `<tr><td>${dprEsc(dprDay(d.date))}</td><td>${dprEsc(d.project)}</td><td class="num">${d.work}</td><td class="num">${d.inward}</td><td class="num">${d.outward}</td></tr>`).join('')}</tbody></table>
      ${(r.warnings || []).length ? `<details class="small" style="margin-top:6px;"><summary>⚠ ${r.warnings.length} note${r.warnings.length > 1 ? 's' : ''}</summary>${r.warnings.map(w => `<div>${dprEsc(w)}</div>`).join('')}</details>` : ''}
      ${r.saved ? '' : `<div style="margin-top:8px;"><button class="btn btn-primary" data-dpr-act="imp-save" ${im.busy ? 'disabled' : ''}>Save these ${r.rows} rows</button></div>`}
    </div>` : ''}
  </div>`;
}
function renderDprView() {
  const s = dprState(); const me = dprMe();
  if (!dprData || dprData.key !== dprKey()) setTimeout(() => dprLoad(), 0);
  const reports = (dprData && dprData.reports) || [];
  const t = dprToday();
  const range = (label, from, to) => `<button type="button" class="btn btn-sm ${s.from === from && s.to === to ? 'btn-primary' : ''}" data-dpr-range="${from}|${to}">${label}</button>`;
  const tabs = [['all', 'All'], ['work', '🏗 Work'], ['inward', '📥 Inward'], ['outward', '📤 Outward'], ['materials', '📦 Material totals']];
  const counts = { work: 0, inward: 0, outward: 0 };
  reports.forEach(r => r.entries.forEach(e => { counts[e.kind]++; }));
  let body = '';
  if (!dprData) body = '<div class="empty">Loading…</div>';
  else if (dprData.error) body = `<div class="err">${dprEsc(dprData.error)}</div>`;
  else if (s.kind === 'materials') {
    const words = String(s.q || '').toLowerCase().split(/\s+/).filter(Boolean);
    const mats = (dprData.materials || []).filter(m => !words.length || words.every(w => `${m.item} ${m.unit}`.toLowerCase().includes(w)));
    body = mats.length ? `<div class="card"><div class="small muted" style="margin-bottom:6px;">Material received and issued in this period${s.project ? ` at ${dprEsc(s.project)}` : ' (all projects)'}.</div>
      <div class="dpr-table-wrap"><table class="dpr-table"><thead><tr><th>Material</th><th>Unit</th><th class="num">📥 Received</th><th class="num">📤 Issued</th><th class="num">Received − issued</th></tr></thead>
      <tbody>${mats.map(m => `<tr><td><b>${dprEsc(m.item)}</b></td><td>${dprEsc(m.unit)}</td><td class="num">${dprNum(m.inward)} <span class="small muted">(${m.inCount})</span></td><td class="num">${dprNum(m.outward)} <span class="small muted">(${m.outCount})</span></td><td class="num ${m.net < 0 ? 'dpr-neg' : ''}">${dprNum(m.net)}</td></tr>`).join('')}</tbody></table></div></div>`
      : '<div class="empty">No material moved in this period.</div>';
  } else {
    const shown = reports.map(r => ({ r, list: r.entries.filter(dprMatches) })).filter(x => x.list.length);
    body = shown.length ? shown.map(({ r, list }) => {
      const by = { work: list.filter(e => e.kind === 'work'), inward: list.filter(e => e.kind === 'inward'), outward: list.filter(e => e.kind === 'outward') };
      return `<div class="card dpr-report">
        <div class="dpr-report-head"><div><b>📅 ${dprEsc(dprDay(r.report_date))}</b> · ${dprEsc(r.project)}</div>
          <div class="dpr-chips">${Object.keys(DPR_KINDS).map(k => `<span class="bud-chip">${DPR_ICON[k]} ${r.entries.filter(e => e.kind === k).length}</span>`).join('')}
            ${me.admin ? `<button type="button" class="btn btn-sm btn-danger" data-dpr-delrep="${r.id}" title="Delete this whole day's report">🗑</button>` : ''}</div></div>
        ${r.source_file ? `<div class="small muted">Imported from ${dprEsc(r.source_file)}</div>` : ''}
        ${dprEntryTable('work', by.work, me)}${dprEntryTable('inward', by.inward, me)}${dprEntryTable('outward', by.outward, me)}
      </div>`;
    }).join('') : `<div class="empty">No DPR entries ${s.q ? 'match your search ' : ''}in this period.${me.canEdit ? ' Tap “+ Add entry” or “⬆ Import”.' : ''}</div>`;
  }
  return `
  <div class="card">
    <div class="flex-between" style="gap:8px;flex-wrap:wrap;">
      <div><div class="card-title" style="margin:0;">Daily Progress Report</div><div class="small muted">Work done and material in / out at site — who it was issued to, and when.</div></div>
      ${me.canEdit ? `<div style="display:flex;gap:6px;flex-wrap:wrap;"><button class="btn btn-primary btn-sm" data-dpr-act="new">+ Add entry</button><button class="btn btn-sm" data-dpr-act="import">⬆ Import</button><button class="btn btn-sm" data-dpr-act="template">⬇ Template</button></div>` : '<span class="small muted">View only</span>'}
    </div>
    <div class="dpr-filters">
      <div><label class="small">Project</label><select id="dpr-project" data-no-qs><option value="">All projects</option>${((dprData && dprData.projects) || PROJECT_OPTIONS).map(p => `<option ${s.project === p ? 'selected' : ''}>${dprEsc(p)}</option>`).join('')}</select></div>
      <div><label class="small">From</label><input type="date" id="dpr-from" value="${dprEsc(s.from)}" max="${t}"></div>
      <div><label class="small">To</label><input type="date" id="dpr-to" value="${dprEsc(s.to)}" max="${t}"></div>
      <div class="dpr-ranges">${range('Today', t, t)}${range('7 days', dprAddDays(t, -6), t)}${range('30 days', dprAddDays(t, -29), t)}</div>
    </div>
    <input type="search" id="dpr-q" value="${dprEsc(s.q)}" placeholder="🔍 Search material, activity, issued to, challan / gate pass, location, person…" autocomplete="off" data-no-spell style="margin-top:8px;">
    <div class="dpr-tabs">${tabs.map(([k, l]) => `<button type="button" class="${s.kind === k ? 'on' : ''}" data-dpr-tab="${k}">${l}${counts[k] != null ? ` <span class="small muted">${counts[k]}</span>` : ''}</button>`).join('')}</div>
  </div>
  ${dprImportHTML()}
  ${dprFormHTML()}
  ${body}`;
}
function bindDprView() {
  const s = dprState();
  const on = (sel, fn) => document.querySelectorAll(sel).forEach(el => el.onclick = (e) => { e.preventDefault(); fn(el, e); });
  const reload = () => { render(); dprLoad(true); };
  const pj = document.getElementById('dpr-project'); if (pj) pj.onchange = () => { s.project = pj.value; reload(); };
  const fr = document.getElementById('dpr-from'); if (fr) fr.onchange = () => { if (fr.value) { s.from = fr.value; if (s.to < s.from) s.to = s.from; reload(); } };
  const to = document.getElementById('dpr-to'); if (to) to.onchange = () => { if (to.value) { s.to = to.value; if (s.from > s.to) s.from = s.to; reload(); } };
  on('[data-dpr-range]', b => { const [a, z] = b.dataset.dprRange.split('|'); s.from = a; s.to = z; reload(); });
  on('[data-dpr-tab]', b => { s.kind = b.dataset.dprTab; render(); });
  const qi = document.getElementById('dpr-q');
  if (qi) qi.oninput = () => { s.q = qi.value; const pos = qi.selectionStart; render(); const n = document.getElementById('dpr-q'); if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch (e) {} } };
  on('[data-dpr-act="template"]', async () => { try { const t = await api('/api/dpr/template'); downloadDataUrl(t.data, t.name); } catch (e) { setBanner(e.message); render(); } });
  on('[data-dpr-act="new"]', () => { s.form = { kind: 'outward', project: s.project || '', date: dprToday(), time: dprNowHM() }; s.imp = null; render(); });
  on('[data-dpr-act="form-cancel"]', () => { s.form = null; render(); });
  on('[data-dpr-act="import"]', () => { s.imp = { project: s.project || '', date: '' }; s.form = null; render(); });
  on('[data-dpr-act="imp-cancel"]', () => { s.imp = null; render(); });
  on('[data-dpr-kind-form]', b => { s.form.kind = b.dataset.dprKindForm; render(); });
  document.querySelectorAll('[data-dprf]').forEach(el => { el.oninput = el.onchange = () => { if (s.form) { s.form[el.dataset.dprf] = el.value; s.form.err = ''; } }; });
  const save = async (another) => {
    const f = s.form; if (!f || f.saving) return;
    if (!f.project) { f.err = 'Pick the project.'; render(); return; }
    if (!String(f.item || '').trim()) { f.err = f.kind === 'work' ? 'Write the activity.' : 'Write the material.'; render(); return; }
    if (f.kind === 'outward' && !String(f.party || '').trim()) { f.err = 'Write who the material was issued to.'; render(); return; }
    f.saving = true; render();
    try {
      await api('/api/dpr/entries', { method: 'POST', body: JSON.stringify({ project: f.project, date: f.date, kind: f.kind, time: f.time, item: f.item, qty: f.qty, unit: f.unit, party: f.party, ref: f.ref, location: f.location, remarks: f.remarks }) });
      setBanner('Saved to the DPR.', 'ok');
      s.form = another ? { kind: f.kind, project: f.project, date: f.date, time: dprNowHM(), unit: '' } : null;
      if (s.project && s.project !== f.project) s.project = '';
      await dprLoad(true);
    } catch (e) { f.saving = false; f.err = e.message; render(); }
  };
  on('[data-dpr-act="save"]', () => save(false));
  on('[data-dpr-act="save-next"]', () => save(true));
  on('[data-dpr-del]', async b => {
    if (!confirmAction('Remove this entry from the DPR?')) return;
    try { await api(`/api/dpr/entries/${b.dataset.dprDel}`, { method: 'DELETE' }); setBanner('Entry removed.', 'ok'); await dprLoad(true); } catch (e) { setBanner(e.message); render(); }
  });
  on('[data-dpr-delrep]', async b => {
    if (!confirmAction("Delete this whole day's report and all its entries?")) return;
    try { await api(`/api/dpr/reports/${b.dataset.dprDelrep}`, { method: 'DELETE' }); setBanner('Report deleted.', 'ok'); await dprLoad(true); } catch (e) { setBanner(e.message); render(); }
  });
  // import
  const im = s.imp;
  if (im) {
    const ip = document.getElementById('dpri-project'); if (ip) ip.onchange = () => { im.project = ip.value; };
    const id = document.getElementById('dpri-date'); if (id) id.onchange = () => { im.date = id.value; };
    const send = async (confirm) => {
      im.busy = true; im.err = ''; render();
      try {
        const r = await api('/api/dpr/import', { method: 'POST', body: JSON.stringify({ fileData: im.fileData, fileName: im.fileName, project: im.project, date: im.date, confirm }) });
        im.result = confirm ? { ...im.result, ...r, saved: true } : r;
        if (confirm) { setBanner(`DPR imported — ${r.added} entr${r.added === 1 ? 'y' : 'ies'} added.`, 'ok'); await dprLoad(true); }
      } catch (e) { im.err = e.message; }
      im.busy = false; render();
    };
    const fi = document.getElementById('dpri-file');
    if (fi) fi.onchange = () => {
      const file = fi.files && fi.files[0]; if (!file) return;
      const rd = new FileReader();
      rd.onload = () => { im.fileData = rd.result; im.fileName = file.name; im.result = null; send(false); };
      rd.onerror = () => { im.err = 'The file could not be read — choose it again.'; render(); };
      rd.readAsDataURL(file);
    };
    on('[data-dpr-act="imp-save"]', () => send(true));
  }
}
function confirmAction(msg) { try { return window.confirm(msg); } catch (e) { return true; } }
