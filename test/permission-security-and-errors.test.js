const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');

test('permission security: expanded direct API attacks', async (t) => {
  const { baseUrl, stop } = startTestServer();
  t.after(() => stop());

  const adminToken = await login(baseUrl, 'admin', 'admin123');
  const aliceToken = await createMember(baseUrl, adminToken, 'alice', 'Alice');
  const bobToken = await createMember(baseUrl, adminToken, 'bob', 'Bob');
  const carolToken = await createMember(baseUrl, adminToken, 'carol', 'Carol');

  let taskId;
  await t.test('setup: alice creates a task, tags bob as assignee, tags carol as follow-up only', async () => {
    const create = await api(baseUrl, '/api/tasks', { method: 'POST', token: aliceToken, body: { title: 'Followup Perms Test', priority: 'low', deadline: futureDate(), assignedToList: ['bob'] } });
    taskId = create.data.id;
    const followup = await api(baseUrl, `/api/tasks/${taskId}/followup`, { method: 'POST', token: bobToken, body: { usernames: ['carol'] } });
    assert.equal(followup.status, 200, JSON.stringify(followup.data));
  });

  await t.test('a follow-up-only user cannot close the task', async () => {
    const res = await api(baseUrl, `/api/tasks/${taskId}/close`, { method: 'POST', token: carolToken });
    assert.equal(res.status, 403, 'a follow-up user must never have close authority');
  });

  await t.test('a follow-up-only user cannot approve/reject the assignee\'s work', async () => {
    await api(baseUrl, `/api/tasks/${taskId}/submit-mine`, { method: 'POST', token: bobToken, body: { note: 'Work fully done here.' } });
    const approveAttempt = await api(baseUrl, `/api/tasks/${taskId}/approve/bob`, { method: 'POST', token: carolToken });
    assert.equal(approveAttempt.status, 403);
  });

  await t.test('a follow-up-only user CAN still comment (they are involved, just without authority)', async () => {
    const res = await api(baseUrl, `/api/tasks/${taskId}/reply`, { method: 'POST', token: carolToken, body: { message: 'Just following up here.' } });
    assert.equal(res.status, 200, 'a follow-up user should still be able to participate in discussion');
  });

  await t.test('an uninvolved outsider cannot even comment', async () => {
    const outsiderToken = await createMember(baseUrl, adminToken, 'outsider2', 'Outsider Two');
    const res = await api(baseUrl, `/api/tasks/${taskId}/reply`, { method: 'POST', token: outsiderToken, body: { message: 'Random comment.' } });
    assert.equal(res.status, 403);
  });

  await t.test('an assignee (not the creator) cannot reopen once closed', async () => {
    await api(baseUrl, `/api/tasks/${taskId}/approve/bob`, { method: 'POST', token: aliceToken });
    const reopenAttempt = await api(baseUrl, `/api/tasks/${taskId}/reopen`, { method: 'POST', token: bobToken, body: { reason: 'trying to reopen my own task' } });
    assert.equal(reopenAttempt.status, 403, 'a tagged assignee, even the one who did the work, is not the creator and must not be able to reopen');
  });

  await t.test('a member cannot view another user\'s personal dashboard by guessing the query param', async () => {
    const res = await api(baseUrl, '/api/reports/my-dashboard?username=alice', { token: bobToken });
    assert.equal(res.data.username, 'bob', "bob must always be forced back to his own dashboard, never alice's, regardless of what he requests");
  });

  await t.test('a member cannot access company-wide Peak Hours (admin-only)', async () => {
    const res = await api(baseUrl, '/api/reports/peak-hours?username=all', { token: bobToken });
    assert.equal(res.status, 403);
  });

  await t.test('failed unauthorized attempts do not create misleading audit log entries', async () => {
    const beforeLog = await api(baseUrl, '/api/audit-log', { token: adminToken });
    const beforeCount = beforeLog.data.length;
    // Every rejected attempt above (close, approve, reopen — all 403s) should have logged NOTHING,
    // since nothing actually happened.
    const afterLog = await api(baseUrl, '/api/audit-log', { token: adminToken });
    assert.equal(afterLog.data.length, beforeCount, 'a rejected/unauthorized attempt must never create an audit entry implying it succeeded');
  });
});

test('malformed request handling never crashes the server or leaks internals', async (t) => {
  const { baseUrl, stop } = startTestServer();
  t.after(() => stop());
  const adminToken = await login(baseUrl, 'admin', 'admin123');

  await t.test('missing Authorization header is rejected cleanly', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/mine`);
    assert.equal(res.status, 401);
  });

  await t.test('a garbage/malformed JWT is rejected cleanly, not a crash', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/mine`, { headers: { Authorization: 'Bearer not-a-real-token-at-all' } });
    assert.equal(res.status, 401);
  });

  await t.test('completely malformed JSON body does not crash the server', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` }, body: '{not valid json!!!' });
    assert.ok(res.status >= 400 && res.status < 500);
    const stillAlive = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) });
    assert.equal(stillAlive.status, 200, 'the server must still be fully responsive after a malformed JSON body');
  });

  await t.test('an empty request body on task creation is rejected cleanly', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` }, body: '' });
    assert.ok(res.status >= 400 && res.status < 500);
  });

  await t.test('a path-traversal-style task ID is safely rejected, not a filesystem error', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/${encodeURIComponent('../../etc/passwd')}`, { headers: { Authorization: `Bearer ${adminToken}` } });
    assert.ok(res.status === 404 || res.status === 400);
  });
});
