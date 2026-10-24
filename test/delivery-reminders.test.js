const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('delivery reminders at the slots (one card per delivery) and delivery follow-up', async (t) => {
  const { baseUrl, stop, getRawClient } = await startTestServer();
  t.after(stop);
  const admin = await login(baseUrl, 'admin', 'admin123');
  const buyer = await createMember(baseUrl, admin, 'tanu.r', 'Tanu Purchase', 'Purchase Department');
  const site = await createMember(baseUrl, admin, 'sachin.r', 'Sachin Site', 'Execution Department');
  const P = (tok, path, body) => api(baseUrl, path, { method: 'POST', token: tok, body });
  const G = (tok, path) => api(baseUrl, path, { token: tok });
  const D = futureDate(1);
  const at = (hhmm) => `${D}T${hhmm}:00+05:30`;
  const d = (await P(buyer, '/api/deliveries', { title: 'Cement 50 bags', expected_at: D, receivers: ['sachin.r'] })).data;
  const cards = async () => (await G(site, '/api/notifications')).data.items.filter(n => n.type === 'delivery_reminder');

  await P(admin, '/api/tasks/send-reminders-now', { at: at('12:30') });
  assert.equal((await cards()).length, 0, 'nothing between slots');
  await P(admin, '/api/tasks/send-reminders-now', { at: at('09:05') });
  let c = await cards(); assert.equal(c.length, 1); assert.match(c[0].message, /Delivery due today: "Cement 50 bags"/);
  await P(admin, '/api/tasks/send-reminders-now', { at: at('09:40') });
  assert.equal((await cards()).length, 1, 'same slot → no repeat');
  await P(admin, '/api/tasks/send-reminders-now', { at: at('15:05') });
  assert.equal((await cards()).length, 1, 'next slot replaced the earlier card — one per delivery');
  // delivered → "unloading pending" reminders
  await P(site, `/api/deliveries/${d.id}/proof`, { stage: 'delivered', attachments: [{ name: 'a.png', data: PNG }] });
  await P(admin, '/api/tasks/send-reminders-now', { at: at('18:05') });
  c = await cards(); assert.equal(c.length, 1); assert.match(c[0].message, /^Unloading pending/);

  // Follow up: purchase only; tagged person notified and sees who followed up
  assert.equal((await P(site, `/api/deliveries/${d.id}/followup`)).status, 403);
  const f = await P(buyer, `/api/deliveries/${d.id}/followup`);
  assert.equal(f.status, 200, JSON.stringify(f.data)); assert.deepEqual(f.data.sent, ['sachin.r']);
  assert.ok((await G(site, '/api/notifications')).data.items.some(n => n.type === 'delivery_followup' && /unloading photos/.test(n.message)));
  const seen = (await G(site, '/api/deliveries')).data.items.find(x => x.id === d.id);
  assert.equal(seen.last_followup_by, 'tanu.r'); assert.ok(seen.last_followup_at); assert.equal(seen.followup_count, 1);
  assert.equal((await P(buyer, `/api/deliveries/${d.id}/followup`)).status, 429, 'not twice within 10 minutes');
  const raw = await getRawClient(); t.after(() => raw.end());
  await raw.query("UPDATE deliveries SET last_followup_at = $1 WHERE id = $2", [new Date(Date.now() - 11 * 60000).toISOString(), d.id]);
  assert.equal((await P(buyer, `/api/deliveries/${d.id}/followup`)).status, 200, 'again later');
  assert.equal((await G(site, '/api/deliveries')).data.items.find(x => x.id === d.id).followup_count, 2);
  // finished → no reminders, no follow-up
  await P(site, `/api/deliveries/${d.id}/proof`, { stage: 'unloaded', attachments: [{ name: 'b.png', data: PNG }] });
  assert.equal((await P(buyer, `/api/deliveries/${d.id}/followup`)).status, 400);
});
