const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember } = require('../testlib/helpers');

test('Compliance due dates: seeded list, access, reminders 10 and 2 days before to Accounts + Admin, done stops them', async (t) => {
  const { baseUrl, stop } = await startTestServer();
  t.after(stop);
  const admin = await login(baseUrl, 'admin', 'admin123');
  const P = (tok, path, body) => api(baseUrl, path, { method: 'POST', token: tok, body });
  const G = (tok, path) => api(baseUrl, path, { token: tok });
  const acc = await createMember(baseUrl, admin, 'niraj.a', 'Niraj Accounts', 'Accounts Department');
  const pur = await createMember(baseUrl, admin, 'tanu.p', 'Tanu Purchase', 'Purchase Department');
  const sales = await createMember(baseUrl, admin, 'sales.x', 'Sales Person', 'Sales Department');
  const nots = async (tok) => (await G(tok, '/api/notifications')).data.items.filter(n => n.type === 'compliance_due');

  // seeded from Sachin's list, GST on the 20th
  const r = await G(acc, '/api/compliance');
  assert.equal(r.status, 200);
  const by = Object.fromEntries(r.data.items.map(i => [i.name, i]));
  assert.deepEqual(Object.fromEntries(Object.entries(by).map(([k, v]) => [k, v.due_day])),
    { 'TDS deposit': 7, 'GST deposit': 20, 'Sales invoices': 5, 'Electricity bill': 10, 'PT (Professional Tax)': 15, 'PF (Provident Fund)': 15 });
  assert.deepEqual(r.data.remindBefore, [10, 2]);
  assert.ok(r.data.items.every(i => i.days_left >= 0), 'nothing is overdue on the day it is set up');
  // access: Accounts + Admin only
  assert.equal((await G(pur, '/api/compliance')).status, 403);
  assert.equal((await G(sales, '/api/compliance')).status, 403);
  assert.equal((await G(admin, '/api/compliance')).status, 200);
  assert.equal((await P(pur, '/api/compliance', { name: 'X', due_day: 3 })).status, 403);

  // add / edit / remove
  assert.equal((await P(acc, '/api/compliance', { name: 'ESIC', due_day: 40 })).status, 400);
  const esic = await P(acc, '/api/compliance', { name: 'ESIC', due_day: 15 });
  assert.equal(esic.status, 200);
  assert.equal((await P(acc, `/api/compliance/${esic.data.id}/update`, { name: 'ESIC deposit', due_day: 21 })).status, 200);
  assert.equal((await P(acc, `/api/compliance/${esic.data.id}/delete`)).status, 200);
  assert.ok(!(await G(acc, '/api/compliance')).data.items.some(i => /ESIC/.test(i.name)));

  // make the next month the live one for every item (whatever today's date is), then simulate days in it
  const realMonth = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 7);
  for (const i of (await G(acc, '/api/compliance')).data.items) if (i.period === realMonth) assert.equal((await P(acc, `/api/compliance/${i.id}/done`, { period: i.period })).status, 200);
  const items = (await G(acc, '/api/compliance')).data.items;
  const M = items.find(i => i.name === 'GST deposit').period;
  assert.ok(items.every(i => i.period === M));
  const at = (day) => `${M}-${day}T09:05:00+05:30`;
  const gst = items.find(i => i.name === 'GST deposit'), elec = items.find(i => i.name === 'Electricity bill');

  // 10th: GST (20th) → 10 days left
  await P(admin, '/api/tasks/send-reminders-now', { at: at('10') });
  let n = await nots(acc);
  assert.ok(n.some(x => /GST deposit .* 10 days left/.test(x.message)), JSON.stringify(n.map(x => x.message)));
  assert.ok((await nots(admin)).some(x => /GST deposit/.test(x.message)), 'Admin is reminded too');
  assert.equal((await nots(pur)).length, 0, 'Purchase is not');
  assert.ok(n.some(x => /due TODAY: Electricity bill/.test(x.message)));
  // same day again → no duplicate
  await P(admin, '/api/tasks/send-reminders-now', { at: `${M}-10T15:05:00+05:30` });
  assert.equal((await nots(acc)).filter(x => /GST deposit/.test(x.message)).length, 1);
  // 11th: nothing new for GST (9 days); electricity overdue by 1 day
  await P(admin, '/api/tasks/send-reminders-now', { at: at('11') });
  n = await nots(acc);
  assert.ok(n.some(x => /overdue by 1 day: Electricity bill/.test(x.message)));
  assert.equal(n.filter(x => /Electricity bill/.test(x.message)).length, 1, 'one card per item');
  // marking it done clears the card and stops reminders
  assert.equal((await P(acc, `/api/compliance/${elec.id}/done`, { period: M, note: 'Paid online' })).status, 200);
  assert.ok(!(await nots(acc)).some(x => /Electricity bill/.test(x.message)));
  assert.ok((await G(admin, '/api/notifications')).data.items.some(x => x.type === 'compliance_done' && /Electricity bill .* done\. Paid online/.test(x.message)));
  // 18th: GST 2 days before
  await P(admin, '/api/tasks/send-reminders-now', { at: at('18') });
  assert.ok((await nots(acc)).some(x => /GST deposit .* due in 2 days/.test(x.message)));
  assert.ok(!(await nots(acc)).some(x => /Electricity bill/.test(x.message)));

  // a different due date for one month (e.g. the date on the electricity bill)
  const next = (await G(acc, '/api/compliance')).data.items.find(i => i.id === elec.id);
  assert.notEqual(next.period, M, 'done → next month is live');
  assert.equal((await P(acc, `/api/compliance/${elec.id}/due-date`, { period: next.period, due_date: `${next.period}-25` })).status, 200);
  const e2 = (await G(acc, '/api/compliance')).data.items.find(i => i.id === elec.id);
  assert.equal(e2.due, `${next.period}-25`); assert.equal(e2.override, true);
  // undo done
  assert.equal((await P(acc, `/api/compliance/${gst.id}/undone`, { period: M })).status, 200);
});
