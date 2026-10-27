const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const csvUrl = (t) => 'data:text/csv;base64,' + Buffer.from(t, 'utf8').toString('base64');
const addDays = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };

test('vendor bills: Purchase sends with credit days, Accounts responds and pays, follow-up, import, reminders T-15/T-5/T-2 and overdue', async (t) => {
  const { baseUrl, stop } = await startTestServer();
  t.after(stop);
  const admin = await login(baseUrl, 'admin', 'admin123');
  const P = (tok, path, body) => api(baseUrl, path, { method: 'POST', token: tok, body });
  const G = (tok, path) => api(baseUrl, path, { token: tok });
  const buyer = await createMember(baseUrl, admin, 'tanu.ap', 'Tanu Purchase', 'Purchase Department');
  const acc = await createMember(baseUrl, admin, 'niraj.ap', 'Niraj Accounts', 'Accounts Department');
  const acc2 = await createMember(baseUrl, admin, 'sneha.ap', 'Sneha Accounts', 'Accounts Department');
  const site = await createMember(baseUrl, admin, 'site.ap', 'Site Person', 'Execution Department');
  const nots = async (tok, type) => (await G(tok, '/api/notifications')).data.items.filter(n => n.type === type);

  // access
  assert.equal((await G(site, '/api/payables')).status, 403);
  assert.equal((await G(site, '/api/payables/summary')).data.canView, false);
  const base = { vendor: 'Kratex Tradetech India', bill_no: 'KT/2291', bill_date: '2026-10-01', amount: 125000, credit_days: 30, project: 'Mihir Amara', delivery_done_on: '2026-10-02', attachments: [{ name: 'bill.png', data: PNG }] };
  assert.equal((await P(acc, '/api/payables', base)).status, 403, 'Accounts does not send bills');
  assert.equal((await P(buyer, '/api/payables', { ...base, attachments: [] })).status, 400, 'bill file required');
  assert.equal((await P(buyer, '/api/payables', { ...base, credit_days: '', due_date: '' })).status, 400, 'credit days or due date');
  assert.equal((await P(buyer, '/api/payables', { ...base, delivery_done_on: '' })).status, 400, 'delivery date needed');

  // sent with a delivery → delivery date + project from the delivery
  const dl = (await P(buyer, '/api/deliveries', { title: 'Tiles 400 boxes', expected_at: futureDate(1), receivers: ['site.ap'], project: 'Mihir Amara' })).data;
  await P(site, `/api/deliveries/${dl.id}/proof`, { stage: 'delivered', attachments: [{ name: 'a.png', data: PNG }] });
  assert.equal((await P(buyer, '/api/payables', { ...base, documents: [{ type: 'nonsense', name: 'x.png', data: PNG }] })).status, 400, 'document type must be known');
  const b1 = await P(buyer, '/api/payables', { ...base, delivery_id: dl.id, delivery_done_on: '', documents: [{ type: 'challan', name: 'dc.png', data: PNG }, { type: 'po', name: 'po.pdf', data: PNG }] });
  assert.equal(b1.status, 200, JSON.stringify(b1.data));
  assert.equal(b1.data.due_date, '2026-10-31');
  assert.ok((await nots(acc, 'ap_bill_added')).some(n => /Kratex Tradetech India bill KT\/2291/.test(n.message) && /30 days credit/.test(n.message)));
  let bills = (await G(acc, '/api/payables')).data.bills;
  let b = bills.find(x => x.id === b1.data.id);
  assert.equal(b.delivery_ref, dl.ref); assert.ok(b.delivery_done_on); assert.equal(b.balance, 125000);
  assert.deepEqual(b.files.map(f => f.kind).sort(), ['bill', 'challan', 'po']);
  // add a GRN later (Purchase) → Accounts told; Accounts adds a credit note → Purchase told
  assert.equal((await P(buyer, `/api/payables/${b.id}/files`, { type: 'grn', attachments: [{ name: 'grn.png', data: PNG }] })).status, 200);
  assert.ok((await nots(acc, 'ap_reply')).some(n => /added gRN|added grn \/ material inward/i.test(n.message)));
  assert.equal((await P(acc, `/api/payables/${b.id}/files`, { type: 'credit_note', attachments: [{ name: 'cn.png', data: PNG }] })).status, 200);
  assert.ok((await nots(buyer, 'ap_update')).some(n => /credit \/ debit note/.test(n.message)));
  assert.equal((await P(site, `/api/payables/${b.id}/files`, { type: 'po', attachments: [{ name: 'x.png', data: PNG }] })).status, 403);
  assert.ok((await G(acc, '/api/payables')).data.docTypes.some(d => d.key === 'challan'));

  // Accounts asks a question → Purchase (+ Admin) told; awaiting Purchase; Purchase answers → Accounts told
  assert.equal((await P(buyer, `/api/payables/${b.id}/respond`, { action: 'query', message: 'x' })).status, 403);
  assert.equal((await P(acc, `/api/payables/${b.id}/respond`, { action: 'query', message: 'GST number missing on the bill?' })).status, 200);
  assert.ok((await nots(buyer, 'ap_update')).some(n => /Question from Niraj Accounts/.test(n.message)));
  assert.ok((await nots(admin, 'ap_update')).length >= 1, 'Admin is told too');
  assert.equal((await G(buyer, '/api/payables/summary')).data.questions, 1);
  assert.equal((await G(buyer, '/api/payables')).data.bills.find(x => x.id === b.id).awaiting, 'purchase');
  assert.equal((await P(buyer, `/api/payables/${b.id}/respond`, { action: 'reply', message: 'Corrected bill attached', attachments: [{ name: 'bill2.png', data: PNG }] })).status, 200);
  assert.ok((await nots(acc2, 'ap_reply')).some(n => /answered/.test(n.message)));
  // schedule, part payment, paid
  assert.equal((await P(acc, `/api/payables/${b.id}/respond`, { action: 'schedule', scheduled_for: '2026-10-29' })).status, 200);
  assert.equal((await P(acc, `/api/payables/${b.id}/respond`, { action: 'partial', amount: 200000 })).status, 400, 'more than balance');
  assert.equal((await P(acc, `/api/payables/${b.id}/respond`, { action: 'partial', amount: 25000, pay_mode: 'NEFT / RTGS', pay_ref: 'UTR123', pay_date: '2026-10-20', attachments: [{ name: 'utr.png', data: PNG }] })).status, 200);
  b = (await G(buyer, '/api/payables')).data.bills.find(x => x.id === b.id);
  assert.equal(b.status, 'partial'); assert.equal(b.paid_amount, 25000); assert.equal(b.balance, 100000);
  assert.ok(b.events.some(e => e.kind === 'partial' && e.files.length === 1 && e.pay_ref === 'UTR123'));
  // follow up (Purchase → Accounts), not twice in 2 hours
  const fu = await P(buyer, `/api/payables/${b.id}/followup`, { message: 'Vendor calling daily' });
  assert.equal(fu.status, 200); assert.deepEqual(fu.data.sent.sort(), ['niraj.ap', 'sneha.ap']);
  assert.ok((await nots(acc, 'ap_followup')).some(n => /Vendor calling daily/.test(n.message)));
  assert.equal((await P(buyer, `/api/payables/${b.id}/followup`)).status, 429);
  assert.equal((await P(acc, `/api/payables/${b.id}/followup`)).status, 403);
  // hold / resume / paid
  assert.equal((await P(acc, `/api/payables/${b.id}/respond`, { action: 'hold', message: 'no' })).status, 400);
  assert.equal((await P(acc, `/api/payables/${b.id}/respond`, { action: 'hold', message: 'Short supply — 20 boxes' })).status, 200);
  assert.equal((await P(acc, `/api/payables/${b.id}/respond`, { action: 'resume' })).status, 200);
  assert.equal((await P(acc, `/api/payables/${b.id}/respond`, { action: 'paid', pay_mode: 'NEFT / RTGS' })).status, 200);
  b = (await G(acc, '/api/payables')).data.bills.find(x => x.id === b.id);
  assert.equal(b.status, 'paid'); assert.equal(b.balance, 0); assert.ok(b.paid_at);
  assert.equal((await P(buyer, `/api/payables/${b.id}/update`, { amount: 1 })).status, 400, 'paid = locked');
  assert.equal((await P(buyer, `/api/payables/${b.id}/delete`)).status, 403, 'payments on it');

  // Import outstanding bills
  const csv = ['Party Name,Invoice No,Invoice Date,Bill Amount,Paid,Credit Days,Due Date,Site,Remarks',
    'Shree Cement Depot,SC-778,15-09-2026,48000,20000,15,,Equinox,part paid',
    'Patil Hardware,PH-12,20-08-2026,9500,,,19-09-2026,Tathawade,',
    'Old Paid Vendor,OP-1,01-08-2026,1000,1000,10,,,',
    ',X-1,01-08-2026,500,,10,,,no vendor',
    'Total,,,59000,,,,,'].join('\n');
  assert.equal((await P(site, '/api/payables/import/preview', { fileData: csvUrl(csv), fileName: 'b.csv' })).status, 403);
  const pv = await P(acc, '/api/payables/import/preview', { fileData: csvUrl(csv), fileName: 'b.csv' });
  assert.equal(pv.status, 200, JSON.stringify(pv.data)); assert.equal(pv.data.valid, 3); assert.equal(pv.data.errors, 1);
  const sc = pv.data.rows.find(r => r.vendor === 'Shree Cement Depot');
  assert.equal(sc.due_date, '2026-09-30'); assert.equal(sc.balance, 28000); assert.equal(sc.project, 'Nyati Equinox');
  assert.equal(pv.data.rows.find(r => r.vendor === 'Patil Hardware').project, 'Sierra (Tathawade)');
  const im = await P(acc, '/api/payables/import', { fileData: csvUrl(csv), fileName: 'b.csv' });
  assert.equal(im.status, 200); assert.equal(im.data.created, 3); assert.equal(im.data.skipped, 1);
  bills = (await G(acc, '/api/payables')).data.bills;
  assert.equal(bills.find(x => x.vendor === 'Old Paid Vendor').status, 'paid');
  assert.equal(bills.find(x => x.vendor === 'Shree Cement Depot').files.length, 0, "another bill's file is not shown on it");
  assert.equal(bills.find(x => x.vendor === 'Shree Cement Depot').status, 'partial');
  const tpl = await G(acc, '/api/payables/template'); assert.equal(tpl.status, 200);

  // Reminders to Accounts at T-15 / T-5 / T-2 / due / overdue (once a day, one card per bill)
  const D = '2026-11-02';
  const at = (day) => `${day}T09:05:00+05:30`;
  const mk = async (vendor, due) => (await P(buyer, '/api/payables', { ...base, vendor, bill_no: vendor, credit_days: '', due_date: due })).data;
  const t15 = await mk('V15', addDays(D, 15)); const t5 = await mk('V5', addDays(D, 5)); const t2 = await mk('V2', addDays(D, 2));
  const t7 = await mk('V7', addDays(D, 7)); const t0 = await mk('V0', D);
  await P(admin, '/api/tasks/send-reminders-now', { at: at(D) });
  const rem = async () => (await nots(acc, 'ap_reminder'));
  let r = await rem();
  const of = (ref) => r.filter(n => n.message.includes(`(${ref})`));
  assert.match(of(t15.ref)[0].message, /^Payment due in 15 days: V15/);
  assert.match(of(t5.ref)[0].message, /^Payment due in 5 days/);
  assert.match(of(t2.ref)[0].message, /^Payment due in 2 days/);
  assert.equal(of(t7.ref).length, 0, 'no reminder 7 days before');
  assert.match(of(t0.ref)[0].message, /^Payment due TODAY/);
  // imported overdue bills: overdue by N days
  assert.ok(r.some(n => /^Payment overdue by 33 days: Shree Cement Depot/.test(n.message)), r.map(n => n.message).join('\n'));
  assert.ok(!r.some(n => /Old Paid Vendor|Kratex Tradetech India bill KT\/2291/.test(n.message)), 'paid bills are not reminded');
  // same day, next slot → nothing new; next day → overdue by 1, replacing the card
  await P(admin, '/api/tasks/send-reminders-now', { at: `${D}T15:05:00+05:30` });
  assert.equal((await rem()).length, r.length);
  await P(admin, '/api/tasks/send-reminders-now', { at: at(addDays(D, 1)) });
  r = await rem();
  assert.equal(of(t0.ref).length, 1); assert.match(of(t0.ref)[0].message, /^Payment overdue by 1 day:/);
  assert.equal(of(t15.ref).length, 1, 'card kept (no reminder at 14 days), still one');
  // hold stops reminders
  await P(acc, `/api/payables/${t0.id}/respond`, { action: 'hold', message: 'Dispute on quantity' });
  await P(admin, '/api/tasks/send-reminders-now', { at: at(addDays(D, 2)) });
  r = await rem();
  assert.match(of(t0.ref)[0].message, /overdue by 1 day:/, 'on hold → no new overdue reminder');
  // summary counts
  const sm = (await G(acc, '/api/payables/summary')).data;
  assert.equal(sm.canPay, true); assert.ok(sm.overdue >= 2);
});
