// "Keep informed" people (often senior management) see the task but are never chased by 📣 Follow up.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');

test('kept-informed people see the task but get no follow-up', async (t) => {
  const { baseUrl, stop } = await startTestServer();
  t.after(() => stop());
  const admin = await login(baseUrl, 'admin', 'admin123');
  const eng = await createMember(baseUrl, admin, 'ki.eng', 'KI Eng', 'Execution Department');
  const doer = await createMember(baseUrl, admin, 'ki.doer', 'KI Doer', 'Execution Department');
  const boss = await createMember(baseUrl, admin, 'ki.boss', 'KI Boss', 'Senior Management');
  const tk = await api(baseUrl, '/api/tasks', { method: 'POST', token: eng, body: { title: 'Pour slab', deadline: futureDate(3), assignedToList: ['ki.doer'] } });
  assert.equal(tk.status, 200, JSON.stringify(tk.data));
  const id = tk.data.id;
  assert.equal((await api(baseUrl, `/api/tasks/${id}/followup`, { method: 'POST', token: eng, body: { usernames: ['ki.boss'] } })).status, 200);
  const bossNotes = (await api(baseUrl, '/api/notifications', { token: boss })).data.items;
  const tag = bossNotes.find(n => n.type === 'followup_tagged');
  assert.match(tag.message, /keeping you informed/);
  assert.equal((await api(baseUrl, `/api/tasks/${id}`, { token: boss })).status, 200, 'they can open the task');
  const r = await api(baseUrl, `/api/tasks/${id}/nudge`, { method: 'POST', token: eng });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.sent, ['ki.doer']);
  const after = (await api(baseUrl, '/api/notifications', { token: boss })).data.items;
  assert.ok(!after.some(n => n.type === 'follow_up'), 'senior management is not chased');
  void doer;
});
