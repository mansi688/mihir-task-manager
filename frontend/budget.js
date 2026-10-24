/* Budget tab — money a Director / Admin allots to a person (monthly, with top-ups in between). That person pays
   porters, transport and unloading labour on their behalf, records every payment with its bill (for a delivery or
   not), and the Director verifies each one. Balance = allotted − returned − paid (payments not accepted do not
   count). Statements run month by month; what is left carries forward.
   Data: GET /api/budget (budgetData). Loaded after deliveries.js and before app.js; driven by ui.* state. */

let budgetData = { canAllot: false, canVerify: false, seesAll: false, holders: [], allotments: [], payments: [] };

const BUD_STATUS = {
  pending: { label: 'To verify', cls: 'warn', icon: '⏳' },
  query: { label: 'Question asked', cls: 'warn', icon: '❓' },
  verified: { label: 'Verified', cls: 'good', icon: '✓' },
  rejected: { label: 'Not accepted', cls: 'bad', icon: '✗' },
};
const BUD_ALLOT_TYPES = [
  { key: 'monthly', label: 'Monthly amount', kind: 'allot' },
  { key: 'topup', label: 'Top-up', kind: 'allot' },
  { key: 'return', label: 'Money returned by them', kind: 'return' },
];
const budBillCache = new Map(); // file id -> data URL (receipt previews, fetched on demand)
const budBillLoading = new Set();

function budState() {
  if (!ui.budget) ui.budget = { view: '', month: dlvIstDay(new Date().toISOString()).slice(0, 7), person: '', status: '', purpose: '', bill: '', q: '', receiptsShown: 24 };
  return ui.budget;
}
function budRound(n) { return Math.round((n || 0) * 100) / 100; }
function budDayOf(iso) { return /^\d{4}-\d{2}-\d{2}/.test(String(iso || '')) && !String(iso).includes('Z') && !/[+-]\d\d:\d\d$/.test(String(iso)) ? String(iso).slice(0, 10) : dlvIstDay(iso); }
function budMonthLabel(m) {
  if (!m) return 'All time';
  const [y, mo] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, 15)).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}
function budMe() { return session && session.username; }
function budPayments() { return (budgetData.payments || []).map(p => ({ ...p, day: budDayOf(p.paid_at || p.created_at), hasBill: (p.bills || []).length > 0, status: p.verify_status || 'pending' })); }
function budAllotments() { return (budgetData.allotments || []).map(a => ({ ...a, day: budDayOf(a.created_at) })); }
function budIsHolder(u) { return budAllotments().some(a => a.username === u) || budPayments().some(p => p.paid_by === u); }

// One person's money for a month: opening (carried forward), allotted, returned, paid, closing.
function budStatement(username, month) {
  const inMonth = d => !month || d.slice(0, 7) === month;
  const before = d => month && d.slice(0, 7) < month;
  const al = budAllotments().filter(a => a.username === username);
  const pays = budPayments().filter(p => p.paid_by === username);
  const sumA = (list, kind) => list.filter(a => (a.kind === 'return') === (kind === 'return')).reduce((t, a) => t + a.amount, 0);
  const counted = p => p.status !== 'rejected';
  const opening = budRound(sumA(al.filter(a => before(a.day)), 'allot') - sumA(al.filter(a => before(a.day)), 'return') - pays.filter(p => before(p.day) && counted(p)).reduce((t, p) => t + p.amount, 0));
  const mA = al.filter(a => inMonth(a.day)), mP = pays.filter(p => inMonth(p.day));
  const allotted = budRound(sumA(mA, 'allot')), returned = budRound(sumA(mA, 'return'));
  const by = st => budRound(mP.filter(p => p.status === st).reduce((t, p) => t + p.amount, 0));
  const paid = budRound(mP.filter(counted).reduce((t, p) => t + p.amount, 0));
  const closing = budRound((month ? opening : 0) + allotted - returned - paid);
  // Running ledger
  const entries = [
    ...mA.map(a => ({ type: a.kind === 'return' ? 'return' : 'allot', day: a.day, at: a.created_at, a })),
    ...mP.map(p => ({ type: 'pay', day: p.day, at: p.created_at, p })),
  ].sort((x, y) => x.day.localeCompare(y.day) || String(x.at).localeCompare(String(y.at)));
  let run = month ? opening : 0;
  for (const e of entries) {
    if (e.type === 'allot') run += e.a.amount; else if (e.type === 'return') run -= e.a.amount; else if (e.p.status !== 'rejected') run -= e.p.amount;
    e.balance = budRound(run);
  }
  return { username, opening, allotted, returned, paid, closing, verified: by('verified'), pending: budRound(by('pending') + by('query')), rejected: by('rejected'),
    noBill: mP.filter(p => !p.hasBill && counted(p)).length, count: mP.length, entries };
}
function budPeople() {
  const set = new Set([...budAllotments().map(a => a.username), ...budPayments().map(p => p.paid_by)]);
  return [...set].sort((a, b) => personName(a).localeCompare(personName(b)));
}
function budMonths() {
  const set = new Set([dlvIstDay(new Date().toISOString()).slice(0, 7), ...budAllotments().map(a => a.day.slice(0, 7)), ...budPayments().map(p => p.day.slice(0, 7))]);
  return [...set].sort().reverse();
}

// Menu: Directors / Admin, Accounts and the purchase side, and anyone who holds money or has recorded a payment.
function budgetTabVisible() {
  return !!(budgetData.canAllot || budgetData.seesAll || budIsHolder(budMe()));
}
// Badge: Directors — payments waiting to be verified; others — questions to answer.
function budgetAttentionCount() {
  const pays = budPayments();
  if (budgetData.canVerify) return pays.filter(p => p.status === 'pending' && p.paid_by !== budMe()).length;
  return pays.filter(p => p.paid_by === budMe() && p.status === 'query').length;
}

function budChip(st) { const s = BUD_STATUS[st] || BUD_STATUS.pending; return `<span class="bud-chip ${s.cls}">${s.icon} ${s.label}</span>`; }
function budBillBtns(p) {
  return p.hasBill ? p.bills.map((f, i) => `<button type="button" class="dlv-file" data-bud-file="${f.id}">🧾 ${p.bills.length > 1 ? `Bill ${i + 1}` : 'Bill'}</button>`).join(' ')
    : `<span class="dlv-nobill">No bill${p.no_bill_reason ? ` — ${dlvEsc(p.no_bill_reason)}` : ''}</span>`;
}
function budForWhat(p) {
  return p.delivery_id || p.d_ref || p.delivery_ref
    ? `<button type="button" class="bud-dlv" ${p.delivery_id ? `data-bud-open="${p.delivery_id}"` : 'disabled'}><b>${dlvEsc(p.d_ref || p.delivery_ref || '')}</b> ${dlvEsc(p.d_title || p.delivery_title || '')}</button>`
    : '<span class="muted small">Not for a delivery</span>';
}

