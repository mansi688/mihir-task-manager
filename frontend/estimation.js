/* Estimation tab (JMR + Reconciliation) and Accounts Dept tab.
   Data: GET /api/estimation (estData, loaded with the page) and GET /api/estimation/summary (estSummary, for the menu
   and badge). Loaded after budget.js and before app.js; everything runs at call time, driven by ui.* state. */

let estData = null;          // { me, projects, jmr: [...], recon: [...] }
let estSummary = { canView: false };

const EST_UNITS = ['cum', 'sqm', 'rmt', 'nos', 'kg', 'MT', 'bags', 'sqft', 'cft', 'rft', 'LS', 'litre'];
const EST_STATUS = {
  draft: { label: 'Draft', cls: '' },
  submitted: { label: 'Waiting for approval', cls: 'warn' },
  approved: { label: 'Approved', cls: 'good' },
  returned: { label: 'Returned', cls: 'bad' },
};
function estEsc(s) { return typeof esc === 'function' ? esc(s) : String(s == null ? '' : s); }
function estNum(n, d = 3) { if (n == null || n === '' || !isFinite(Number(n))) return '—'; return Number(n).toLocaleString('en-IN', { maximumFractionDigits: d }); }
function estInr(n) { return n == null ? '—' : '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 }); }
function estDate(d) { if (!d) return ''; try { return new Date(String(d).length === 10 ? d + 'T12:00:00+05:30' : d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }); } catch (e) { return d; } }
function estChip(st) { const s = EST_STATUS[st] || EST_STATUS.draft; return `<span class="bud-chip ${s.cls}">${s.label}</span>`; }
function estMe() { return (estData && estData.me) || { canEdit: !!estSummary.canEdit, approveAll: !!estSummary.approveAll, headOf: estSummary.headOf || [] }; }
function estCanApprove(project) { const m = estMe(); return m.approveAll || (m.headOf || []).includes(project); }
function estState() {
  if (!ui.est) ui.est = { view: 'jmr', project: '', status: '', q: '', open: null, form: null };
  return ui.est;
}
// Menu
function estimationTabVisible() { return !!estSummary.canView; }
// Accounts Department page: the Accounts Department, the Purchase Department (and delivery access) and Admin — the server decides (apSummary.canView).
function accountsDeptTabVisible() { return !!(session.role === 'admin' || (typeof apSummary !== 'undefined' && apSummary.canView)); }
function estimationBadge() { return (estSummary.toApprove || 0) + (estSummary.returned || 0); }

// ---- maths (same as the server)
function estLineQty(l) {
  if (l.manual) return (l.deduct ? -1 : 1) * Math.abs(Number(l.qty) || 0);
  const f = [l.nos, l.length, l.breadth, l.height].filter(v => v !== '' && v != null && isFinite(Number(v))).map(Number);
  if (!f.length) return 0;
  return (l.deduct ? -1 : 1) * f.reduce((a, b) => a * b, 1);
}
const estR3 = n => Math.round(n * 1000) / 1000;
function estReconCalc(r) {
  const n = k => Number(r[k]) || 0;
  const actual = estR3(n('issued') - n('returned') - n('balance_at_site'));
  const theoretical = estR3(n('work_qty') * n('norm'));
  const allowed = estR3(theoretical * (1 + n('wastage_pct') / 100));
  const excess = estR3(Math.max(0, actual - allowed));
  const saving = estR3(Math.max(0, theoretical - actual));
  const variancePct = theoretical ? Math.round((actual - theoretical) / theoretical * 10000) / 100 : null;
  const recovery = r.rate !== '' && r.rate != null ? Math.round(excess * Number(r.rate) * 100) / 100 : null;
  return { actual, theoretical, allowed, excess, saving, variancePct, recovery };
}

