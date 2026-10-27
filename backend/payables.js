/* Accounts payable — vendor bills.

   Purchase (Admin, the Purchase Department, people with delivery access) sends a vendor bill to Accounts: vendor,
   bill no. and date, amount, the delivery it is for (and that the delivery is done), and the credit period in days.
   Due date = bill date (or the delivery date, or today) + credit days — or a due date typed in.

   Reminders go to the Accounts Department at the 9 AM / 3 PM / 6 PM reminder slots, once a day per bill:
     15, 5 and 2 days before the due date ("payment due in N days — overdue in N days"), on the due date, and every
     day after it ("overdue by N days"). One reminder card per person per bill: each new one replaces the last.
   Accounts responds on the bill — note, question to Purchase, payment scheduled for a date, part payment, paid
   (date, mode, UTR / cheque no., proof), on hold (reason), resume — and Purchase and Admin are told. Purchase
   answers questions and can follow up (Accounts is reminded; at most once every 2 hours per bill).
   Bills can also be imported from Excel / CSV (outstanding bills already on record). */
const ExcelJS = require('exceljs');
const { decodeDataUrl, excelCellValue, stripXlsxComments, parseCSV, parseDateValue } = require('./task-import');

const PAY_MODES = ['NEFT / RTGS', 'UPI', 'Cheque', 'Cash', 'Other'];
// Documents that can go with a bill (the vendor bill itself is 'bill').
const DOC_TYPES = [
  { key: 'bill', label: 'Vendor bill / invoice' }, { key: 'challan', label: 'Delivery challan' }, { key: 'po', label: 'Purchase order (PO)' },
  { key: 'grn', label: 'GRN / material inward' }, { key: 'eway', label: 'E-way bill' }, { key: 'lr', label: 'LR / transport receipt' },
  { key: 'weighbridge', label: 'Weighbridge slip' }, { key: 'quotation', label: 'Quotation / rate approval' }, { key: 'credit_note', label: 'Credit / debit note' },
  { key: 'other', label: 'Other document' },
];
const DOC_KEYS = DOC_TYPES.map(d => d.key);
const REMIND_BEFORE = [15, 5, 2];
const FOLLOWUP_GAP_MS = 2 * 3600000;

