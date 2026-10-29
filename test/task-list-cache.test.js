const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');

test('Task lists stay cached when only notifications change, and refresh when task data changes', async (t) => {
  const { baseUrl, stop } = await startTestServer();
  t.after(stop);
  const admin = await login(baseUrl, 'admin', 'admin123');
  const a = await createMember(baseUrl, admin, 'big.user', 'Big User', 'Estimation');
  const x = (await api(baseUrl, '/api/tasks', { method: 'POST', token: admin, body: { title: 'Cache me', deadline: futureDate(3), assignedToList: ['big.user'] } })).data;
  const cacheOf = async (path) => (await fetch(baseUrl + path, { headers: { Authorization: `Bearer ${a}` } })).headers.get('x-cache');
  await cacheOf('/api/tasks/mine');
  assert.equal(await cacheOf('/api/tasks/mine'), 'hit');
  await cacheOf('/api/tasks/watching');
  assert.equal(await cacheOf('/api/tasks/watching'), 'hit', 'Kept informed list is cached too');
  // marking notifications seen (a write elsewhere) does not throw the task list away
  const n = (await api(baseUrl, '/api/notifications', { token: a })).data.items;
  assert.ok(n.length);
  await api(baseUrl, '/api/notifications/read', { method: 'POST', token: a, body: { ids: n.map(i => i.id) } });
  assert.equal(await cacheOf('/api/tasks/mine'), 'hit', 'still cached after a notification write');
  // …but a comment on the task does
  await api(baseUrl, `/api/tasks/${x.id}/reply`, { method: 'POST', token: admin, body: { message: 'update' } });
  assert.notEqual(await cacheOf('/api/tasks/mine'), 'hit');
  const mine = (await api(baseUrl, '/api/tasks/mine', { token: a })).data.find(y => y.id === x.id);
  assert.equal(mine.replies.length, 1, 'the new comment is there');
});
