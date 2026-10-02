const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');

test('response cache never serves stale or someone else\'s data; /api/sync tracks changes', async (t) => {
  const { baseUrl, stop } = await startTestServer();
  t.after(() => stop());
  const admin = await login(baseUrl, 'admin', 'admin123');
  const a = await createMember(baseUrl, admin, 'cache.a', 'Cache A', 'Site');
  const b = await createMember(baseUrl, admin, 'cache.b', 'Cache B', 'Site');

  const v1 = (await api(baseUrl, '/api/sync', { token: a })).data.v;
  const before = (await api(baseUrl, '/api/tasks/mine', { token: a })).data.length;
  await api(baseUrl, '/api/tasks/mine', { token: a }); // second call is served from cache
  const t1 = await api(baseUrl, '/api/tasks', { method: 'POST', token: admin, body: { title: 'Cache check', deadline: futureDate(3), assignedToList: ['cache.a'] } });
  assert.equal(t1.status, 200);
  const v2 = (await api(baseUrl, '/api/sync', { token: a })).data.v;
  assert.notEqual(v1, v2, 'sync version moves on a write');
  const after = (await api(baseUrl, '/api/tasks/mine', { token: a })).data;
  assert.equal(after.length, before + 1, 'the new task shows immediately, not a cached old list');
  const bList = (await api(baseUrl, '/api/tasks/mine', { token: b })).data;
  assert.ok(!bList.some(x => x.id === t1.data.id), 'B never receives A\'s cached list');
  // a reply (another table) also invalidates
  await api(baseUrl, `/api/tasks/${t1.data.id}/reply`, { method: 'POST', token: a, body: { message: 'seen' } });
  const withReply = (await api(baseUrl, '/api/tasks/mine', { token: a })).data.find(x => x.id === t1.data.id);
  assert.equal(withReply.replies.length, 1);
  // notifications too
  const n1 = (await api(baseUrl, '/api/notifications', { token: a })).data.unread;
  await api(baseUrl, '/api/tasks', { method: 'POST', token: admin, body: { title: 'Another', deadline: futureDate(3), assignedToList: ['cache.a'] } });
  const n2 = (await api(baseUrl, '/api/notifications', { token: a })).data.unread;
  assert.equal(n2, n1 + 1);
  // concurrent identical requests all succeed with the same answer
  const many = await Promise.all(Array.from({ length: 8 }, () => api(baseUrl, '/api/reports/my-dashboard', { token: admin })));
  assert.ok(many.every(r => r.status === 200));
  assert.equal(new Set(many.map(r => JSON.stringify(r.data))).size, 1);
  // role change takes effect immediately (users cache invalidated)
  const r = await api(baseUrl, '/api/users/cache.b', { method: 'PUT', token: admin, body: { role: 'admin' } }).catch(() => null);
  if (r && r.status === 200) assert.equal((await api(baseUrl, '/api/tasks', { token: b })).status, 200);
});

test('phone-app device token: reads only that person\'s new notifications, and dies on password change', async (t) => {
  const { baseUrl, stop } = await startTestServer();
  t.after(() => stop());
  const admin = await login(baseUrl, 'admin', 'admin123');
  const tok = await createMember(baseUrl, admin, 'phone.u', 'Phone User', 'Site');
  const reg = await api(baseUrl, '/api/device/register', { method: 'POST', token: tok });
  assert.equal(reg.status, 200);
  const dev = reg.data.deviceToken;
  const poll = (after) => fetch(`${baseUrl}/api/device/notifications?after=${after}`, { headers: { Authorization: 'Device ' + dev } }).then(async r => ({ status: r.status, data: await r.json() }));
  assert.equal((await poll(reg.data.latestId)).data.items.length, 0);
  await api(baseUrl, '/api/tasks', { method: 'POST', token: admin, body: { title: 'Ping my phone', deadline: futureDate(2), assignedToList: ['phone.u'] } });
  const p1 = await poll(reg.data.latestId);
  assert.equal(p1.data.items.length, 1); assert.match(p1.data.items[0].message, /Ping my phone/);
  assert.equal((await poll(p1.data.latestId)).data.items.length, 0, 'already-seen ones are not repeated');
  // the device token is useless for anything else
  assert.equal((await api(baseUrl, '/api/tasks/mine', { token: dev })).status, 401);
  // "log out everywhere" (and any password change/reset — same token_version) signs the phone out
  const out = await api(baseUrl, '/api/auth/logout-everywhere', { method: 'POST', token: tok });
  assert.equal(out.status, 200);
  assert.equal((await poll(0)).status, 401);
});