// =================== Estimation tab ===================
function renderEstimationView() {
  if (!estData) return `<div class="card"><div class="small muted">Loading Estimation…</div></div>`;
  const s = estState(); const m = estMe();
  const views = [{ key: 'jmr', label: '📐 JMR', n: estData.jmr.length }, { key: 'recon', label: '⚖️ Reconciliation', n: estData.recon.length }, { key: 'summary', label: '📊 Summary' }];
  const view = views.some(v => v.key === s.view) ? s.view : 'jmr';
  const waiting = [...estData.jmr, ...estData.recon].filter(x => x.status === 'submitted' && estCanApprove(x.project)).length;
  return `
  <div class="card">
    <div class="flex-between" style="flex-wrap:wrap;gap:10px;">
      <div><div class="card-title" style="margin:0;">Estimation & Billing</div>
        <div class="small muted">JMR — joint measurement of work done (Nos × L × B × H), with previous / this / cumulative quantity. Reconciliation — material issued to a contractor against the work done, with wastage allowed and recovery.
          ${m.canEdit ? 'Write it, then send it for approval — it goes to Dnyaneshwar Kolekar and Admin.' : m.approveAll ? 'You approve these entries.' : 'You can view them.'}</div></div>
      ${m.canEdit && !s.form && !s.imp ? `<div style="display:flex;gap:8px;flex-wrap:wrap;"><button class="btn btn-primary btn-sm" data-est-act="new-jmr">+ New JMR</button><button class="btn btn-sm" data-est-act="import">⬆ Import JMR from Excel</button><button class="btn btn-sm" data-est-act="new-recon">+ New reconciliation</button></div>` : ''}
    </div>
    ${waiting ? `<div class="notice dlv-warn" style="margin-top:10px;">⏳ ${waiting} waiting for your approval.</div>` : ''}
  </div>
  ${s.imp ? estImportHTML(s.imp) : ''}
  ${s.form ? (s.form.type === 'jmr' ? estJmrFormHTML(s.form) : estReconFormHTML(s.form)) : ''}
  <div class="card">
    <div class="task-tabs" role="tablist">${views.map(v => `<button class="task-tab${view === v.key ? ' active' : ''}" data-est-view="${v.key}">${v.label}${v.n != null ? ` <span class="task-tab-count">${v.n}</span>` : ''}</button>`).join('')}</div>
    <div class="bud-filters">
      <div><label for="est-project">Project</label><select id="est-project"><option value="">All projects</option>${(estData.projects || []).map(p => `<option ${s.project === p ? 'selected' : ''}>${estEsc(p)}</option>`).join('')}</select></div>
      ${view !== 'summary' ? `<div><label for="est-status">Status</label><select id="est-status"><option value="">All</option>${Object.entries(EST_STATUS).map(([k, v]) => `<option value="${k}" ${s.status === k ? 'selected' : ''}>${v.label}</option>`).join('')}</select></div>` : ''}
      <div class="bud-search"><label for="est-q">Search</label><input type="text" id="est-q" value="${estEsc(s.q)}" placeholder="JMR / REC number, work item, contractor, location…"></div>
      ${view !== 'summary' ? `<div style="align-self:flex-end;"><button class="btn btn-sm" data-est-act="csv">⬇ CSV</button></div>` : ''}
    </div>
    ${view === 'jmr' ? estJmrListHTML() : view === 'recon' ? estReconListHTML() : estSummaryHTML()}
  </div>
  ${estViewerHTML()}`;
}
// View-only viewer for estimation files: images, PDFs (no toolbar) and Excel / CSV shown as a table — no Download button.
function estViewerHTML() {
  const v = ui.estView; if (!v) return '';
  const sh = v.sheets && v.sheets[v.sheet || 0];
  return `<div class="est-viewer" data-est-act="view-close-bg">
    <div class="est-viewer-box" data-est-act="view-stay">
      <div class="est-viewer-bar"><b>${estEsc(v.name || '')}</b><span class="small muted">View only</span><button class="btn btn-sm" data-est-act="view-close">Close</button></div>
      <div class="est-viewer-body" oncontextmenu="return false;">
        ${v.loading ? '<div class="small muted" style="padding:20px;">Opening…</div>'
          : v.kind === 'image' ? `<img src="${v.data}" alt="" draggable="false" class="est-view-img">`
          : v.kind === 'pdf' ? `<div data-morph-skip id="est-pdf-holder" class="est-pdf"></div>`
          : v.kind === 'sheet' ? `${v.sheets.length > 1 ? `<div class="dlv-subtabs" style="margin-bottom:8px;">${v.sheets.map((x, i) => `<button type="button" class="dlv-subtab${(v.sheet || 0) === i ? ' active' : ''}" data-est-sheet="${i}">${estEsc(x.name)}</button>`).join('')}</div>` : ''}
              ${sh && sh.rows.length ? `<div class="est-sheet-wrap"><table class="est-sheet"><tbody>${sh.rows.map((r, ri) => `<tr><th>${ri + 1}</th>${r.map(c => `<td>${estEsc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>${sh.more ? '<div class="small muted">Showing the first 300 rows.</div>' : ''}` : '<div class="small muted">This sheet is empty.</div>'}`
          : `<div class="small" style="padding:20px;">${estEsc(v.error || 'This file cannot be shown here.')}</div>`}
      </div>
    </div>
  </div>`;
}
async function estOpenViewer(id) {
  ui.estView = { loading: true, name: '' }; render();
  try {
    const r = await api(`/api/estimation/files/${id}/view`);
    ui.estView = { ...r, sheet: 0 };
    render();
    if (r.kind === 'pdf') {
      const bin = atob(String(r.data).split(',')[1] || ''); const arr = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([arr], { type: 'application/pdf' }));
      ui.estView.blobUrl = url;
      const h = document.getElementById('est-pdf-holder'); if (h) h.innerHTML = `<iframe src="${url}#toolbar=0&navpanes=0" title="${estEsc(r.name)}"></iframe>`;
    }
  } catch (e) { ui.estView = null; setBanner(e.message); render(); }
}
function estCloseViewer() { if (ui.estView && ui.estView.blobUrl) URL.revokeObjectURL(ui.estView.blobUrl); ui.estView = null; render(); }
function estFilter(list, fields) {
  const s = estState(); const q = (s.q || '').trim().toLowerCase();
  return list.filter(x => (!s.project || x.project === s.project) && (!s.status || x.status === s.status)
    && (!q || fields.map(f => x[f]).filter(Boolean).join(' ').toLowerCase().includes(q)));
}
function estFilesHTML(x, type) {
  const m = estMe();
  const src = (x.files || []).filter(f => f.kind === 'source'), other = (x.files || []).filter(f => f.kind !== 'source');
  return `<div class="est-src ${src.length ? '' : 'missing'}"><b>📊 HighRise / estimation document:</b> ${src.length ? src.map(f => `<button type="button" class="dlv-file" data-est-file="${f.id}">📊 ${estEsc(f.name)}</button>`).join(' ') : '<span class="dlv-nobill">not attached — needed before sending for approval</span>'}
    ${m.canEdit ? `<label class="btn btn-sm">+ ${src.length ? 'Add another' : 'Attach'}<input type="file" data-est-addfile="${type}:${x.id}:source" multiple hidden></label>` : ''}</div>
  <div class="dlv-files" style="margin-top:8px;">${other.map(f => `<button type="button" class="dlv-file" data-est-file="${f.id}">📎 ${estEsc(f.name)}</button>`).join('')}
    ${m.canEdit || estCanApprove(x.project) ? `<label class="btn btn-sm">+ Add file${x.status === 'approved' ? ' (e.g. signed copy)' : ''}<input type="file" data-est-addfile="${type}:${x.id}" accept="image/*,application/pdf,.pdf,.xlsx,.xls,.doc,.docx" multiple hidden></label>` : ''}</div>`;
}
function estRemarksHTML(x, type) {
  const s = estState(); const icon = { submit: '📤', approved: '✓', returned: '↩', remark: '💬' };
  const key = `${type}:${x.id}`;
  return `<div class="dlv-section" style="margin-top:12px;">Remarks</div>
    <div class="ap-timeline">${(x.comments || []).map(c => `<div class="ap-ev ap-${c.kind === 'returned' ? 'hold' : c.kind === 'approved' ? 'paid' : c.kind === 'submit' ? 'query' : 'note'}"><span class="ap-ev-ic">${icon[c.kind] || '💬'}</span><div><div>${c.kind === 'submit' ? '<b>Sent for approval:</b> ' : ''}${estEsc(c.text)}</div>
      <div class="small muted">${estEsc(c.by_name || c.by_username || '')} · ${estEsc(new Date(c.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }))}</div></div></div>`).join('') || '<div class="small muted">No remarks yet.</div>'}</div>
    <div class="ap-credit" style="margin-top:6px;"><input type="text" id="est-remark-${type}-${x.id}" value="${estEsc((s.remarkDraft || {})[key] || '')}" placeholder="Add a remark…" style="flex:1;min-width:200px;margin:0;"><button class="btn btn-sm" data-est-remark="${key}">Add remark</button></div>`;
}
function estActionsHTML(x, type) {
  const m = estMe(); const s = estState();
  const mineEdit = m.canEdit && ['draft', 'returned'].includes(x.status);
  const dec = s.decide && s.decide.type === type && s.decide.id === x.id ? s.decide : null;
  return `
    ${x.status === 'returned' && x.decision_note ? `<div class="notice dlv-warn" style="margin-top:8px;">↩ Returned by <b>${estEsc(x.decided_by_name || x.decided_by)}</b>: “${estEsc(x.decision_note)}”</div>` : ''}
    ${x.status === 'approved' ? `<div class="small" style="margin-top:8px;">✓ Approved by <b>${estEsc(x.decided_by_name || x.decided_by)}</b> · ${estEsc(estDate(x.decided_at))}${x.decision_note ? ` — “${estEsc(x.decision_note)}”` : ''}</div>` : ''}
    <div class="dlv-actions">
      ${mineEdit ? `<button class="btn btn-sm" data-est-edit="${type}:${x.id}">✏️ Edit</button><button class="btn btn-primary btn-sm" data-est-sendbox="${type}:${x.id}" ${(x.files || []).some(f => f.kind === 'source') ? '' : 'disabled title="Attach the HighRise / estimation document first"'}>📤 Send for approval</button>` : ''}
      ${x.status === 'submitted' && estCanApprove(x.project) && !dec ? `<button class="btn btn-primary btn-sm" data-est-approve="${type}:${x.id}">✓ Approve</button><button class="btn btn-sm" data-est-return="${type}:${x.id}">↩ Return for correction</button>` : ''}
      ${type === 'jmr' ? `<button class="btn btn-sm" data-est-print="${x.id}">🖨 Print</button>` : `<button class="btn btn-sm" data-est-print-recon="${x.id}">🖨 Print</button>`}
      ${(m.canEdit && x.status !== 'approved') || session.role === 'admin' ? `<button class="btn btn-sm btn-danger" data-est-del="${type}:${x.id}">🗑 Delete</button>` : ''}
    </div>
    ${s.send && s.send.type === type && s.send.id === x.id ? `<div class="dlv-proof"><label for="est-send-remarks">Remarks for Dnyaneshwar Kolekar / Admin <span class="muted small">(optional)</span></label><textarea id="est-send-remarks" placeholder="Anything they should know before approving">${estEsc(s.send.remarks || '')}</textarea>
      <div style="margin-top:8px;display:flex;gap:8px;"><button class="btn btn-primary btn-sm" data-est-submit="${type}:${x.id}">📤 Send for approval</button><button class="btn btn-sm" data-est-act="send-cancel">Cancel</button></div></div>` : ''}
    ${dec ? `<div class="dlv-proof"><label for="est-dec-note">${dec.decision === 'return' ? 'What needs correcting?' : 'Note (optional)'}</label><input type="text" id="est-dec-note" value="${estEsc(dec.note || '')}">
      <div style="margin-top:8px;display:flex;gap:8px;"><button class="btn btn-sm ${dec.decision === 'return' ? 'btn-danger' : 'btn-primary'}" data-est-dec-send="1">${dec.decision === 'return' ? '↩ Return' : '✓ Approve'}</button><button class="btn btn-sm" data-est-act="dec-cancel">Cancel</button></div></div>` : ''}`;
}