function renderBudgetView() {
  const s = budState();
  const B = budgetData;
  const me = budMe();
  const people = budPeople();
  const months = budMonths();
  const month = s.month === '' || months.includes(s.month) ? s.month : months[0];
  const mine = budStatement(me, month);
  const amHolder = budIsHolder(me);
  const toVerify = budPayments().filter(p => p.status === 'pending' && p.paid_by !== me);
  const myQueries = budPayments().filter(p => p.paid_by === me && p.status === 'query');
  const views = [
    ...(B.canVerify ? [{ key: 'verify', label: `✅ To verify`, n: toVerify.length }] : []),
    ...(B.seesAll ? [{ key: 'people', label: '👥 People & balances' }] : []),
    { key: 'statement', label: '📒 Statement' },
    { key: 'payments', label: '🧾 All payments' },
    { key: 'receipts', label: '📷 Receipts' },
    { key: 'summary', label: '📊 Summary' },
  ];
  const view = views.some(v => v.key === s.view) ? s.view : views[0].key;
  const opt = (v, label, cur) => `<option value="${dlvEsc(v)}" ${cur === v ? 'selected' : ''}>${dlvEsc(label)}</option>`;
  const canPay = amHolder || B.canAllot || dlvCanManage() || (deliveriesData.items || []).some(d => dlvMine(d));
  return `
  <div class="card">
    <div class="flex-between" style="flex-wrap:wrap;gap:10px;">
      <div><div class="card-title" style="margin:0;">Budget</div>
        <div class="small muted">${B.canAllot ? 'Allot money to people on site (monthly, top up any time). They pay porters and transport on your behalf and record every payment with its bill — you verify each one. Unused money carries forward to the next month.'
          : amHolder ? 'Money allotted to you for porter / transport / site payments. Record every payment with a photo of the bill — the Director verifies each one.'
          : 'Payments for porters, transport and unloading, with their bills.'}</div></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        ${B.canAllot ? `<button class="btn btn-primary btn-sm" data-bud-act="allot">+ Allot money</button>` : ''}
        ${canPay ? `<button class="btn btn-sm ${B.canAllot ? '' : 'btn-primary'}" data-bud-act="pay">+ Record a payment</button>` : ''}
        ${amHolder && !B.canAllot ? `<button class="btn btn-sm" data-bud-act="topup">🙋 Ask for top-up</button>` : ''}
      </div>
    </div>
    ${budFormsHTML()}
    <div class="bud-filters">
      <div><label for="bud-month">Month</label><select id="bud-month">${months.map(m => opt(m, budMonthLabel(m), month)).join('')}${opt('', 'All time', month)}</select></div>
      ${B.seesAll ? `<div><label for="bud-person">Person</label><select id="bud-person">${opt('', 'Everyone', s.person)}${people.map(u => opt(u, personName(u), s.person)).join('')}</select></div>` : ''}
      <div class="bud-search"><label for="bud-q">Search</label><input type="text" id="bud-q" value="${dlvEsc(s.q)}" placeholder="DLV number, paid to, purpose…"></div>
    </div>
  </div>

  ${myQueries.length ? `<div class="card bud-attn"><div class="card-title" style="margin:0 0 6px;">❓ ${myQueries.length} question${myQueries.length > 1 ? 's' : ''} about your payments</div>
    ${myQueries.map(p => budQueryHTML(p)).join('')}</div>` : ''}

  ${amHolder && !B.seesAll ? budTilesHTML(mine, month, 'Your money') : ''}
  ${B.seesAll && s.person ? budTilesHTML(budStatement(s.person, month), month, personName(s.person)) : ''}
  ${B.seesAll && !s.person ? budTeamTilesHTML(people, month) : ''}

  <div class="card">
    <div class="task-tabs" role="tablist">${views.map(v => `<button class="task-tab${view === v.key ? ' active' : ''}" data-bud-view="${v.key}">${v.label}${v.n ? ` <span class="task-tab-count">${v.n}</span>` : ''}</button>`).join('')}</div>
    ${view === 'verify' ? budVerifyHTML(toVerify)
      : view === 'people' ? budPeopleHTML(people, month)
      : view === 'statement' ? budStatementHTML(B.seesAll ? s.person : me, month)
      : view === 'payments' ? budPaymentsHTML(budFiltered(month))
      : view === 'receipts' ? budReceiptsHTML(budFiltered(month))
      : budSummaryHTML(budFiltered(month))}
  </div>
  ${ui.deliveryPhoto ? `<div class="dlv-viewer" data-dlv-act="close-photo"><img src="${ui.deliveryPhoto.data}" alt="${dlvEsc(ui.deliveryPhoto.name)}"><div class="dlv-viewer-bar"><span>${dlvEsc(ui.deliveryPhoto.name)}</span><button class="btn btn-sm" data-dlv-act="download-photo">Download</button><button class="btn btn-sm" data-dlv-act="close-photo">Close</button></div></div>` : ''}`;
}

function budTilesHTML(st, month, who) {
  return `<div class="card bud-me">
    <div class="small"><b>${dlvEsc(who)}</b> · ${dlvEsc(budMonthLabel(month))}</div>
    <div class="dlv-money-tiles bud-tiles">
      ${month ? `<div class="dlv-tile"><span>Carried forward</span><b>${st.opening < 0 ? '−' : ''}${dlvInr(Math.abs(st.opening))}</b></div>` : ''}
      <div class="dlv-tile"><span>Allotted${month ? ' this month' : ''}</span><b>${dlvInr(st.allotted)}</b>${st.returned ? `<small class="muted">${dlvInr(st.returned)} returned</small>` : ''}</div>
      <div class="dlv-tile"><span>Paid</span><b>${dlvInr(st.paid)}</b><small class="muted">${st.count} payment${st.count === 1 ? '' : 's'}</small></div>
      <div class="dlv-tile ${st.closing < 0 ? 'bad' : 'good'}"><span>${st.closing < 0 ? 'Paid from own pocket' : 'Balance in hand'}</span><b>${dlvInr(Math.abs(st.closing))}</b></div>
      <div class="dlv-tile good"><span>Verified</span><b>${dlvInr(st.verified)}</b></div>
      <div class="dlv-tile ${st.pending ? 'warn' : ''}"><span>Waiting for verification</span><b>${dlvInr(st.pending)}</b></div>
      ${st.rejected ? `<div class="dlv-tile bad"><span>Not accepted</span><b>${dlvInr(st.rejected)}</b><small class="muted">not counted</small></div>` : ''}
    </div>
    ${st.noBill ? `<div class="small" style="margin-top:6px;">🧾 ${st.noBill} payment${st.noBill > 1 ? 's' : ''} without a bill this ${month ? 'month' : 'period'}.</div>` : ''}
  </div>`;
}
function budTeamTilesHTML(people, month) {
  const st = people.map(u => budStatement(u, month));
  const t = k => budRound(st.reduce((a, x) => a + x[k], 0));
  const inHand = budRound(st.reduce((a, x) => a + Math.max(0, x.closing), 0));
  const ownPocket = budRound(st.reduce((a, x) => a + Math.max(0, -x.closing), 0));
  return `<div class="card bud-me">
    <div class="small"><b>Everyone</b> · ${dlvEsc(budMonthLabel(month))} · ${people.length} ${people.length === 1 ? 'person' : 'people'}</div>
    <div class="dlv-money-tiles bud-tiles">
      <div class="dlv-tile"><span>Allotted${month ? ' this month' : ''}</span><b>${dlvInr(t('allotted'))}</b></div>
      <div class="dlv-tile"><span>Paid</span><b>${dlvInr(t('paid'))}</b></div>
      <div class="dlv-tile good"><span>Balance with people</span><b>${dlvInr(inHand)}</b></div>
      ${ownPocket ? `<div class="dlv-tile bad"><span>Paid from own pocket</span><b>${dlvInr(ownPocket)}</b><small class="muted">to give back</small></div>` : ''}
      <div class="dlv-tile good"><span>Verified</span><b>${dlvInr(t('verified'))}</b></div>
      <div class="dlv-tile ${t('pending') ? 'warn' : ''}"><span>Waiting for verification</span><b>${dlvInr(t('pending'))}</b></div>
      ${t('rejected') ? `<div class="dlv-tile bad"><span>Not accepted</span><b>${dlvInr(t('rejected'))}</b></div>` : ''}
    </div>
  </div>`;
}

