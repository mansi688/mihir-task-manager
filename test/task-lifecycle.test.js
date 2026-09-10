const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');

test('task lifecycle, permissions, and idempotency', async (t) => {
  const { baseUrl, stop } = await startTestServer();
  t.after(() => stop());

  const adminToken = await login(baseUrl, 'admin', 'admin123');
  assert.ok(adminToken, 'default admin should be able to log in on first run');

  const aliceToken = await createMember(baseUrl, adminToken, 'alice', 'Alice Test');
  const bobToken = await createMember(baseUrl, adminToken, 'bob', 'Bob Test');
  assert.ok(aliceToken && bobToken, 'member accounts should be created and able to log in');

  await t.test('task creation requires title, deadline, and at least one tagged person', async () => {
    const noTitle = await api(baseUrl, '/api/tasks', { method: 'POST', token: aliceToken, body: { deadline: futureDate(), assignedToList: ['bob'] } });
    assert.equal(noTitle.status, 400);

    const noDeadline = await api(baseUrl, '/api/tasks', { method: 'POST', token: aliceToken, body: { title: 'X', assignedToList: ['bob'] } });
    assert.equal(noDeadline.status, 400);

    const noAssignee = await api(baseUrl, '/api/tasks', { method: 'POST', token: aliceToken, body: { title: 'X', deadline: futureDate(), assignedToList: [] } });
    assert.equal(noAssignee.status, 400);
  });

  let taskId;
  await t.test('full lifecycle: create → submit → approve → auto-close', async () => {
    const create = await api(baseUrl, '/api/tasks', { method: 'POST', token: aliceToken, body: { title: 'Test Task', description: 'desc', priority: 'medium', deadline: futureDate(), assignedToList: ['bob'] } });
    assert.equal(create.status, 200);
    taskId = create.data.id;
    assert.ok(taskId);

    const submit = await api(baseUrl, `/api/tasks/${taskId}/submit-mine`, { method: 'POST', token: bobToken, body: { note: 'Work is fully done and verified.' } });
    assert.equal(submit.status, 200, JSON.stringify(submit.data));

    const approve = await api(baseUrl, `/api/tasks/${taskId}/approve/bob`, { method: 'POST', token: aliceToken });
    assert.equal(approve.status, 200);
    assert.equal(approve.data.taskClosed, true, 'task with one assignee should auto-close once approved');
  });

  await t.test('idempotency: approving an already-approved person is rejected, not silently reprocessed', async () => {
    // Needs a SECOND assignee so the task stays open after the first approval — otherwise the
    // task auto-closes immediately and a repeat call correctly (but less specifically) hits the
    // earlier "task is not open" check instead of exercising the new guard directly.
    const create = await api(baseUrl, '/api/tasks', { method: 'POST', token: aliceToken, body: { title: 'Double Approve Test', priority: 'low', deadline: futureDate(), assignedToList: ['alice', 'bob'] } });
    const id = create.data.id;
    await api(baseUrl, `/api/tasks/${id}/submit-mine`, { method: 'POST', token: bobToken, body: { note: 'My part is fully done.' } });
    const firstApprove = await api(baseUrl, `/api/tasks/${id}/approve/bob`, { method: 'POST', token: aliceToken });
    assert.equal(firstApprove.status, 200);
    assert.equal(firstApprove.data.taskClosed, false, 'task should stay open — alice has not submitted/approved her own part yet');

    const second = await api(baseUrl, `/api/tasks/${id}/approve/bob`, { method: 'POST', token: aliceToken });
    assert.equal(second.status, 400);
    assert.match(second.data.error, /already approved/i);
  });

  await t.test('closing/reopening authority is creator-or-admin only', async () => {
    const create = await api(baseUrl, '/api/tasks', { method: 'POST', token: aliceToken, body: { title: 'Reopen Test', priority: 'low', deadline: futureDate(), assignedToList: ['bob'] } });
    const id = create.data.id;
    await api(baseUrl, `/api/tasks/${id}/submit-mine`, { method: 'POST', token: bobToken, body: { note: 'Done, verified on site.' } });
    await api(baseUrl, `/api/tasks/${id}/approve/bob`, { method: 'POST', token: aliceToken });

    const bobReopenAttempt = await api(baseUrl, `/api/tasks/${id}/reopen`, { method: 'POST', token: bobToken, body: { reason: 'testing' } });
    assert.equal(bobReopenAttempt.status, 403, 'a tagged assignee who is not the creator must not be able to reopen');

    const noReason = await api(baseUrl, `/api/tasks/${id}/reopen`, { method: 'POST', token: aliceToken, body: {} });
    assert.equal(noReason.status, 400, 'reopening without a reason must be rejected');

    const validReopen = await api(baseUrl, `/api/tasks/${id}/reopen`, { method: 'POST', token: aliceToken, body: { reason: 'Missing photos, needs redoing' } });
    assert.equal(validReopen.status, 200);
  });

  await t.test('reject requires an actual submission to reject, and a real reason', async () => {
    const create = await api(baseUrl, '/api/tasks', { method: 'POST', token: aliceToken, body: { title: 'Reject Test', priority: 'low', deadline: futureDate(), assignedToList: ['bob'] } });
    const id = create.data.id;

    const rejectNothing = await api(baseUrl, `/api/tasks/${id}/reject/bob`, { method: 'POST', token: aliceToken, body: { reason: 'no submission exists yet' } });
    assert.equal(rejectNothing.status, 400, 'rejecting someone who has not submitted anything must be refused');

    await api(baseUrl, `/api/tasks/${id}/submit-mine`, { method: 'POST', token: bobToken, body: { note: 'First attempt at the work.' } });
    const rejectNoReason = await api(baseUrl, `/api/tasks/${id}/reject/bob`, { method: 'POST', token: aliceToken, body: {} });
    assert.equal(rejectNoReason.status, 400, 'rejection must require a real reason');

    const rejectOk = await api(baseUrl, `/api/tasks/${id}/reject/bob`, { method: 'POST', token: aliceToken, body: { reason: 'Please add more detail' } });
    assert.equal(rejectOk.status, 200);

    // Bob should be able to resubmit after rejection.
    const resubmit = await api(baseUrl, `/api/tasks/${id}/submit-mine`, { method: 'POST', token: bobToken, body: { note: 'Added the requested detail.' } });
    assert.equal(resubmit.status, 200, 'a rejected assignee must be able to resubmit');
  });

  await t.test('a blocked task cannot be force-closed until its dependency closes', async () => {
    const prereq = await api(baseUrl, '/api/tasks', { method: 'POST', token: aliceToken, body: { title: 'Prereq', priority: 'low', deadline: futureDate(), assignedToList: ['bob'] } });
    const dependent = await api(baseUrl, '/api/tasks', { method: 'POST', token: aliceToken, body: { title: 'Dependent', priority: 'low', deadline: futureDate(), assignedToList: ['bob'], dependsOnTaskId: prereq.data.id } });

    const blockedClose = await api(baseUrl, `/api/tasks/${dependent.data.id}/close`, { method: 'POST', token: aliceToken });
    assert.equal(blockedClose.status, 400, 'a task blocked on an open prerequisite must not be closable');

    await api(baseUrl, `/api/tasks/${prereq.data.id}/submit-mine`, { method: 'POST', token: bobToken, body: { note: 'Prereq done.' } });
    await api(baseUrl, `/api/tasks/${prereq.data.id}/approve/bob`, { method: 'POST', token: aliceToken });

    const nowClosable = await api(baseUrl, `/api/tasks/${dependent.data.id}/close`, { method: 'POST', token: aliceToken });
    assert.equal(nowClosable.status, 200, 'once the prerequisite closes, the dependent task should be closable');
  });

  await t.test('level 2 cannot be released before level 1 is fully approved', async () => {
    const create = await api(baseUrl, '/api/tasks', {
      method: 'POST', token: aliceToken,
      body: { title: 'Level Test', priority: 'medium', deadline: futureDate(), assignedToList: ['alice', 'bob'], stages: [{ usernames: ['alice'] }, { usernames: ['bob'] }] },
    });
    const id = create.data.id;

    const earlyRelease = await api(baseUrl, `/api/tasks/${id}/release-stage/2`, { method: 'POST', token: aliceToken });
    assert.equal(earlyRelease.status, 400, 'level 2 must not be releasable before level 1 is approved');

    await api(baseUrl, `/api/tasks/${id}/submit-mine`, { method: 'POST', token: aliceToken, body: { note: 'Level 1 work done.' } });
    await api(baseUrl, `/api/tasks/${id}/approve/alice`, { method: 'POST', token: aliceToken });

    const release = await api(baseUrl, `/api/tasks/${id}/release-stage/2`, { method: 'POST', token: aliceToken });
    assert.equal(release.status, 200, 'level 2 should be releasable once level 1 is approved');

    const doubleRelease = await api(baseUrl, `/api/tasks/${id}/release-stage/2`, { method: 'POST', token: aliceToken });
    assert.equal(doubleRelease.status, 400, 'releasing an already-released level again must be rejected, not silently reprocessed');
  });

  await t.test('permission checks reject unauthorized admin-only endpoints', async () => {
    const memberTriesAuditLog = await api(baseUrl, '/api/audit-log', { token: bobToken });
    assert.equal(memberTriesAuditLog.status, 403);

    const memberTriesCreateUser = await api(baseUrl, '/api/users', { method: 'POST', token: bobToken, body: { username: 'hacker', password: 'Whatever123', name: 'Hacker', role: 'admin' } });
    assert.equal(memberTriesCreateUser.status, 403);
  });

  await t.test('server never crashes on a bad request — global error handling holds', async () => {
    const weird = await api(baseUrl, '/api/tasks/this-task-does-not-exist/approve/nobody', { method: 'POST', token: aliceToken });
    assert.ok(weird.status >= 400 && weird.status < 500, 'an invalid request should get a clean 4xx, not a crash');
    const stillAlive = await api(baseUrl, '/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
    assert.equal(stillAlive.status, 200, 'the server must still be responding after a bad request');
  });
});