// ---- JMR list / detail
function estJmrListHTML() {
  const list = estFilter(estData.jmr, ['ref', 'work_item', 'material', 'contractor', 'location', 'ra_bill_no', 'project']);
  if (!list.length) return `<div class="empty">No JMR yet.${estMe().canEdit ? ' Tap “+ New JMR”.' : ''}</div>`;
  const s = estState();
  return `<div class="est-list">${list.map(j => {
    const open = s.open === `jmr:${j.id}`;
    return `<div class="est-item ${open ? 'open' : ''}">
      <button type="button" class="est-row" data-est-open="jmr:${j.id}">
        <span class="est-row-main"><b>${estEsc(j.work_item)}</b> <span class="mono small muted">${estEsc(j.ref)}</span>
          <span class="small muted">${estEsc([j.project, j.location, j.contractor, j.material ? `Material: ${j.material}` : '', j.ra_bill_no ? `RA ${j.ra_bill_no}` : ''].filter(Boolean).join(' · '))}</span></span>
        <span class="est-row-num"><b>${estNum(j.total_qty)} ${estEsc(j.unit)}</b><span class="small muted">${j.lines.length} line${j.lines.length === 1 ? '' : 's'}</span></span>
        ${estChip(j.status)}
      </button>
      ${open ? estJmrDetailHTML(j) : ''}
    </div>`;
  }).join('')}</div>`;
}
function estJmrDetailHTML(j) {
  return `<div class="est-detail">
    <div class="dlv-money-tiles bud-tiles">
      <div class="dlv-tile"><span>Up to previous (approved)</span><b>${estNum(j.prev_qty)} ${estEsc(j.unit)}</b></div>
      <div class="dlv-tile good"><span>This JMR</span><b>${estNum(j.total_qty)} ${estEsc(j.unit)}</b></div>
      <div class="dlv-tile"><span>Cumulative</span><b>${estNum(j.cum_qty)} ${estEsc(j.unit)}</b></div>
    </div>
    <div class="dlv-grid" style="margin-top:8px;">
      ${[['Material', j.material], ['RA bill no.', j.ra_bill_no], ['Measured on', estDate(j.measured_on)], ['Period', [estDate(j.period_from), estDate(j.period_to)].filter(Boolean).join(' – ')], ['Our representative', j.client_rep], ['Contractor representative', j.contractor_rep],
        ['Written by', `${j.created_by_name || j.created_by} · ${estDate(j.created_at)}`]].filter(r => r[1]).map(r => `<div class="dlv-kv"><span>${r[0]}</span><b>${estEsc(r[1])}</b></div>`).join('')}
    </div>
    <div class="dlv-perf-wrap"><table class="dlv-perf bud-table est-lines"><thead><tr><th>#</th><th>Description</th><th style="text-align:right;">Nos</th><th style="text-align:right;">L</th><th style="text-align:right;">B</th><th style="text-align:right;">H / D</th><th style="text-align:right;">Qty (${estEsc(j.unit)})</th><th>Remarks</th></tr></thead><tbody>
      ${j.lines.map((l, i) => `<tr class="${l.deduct ? 'est-deduct' : ''}"><td>${i + 1}</td><td>${l.deduct ? '<b>Less:</b> ' : ''}${estEsc(l.description || '')}</td>
        <td style="text-align:right;">${estNum(l.nos)}</td><td style="text-align:right;">${estNum(l.length)}</td><td style="text-align:right;">${estNum(l.breadth)}</td><td style="text-align:right;">${estNum(l.height)}</td>
        <td style="text-align:right;"><b>${estNum(l.qty)}</b>${l.manual ? ' <span class="small muted">(typed)</span>' : ''}</td><td>${estEsc(l.remarks || '')}</td></tr>`).join('')}
      <tr class="dlv-total"><td colspan="6">Total</td><td style="text-align:right;">${estNum(j.total_qty)}</td><td></td></tr>
    </tbody></table></div>
    ${j.notes ? `<div class="doc-note" style="margin-top:8px;">${estEsc(j.notes)}</div>` : ''}
    ${estFilesHTML(j, 'jmr')}
    ${estRemarksHTML(j, 'jmr')}
    ${estActionsHTML(j, 'jmr')}
  </div>`;
}
// ---- Import from Excel
function estImportHTML(im) {
  const r = im.result;
  return `<div class="card est-form" id="est-import">
    <div class="flex-between" style="gap:8px;flex-wrap:wrap;"><div class="card-title" style="margin:0;">Import JMR from Excel</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;"><button class="btn btn-sm" data-est-act="template">⬇ Template</button><button class="btn btn-sm" data-est-act="import-cancel">Cancel</button></div></div>
    <div class="small muted">Upload your JMR sheet (.xlsx or .csv). Each sheet is read; the table needs a heading row with <b>Description</b> and <b>Nos / L / B / H</b> and/or <b>Qty</b>. A row with text and no numbers starts a new work item; “Less …” rows and negative numbers are deductions; Total rows are skipped. Nothing is saved until you create the drafts.</div>
    <label class="btn btn-sm" style="margin-top:10px;">📂 Choose Excel / CSV<input type="file" id="est-imp-file" accept=".xlsx,.xlsm,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" hidden></label>
    ${im.fileName ? `<span class="small"> ${estEsc(im.fileName)}</span>` : ''}
    ${im.loading ? '<div class="small muted" style="margin-top:6px;">Reading the file…</div>' : ''}
    ${im.err ? `<div class="err">${estEsc(im.err)}</div>` : ''}
    ${r ? `
      <div class="small" style="margin-top:8px;">Found <b>${r.jmrs.length}</b> JMR${r.jmrs.length === 1 ? '' : 's'} in ${r.sheetsRead.map(estEsc).join(', ')}${r.sheetsSkipped.length ? ` · skipped sheet${r.sheetsSkipped.length > 1 ? 's' : ''} without a measurement table: ${r.sheetsSkipped.map(estEsc).join(', ')}` : ''}.</div>
      ${r.warnings.length ? `<div class="notice dlv-warn" style="margin-top:8px;">⚠ ${r.warnings.length} row${r.warnings.length > 1 ? 's' : ''} to check:<br>${r.warnings.slice(0, 8).map(estEsc).join('<br>')}${r.warnings.length > 8 ? `<br>… and ${r.warnings.length - 8} more` : ''}</div>` : ''}
      <div class="dlv-section">For all of them <span class="muted small">— details in the sheet are used where given</span></div>
      <div class="row">
        <div class="col"><label for="imp-project">Project *</label><select id="imp-project"><option value="">— Pick —</option>${estData.projects.map(p => `<option ${im.project === p ? 'selected' : ''}>${estEsc(p)}</option>`).join('')}</select></div>
        <div class="col"><label for="imp-contractor">Contractor</label><input type="text" id="imp-contractor" value="${estEsc(im.contractor || '')}" list="ejf-contractors"></div>
        <div class="col"><label for="imp-location">Location</label><input type="text" id="imp-location" value="${estEsc(im.location || '')}"></div>
      </div>
      <datalist id="ejf-contractors">${[...new Set([...estData.jmr.map(j => j.contractor), ...estData.recon.map(x => x.contractor)].filter(Boolean))].map(w => `<option value="${estEsc(w)}">`).join('')}</datalist>
      <label class="small" style="display:flex;gap:8px;align-items:center;margin-top:8px;"><input type="checkbox" id="imp-source" style="width:auto;margin:0;" ${im.asSource ? 'checked' : ''}> This Excel is the <b>HighRise / estimation document</b> (otherwise it is attached as a normal file and you add the HighRise document before sending)</label>
      <div class="dlv-perf-wrap"><table class="dlv-perf bud-table"><thead><tr><th></th><th>Work item</th><th>Unit</th><th>Sheet</th><th style="text-align:right;">Lines</th><th style="text-align:right;">Total qty</th><th>Material</th></tr></thead><tbody>
        ${r.jmrs.map((j, i) => `<tr><td><input type="checkbox" data-imp-pick="${i}" style="width:auto;margin:0;" ${im.picked[i] ? 'checked' : ''}></td>
          <td><input type="text" data-imp-wi="${i}" value="${estEsc(j.work_item)}" style="margin:0;min-width:200px;"></td>
          <td><select data-imp-unit="${i}" style="margin:0;width:auto;"><option value="">—</option>${[...new Set([...EST_UNITS, j.unit].filter(Boolean))].map(u => `<option ${j.unit === u ? 'selected' : ''}>${estEsc(u)}</option>`).join('')}</select></td>
          <td class="small">${estEsc(j.sheet)}</td><td style="text-align:right;">${j.lines.length}</td><td style="text-align:right;"><b>${estNum(j.total)}</b></td><td>${estEsc(j.material || '—')}</td></tr>`).join('')}
      </tbody></table></div>
      <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;">
        ${Object.values(im.picked).filter(Boolean).length === 1 ? '<button class="btn btn-sm" data-est-act="import-open">✏️ Open in the JMR form</button>' : ''}
        <button class="btn btn-primary btn-sm" data-est-act="import-create" ${im.creating ? 'disabled' : ''}>${im.creating ? `Creating… ${im.done || 0}/${Object.values(im.picked).filter(Boolean).length}` : `💾 Create ${Object.values(im.picked).filter(Boolean).length} draft JMR${Object.values(im.picked).filter(Boolean).length === 1 ? '' : 's'}`}</button>
      </div>` : ''}
  </div>`;
}
// ---- JMR form
function estBlankLine() { return { description: '', nos: '', length: '', breadth: '', height: '', qty: '', manual: false, deduct: false, remarks: '' }; }
function estJmrFormHTML(f) {
  const total = estR3(f.lines.reduce((a, l) => a + estLineQty(l), 0));
  // previous approved quantity for this work item + contractor
  const key = j => `${j.project}|${String(j.work_item || '').toLowerCase()}|${String(j.contractor || '').toLowerCase()}`;
  const prev = estR3(estData.jmr.filter(j => j.status === 'approved' && j.id !== f.id && key(j) === key(f)).reduce((a, j) => a + j.total_qty, 0));
  const inp = (k, label, ph = '', type = 'text', extra = '') => `<div class="col"><label for="ejf-${k}">${label}</label><input type="${type}" id="ejf-${k}" data-ejf="${k}" value="${estEsc(f[k] == null ? '' : f[k])}" placeholder="${estEsc(ph)}" ${extra}></div>`;
  return `<div class="card est-form" id="est-form">
    <div class="flex-between" style="gap:8px;flex-wrap:wrap;"><div class="card-title" style="margin:0;">${f.id ? `Edit JMR ${estEsc(f.ref)}` : 'New JMR'} <span class="small muted">— Joint Measurement Record</span></div><button class="btn btn-sm" data-est-act="form-cancel">Cancel</button></div>
    <div class="row">
      <div class="col"><label for="ejf-project">Project *</label><select id="ejf-project" data-ejf="project"><option value="">— Pick —</option>${estData.projects.map(p => `<option ${f.project === p ? 'selected' : ''}>${estEsc(p)}</option>`).join('')}</select></div>
      ${inp('location', 'Location (tower / floor / area)', 'e.g. Tower B, 4th floor')}
    </div>
    <div class="row">${inp('work_item', 'Work item *', 'e.g. Block work 150 mm', 'text', 'list="ejf-items"')}${inp('material', 'Material', 'e.g. AAC blocks 150 mm', 'text', 'list="ejf-materials"')}
      <div class="col"><label for="ejf-unit">Unit *</label><select id="ejf-unit" data-ejf="unit"><option value="">—</option>${EST_UNITS.map(u => `<option ${f.unit === u ? 'selected' : ''}>${u}</option>`).join('')}</select></div></div>
    <datalist id="ejf-materials">${[...new Set(['Cement OPC 53', 'TMT Steel', 'AAC blocks', 'Bricks', 'Sand', 'Aggregate 20 mm', 'RMC M25', 'Tiles', ...estData.jmr.map(j => j.material), ...estData.recon.map(r => r.material)].filter(Boolean))].map(w => `<option value="${estEsc(w)}">`).join('')}</datalist>
    <datalist id="ejf-items">${[...new Set(estData.jmr.map(j => j.work_item))].map(w => `<option value="${estEsc(w)}">`).join('')}</datalist>
    <div class="row">${inp('contractor', 'Contractor', 'e.g. Shree Builders', 'text', 'list="ejf-contractors"')}${inp('ra_bill_no', 'RA bill no.', 'e.g. RA-03')}</div>
    <datalist id="ejf-contractors">${[...new Set([...estData.jmr.map(j => j.contractor), ...estData.recon.map(r => r.contractor)].filter(Boolean))].map(w => `<option value="${estEsc(w)}">`).join('')}</datalist>
    <div class="row">${inp('measured_on', 'Measured on', '', 'date')}${inp('period_from', 'Work period from', '', 'date')}${inp('period_to', 'to', '', 'date')}</div>
    <div class="row">${inp('client_rep', 'Our representative', 'e.g. Site engineer name')}${inp('contractor_rep', "Contractor's representative", 'Name')}</div>
    <div class="dlv-section">Measurements</div>
    <div class="dlv-perf-wrap"><table class="dlv-perf est-lines est-edit"><thead><tr><th>#</th><th>Description</th><th>Nos</th><th>L</th><th>B</th><th>H / D</th><th>Type qty</th><th style="text-align:right;">Qty</th><th>Less</th><th>Remarks</th><th></th></tr></thead><tbody>
      ${f.lines.map((l, i) => `<tr class="${l.deduct ? 'est-deduct' : ''}"><td>${i + 1}</td>
        <td><input type="text" data-ejl="${i}:description" value="${estEsc(l.description)}" placeholder="e.g. Wall A"></td>
        ${['nos', 'length', 'breadth', 'height'].map(k => `<td><input type="number" step="any" inputmode="decimal" class="est-n" data-ejl="${i}:${k}" value="${estEsc(l[k])}" ${l.manual ? 'disabled' : ''}></td>`).join('')}
        <td><input type="checkbox" data-ejl-check="${i}:manual" ${l.manual ? 'checked' : ''}>${l.manual ? `<input type="number" step="any" inputmode="decimal" class="est-n" data-ejl="${i}:qty" value="${estEsc(l.qty)}">` : ''}</td>
        <td style="text-align:right;" class="est-q" id="ejq-${i}"><b>${estNum(estLineQty(l))}</b></td>
        <td><input type="checkbox" data-ejl-check="${i}:deduct" ${l.deduct ? 'checked' : ''}></td>
        <td><input type="text" data-ejl="${i}:remarks" value="${estEsc(l.remarks)}"></td>
        <td><button type="button" class="dlv-x" data-ejl-del="${i}" aria-label="Remove line">✕</button></td></tr>`).join('')}
      <tr class="dlv-total"><td colspan="7">Total this JMR</td><td style="text-align:right;" id="ej-total">${estNum(total)}</td><td colspan="3">${estEsc(f.unit || '')}</td></tr>
    </tbody></table></div>
    <button type="button" class="btn btn-sm" style="margin-top:6px;" data-est-act="add-line">+ Add line</button>
    <div class="dlv-money-tiles bud-tiles" style="margin-top:10px;" id="ej-tiles">
      <div class="dlv-tile"><span>Up to previous (approved)</span><b>${estNum(prev)} ${estEsc(f.unit || '')}</b></div>
      <div class="dlv-tile good"><span>This JMR</span><b>${estNum(total)} ${estEsc(f.unit || '')}</b></div>
      <div class="dlv-tile"><span>Cumulative</span><b>${estNum(estR3(prev + total))} ${estEsc(f.unit || '')}</b></div>
    </div>
    <label for="ejf-notes">Notes</label><textarea id="ejf-notes" data-ejf="notes" placeholder="Notes kept on the JMR">${estEsc(f.notes || '')}</textarea>
    <label for="est-remarks">Remarks for the approver <span class="muted small">(sent with it when you send it for approval)</span></label><textarea id="est-remarks" placeholder="e.g. Measured with the contractor's engineer; lift wall height to be confirmed">${estEsc(f.remarks || '')}</textarea>
    <div class="est-src ${(f.sourceFiles || []).length || f.hasSource ? '' : 'missing'}" style="margin-top:10px;"><b>📊 HighRise / estimation document *</b> <span class="small muted">— Excel, PDF or any format; required to send for approval</span><br>
      <label class="btn btn-sm" style="margin-top:6px;">📎 Choose file<input type="file" id="est-src-files" multiple hidden></label>
      ${(f.sourceFiles || []).length ? `<span class="small">${f.sourceFiles.map(x => estEsc(x.name)).join(', ')}</span>` : f.hasSource ? '<span class="small muted">Already attached — add another if it changed.</span>' : ''}</div>
    <label class="btn btn-sm" style="margin-top:8px;">📎 Other attachments (sketch, photos, signed sheet)<input type="file" id="ejf-files" accept="image/*,application/pdf,.pdf,.xlsx,.xls" multiple hidden></label>
    ${(f.files || []).length ? `<div class="small muted">${f.files.map(x => estEsc(x.name)).join(', ')}</div>` : ''}
    ${f.err ? `<div class="err">${estEsc(f.err)}</div>` : ''}
    <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;">
      <button class="btn btn-sm" data-est-save="draft" ${f.saving ? 'disabled' : ''}>💾 Save draft</button>
      <button class="btn btn-primary btn-sm" data-est-save="submit" ${f.saving ? 'disabled' : ''}>${f.saving ? 'Saving…' : '📤 Save & send for approval'}</button>
    </div>
  </div>`;
}

