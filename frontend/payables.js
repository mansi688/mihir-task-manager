/* Accounts Dept page — vendor bills (accounts payable) first, then the contractor / site money overview.
   Purchase sends a vendor bill (delivery done, credit period in days); Accounts is reminded 15, 5 and 2 days before
   the due date, on it, and every day once overdue; Accounts replies, schedules, pays (part or full) or holds; Purchase
   answers and follows up. Data: GET /api/payables (apData, with the page) and /api/payables/summary (apSummary).
   Loaded after estimation.js and before app.js. */

let apData = null;
let apSummary = { canView: false };
let compData = null; // GET /api/compliance — monthly compliance due dates (Accounts + Admin)
const AP_TABS = [
  { key: 'overdue', label: '🔴 Overdue', match: b => b.status !== 'paid' && b.days_left < 0 },
  { key: 'compliance', label: '📅 Compliance', payOnly: true },
  { key: 'soon', label: '⏳ Due in 15 days', match: b => b.status !== 'paid' && b.days_left >= 0 && b.days_left <= 15 },
  { key: 'later', label: '🗓 Not yet due', match: b => b.status !== 'paid' && b.days_left > 15 },
  { key: 'hold', label: '⏸ On hold', match: b => b.status === 'on_hold' },
  { key: 'paid', label: '✅ Paid', match: b => b.status === 'paid' },
  { key: 'all', label: 'All bills', match: () => true },
  { key: 'vendors', label: '🏢 By vendor' },
  { key: 'other', label: 'Site money' },
];
function apEsc(s) { return typeof esc === 'function' ? esc(s) : String(s == null ? '' : s); }
function apInr(n) { return n == null ? '—' : '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 }); }
function apDay(d) { if (!d) return ''; try { return new Date(String(d).length === 10 ? `${d}T12:00:00+05:30` : d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }); } catch (e) { return d; } }
function apToday() { return typeof istDayKey === 'function' ? istDayKey(new Date().toISOString()) : new Date().toISOString().slice(0, 10); }
function apAddDays(ymd, n) { const [y, m, d] = String(ymd).split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); }
function apDocLabel(k) { const d = ((apData && apData.docTypes) || []).find(x => x.key === k); return d ? d.label : (k === 'proof' ? 'Payment proof' : 'Document'); }
function apDocTypeOptions(sel, skipBill) { return ((apData && apData.docTypes) || []).filter(d => !(skipBill && d.key === 'bill')).map(d => `<option value="${d.key}" ${sel === d.key ? 'selected' : ''}>${apEsc(d.label)}</option>`).join(''); }
function apState() { if (!ui.ap) ui.ap = { tab: 'overdue', q: '', project: '', open: null, form: null, imp: null, act: null }; return ui.ap; }
function apMe() { return (apData && apData.me) || { canAdd: !!apSummary.canAdd, canPay: !!apSummary.canPay }; }
function accountsDeptBadge() { return apSummary.canPay ? (apSummary.overdue || 0) + compUrgent().length : (apSummary.questions || 0); }
function compUrgent() { return ((compData && compData.items) || []).filter(i => !i.unset && i.days_left <= 2); }
function apDueChip(b) {
  if (b.status === 'paid') return `<span class="bud-chip good">✓ Paid${b.paid_at ? ` ${apDay(b.paid_at)}` : ''}</span>`;
  const d = b.days_left;
  const due = d < 0 ? `<span class="bud-chip bad">Overdue ${-d} day${d === -1 ? '' : 's'}</span>` : d === 0 ? '<span class="bud-chip bad">Due today</span>'
    : `<span class="bud-chip ${d <= 5 ? 'warn' : ''}">Due in ${d} day${d === 1 ? '' : 's'}</span>`;
  const st = b.status === 'on_hold' ? ' <span class="bud-chip">⏸ On hold</span>' : b.status === 'scheduled' ? ` <span class="bud-chip">🗓 Scheduled ${apDay(b.scheduled_for)}</span>` : b.status === 'partial' ? ' <span class="bud-chip">Part paid</span>' : '';
  return due + st + (b.awaiting === 'purchase' ? ' <span class="bud-chip warn">❓ Question for Purchase</span>' : '');
}

