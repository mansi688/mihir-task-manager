const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');

test("Notifications person panel: a person's other open tasks — Admin sees all, others only tasks they are on", async (t) => {
  const { baseUrl, stop } = await startTestServer();
  t.after(stop);
  const admin = await login(baseUrl, 'admin', 'admin123');
  const boss = await createMember(baseUrl, admin, 'boss.x', 'Boss', 'Execution Department');
  await createMember(baseUrl, admin, 'worker.y', 'Worker', 'Execution Department');
  const other = await createMember(baseUrl, admin, 'other.z', 'Other', 'Sales Department');
  const mk = async (tok, title) => (await api(baseUrl, '/api/tasks', { method: 'POST', token: tok, body: { title, deadline: futureDate(), assignedToList: ['worker.y'] } })).data.id;
  const a = await mk(admin, 'Admin task for worker');
  const b = await mk(boss, 'Boss task for worker');
  const G = (tok) => api(baseUrl, '/api/notifications/person/worker.y/open-tasks', { token: tok });
  const ra = await G(admin);
  assert.equal(ra.status, 200);
  assert.ok(ra.data.ids.includes(a) && ra.data.ids.includes(b));
  assert.equal(ra.data.tasks[a].title, 'Admin task for worker'); assert.equal(ra.data.tasks[a].status, 'open');
  const rb = await G(boss);
  assert.deepEqual(rb.data.ids, [b], 'only tasks the viewer created / is on');
  assert.deepEqual((await G(other)).data.ids, []);
});
