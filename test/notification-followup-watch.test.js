const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');

test('people only mentioned or kept informed can open the task; Follow up from notifications with re-follow-up', async (t) => {
  const { baseUrl, stop, getRawClient } = await startTestServer();
  t.after(stop);
  const admin = await login(baseUrl, 'admin', 'admin123');
  const priya = await createMember(baseUrl, admin, 'priya.w', 'Priya Creator', 'Site');
  const ravi = await createMember(baseUrl, admin, 'ravi.w', 'Ravi Kumar', 'Site');
  const asha = await createMember(baseUrl, admin, 'asha.w', 'Asha Shah', 'Site');
  const kiran = await createMember(baseUrl, admin, 'kiran.w', 'Kiran B', 'Site');
  const P = (tok, path, body) => api(baseUrl, path, { method: 'POST', token: tok, body });
  const G = (tok, path) => api(baseUrl, path, { token: tok });
  const id = (await P(priya, '/api/tasks', { title: 'Shuttering check', priority: 'high', deadline: futureDate(3), assignedToList: ['ravi.w'] })).data.id;

  // Before: Asha is not on the task → cannot open it
  assert.equal((await G(asha, `/api/tasks/${id}`)).status, 403);
  // Mentioned in a comment → notified AND added to "Keep informed", so the task opens for her
  assert.equal((await P(priya, `/api/tasks/${id}/reply`, { message: 'Please check the plates @asha.w' })).status, 200);
  const an = (await G(asha, '/api/notifications')).data;
  assert.ok(an.items.some(n => n.type === 'mentioned_in_comment' && n.task_id === id));
  assert.equal((await G(asha, `/api/tasks/${id}`)).status, 200, 'the task opens for the mentioned person');
  assert.ok((await G(asha, '/api/tasks/watching')).data.some(x => x.id === id), 'listed under Kept informed');
  assert.ok(!(await G(asha, '/api/tasks/mine')).data.some(x => x.id === id), 'not counted as her own work');
  // Keep someone informed → listed for them too
  assert.equal((await P(priya, `/api/tasks/${id}/followup`, { usernames: ['kiran.w'] })).status, 200);
  assert.ok((await G(kiran, '/api/tasks/watching')).data.some(x => x.id === id));
  // The assignee does not see it under "watching" (it is already in My Tasks)
  assert.ok(!(await G(ravi, '/api/tasks/watching')).data.some(x => x.id === id));

  // Notifications carry each task's status and my last follow-up
  assert.equal(an.tasks[id].status, 'open'); assert.equal(an.tasks[id].followedUpAt, null);
  const f1 = await P(asha, `/api/tasks/${id}/nudge`);
  assert.equal(f1.status, 200, JSON.stringify(f1.data));
  assert.ok(f1.data.sent.includes('ravi.w'));
  assert.ok((await G(asha, '/api/notifications')).data.tasks[id].followedUpAt, 'button turns grey: followed up at …');
  assert.equal((await P(asha, `/api/tasks/${id}/nudge`)).status, 429, 'right away again is held back (everyone was just told)');
  // Later (next reminder slot) — follow up again is allowed
  const raw = await getRawClient(); t.after(() => raw.end());
  await raw.query("UPDATE notification_deliveries SET sent_at = sent_at - interval '3 hours', idempotency_key = idempotency_key || ':earlier' WHERE notification_type='follow_up'");
  assert.equal((await P(asha, `/api/tasks/${id}/nudge`)).status, 200, 're-follow-up allowed later');
});