// ---- Reconciliation list / detail / form
function estReconCalcHTML(c, r) {
  const u = estEsc(r.unit || '');
  return `<div class="dlv-money-tiles bud-tiles est-calc">
    <div class="dlv-tile"><span>Actual consumption</span><b>${estNum(c.actual)} ${u}</b><small class="muted">issued − returned − balance at site</small></div>
    <div class="dlv-tile"><span>Theoretical</span><b>${estNum(c.theoretical)} ${u}</b><small class="muted">work done × norm</small></div>
    <div class="dlv-tile"><span>Allowed (with ${estNum(r.wastage_pct || 0, 2)}% wastage)</span><b>${estNum(c.allowed)} ${u}</b></div>
    <div class="dlv-tile ${c.excess > 0 ? 'bad' : c.saving > 0 ? 'good' : ''}"><span>${c.excess > 0 ? 'Excess — recoverable' : c.saving > 0 ? 'Saving' : 'Within allowance'}</span><b>${c.excess > 0 ? `${estNum(c.excess)} ${u}` : c.saving > 0 ? `${estNum(c.saving)} ${u}` : '0'}</b>${c.variancePct != null ? `<small class="muted">${c.variancePct > 0 ? '+' : ''}${c.variancePct}% vs theoretical</small>` : ''}</div>
    ${c.excess > 0 ? `<div class="dlv-tile bad"><span>Recovery</span><b>${c.recovery != null ? estInr(c.recovery) : 'add a rate'}</b>${r.rate ? `<small class="muted">@ ${estInr(r.rate)}/${u}</small>` : ''}</div>` : ''}
  </div>`;
}
function estReconListHTML() {
  const list = estFilter(estData.recon, ['ref', 'material', 'contractor', 'work_item', 'project']);
  if (!list.length) return `<div class="empty">No reconciliation yet.${estMe().canEdit ? ' Tap “+ New reconciliation”.' : ''}</div>`;
  const s = estState();
  return `<div class="est-list">${list.map(r => {
    const open = s.open === `recon:${r.id}`; const c = r.calc;
    return `<div class="est-item ${open ? 'open' : ''}">
      <button type="button" class="est-row" data-est-open="recon:${r.id}">
        <span class="est-row-main"><b>${estEsc(r.material)}</b> <span class="mono small muted">${estEsc(r.ref)}</span>
          <span class="small muted">${estEsc([r.project, r.contractor, r.work_item, [estDate(r.period_from), estDate(r.period_to)].filter(Boolean).join(' – ')].filter(Boolean).join(' · '))}</span></span>
        <span class="est-row-num"><b class="${c.excess > 0 ? 'dlv-over' : ''}">${c.excess > 0 ? `Excess ${estNum(c.excess)} ${estEsc(r.unit)}` : c.saving > 0 ? `Saving ${estNum(c.saving)} ${estEsc(r.unit)}` : 'Within allowance'}</b><span class="small muted">${c.excess > 0 && c.recovery != null ? `Recovery ${estInr(c.recovery)}` : `Used ${estNum(c.actual)} ${estEsc(r.unit)}`}</span></span>
        ${estChip(r.status)}
      </button>
      ${open ? `<div class="est-detail">
        <div class="dlv-grid">${[['Issued to contractor', `${estNum(r.issued)} ${r.unit}`], ['Returned', `${estNum(r.returned)} ${r.unit}`], ['Balance at site', `${estNum(r.balance_at_site)} ${r.unit}`],
          ['Work done', `${estNum(r.work_qty)} ${r.work_unit || ''}`], ['Norm', `${estNum(r.norm, 6)} ${r.unit} per ${r.work_unit || 'unit'}`], ['Wastage allowed', `${estNum(r.wastage_pct, 2)}%`], ['Rate', r.rate != null ? `${estInr(r.rate)}/${r.unit}` : ''],
          ['Written by', `${r.created_by_name || r.created_by} · ${estDate(r.created_at)}`]].filter(x => x[1]).map(x => `<div class="dlv-kv"><span>${x[0]}</span><b>${estEsc(x[1])}</b></div>`).join('')}</div>
        ${estReconCalcHTML(c, r)}
        ${r.notes ? `<div class="doc-note" style="margin-top:8px;">${estEsc(r.notes)}</div>` : ''}
        ${estFilesHTML(r, 'recon')}
        ${estRemarksHTML(r, 'recon')}
        ${estActionsHTML(r, 'recon')}
      </div>` : ''}
    </div>`;
  }).join('')}</div>`;
}
function estReconFormHTML(f) {
  const c = estReconCalc(f);
  const inp = (k, label, ph = '', type = 'number', extra = 'step="any" min="0" inputmode="decimal"') => `<div class="col"><label for="erf-${k}">${label}</label><input type="${type}" id="erf-${k}" data-erf="${k}" value="${estEsc(f[k] == null ? '' : f[k])}" placeholder="${estEsc(ph)}" ${extra}></div>`;
  return `<div class="card est-form" id="est-form">
    <div class="flex-between" style="gap:8px;flex-wrap:wrap;"><div class="card-title" style="margin:0;">${f.id ? `Edit reconciliation ${estEsc(f.ref)}` : 'New material reconciliation'}</div><button class="btn btn-sm" data-est-act="form-cancel">Cancel</button></div>
    <div class="row">
      <div class="col"><label for="erf-project">Project *</label><select id="erf-project" data-erf="project"><option value="">— Pick —</option>${estData.projects.map(p => `<option ${f.project === p ? 'selected' : ''}>${estEsc(p)}</option>`).join('')}</select></div>
      ${inp('material', 'Material *', 'e.g. Cement OPC 53', 'text', 'list="erf-materials"')}
      <div class="col"><label for="erf-unit">Unit *</label><select id="erf-unit" data-erf="unit"><option value="">—</option>${EST_UNITS.map(u => `<option ${f.unit === u ? 'selected' : ''}>${u}</option>`).join('')}</select></div>
    </div>
    <datalist id="erf-materials">${['Cement OPC 53', 'Cement PPC', 'TMT Steel', 'Sand', 'Aggregate 20 mm', 'Blocks (AAC)', 'Bricks', 'Tiles', ...new Set(estData.recon.map(r => r.material))].map(w => `<option value="${estEsc(w)}">`).join('')}</datalist>
    <div class="row">${inp('contractor', 'Contractor', 'e.g. Shree Builders', 'text', 'list="ejf-contractors2"')}${inp('work_item', 'Work item it was used for', 'e.g. Block work 150 mm', 'text', '')}${inp('period_from', 'Period from', '', 'date', '')}${inp('period_to', 'to', '', 'date', '')}</div>
    <datalist id="ejf-contractors2">${[...new Set([...estData.jmr.map(j => j.contractor), ...estData.recon.map(r => r.contractor)].filter(Boolean))].map(w => `<option value="${estEsc(w)}">`).join('')}</datalist>
    <div class="dlv-section">Material</div>
    <div class="row">${inp('issued', `Issued to contractor (${estEsc(f.unit || 'unit')})`)}${inp('returned', 'Returned')}${inp('balance_at_site', 'Balance still at site')}</div>
    <div class="dlv-section">Work done & norm</div>
    <div class="row">${inp('work_qty', 'Work done (quantity)', 'from JMR')}
      <div class="col"><label for="erf-work_unit">Work unit</label><select id="erf-work_unit" data-erf="work_unit"><option value="">—</option>${EST_UNITS.map(u => `<option ${f.work_unit === u ? 'selected' : ''}>${u}</option>`).join('')}</select></div>
      ${inp('norm', `Norm (${estEsc(f.unit || 'unit')} per ${estEsc(f.work_unit || 'work unit')})`, 'e.g. 0.4')}${inp('wastage_pct', 'Wastage allowed (%)', 'e.g. 3')}${inp('rate', `Recovery rate (₹ per ${estEsc(f.unit || 'unit')})`, 'e.g. 380')}</div>
    ${f.work_item ? `<div class="small muted">Approved JMR quantity for “${estEsc(f.work_item)}”${f.contractor ? ` (${estEsc(f.contractor)})` : ''}: <b>${estNum(estR3(estData.jmr.filter(j => j.status === 'approved' && j.project === f.project && String(j.work_item).toLowerCase() === String(f.work_item).toLowerCase() && (!f.contractor || String(j.contractor || '').toLowerCase() === String(f.contractor).toLowerCase())).reduce((a, j) => a + j.total_qty, 0)))}</b> <button type="button" class="linkish" data-est-act="use-jmr-qty">Use it as work done</button></div>` : ''}
    <div id="er-calc">${estReconCalcHTML(c, f)}</div>
    <label for="erf-notes">Notes</label><textarea id="erf-notes" data-erf="notes">${estEsc(f.notes || '')}</textarea>
    <label for="est-remarks">Remarks for the approver <span class="muted small">(sent with it when you send it for approval)</span></label><textarea id="est-remarks" placeholder="e.g. Store register checked; 10 bags damaged in rain">${estEsc(f.remarks || '')}</textarea>
    <div class="est-src ${(f.sourceFiles || []).length || f.hasSource ? '' : 'missing'}" style="margin-top:10px;"><b>📊 HighRise / estimation document *</b> <span class="small muted">— Excel, PDF or any format; required to send for approval</span><br>
      <label class="btn btn-sm" style="margin-top:6px;">📎 Choose file<input type="file" id="est-src-files" multiple hidden></label>
      ${(f.sourceFiles || []).length ? `<span class="small">${f.sourceFiles.map(x => estEsc(x.name)).join(', ')}</span>` : f.hasSource ? '<span class="small muted">Already attached — add another if it changed.</span>' : ''}</div>
    <label class="btn btn-sm" style="margin-top:8px;">📎 Other attachments (stock register, issue slips)<input type="file" id="erf-files" accept="image/*,application/pdf,.pdf,.xlsx,.xls" multiple hidden></label>
    ${(f.files || []).length ? `<div class="small muted">${f.files.map(x => estEsc(x.name)).join(', ')}</div>` : ''}
    ${f.err ? `<div class="err">${estEsc(f.err)}</div>` : ''}
    <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;">
      <button class="btn btn-sm" data-est-save="draft" ${f.saving ? 'disabled' : ''}>💾 Save draft</button>
      <button class="btn btn-primary btn-sm" data-est-save="submit" ${f.saving ? 'disabled' : ''}>${f.saving ? 'Saving…' : '📤 Save & send for approval'}</button>
    </div>
  </div>`;
}
// ---- Summary
function estSummaryHTML() {
  const s = estState();
  const ok = x => (!s.project || x.project === s.project);
  const appr = estData.jmr.filter(j => j.status === 'approved' && ok(j));
  const groups = new Map();
  for (const j of appr) {
    const k = `${j.project}|${j.work_item}|${j.material || ''}|${j.contractor || ''}|${j.unit}`;
    const g = groups.get(k) || { project: j.project, work_item: j.work_item, material: j.material, contractor: j.contractor, unit: j.unit, qty: 0, count: 0, last: '' };
    g.qty += j.total_qty; g.count++; if (String(j.decided_at) > g.last) g.last = j.decided_at; groups.set(k, g);
  }
  const rows = [...groups.values()].sort((a, b) => a.project.localeCompare(b.project) || String(a.work_item).localeCompare(String(b.work_item)));
  const pend = estData.jmr.filter(j => j.status === 'submitted' && ok(j));
  const recs = estData.recon.filter(r => r.status === 'approved' && ok(r));
  const recovery = recs.reduce((a, r) => a + (r.calc.recovery || 0), 0);
  return `
    <div class="dlv-money-tiles bud-tiles" style="margin-top:10px;">
      <div class="dlv-tile good"><span>Approved JMRs</span><b>${appr.length}</b></div>
      <div class="dlv-tile ${pend.length ? 'warn' : ''}"><span>Waiting for approval</span><b>${pend.length}</b><small class="muted">JMR</small></div>
      <div class="dlv-tile ${recovery ? 'bad' : ''}"><span>Recoveries (approved reconciliations)</span><b>${estInr(Math.round(recovery * 100) / 100)}</b><small class="muted">${recs.filter(r => r.calc.excess > 0).length} with excess</small></div>
    </div>
    <div class="dlv-section" style="margin-top:12px;">Work done to date (approved JMRs) — by work item and contractor</div>
    ${rows.length ? `<div class="dlv-perf-wrap"><table class="dlv-perf bud-table"><thead><tr><th>Project</th><th>Work item</th><th>Material</th><th>Contractor</th><th style="text-align:right;">Cumulative qty</th><th>JMRs</th><th>Last approved</th></tr></thead><tbody>
      ${rows.map(g => `<tr><td>${estEsc(g.project)}</td><td><b>${estEsc(g.work_item)}</b></td><td>${estEsc(g.material || '—')}</td><td>${estEsc(g.contractor || '—')}</td><td style="text-align:right;">${estNum(g.qty)} ${estEsc(g.unit)}</td><td>${g.count}</td><td>${estEsc(estDate(g.last))}</td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty small">No approved JMR yet.</div>'}`;
}

// ---- print
function estPrint(html, title) {
  const w = window.open('', '_blank');
  if (!w) { setBanner('Allow pop-ups to print.'); render(); return; }
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${estEsc(title)}</title><style>
    body{font-family:Arial,sans-serif;font-size:12px;color:#111;margin:24px;} h1{font-size:18px;margin:0 0 4px;} .muted{color:#555;}
    table{width:100%;border-collapse:collapse;margin-top:10px;} th,td{border:1px solid #999;padding:5px 6px;text-align:left;} th{background:#eee;} .r{text-align:right;}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:4px 24px;margin-top:10px;} .sig{display:grid;grid-template-columns:1fr 1fr 1fr;gap:24px;margin-top:48px;} .sig div{border-top:1px solid #333;padding-top:6px;text-align:center;}
    @media print{button{display:none;}}</style></head><body>${html}<script>window.onload=function(){window.print();}<\/script></body></html>`);
  w.document.close();
}
function estPrintJmr(j) {
  estPrint(`<h1>Joint Measurement Record — ${estEsc(j.ref)}</h1><div class="muted">${estEsc(j.project)}${j.location ? ' · ' + estEsc(j.location) : ''} · ${estChip(j.status).replace(/<[^>]+>/g, '')}</div>
    <div class="grid"><div><b>Work item:</b> ${estEsc(j.work_item)}</div><div><b>Material:</b> ${estEsc(j.material || '—')}</div><div><b>Contractor:</b> ${estEsc(j.contractor || '—')}</div>
      <div><b>Measured on:</b> ${estEsc(estDate(j.measured_on))}</div><div><b>Period:</b> ${estEsc([estDate(j.period_from), estDate(j.period_to)].filter(Boolean).join(' – '))}</div>
      <div><b>RA bill no.:</b> ${estEsc(j.ra_bill_no || '—')}</div></div>
    <table><thead><tr><th>#</th><th>Description</th><th class="r">Nos</th><th class="r">L</th><th class="r">B</th><th class="r">H / D</th><th class="r">Qty (${estEsc(j.unit)})</th><th>Remarks</th></tr></thead><tbody>
      ${j.lines.map((l, i) => `<tr><td>${i + 1}</td><td>${l.deduct ? 'Less: ' : ''}${estEsc(l.description || '')}</td><td class="r">${estNum(l.nos)}</td><td class="r">${estNum(l.length)}</td><td class="r">${estNum(l.breadth)}</td><td class="r">${estNum(l.height)}</td><td class="r">${estNum(l.qty)}</td><td>${estEsc(l.remarks || '')}</td></tr>`).join('')}
      <tr><td colspan="6"><b>Total this JMR</b></td><td class="r"><b>${estNum(j.total_qty)}</b></td><td></td></tr></tbody></table>
    <table><tr><th>Up to previous</th><th>This JMR</th><th>Cumulative</th></tr>
      <tr><td>${estNum(j.prev_qty)} ${estEsc(j.unit)}</td><td>${estNum(j.total_qty)} ${estEsc(j.unit)}</td><td>${estNum(j.cum_qty)} ${estEsc(j.unit)}</td></tr></table>
    ${j.notes ? `<p><b>Notes:</b> ${estEsc(j.notes)}</p>` : ''}
    <div class="sig"><div>Contractor's representative<br>${estEsc(j.contractor_rep || '')}</div><div>Our representative<br>${estEsc(j.client_rep || '')}</div><div>Approved by<br>${estEsc(j.decided_by_name || '')}</div></div>`, j.ref);
}
function estPrintRecon(r) {
  const c = r.calc;
  estPrint(`<h1>Material Reconciliation — ${estEsc(r.ref)}</h1><div class="muted">${estEsc(r.project)} · ${estEsc(r.material)} · ${estEsc(r.contractor || '')}</div>
    <table><tr><th>Issued</th><th>Returned</th><th>Balance at site</th><th>Actual consumption</th></tr><tr><td>${estNum(r.issued)} ${estEsc(r.unit)}</td><td>${estNum(r.returned)}</td><td>${estNum(r.balance_at_site)}</td><td><b>${estNum(c.actual)}</b></td></tr></table>
    <table><tr><th>Work done</th><th>Norm</th><th>Theoretical</th><th>Wastage allowed</th><th>Allowed</th></tr><tr><td>${estNum(r.work_qty)} ${estEsc(r.work_unit || '')}</td><td>${estNum(r.norm, 6)}</td><td>${estNum(c.theoretical)}</td><td>${estNum(r.wastage_pct, 2)}%</td><td>${estNum(c.allowed)}</td></tr></table>
    <table><tr><th>Excess (recoverable)</th><th>Saving</th><th>Rate</th><th>Recovery</th></tr><tr><td>${estNum(c.excess)} ${estEsc(r.unit)}</td><td>${estNum(c.saving)}</td><td>${r.rate != null ? estInr(r.rate) : '—'}</td><td><b>${estInr(c.recovery)}</b></td></tr></table>
    ${r.notes ? `<p><b>Notes:</b> ${estEsc(r.notes)}</p>` : ''}
    <div class="sig"><div>Contractor</div><div>Estimation & Billing<br>${estEsc(r.created_by_name || '')}</div><div>Approved by<br>${estEsc(r.decided_by_name || '')}</div></div>`, r.ref);
}
function estCsv(rows) { return rows.map(r => r.map(c => { const v = String(c == null ? '' : c); return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; }).join(',')).join('\n'); }
function estDownloadCsv(rows, name) { downloadDataUrl('data:text/csv;charset=utf-8;base64,' + btoa(unescape(encodeURIComponent('﻿' + estCsv(rows)))), name); }

async function estReload() { try { estData = await api('/api/estimation'); estSummary = await api('/api/estimation/summary'); } catch (e) { setBanner(e.message); } render(); }

function bindEstimationView() {
  const s = estState();
  if (!estData) { estReload(); return; }
  const on = (sel, fn) => document.querySelectorAll(sel).forEach(b => b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); fn(b); });
  const sel = (id, k) => { const el = document.getElementById(id); if (el) el.onchange = () => { s[k] = el.value; render(); }; };
  sel('est-project', 'project'); sel('est-status', 'status');
  const q = document.getElementById('est-q'); if (q) q.oninput = () => { s.q = q.value; clearTimeout(window.__estQ); window.__estQ = setTimeout(() => { render(); const n = document.getElementById('est-q'); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } }, 300); };
  on('[data-est-view]', b => { s.view = b.dataset.estView; render(); });
  on('[data-est-open]', b => { s.open = s.open === b.dataset.estOpen ? null : b.dataset.estOpen; s.decide = null; render(); });
  on('[data-est-file]', b => estOpenViewer(b.dataset.estFile));
  on('[data-est-act="view-close"]', () => estCloseViewer());
  document.querySelectorAll('[data-est-act="view-close-bg"]').forEach(el => el.onclick = (e) => { if (e.target === el) estCloseViewer(); });
  on('[data-est-sheet]', b => { if (ui.estView) { ui.estView.sheet = Number(b.dataset.estSheet); render(); } });
  // send for approval with remarks; remarks thread
  on('[data-est-sendbox]', b => { const [t, id] = b.dataset.estSendbox.split(':'); s.send = { type: t, id: Number(id), remarks: '' }; render(); const n = document.getElementById('est-send-remarks'); if (n) n.focus(); });
  on('[data-est-act="send-cancel"]', () => { s.send = null; render(); });
  const sr = document.getElementById('est-send-remarks'); if (sr && s.send) sr.oninput = () => { s.send.remarks = sr.value; };
  document.querySelectorAll('[id^="est-remark-"]').forEach(el => el.oninput = () => { const k = el.id.replace('est-remark-', '').replace('-', ':'); s.remarkDraft = { ...(s.remarkDraft || {}), [k]: el.value }; });
  on('[data-est-remark]', async b => {
    const key = b.dataset.estRemark; const [t, id] = key.split(':'); const text = String((s.remarkDraft || {})[key] || '').trim();
    if (text.length < 2) { setBanner('Write the remark first.'); render(); return; }
    b.disabled = true;
    try { await api(`/api/estimation/${t}/${id}/remark`, { method: 'POST', body: JSON.stringify({ text }) }); s.remarkDraft[key] = ''; setBanner('Remark added.', 'ok'); await estReload(); }
    catch (e) { b.disabled = false; setBanner(e.message); render(); }
  });
  document.querySelectorAll('[data-est-addfile]').forEach(inp => inp.onchange = () => {
    const [type, id, kind] = inp.dataset.estAddfile.split(':'); const list = Array.from(inp.files || []).slice(0, 10); if (!list.length) return;
    const files = []; let left = list.length;
    list.forEach(file => readAnyFile(file, async data => { if (data) files.push({ name: file.name, data }); if (--left === 0) {
      try { await api(`/api/estimation/${type}/${id}/files`, { method: 'POST', body: JSON.stringify({ attachments: files, kind: kind || 'attachment' }) }); setBanner('File added.', 'ok'); await estReload(); } catch (e) { setBanner(e.message); render(); }
    } }));
  });
  on('[data-est-act="csv"]', () => {
    if (s.view === 'recon') {
      const list = estFilter(estData.recon, ['ref', 'material', 'contractor', 'work_item', 'project']);
      estDownloadCsv([['Ref', 'Project', 'Material', 'Unit', 'Contractor', 'Work item', 'From', 'To', 'Issued', 'Returned', 'Balance at site', 'Actual', 'Work done', 'Work unit', 'Norm', 'Theoretical', 'Wastage %', 'Allowed', 'Excess', 'Saving', 'Rate', 'Recovery', 'Status', 'Approved by'],
        ...list.map(r => [r.ref, r.project, r.material, r.unit, r.contractor, r.work_item, r.period_from, r.period_to, r.issued, r.returned, r.balance_at_site, r.calc.actual, r.work_qty, r.work_unit, r.norm, r.calc.theoretical, r.wastage_pct, r.calc.allowed, r.calc.excess, r.calc.saving, r.rate, r.calc.recovery, EST_STATUS[r.status].label, r.decided_by_name])], 'reconciliation.csv');
    } else {
      const list = estFilter(estData.jmr, ['ref', 'work_item', 'material', 'contractor', 'location', 'ra_bill_no', 'project']);
      estDownloadCsv([['Ref', 'Project', 'Location', 'Work item', 'Material', 'Contractor', 'Unit', 'Previous qty', 'This JMR qty', 'Cumulative qty', 'RA bill', 'Measured on', 'Status', 'Written by', 'Approved by'],
        ...list.map(j => [j.ref, j.project, j.location, j.work_item, j.material, j.contractor, j.unit, j.prev_qty, j.total_qty, j.cum_qty, j.ra_bill_no, j.measured_on, EST_STATUS[j.status].label, j.created_by_name, j.decided_by_name])], 'jmr.csv');
    }
  });
  on('[data-est-print]', b => { const j = estData.jmr.find(x => x.id === Number(b.dataset.estPrint)); if (j) estPrintJmr(j); });
  on('[data-est-print-recon]', b => { const r = estData.recon.find(x => x.id === Number(b.dataset.estPrintRecon)); if (r) estPrintRecon(r); });
  // workflow
  const call = async (b, url, body, ok) => { if (b.disabled) return; b.disabled = true; try { await api(url, { method: 'POST', body: JSON.stringify(body || {}) }); setBanner(ok, 'ok'); s.decide = null; await estReload(); } catch (e) { b.disabled = false; setBanner(e.message); render(); } };
  on('[data-est-submit]', b => { const [t, id] = b.dataset.estSubmit.split(':'); const remarks = s.send && s.send.id === Number(id) ? s.send.remarks : ''; s.send = null; call(b, `/api/estimation/${t}/${id}/submit`, { remarks }, 'Sent for approval to Dnyaneshwar Kolekar / Admin.'); });
  on('[data-est-approve]', b => { const [t, id] = b.dataset.estApprove.split(':'); s.decide = { type: t, id: Number(id), decision: 'approve', note: '' }; render(); });
  on('[data-est-return]', b => { const [t, id] = b.dataset.estReturn.split(':'); s.decide = { type: t, id: Number(id), decision: 'return', note: '' }; render(); const n = document.getElementById('est-dec-note'); if (n) n.focus(); });
  on('[data-est-act="dec-cancel"]', () => { s.decide = null; render(); });
  const dn = document.getElementById('est-dec-note'); if (dn && s.decide) dn.oninput = () => { s.decide.note = dn.value; };
  on('[data-est-dec-send]', b => { const d = s.decide; if (!d) return; call(b, `/api/estimation/${d.type}/${d.id}/decide`, { decision: d.decision, note: d.note }, d.decision === 'approve' ? 'Approved ✓' : 'Returned for correction.'); });
  on('[data-est-del]', b => {
    if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Tap again to delete'; return; }
    const [t, id] = b.dataset.estDel.split(':'); call(b, `/api/estimation/${t}/${id}/delete`, {}, 'Deleted.');
  });
  // import from Excel
  on('[data-est-act="import"]', () => { s.imp = { picked: {}, asSource: false }; s.form = null; render(); window.scrollTo(0, 0); });
  on('[data-est-act="import-cancel"]', () => { s.imp = null; render(); });
  on('[data-est-act="template"]', async () => { try { const t = await api('/api/estimation/jmr/template'); downloadDataUrl(t.data, t.name); } catch (e) { setBanner(e.message); render(); } });
  const im = s.imp;
  if (im) {
    const fi = document.getElementById('est-imp-file');
    if (fi) fi.onchange = () => {
      const file = (fi.files || [])[0]; if (!file) return;
      im.loading = true; im.err = ''; im.result = null; im.fileName = file.name; render();
      readAnyFile(file, async data => {
        if (!data) { im.loading = false; im.err = 'Could not read that file.'; render(); return; }
        im.fileData = data;
        try {
          const r = await api('/api/estimation/jmr/import/preview', { method: 'POST', body: JSON.stringify({ fileData: data, fileName: file.name }) });
          im.result = r; im.picked = Object.fromEntries(r.jmrs.map((_, i) => [i, true]));
          const first = r.jmrs[0] || {};
          im.project = first.project || estState().project || ''; im.contractor = first.contractor || ''; im.location = first.location || '';
        } catch (e) { im.err = e.message; }
        im.loading = false; render();
      });
    };
    const bindIn = (id, k) => { const el = document.getElementById(id); if (el) { el.oninput = () => { im[k] = el.value; }; el.onchange = () => { im[k] = el.value; }; } };
    bindIn('imp-project', 'project'); bindIn('imp-contractor', 'contractor'); bindIn('imp-location', 'location');
    const src = document.getElementById('imp-source'); if (src) src.onchange = () => { im.asSource = src.checked; };
    document.querySelectorAll('[data-imp-pick]').forEach(el => el.onchange = () => { im.picked[el.dataset.impPick] = el.checked; render(); });
    document.querySelectorAll('[data-imp-wi]').forEach(el => el.oninput = () => { im.result.jmrs[Number(el.dataset.impWi)].work_item = el.value; });
    document.querySelectorAll('[data-imp-unit]').forEach(el => el.onchange = () => { im.result.jmrs[Number(el.dataset.impUnit)].unit = el.value; });
    const bodyFor = j => ({ project: im.project, location: j.location || im.location || '', work_item: j.work_item, material: j.material || im.material || '', contractor: j.contractor || im.contractor || '', unit: j.unit,
      measured_on: j.measured_on || '', ra_bill_no: j.ra_bill_no || '', lines: j.lines });
    const fileObj = () => ({ name: im.fileName, data: im.fileData });
    on('[data-est-act="import-open"]', () => {
      const i = Object.keys(im.picked).find(k => im.picked[k]); const j = im.result.jmrs[Number(i)];
      s.form = { type: 'jmr', ...bodyFor(j), period_from: '', period_to: '', client_rep: '', contractor_rep: '', notes: '',
        lines: j.lines.map(l => ({ ...l })), files: im.asSource ? [] : [fileObj()], sourceFiles: im.asSource ? [fileObj()] : [] };
      s.imp = null; render(); window.scrollTo(0, 0);
    });
    on('[data-est-act="import-create"]', async () => {
      if (im.creating) return;
      if (!im.project) { im.err = 'Pick the project.'; render(); return; }
      const list = im.result.jmrs.filter((_, i) => im.picked[i]);
      if (!list.length) { im.err = 'Tick at least one JMR.'; render(); return; }
      const noUnit = list.find(j => !j.unit); if (noUnit) { im.err = `Pick the unit for “${noUnit.work_item}”.`; render(); return; }
      im.creating = true; im.done = 0; im.err = ''; render();
      const made = [];
      for (const j of list) {
        try {
          const r = await api('/api/estimation/jmr', { method: 'POST', body: JSON.stringify({ ...bodyFor(j), ...(im.asSource ? { source_files: [fileObj()] } : { attachments: [fileObj()] }) }) });
          made.push(r.ref); im.done++; render();
        } catch (e) { im.err = `“${j.work_item}”: ${e.message}${made.length ? ` (${made.length} already created)` : ''}`; im.creating = false; render(); return; }
      }
      s.imp = null; s.view = 'jmr'; s.status = 'draft';
      setBanner(`${made.length} draft JMR${made.length === 1 ? '' : 's'} created: ${made.join(', ')}. Check them, then send each for approval.`, 'ok');
      await estReload();
    });
  }
  // forms
  const today = typeof istDayKey === 'function' ? istDayKey(new Date().toISOString()) : '';
  on('[data-est-act="new-jmr"]', () => { s.form = { type: 'jmr', project: s.project || '', unit: '', measured_on: today, lines: [estBlankLine(), estBlankLine(), estBlankLine()], files: [] }; render(); window.scrollTo(0, 0); });
  on('[data-est-act="new-recon"]', () => { s.form = { type: 'recon', project: s.project || '', unit: '', files: [] }; render(); window.scrollTo(0, 0); });
  on('[data-est-act="form-cancel"]', () => { s.form = null; render(); });
  on('[data-est-edit]', b => {
    const [t, id] = b.dataset.estEdit.split(':');
    const x = (t === 'jmr' ? estData.jmr : estData.recon).find(y => y.id === Number(id)); if (!x) return;
    const blank = v => v == null ? '' : v;
    s.form = t === 'jmr' ? { type: 'jmr', ...Object.fromEntries(Object.entries(x).map(([k, v]) => [k, blank(v)])), files: [], lines: x.lines.map(l => ({ description: blank(l.description), nos: blank(l.nos), length: blank(l.length), breadth: blank(l.breadth), height: blank(l.height), qty: l.manual ? Math.abs(l.qty) : '', manual: l.manual, deduct: l.deduct, remarks: blank(l.remarks) })) }
      : { type: 'recon', ...Object.fromEntries(Object.entries(x).filter(([k]) => k !== 'calc').map(([k, v]) => [k, blank(v)])), files: [] };
    s.form.hasSource = (x.files || []).some(y => y.kind === 'source'); s.form.sourceFiles = [];
    render(); window.scrollTo(0, 0);
  });
  const f = s.form;
  if (f && f.type === 'jmr') {
    const refreshTotals = () => {
      f.lines.forEach((l, i) => { const c = document.getElementById(`ejq-${i}`); if (c) c.innerHTML = `<b>${estNum(estLineQty(l))}</b>`; });
      const t = document.getElementById('ej-total'); if (t) t.textContent = estNum(estR3(f.lines.reduce((a, l) => a + estLineQty(l), 0)));
    };
    document.querySelectorAll('[data-ejf]').forEach(el => { const k = el.dataset.ejf; el.oninput = () => { f[k] = el.value; }; el.onchange = () => { f[k] = el.value; if (['project', 'unit', 'rate', 'work_item', 'contractor'].includes(k)) { render(); const n = document.getElementById(el.id); if (n && n.focus && el.tagName === 'INPUT') n.focus(); } }; });
    document.querySelectorAll('[data-ejl]').forEach(el => { const [i, k] = el.dataset.ejl.split(':'); el.oninput = () => { f.lines[Number(i)][k] = el.value; refreshTotals(); }; el.onchange = () => { f.lines[Number(i)][k] = el.value; render(); }; });
    document.querySelectorAll('[data-ejl-check]').forEach(el => { const [i, k] = el.dataset.ejlCheck.split(':'); el.onchange = () => { f.lines[Number(i)][k] = el.checked; render(); }; });
    on('[data-ejl-del]', b => { f.lines.splice(Number(b.dataset.ejlDel), 1); if (!f.lines.length) f.lines.push(estBlankLine()); render(); });
    on('[data-est-act="add-line"]', () => { f.lines.push(estBlankLine()); render(); const ins = document.querySelectorAll('[data-ejl$=":description"]'); if (ins.length) ins[ins.length - 1].focus(); });
  }
  if (f && f.type === 'recon') {
    document.querySelectorAll('[data-erf]').forEach(el => { const k = el.dataset.erf; el.oninput = () => { f[k] = el.value; const c = document.getElementById('er-calc'); if (c) c.innerHTML = estReconCalcHTML(estReconCalc(f), f); }; el.onchange = () => { f[k] = el.value; render(); }; });
    on('[data-est-act="use-jmr-qty"]', () => {
      f.work_qty = estR3(estData.jmr.filter(j => j.status === 'approved' && j.project === f.project && String(j.work_item).toLowerCase() === String(f.work_item).toLowerCase() && (!f.contractor || String(j.contractor || '').toLowerCase() === String(f.contractor).toLowerCase())).reduce((a, j) => a + j.total_qty, 0));
      const u = estData.jmr.find(j => String(j.work_item).toLowerCase() === String(f.work_item).toLowerCase()); if (u && !f.work_unit) f.work_unit = u.unit;
      render();
    });
  }
  if (f) {
    const fi = document.getElementById(f.type === 'jmr' ? 'ejf-files' : 'erf-files');
    if (fi) fi.onchange = () => { const list = Array.from(fi.files || []).slice(0, 10); f.files = []; let left = list.length; list.forEach(file => readAnyFile(file, data => { if (data) f.files.push({ name: file.name, data }); if (--left === 0) render(); })); };
    const rmk = document.getElementById('est-remarks'); if (rmk) rmk.oninput = () => { f.remarks = rmk.value; };
    const sfi = document.getElementById('est-src-files');
    if (sfi) sfi.onchange = () => { const list = Array.from(sfi.files || []).slice(0, 10); f.sourceFiles = []; f.err = ''; let left = list.length; list.forEach(file => readAnyFile(file, data => { if (data) f.sourceFiles.push({ name: file.name, data }); if (--left === 0) render(); })); };
    on('[data-est-save]', async b => {
      if (f.saving) return;
      const submit = b.dataset.estSave === 'submit';
      if (submit && !(f.sourceFiles || []).length && !f.hasSource) { f.err = 'Attach the HighRise / estimation document (Excel, PDF or any format) before sending it for approval.'; render(); return; }
      const body = f.type === 'jmr'
        ? { project: f.project, location: f.location, work_item: f.work_item, material: f.material, contractor: f.contractor, unit: f.unit, measured_on: f.measured_on, period_from: f.period_from, period_to: f.period_to,
            ra_bill_no: f.ra_bill_no, client_rep: f.client_rep, contractor_rep: f.contractor_rep, notes: f.notes, lines: f.lines, attachments: f.files, source_files: f.sourceFiles || [], remarks: submit ? (f.remarks || '') : '', submit }
        : { ...Object.fromEntries(['project', 'material', 'unit', 'contractor', 'work_item', 'period_from', 'period_to', 'issued', 'returned', 'balance_at_site', 'work_qty', 'work_unit', 'norm', 'wastage_pct', 'rate', 'notes'].map(k => [k, f[k]])), attachments: f.files, source_files: f.sourceFiles || [], remarks: submit ? (f.remarks || '') : '', submit };
      f.saving = true; f.err = ''; render();
      try {
        const r = await api(f.id ? `/api/estimation/${f.type}/${f.id}/update` : `/api/estimation/${f.type}`, { method: 'POST', body: JSON.stringify(body) });
        s.form = null; s.view = f.type; s.open = `${f.type}:${r.id}`;
        setBanner(submit ? `${r.ref} sent for approval${r.sentTo && r.sentTo.length ? ` to ${r.sentTo.map(personName).join(', ')}` : ''}.` : `${r.ref} saved as draft.`, 'ok');
        await estReload();
      } catch (e) { f.saving = false; f.err = e.message; render(); }
    });
  }
}

// =================== Accounts Dept tab ===================
// A starting point that brings together the money the Accounts team handles; how Accounts works will be added here.
function accOverviewHTML() {
  const jmr = estData ? estData.jmr : null;
  const B = typeof budgetData !== 'undefined' ? budgetData : { payments: [] };
  const pays = (B.payments || []);
  const invoices = [];
  for (const d of (typeof deliveriesData !== 'undefined' ? deliveriesData.items : []) || []) for (const f of d.files || []) if (f.kind === 'document' && ['received_invoice', 'invoice'].includes(f.doc_type)) invoices.push({ d, f });
  const appr = (jmr || []).filter(j => j.status === 'approved');
  const recs = estData ? estData.recon.filter(r => r.status === 'approved' && r.calc.excess > 0) : [];
  const byContractor = new Map();
  for (const j of appr) { const k = j.contractor || '—'; const g = byContractor.get(k) || { contractor: k, amount: 0, count: 0, items: [] }; g.amount += j.amount || 0; g.count++; g.items.push(j); byContractor.set(k, g); }
  for (const r of recs) { const k = r.contractor || '—'; const g = byContractor.get(k) || { contractor: k, amount: 0, count: 0, items: [] }; g.recovery = (g.recovery || 0) + (r.calc.recovery || 0); byContractor.set(k, g); }
  const sum = (list, f) => Math.round(list.reduce((a, x) => a + (f(x) || 0), 0) * 100) / 100;
  const pv = pays.filter(p => (p.verify_status || 'pending') === 'verified'), pp = pays.filter(p => ['pending', 'query'].includes(p.verify_status || 'pending'));
  return `
  <div class="card">
    <div class="card-title" style="margin:0;">Site money</div>
    <div class="small muted">Site payments (porter / transport) with their bills, and invoices received with material from site.</div>
    <div class="dlv-money-tiles bud-tiles" style="margin-top:10px;">
      <div class="dlv-tile good"><span>Site payments verified</span><b>${estInr(sum(pv, p => p.amount))}</b><small class="muted">${pv.length} payment${pv.length === 1 ? '' : 's'}</small></div>
      <div class="dlv-tile ${pp.length ? 'warn' : ''}"><span>Site payments waiting</span><b>${estInr(sum(pp, p => p.amount))}</b><small class="muted">${pp.length} to verify</small></div>
      <div class="dlv-tile"><span>Invoices received from site</span><b>${invoices.length}</b></div>
    </div>
  </div>
  <div class="card">
    <div class="flex-between" style="gap:8px;flex-wrap:wrap;"><div class="card-title" style="margin:0;">Site payments (porter / transport)</div><button class="btn btn-sm" data-acc-goto="budget">Open Budget ›</button></div>
    <div class="small muted">Money allotted to people on site and what they paid, with bills — verified by the Director.</div>
    ${pays.length ? `<div class="dlv-perf-wrap"><table class="dlv-perf bud-table"><thead><tr><th>Date</th><th>Paid by</th><th>For</th><th style="text-align:right;">Amount</th><th>Bill</th><th>Status</th></tr></thead><tbody>
      ${pays.slice(0, 15).map(p => `<tr><td class="nowrap">${estEsc(estDate(String(p.paid_at || '').slice(0, 10)))}</td><td>${estEsc(p.paid_by_name || personName(p.paid_by))}</td><td>${estEsc(p.purpose)}${p.d_ref ? ` <span class="small muted">${estEsc(p.d_ref)}</span>` : ''}</td>
        <td style="text-align:right;">${estInr(p.amount)}</td><td>${(p.bills || []).length ? '🧾' : '<span class="dlv-nobill">No bill</span>'}</td><td>${typeof budChip === 'function' ? budChip(p.verify_status || 'pending') : ''}</td></tr>`).join('')}
    </tbody></table></div>${pays.length > 15 ? `<div class="small muted">Latest 15 of ${pays.length} — see Budget for all.</div>` : ''}` : '<div class="empty small">No site payments yet.</div>'}
  </div>
  <div class="card">
    <div class="card-title" style="margin:0;">Invoices received with material (from site)</div>
    ${invoices.length ? `<div class="dlv-perf-wrap"><table class="dlv-perf bud-table"><thead><tr><th>Delivery</th><th>Vendor</th><th>Document</th><th>Uploaded</th></tr></thead><tbody>
      ${invoices.map(({ d, f }) => `<tr><td><button type="button" class="bud-dlv" data-acc-dlv="${d.id}"><b>${estEsc(d.ref)}</b> ${estEsc(d.title)}</button></td><td>${estEsc(d.vendor || '—')}</td>
        <td><button type="button" class="dlv-file" data-acc-file="${d.id}:${f.id}">📎 ${estEsc(f.name)}</button></td><td class="nowrap">${estEsc(personName(f.uploaded_by))} · ${estEsc(estDate(f.created_at))}</td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty small">No invoices uploaded from site yet (Deliveries → 📄 Documents → From site).</div>'}
  </div>
  ${ui.deliveryPhoto ? `<div class="dlv-viewer" data-acc-act="close-photo"><img src="${ui.deliveryPhoto.data}" alt=""><div class="dlv-viewer-bar"><span>${estEsc(ui.deliveryPhoto.name)}</span><button class="btn btn-sm" data-acc-act="close-photo">Close</button></div></div>` : ''}`;
}
function bindAccOverview() {
  const on = (sel, fn) => document.querySelectorAll(sel).forEach(b => b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); fn(b); });
  on('[data-acc-goto]', b => { ui.adminTab = b.dataset.accGoto; try { safeStorage.setItem('ls_last_tab', ui.adminTab); } catch (e) {} if (ui.adminTab === 'estimation') estState().view = 'summary'; render(); window.scrollTo(0, 0); });
  on('[data-acc-dlv]', b => openDeliveryOnPage(Number(b.dataset.accDlv)));
  on('[data-acc-act="close-photo"]', () => { ui.deliveryPhoto = null; render(); });
  on('[data-acc-file]', async b => { const [d, f] = b.dataset.accFile.split(':'); try { const r = await api(`/api/deliveries/${d}/files/${f}`); if (/^data:image\//.test(r.data)) { ui.deliveryPhoto = r; render(); } else downloadDataUrl(r.data, r.name); } catch (e) { setBanner(e.message); render(); } });
  on('[data-acc-act="csv-jmr"]', () => {
    const appr = estData.jmr.filter(j => j.status === 'approved');
    estDownloadCsv([['Contractor', 'Ref', 'Project', 'Work item', 'BOQ', 'RA bill', 'Unit', 'Qty', 'Rate', 'Amount', 'Approved by', 'Approved on'],
      ...appr.map(j => [j.contractor, j.ref, j.project, j.work_item, j.boq_item, j.ra_bill_no, j.unit, j.total_qty, j.rate, j.amount, j.decided_by_name, (j.decided_at || '').slice(0, 10)])], 'approved-jmr-for-billing.csv');
  });
}
