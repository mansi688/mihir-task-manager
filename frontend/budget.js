/* Budget tab — every delivery's porter / transport budget against what was actually paid, every expense,
   who paid it, and the bill / receipt behind it. Built on the same data as the Deliveries tab
   (deliveriesData), so it always matches the delivery cards. Purchase / Admin / Director / Accounts see all
   deliveries; the site team sees the ones they are tagged on.
   Loaded after deliveries.js and before app.js; driven by ui.* state. */

const BUD_VIEWS = [
  { key: 'match', label: '⚖️ Budget vs spent' },
  { key: 'expenses', label: '🧾 All expenses' },
  { key: 'receipts', label: '📷 Receipts' },
  { key: 'summary', label: '📊 Summary' },
];
const BUD_PERIODS = [
  { key: 'month', label: 'This month' }, { key: 'lastmonth', label: 'Last month' }, { key: '30d', label: 'Last 30 days' },
  { key: 'year', label: 'This year' }, { key: 'all', label: 'All time' }, { key: 'custom', label: 'Custom dates' },
];
const budBillCache = new Map(); // file id -> data URL (receipt previews, fetched on demand)
const budBillLoading = new Set();

function budState() {
  if (!ui.budget) ui.budget = { view: 'match', period: 'month', from: '', to: '', project: '', person: '', purpose: '', mode: '', bill: '', match: '', q: '', receiptsShown: 24 };
  return ui.budget;
}
function budToday() { return dlvIstDay(new Date().toISOString()); }
function budRange(s) {
  const today = budToday();
  const [y, m] = today.split('-').map(Number);
  const pad = n => String(n).padStart(2, '0');
  // Periods run to their end (not today), so deliveries booked later this month still count.
  if (s.period === 'month') return [`${y}-${pad(m)}-01`, `${y}-${pad(m)}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`];
  if (s.period === 'lastmonth') { const ly = m === 1 ? y - 1 : y, lm = m === 1 ? 12 : m - 1; const last = new Date(Date.UTC(ly, lm, 0)).getUTCDate(); return [`${ly}-${pad(lm)}-01`, `${ly}-${pad(lm)}-${pad(last)}`]; }
  if (s.period === '30d') return [dlvIstDay(new Date(Date.now() - 30 * 864e5).toISOString()), ''];
  if (s.period === 'year') return [`${y}-01-01`, `${y}-12-31`];
  if (s.period === 'custom') return [s.from || '', s.to || ''];
  return ['', ''];
}
const budIn = (day, [from, to]) => (!from || day >= from) && (!to || day <= to);
function budRound(n) { return Math.round((n || 0) * 100) / 100; }

