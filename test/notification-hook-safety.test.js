const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');

test('the notification hook (push/WhatsApp dispatch) never disrupts normal task operations', async (t) => {
  const { baseUrl, stop } = startTestServer();
  t.after(() => stop());
  const adminToken = await login(baseUrl, 'admin', 'admin123');
  const bobToken = await createMember(baseUrl, adminToken, 'bob', 'Bob');

  // Give bob a phone number, exercising the WhatsApp dispatch code path on every notification he
  // receives from here on — with no WHATSAPP_TOKEN configured in this test environment, this
  // should silently no-op rather than error or slow anything down meaningfully.
  await api(baseUrl, '/api/auth/update-phone', { method: 'POST', token: bobToken, body: { phone: '+919876543210' } });

  const start = Date.now();
  const create = await api(baseUrl, '/api/tasks', { method: 'POST', token: adminToken, body: { title: 'Hook Safety Test', priority: 'medium', deadline: futureDate(), assignedToList: ['bob'] } });
  assert.equal(create.status, 200, 'creating a task (which notifies bob, who has a phone on file) must still succeed normally');

  const submit = await api(baseUrl, `/api/tasks/${create.data.id}/submit-mine`, { method: 'POST', token: bobToken, body: { note: 'Fully done here.' } });
  assert.equal(submit.status, 200);

  const approve = await api(baseUrl, `/api/tasks/${create.data.id}/approve/bob`, { method: 'POST', token: adminToken });
  assert.equal(approve.status, 200);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 5000, `a few ordinary task operations with dispatch attempts on every notification should still be fast — took ${elapsed}ms`);

  const stillAlive = await api(baseUrl, '/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
  assert.equal(stillAlive.status, 200, 'the server must remain fully healthy after every dispatch attempt');
});
