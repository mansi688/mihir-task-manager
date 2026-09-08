const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');

test('checking for a not-yet-generated report returns 200 (not a console-alarming 404)', async (t) => {
  const { baseUrl, stop } = startTestServer();
  t.after(() => stop());
  const adminToken = await login(baseUrl, 'admin', 'admin123');
  await createMember(baseUrl, adminToken, 'bob', 'Bob');

  const create = await api(baseUrl, '/api/tasks', { method: 'POST', token: adminToken, body: { title: 'Report Check Test', priority: 'low', deadline: futureDate(), assignedToList: ['bob'] } });
  await api(baseUrl, `/api/tasks/${create.data.id}/close`, { method: 'POST', token: adminToken });

  const beforeGenerate = await api(baseUrl, `/api/reports/task/${create.data.id}`, { token: adminToken });
  assert.equal(beforeGenerate.status, 200, 'checking before generating must be a normal 200, not a 404 — this is expected, routine state, not an error');
  assert.equal(beforeGenerate.data.generated, false);

  await api(baseUrl, `/api/reports/task/${create.data.id}/generate`, { method: 'POST', token: adminToken });
  const afterGenerate = await api(baseUrl, `/api/reports/task/${create.data.id}`, { token: adminToken });
  assert.equal(afterGenerate.status, 200);
  assert.equal(afterGenerate.data.generated, true);
  assert.equal(afterGenerate.data.title, 'Report Check Test');
});
