const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');

test('notifications are marked seen in batches, with the time they were seen', async (t) => {
  const { baseUrl, stop } = await startTestServer();
  t.after(stop);
  const admin = await login(baseUrl, 'admin', 'admin123');
  const ravi = await createMember(baseUrl, admin, 'ravi', 'Ravi Kumar', 'Site');
  const asha = await createMember(baseUrl, admin, 'asha', 'Asha Shah', 'Site');
  for (const title of ['Pour slab', 'Order cement', 'Check scaffolding']) {
    const r = await api(baseUrl, '/api/tasks', { method: 'POST', token: admin, body: { title, priority: 'medium', deadline: futureDate(3), assignedToList: ['ravi', 'asha'] } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  const list = async (tok) => (await api(baseUrl, '/api/notifications', { token: tok })).data;
  const mine = await list(ravi);
  assert.ok(mine.unread >= 3); assert.ok(mine.items.every(n => !n.read && !n.read_at));
  const ids = mine.items.slice(0, 2).map(n => n.id);

  const r = await api(baseUrl, '/api/notifications/read', { method: 'POST', token: ravi, body: { ids } });
  assert.equal(r.status, 200); assert.equal(r.data.unread, mine.unread - 2);
  const after = await list(ravi);
  for (const id of ids) { const n = after.items.find(x => x.id === id); assert.equal(n.read, 1); assert.ok(n.read_at && !Number.isNaN(Date.parse(n.read_at)), 'seen time recorded'); }
  const firstSeen = after.items.find(x => x.id === ids[0]).read_at;

  // seeing it again keeps the first time
  await api(baseUrl, `/api/notifications/${ids[0]}/read`, { method: 'POST', token: ravi });
  assert.equal((await list(ravi)).items.find(x => x.id === ids[0]).read_at, firstSeen);

  // someone else's notifications cannot be marked
  const ashaIds = (await list(asha)).items.map(n => n.id);
  await api(baseUrl, '/api/notifications/read', { method: 'POST', token: ravi, body: { ids: ashaIds } });
  assert.ok((await list(asha)).items.every(n => !n.read), "Ravi can't mark Asha's");

  assert.equal((await api(baseUrl, '/api/notifications/read', { method: 'POST', token: ravi, body: {} })).status, 400);
  await api(baseUrl, '/api/notifications/read-all', { method: 'POST', token: ravi });
  const done = await list(ravi);
  assert.equal(done.unread, 0); assert.ok(done.items.every(n => n.read && n.read_at));
});