// Everything the page needs, after filters.
function budCompute() {
  const s = budState();
  const range = budRange(s);
  const q = (s.q || '').trim().toLowerCase();
  const all = (deliveriesData.items || []).filter(d => d.status !== 'cancelled' || (d.payments || []).length);
  const dMatch = d => (!s.project || (d.project || '') === s.project)
    && (!q || [d.ref, d.title, d.project, d.vendor].filter(Boolean).join(' ').toLowerCase().includes(q));
  // Payments: by the date paid
  const payments = [];
  for (const d of all) {
    if (!dMatch(d)) continue;
    for (const p of d.payments || []) {
      const day = String(p.paid_at || p.created_at || '').slice(0, 10);
      if (!budIn(day, range)) continue;
      if (s.person && p.paid_by !== s.person) continue;
      if (s.purpose && p.purpose !== s.purpose) continue;
      if (s.mode && (p.mode || '') !== s.mode) continue;
      const hasBill = (p.bills || []).length > 0;
      if (s.bill === 'with' && !hasBill) continue;
      if (s.bill === 'without' && hasBill) continue;
      payments.push({ ...p, day, delivery: d, hasBill });
    }
  }
  payments.sort((a, b) => b.day.localeCompare(a.day) || b.id - a.id);
  // Deliveries: by delivery date — budget against everything paid on it (whatever the payment filters)
  const rows = all.filter(d => dMatch(d) && budIn(String(d.expected_at || d.created_at || '').slice(0, 10), range)
      && (d.budget_amount != null || (d.payments || []).length))
    .filter(d => !s.person || (d.payments || []).some(p => p.paid_by === s.person) || (d.receivers || []).includes(s.person))
    .map(d => {
      const spent = budRound(d.paid || 0);
      const budget = d.budget_amount;
      const diff = budget == null ? null : budRound(budget - spent);
      const pays = d.payments || [];
      const status = budget == null ? 'nobudget' : spent === 0 ? 'unused' : diff < 0 ? 'over' : 'within';
      return { d, budget, spent, diff, status, pct: budget ? Math.round(spent / budget * 100) : null,
        bills: pays.filter(p => (p.bills || []).length).length, count: pays.length };
    })
    .filter(r => !s.match || r.status === s.match)
    .sort((a, b) => (a.status === 'over' ? 0 : 1) - (b.status === 'over' ? 0 : 1) || String(b.d.expected_at || '').localeCompare(String(a.d.expected_at || '')));
  const budgeted = rows.filter(r => r.budget != null);
  const totals = {
    budget: budRound(budgeted.reduce((a, r) => a + r.budget, 0)),
    spentOnBudgeted: budRound(budgeted.reduce((a, r) => a + r.spent, 0)),
    spentNoBudget: budRound(rows.filter(r => r.budget == null).reduce((a, r) => a + r.spent, 0)),
    expenses: budRound(payments.reduce((a, p) => a + p.amount, 0)),
    over: rows.filter(r => r.status === 'over'),
    noBill: payments.filter(p => !p.hasBill),
    bills: payments.reduce((a, p) => a + (p.bills || []).length, 0),
  };
  return { s, range, rows, payments, totals };
}
function budGroup(payments, keyFn, labelFn) {
  const m = new Map();
  for (const p of payments) {
    const k = keyFn(p); const r = m.get(k) || { key: k, label: labelFn(p), total: 0, count: 0, noBill: 0, deliveries: new Set() };
    r.total += p.amount; r.count++; if (!p.hasBill) r.noBill++; r.deliveries.add(p.delivery.id); m.set(k, r);
  }
  return [...m.values()].map(r => ({ ...r, total: budRound(r.total) })).sort((a, b) => b.total - a.total);
}

// Menu: shown to the purchase side, Admin, Director, Accounts, and anyone on a delivery with money on it.
function budgetTabVisible() {
  if (dlvCanManage() || deliveriesData.seesAll) return true;
  return (deliveriesData.items || []).some(d => dlvMine(d) && (d.budget_amount != null || (d.payments || []).length));
}
// Badge for the purchase side: deliveries over budget + payments without a bill (last 30 days).
function budgetAttentionCount() {
  if (!dlvCanManage()) return 0;
  const from = dlvIstDay(new Date(Date.now() - 30 * 864e5).toISOString());
  let n = 0;
  for (const d of deliveriesData.items || []) {
    if (d.status === 'cancelled') continue;
    if (d.balance != null && d.balance < 0) n++;
    n += (d.payments || []).filter(p => !(p.bills || []).length && String(p.paid_at || '').slice(0, 10) >= from).length;
  }
  return n;
}