function mountPayables(app, deps) {
  const { db, auth, ALL_ROLES, auditFromReq, collectUploads, MAX_FILE_CHARS, str, PROJECT_OPTIONS, localDateStr } = deps;
  const q = (sql, params = []) => db.pool.query(sql, params);
  const rows = async (sql, params) => (await q(sql, params)).rows;
  const one = async (sql, params) => (await q(sql, params)).rows[0] || null;
  const now = () => new Date().toISOString();
  const r2 = (n) => Math.round(n * 100) / 100;
  const inr = (n) => '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const genRef = () => `BILL-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  const dayNum = (ymd) => { const [y, m, d] = String(ymd).slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d) / 864e5; };
  const addDays = (ymd, n) => { const t = new Date((dayNum(ymd) + n) * 864e5); return t.toISOString().slice(0, 10); };
  const fmtDay = (ymd) => { try { return new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }); } catch (e) { return ymd; } };
  const validDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null;

  async function me(user) {
    const u = await db.getUserFresh(user.username);
    const team = String((u && u.team) || '');
    const admin = user.role === 'admin';
    const canAdd = admin || /purchase/i.test(team) || !!(u && u.manage_deliveries);
    const canPay = admin || /account/i.test(team);
    return { username: user.username, name: (u && u.name) || user.name, admin, canAdd, canPay,
      canView: canAdd || canPay || user.role === 'director' || /senior management/i.test(team) };
  }
  async function accountsTeam() {
    const users = await db.listUsers();
    const acc = users.filter(u => /account/i.test(u.team || '')).map(u => u.username);
    return acc.length ? acc : users.filter(u => u.role === 'admin').map(u => u.username);
  }
  async function purchaseSide(bill) {
    const users = await db.listUsers();
    return [...new Set([bill.created_by, ...users.filter(u => u.role === 'admin').map(u => u.username)])];
  }
  const notify = async (users, except, type, message) => { for (const u of new Set(users)) if (u && u !== except) await db.createNotification({ username: u, type, message, task_id: null, ref_type: 'bill' }); };
  const label = (b) => `${b.vendor}${b.bill_no ? ` bill ${b.bill_no}` : ''} (${b.ref})`;

  function computeDue(f, today) {
    if (f.due_date) return f.due_date;
    const base = f.bill_date || f.delivery_done_on || today;
    return f.credit_days != null ? addDays(base, f.credit_days) : null;
  }
  function readBill(b, today, { forImport = false } = {}) {
    const f = {
      vendor: str(b.vendor).trim().slice(0, 200), bill_no: str(b.bill_no).trim().slice(0, 60) || null,
      bill_date: validDay(b.bill_date), amount: Number(b.amount), credit_days: b.credit_days === '' || b.credit_days == null ? null : Number(b.credit_days),
      due_date: validDay(b.due_date), project: str(b.project).trim() || null, delivery_done_on: validDay(b.delivery_done_on),
      description: str(b.description).trim().slice(0, 1000) || null, paid_amount: Number(b.paid_amount) || 0,
    };
    if (!f.vendor) return { error: 'Write the vendor / supplier name.' };
    if (!isFinite(f.amount) || f.amount <= 0 || f.amount > 1e10) return { error: 'Enter the bill amount in rupees.' };
    f.amount = r2(f.amount);
    if (f.credit_days != null && (!Number.isInteger(f.credit_days) || f.credit_days < 0 || f.credit_days > 365)) return { error: 'Credit period must be whole days (0 to 365).' };
    if (f.project && !PROJECT_OPTIONS.includes(f.project) && !forImport) return { error: `Pick the project: ${PROJECT_OPTIONS.join(', ')}.` };
    if (f.paid_amount < 0 || f.paid_amount > f.amount) return { error: 'Paid amount cannot be more than the bill amount.' };
    f.due_date = computeDue(f, today);
    if (!f.due_date) return { error: 'Give the credit period in days (or a due date).' };
    if (f.credit_days == null && f.bill_date) f.credit_days = Math.max(0, dayNum(f.due_date) - dayNum(f.bill_date));
    return { f };
  }

  async function loadBills(where = '', params = []) {
    const bills = await rows(`SELECT * FROM ap_bills ${where} ORDER BY (status = 'paid'), due_date, id LIMIT 5000`, params);
    if (!bills.length) return [];
    const ids = bills.map(b => b.id);
    const ev = await rows('SELECT * FROM ap_bill_events WHERE bill_id = ANY($1::int[]) ORDER BY id', [ids]);
    const files = await rows('SELECT id, bill_id, event_id, kind, name, uploaded_by, created_at FROM ap_files WHERE bill_id = ANY($1::int[]) ORDER BY id', [ids]);
    const today = localDateStr(new Date());
    return bills.map(b => {
      const amount = Number(b.amount), paid = Number(b.paid_amount);
      const daysLeft = dayNum(b.due_date) - dayNum(today);
      const events = ev.filter(e => e.bill_id === b.id).map(e => ({ ...e, amount: e.amount == null ? null : Number(e.amount), files: files.filter(f => f.event_id === e.id) }));
      const lastTalk = [...events].reverse().find(e => ['query', 'reply', 'note'].includes(e.kind));
      return { ...b, amount, paid_amount: paid, balance: r2(amount - paid), days_left: daysLeft, overdue_days: b.status === 'paid' ? 0 : Math.max(0, -daysLeft),
        awaiting: b.status !== 'paid' && lastTalk && lastTalk.kind === 'query' ? 'purchase' : null,
        events, files: files.filter(f => f.bill_id === b.id && !f.event_id) };
    });
  }

  // Extra documents: [{ type, name, data }]
  function readDocs(list) {
    if (list == null) return { list: [] };
    if (!Array.isArray(list) || list.length > 20) return { error: 'Attach at most 20 documents at a time.' };
    const out = [];
    for (const d of list) {
      const type = DOC_KEYS.includes(str((d || {}).type)) ? str(d.type) : null;
      if (!type) return { error: 'Pick what each document is (challan, PO, …).' };
      const up = collectUploads({ attachments: [{ name: (d || {}).name, data: (d || {}).data }] }, MAX_FILE_CHARS);
      if (up.error) return { error: up.error };
      out.push({ type, ...up.files[0] });
    }
    return { list: out };
  }
  // ---- routes
  app.get('/api/payables/summary', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user);
    if (!m.canView) return res.json({ canView: false });
    const today = localDateStr(new Date());
    const open = await rows("SELECT id, due_date, created_by FROM ap_bills WHERE status <> 'paid'");
    const overdue = open.filter(b => b.due_date < today).length;
    const soon = open.filter(b => b.due_date >= today && dayNum(b.due_date) - dayNum(today) <= 5).length;
    let questions = 0;
    if (m.canAdd) {
      const last = await rows(`SELECT DISTINCT ON (bill_id) bill_id, kind FROM ap_bill_events WHERE kind IN ('query','reply','note') AND bill_id = ANY($1::int[]) ORDER BY bill_id, id DESC`, [open.map(b => b.id)]);
      questions = last.filter(x => x.kind === 'query' && (m.admin || open.find(b => b.id === x.bill_id && b.created_by === m.username))).length;
    }
    res.json({ canView: true, canAdd: m.canAdd, canPay: m.canPay, overdue, dueSoon: soon, questions });
  });
  app.get('/api/payables', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user);
    if (!m.canView) return res.status(403).json({ error: 'Vendor bills are for Accounts, Purchase, Admin and management.' });
    res.json({ me: { canAdd: m.canAdd, canPay: m.canPay, admin: m.admin }, payModes: PAY_MODES, docTypes: DOC_TYPES, remindBefore: REMIND_BEFORE, projects: PROJECT_OPTIONS, bills: await loadBills() });
  });
  async function linkDelivery(b, f) {
    if (!b.delivery_id) return { delivery_id: null, delivery_ref: str(b.delivery_ref).trim().slice(0, 40) || null };
    const d = await db.getDelivery(b.delivery_id);
    if (!d) return { error: 'That delivery was not found.' };
    if (!f.project && d.project && PROJECT_OPTIONS.includes(d.project)) f.project = d.project;
    if (!f.delivery_done_on) { const done = d.unloaded_at || d.delivered_at; if (done) f.delivery_done_on = localDateStr(new Date(done)); }
    return { delivery_id: d.id, delivery_ref: d.ref };
  }
  app.post('/api/payables', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user);
    if (!m.canAdd) return res.status(403).json({ error: 'Vendor bills are sent to Accounts by the Purchase Department (or Admin).' });
    const b = req.body || {};
    const today = localDateStr(new Date());
    const { f, error } = readBill(b, today); if (error) return res.status(400).json({ error });
    const link = await linkDelivery(b, f); if (link.error) return res.status(400).json({ error: link.error });
    if (f.delivery_done_on == null && !b.delivery_not_done) return res.status(400).json({ error: 'Confirm the delivery date (when the material was delivered).' });
    if (!validDay(b.due_date)) f.due_date = computeDue({ ...f, due_date: null }, today); // the delivery date may only be known now
    const up = collectUploads(b, MAX_FILE_CHARS); if (up.error) return res.status(400).json({ error: up.error });
    if (!up.files.length) return res.status(400).json({ error: 'Attach the vendor bill (photo or PDF).' });
    const docs = readDocs(b.documents); if (docs.error) return res.status(400).json({ error: docs.error });
    let ref; do { ref = genRef(); } while (await one('SELECT 1 FROM ap_bills WHERE ref=$1', [ref]));
    const t = now();
    const bill = await one(`INSERT INTO ap_bills(ref, vendor, bill_no, bill_date, amount, credit_days, due_date, project, delivery_id, delivery_ref, delivery_done_on, description, status, paid_amount, source, created_by, created_by_name, created_at, updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'open',0,'manual',$13,$14,$15,$15) RETURNING *`,
      [ref, f.vendor, f.bill_no, f.bill_date, f.amount, f.credit_days, f.due_date, f.project, link.delivery_id, link.delivery_ref, f.delivery_done_on, f.description, m.username, m.name, t]);
    for (const file of up.files) await q('INSERT INTO ap_files(bill_id, kind, name, data, uploaded_by, created_at) VALUES($1,$2,$3,$4,$5,$6)', [bill.id, 'bill', file.name, file.data, m.username, t]);
    for (const d of docs.list) await q('INSERT INTO ap_files(bill_id, kind, name, data, uploaded_by, created_at) VALUES($1,$2,$3,$4,$5,$6)', [bill.id, d.type, d.name, d.data, m.username, t]);
    await q('INSERT INTO ap_bill_events(bill_id, kind, message, by_username, by_name, created_at) VALUES($1,$2,$3,$4,$5,$6)',
      [bill.id, 'created', `Bill sent to Accounts — delivery ${f.delivery_done_on ? `done on ${fmtDay(f.delivery_done_on)}` : 'not done yet'}, credit ${f.credit_days != null ? `${f.credit_days} days` : '—'}, due ${fmtDay(f.due_date)}.`, m.username, m.name, t]);
    await notify(await accountsTeam(), m.username, 'ap_bill_added', `New vendor bill: ${label(bill)} — ${inr(f.amount)}, due ${fmtDay(f.due_date)}${f.credit_days != null ? ` (${f.credit_days} days credit)` : ''}. Sent by ${m.name}.`);
    await auditFromReq(req, 'bill_added', `Sent ${label(bill)} of ${inr(f.amount)} to Accounts (due ${f.due_date}).`);
    res.json({ ok: true, id: bill.id, ref, due_date: f.due_date });
  });
  async function getBill(id, res) {
    const b = await one('SELECT * FROM ap_bills WHERE id=$1', [Number(id) || 0]);
    if (!b) { res.status(404).json({ error: 'Bill not found.' }); return null; }
    return b;
  }
  app.post('/api/payables/:id/update', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user);
    const bill = await getBill(req.params.id, res); if (!bill) return;
    if (!(m.admin || (m.canAdd && bill.created_by === m.username))) return res.status(403).json({ error: 'Only whoever sent the bill (or Admin) can change it.' });
    if (bill.status === 'paid') return res.status(400).json({ error: 'This bill is paid — it can no longer be changed.' });
    const b = req.body || {};
    const { f, error } = readBill({ ...bill, ...b, amount: b.amount != null ? b.amount : bill.amount, due_date: b.due_date !== undefined ? b.due_date : null }, localDateStr(new Date())); if (error) return res.status(400).json({ error });
    if (f.amount < Number(bill.paid_amount)) return res.status(400).json({ error: 'The amount cannot be less than what is already paid.' });
    await q('UPDATE ap_bills SET vendor=$1, bill_no=$2, bill_date=$3, amount=$4, credit_days=$5, due_date=$6, project=$7, delivery_done_on=$8, description=$9, updated_at=$10 WHERE id=$11',
      [f.vendor, f.bill_no, f.bill_date, f.amount, f.credit_days, f.due_date, f.project, f.delivery_done_on, f.description, now(), bill.id]);
    const changes = [];
    if (Number(bill.amount) !== f.amount) changes.push(`amount ${inr(bill.amount)} → ${inr(f.amount)}`);
    if (bill.due_date !== f.due_date) changes.push(`due date ${fmtDay(bill.due_date)} → ${fmtDay(f.due_date)}`);
    await q('INSERT INTO ap_bill_events(bill_id, kind, message, by_username, by_name, created_at) VALUES($1,$2,$3,$4,$5,$6)', [bill.id, 'edited', `Bill details updated${changes.length ? `: ${changes.join(', ')}` : ''}.`, m.username, m.name, now()]);
    if (changes.length) await notify(await accountsTeam(), m.username, 'ap_update', `${m.name} changed ${label({ ...bill, ...f })}: ${changes.join(', ')}.`);
    res.json({ ok: true, due_date: f.due_date });
  });
  // Accounts and Purchase talk on the bill; Accounts records payments.
  app.post('/api/payables/:id/respond', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user);
    const bill = await getBill(req.params.id, res); if (!bill) return;
    if (!m.canView) return res.status(403).json({ error: 'Not allowed.' });
    const b = req.body || {};
    const action = str(b.action);
    const msg = str(b.message).trim().slice(0, 1000);
    const ACC = ['schedule', 'partial', 'paid', 'hold', 'resume', 'query'];
    if (ACC.includes(action) && !m.canPay) return res.status(403).json({ error: 'Payments are recorded by the Accounts team (or Admin).' });
    if (action === 'reply' && !(m.canAdd || m.admin)) return res.status(403).json({ error: 'Answers come from Purchase (or Admin).' });
    if (!['note', 'reply', ...ACC].includes(action)) return res.status(400).json({ error: 'Pick what to do.' });
    if (bill.status === 'paid' && !['note'].includes(action)) return res.status(400).json({ error: 'This bill is already paid.' });
    const up = collectUploads(b, MAX_FILE_CHARS); if (up.error) return res.status(400).json({ error: up.error });
    const t = now();
    const balance = r2(Number(bill.amount) - Number(bill.paid_amount));
    let set = {}, text = msg, amount = null, payDate = null, payMode = null, payRef = null;
    if (['note', 'reply', 'query'].includes(action) && msg.length < 2) return res.status(400).json({ error: 'Write the message.' });
    if (action === 'schedule') {
      const d = validDay(b.scheduled_for); if (!d) return res.status(400).json({ error: 'Pick the date the payment will be released.' });
      set = { status: 'scheduled', scheduled_for: d }; text = `Payment scheduled for ${fmtDay(d)}${msg ? ` — ${msg}` : ''}.`;
    }
    if (action === 'partial' || action === 'paid') {
      amount = action === 'paid' && (b.amount == null || b.amount === '') ? balance : r2(Number(b.amount));
      if (!isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Enter the amount paid.' });
      if (amount > balance + 0.001) return res.status(400).json({ error: `Only ${inr(balance)} is left to pay on this bill.` });
      payDate = validDay(b.pay_date) || localDateStr(new Date()); payMode = PAY_MODES.includes(str(b.pay_mode)) ? str(b.pay_mode) : null; payRef = str(b.pay_ref).trim().slice(0, 80) || null;
      const newPaid = r2(Number(bill.paid_amount) + amount);
      const full = newPaid >= Number(bill.amount) - 0.001;
      set = { paid_amount: newPaid, status: full ? 'paid' : 'partial', ...(full ? { paid_at: t } : {}) };
      text = `${full ? 'Paid' : 'Part payment'} ${inr(amount)} on ${fmtDay(payDate)}${payMode ? ` by ${payMode}` : ''}${payRef ? ` (ref ${payRef})` : ''}${full ? '' : ` — ${inr(r2(Number(bill.amount) - newPaid))} still to pay`}${msg ? `. ${msg}` : ''}.`;
    }
    if (action === 'hold') { if (msg.length < 5) return res.status(400).json({ error: 'Write why the payment is on hold.' }); set = { status: 'on_hold', hold_reason: msg }; text = `Payment put on hold: ${msg}`; }
    if (action === 'resume') { set = { status: Number(bill.paid_amount) > 0 ? 'partial' : 'open', hold_reason: null }; text = `Payment taken off hold${msg ? ` — ${msg}` : ''}.`; }
    if (Object.keys(set).length) {
      const keys = Object.keys(set);
      await q(`UPDATE ap_bills SET ${keys.map((k, i) => `${k}=$${i + 1}`).join(', ')}, updated_at=$${keys.length + 1} WHERE id=$${keys.length + 2}`, [...keys.map(k => set[k]), t, bill.id]);
    }
    const ev = await one('INSERT INTO ap_bill_events(bill_id, kind, message, amount, pay_date, pay_mode, pay_ref, by_username, by_name, created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id',
      [bill.id, action, text, amount, payDate, payMode, payRef, m.username, m.name, t]);
    for (const file of up.files) await q('INSERT INTO ap_files(bill_id, event_id, kind, name, data, uploaded_by, created_at) VALUES($1,$2,$3,$4,$5,$6,$7)', [bill.id, ev.id, ['partial', 'paid'].includes(action) ? 'proof' : 'other', file.name, file.data, m.username, t]);
    // Who is told: Accounts' updates → whoever sent the bill + Admin; Purchase's answers → Accounts.
    const fromAccounts = m.canPay && !(action === 'reply');
    const to = fromAccounts ? await purchaseSide(bill) : await accountsTeam();
    const prefix = { query: `❓ Question from ${m.name}`, reply: `↩ ${m.name} answered`, note: `💬 ${m.name}`, schedule: `🗓 ${m.name}`, partial: `💸 ${m.name}`, paid: `✅ ${m.name}`, hold: `⏸ ${m.name}`, resume: `▶ ${m.name}` }[action];
    await notify(to, m.username, fromAccounts ? 'ap_update' : 'ap_reply', `${prefix} on ${label(bill)}: ${text}`);
    await auditFromReq(req, `bill_${action}`, `${label(bill)}: ${text}`);
    res.json({ ok: true, status: set.status || bill.status });
  });
  app.post('/api/payables/:id/followup', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user);
    const bill = await getBill(req.params.id, res); if (!bill) return;
    if (!(m.canAdd || m.admin)) return res.status(403).json({ error: 'Purchase (or Admin) follows up with Accounts.' });
    if (bill.status === 'paid') return res.status(400).json({ error: 'This bill is already paid.' });
    if (bill.last_followup_at && Date.now() - new Date(bill.last_followup_at).getTime() < FOLLOWUP_GAP_MS) return res.status(429).json({ error: 'Followed up less than 2 hours ago — give Accounts some time.' });
    const t = now();
    await q('UPDATE ap_bills SET last_followup_at=$1, last_followup_by=$2, followup_count=followup_count+1 WHERE id=$3', [t, m.username, bill.id]);
    const today = localDateStr(new Date()); const dl = dayNum(bill.due_date) - dayNum(today);
    const when = dl < 0 ? `overdue by ${-dl} day${dl === -1 ? '' : 's'}` : dl === 0 ? 'due today' : `due in ${dl} day${dl === 1 ? '' : 's'}`;
    const msg = str((req.body || {}).message).trim().slice(0, 300);
    await q('INSERT INTO ap_bill_events(bill_id, kind, message, by_username, by_name, created_at) VALUES($1,$2,$3,$4,$5,$6)', [bill.id, 'followup', `Followed up with Accounts (${when})${msg ? `: ${msg}` : ''}.`, m.username, m.name, t]);
    const to = await accountsTeam();
    await notify(to, m.username, 'ap_followup', `📣 ${m.name} is following up on ${label(bill)} — ${inr(r2(Number(bill.amount) - Number(bill.paid_amount)))} ${when}.${msg ? ` "${msg}"` : ''} Please release the payment or reply.`);
    res.json({ ok: true, sent: to });
  });
  app.post('/api/payables/:id/delete', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user);
    const bill = await getBill(req.params.id, res); if (!bill) return;
    const ok = m.admin || (bill.created_by === m.username && Number(bill.paid_amount) === 0);
    if (!ok) return res.status(403).json({ error: Number(bill.paid_amount) > 0 ? 'Payments are recorded on this bill — only Admin can remove it.' : 'Only whoever sent the bill (or Admin) can remove it.' });
    await q('DELETE FROM ap_bills WHERE id=$1', [bill.id]);
    await q("DELETE FROM notifications WHERE type='ap_reminder' AND message LIKE $1", [`%(${bill.ref})%`]);
    await auditFromReq(req, 'bill_deleted', `Removed ${label(bill)} (${inr(bill.amount)}).`);
    res.json({ ok: true });
  });
  app.post('/api/payables/:id/files', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user);
    const bill = await getBill(req.params.id, res); if (!bill) return;
    if (!(m.canAdd || m.canPay)) return res.status(403).json({ error: 'Not allowed.' });
    const type = DOC_KEYS.includes(str((req.body || {}).type)) ? str(req.body.type) : 'other';
    const up = collectUploads(req.body || {}, MAX_FILE_CHARS); if (up.error) return res.status(400).json({ error: up.error });
    if (!up.files.length) return res.status(400).json({ error: 'Attach a file.' });
    const t = now();
    for (const file of up.files) await q('INSERT INTO ap_files(bill_id, kind, name, data, uploaded_by, created_at) VALUES($1,$2,$3,$4,$5,$6)', [bill.id, type, file.name, file.data, m.username, t]);
    const lab = DOC_TYPES.find(d => d.key === type).label;
    await q('INSERT INTO ap_bill_events(bill_id, kind, message, by_username, by_name, created_at) VALUES($1,$2,$3,$4,$5,$6)', [bill.id, 'document', `${lab} added: ${up.files.map(f => f.name).join(', ')}.`, m.username, m.name, t]);
    await notify(m.canPay && !m.canAdd ? await purchaseSide(bill) : await accountsTeam(), m.username, m.canPay && !m.canAdd ? 'ap_update' : 'ap_reply', `📄 ${m.name} added ${lab.toLowerCase()} to ${label(bill)}.`);
    res.json({ ok: true });
  });
  app.get('/api/payables/files/:id', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user); if (!m.canView) return res.status(403).json({ error: 'Not allowed.' });
    const f = await one('SELECT name, data FROM ap_files WHERE id=$1', [Number(req.params.id) || 0]);
    if (!f) return res.status(404).json({ error: 'File not found.' });
    res.json(f);
  });

  // ---- Import outstanding bills from Excel / CSV
  const COLS = {
    vendor: ['vendor', 'supplier', 'party', 'party name', 'vendor name', 'supplier name', 'name of vendor', 'name of supplier'],
    bill_no: ['bill no', 'bill number', 'invoice no', 'invoice number', 'inv no', 'bill', 'invoice'],
    bill_date: ['bill date', 'invoice date', 'inv date', 'date'],
    amount: ['amount', 'bill amount', 'invoice amount', 'total', 'net amount', 'gross amount', 'total amount', 'bill value', 'invoice value'],
    paid_amount: ['paid', 'paid amount', 'amount paid', 'payment made'],
    balance: ['balance', 'outstanding', 'balance amount', 'pending amount', 'due amount', 'amount due'],
    credit_days: ['credit days', 'credit period', 'credit', 'credit days allowed', 'days'],
    due_date: ['due date', 'payment due', 'due on', 'payment due date'],
    project: ['project', 'site', 'project name'],
    delivery_ref: ['delivery', 'dlv', 'po', 'po no', 'dc no', 'challan no', 'delivery ref', 'grn'],
    description: ['remarks', 'notes', 'description', 'material', 'particulars'],
  };
  const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[\s._:()\[\]\-\/#]+/g, ' ').trim();
  const numOf = (v) => { if (v == null || v === '' || v instanceof Date) return null; const s = String(v).replace(/,/g, '').replace(/₹|rs\.?|inr/gi, '').trim(); if (!/^-?\d*\.?\d+$/.test(s)) return null; return Number(s); };
  async function readGrid(dataUrl, fileName) {
    const buf = decodeDataUrl(dataUrl);
    const zip = buf.length > 3 && buf[0] === 0x50 && buf[1] === 0x4b;
    if (!zip) return parseCSV(buf.toString('utf8'));
    let wb = new ExcelJS.Workbook();
    try { await wb.xlsx.load(buf); } catch (e) { wb = new ExcelJS.Workbook(); await wb.xlsx.load(await stripXlsxComments(buf)); }
    for (const ws of wb.worksheets) {
      if (ws.state === 'hidden' || ws.state === 'veryHidden') continue;
      const out = [];
      ws.eachRow({ includeEmpty: true }, (row, n) => { const v = []; for (let c = 1; c <= Math.max(ws.actualColumnCount || 0, row.cellCount); c++) v.push(excelCellValue(row.getCell(c).value)); out[n - 1] = v; });
      for (let i = 0; i < out.length; i++) if (!out[i]) out[i] = [];
      if (findHeader(out)) return out;
    }
    return [];
  }
  function findHeader(grid) {
    for (let i = 0; i < Math.min(grid.length, 25); i++) {
      const map = {};
      (grid[i] || []).map(norm).forEach((c, idx) => { for (const [k, al] of Object.entries(COLS)) if (map[k] == null && al.includes(c)) { map[k] = idx; break; } });
      if (map.vendor != null && (map.amount != null || map.balance != null)) return { index: i, map };
    }
    return null;
  }
  async function planImport(dataUrl, fileName) {
    if (!dataUrl) throw Object.assign(new Error('Choose the Excel / CSV file.'), { isImportError: true });
    if (String(dataUrl).length > 14 * 1024 * 1024) throw Object.assign(new Error('That file is too large (max ~10 MB).'), { isImportError: true });
    let grid;
    try { grid = await readGrid(dataUrl, fileName); } catch (e) { throw Object.assign(new Error("This file couldn't be opened. Save it as .xlsx or .csv and try again."), { isImportError: true }); }
    const h = findHeader(grid);
    if (!h) throw Object.assign(new Error('No bill list found — the sheet needs a heading row with Vendor (or Party / Supplier) and Amount (or Balance). Download the template to see the layout.'), { isImportError: true });
    const today = localDateStr(new Date());
    const out = [];
    for (let i = h.index + 1; i < grid.length; i++) {
      const r = grid[i] || []; const get = k => (h.map[k] == null ? null : r[h.map[k]]);
      if (r.every(c => c == null || String(c).trim() === '')) continue;
      const vendor = String(get('vendor') == null ? '' : get('vendor')).trim();
      if (/^(grand )?total\b/i.test(vendor)) continue;
      let amount = numOf(get('amount')); const bal = numOf(get('balance')); let paid = numOf(get('paid_amount'));
      if (amount == null && bal != null) amount = bal;
      if (paid == null && bal != null && amount != null) paid = Math.max(0, amount - bal);
      const row = { rowNumber: i + 1, vendor, bill_no: String(get('bill_no') == null ? '' : get('bill_no')).trim(), bill_date: (parseDateValue(get('bill_date')) || '').slice(0, 10) || null,
        amount, paid_amount: paid || 0, credit_days: numOf(get('credit_days')), due_date: (parseDateValue(get('due_date')) || '').slice(0, 10) || null,
        project: String(get('project') == null ? '' : get('project')).trim(), delivery_ref: String(get('delivery_ref') == null ? '' : get('delivery_ref')).trim(), description: String(get('description') == null ? '' : get('description')).trim() };
      const hit = row.project && PROJECT_OPTIONS.find(p => p.toLowerCase() === row.project.toLowerCase() || p.toLowerCase().includes(row.project.toLowerCase()) || row.project.toLowerCase().includes(p.toLowerCase().split(' (')[0]));
      row.project = hit || '';
      const { f, error } = readBill({ ...row, credit_days: row.credit_days == null ? '' : row.credit_days }, today, { forImport: true });
      row.error = error || null;
      if (f) { row.due_date = f.due_date; row.credit_days = f.credit_days; row.balance = r2(f.amount - f.paid_amount); row.days_left = dayNum(f.due_date) - dayNum(today); }
      if (!row.error && row.balance <= 0) row.note = 'Fully paid — will be imported as paid';
      out.push(row);
    }
    if (!out.length) throw Object.assign(new Error('The sheet has headings but no bills under them.'), { isImportError: true });
    if (out.length > 2000) throw Object.assign(new Error(`That is ${out.length} bills — import at most 2000 at a time.`), { isImportError: true });
    return out;
  }
  app.post('/api/payables/import/preview', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user);
    if (!(m.canAdd || m.canPay)) return res.status(403).json({ error: 'Purchase, Accounts or Admin can import bills.' });
    try { const r = await planImport((req.body || {}).fileData, (req.body || {}).fileName); res.json({ rows: r, valid: r.filter(x => !x.error).length, errors: r.filter(x => x.error).length }); }
    catch (e) { if (e.isImportError) return res.status(400).json({ error: e.message }); throw e; }
  });
  app.post('/api/payables/import', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user);
    if (!(m.canAdd || m.canPay)) return res.status(403).json({ error: 'Purchase, Accounts or Admin can import bills.' });
    let plan;
    try { plan = await planImport((req.body || {}).fileData, (req.body || {}).fileName); } catch (e) { if (e.isImportError) return res.status(400).json({ error: e.message }); throw e; }
    const ok = plan.filter(x => !x.error);
    if (!ok.length) return res.status(400).json({ error: 'No valid rows to import.' });
    const t = now(); const created = [];
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      for (const r of ok) {
        let ref; do { ref = genRef(); } while ((await client.query('SELECT 1 FROM ap_bills WHERE ref=$1', [ref])).rows.length || created.some(c => c.ref === ref));
        const paid = r2(r.paid_amount || 0); const full = paid >= r.amount - 0.001;
        const row = (await client.query(`INSERT INTO ap_bills(ref, vendor, bill_no, bill_date, amount, credit_days, due_date, project, delivery_ref, description, status, paid_amount, source, created_by, created_by_name, created_at, updated_at, paid_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'import',$13,$14,$15,$15,$16) RETURNING id`,
          [ref, r.vendor, r.bill_no || null, r.bill_date, r2(r.amount), r.credit_days, r.due_date, r.project || null, r.delivery_ref || null, r.description || null, full ? 'paid' : paid > 0 ? 'partial' : 'open', paid, m.username, m.name, t, full ? t : null])).rows[0];
        await client.query('INSERT INTO ap_bill_events(bill_id, kind, message, by_username, by_name, created_at) VALUES($1,$2,$3,$4,$5,$6)',
          [row.id, 'created', `Imported from ${str((req.body || {}).fileName).slice(0, 120) || 'a file'} (row ${r.rowNumber})${paid ? ` — ${inr(paid)} already paid` : ''}.`, m.username, m.name, t]);
        created.push({ id: row.id, ref });
      }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    const overdue = ok.filter(r => r.balance > 0 && r.days_left < 0);
    if (!m.canPay) await notify(await accountsTeam(), m.username, 'ap_bill_added', `${m.name} imported ${created.length} vendor bill${created.length === 1 ? '' : 's'}${overdue.length ? ` — ${overdue.length} already overdue (${inr(r2(overdue.reduce((a, r) => a + r.balance, 0)))})` : ''}.`);
    await auditFromReq(req, 'bills_imported', `Imported ${created.length} vendor bill(s).`);
    res.json({ ok: true, created: created.length, skipped: plan.length - ok.length });
  });
  app.get('/api/payables/template', auth(ALL_ROLES), async (req, res) => {
    const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Bills');
    const head = ws.addRow(['Vendor', 'Bill No', 'Bill Date', 'Amount', 'Paid', 'Credit Days', 'Due Date', 'Project', 'Delivery / PO', 'Remarks']); head.font = { bold: true };
    ws.addRow(['Kratex Tradetech India', 'KT/2291', '01-10-2026', 125000, 0, 30, '', 'Mihir Amara', 'DLV-AB12C', 'Tiles 400 boxes']);
    ws.addRow(['Shree Cement Depot', 'SC-778', '15-09-2026', 48000, 20000, 15, '', 'Nyati Equinox', '', 'part paid']);
    ws.addRow(['Patil Hardware', 'PH-12', '20-08-2026', 9500, 0, '', '19-09-2026', 'Sierra (Tathawade)', '', 'due date given instead of credit days']);
    ws.columns.forEach(c => { c.width = 18; });
    const help = wb.addWorksheet('How to fill');
    ['Needed: Vendor and Amount (or Balance / Outstanding). Give Credit Days (counted from the Bill Date) or a Due Date.', 'Paid = amount already paid (or give Balance and it is worked out). Fully paid rows are imported as paid.',
      'Dates like 01-10-2026, 1/10/26, 1 Oct 2026 or Excel dates all work. Project must be one of: ' + PROJECT_OPTIONS.join(', ') + ' (others are left blank).'].forEach(t => help.addRow([t]));
    help.getColumn(1).width = 120;
    const buf = await wb.xlsx.writeBuffer();
    res.json({ name: 'vendor-bills-template.xlsx', data: 'data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,' + Buffer.from(buf).toString('base64') });
  });

  // ---- Reminders to Accounts (called from the reminder engine at each slot; once a day per bill)
  async function runPayableReminders(nowDate) {
    const today = localDateStr(nowDate);
    const bills = await rows("SELECT * FROM ap_bills WHERE status IN ('open','scheduled','partial')");
    if (!bills.length) return 0;
    const to = await accountsTeam();
    let sent = 0;
    for (const b of bills) {
      const d = dayNum(b.due_date) - dayNum(today);
      const bal = r2(Number(b.amount) - Number(b.paid_amount));
      let message = null;
      const what = `${b.vendor}${b.bill_no ? ` bill ${b.bill_no}` : ''} (${b.ref}) — ${inr(bal)}${b.project ? `, ${b.project}` : ''}`;
      if (REMIND_BEFORE.includes(d)) message = `Payment due in ${d} days: ${what}. Due ${fmtDay(b.due_date)} — ${d} days left to release it (overdue in ${d} days).${b.scheduled_for ? ` Scheduled for ${fmtDay(b.scheduled_for)}.` : ''}`;
      else if (d === 0) message = `Payment due TODAY: ${what}. Release it today or reply on the bill.`;
      else if (d < 0) message = `Payment overdue by ${-d} day${d === -1 ? '' : 's'}: ${what}. Was due ${fmtDay(b.due_date)}. Please release it or reply on the bill.`;
      if (!message) continue;
      for (const u of to) {
        const id = await db.claimDelivery({ key: `aprem:${b.id}:${u}:${today}`, recipient: u, taskId: null, type: 'ap_reminder' });
        if (!id) continue;
        try {
          await q("DELETE FROM notifications WHERE username=$1 AND type='ap_reminder' AND message LIKE $2", [u, `%(${b.ref})%`]);
          const nid = await db.createNotification({ username: u, type: 'ap_reminder', message, task_id: null, ref_type: 'bill', ref_id: b.id });
          await db.finishDelivery(id, { status: 'sent', notificationId: nid, sentAt: nowDate.toISOString() });
          sent++;
        } catch (e) { await db.finishDelivery(id, { status: 'failed', reason: e.message.slice(0, 300) }); }
      }
    }
    return sent;
  }
  return { runPayableReminders };
}

module.exports = { mountPayables, PAY_MODES, REMIND_BEFORE, DOC_TYPES };
