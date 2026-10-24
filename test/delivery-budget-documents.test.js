const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PDF = 'data:application/pdf;base64,JVBERi0xLjQKJSVFT0YK';

test('delivery documents (sent to site / from site, required vs optional) and budget with payments', async (t) => {
  const { baseUrl, stop, getRawClient } = await startTestServer();
  t.after(stop);
  const admin = await login(baseUrl, 'admin', 'admin123');
  const buyer = await createMember(baseUrl, admin, 'tanu.b', 'Tanu Purchase', 'Purchase Department');
  const site = await createMember(baseUrl, admin, 'sachin.b', 'Sachin Site', 'Execution Department');
  const site2 = await createMember(baseUrl, admin, 'ravi.b', 'Ravi Site', 'Execution Department');
  const outsider = await createMember(baseUrl, admin, 'out.b', 'Out Sider', 'Sales');
  const accts = await createMember(baseUrl, admin, 'acc.b', 'Asha Accounts', 'Accounts Department');
  const P = (tok, path, body) => api(baseUrl, path, { method: 'POST', token: tok, body });
  const G = (tok, path) => api(baseUrl, path, { token: tok });
  const one = async (tok, id) => (await G(tok, '/api/deliveries')).data.items.find(x => x.id === id);

  // ---- create with a budget; default required documents = challan (to site) + signed challan (from site)
  assert.equal((await P(buyer, '/api/deliveries', { title: 'x', expected_at: futureDate(1), receivers: ['sachin.b'], budget_amount: 'abc' })).status, 400);
  assert.equal((await P(buyer, '/api/deliveries', { title: 'x', expected_at: futureDate(1), receivers: ['sachin.b'], required_docs: ['nope'] })).status, 400);
  const c = await P(buyer, '/api/deliveries', { title: 'Cement 50 bags', expected_at: futureDate(1), receivers: ['sachin.b', 'ravi.b'], budget_amount: 2000, budget_note: 'Porter + unloading' });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  const id = c.data.id;
  const list = (await G(buyer, '/api/deliveries')).data;
  assert.ok(Array.isArray(list.docTypes) && list.docTypes.some(x => x.key === 'challan' && x.dir === 'to_site'));
  let d = list.items.find(x => x.id === id);
  assert.equal(d.budget_amount, 2000); assert.equal(d.paid, 0); assert.equal(d.balance, 2000);
  assert.deepEqual(d.required_docs, ['challan', 'signed_challan']);

  // ---- documents: to-site only by purchase; from-site by the tagged site team (or purchase)
  assert.equal((await P(site, `/api/deliveries/${id}/documents`, { type: 'challan', attachments: [{ name: 'c.pdf', data: PDF }] })).status, 403, 'site cannot send to-site docs');
  assert.equal((await P(buyer, `/api/deliveries/${id}/documents`, { type: 'challan', attachments: [] })).status, 400, 'file required');
  assert.equal((await P(buyer, `/api/deliveries/${id}/documents`, { type: 'bogus', attachments: [{ name: 'c.pdf', data: PDF }] })).status, 400);
  assert.equal((await P(buyer, `/api/deliveries/${id}/documents`, { type: 'challan', note: 'DC-2291', attachments: [{ name: 'challan.pdf', data: PDF }] })).status, 200);
  assert.ok((await G(site, '/api/notifications')).data.items.some(n => n.type === 'delivery_document' && /Delivery challan sent to site/.test(n.message)), 'site team told about the challan');
  assert.equal((await P(outsider, `/api/deliveries/${id}/documents`, { type: 'signed_challan', attachments: [{ name: 's.png', data: PNG }] })).status, 403);
  // optional doc from site
  assert.equal((await P(site, `/api/deliveries/${id}/documents`, { type: 'weighbridge', attachments: [{ name: 'w.png', data: PNG }] })).status, 200);
  let n = (await G(buyer, '/api/notifications')).data.items.filter(x => x.type === 'delivery_document');
  assert.ok(n.some(x => /Weighbridge slip received from site/.test(x.message) && !/All required/.test(x.message)));
  d = await one(buyer, id);
  assert.deepEqual(d.files.filter(f => f.kind === 'document').map(f => f.doc_type).sort(), ['challan', 'weighbridge']);
  assert.equal(d.files.find(f => f.doc_type === 'challan').note, 'DC-2291');

  // ---- documents-pending reminder after unloading, until the signed challan is in
  await P(site, `/api/deliveries/${id}/proof`, { stage: 'delivered', attachments: [{ name: 'a.png', data: PNG }] });
  await P(site, `/api/deliveries/${id}/proof`, { stage: 'unloaded', attachments: [{ name: 'b.png', data: PNG }] });
  const D = futureDate(1);
  await P(admin, '/api/tasks/send-reminders-now', { at: `${D}T15:05:00+05:30` });
  let rem = (await G(site, '/api/notifications')).data.items.filter(x => x.type === 'delivery_reminder');
  assert.equal(rem.length, 1); assert.match(rem[0].message, /^Documents pending: "Cement 50 bags".*signed \/ stamped challan/);
  // the from-site required doc completes the set → office told "all required documents are in"
  const up = await P(site2, `/api/deliveries/${id}/documents`, { type: 'signed_challan', attachments: [{ name: 'signed.png', data: PNG }] });
  assert.equal(up.status, 200, JSON.stringify(up.data));
  n = (await G(buyer, '/api/notifications')).data.items.filter(x => x.type === 'delivery_document');
  assert.ok(n.some(x => /Signed \/ stamped challan received from site.*All required documents from site are in/.test(x.message)));
  await P(admin, '/api/tasks/send-reminders-now', { at: `${D}T18:05:00+05:30` });
  rem = (await G(site, '/api/notifications')).data.items.filter(x => x.type === 'delivery_reminder');
  const firstId = (await G(site, '/api/notifications')).data.items.filter(x => x.type === 'delivery_reminder')[0].id;
  assert.equal(rem.length, 1); assert.equal(rem[0].id, firstId, 'no new documents reminder once all required docs are in');
  // remove a document: uploader or purchase; not photo proof
  d = await one(buyer, id);
  const wb = d.files.find(f => f.doc_type === 'weighbridge');
  assert.equal((await P(site2, `/api/deliveries/${id}/files/${wb.id}/delete`)).status, 403, 'not the uploader');
  assert.equal((await P(site, `/api/deliveries/${id}/files/${wb.id}/delete`)).status, 200);
  const proof = d.files.find(f => f.kind === 'delivery_proof');
  assert.equal((await P(buyer, `/api/deliveries/${id}/files/${proof.id}/delete`)).status, 400, 'photo proof stays');

  // ---- after unloading purchase can still change budget + required docs, but nothing else
  assert.equal((await P(buyer, `/api/deliveries/${id}/update`, { budget_amount: 1500, driver_name: 'Late edit' })).status, 400, 'other details are locked');
  assert.equal((await P(buyer, `/api/deliveries/${id}/update`, { budget_amount: 1500, required_docs: ['challan', 'signed_challan', 'grn'] })).status, 200);
  d = await one(buyer, id);
  assert.equal(d.budget_amount, 1500); assert.deepEqual(d.required_docs, ['challan', 'signed_challan', 'grn']); assert.notEqual(d.driver_name, 'Late edit');

  // ---- payments
  assert.equal((await P(outsider, `/api/deliveries/${id}/payments`, { amount: 100, purpose: 'Other', attachments: [{ name: 'b.png', data: PNG }] })).status, 403);
  assert.equal((await P(site, `/api/deliveries/${id}/payments`, { amount: 0, purpose: 'Other', attachments: [{ name: 'b.png', data: PNG }] })).status, 400);
  assert.equal((await P(site, `/api/deliveries/${id}/payments`, { amount: 100, purpose: 'Snacks', attachments: [{ name: 'b.png', data: PNG }] })).status, 400, 'purpose from the list');
  assert.equal((await P(site, `/api/deliveries/${id}/payments`, { amount: 100, purpose: 'Other', attachments: [] })).status, 400, 'bill or a reason required');
  const p1 = await P(site, `/api/deliveries/${id}/payments`, { amount: 850, purpose: 'Porter / transport fare', mode: 'UPI', paid_to: 'Porter driver', paid_at: D, attachments: [{ name: 'bill.png', data: PNG }] });
  assert.equal(p1.status, 200, JSON.stringify(p1.data)); assert.equal(p1.data.paid, 850); assert.equal(p1.data.balance, 650); assert.equal(p1.data.overBudget, false);
  const p2 = await P(site2, `/api/deliveries/${id}/payments`, { amount: 900.5, purpose: 'Unloading labour', mode: 'Cash', no_bill_reason: 'labourers paid cash, no receipt' });
  assert.equal(p2.status, 200, JSON.stringify(p2.data)); assert.equal(p2.data.paid, 1750.5); assert.equal(p2.data.balance, -250.5); assert.equal(p2.data.overBudget, true);
  n = (await G(buyer, '/api/notifications')).data.items.filter(x => x.type === 'delivery_payment');
  assert.ok(n.some(x => /over by ₹250\.5/.test(x.message) && /no bill/.test(x.message)), JSON.stringify(n.map(x => x.message)));
  d = await one(site, id);
  assert.equal(d.paid, 1750.5); assert.equal(d.balance, -250.5); assert.equal(d.payments.length, 2);
  const pay1 = d.payments.find(x => x.id === p1.data.id), pay2 = d.payments.find(x => x.id === p2.data.id);
  assert.equal(pay1.bills.length, 1); assert.equal(pay2.bills.length, 0); assert.equal(pay2.no_bill_reason, 'labourers paid cash, no receipt');
  assert.ok(!d.files.some(f => f.kind === 'bill'), 'bills are listed under their payment, not with the documents');
  // Accounts: sees every delivery's payments and bills (read-only)
  const al = (await G(accts, '/api/deliveries')).data;
  assert.equal(al.canManage, false); assert.equal(al.seesAll, true);
  assert.ok(al.items.some(x => x.id === id && x.payments.length === 2));
  assert.equal((await G(accts, `/api/deliveries/${id}/files/${pay1.bills[0].id}`)).status, 200);
  assert.equal((await P(accts, `/api/deliveries/${id}/payments`, { amount: 5, purpose: 'Other', no_bill_reason: 'just testing' })).status, 403, 'accounts cannot record payments');
  assert.ok(!(await G(outsider, '/api/deliveries')).data.items.some(x => x.id === id));
    // bill opens for people on the delivery
  assert.equal((await G(site2, `/api/deliveries/${id}/files/${pay1.bills[0].id}`)).status, 200);
  // delete: payer within 48h, or purchase
  assert.equal((await P(site2, `/api/deliveries/${id}/payments/${p1.data.id}/delete`)).status, 403);
  const raw = await getRawClient(); t.after(() => raw.end());
  await raw.query('UPDATE delivery_payments SET created_at = $1 WHERE id = $2', [new Date(Date.now() - 49 * 3600000).toISOString(), p2.data.id]);
  assert.equal((await P(site2, `/api/deliveries/${id}/payments/${p2.data.id}/delete`)).status, 403, 'too late for the payer');
  assert.equal((await P(buyer, `/api/deliveries/${id}/payments/${p2.data.id}/delete`)).status, 200, 'purchase can');
  assert.equal((await P(site, `/api/deliveries/${id}/payments/${p1.data.id}/delete`)).status, 200, 'payer within 48h');
  d = await one(buyer, id);
  assert.equal(d.paid, 0); assert.equal(d.payments.length, 0);
  const left = await raw.query("SELECT count(*)::int AS n FROM delivery_files WHERE delivery_id = $1 AND kind = 'bill'", [id]);
  assert.equal(left.rows[0].n, 0, 'bill files removed with their payment');

  // ---- cancelled: no payments / documents
  const c2 = (await P(buyer, '/api/deliveries', { title: 'Sand', expected_at: futureDate(2), receivers: ['sachin.b'], required_docs: [] })).data;
  assert.deepEqual((await one(buyer, c2.id)).required_docs, [], 'all documents optional when none ticked');
  await P(buyer, `/api/deliveries/${c2.id}/status`, { status: 'cancelled', reason: 'Order merged' });
  assert.equal((await P(site, `/api/deliveries/${c2.id}/payments`, { amount: 10, purpose: 'Other', no_bill_reason: 'test reason' })).status, 400);
  assert.equal((await P(buyer, `/api/deliveries/${c2.id}/documents`, { type: 'po', attachments: [{ name: 'p.pdf', data: PDF }] })).status, 400);
});