function renderBudgetView() {
  const c = budCompute(); const { s, rows, payments, totals } = c;
  const items = deliveriesData.items || [];
  const projects = [...new Set(items.map(d => d.project).filter(Boolean))].sort();
  const payers = new Map(); for (const d of items) for (const p of d.payments || []) payers.set(p.paid_by, p.paid_by_name || personName(p.paid_by));
  const opt = (v, label, cur) => `<option value="${dlvEsc(v)}" ${cur === v ? 'selected' : ''}>${dlvEsc(label)}</option>`;
  const bal = budRound(totals.budget - totals.spentOnBudgeted);
  const view = BUD_VIEWS.some(v => v.key === s.view) ? s.view : 'match';
  return `
  <div class="card">
    <div class="flex-between" style="flex-wrap:wrap;gap:10px;">
      <div><div class="card-title" style="margin:0;">Budget</div>
        <div class="small muted">Porter / transport budgets on deliveries against what was actually paid — every expense, who paid it and its bill.
          ${dlvCanManage() || deliveriesData.seesAll ? 'Shows all deliveries.' : 'Shows the deliveries you are tagged on.'} Budgets are set on the delivery; payments are recorded on the delivery's 💰 tab.</div></div>
      <button class="btn btn-sm" data-bud-act="csv">⬇ Download expenses (CSV)</button>
    </div>
    <div class="bud-filters">
      <div><label for="bud-period">Period</label><select id="bud-period">${BUD_PERIODS.map(p => opt(p.key, p.label, s.period)).join('')}</select></div>
      ${s.period === 'custom' ? `<div><label for="bud-from">From</label><input type="date" id="bud-from" value="${dlvEsc(s.from)}"></div><div><label for="bud-to">To</label><input type="date" id="bud-to" value="${dlvEsc(s.to)}"></div>` : ''}
      <div><label for="bud-project">Project / site</label><select id="bud-project">${opt('', 'All projects', s.project)}${projects.map(p => opt(p, p, s.project)).join('')}</select></div>
      <div><label for="bud-person">Paid by</label><select id="bud-person">${opt('', 'Everyone', s.person)}${[...payers].sort((a, b) => a[1].localeCompare(b[1])).map(([u, n]) => opt(u, n, s.person)).join('')}</select></div>
      <div class="bud-search"><label for="bud-q">Search</label><input type="text" id="bud-q" value="${dlvEsc(s.q)}" placeholder="DLV number, material, vendor…"></div>
    </div>
    <div class="small muted" style="margin-top:6px;">Expenses are counted by the date paid; budgets by the delivery date.</div>
  </div>

  <div class="dlv-money-tiles bud-tiles">
    <div class="dlv-tile"><span>Total budget</span><b>${dlvInr(totals.budget)}</b></div>
    <div class="dlv-tile"><span>Spent (budgeted deliveries)</span><b>${dlvInr(totals.spentOnBudgeted)}</b></div>
    <div class="dlv-tile ${bal < 0 ? 'bad' : 'good'}"><span>${bal < 0 ? 'Over budget by' : 'Balance left'}</span><b>${dlvInr(Math.abs(bal))}</b></div>
    <div class="dlv-tile"><span>All expenses in period</span><b>${dlvInr(totals.expenses)}</b><small class="muted">${payments.length} payment${payments.length === 1 ? '' : 's'}</small></div>
    <div class="dlv-tile ${totals.over.length ? 'bad' : ''}"><span>Deliveries over budget</span><b>${totals.over.length}</b></div>
    <div class="dlv-tile ${totals.noBill.length ? 'warn' : ''}"><span>Payments without bill</span><b>${totals.noBill.length}</b><small class="muted">${totals.bills} bill${totals.bills === 1 ? '' : 's'} attached</small></div>
  </div>
  ${totals.spentNoBudget ? `<div class="notice dlv-warn" style="margin:0 0 12px;">⚠ ${dlvInr(totals.spentNoBudget)} was paid on deliveries that have no budget set.${dlvCanManage() ? ' Set a budget on them under “Budget vs spent”.' : ''}</div>` : ''}

  <div class="card">
    <div class="task-tabs" role="tablist">${BUD_VIEWS.map(v => `<button class="task-tab${view === v.key ? ' active' : ''}" data-bud-view="${v.key}">${v.label}${v.key === 'expenses' ? ` <span class="task-tab-count">${payments.length}</span>` : v.key === 'match' ? ` <span class="task-tab-count">${rows.length}</span>` : v.key === 'receipts' ? ` <span class="task-tab-count">${totals.bills}</span>` : ''}</button>`).join('')}</div>
    ${view === 'match' ? budMatchHTML(c) : view === 'expenses' ? budExpensesHTML(c) : view === 'receipts' ? budReceiptsHTML(c) : budSummaryHTML(c)}
  </div>
  ${ui.deliveryPhoto ? `<div class="dlv-viewer" data-dlv-act="close-photo"><img src="${ui.deliveryPhoto.data}" alt="${dlvEsc(ui.deliveryPhoto.name)}"><div class="dlv-viewer-bar"><span>${dlvEsc(ui.deliveryPhoto.name)}</span><button class="btn btn-sm" data-dlv-act="download-photo">Download</button><button class="btn btn-sm" data-dlv-act="close-photo">Close</button></div></div>` : ''}`;
}

