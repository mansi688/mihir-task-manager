const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');

// These fire genuinely simultaneous requests (Promise.all, not sequential awaits) at the same
// resource, to verify the app's behavior under real concurrent load — not just "call it twice
// in a row." Node's single-threaded event loop plus better-sqlite3's synchronous driver means a
// non-async handler runs start-to-finish with no interleaving, so the expected, verified
// behavior is: exactly one request wins, the other gets a clean rejection, and nothing ends up
// double-processed. This is being verified here, not assumed.
test('concurrency: simultaneous conflicting requests', async (t) => {
  const { baseUrl, stop } = startTestServer();
  t.after(() => stop());

  const adminToken = await login(baseUrl, 'admin', 'admin123');
  const aliceToken = await createMember(baseUrl, adminToken, 'alice', 'Alice');
  const bobToken = await createMember(baseUrl, adminToken, 'bob', 'Bob');

  await t.test('two simultaneous approvals of the same assignee: exactly one succeeds', async () => {
    const create = await api(baseUrl, '/api/tasks', { method: 'POST', token: aliceToken, body: { title: 'Concurrent Approve', priority: 'low', deadline: futureDate(), assignedToList: ['alice', 'bob'] } });
    const id = create.data.id;
    await api(baseUrl, `/api/tasks/${id}/submit-mine`, { method: 'POST', token: bobToken, body: { note: 'Bob is fully done here.' } });

    const [r1, r2] = await Promise.all([
      api(baseUrl, `/api/tasks/${id}/approve/bob`, { method: 'POST', token: aliceToken }),
      api(baseUrl, `/api/tasks/${id}/approve/bob`, { method: 'POST', token: aliceToken }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    assert.deepEqual(statuses, [200, 400], 'exactly one of two simultaneous approvals should succeed, the other cleanly rejected as already-approved');

    const notifs = await api(baseUrl, '/api/notifications', { token: bobToken });
    const approvalNotifs = notifs.data.items.filter(n => n.type === 'task_submitted' || n.message.toLowerCase().includes('approved'));
    assert.ok(approvalNotifs.length <= 1, `bob should get at most one "approved" notification from this, not one per request (got ${approvalNotifs.length})`);
  });

  await t.test('two simultaneous rejections of the same submission: exactly one succeeds', async () => {
    const create = await api(baseUrl, '/api/tasks', { method: 'POST', token: aliceToken, body: { title: 'Concurrent Reject', priority: 'low', deadline: futureDate(), assignedToList: ['bob'] } });
    const id = create.data.id;
    await api(baseUrl, `/api/tasks/${id}/submit-mine`, { method: 'POST', token: bobToken, body: { note: 'First attempt at this work.' } });

    const [r1, r2] = await Promise.all([
      api(baseUrl, `/api/tasks/${id}/reject/bob`, { method: 'POST', token: aliceToken, body: { reason: 'Needs more detail please' } }),
      api(baseUrl, `/api/tasks/${id}/reject/bob`, { method: 'POST', token: aliceToken, body: { reason: 'Needs more detail please' } }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    assert.deepEqual(statuses, [200, 400], 'the second simultaneous reject of an already-reset submission should be cleanly refused, not double-processed');
  });

  await t.test('two simultaneous closes of the same task: exactly one succeeds', async () => {
    const create = await api(baseUrl, '/api/tasks', { method: 'POST', token: aliceToken, body: { title: 'Concurrent Close', priority: 'low', deadline: futureDate(), assignedToList: ['bob'] } });
    const id = create.data.id;

    const [r1, r2] = await Promise.all([
      api(baseUrl, `/api/tasks/${id}/close`, { method: 'POST', token: aliceToken }),
      api(baseUrl, `/api/tasks/${id}/close`, { method: 'POST', token: aliceToken }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    assert.deepEqual(statuses, [200, 400], 'only one simultaneous close should succeed');
  });

  await t.test('two simultaneous reopens of the same task: exactly one succeeds', async () => {
    const create = await api(baseUrl, '/api/tasks', { method: 'POST', token: aliceToken, body: { title: 'Concurrent Reopen', priority: 'low', deadline: futureDate(), assignedToList: ['bob'] } });
    const id = create.data.id;
    await api(baseUrl, `/api/tasks/${id}/close`, { method: 'POST', token: aliceToken });

    const [r1, r2] = await Promise.all([
      api(baseUrl, `/api/tasks/${id}/reopen`, { method: 'POST', token: aliceToken, body: { reason: 'More work needed here' } }),
      api(baseUrl, `/api/tasks/${id}/reopen`, { method: 'POST', token: aliceToken, body: { reason: 'More work needed here' } }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    assert.deepEqual(statuses, [200, 400], 'only one simultaneous reopen should succeed');

    const auditLog = await api(baseUrl, '/api/audit-log', { token: adminToken });
    const reopenEntries = auditLog.data.filter(e => e.action === 'task_reopened' && e.details.includes('Concurrent Reopen'));
    assert.equal(reopenEntries.length, 1, 'exactly one audit entry should exist, not one per simultaneous request');
  });

  await t.test('two simultaneous releases of the same level: exactly one succeeds, no duplicate notifications', async () => {
    const create = await api(baseUrl, '/api/tasks', {
      method: 'POST', token: aliceToken,
      body: { title: 'Concurrent Level Release', priority: 'low', deadline: futureDate(), assignedToList: ['alice', 'bob'], stages: [{ usernames: ['alice'] }, { usernames: ['bob'] }] },
    });
    const id = create.data.id;
    await api(baseUrl, `/api/tasks/${id}/submit-mine`, { method: 'POST', token: aliceToken, body: { note: 'Level 1 fully done.' } });
    await api(baseUrl, `/api/tasks/${id}/approve/alice`, { method: 'POST', token: aliceToken });

    const [r1, r2] = await Promise.all([
      api(baseUrl, `/api/tasks/${id}/release-stage/2`, { method: 'POST', token: aliceToken }),
      api(baseUrl, `/api/tasks/${id}/release-stage/2`, { method: 'POST', token: aliceToken }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    assert.deepEqual(statuses, [200, 400], 'only one simultaneous level release should succeed');

    const bobNotifs = await api(baseUrl, '/api/notifications', { token: bobToken });
    const releaseNotifs = bobNotifs.data.items.filter(n => n.message.toLowerCase().includes('released'));
    assert.equal(releaseNotifs.length, 1, `bob should get exactly one "you're released" notification, not one per simultaneous request (got ${releaseNotifs.length})`);
  });

  await t.test('two simultaneous cancels of the same task: exactly one succeeds', async () => {
    const create = await api(baseUrl, '/api/tasks', { method: 'POST', token: aliceToken, body: { title: 'Concurrent Cancel', priority: 'low', deadline: futureDate(), assignedToList: ['bob'] } });
    const id = create.data.id;

    const [r1, r2] = await Promise.all([
      api(baseUrl, `/api/tasks/${id}/cancel`, { method: 'POST', token: aliceToken, body: { reason: 'No longer needed' } }),
      api(baseUrl, `/api/tasks/${id}/cancel`, { method: 'POST', token: aliceToken, body: { reason: 'No longer needed' } }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    assert.deepEqual(statuses, [200, 400], 'only one simultaneous cancel should succeed');
  });
});
