const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('allotted money: Director allots, site person pays with bills, Director verifies; balance and statement', async (t) => {
  const { baseUrl, stop } = await startTestServer();
  t.after(stop);
  const admin = await login(baseUrl, 'admin', 'admin123');
  const P = (tok, path, body) => api(baseUrl, path, { method: 'POST', token: tok, body });
  const G = (tok, path) => api(baseUrl, path, { token: tok });
  // a Director
  assert.equal((await P(admin, '/api/users', { username: 'ved.d', name: 'Vedant Director', role: 'director', team: 'Management', password: 'Pass@1234' })).status, 200);
  const dir = await login(baseUrl, 'ved.d', 'Pass@1234');
  const site = await createMember(baseUrl, admin, 'rahul.a', 'Rahul Site', 'Execution Department');
  const other = await createMember(baseUrl, admin, 'neha.a', 'Neha Other', 'Execution Department');
  const accts = await createMember(baseUrl, admin, 'asha.a', 'Asha Accounts', 'Accounts');
  const buyer = await createMember(baseUrl, admin, 'tanu.a', 'Tanu Purchase', 'Purchase Department');
  const nots = async (tok, type) => (await G(tok, '/api/notifications')).data.items.filter(n => n.type === type);

  // only Director / Admin allot
  assert.equal((await P(site, '/api/budget/allot', { username: 'rahul.a', amount: 1000 })).status, 403);
  assert.equal((await P(buyer, '/api/budget/allot', { username: 'rahul.a', amount: 1000 })).status, 403);
  assert.equal((await P(dir, '/api/budget/allot', { username: 'nobody.x', amount: 1000 })).status, 400);
  assert.equal((await P(dir, '/api/budget/allot', { username: 'rahul.a', amount: 0 })).status, 400);
  const a1 = await P(dir, '/api/budget/allot', { username: 'rahul.a', amount: 5000, mode: 'UPI', reference: 'UPI123', note: 'Monthly — October 2026' });
  assert.equal(a1.status, 200, JSON.stringify(a1.data)); assert.equal(a1.data.balance, 5000);
  assert.ok((await nots(site, 'budget_allotted')).some(n => /allotted you ₹5,000/.test(n.message)));

  // no allotment → cannot record a payment that is not for a delivery
  assert.equal((await P(other, '/api/budget/payments', { amount: 100, purpose: 'Other', paid_to: 'x', no_bill_reason: 'cash, no receipt' })).status, 403);

  // the holder pays (not for a delivery) with a bill, and one without a bill
  const p1 = await P(site, '/api/budget/payments', { amount: 1200, purpose: 'Porter / transport fare', paid_to: 'Porter Suresh', mode: 'UPI', attachments: [{ name: 'bill.png', data: PNG }] });
  assert.equal(p1.status, 200, JSON.stringify(p1.data)); assert.equal(p1.data.wallet, 3800);
  const p2 = await P(site, '/api/budget/payments', { amount: 300, purpose: 'Unloading labour', paid_to: '2 labourers', mode: 'Cash', no_bill_reason: 'paid cash, no receipt' });
  assert.equal(p2.data.wallet, 3500);
  // ... and one for a delivery they are on
  const d = (await P(buyer, '/api/deliveries', { title: 'Cement 50 bags', expected_at: futureDate(1), receivers: ['rahul.a'] })).data;
  const p3 = await P(site, '/api/budget/payments', { delivery_id: d.id, amount: 700, purpose: 'Porter / transport fare', paid_to: 'Porter', attachments: [{ name: 'b.png', data: PNG }] });
  assert.equal(p3.status, 200, JSON.stringify(p3.data)); assert.equal(p3.data.wallet, 2800);
  assert.equal((await P(other, '/api/budget/payments', { delivery_id: d.id, amount: 5, purpose: 'Other', no_bill_reason: 'not on it really' })).status, 403, 'not on that delivery');
  // the Director (who allotted) is asked to verify
  const tv = await nots(dir, 'budget_verify');
  assert.equal(tv.length, 3);
  assert.ok(tv.some(n => /NO BILL/.test(n.message)) && tv.some(n => /DLV-/.test(n.message)) && tv.some(n => /balance: ₹2,800/.test(n.message)));

  // views: Director sees everyone; holder sees own; Accounts read-only; others nothing
  const bd = (await G(dir, '/api/budget')).data;
  assert.equal(bd.canAllot, true); assert.equal(bd.canVerify, true); assert.equal(bd.seesAll, true);
  const h = bd.holders.find(x => x.username === 'rahul.a');
  assert.equal(h.allotted, 5000); assert.equal(h.paid, 2200); assert.equal(h.pending, 2200); assert.equal(h.balance, 2800); assert.equal(h.noBill, 1);
  const bs = (await G(site, '/api/budget')).data;
  assert.equal(bs.canAllot, false); assert.equal(bs.payments.length, 3); assert.equal(bs.allotments.length, 1);
  assert.equal((await G(accts, '/api/budget')).data.seesAll, true);
  assert.equal((await P(accts, `/api/budget/payments/${p1.data.id}/verify`, { status: 'verified' })).status, 403, 'Accounts cannot verify');
  const bo = (await G(other, '/api/budget')).data;
  assert.equal(bo.payments.length, 0); assert.equal(bo.allotments.length, 0);
  // bills
  const bill = bs.payments.find(p => p.id === p1.data.id).bills[0];
  assert.equal((await G(dir, `/api/budget/bills/${bill.id}`)).status, 200);
  assert.equal((await G(site, `/api/budget/bills/${bill.id}`)).status, 200);
  assert.equal((await G(other, `/api/budget/bills/${bill.id}`)).status, 403);

  // verify / question / not accepted
  assert.equal((await P(site, `/api/budget/payments/${p1.data.id}/verify`, { status: 'verified' })).status, 403, 'cannot verify yourself');
  assert.equal((await P(dir, `/api/budget/payments/${p1.data.id}/verify`, { status: 'verified' })).status, 200);
  assert.ok((await nots(site, 'budget_verified')).some(n => /verified your payment of ₹1,200/.test(n.message)));
  assert.equal((await P(dir, `/api/budget/payments/${p2.data.id}/verify`, { status: 'query' })).status, 400, 'question needs text');
  assert.equal((await P(dir, `/api/budget/payments/${p2.data.id}/verify`, { status: 'query', note: 'Which labourers? Get a signed slip.' })).status, 200);
  assert.ok((await nots(site, 'budget_verified')).some(n => /question about your payment of ₹300/.test(n.message)));
  // holder answers with a slip → back to the verifier
  assert.equal((await P(other, `/api/budget/payments/${p2.data.id}/reply`, { note: 'x' })).status, 403);
  assert.equal((await P(site, `/api/budget/payments/${p2.data.id}/reply`, { note: 'Ramu and Shyam, slip attached', attachments: [{ name: 'slip.png', data: PNG }] })).status, 200);
  let mine = (await G(site, '/api/budget')).data.payments.find(p => p.id === p2.data.id);
  assert.equal(mine.verify_status, 'pending'); assert.equal(mine.reply_note, 'Ramu and Shyam, slip attached'); assert.equal(mine.bills.length, 1);
  assert.ok((await nots(dir, 'budget_verify')).some(n => /To verify again/.test(n.message)));
  // not accepted → not counted; the money stays with the person
  assert.equal((await P(dir, `/api/budget/payments/${p3.data.id}/verify`, { status: 'rejected', note: 'Porter was paid by the vendor' })).status, 200);
  const h2 = (await G(dir, '/api/budget')).data.holders.find(x => x.username === 'rahul.a');
  assert.equal(h2.verified, 1200); assert.equal(h2.pending, 300); assert.equal(h2.rejected, 700); assert.equal(h2.balance, 3500);
  assert.equal((await G(buyer, '/api/deliveries')).data.items.find(x => x.id === d.id).paid, 0, 'not accepted payment not counted on the delivery');
  // verified payments can only be removed by Director / Admin
  assert.equal((await P(site, `/api/budget/payments/${p1.data.id}/delete`)).status, 403);

  // top-up request → Director; then top-up; return of unused money
  const tr = await P(site, '/api/budget/request-topup', { amount: 3000, note: 'Three deliveries this week' });
  assert.equal(tr.status, 200, JSON.stringify(tr.data)); assert.deepEqual(tr.data.sentTo, ['ved.d']);
  assert.ok((await nots(dir, 'budget_topup')).some(n => /needs ₹3,000/.test(n.message)));
  assert.equal((await P(site, '/api/budget/request-topup', { amount: 3000 })).status, 429, 'not again within 10 minutes');
  assert.equal((await P(dir, '/api/budget/allot', { username: 'rahul.a', amount: 3000, note: 'Top-up' })).data.balance, 6500);
  assert.equal((await P(dir, '/api/budget/allot', { username: 'rahul.a', kind: 'return', amount: 99999 })).status, 400, 'cannot return more than the balance');
  assert.equal((await P(dir, '/api/budget/allot', { username: 'rahul.a', kind: 'return', amount: 500, mode: 'Cash' })).data.balance, 6000);
  // paying more than the balance shows as own pocket (negative)
  const big = await P(site, '/api/budget/payments', { amount: 6500, purpose: 'Porter / transport fare', paid_to: 'Truck', attachments: [{ name: 'b.png', data: PNG }] });
  assert.equal(big.data.wallet, -500);
  assert.ok((await nots(dir, 'budget_verify')).some(n => /paid from own pocket/.test(n.message)));
  // remove an allotment entry (Director only)
  const al = (await G(dir, '/api/budget')).data.allotments;
  assert.equal((await P(site, `/api/budget/allotments/${al[0].id}/delete`)).status, 403);
  assert.equal((await P(dir, `/api/budget/allotments/${al[al.length - 1].id}/delete`)).status, 200);
  assert.equal((await G(dir, '/api/budget')).data.holders.find(x => x.username === 'rahul.a').balance, 0, 'the 500 return entry removed');
  // deleting a delivery keeps its payments in the statement
  await P(buyer, `/api/deliveries/${d.id}/delete`, {});
  const kept = (await G(dir, '/api/budget')).data.payments.find(p => p.id === p3.data.id);
  assert.ok(kept, 'payment kept'); assert.equal(kept.delivery_id, null); assert.match(kept.delivery_ref, /^DLV-/);
});