function renderAccountsDeptView() {
  const s = apState(); const m = apMe();
  if (!apData && apSummary.canView) return '<div class="card"><div class="small muted">Loading vendor bills…</div></div>';
  if (!apSummary.canView && !apData) return typeof accOverviewHTML === 'function' ? accOverviewHTML() : '';
  const bills = apData.bills || [];
  const open = bills.filter(b => b.status !== 'paid');
  const sum = list => Math.round(list.reduce((a, b) => a + (b.balance || 0), 0) * 100) / 100;
  const overdue = open.filter(b => b.days_left < 0), soon = open.filter(b => b.days_left >= 0 && b.days_left <= 15);
  const month = apToday().slice(0, 7);
  const paidMonth = bills.reduce((a, b) => a + b.events.filter(e => ['partial', 'paid'].includes(e.kind) && String(e.pay_date || e.created_at).slice(0, 7) === month).reduce((x, e) => x + (e.amount || 0), 0), 0);
  const questions = open.filter(b => b.awaiting === 'purchase').length;
  const tabs = AP_TABS.filter(t => !t.payOnly || m.canPay);
  const tab = tabs.some(t => t.key === s.tab) ? s.tab : 'overdue';
  const count = t => t.match ? bills.filter(t.match).length : null;
  return `
  <div class="card">
    <div class="flex-between" style="flex-wrap:wrap;gap:10px;">
      <div><div class="card-title" style="margin:0;">Accounts Department — vendor bills</div>
        <div class="small muted">Purchase sends each vendor bill once the delivery is done, with the credit period. Accounts is reminded ${(apData.remindBefore || [15, 5, 2]).join(', ')} days before the due date, on the due date, and every day once it is overdue. Reply, schedule, pay or hold on the bill — Purchase and Admin are told.</div></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        ${m.canAdd && !s.form ? '<button class="btn btn-primary btn-sm" data-ap-act="new">+ Send vendor bill</button>' : ''}
        ${(m.canAdd || m.canPay) && !s.imp ? '<button class="btn btn-sm" data-ap-act="import">⬆ Import bills from Excel</button>' : ''}
      </div>
    </div>
    <div class="dlv-money-tiles bud-tiles" style="margin-top:10px;">
      <div class="dlv-tile"><span>Outstanding</span><b>${apInr(sum(open))}</b><small class="muted">${open.length} bill${open.length === 1 ? '' : 's'}</small></div>
      <div class="dlv-tile ${overdue.length ? 'bad' : 'good'}"><span>Overdue</span><b>${apInr(sum(overdue))}</b><small class="muted">${overdue.length} bill${overdue.length === 1 ? '' : 's'}</small></div>
      <div class="dlv-tile ${soon.length ? 'warn' : ''}"><span>Due in 15 days</span><b>${apInr(sum(soon))}</b><small class="muted">${soon.length} bill${soon.length === 1 ? '' : 's'}</small></div>
      <div class="dlv-tile good"><span>Paid this month</span><b>${apInr(Math.round(paidMonth * 100) / 100)}</b></div>
      ${questions ? `<div class="dlv-tile warn"><span>Questions for Purchase</span><b>${questions}</b></div>` : ''}
    </div>
  </div>
  ${s.form ? apFormHTML(s.form) : ''}
  ${s.imp ? apImportHTML(s.imp) : ''}
  <div class="card">
    <div class="task-tabs" role="tablist">${tabs.map(t => `<button class="task-tab${tab === t.key ? ' active' : ''}" data-ap-tab="${t.key}">${t.label}${count(t) != null ? ` <span class="task-tab-count">${count(t)}</span>` : ''}</button>`).join('')}</div>
    ${tab === 'other' || tab === 'compliance' ? '' : `<div class="bud-filters">
      <div><label for="ap-project">Project</label><select id="ap-project"><option value="">All projects</option>${(apData.projects || []).map(p => `<option ${s.project === p ? 'selected' : ''}>${apEsc(p)}</option>`).join('')}</select></div>
      <div class="bud-search"><label for="ap-q">Search</label><input type="text" id="ap-q" value="${apEsc(s.q)}" placeholder="Vendor, bill no., BILL- number, delivery…"></div>
      <div style="align-self:flex-end;"><button class="btn btn-sm" data-ap-act="csv">⬇ CSV</button></div>
    </div>`}
    ${tab === 'compliance' ? compHTML() : tab === 'other' ? '' : tab === 'vendors' ? apVendorsHTML(apFiltered(bills)) : apListHTML(apFiltered(bills.filter(AP_TABS.find(t => t.key === tab).match)), tab)}
  </div>
  ${tab === 'other' && typeof accOverviewHTML === 'function' ? accOverviewHTML() : ''}
  ${ui.deliveryPhoto ? `<div class="dlv-viewer" data-ap-act="close-photo"><img src="${ui.deliveryPhoto.data}" alt=""><div class="dlv-viewer-bar"><span>${apEsc(ui.deliveryPhoto.name)}</span><button class="btn btn-sm" data-ap-act="download-photo">Download</button><button class="btn btn-sm" data-ap-act="close-photo">Close</button></div></div>` : ''}`;
}
function apFiltered(list) {
  const s = apState(); const q = (s.q || '').trim().toLowerCase();
  return list.filter(b => (!s.project || b.project === s.project) && (!q || [b.vendor, b.bill_no, b.ref, b.delivery_ref, b.description, b.project].filter(Boolean).join(' ').toLowerCase().includes(q)));
}
function apListHTML(list, tab) {
  if (!list.length) return `<div class="empty">${tab === 'overdue' ? 'Nothing overdue. 👍' : 'No bills here.'}</div>`;
  const s = apState();
  const sorted = tab === 'paid' ? [...list].sort((a, b) => String(b.paid_at).localeCompare(String(a.paid_at))) : [...list].sort((a, b) => a.days_left - b.days_left);
  return `<div class="est-list">${sorted.map(b => {
    const open = s.open === b.id;
    return `<div class="est-item ${open ? 'open' : ''} ${b.status !== 'paid' && b.days_left < 0 ? 'ap-overdue' : ''}">
      <button type="button" class="est-row" data-ap-open="${b.id}">
        <span class="est-row-main"><b>${apEsc(b.vendor)}</b> <span class="small">${b.bill_no ? `Bill ${apEsc(b.bill_no)}` : ''}</span> <span class="mono small muted">${apEsc(b.ref)}</span>
          <span class="small muted">${apEsc([b.project, b.delivery_ref ? `Delivery ${b.delivery_ref}` : '', `Due ${apDay(b.due_date)}`, b.credit_days != null ? `${b.credit_days} days credit` : ''].filter(Boolean).join(' · '))}</span>
          <span>${apDueChip(b)}</span></span>
        <span class="est-row-num"><b>${apInr(b.status === 'paid' ? b.amount : b.balance)}</b><span class="small muted">${b.paid_amount && b.status !== 'paid' ? `of ${apInr(b.amount)}` : b.status === 'paid' ? 'paid' : 'to pay'}</span></span>
      </button>
      ${open ? apDetailHTML(b) : ''}
    </div>`;
  }).join('')}</div>`;
}
function apDetailHTML(b) {
  const m = apMe(); const s = apState();
  const act = s.act && s.act.id === b.id ? s.act : null;
  const mineAdd = m.canAdd && (m.admin || b.created_by === session.username);
  const groups = new Map(); for (const f of b.files || []) { const k = f.kind || 'other'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(f); }
  const order = ((apData && apData.docTypes) || []).map(d => d.key);
  const files = [...groups.entries()].sort((x, y) => order.indexOf(x[0]) - order.indexOf(y[0])).map(([k, fs]) => `<div class="ap-doc"><span class="ap-doc-type">${k === 'bill' ? '🧾' : '📄'} ${apEsc(apDocLabel(k))}</span>${fs.map(f => `<button type="button" class="dlv-file" data-ap-file="${f.id}">${apEsc(f.name)}</button>`).join(' ')}</div>`).join('');
  const dlv = b.delivery_id && typeof deliveriesData !== 'undefined' ? (deliveriesData.items || []).find(d => d.id === b.delivery_id) : null;
  const dlvDocs = dlv ? (dlv.files || []).filter(f => f.kind === 'document' || f.kind === 'attachment') : [];
  const addDoc = s.addDoc && s.addDoc.id === b.id ? s.addDoc : null;
  const fuAt = b.last_followup_at ? new Date(b.last_followup_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '';
  const icon = { created: '📨', edited: '✏️', note: '💬', query: '❓', reply: '↩', schedule: '🗓', partial: '💸', paid: '✅', hold: '⏸', resume: '▶', followup: '📣', document: '📄' };
  return `<div class="est-detail">
    <div class="dlv-grid">${[['Bill amount', apInr(b.amount)], ['Paid', apInr(b.paid_amount)], ['Balance', apInr(b.balance)], ['Bill date', apDay(b.bill_date)], ['Credit period', b.credit_days != null ? `${b.credit_days} days` : ''],
      ['Due date', apDay(b.due_date)], ['Delivery done on', apDay(b.delivery_done_on)], ['Delivery', b.delivery_ref || ''], ['Sent by', `${b.created_by_name || b.created_by} · ${apDay(b.created_at)}${b.source === 'import' ? ' (imported)' : ''}`],
      ['On hold because', b.status === 'on_hold' ? b.hold_reason : '']].filter(r => r[1]).map(r => `<div class="dlv-kv"><span>${r[0]}</span><b>${apEsc(r[1])}</b></div>`).join('')}</div>
    ${b.description ? `<div class="doc-note" style="margin-top:8px;">${apEsc(b.description)}</div>` : ''}
    <div class="dlv-section" style="margin-top:12px;">Documents</div>
    ${files || '<div class="small muted">No documents yet.</div>'}
    ${dlvDocs.length ? `<div class="ap-doc"><span class="ap-doc-type">🚚 From delivery ${apEsc(dlv.ref)}</span>${dlvDocs.map(f => `<button type="button" class="dlv-file" data-ap-dfile="${dlv.id}:${f.id}">${apEsc(typeof dlvDoc === 'function' && f.doc_type && dlvDoc(f.doc_type) ? dlvDoc(f.doc_type).label + ' — ' : '')}${apEsc(f.name)}</button>`).join(' ')}</div>` : ''}
    ${(m.canAdd || m.canPay) ? (addDoc ? `<div class="dlv-proof"><div class="row"><div class="col"><label for="apd-type">Which document?</label><select id="apd-type">${apDocTypeOptions(addDoc.type)}</select></div></div>
        <label class="btn btn-sm">📎 Choose file(s)<input type="file" id="apd-files" accept="image/*,application/pdf,.pdf,.xlsx,.xls,.doc,.docx" multiple hidden></label> ${(addDoc.files || []).map(f => `<span class="small">${apEsc(f.name)}</span>`).join(', ')}
        ${addDoc.err ? `<div class="err">${apEsc(addDoc.err)}</div>` : ''}
        <div style="margin-top:8px;display:flex;gap:8px;"><button class="btn btn-primary btn-sm" data-ap-act="doc-save" ${addDoc.saving ? 'disabled' : ''}>${addDoc.saving ? 'Uploading…' : 'Upload'}</button><button class="btn btn-sm" data-ap-act="doc-cancel">Cancel</button></div></div>`
      : `<button type="button" class="btn btn-sm" style="margin-top:6px;" data-ap-adddoc="${b.id}">+ Add document (challan, PO, GRN…)</button>`) : ''}
    ${b.delivery_id ? `<div style="margin-top:6px;"><button type="button" class="linkish" data-ap-dlv="${b.delivery_id}">Open delivery ${apEsc(b.delivery_ref)} ›</button></div>` : ''}
    <div class="dlv-section" style="margin-top:12px;">Conversation & payments</div>
    <div class="ap-timeline">${b.events.map(e => `<div class="ap-ev ap-${e.kind}"><span class="ap-ev-ic">${icon[e.kind] || '•'}</span><div><div>${apEsc(e.message || '')}</div>
      <div class="small muted">${apEsc(e.by_name || e.by_username || '')} · ${apEsc(new Date(e.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }))}</div>
      ${(e.files || []).length ? `<div class="dlv-files">${e.files.map(f => `<button type="button" class="dlv-file" data-ap-file="${f.id}">📎 ${apEsc(f.name)}</button>`).join('')}</div>` : ''}</div></div>`).join('')}</div>
    ${b.last_followup_at ? `<div class="dlv-fu-note">📣 Followed up by <b>${apEsc(personName(b.last_followup_by))}</b> · ${apEsc(fuAt)}${b.followup_count > 1 ? ` · ${b.followup_count} times` : ''}</div>` : ''}
    ${act ? apActFormHTML(b, act) : `<div class="dlv-actions">
      ${b.status !== 'paid' && m.canPay ? `
        <button class="btn btn-primary btn-sm" data-ap-do="${b.id}:paid">✅ Mark paid</button>
        <button class="btn btn-sm" data-ap-do="${b.id}:partial">💸 Part payment</button>
        <button class="btn btn-sm" data-ap-do="${b.id}:schedule">🗓 Schedule payment</button>
        <button class="btn btn-sm" data-ap-do="${b.id}:query">❓ Ask Purchase</button>
        ${b.status === 'on_hold' ? `<button class="btn btn-sm" data-ap-do="${b.id}:resume">▶ Take off hold</button>` : `<button class="btn btn-sm" data-ap-do="${b.id}:hold">⏸ Hold</button>`}` : ''}
      ${b.status !== 'paid' && (m.canAdd || m.admin) ? `
        <button class="btn btn-sm ${b.awaiting === 'purchase' ? 'btn-primary' : ''}" data-ap-do="${b.id}:reply">↩ Reply to Accounts</button>
        <button class="btn btn-sm dlv-fu ${b.last_followup_at ? 'done' : ''}" data-ap-do="${b.id}:followup" title="Remind Accounts to release this payment">📣 ${b.last_followup_at ? 'Follow up again' : 'Follow up'}</button>` : ''}
      <button class="btn btn-sm" data-ap-do="${b.id}:note">💬 Note</button>
      ${mineAdd && b.status !== 'paid' ? `<button class="btn btn-sm" data-ap-edit="${b.id}">✏️ Edit</button>` : ''}
      ${(m.admin || (mineAdd && !b.paid_amount)) ? `<button class="btn btn-sm btn-danger" data-ap-del="${b.id}">🗑 Delete</button>` : ''}
    </div>`}
  </div>`;
}
function apActFormHTML(b, a) {
  const modes = (apData.payModes || []).map(x => `<option ${a.pay_mode === x ? 'selected' : ''}>${apEsc(x)}</option>`).join('');
  const T = { paid: '✅ Mark paid', partial: '💸 Part payment', schedule: '🗓 Schedule payment', query: '❓ Ask Purchase', hold: '⏸ Put on hold', resume: '▶ Take off hold', reply: '↩ Reply to Accounts', note: '💬 Note', followup: '📣 Follow up with Accounts' }[a.action];
  const pay = a.action === 'paid' || a.action === 'partial';
  return `<div class="dlv-proof">
    <div class="dlv-proof-title">${T} — ${apEsc(b.vendor)}${b.bill_no ? ` ${apEsc(b.bill_no)}` : ''}</div>
    ${pay ? `<div class="row">
      <div class="col"><label for="apa-amount">Amount (₹)${a.action === 'paid' ? ' <span class="muted small">— empty = full balance</span>' : ' *'}</label><input type="number" id="apa-amount" data-apa="amount" min="1" step="0.01" inputmode="decimal" value="${apEsc(a.amount || '')}" placeholder="${apInr(b.balance)}"></div>
      <div class="col"><label for="apa-pay_date">Paid on</label><input type="date" id="apa-pay_date" data-apa="pay_date" value="${apEsc(a.pay_date || apToday())}"></div>
      <div class="col"><label for="apa-pay_mode">Mode</label><select id="apa-pay_mode" data-apa="pay_mode">${modes}</select></div>
      <div class="col"><label for="apa-pay_ref">UTR / cheque no.</label><input type="text" id="apa-pay_ref" data-apa="pay_ref" value="${apEsc(a.pay_ref || '')}"></div>
    </div>` : ''}
    ${a.action === 'schedule' ? `<label for="apa-scheduled_for">Payment will be released on *</label><input type="date" id="apa-scheduled_for" data-apa="scheduled_for" value="${apEsc(a.scheduled_for || '')}">` : ''}
    <label for="apa-message">${a.action === 'hold' ? 'Why is it on hold? *' : ['query', 'reply', 'note'].includes(a.action) ? 'Message *' : 'Message (optional)'}</label>
    <textarea id="apa-message" data-apa="message" placeholder="${a.action === 'query' ? 'e.g. GST number missing — please send the corrected bill' : a.action === 'followup' ? 'e.g. Vendor is calling daily' : ''}">${apEsc(a.message || '')}</textarea>
    ${['paid', 'partial', 'reply', 'note', 'query'].includes(a.action) ? `<label class="btn btn-sm" style="margin-top:6px;">📎 ${pay ? 'Payment proof' : 'Attach'}<input type="file" id="apa-files" accept="image/*,application/pdf,.pdf" multiple hidden></label> ${(a.files || []).map(f => `<span class="small">${apEsc(f.name)}</span>`).join(', ')}` : ''}
    ${a.err ? `<div class="err">${apEsc(a.err)}</div>` : ''}
    <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;"><button class="btn btn-primary btn-sm" data-ap-send="1" ${a.saving ? 'disabled' : ''}>${a.saving ? 'Saving…' : 'Send'}</button><button class="btn btn-sm" data-ap-act="act-cancel">Cancel</button></div>
  </div>`;
}
function apVendorsHTML(list) {
  const map = new Map();
  for (const b of list) {
    if (b.status === 'paid') continue;
    const g = map.get(b.vendor) || { vendor: b.vendor, n: 0, total: 0, notDue: 0, a0: 0, a30: 0, a60: 0, a90: 0, maxOver: 0 };
    g.n++; g.total += b.balance;
    const o = -b.days_left;
    if (o <= 0) g.notDue += b.balance; else if (o <= 30) g.a0 += b.balance; else if (o <= 60) g.a30 += b.balance; else if (o <= 90) g.a60 += b.balance; else g.a90 += b.balance;
    g.maxOver = Math.max(g.maxOver, o); map.set(b.vendor, g);
  }
  const rows = [...map.values()].sort((a, b) => (b.total - b.notDue) - (a.total - a.notDue) || b.total - a.total);
  if (!rows.length) return '<div class="empty">Nothing outstanding.</div>';
  const c = v => v ? apInr(Math.round(v * 100) / 100) : '—';
  return `<div class="small muted" style="margin:10px 0;">Outstanding by vendor, split by how many days overdue.</div>
    <div class="dlv-perf-wrap"><table class="dlv-perf bud-table"><thead><tr><th>Vendor</th><th>Bills</th><th style="text-align:right;">Not due yet</th><th style="text-align:right;">1–30 days</th><th style="text-align:right;">31–60</th><th style="text-align:right;">61–90</th><th style="text-align:right;">90+</th><th style="text-align:right;">Total</th></tr></thead><tbody>
    ${rows.map(g => `<tr><td><b>${apEsc(g.vendor)}</b>${g.maxOver > 0 ? `<div class="small dlv-over">oldest ${g.maxOver} days overdue</div>` : ''}</td><td>${g.n}</td><td style="text-align:right;">${c(g.notDue)}</td><td style="text-align:right;">${c(g.a0)}</td><td style="text-align:right;">${c(g.a30)}</td><td style="text-align:right;">${c(g.a60)}</td><td style="text-align:right;" class="${g.a90 ? 'dlv-over' : ''}">${c(g.a90)}</td><td style="text-align:right;"><b>${c(g.total)}</b></td></tr>`).join('')}
    </tbody></table></div>`;
}
// ---- send / edit bill
function apFormHTML(f) {
  const dl = (typeof deliveriesData !== 'undefined' ? deliveriesData.items || [] : []).filter(d => d.status !== 'cancelled').slice(0, 150);
  const vendors = [...new Set([...(typeof dlvVendorSuggestions === 'function' ? dlvVendorSuggestions() : []), ...(apData.bills || []).map(b => b.vendor)])];
  const base = f.bill_date || f.delivery_done_on || apToday();
  const due = f.due_override ? f.due_date : (f.credit_days !== '' && f.credit_days != null ? apAddDays(base, Number(f.credit_days)) : '');
  const left = due ? Math.round((Date.UTC(...due.split('-').map((v, i) => i === 1 ? v - 1 : +v)) - Date.UTC(...apToday().split('-').map((v, i) => i === 1 ? v - 1 : +v))) / 864e5) : null;
  const inp = (k, label, type = 'text', extra = '') => `<div class="col"><label for="apf-${k}">${label}</label><input type="${type}" id="apf-${k}" data-apf="${k}" value="${apEsc(f[k] == null ? '' : f[k])}" ${extra}></div>`;
  return `<div class="card est-form" id="ap-form">
    <div class="flex-between" style="gap:8px;flex-wrap:wrap;"><div class="card-title" style="margin:0;">${f.id ? `Edit ${apEsc(f.ref)}` : 'Send vendor bill to Accounts'}</div><button class="btn btn-sm" data-ap-act="form-cancel">Cancel</button></div>
    ${f.id ? '' : `<label for="apf-delivery">For delivery</label><select id="apf-delivery" data-apf="delivery_id"><option value="">— Not linked to a delivery —</option>${dl.map(d => `<option value="${d.id}" ${String(f.delivery_id) === String(d.id) ? 'selected' : ''}>${apEsc(d.ref)} — ${apEsc(d.title)}${d.vendor ? ` · ${apEsc(d.vendor)}` : ''} (${apEsc((DLV_STATUS[d.status] || {}).label || d.status)})</option>`).join('')}</select>`}
    <div class="row">${inp('vendor', 'Vendor / supplier *', 'text', 'list="apf-vendors" placeholder="e.g. Kratex Tradetech India"')}${inp('bill_no', 'Bill / invoice no.', 'text', 'placeholder="e.g. KT/2291"')}${inp('bill_date', 'Bill date', 'date')}</div>
    <datalist id="apf-vendors">${vendors.map(v => `<option value="${apEsc(v)}">`).join('')}</datalist>
    <div class="row">${inp('amount', 'Bill amount (₹) *', 'number', 'min="1" step="0.01" inputmode="decimal"')}
      <div class="col"><label for="apf-project">Project</label><select id="apf-project" data-apf="project"><option value="">—</option>${(apData.projects || []).map(p => `<option ${f.project === p ? 'selected' : ''}>${apEsc(p)}</option>`).join('')}</select></div>
      ${inp('delivery_done_on', 'Delivery done on *', 'date')}</div>
    <div class="dlv-section">Credit period</div>
    <div class="ap-credit">${[0, 7, 15, 30, 45, 60, 90].map(d => `<button type="button" class="dlv-ctab${!f.due_override && String(f.credit_days) === String(d) ? ' active' : ''}" data-ap-credit="${d}">${d === 0 ? 'Immediate' : `${d} days`}</button>`).join('')}
      <input type="number" id="apf-credit_days" data-apf="credit_days" min="0" max="365" step="1" value="${apEsc(f.due_override ? '' : (f.credit_days == null ? '' : f.credit_days))}" placeholder="other" style="width:90px;margin:0;">
      <label class="small" style="display:flex;gap:6px;align-items:center;"><input type="checkbox" id="apf-due-override" style="width:auto;margin:0;" ${f.due_override ? 'checked' : ''}> type a due date instead</label>
      ${f.due_override ? `<input type="date" id="apf-due_date" data-apf="due_date" value="${apEsc(f.due_date || '')}" style="width:auto;margin:0;">` : ''}</div>
    ${due ? `<div class="notice" style="margin-top:8px;">Due on <b>${apDay(due)}</b>${left != null ? ` — ${left < 0 ? `<b class="dlv-over">already overdue by ${-left} days</b>` : left === 0 ? '<b>today</b>' : `${left} days from today`}` : ''}. Accounts is reminded 15, 5 and 2 days before, on the day, and daily after.${f.due_override ? '' : ` <span class="muted small">(counted from the ${f.bill_date ? 'bill date' : f.delivery_done_on ? 'delivery date' : 'date today'})</span>`}</div>` : ''}
    <label for="apf-description">Notes for Accounts</label><textarea id="apf-description" data-apf="description" placeholder="e.g. Tiles 400 boxes received in full; GRN attached">${apEsc(f.description || '')}</textarea>
    ${f.id ? '' : `<label class="btn btn-sm" style="margin-top:8px;">📷 Vendor bill * (photo / PDF)<input type="file" id="apf-files" accept="image/*,application/pdf,.pdf" multiple hidden></label> ${(f.files || []).map(x => `<span class="small">${apEsc(x.name)}</span>`).join(', ')}
    <div class="dlv-section">Other documents <span class="muted small">— delivery challan, PO, GRN, e-way bill, LR… (optional)</span></div>
    ${(f.docs || []).map((d, i) => `<div class="ap-doc"><span class="ap-doc-type">📄 ${apEsc(apDocLabel(d.type))}</span><span class="small">${apEsc(d.name)}</span><button type="button" class="dlv-x" data-apf-docdel="${i}" aria-label="Remove">✕</button></div>`).join('')}
    <div class="ap-credit"><select id="apf-doctype" style="width:auto;margin:0;">${apDocTypeOptions(f.docType || 'challan', true)}</select>
      <label class="btn btn-sm">📎 Add<input type="file" id="apf-docfiles" accept="image/*,application/pdf,.pdf,.xlsx,.xls,.doc,.docx" multiple hidden></label></div>`}
    ${f.err ? `<div class="err">${apEsc(f.err)}</div>` : ''}
    <div style="margin-top:12px;"><button class="btn btn-primary btn-sm" data-ap-act="save" ${f.saving ? 'disabled' : ''}>${f.saving ? 'Sending…' : f.id ? 'Save changes' : '📨 Send to Accounts'}</button></div>
  </div>`;
}
// ---- import
function apImportHTML(im) {
  const r = im.result;
  return `<div class="card est-form">
    <div class="flex-between" style="gap:8px;flex-wrap:wrap;"><div class="card-title" style="margin:0;">Import vendor bills from Excel</div>
      <div style="display:flex;gap:8px;"><button class="btn btn-sm" data-ap-act="template">⬇ Template</button><button class="btn btn-sm" data-ap-act="import-cancel">Cancel</button></div></div>
    <div class="small muted">Outstanding bills you already track in Excel. Needed: Vendor (or Party / Supplier) and Amount (or Balance). Give Credit Days or a Due Date; Paid / Balance columns set what is already paid. Fully paid rows come in as paid.</div>
    <label class="btn btn-sm" style="margin-top:10px;">📂 Choose Excel / CSV<input type="file" id="ap-imp-file" accept=".xlsx,.xlsm,.csv" hidden></label> ${im.fileName ? `<span class="small">${apEsc(im.fileName)}</span>` : ''}
    ${im.loading ? '<div class="small muted">Reading…</div>' : ''}
    ${im.err ? `<div class="err">${apEsc(im.err)}</div>` : ''}
    ${r ? `<div class="small" style="margin-top:8px;"><b>${r.valid}</b> bill${r.valid === 1 ? '' : 's'} ready${r.errors ? `, <b class="dlv-over">${r.errors}</b> with problems (left out)` : ''}.</div>
      <div class="dlv-perf-wrap"><table class="dlv-perf bud-table"><thead><tr><th>Row</th><th>Vendor</th><th>Bill no.</th><th style="text-align:right;">Amount</th><th style="text-align:right;">Balance</th><th>Due</th><th>Project</th><th></th></tr></thead><tbody>
        ${r.rows.slice(0, 300).map(x => `<tr class="${x.error ? 'nr-unseen' : ''}"><td>${x.rowNumber}</td><td>${apEsc(x.vendor)}</td><td>${apEsc(x.bill_no || '')}</td><td style="text-align:right;">${x.amount != null ? apInr(x.amount) : '—'}</td><td style="text-align:right;">${x.balance != null ? apInr(x.balance) : '—'}</td>
          <td class="nowrap">${x.due_date ? apDay(x.due_date) : '—'}${x.days_left != null && x.balance > 0 ? `<div class="small ${x.days_left < 0 ? 'dlv-over' : 'muted'}">${x.days_left < 0 ? `overdue ${-x.days_left} d` : `in ${x.days_left} d`}</div>` : ''}</td><td>${apEsc(x.project || '—')}</td>
          <td class="small">${x.error ? `<span class="dlv-over">${apEsc(x.error)}</span>` : apEsc(x.note || '')}</td></tr>`).join('')}
      </tbody></table></div>
      ${r.valid ? `<div style="margin-top:10px;"><button class="btn btn-primary btn-sm" data-ap-act="import-go" ${im.saving ? 'disabled' : ''}>${im.saving ? 'Importing…' : `⬆ Import ${r.valid} bill${r.valid === 1 ? '' : 's'}`}</button></div>` : ''}` : ''}
  </div>`;
}