// ---- forms: allot / payment / top-up / answer
function budFormsHTML() {
  const f = ui.budForm; if (!f) return '';
  const err = f.err ? `<div class="err">${dlvEsc(f.err)}</div>` : '';
  const thumbs = (list, attr) => `<div class="dlv-thumbs">${(list || []).map((x, i) => `<div class="dlv-thumb">${/^data:image\//.test(x.data) ? `<img src="${x.data}" alt="">` : `<span class="dlv-thumb-file">📎 ${dlvEsc(x.name)}</span>`}<button type="button" ${attr}="${i}" aria-label="Remove">✕</button></div>`).join('')}</div>`;
  if (f.type === 'allot') {
    const people = (userDirectory || []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const holders = new Set(budPeople());
    const bal = f.username ? budStatement(f.username, '').closing : null;
    return `<div class="dlv-proof bud-form">
      <div class="dlv-proof-title">💸 Allot money</div>
      <div class="row">
        <div class="col"><label for="bf-user">To *</label><select id="bf-user"><option value="">— pick the person —</option>
          ${holders.size ? `<optgroup label="Already holding money">${people.filter(u => holders.has(u.username)).map(u => `<option value="${dlvEsc(u.username)}" ${f.username === u.username ? 'selected' : ''}>${dlvEsc(u.name)}${u.designation ? ` — ${dlvEsc(u.designation)}` : ''}</option>`).join('')}</optgroup>` : ''}
          <optgroup label="Everyone">${people.filter(u => !holders.has(u.username)).map(u => `<option value="${dlvEsc(u.username)}" ${f.username === u.username ? 'selected' : ''}>${dlvEsc(u.name)}${u.designation ? ` — ${dlvEsc(u.designation)}` : ''}</option>`).join('')}</optgroup></select>
          ${bal != null ? `<div class="small muted" style="margin-top:4px;">Balance with them now: <b>${bal < 0 ? '−' : ''}${dlvInr(Math.abs(bal))}</b>${bal < 0 ? ' (they paid from their own pocket)' : ''}</div>` : ''}</div>
        <div class="col"><label for="bf-kind">Type</label><select id="bf-kind">${BUD_ALLOT_TYPES.map(t => `<option value="${t.key}" ${f.kind === t.key ? 'selected' : ''}>${t.label}</option>`).join('')}</select></div>
      </div>
      <div class="row">
        <div class="col"><label for="bf-amount">Amount (₹) *</label><input type="number" id="bf-amount" min="1" step="1" inputmode="decimal" value="${dlvEsc(f.amount || '')}" placeholder="e.g. 10000"></div>
        <div class="col"><label for="bf-mode">${f.kind === 'return' ? 'Returned by' : 'Given by'}</label><select id="bf-mode">${(budgetData.giveModes || ['Cash', 'UPI', 'Bank transfer', 'Other']).map(x => `<option ${f.mode === x ? 'selected' : ''}>${dlvEsc(x)}</option>`).join('')}</select></div>
        <div class="col"><label for="bf-ref">UPI / bank reference <span class="muted small">(optional)</span></label><input type="text" id="bf-ref" value="${dlvEsc(f.reference || '')}"></div>
      </div>
      <label for="bf-note">Note <span class="muted small">(optional)</span></label><input type="text" id="bf-note" value="${dlvEsc(f.note || '')}" placeholder="${f.kind === 'monthly' ? `e.g. Porter budget — ${budMonthLabel(dlvIstDay(new Date().toISOString()).slice(0, 7))}` : f.kind === 'topup' ? 'e.g. extra for Tower B shuttering' : 'e.g. unused cash returned'}">
      ${err}
      <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;"><button class="btn btn-primary btn-sm" data-bud-act="allot-save" ${f.saving ? 'disabled' : ''}>${f.saving ? 'Saving…' : f.kind === 'return' ? '✓ Record money returned' : '✓ Allot'}</button><button class="btn btn-sm" data-bud-act="form-cancel">Cancel</button></div>
    </div>`;
  }
  if (f.type === 'pay') {
    const dl = (deliveriesData.items || []).filter(d => d.status !== 'cancelled' && (dlvMine(d) || dlvCanManage())).slice(0, 100);
    const st = budStatement(budMe(), '');
    return `<div class="dlv-proof bud-form">
      <div class="dlv-proof-title">💰 Record a payment</div>
      ${budIsHolder(budMe()) ? `<div class="small muted" style="margin-bottom:6px;">Balance with you now: <b>${st.closing < 0 ? '−' : ''}${dlvInr(Math.abs(st.closing))}</b></div>` : ''}
      <label for="bf-dlv">For which delivery?</label>
      <select id="bf-dlv"><option value="">Not for a delivery (other porter / transport payment)</option>${dl.map(d => `<option value="${d.id}" ${String(f.delivery_id) === String(d.id) ? 'selected' : ''}>${dlvEsc(d.ref)} — ${dlvEsc(d.title)}${d.project ? ` (${dlvEsc(d.project)})` : ''}</option>`).join('')}</select>
      <div class="row">
        <div class="col"><label for="bf-amount">Amount paid (₹) *</label><input type="number" id="bf-amount" min="1" step="1" inputmode="decimal" value="${dlvEsc(f.amount || '')}" placeholder="e.g. 850"></div>
        <div class="col"><label for="bf-purpose">For *</label><select id="bf-purpose">${(budgetData.payPurposes || dlvPayPurposes()).map(x => `<option ${f.purpose === x ? 'selected' : ''}>${dlvEsc(x)}</option>`).join('')}</select></div>
      </div>
      <div class="row">
        <div class="col"><label for="bf-to">Paid to ${f.delivery_id ? '' : '*'}</label><input type="text" id="bf-to" value="${dlvEsc(f.paid_to || '')}" placeholder="e.g. Porter driver Suresh, MH12 AB 1234"></div>
        <div class="col"><label for="bf-mode">Mode</label><select id="bf-mode">${(budgetData.payModes || dlvPayModes()).map(x => `<option ${f.mode === x ? 'selected' : ''}>${dlvEsc(x)}</option>`).join('')}</select></div>
        <div class="col"><label for="bf-date">Date</label><input type="date" id="bf-date" value="${dlvEsc(f.date || '')}"></div>
      </div>
      <label class="btn dlv-camera" style="margin-top:8px;">📷 Photo of the bill / receipt<input type="file" id="bf-files" accept="image/*,application/pdf,.pdf" multiple hidden></label>
      ${thumbs(f.files, 'data-bf-remove')}
      ${f.busy ? '<div class="small muted">Preparing photo…</div>' : ''}
      ${(f.files || []).length ? '' : `<label for="bf-nobill">No bill? Say why <span class="muted small">(only if there is no bill)</span></label><input type="text" id="bf-nobill" value="${dlvEsc(f.no_bill_reason || '')}" placeholder="e.g. labourers paid cash, no receipt">`}
      <label for="bf-note">Note <span class="muted small">(optional)</span></label><input type="text" id="bf-note" value="${dlvEsc(f.note || '')}">
      ${budIsHolder(budMe()) && Number(f.amount) > 0 && st.closing - Number(f.amount) < 0 ? `<div class="notice dlv-warn" style="margin-top:8px;">⚠ This is more than the money with you — ${dlvInr(Number(f.amount) - Math.max(0, st.closing))} will show as paid from your own pocket. You can ask for a top-up.</div>` : ''}
      ${err}
      <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;"><button class="btn btn-primary btn-sm" data-bud-act="pay-save" ${f.saving || f.busy ? 'disabled' : ''}>${f.saving ? 'Saving…' : '✓ Save payment'}</button><button class="btn btn-sm" data-bud-act="form-cancel">Cancel</button></div>
    </div>`;
  }
  if (f.type === 'topup') {
    return `<div class="dlv-proof bud-form">
      <div class="dlv-proof-title">🙋 Ask for a top-up</div>
      <div class="row"><div class="col"><label for="bf-amount">How much do you need (₹)? *</label><input type="number" id="bf-amount" min="1" step="1" inputmode="decimal" value="${dlvEsc(f.amount || '')}"></div></div>
      <label for="bf-note">What for <span class="muted small">(optional)</span></label><input type="text" id="bf-note" value="${dlvEsc(f.note || '')}" placeholder="e.g. 3 deliveries this week, porter + unloading">
      ${err}
      <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;"><button class="btn btn-primary btn-sm" data-bud-act="topup-save" ${f.saving ? 'disabled' : ''}>${f.saving ? 'Sending…' : 'Send request'}</button><button class="btn btn-sm" data-bud-act="form-cancel">Cancel</button></div>
    </div>`;
  }
  return '';
}
function budQueryHTML(p) {
  const f = ui.budForm && ui.budForm.type === 'reply' && ui.budForm.id === p.id ? ui.budForm : null;
  return `<div class="bud-q">
    <div><b>${dlvInr(p.amount)}</b> · ${dlvEsc(p.purpose)} · ${dlvEsc(dlvWhen(p.day))}${p.d_ref ? ` · ${dlvEsc(p.d_ref)}` : ''}</div>
    <div class="small">❓ <b>${dlvEsc(personName(p.verified_by))}</b>: “${dlvEsc(p.verify_note || '')}”</div>
    ${f ? `<div style="margin-top:6px;">
      <input type="text" id="bf-reply" value="${dlvEsc(f.note || '')}" placeholder="Your answer">
      <label class="btn btn-sm dlv-camera" style="margin-top:6px;">📷 Add bill<input type="file" id="bf-files" accept="image/*,application/pdf,.pdf" multiple hidden></label>
      <div class="dlv-thumbs">${(f.files || []).map((x, i) => `<div class="dlv-thumb">${/^data:image\//.test(x.data) ? `<img src="${x.data}" alt="">` : `<span class="dlv-thumb-file">📎 ${dlvEsc(x.name)}</span>`}<button type="button" data-bf-remove="${i}" aria-label="Remove">✕</button></div>`).join('')}</div>
      ${f.err ? `<div class="err">${dlvEsc(f.err)}</div>` : ''}
      <div style="margin-top:6px;display:flex;gap:8px;"><button class="btn btn-primary btn-sm" data-bud-reply-send="${p.id}" ${f.saving || f.busy ? 'disabled' : ''}>${f.saving ? 'Sending…' : 'Send answer'}</button><button class="btn btn-sm" data-bud-act="form-cancel">Cancel</button></div>
    </div>` : `<button class="btn btn-sm" style="margin-top:6px;" data-bud-reply="${p.id}">Answer</button>`}
  </div>`;
}

// ---- views
function budFiltered(month) {
  const s = budState(); const q = (s.q || '').trim().toLowerCase();
  return budPayments().filter(p => (!month || p.day.slice(0, 7) === month)
    && (!s.person || !budgetData.seesAll || p.paid_by === s.person)
    && (!s.status || p.status === s.status)
    && (!s.purpose || p.purpose === s.purpose)
    && (!s.bill || (s.bill === 'with' ? p.hasBill : !p.hasBill))
    && (!q || [p.d_ref, p.delivery_ref, p.d_title, p.delivery_title, p.d_project, p.paid_to, p.purpose, p.note, p.paid_by_name].filter(Boolean).join(' ').toLowerCase().includes(q)))
    .sort((a, b) => b.day.localeCompare(a.day) || b.id - a.id);
}
function budVerifyHTML(list) {
  if (!list.length) return '<div class="empty">Nothing waiting — every payment has been checked. 👍</div>';
  const withBill = list.filter(p => p.hasBill);
  const act = ui.budVerify || {};
  return `
    <div class="flex-between" style="flex-wrap:wrap;gap:8px;margin:10px 0;">
      <div class="small muted">Check the bill against the amount, then verify. “Not accepted” payments are not counted — the money stays with the person.</div>
      ${withBill.length > 1 ? `<button class="btn btn-sm" data-bud-act="verify-all">✓ Verify all ${withBill.length} with a bill</button>` : ''}
    </div>
    <div class="bud-vlist">${list.map(p => {
      const img = p.hasBill ? budBillCache.get(p.bills[0].id) : null;
      const open = act.id === p.id ? act : null;
      const st = budStatement(p.paid_by, '');
      return `<div class="bud-vitem" id="bud-v-${p.id}">
        <button type="button" class="bud-vimg" ${p.hasBill ? `data-bud-file="${p.bills[0].id}" data-bud-bill="${p.bills[0].id}"` : 'disabled'}>${p.hasBill ? (img ? (/^data:image\//.test(img) ? `<img src="${img}" alt="">` : '<span>📄 PDF</span>') : '<span class="muted small">Loading…</span>') : '<span class="dlv-nobill">No bill</span>'}</button>
        <div class="bud-vbody">
          <div class="bud-vhead"><b class="bud-amt">${dlvInr(p.amount)}</b> <span>${dlvEsc(p.purpose)}</span> ${budChip(p.status)}</div>
          <div class="small"><b>${dlvEsc(p.paid_by_name || personName(p.paid_by))}</b> paid${p.paid_to ? ` ${dlvEsc(p.paid_to)}` : ''}${p.mode ? ` · ${dlvEsc(p.mode)}` : ''} · ${dlvEsc(dlvWhen(p.day))}</div>
          <div class="small">${budForWhat(p)}${p.d_project ? ` · ${dlvEsc(p.d_project)}` : ''}</div>
          ${p.note ? `<div class="small muted">“${dlvEsc(p.note)}”</div>` : ''}
          ${!p.hasBill && p.no_bill_reason ? `<div class="small dlv-nobill">No bill: ${dlvEsc(p.no_bill_reason)}</div>` : ''}
          ${p.reply_note ? `<div class="small">↩ Answer: “${dlvEsc(p.reply_note)}”${p.verify_note ? ` <span class="muted">(you asked: ${dlvEsc(p.verify_note)})</span>` : ''}</div>` : ''}
          <div class="small muted">Balance with ${dlvEsc(personName(p.paid_by))}: ${st.closing < 0 ? '−' : ''}${dlvInr(Math.abs(st.closing))}</div>
          ${open ? `<div style="margin-top:6px;"><input type="text" id="bud-vnote" value="${dlvEsc(open.note || '')}" placeholder="${open.status === 'rejected' ? 'Why is it not accepted?' : 'Your question'}">
            <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;"><button class="btn btn-sm ${open.status === 'rejected' ? 'btn-danger' : 'btn-primary'}" data-bud-vsend="${p.id}">${open.status === 'rejected' ? '✗ Not accepted' : 'Send question'}</button><button class="btn btn-sm" data-bud-act="vcancel">Cancel</button></div></div>`
          : `<div class="bud-vbtns"><button class="btn btn-primary btn-sm" data-bud-verify="${p.id}:verified">✓ Verify</button><button class="btn btn-sm" data-bud-verify="${p.id}:query">❓ Ask</button><button class="btn btn-sm btn-danger" data-bud-verify="${p.id}:rejected">✗ Not accepted</button></div>`}
        </div>
      </div>`;
    }).join('')}</div>`;
}
function budPeopleHTML(people, month) {
  if (!people.length) return `<div class="empty">No money allotted yet.${budgetData.canAllot ? ' Tap “+ Allot money” to give a monthly amount to someone on site.' : ''}</div>`;
  const rows = people.map(u => budStatement(u, month));
  return `<div class="small muted" style="margin:10px 0;">${dlvEsc(budMonthLabel(month))}. Balance carries forward month to month.</div>
    <div class="dlv-perf-wrap"><table class="dlv-perf bud-table"><thead><tr><th>Person</th>${month ? '<th style="text-align:right;">Carried forward</th>' : ''}<th style="text-align:right;">Allotted</th><th style="text-align:right;">Paid</th><th style="text-align:right;">Verified</th><th style="text-align:right;">To verify</th><th style="text-align:right;">Not accepted</th><th style="text-align:right;">Balance</th><th></th></tr></thead>
    <tbody>${rows.map(r => `<tr>
      <td><b>${dlvEsc(personName(r.username))}</b>${r.noBill ? ` <span class="dlv-nobill" title="payments without a bill">🧾 ${r.noBill}</span>` : ''}</td>
      ${month ? `<td style="text-align:right;">${r.opening < 0 ? '−' : ''}${dlvInr(Math.abs(r.opening))}</td>` : ''}
      <td style="text-align:right;">${dlvInr(r.allotted)}${r.returned ? `<div class="small muted">−${dlvInr(r.returned)} returned</div>` : ''}</td>
      <td style="text-align:right;">${dlvInr(r.paid)}</td><td style="text-align:right;">${dlvInr(r.verified)}</td>
      <td style="text-align:right;">${r.pending ? `<span class="dlv-nobill">${dlvInr(r.pending)}</span>` : '—'}</td>
      <td style="text-align:right;">${r.rejected ? `<span class="dlv-over">${dlvInr(r.rejected)}</span>` : '—'}</td>
      <td style="text-align:right;" class="${r.closing < 0 ? 'dlv-over' : ''}"><b>${r.closing < 0 ? '−' : ''}${dlvInr(Math.abs(r.closing))}</b>${r.closing < 0 ? '<div class="small">own pocket</div>' : ''}</td>
      <td class="nowrap"><button class="btn btn-sm" data-bud-person="${dlvEsc(r.username)}">Statement</button>${budgetData.canAllot ? ` <button class="btn btn-sm" data-bud-allot-to="${dlvEsc(r.username)}">+ Top up</button>` : ''}</td></tr>`).join('')}
    </tbody></table></div>`;
}
function budStatementHTML(username, month) {
  if (!username) return `<div class="empty">Pick a person above to see their statement.</div>`;
  const st = budStatement(username, month);
  if (!st.entries.length && !st.opening) return `<div class="empty">Nothing for ${dlvEsc(personName(username))} in ${dlvEsc(budMonthLabel(month))}.</div>`;
  const canDelA = budgetData.canAllot;
  return `<div class="small muted" style="margin:10px 0;">${dlvEsc(personName(username))} · ${dlvEsc(budMonthLabel(month))}</div>
    <div class="dlv-perf-wrap"><table class="dlv-perf bud-table bud-stmt"><thead><tr><th>Date</th><th>Entry</th><th>Details</th><th>Bill</th><th style="text-align:right;">In</th><th style="text-align:right;">Out</th><th style="text-align:right;">Balance</th><th>Status</th><th></th></tr></thead>
    <tbody>
      ${month ? `<tr class="bud-open"><td colspan="6">Carried forward from earlier months</td><td style="text-align:right;"><b>${st.opening < 0 ? '−' : ''}${dlvInr(Math.abs(st.opening))}</b></td><td colspan="2"></td></tr>` : ''}
      ${st.entries.map(e => e.type === 'pay' ? `<tr class="${e.p.status === 'rejected' ? 'bud-row-rej' : ''}">
          <td class="nowrap">${dlvEsc(dlvWhen(e.day))}</td><td>Paid — ${dlvEsc(e.p.purpose)}</td>
          <td>${[e.p.paid_to, e.p.mode].filter(Boolean).map(dlvEsc).join(' · ')}<div class="small">${budForWhat(e.p)}</div>${e.p.verify_note ? `<div class="small muted">${e.p.status === 'rejected' ? 'Reason' : 'Note'}: ${dlvEsc(e.p.verify_note)}</div>` : ''}</td>
          <td>${budBillBtns(e.p)}</td><td></td><td style="text-align:right;">${e.p.status === 'rejected' ? `<s>${dlvInr(e.p.amount)}</s>` : dlvInr(e.p.amount)}</td>
          <td style="text-align:right;" class="${e.balance < 0 ? 'dlv-over' : ''}">${e.balance < 0 ? '−' : ''}${dlvInr(Math.abs(e.balance))}</td><td>${budChip(e.p.status)}</td>
          <td>${budCanDeletePay(e.p) ? `<button type="button" class="dlv-x" data-bud-pay-del="${e.p.id}" title="Remove this payment">✕</button>` : ''}</td></tr>`
        : `<tr class="bud-row-in"><td class="nowrap">${dlvEsc(dlvWhen(e.day))}</td><td><b>${e.type === 'return' ? 'Returned' : 'Allotted'}</b></td>
          <td>${dlvEsc(e.a.note || '')}${e.a.mode ? `<div class="small muted">${dlvEsc(e.a.mode)}${e.a.reference ? ` · ${dlvEsc(e.a.reference)}` : ''} · by ${dlvEsc(e.a.by_name || personName(e.a.by_username))}</div>` : ''}</td><td></td>
          <td style="text-align:right;">${e.type === 'allot' ? dlvInr(e.a.amount) : ''}</td><td style="text-align:right;">${e.type === 'return' ? dlvInr(e.a.amount) : ''}</td>
          <td style="text-align:right;" class="${e.balance < 0 ? 'dlv-over' : ''}">${e.balance < 0 ? '−' : ''}${dlvInr(Math.abs(e.balance))}</td><td></td>
          <td>${canDelA ? `<button type="button" class="dlv-x" data-bud-allot-del="${e.a.id}" title="Remove this entry">✕</button>` : ''}</td></tr>`).join('')}
      <tr class="dlv-total"><td colspan="4">${month ? 'End of month' : 'Total'}</td><td style="text-align:right;">${dlvInr(st.allotted)}</td><td style="text-align:right;">${dlvInr(budRound(st.paid + st.returned))}</td><td style="text-align:right;" class="${st.closing < 0 ? 'dlv-over' : ''}">${st.closing < 0 ? '−' : ''}${dlvInr(Math.abs(st.closing))}</td><td colspan="2"></td></tr>
    </tbody></table></div>`;
}
function budCanDeletePay(p) {
  if (budgetData.canAllot) return true;
  if (p.status === 'verified') return false;
  return (p.paid_by === budMe() && Date.now() - new Date(p.created_at).getTime() < 48 * 3600000) || dlvCanManage();
}
function budPaymentsHTML(list) {
  const s = budState();
  const total = budRound(list.filter(p => p.status !== 'rejected').reduce((a, p) => a + p.amount, 0));
  return `
    <div class="bud-subfilters">
      <label for="bud-status">Status</label><select id="bud-status"><option value="">All</option>${Object.entries(BUD_STATUS).map(([k, v]) => `<option value="${k}" ${s.status === k ? 'selected' : ''}>${v.label}</option>`).join('')}</select>
      <label for="bud-purpose">For</label><select id="bud-purpose"><option value="">Anything</option>${(budgetData.payPurposes || dlvPayPurposes()).map(x => `<option ${s.purpose === x ? 'selected' : ''}>${dlvEsc(x)}</option>`).join('')}</select>
      <label for="bud-bill">Bill</label><select id="bud-bill"><option value="">All</option><option value="with" ${s.bill === 'with' ? 'selected' : ''}>With bill</option><option value="without" ${s.bill === 'without' ? 'selected' : ''}>Without bill</option></select>
      <button class="btn btn-sm" data-bud-act="csv" style="margin-left:auto;">⬇ Download (CSV)</button>
    </div>
    ${list.length ? `<div class="dlv-perf-wrap"><table class="dlv-perf bud-table">
      <thead><tr><th>Date</th><th>Paid by</th><th>For</th><th>Paid to</th><th>Delivery</th><th>Mode</th><th style="text-align:right;">Amount</th><th>Bill</th><th>Status</th></tr></thead>
      <tbody>${list.map(p => `<tr class="${p.status === 'rejected' ? 'bud-row-rej' : ''}">
        <td class="nowrap">${dlvEsc(dlvWhen(p.day))}</td><td>${dlvEsc(p.paid_by_name || personName(p.paid_by))}</td>
        <td>${dlvEsc(p.purpose)}${p.note ? `<div class="small muted">${dlvEsc(p.note)}</div>` : ''}</td><td>${dlvEsc(p.paid_to || '—')}</td>
        <td>${budForWhat(p)}</td><td>${dlvEsc(p.mode || '—')}</td><td style="text-align:right;"><b>${dlvInr(p.amount)}</b></td><td>${budBillBtns(p)}</td><td>${budChip(p.status)}</td></tr>`).join('')}
        <tr class="dlv-total"><td colspan="6">Total counted (${list.filter(p => p.status !== 'rejected').length})</td><td style="text-align:right;">${dlvInr(total)}</td><td colspan="2"></td></tr>
      </tbody></table></div>` : '<div class="empty">No payments match.</div>'}`;
}
function budReceiptsHTML(list) {
  const s = budState();
  const shown = []; for (const p of list) for (const f of p.bills || []) shown.push({ p, f });
  const page = shown.slice(0, s.receiptsShown || 24);
  const missing = list.filter(p => !p.hasBill && p.status !== 'rejected');
  return `
    ${missing.length ? `<div class="bud-missing"><b>⚠ ${missing.length} payment${missing.length > 1 ? 's' : ''} without a bill</b>
      ${missing.map(p => `<div class="small">${dlvEsc(dlvWhen(p.day))} · <b>${dlvInr(p.amount)}</b> · ${dlvEsc(p.purpose)} · ${dlvEsc(p.paid_by_name || personName(p.paid_by))}${p.no_bill_reason ? ` — “${dlvEsc(p.no_bill_reason)}”` : ''}</div>`).join('')}</div>` : ''}
    ${page.length ? `<div class="bud-receipts">${page.map(({ p, f }) => {
      const img = budBillCache.get(f.id);
      return `<button type="button" class="bud-receipt" data-bud-file="${f.id}" data-bud-bill="${f.id}">
        <div class="bud-receipt-img">${img ? (/^data:image\//.test(img) ? `<img src="${img}" alt="">` : '<span>📄 PDF</span>') : '<span class="muted small">Loading…</span>'}</div>
        <div class="bud-receipt-meta"><b>${dlvInr(p.amount)}</b> · ${dlvEsc(p.purpose)} ${budChip(p.status)}<br><span class="small muted">${dlvEsc(dlvWhen(p.day))} · ${dlvEsc(p.paid_by_name || personName(p.paid_by))}${p.d_ref ? ` · ${dlvEsc(p.d_ref)}` : ''}</span></div>
      </button>`;
    }).join('')}</div>
    ${shown.length > page.length ? `<div style="margin-top:10px;"><button class="btn btn-sm" data-bud-act="more-receipts">Show more (${shown.length - page.length} left)</button></div>` : ''}`
    : '<div class="empty">No bills here.</div>'}`;
}
function budSummaryHTML(list) {
  const counted = list.filter(p => p.status !== 'rejected');
  const group = (keyFn, labelFn) => {
    const m = new Map();
    for (const p of counted) { const k = keyFn(p); const r = m.get(k) || { label: labelFn(p), total: 0, count: 0, noBill: 0, verified: 0 }; r.total += p.amount; r.count++; if (!p.hasBill) r.noBill++; if (p.status === 'verified') r.verified += p.amount; m.set(k, r); }
    return [...m.values()].sort((a, b) => b.total - a.total);
  };
  const table = (title, head, rows) => `<div class="bud-sum-block"><div class="dlv-section">${title}</div>
    ${rows.length ? `<div class="dlv-perf-wrap"><table class="dlv-perf bud-table"><thead><tr><th>${head}</th><th>Payments</th><th>Without bill</th><th style="text-align:right;">Verified</th><th style="text-align:right;">Total paid</th></tr></thead><tbody>
      ${rows.map(g => `<tr><td><b>${dlvEsc(g.label)}</b></td><td>${g.count}</td><td>${g.noBill ? `<span class="dlv-late">${g.noBill}</span>` : '0'}</td><td style="text-align:right;">${dlvInr(budRound(g.verified))}</td><td style="text-align:right;"><b>${dlvInr(budRound(g.total))}</b></td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty small">Nothing yet.</div>'}</div>`;
  return `
    ${budgetData.seesAll ? table('Paid per person', 'Person', group(p => p.paid_by, p => p.paid_by_name || personName(p.paid_by))) : ''}
    ${table('By what it was for', 'For', group(p => p.purpose, p => p.purpose))}
    ${table('By project / site', 'Project', group(p => p.d_project || '—', p => p.d_project || (p.delivery_id ? '—' : 'Not for a delivery')))}
    ${table('By payment mode', 'Mode', group(p => p.mode || '—', p => p.mode || '—'))}`;
}

function budCsv(list) {
  const head = ['Date paid', 'Paid by', 'For', 'Paid to', 'Mode', 'Amount (Rs)', 'Status', 'Delivery', 'Material', 'Project', 'Bill attached', 'No-bill reason', 'Note', 'Verified / checked by', 'Verifier note'];
  const rows = list.map(p => [p.day, p.paid_by_name || personName(p.paid_by), p.purpose, p.paid_to || '', p.mode || '', p.amount, (BUD_STATUS[p.status] || {}).label || p.status,
    p.d_ref || p.delivery_ref || '', p.d_title || p.delivery_title || '', p.d_project || '', p.hasBill ? 'Yes' : 'No', p.no_bill_reason || '', p.note || '', p.verified_by ? personName(p.verified_by) : '', p.verify_note || '']);
  return [head, ...rows].map(r => r.map(c => { const v = String(c == null ? '' : c); return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; }).join(',')).join('\n');
}

async function budReload() { await refreshData(); }

function bindBudgetView() {
  const s = budState();
  const sel = (id, key) => { const el = document.getElementById(id); if (el) el.onchange = () => { s[key] = el.value; render(); }; };
  sel('bud-month', 'month'); sel('bud-person', 'person'); sel('bud-status', 'status'); sel('bud-purpose', 'purpose'); sel('bud-bill', 'bill');
  const q = document.getElementById('bud-q');
  if (q) q.oninput = () => { s.q = q.value; clearTimeout(window.__budQT); window.__budQT = setTimeout(() => { render(); const n = document.getElementById('bud-q'); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } }, 300); };
  const on = (selector, fn) => document.querySelectorAll(selector).forEach(b => b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); fn(b); });
  on('[data-bud-view]', b => { s.view = b.dataset.budView; render(); });
  on('[data-bud-open]', b => { const id = Number(b.dataset.budOpen); ui.dlvCardTab = { ...(ui.dlvCardTab || {}), [id]: 'money' }; openDeliveryOnPage(id); });
  on('[data-bud-person]', b => { s.person = b.dataset.budPerson; s.view = 'statement'; render(); });
  on('[data-bud-act="more-receipts"]', () => { s.receiptsShown = (s.receiptsShown || 24) + 24; render(); });
  on('[data-bud-act="csv"]', () => {
    const list = budFiltered(s.month);
    if (!list.length) { setBanner('No payments to download.'); render(); return; }
    downloadDataUrl('data:text/csv;charset=utf-8;base64,' + btoa(unescape(encodeURIComponent('\uFEFF' + budCsv(list)))), `budget-payments-${s.month || 'all'}.csv`);
  });
  // bill viewer
  on('[data-bud-file]', async b => {
    const fid = Number(b.dataset.budFile);
    try {
      const cached = budBillCache.get(fid);
      const r = cached && cached !== 'data:,' ? { data: cached, name: `bill-${fid}` } : await api(`/api/budget/bills/${fid}`);
      if (/^data:image\//i.test(r.data)) { ui.deliveryPhoto = { data: r.data, name: r.name }; render(); } else downloadDataUrl(r.data, r.name);
    } catch (err) { setBanner(err.message); render(); }
  });
  document.querySelectorAll('[data-dlv-act="close-photo"]').forEach(el => el.onclick = (e) => { e.preventDefault(); ui.deliveryPhoto = null; render(); });
  document.querySelectorAll('[data-dlv-act="download-photo"]').forEach(el => el.onclick = (e) => { e.preventDefault(); e.stopPropagation(); const p = ui.deliveryPhoto; if (p) downloadDataUrl(p.data, p.name); });

  // ---- forms
  const today = dlvIstDay(new Date().toISOString());
  on('[data-bud-act="allot"]', () => { ui.budForm = { type: 'allot', kind: 'monthly', username: s.person || '', amount: '', mode: 'UPI', note: '', reference: '' }; render(); });
  on('[data-bud-allot-to]', b => { ui.budForm = { type: 'allot', kind: 'topup', username: b.dataset.budAllotTo, amount: '', mode: 'UPI', note: '', reference: '' }; render(); window.scrollTo(0, 0); });
  on('[data-bud-act="pay"]', () => { ui.budForm = { type: 'pay', delivery_id: '', amount: '', purpose: (budgetData.payPurposes || dlvPayPurposes())[0], mode: 'Cash', paid_to: '', date: today, files: [], note: '', no_bill_reason: '' }; render(); });
  on('[data-bud-act="topup"]', () => { ui.budForm = { type: 'topup', amount: '', note: '' }; render(); });
  on('[data-bud-reply]', b => { ui.budForm = { type: 'reply', id: Number(b.dataset.budReply), note: '', files: [] }; render(); });
  on('[data-bud-act="form-cancel"]', () => { ui.budForm = null; render(); });
  const f = ui.budForm;
  if (f) {
    const bindV = (id, k, rerender) => { const el = document.getElementById(id); if (!el) return; el.oninput = () => { f[k] = el.value; }; el.onchange = () => { f[k] = el.value; if (rerender) { render(); const n = document.getElementById(id); if (n && n.focus) n.focus(); } }; };
    bindV('bf-user', 'username', true); bindV('bf-kind', 'kind', true); bindV('bf-amount', 'amount', f.type !== 'topup'); bindV('bf-mode', 'mode'); bindV('bf-ref', 'reference');
    bindV('bf-note', 'note'); bindV('bf-dlv', 'delivery_id', true); bindV('bf-purpose', 'purpose'); bindV('bf-to', 'paid_to'); bindV('bf-date', 'date'); bindV('bf-nobill', 'no_bill_reason'); bindV('bf-reply', 'note');
    const fi = document.getElementById('bf-files');
    if (fi) fi.onchange = () => {
      const list = Array.from(fi.files || []).slice(0, 5 - (f.files || []).length); if (!list.length) return;
      f.busy = true; f.err = ''; render(); let left = list.length;
      list.forEach(file => readAnyFile(file, async (data) => {
        if (data && /^data:image\//i.test(data)) {
          const stamp = `${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })} · Bill · ${session.name}`;
          f.files.push({ name: file.name.replace(/\.[^.]+$/, '') + '.jpg', data: await dlvStampPhoto(data, stamp) });
        } else if (data) f.files.push({ name: file.name, data });
        if (--left === 0) { f.busy = false; render(); }
      }));
    };
    on('[data-bf-remove]', b => { f.files.splice(Number(b.dataset.bfRemove), 1); render(); });
    const send = async (url, body, okMsg) => {
      if (f.saving) return; f.saving = true; f.err = ''; render();
      try { const r = await api(url, { method: 'POST', body: JSON.stringify(body) }); ui.budForm = null; setBanner(okMsg(r), 'ok'); await budReload(); }
      catch (e) { f.saving = false; f.err = e.message; render(); }
    };
    on('[data-bud-act="allot-save"]', () => {
      if (!f.username) { f.err = 'Pick the person.'; render(); return; }
      if (!(Number(f.amount) > 0)) { f.err = 'Enter the amount.'; render(); return; }
      const t = BUD_ALLOT_TYPES.find(x => x.key === f.kind) || BUD_ALLOT_TYPES[0];
      const note = t.key === 'return' ? f.note : [t.key === 'monthly' ? `Monthly — ${budMonthLabel(today.slice(0, 7))}` : 'Top-up', f.note].filter(Boolean).join(': ');
      send('/api/budget/allot', { username: f.username, kind: t.kind, amount: Number(f.amount), mode: f.mode, reference: f.reference, note },
        r => `${t.kind === 'return' ? 'Return recorded' : `${dlvInr(Number(f.amount))} allotted to ${personName(f.username)}`}. Their balance: ${dlvInr(r.balance)}.`);
    });
    on('[data-bud-act="pay-save"]', () => {
      if (!(Number(f.amount) > 0)) { f.err = 'Enter the amount paid.'; render(); return; }
      if (!f.delivery_id && !String(f.paid_to || '').trim()) { f.err = 'Write who you paid (e.g. porter driver name / vehicle).'; render(); return; }
      if (!(f.files || []).length && String(f.no_bill_reason || '').trim().length < 5) { f.err = 'Add a photo of the bill / receipt — or, if there is no bill, write why.'; render(); return; }
      send('/api/budget/payments', { delivery_id: f.delivery_id ? Number(f.delivery_id) : null, amount: Number(f.amount), purpose: f.purpose, mode: f.mode, paid_to: f.paid_to, paid_at: f.date, note: f.note, no_bill_reason: f.no_bill_reason, attachments: f.files },
        r => `Payment saved — sent for verification.${r.wallet != null ? ` Balance with you: ${r.wallet < 0 ? '−' : ''}${dlvInr(Math.abs(r.wallet))}.` : ''}`);
    });
    on('[data-bud-act="topup-save"]', () => {
      if (!(Number(f.amount) > 0)) { f.err = 'Enter how much you need.'; render(); return; }
      send('/api/budget/request-topup', { amount: Number(f.amount), note: f.note }, r => `Top-up request sent to ${r.sentTo.map(personName).join(', ')}.`);
    });
    on('[data-bud-reply-send]', b => {
      if (String(f.note || '').trim().length < 3 && !(f.files || []).length) { f.err = 'Write your answer or add the bill.'; render(); return; }
      send(`/api/budget/payments/${b.dataset.budReplySend}/reply`, { note: f.note, attachments: f.files }, () => 'Answer sent — it goes back for verification.');
    });
  }

  // ---- verify
  on('[data-bud-verify]', async b => {
    const [id, status] = b.dataset.budVerify.split(':');
    if (status === 'verified') {
      b.disabled = true;
      try { await api(`/api/budget/payments/${id}/verify`, { method: 'POST', body: JSON.stringify({ status }) }); setBanner('Verified ✓', 'ok'); await budReload(); }
      catch (e) { b.disabled = false; setBanner(e.message); render(); }
      return;
    }
    ui.budVerify = { id: Number(id), status, note: '' }; render(); const n = document.getElementById('bud-vnote'); if (n) n.focus();
  });
  on('[data-bud-act="vcancel"]', () => { ui.budVerify = null; render(); });
  const vn = document.getElementById('bud-vnote'); if (vn && ui.budVerify) vn.oninput = () => { ui.budVerify.note = vn.value; };
  on('[data-bud-vsend]', async b => {
    const v = ui.budVerify; if (!v) return;
    if (String(v.note || '').trim().length < 3) { setBanner(v.status === 'rejected' ? 'Write why it is not accepted.' : 'Write your question.'); render(); return; }
    b.disabled = true;
    try { await api(`/api/budget/payments/${v.id}/verify`, { method: 'POST', body: JSON.stringify({ status: v.status, note: v.note }) }); ui.budVerify = null; setBanner(v.status === 'rejected' ? 'Marked as not accepted — they have been told.' : 'Question sent.', 'ok'); await budReload(); }
    catch (e) { b.disabled = false; setBanner(e.message); render(); }
  });
  on('[data-bud-act="verify-all"]', async b => {
    if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Tap again to verify all'; return; }
    b.disabled = true;
    const ids = budPayments().filter(p => p.status === 'pending' && p.hasBill && p.paid_by !== budMe()).map(p => p.id);
    let ok = 0; for (const id of ids) { try { await api(`/api/budget/payments/${id}/verify`, { method: 'POST', body: JSON.stringify({ status: 'verified' }) }); ok++; } catch (e) {} }
    setBanner(`${ok} payment${ok === 1 ? '' : 's'} verified.`, 'ok'); await budReload();
  });
  // ---- remove entries
  const armDel = (b, run) => {
    if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Remove?'; b.classList.add('armed'); setTimeout(() => { if (b.isConnected) { b.dataset.armed = ''; b.textContent = '✕'; b.classList.remove('armed'); } }, 4000); return; }
    b.disabled = true; run().then(() => budReload()).catch(err => { b.disabled = false; setBanner(err.message); render(); });
  };
  on('[data-bud-pay-del]', b => armDel(b, () => api(`/api/budget/payments/${b.dataset.budPayDel}/delete`, { method: 'POST' }).then(() => setBanner('Payment removed.', 'ok'))));
  on('[data-bud-allot-del]', b => armDel(b, () => api(`/api/budget/allotments/${b.dataset.budAllotDel}/delete`, { method: 'POST' }).then(() => setBanner('Entry removed.', 'ok'))));

  // Receipt previews: fetch the ones on screen, a few at a time.
  const want = [...new Set([...document.querySelectorAll('[data-bud-bill]')].map(b => Number(b.dataset.budBill)))].filter(f => !budBillCache.has(f) && !budBillLoading.has(f)).slice(0, 6);
  if (want.length) {
    want.forEach(f => budBillLoading.add(f));
    Promise.all(want.map(f => api(`/api/budget/bills/${f}`).then(r => budBillCache.set(f, r.data)).catch(() => budBillCache.set(f, 'data:,')).finally(() => budBillLoading.delete(f))))
      .then(() => { if (ui.adminTab === 'budget') render(); });
  }
}