const BUD_MATCH = {
  within: { label: 'Within budget', cls: 'good' }, over: { label: 'Over budget', cls: 'bad' },
  unused: { label: 'Nothing spent yet', cls: '' }, nobudget: { label: 'No budget set', cls: 'warn' },
};
function budDlvLink(d) { return `<button type="button" class="bud-dlv" data-bud-open="${d.id}"><b>${dlvEsc(d.ref)}</b> ${dlvEsc(d.title)}</button>`; }
function budMatchHTML({ s, rows }) {
  const tot = rows.reduce((a, r) => ({ budget: a.budget + (r.budget || 0), spent: a.spent + r.spent }), { budget: 0, spent: 0 });
  return `
    <div class="bud-subfilters"><label for="bud-match">Show</label><select id="bud-match">
      <option value="">All deliveries</option>${Object.entries(BUD_MATCH).map(([k, v]) => `<option value="${k}" ${s.match === k ? 'selected' : ''}>${v.label}</option>`).join('')}</select></div>
    ${rows.length ? `<div class="dlv-perf-wrap"><table class="dlv-perf bud-table">
      <thead><tr><th>Delivery</th><th>Project</th><th>Date</th><th style="text-align:right;">Budget</th><th style="text-align:right;">Spent</th><th style="text-align:right;">Difference</th><th>Used</th><th>Bills</th><th>Status</th></tr></thead>
      <tbody>${rows.map(r => `<tr class="${r.status === 'over' ? 'bud-row-over' : ''}">
        <td>${budDlvLink(r.d)}${r.d.status === 'cancelled' ? ' <span class="small muted">(cancelled)</span>' : ''}</td>
        <td>${dlvEsc(r.d.project || '—')}</td><td class="nowrap">${dlvEsc(dlvWhen(String(r.d.expected_at || '').slice(0, 10)))}</td>
        <td style="text-align:right;">${r.budget == null ? '<span class="muted">—</span>' : dlvInr(r.budget)}</td>
        <td style="text-align:right;"><b>${dlvInr(r.spent)}</b></td>
        <td style="text-align:right;" class="${r.diff != null && r.diff < 0 ? 'dlv-over' : ''}">${r.diff == null ? '—' : (r.diff < 0 ? '−' : '') + dlvInr(Math.abs(r.diff))}</td>
        <td>${r.pct == null ? '—' : `<div class="bud-mini"><div class="dlv-bar"><div class="dlv-bar-fill ${r.pct > 100 ? 'over' : r.pct >= 80 ? 'near' : ''}" style="width:${Math.min(100, r.pct)}%"></div></div><span>${r.pct}%</span></div>`}</td>
        <td>${r.count ? `${r.bills}/${r.count}${r.bills < r.count ? ' <span class="dlv-nobill">⚠</span>' : ''}` : '—'}</td>
        <td><span class="bud-chip ${BUD_MATCH[r.status].cls}">${BUD_MATCH[r.status].label}</span></td></tr>`).join('')}
        <tr class="dlv-total"><td colspan="3">Total (${rows.length})</td><td style="text-align:right;">${dlvInr(budRound(tot.budget))}</td><td style="text-align:right;">${dlvInr(budRound(tot.spent))}</td><td colspan="4"></td></tr>
      </tbody></table></div>` : '<div class="empty">No delivery with a budget or payments in this period.</div>'}`;
}
function budExpensesHTML({ s, payments }) {
  const total = budRound(payments.reduce((a, p) => a + p.amount, 0));
  const purposes = typeof dlvPayPurposes === 'function' ? dlvPayPurposes() : [];
  const modes = typeof dlvPayModes === 'function' ? dlvPayModes() : [];
  return `
    <div class="bud-subfilters">
      <label for="bud-purpose">For</label><select id="bud-purpose"><option value="">Anything</option>${purposes.map(x => `<option ${s.purpose === x ? 'selected' : ''}>${dlvEsc(x)}</option>`).join('')}</select>
      <label for="bud-mode">Mode</label><select id="bud-mode"><option value="">Any</option>${modes.map(x => `<option ${s.mode === x ? 'selected' : ''}>${dlvEsc(x)}</option>`).join('')}</select>
      <label for="bud-bill">Bill</label><select id="bud-bill"><option value="">All</option><option value="with" ${s.bill === 'with' ? 'selected' : ''}>With bill</option><option value="without" ${s.bill === 'without' ? 'selected' : ''}>Without bill</option></select>
    </div>
    ${payments.length ? `<div class="dlv-perf-wrap"><table class="dlv-perf bud-table">
      <thead><tr><th>Date paid</th><th>Delivery</th><th>Project</th><th>For</th><th>Paid to</th><th>Mode</th><th>Paid by</th><th style="text-align:right;">Amount</th><th>Bill / receipt</th></tr></thead>
      <tbody>${payments.map(p => `<tr>
        <td class="nowrap">${dlvEsc(dlvWhen(p.day))}</td><td>${budDlvLink(p.delivery)}</td><td>${dlvEsc(p.delivery.project || '—')}</td>
        <td>${dlvEsc(p.purpose)}${p.note ? `<div class="small muted">${dlvEsc(p.note)}</div>` : ''}</td><td>${dlvEsc(p.paid_to || '—')}</td><td>${dlvEsc(p.mode || '—')}</td>
        <td>${dlvEsc(p.paid_by_name || personName(p.paid_by))}</td><td style="text-align:right;"><b>${dlvInr(p.amount)}</b></td>
        <td>${p.hasBill ? p.bills.map((f, i) => `<button type="button" class="dlv-file" data-dlv-file="${p.delivery.id}:${f.id}">🧾 ${p.bills.length > 1 ? `Bill ${i + 1}` : 'View bill'}</button>`).join(' ') : `<span class="dlv-nobill">No bill${p.no_bill_reason ? ` — ${dlvEsc(p.no_bill_reason)}` : ''}</span>`}</td></tr>`).join('')}
        <tr class="dlv-total"><td colspan="7">Total (${payments.length} payment${payments.length === 1 ? '' : 's'})</td><td style="text-align:right;">${dlvInr(total)}</td><td></td></tr>
      </tbody></table></div>` : '<div class="empty">No expenses match these filters.</div>'}`;
}
function budReceiptsHTML({ s, payments }) {
  const withBills = payments.filter(p => p.hasBill);
  const shown = [];
  for (const p of withBills) for (const f of p.bills) shown.push({ p, f });
  const page = shown.slice(0, s.receiptsShown || 24);
  const missing = payments.filter(p => !p.hasBill);
  return `
    ${missing.length ? `<div class="bud-missing"><b>⚠ ${missing.length} payment${missing.length > 1 ? 's' : ''} without a bill</b>
      ${missing.map(p => `<div class="small">${dlvEsc(dlvWhen(p.day))} · ${dlvEsc(p.delivery.ref)} · ${dlvEsc(p.purpose)} · <b>${dlvInr(p.amount)}</b> · ${dlvEsc(p.paid_by_name || personName(p.paid_by))}${p.no_bill_reason ? ` — “${dlvEsc(p.no_bill_reason)}”` : ''}</div>`).join('')}</div>` : ''}
    ${page.length ? `<div class="bud-receipts">${page.map(({ p, f }) => {
      const img = budBillCache.get(f.id);
      return `<button type="button" class="bud-receipt" data-dlv-file="${p.delivery.id}:${f.id}" data-bud-bill="${p.delivery.id}:${f.id}">
        <div class="bud-receipt-img">${img ? (/^data:image\//.test(img) ? `<img src="${img}" alt="">` : '<span>📄 PDF</span>') : '<span class="muted small">Loading…</span>'}</div>
        <div class="bud-receipt-meta"><b>${dlvInr(p.amount)}</b> · ${dlvEsc(p.purpose)}<br><span class="small muted">${dlvEsc(dlvWhen(p.day))} · ${dlvEsc(p.delivery.ref)} · ${dlvEsc(p.paid_by_name || personName(p.paid_by))}</span></div>
      </button>`;
    }).join('')}</div>
    ${shown.length > page.length ? `<div style="margin-top:10px;"><button class="btn btn-sm" data-bud-act="more-receipts">Show more (${shown.length - page.length} left)</button></div>` : ''}`
    : '<div class="empty">No bills in this period.</div>'}`;
}
function budSummaryHTML({ payments, rows }) {
  const table = (title, groups, extra) => `<div class="bud-sum-block"><div class="dlv-section">${title}</div>
    ${groups.length ? `<div class="dlv-perf-wrap"><table class="dlv-perf bud-table"><thead><tr><th>${extra.head}</th><th>Payments</th><th>Deliveries</th><th>Without bill</th><th style="text-align:right;">Total paid</th></tr></thead><tbody>
      ${groups.map(g => `<tr><td><b>${dlvEsc(g.label)}</b></td><td>${g.count}</td><td>${g.deliveries.size}</td><td>${g.noBill ? `<span class="dlv-late">${g.noBill}</span>` : '0'}</td><td style="text-align:right;"><b>${dlvInr(g.total)}</b></td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty small">Nothing yet.</div>'}</div>`;
  // Per project: budget vs spent
  const proj = new Map();
  for (const r of rows) { const k = r.d.project || '—'; const x = proj.get(k) || { k, budget: 0, spent: 0, n: 0, over: 0 }; x.budget += r.budget || 0; x.spent += r.spent; x.n++; if (r.status === 'over') x.over++; proj.set(k, x); }
  const projRows = [...proj.values()].sort((a, b) => b.spent - a.spent);
  return `
    ${table('Paid per person', budGroup(payments, p => p.paid_by, p => p.paid_by_name || personName(p.paid_by)), { head: 'Person' })}
    ${table('By what it was for', budGroup(payments, p => p.purpose, p => p.purpose), { head: 'For' })}
    ${table('By payment mode', budGroup(payments, p => p.mode || '—', p => p.mode || '—'), { head: 'Mode' })}
    <div class="bud-sum-block"><div class="dlv-section">Per project / site — budget vs spent</div>
    ${projRows.length ? `<div class="dlv-perf-wrap"><table class="dlv-perf bud-table"><thead><tr><th>Project</th><th>Deliveries</th><th style="text-align:right;">Budget</th><th style="text-align:right;">Spent</th><th style="text-align:right;">Balance</th><th>Over budget</th></tr></thead><tbody>
      ${projRows.map(x => { const b = budRound(x.budget - x.spent); return `<tr><td><b>${dlvEsc(x.k)}</b></td><td>${x.n}</td><td style="text-align:right;">${dlvInr(budRound(x.budget))}</td><td style="text-align:right;">${dlvInr(budRound(x.spent))}</td><td style="text-align:right;" class="${b < 0 ? 'dlv-over' : ''}">${b < 0 ? '−' : ''}${dlvInr(Math.abs(b))}</td><td>${x.over ? `<span class="dlv-late">${x.over}</span>` : '0'}</td></tr>`; }).join('')}
    </tbody></table></div>` : '<div class="empty small">Nothing yet.</div>'}</div>`;
}

function budCsv(payments) {
  const head = ['Date paid', 'Delivery', 'Material', 'Project', 'For', 'Paid to', 'Mode', 'Paid by', 'Amount (Rs)', 'Bill attached', 'No-bill reason', 'Note', 'Delivery budget (Rs)', 'Delivery total paid (Rs)'];
  const rows = payments.map(p => [p.day, p.delivery.ref, p.delivery.title, p.delivery.project || '', p.purpose, p.paid_to || '', p.mode || '', p.paid_by_name || personName(p.paid_by),
    p.amount, p.hasBill ? 'Yes' : 'No', p.no_bill_reason || '', p.note || '', p.delivery.budget_amount == null ? '' : p.delivery.budget_amount, p.delivery.paid || 0]);
  return [head, ...rows].map(r => r.map(c => { const v = String(c == null ? '' : c); return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; }).join(',')).join('\n');
}

function bindBudgetView() {
  const s = budState();
  const sel = (id, key, after) => { const el = document.getElementById(id); if (el) el.onchange = () => { s[key] = el.value; if (after) after(); render(); }; };
  sel('bud-period', 'period'); sel('bud-from', 'from'); sel('bud-to', 'to'); sel('bud-project', 'project'); sel('bud-person', 'person');
  sel('bud-purpose', 'purpose'); sel('bud-mode', 'mode'); sel('bud-bill', 'bill'); sel('bud-match', 'match');
  const q = document.getElementById('bud-q');
  if (q) q.oninput = () => { s.q = q.value; clearTimeout(window.__budQT); window.__budQT = setTimeout(() => { render(); const n = document.getElementById('bud-q'); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } }, 300); };
  document.querySelectorAll('[data-bud-view]').forEach(b => b.onclick = () => { s.view = b.dataset.budView; render(); });
  document.querySelectorAll('[data-bud-open]').forEach(b => b.onclick = () => { const id = Number(b.dataset.budOpen); ui.dlvCardTab = { ...(ui.dlvCardTab || {}), [id]: 'money' }; openDeliveryOnPage(id); });
  document.querySelectorAll('[data-bud-act="more-receipts"]').forEach(b => b.onclick = () => { s.receiptsShown = (s.receiptsShown || 24) + 24; render(); });
  document.querySelectorAll('[data-bud-act="csv"]').forEach(b => b.onclick = () => {
    const { payments } = budCompute();
    if (!payments.length) { setBanner('No expenses to download for these filters.'); render(); return; }
    downloadDataUrl('data:text/csv;charset=utf-8;base64,' + btoa(unescape(encodeURIComponent('﻿' + budCsv(payments)))), `delivery-expenses-${budToday()}.csv`);
  });
  // Bill / photo viewer (same as on the delivery cards)
  document.querySelectorAll('[data-dlv-file]').forEach(b => b.onclick = async (e) => {
    e.preventDefault(); e.stopPropagation();
    const [did, fid] = b.dataset.dlvFile.split(':');
    try {
      const cached = budBillCache.get(Number(fid));
      const r = cached ? { data: cached, name: `bill-${fid}` } : await api(`/api/deliveries/${did}/files/${fid}`);
      if (/^data:image\//i.test(r.data)) { ui.deliveryPhoto = { data: r.data, name: r.name }; render(); } else downloadDataUrl(r.data, r.name);
    } catch (err) { setBanner(err.message); render(); }
  });
  document.querySelectorAll('[data-dlv-act="close-photo"]').forEach(el => el.onclick = (e) => { e.preventDefault(); ui.deliveryPhoto = null; render(); });
  document.querySelectorAll('[data-dlv-act="download-photo"]').forEach(el => el.onclick = (e) => { e.preventDefault(); e.stopPropagation(); const p = ui.deliveryPhoto; if (p) downloadDataUrl(p.data, p.name); });
  // Receipt previews: fetch the ones on screen, a few at a time.
  const want = [...document.querySelectorAll('[data-bud-bill]')].map(b => b.dataset.budBill.split(':').map(Number)).filter(([, f]) => !budBillCache.has(f) && !budBillLoading.has(f)).slice(0, 6);
  if (want.length) {
    want.forEach(([, f]) => budBillLoading.add(f));
    Promise.all(want.map(([d, f]) => api(`/api/deliveries/${d}/files/${f}`).then(r => budBillCache.set(f, r.data)).catch(() => budBillCache.set(f, 'data:,')).finally(() => budBillLoading.delete(f))))
      .then(() => { if (ui.adminTab === 'budget') render(); });
  }
}
