const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');

test('Dnyaneshwar Kolekar is kept informed on every project task', async (t) => {
  const { baseUrl, stop } = await startTestServer();
  t.after(() => stop());
  const admin = await login(baseUrl, 'admin', 'admin123');
  const dk = await createMember(baseUrl, admin, 'dnyaneshwar.k', 'Dnyaneshwar Kolekar', 'Senior management');
  const eng = await createMember(baseUrl, admin, 'ai.eng', 'Eng', 'Execution Department');
  const mk = (body) => api(baseUrl, '/api/tasks', { method: 'POST', token: eng, body: { deadline: futureDate(2), assignedToList: ['ai.eng'], ...body } });
  for (const project of ['Mihir Amara', 'Nyati Equinox']) {
    const r = await mk({ title: `Slab on ${project}`, project });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const task = (await api(baseUrl, `/api/tasks/${r.data.id}`, { token: admin })).data;
    assert.ok((task.followups || []).some(f => (f.username || f) === 'dnyaneshwar.k'), project + ' ' + JSON.stringify(task.followups));
  }
  const own = await api(baseUrl, '/api/tasks', { method: 'POST', token: dk, body: { title: 'His own', project: 'Mihir Amara', deadline: futureDate(2), assignedToList: ['ai.eng'] } });
  assert.ok(!(await api(baseUrl, `/api/tasks/${own.data.id}`, { token: admin })).data.followups.some(f => f.username === 'dnyaneshwar.k'), 'not on his own task');
  assert.ok((await api(baseUrl, '/api/notifications', { token: dk })).data.items.some(n => /kept informed on every project task/.test(n.message)));
});