async function apReload() { try { apData = await api('/api/payables'); apSummary = await api('/api/payables/summary'); } catch (e) { setBanner(e.message); } render(); }
// From a delivery card: open the form with the delivery filled in.
function openBillFromDelivery(d) {
  ui.adminTab = 'accountsdept'; try { safeStorage.setItem('ls_last_tab', 'accountsdept'); } catch (e) {}
  const done = d.unloaded_at || d.delivered_at;
  apState().form = { delivery_id: d.id, vendor: d.vendor || '', project: d.project || '', delivery_done_on: done && typeof istDayKey === 'function' ? istDayKey(done) : '', bill_date: apToday(), credit_days: 30, files: [] };
  apState().imp = null; render(); window.scrollTo(0, 0);
}

// ---- Compliance due dates (TDS, GST, PT, PF …)
function compState() { const s = apState(); if (!s.comp) s.comp = { form: null, date: null, done: null }; return s.comp; }
function compChip(i) {
  if (i.unset) return '<span class="bud-chip warn">📅 Date not set</span>';
  const d = i.days_left;
  if (d < 0) return `<span class="bud-chip bad">Overdue ${-d} day${d === -1 ? '' : 's'}</span>`;
  if (d === 0) return '<span class="bud-chip bad">Due today</span>';
  if (d <= 2) return `<span class="bud-chip warn">${d} day${d === 1 ? '' : 's'} left</span>`;
  if (d <= 10) return `<span class="bud-chip warn">${d} days left</span>`;
  return `<span class="bud-chip">${d} days left</span>`;
}
const compOrd = (n) => { const v = n % 100; return n + (v >= 11 && v <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th')); };
function compFileChip(x, canDel) {
  return `<span class="comp-file"><button type="button" class="dlv-file" data-comp-file="${x.id}" title="${apEsc(`${x.uploaded_by_name || x.uploaded_by || ''} · ${apDay(x.created_at)}`)}">📎 ${apEsc(x.name)}</button>${canDel ? `<button type="button" class="dlv-x" data-comp-fdel="${x.id}" aria-label="Remove file">✕</button>` : ''}</span>`;
}
function compHTML() {
  if (!compData) return '<div class="small muted" style="margin-top:10px;">Loading compliance dates…</div>';
  const c = compState(); const can = compData.me && compData.me.canEdit;
  const f = c.form;
  return `<div class="comp-wrap">
    <div class="flex-between" style="gap:8px;flex-wrap:wrap;margin:10px 0 6px;">
      <div class="small muted">Monthly compliance dates. Accounts and Admin are reminded <b>${(compData.remindBefore || [10, 2]).join(' and ')} days before</b>, on the due date, and every day once it is overdue — until it is marked done for that month.</div>
      ${can && !f ? '<button class="btn btn-sm btn-primary" data-comp-act="new">+ Add due date</button>' : ''}
    </div>
    ${f ? `<div class="comp-form">
      <div class="row"><div class="col"><label for="comp-name">What is due *</label><input id="comp-name" type="text" value="${apEsc(f.name || '')}" placeholder="e.g. GST deposit"></div>
        <div class="col" style="max-width:170px;"><label for="comp-day">Due by (day of month)</label><input id="comp-day" type="number" min="1" max="31" inputmode="numeric" value="${apEsc(f.due_day || '')}" placeholder="e.g. 20 — or leave empty for now"></div></div>
      <label for="comp-notes">Notes</label><input id="comp-notes" type="text" value="${apEsc(f.notes || '')}" placeholder="e.g. or as per the due date on the bill">
      ${f.err ? `<div class="small" style="color:var(--danger);margin-top:6px;">${apEsc(f.err)}</div>` : ''}
      <div style="display:flex;gap:8px;margin-top:8px;"><button class="btn btn-sm btn-primary" data-comp-act="save">${f.id ? 'Save' : 'Add'}</button><button class="btn btn-sm" data-comp-act="cancel">Cancel</button></div>
    </div>` : ''}
    ${compData.items.length ? `<div class="comp-list">${compData.items.map(i => {
      const last = (i.history || [])[0];
      const dateOpen = c.date && c.date.id === i.id, doneOpen = c.done && c.done.id === i.id;
      return `<div class="comp-item ${i.days_left < 0 || i.days_left === 0 ? 'late' : i.days_left <= 2 ? 'soon' : ''}">
        <div class="comp-main">
          <div><b>${apEsc(i.name)}</b> ${i.unset ? '' : `<span class="small muted">· by the ${compOrd(i.due_day)} of every month</span>`}</div>
          <div class="small">${i.unset ? `${compChip(i)} <span class="muted">— set the day of the month with ✏️; reminders start after that.</span>` : `${apEsc(i.period_label)}: due <b>${apDay(i.due)}</b>${i.override ? ' <span class="muted">(date set for this month)</span>' : ''} ${compChip(i)}`}</div>
          ${i.notes ? `<div class="small muted">${apEsc(i.notes)}</div>` : ''}
          ${(i.files || []).length ? `<div class="dlv-files">${i.files.map(x => compFileChip(x, can)).join('')}</div>` : ''}
          ${last ? `<div class="small muted">Last done: ${apEsc(last.period_label)} — ${apEsc(last.done_by_name || last.done_by)}, ${apDay(last.done_at)}${last.note ? ` · ${apEsc(last.note)}` : ''}${can ? ` <button type="button" class="linklike" data-comp-undo="${i.id}:${last.period}">undo</button>` : ''}</div>
            ${(last.files || []).length ? `<div class="dlv-files">${last.files.map(x => compFileChip(x, false)).join('')}</div>` : ''}` : ''}
        </div>
        ${can && i.unset ? `<div class="comp-btns"><button class="btn btn-sm btn-primary" data-comp-edit="${i.id}">✏️ Set the date</button><button class="btn btn-sm" data-comp-del="${i.id}" title="Remove">✕</button></div>` : ''}
        ${can && !i.unset ? `<div class="comp-btns">
          <button class="btn btn-sm btn-primary" data-comp-done="${i.id}">✓ Done for ${apEsc(i.period_label)}</button>
          <label class="btn btn-sm" title="Upload the bill / challan for ${apEsc(i.period_label)}">📎 Upload bill<input type="file" data-comp-upload="${i.id}:${i.period}" accept="image/*,application/pdf,.pdf,.xlsx,.xls,.doc,.docx" multiple hidden></label>
          <button class="btn btn-sm" data-comp-date="${i.id}">📅 Date this month</button>
          <button class="btn btn-sm" data-comp-edit="${i.id}">✏️</button>
          <button class="btn btn-sm" data-comp-del="${i.id}" title="Remove">✕</button>
        </div>` : ''}
        ${doneOpen ? `<div class="comp-inline"><input type="text" id="comp-done-note" value="${apEsc(c.done.note || '')}" placeholder="Note (optional) — e.g. challan no., amount"><label class="btn btn-sm">📎 ${(c.done.files || []).length ? `${c.done.files.length} file${c.done.files.length > 1 ? 's' : ''}` : 'Attach bill / challan'}<input type="file" id="comp-done-files" accept="image/*,application/pdf,.pdf,.xlsx,.xls,.doc,.docx" multiple hidden></label><button class="btn btn-sm btn-primary" data-comp-act="done-save">Mark done</button><button class="btn btn-sm" data-comp-act="inline-cancel">Cancel</button></div>` : ''}
        ${dateOpen ? `<div class="comp-inline"><label class="small" for="comp-date-in">Due date for ${apEsc(i.period_label)}</label><input type="date" id="comp-date-in" value="${apEsc(c.date.value || '')}"><button class="btn btn-sm btn-primary" data-comp-act="date-save">Save</button>${i.override ? '<button class="btn btn-sm" data-comp-act="date-clear">Use the usual day</button>' : ''}<button class="btn btn-sm" data-comp-act="inline-cancel">Cancel</button></div>` : ''}
      </div>`;
    }).join('')}</div>` : '<div class="small muted">No compliance dates yet.</div>'}
  </div>`;
}
async function compReload() { try { compData = await api('/api/compliance'); } catch (e) { setBanner(e.message); } render(); }
function bindCompliance() {
  const c = compState();
  const on = (sel, fn) => document.querySelectorAll(sel).forEach(b => b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); fn(b); });
  const item = (id) => ((compData && compData.items) || []).find(i => i.id === Number(id));
  const post = async (b, path, body, ok) => { if (b) b.disabled = true; try { await api(path, { method: 'POST', body: JSON.stringify(body || {}) }); c.date = null; c.done = null; if (ok) setBanner(ok, 'ok'); await compReload(); } catch (e) { if (b) b.disabled = false; setBanner(e.message); render(); } };
  on('[data-comp-act="new"]', () => { c.form = { name: '', due_day: '', notes: '' }; render(); });
  on('[data-comp-act="cancel"]', () => { c.form = null; render(); });
  on('[data-comp-edit]', b => { const i = item(b.dataset.compEdit); if (i) { c.form = { id: i.id, name: i.name, due_day: i.due_day, notes: i.notes || '' }; render(); } });
  ['name', 'day', 'notes'].forEach(k => { const el = document.getElementById(`comp-${k}`); if (el && c.form) el.oninput = () => { c.form[k === 'day' ? 'due_day' : k] = el.value; }; });
  on('[data-comp-act="save"]', async b => {
    const f = c.form; b.disabled = true;
    try { await api(f.id ? `/api/compliance/${f.id}/update` : '/api/compliance', { method: 'POST', body: JSON.stringify({ name: f.name, due_day: f.due_day === '' || f.due_day == null ? null : Number(f.due_day), notes: f.notes }) }); c.form = null; setBanner('Compliance date saved.', 'ok'); await compReload(); }
    catch (e) { f.err = e.message; render(); }
  });
  on('[data-comp-del]', b => { const i = item(b.dataset.compDel); if (i && confirm(`Remove "${i.name}" from compliance dates? Its reminders stop.`)) post(b, `/api/compliance/${i.id}/delete`, {}, 'Removed.'); });
  on('[data-comp-done]', b => { const i = item(b.dataset.compDone); if (i) { c.done = { id: i.id, period: i.period, note: '' }; c.date = null; render(); const n = document.getElementById('comp-done-note'); if (n) n.focus(); } });
  on('[data-comp-date]', b => { const i = item(b.dataset.compDate); if (i) { c.date = { id: i.id, period: i.period, value: i.due }; c.done = null; render(); } });
  on('[data-comp-act="inline-cancel"]', () => { c.date = null; c.done = null; render(); });
  const dn = document.getElementById('comp-done-note'); if (dn && c.done) dn.oninput = () => { c.done.note = dn.value; };
  const di = document.getElementById('comp-date-in'); if (di && c.date) di.oninput = di.onchange = () => { c.date.value = di.value; };
  const readFiles = (input, cb) => { const list = Array.from(input.files || []).slice(0, 10); const out = []; let left = list.length; if (!left) return; list.forEach(file => readAnyFile(file, d => { if (d) out.push({ name: file.name, data: d }); if (--left === 0) cb(out); })); };
  const dfi = document.getElementById('comp-done-files'); if (dfi && c.done) dfi.onchange = () => readFiles(dfi, out => { c.done.files = out; render(); });
  on('[data-comp-act="done-save"]', b => post(b, `/api/compliance/${c.done.id}/done`, { period: c.done.period, note: c.done.note, attachments: c.done.files || [] }, 'Marked done — the reminders for this month stop.'));
  document.querySelectorAll('[data-comp-upload]').forEach(inp => inp.onchange = () => {
    const [id, period] = inp.dataset.compUpload.split(':');
    readFiles(inp, out => post(null, `/api/compliance/${id}/files`, { period, attachments: out }, `${out.length} file${out.length > 1 ? 's' : ''} uploaded.`));
  });
  on('[data-comp-file]', async b => { try { const r = await api(`/api/compliance/files/${b.dataset.compFile}`); if (/^data:image\//.test(r.data)) { ui.deliveryPhoto = r; render(); } else downloadDataUrl(r.data, r.name); } catch (e) { setBanner(e.message); render(); } });
  on('[data-comp-fdel]', b => { if (confirm('Remove this file?')) post(b, `/api/compliance/files/${b.dataset.compFdel}/delete`, {}, 'File removed.'); });
  on('[data-comp-act="date-save"]', b => post(b, `/api/compliance/${c.date.id}/due-date`, { period: c.date.period, due_date: c.date.value }, 'Due date set for this month.'));
  on('[data-comp-act="date-clear"]', b => post(b, `/api/compliance/${c.date.id}/due-date`, { period: c.date.period, due_date: '' }, 'Back to the usual day.'));
  on('[data-comp-undo]', b => { const [id, period] = b.dataset.compUndo.split(':'); post(b, `/api/compliance/${id}/undone`, { period }, 'Marked not done.'); });
}
function bindAccountsDeptView() {
  const s = apState();
  if (!apData && apSummary.canView) { apReload(); return; }
  if (typeof bindAccOverview === 'function' && (s.tab === 'other' || !apSummary.canView)) bindAccOverview();
  if (!apData) return;
  const on = (sel, fn) => document.querySelectorAll(sel).forEach(b => b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); fn(b); });
  on('[data-ap-tab]', b => { s.tab = b.dataset.apTab; if (s.tab === 'compliance' && !compData) compReload(); render(); });
  if (s.tab === 'compliance') { if (!compData) compReload(); bindCompliance(); }
  on('[data-ap-open]', b => { const id = Number(b.dataset.apOpen); s.open = s.open === id ? null : id; s.act = null; render(); });
  const pj = document.getElementById('ap-project'); if (pj) pj.onchange = () => { s.project = pj.value; render(); };
  const q = document.getElementById('ap-q'); if (q) q.oninput = () => { s.q = q.value; clearTimeout(window.__apQ); window.__apQ = setTimeout(() => { render(); const n = document.getElementById('ap-q'); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } }, 300); };
  on('[data-ap-act="close-photo"]', () => { ui.deliveryPhoto = null; render(); });
  on('[data-ap-act="download-photo"]', () => { const p = ui.deliveryPhoto; if (p) downloadDataUrl(p.data, p.name); });
  on('[data-ap-file]', async b => { try { const r = await api(`/api/payables/files/${b.dataset.apFile}`); if (/^data:image\//.test(r.data)) { ui.deliveryPhoto = r; render(); } else downloadDataUrl(r.data, r.name); } catch (e) { setBanner(e.message); render(); } });
  on('[data-ap-dlv]', b => openDeliveryOnPage(Number(b.dataset.apDlv)));
  on('[data-ap-dfile]', async b => { const [d, fid] = b.dataset.apDfile.split(':'); try { const r = await api(`/api/deliveries/${d}/files/${fid}`); if (/^data:image\//.test(r.data)) { ui.deliveryPhoto = r; render(); } else downloadDataUrl(r.data, r.name); } catch (e) { setBanner(e.message); render(); } });
  on('[data-ap-adddoc]', b => { s.addDoc = { id: Number(b.dataset.apAdddoc), type: 'challan', files: [] }; render(); });
  on('[data-ap-act="doc-cancel"]', () => { s.addDoc = null; render(); });
  const ad = s.addDoc;
  if (ad) {
    const ty = document.getElementById('apd-type'); if (ty) ty.onchange = () => { ad.type = ty.value; };
    const fi = document.getElementById('apd-files'); if (fi) fi.onchange = () => { const list = Array.from(fi.files || []).slice(0, 10); ad.files = []; let left = list.length; list.forEach(file => readAnyFile(file, d => { if (d) ad.files.push({ name: file.name, data: d }); if (--left === 0) render(); })); };
    on('[data-ap-act="doc-save"]', async () => {
      if (ad.saving) return; if (!ad.files.length) { ad.err = 'Choose the file first.'; render(); return; }
      ad.saving = true; render();
      try { await api(`/api/payables/${ad.id}/files`, { method: 'POST', body: JSON.stringify({ type: ad.type, attachments: ad.files }) }); s.addDoc = null; setBanner(`${apDocLabel(ad.type)} uploaded.`, 'ok'); await apReload(); }
      catch (e) { ad.saving = false; ad.err = e.message; render(); }
    });
  }
  on('[data-ap-act="csv"]', () => {
    const rows = apFiltered(apData.bills);
    const csv = [['Ref', 'Vendor', 'Bill no', 'Bill date', 'Amount', 'Paid', 'Balance', 'Credit days', 'Due date', 'Days overdue', 'Status', 'Project', 'Delivery', 'Sent by'],
      ...rows.map(b => [b.ref, b.vendor, b.bill_no, b.bill_date, b.amount, b.paid_amount, b.balance, b.credit_days, b.due_date, b.overdue_days, b.status, b.project, b.delivery_ref, b.created_by_name])];
    downloadDataUrl('data:text/csv;charset=utf-8;base64,' + btoa(unescape(encodeURIComponent('﻿' + csv.map(r => r.map(c => { const v = String(c == null ? '' : c); return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; }).join(',')).join('\n')))), `vendor-bills-${apToday()}.csv`);
  });
  // ---- actions on a bill
  on('[data-ap-do]', async b => {
    const [id, action] = b.dataset.apDo.split(':');
    s.act = { id: Number(id), action, files: [], pay_mode: (apData.payModes || [])[0] }; render();
    const t = document.getElementById(action === 'schedule' ? 'apa-scheduled_for' : action === 'partial' ? 'apa-amount' : 'apa-message'); if (t) t.focus();
  });
  on('[data-ap-act="act-cancel"]', () => { s.act = null; render(); });
  const a = s.act;
  if (a) {
    document.querySelectorAll('[data-apa]').forEach(el => { const k = el.dataset.apa; el.oninput = () => { a[k] = el.value; }; el.onchange = () => { a[k] = el.value; }; });
    const fi = document.getElementById('apa-files'); if (fi) fi.onchange = () => { const list = Array.from(fi.files || []).slice(0, 5); a.files = []; let left = list.length; list.forEach(file => readAnyFile(file, d => { if (d) a.files.push({ name: file.name, data: d }); if (--left === 0) render(); })); };
    on('[data-ap-send]', async () => {
      if (a.saving) return; a.saving = true; a.err = ''; render();
      try {
        if (a.action === 'followup') await api(`/api/payables/${a.id}/followup`, { method: 'POST', body: JSON.stringify({ message: a.message || '' }) });
        else await api(`/api/payables/${a.id}/respond`, { method: 'POST', body: JSON.stringify({ action: a.action, message: a.message || '', amount: a.amount || '', pay_date: a.pay_date || apToday(), pay_mode: a.pay_mode, pay_ref: a.pay_ref || '', scheduled_for: a.scheduled_for || '', attachments: a.files }) });
        const done = { paid: 'Marked paid — Purchase and Admin have been told.', partial: 'Part payment recorded — Purchase and Admin have been told.', schedule: 'Payment scheduled — Purchase and Admin have been told.', query: 'Question sent to Purchase.', hold: 'Put on hold — Purchase and Admin have been told.', resume: 'Taken off hold.', reply: 'Reply sent to Accounts.', note: 'Note added.', followup: 'Follow-up sent to Accounts.' }[a.action];
        s.act = null; setBanner(done, 'ok'); await apReload();
      } catch (e) { a.saving = false; a.err = e.message; render(); }
    });
  }
  on('[data-ap-del]', async b => {
    if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Tap again to delete'; return; }
    try { await api(`/api/payables/${b.dataset.apDel}/delete`, { method: 'POST' }); setBanner('Bill removed.', 'ok'); s.open = null; await apReload(); } catch (e) { setBanner(e.message); render(); }
  });
  on('[data-ap-edit]', b => {
    const x = apData.bills.find(y => y.id === Number(b.dataset.apEdit)); if (!x) return;
    s.form = { id: x.id, ref: x.ref, vendor: x.vendor, bill_no: x.bill_no || '', bill_date: x.bill_date || '', amount: x.amount, project: x.project || '', delivery_done_on: x.delivery_done_on || '', credit_days: x.credit_days == null ? '' : x.credit_days, due_date: x.due_date, due_override: x.credit_days == null, description: x.description || '' };
    render(); window.scrollTo(0, 0);
  });
  // ---- send bill form
  on('[data-ap-act="new"]', () => { s.form = { bill_date: apToday(), delivery_done_on: apToday(), credit_days: 30, files: [] }; s.imp = null; render(); });
  on('[data-ap-act="form-cancel"]', () => { s.form = null; render(); });
  const f = s.form;
  if (f) {
    document.querySelectorAll('[data-apf]').forEach(el => { const k = el.dataset.apf; el.oninput = () => { f[k] = el.value; }; el.onchange = () => {
      f[k] = el.value;
      if (k === 'delivery_id' && el.value) { const d = (deliveriesData.items || []).find(x => x.id === Number(el.value)); if (d) { if (d.vendor && !f.vendor) f.vendor = d.vendor; if (d.project) f.project = d.project; const done = d.unloaded_at || d.delivered_at; if (done && typeof istDayKey === 'function') f.delivery_done_on = istDayKey(done); } }
      if (['delivery_id', 'bill_date', 'delivery_done_on', 'credit_days', 'due_date', 'project'].includes(k)) render();
    }; });
    on('[data-ap-credit]', b => { f.credit_days = Number(b.dataset.apCredit); f.due_override = false; render(); });
    const dt = document.getElementById('apf-doctype'); if (dt) dt.onchange = () => { f.docType = dt.value; };
    const dfi = document.getElementById('apf-docfiles');
    if (dfi) dfi.onchange = () => { const type = (document.getElementById('apf-doctype') || {}).value || 'other'; f.docType = type; const list = Array.from(dfi.files || []).slice(0, 10); f.docs = f.docs || []; let left = list.length; list.forEach(file => readAnyFile(file, d => { if (d) f.docs.push({ type, name: file.name, data: d }); if (--left === 0) render(); })); };
    on('[data-apf-docdel]', b => { f.docs.splice(Number(b.dataset.apfDocdel), 1); render(); });
    const ov = document.getElementById('apf-due-override'); if (ov) ov.onchange = () => { f.due_override = ov.checked; if (!ov.checked) f.due_date = ''; render(); };
    const fi = document.getElementById('apf-files'); if (fi) fi.onchange = () => { const list = Array.from(fi.files || []).slice(0, 5); f.files = []; let left = list.length; list.forEach(file => readAnyFile(file, d => { if (d) f.files.push({ name: file.name, data: d }); if (--left === 0) render(); })); };
    on('[data-ap-act="save"]', async () => {
      if (f.saving) return;
      if (!f.id && !(f.files || []).length) { f.err = 'Attach the vendor bill (photo or PDF).'; render(); return; }
      f.saving = true; f.err = ''; render();
      const body = { vendor: f.vendor, bill_no: f.bill_no, bill_date: f.bill_date, amount: f.amount, project: f.project, delivery_done_on: f.delivery_done_on, description: f.description,
        credit_days: f.due_override ? '' : f.credit_days, due_date: f.due_override ? f.due_date : '', delivery_id: f.delivery_id ? Number(f.delivery_id) : null, attachments: f.files || [], documents: f.docs || [] };
      try {
        const r = await api(f.id ? `/api/payables/${f.id}/update` : '/api/payables', { method: 'POST', body: JSON.stringify(body) });
        setBanner(f.id ? 'Bill updated.' : `Sent to Accounts as ${r.ref} — due ${apDay(r.due_date)}. Accounts will be reminded before it is due.`, 'ok');
        s.form = null; s.open = r.id || f.id; s.tab = 'all'; await apReload();
      } catch (e) { f.saving = false; f.err = e.message; render(); }
    });
  }
  // ---- import
  on('[data-ap-act="import"]', () => { s.imp = {}; s.form = null; render(); });
  on('[data-ap-act="import-cancel"]', () => { s.imp = null; render(); });
  on('[data-ap-act="template"]', async () => { try { const t = await api('/api/payables/template'); downloadDataUrl(t.data, t.name); } catch (e) { setBanner(e.message); render(); } });
  const im = s.imp;
  if (im) {
    const fi = document.getElementById('ap-imp-file');
    if (fi) fi.onchange = () => {
      const file = (fi.files || [])[0]; if (!file) return;
      im.loading = true; im.err = ''; im.result = null; im.fileName = file.name; render();
      readAnyFile(file, async data => {
        im.fileData = data;
        try { im.result = await api('/api/payables/import/preview', { method: 'POST', body: JSON.stringify({ fileData: data, fileName: file.name }) }); } catch (e) { im.err = e.message; }
        im.loading = false; render();
      });
    };
    on('[data-ap-act="import-go"]', async () => {
      if (im.saving) return; im.saving = true; render();
      try { const r = await api('/api/payables/import', { method: 'POST', body: JSON.stringify({ fileData: im.fileData, fileName: im.fileName }) }); s.imp = null; s.tab = 'overdue'; setBanner(`${r.created} bill${r.created === 1 ? '' : 's'} imported${r.skipped ? ` (${r.skipped} row${r.skipped === 1 ? '' : 's'} with problems left out)` : ''}.`, 'ok'); await apReload(); }
      catch (e) { im.saving = false; im.err = e.message; render(); }
    });
  }
}
