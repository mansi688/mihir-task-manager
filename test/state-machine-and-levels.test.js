const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');

test('task state machine: valid and invalid transitions explicitly enumerated', async (t) => {
  const { baseUrl, stop } = await startTestServer();
  t.after(() => stop());

  const adminToken = await login(baseUrl, 'admin', 'admin123');
  const aliceToken = await createMember(baseUrl, adminToken, 'alice', 'Alice');
  const bobToken = await createMember(baseUrl, adminToken, 'bob', 'Bob');

  await t.test('VALID: open → (submitted) → approved → closed', async () => {
    const create = await api(baseUrl, '/api/tasks', { method: 'POST', token: aliceToken, body: { title: 'SM Valid Path', priority: 'low', deadline: futureDate(), assignedToList: ['bob'] } });
    const id = create.data.id;
    const submit = await api(baseUrl, `/api/tasks/${id}/submit-mine`, { method: 'POST', token: bobToken, body: { note: 'Fully done and verified.' } });
    assert.equal(submit.status, 200);
    const approve = await api(baseUrl, `/api/tasks/${id}/approve/bob`, { method: 'POST', token: aliceToken });
    assert.equal(approve.status, 200);
    assert.equal(approve.data.taskClosed, true, 'single-assignee task should auto-close on final approval');
  });

  await t.test('VALID: submitted → rejected → resubmitted → approved', async () => {
    const create = await api(baseUrl, '/api/tasks', { method: 'POST', token: aliceToken, body: { title: 'SM Reject Resubmit', priority: 'low', deadline: futureDate(), assignedToList: ['bob'] } });
    const id = create.data.id;
    await api(baseUrl, `/api/tasks/${id}/submit-mine`, { method: 'POST', token: bobToken, body: { note: 'First attempt.' } });
    const reject = await api(baseUrl, `/api/tasks/${id}/reject/bob`, { method: 'POST', token: aliceToken, body: { reason: 'Needs more detail here' } });
    assert.equal(reject.status, 200);
    const resubmit = await api(baseUrl, `/api/tasks/${id}/submit-mine`, { method: 'POST', token: bobToken, body: { note: 'Added the detail requested.' } });
    assert.equal(resubmit.status, 200);
    const approve = await api(baseUrl, `/api/tasks/${id}/approve/bob`, { method: 'POST', token: aliceToken });
    assert.equal(approve.status, 200);
  });

  await t.test('VALID: closed → reopened → (open again) → closed again', async () => {
    const create = await api(baseUrl, '/api/tasks', { method: 'POST', token: aliceToken, body: { title: 'SM Reopen Cycle', priority: 'low', deadline: futureDate(), assignedToList: ['bob'] } });
    const id = create.data.id;
    await api(baseUrl, `/api/tasks/${id}/close`, { method: 'POST', token: aliceToken });
    const reopen = await api(baseUrl, `/api/tasks/${id}/reopen`, { method: 'POST', token: aliceToken, body: { reason: 'More work identified' } });
    assert.equal(reopen.status, 200);
    const closeAgain = await api(baseUrl, `/api/tasks/${id}/close`, { method: 'POST', token: aliceToken });
    assert.equal(closeAgain.status, 200, 'a re-reopened task should be closable again');
  });

  await t.test('VALID: cancelled → reopened → open', async () => {
    const create = await api(baseUrl, '/api/tasks', { method: 'POST', token: aliceToken, body: { title: 'SM Cancel Reopen', priority: 'low', deadline: futureDate(), assignedToList: ['bob'] } });
    const id = create.data.id;
    await api(baseUrl, `/api/tasks/${id}/cancel`, { method: 'POST', token: aliceToken, body: { reason: 'Made in error' } });
    const reopen = await api(baseUrl, `/api/tasks/${id}/reopen`, { method: 'POST', token: aliceToken, body: { reason: 'Actually still needed' } });
    assert.equal(reopen.status, 200, 'a cancelled task should be reopenable back into an open task');
  });

  await t.test('INVALID: cannot close a cancelled task directly (must reopen first)', async () => {
    const create = await api(baseUrl, '/api/tasks', { method: 'POST', token: aliceToken, body: { title: 'SM Cancel Then Close', priority: 'low', deadline: futureDate(), assignedToList: ['bob'] } });
    const id = create.data.id;
    await api(baseUrl, `/api/tasks/${id}/cancel`, { method: 'POST', token: aliceToken, body: { reason: 'Not needed' } });
    const closeAttempt = await api(baseUrl, `/api/tasks/${id}/close`, { method: 'POST', token: aliceToken });
    assert.equal(closeAttempt.status, 400, 'a cancelled task must not be directly closable — it must be reopened first');
  });

  await t.test('INVALID: cannot cancel an already-closed task', async () => {
    const create = await api(baseUrl, '/api/tasks', { method: 'POST', token: aliceToken, body: { title: 'SM Close Then Cancel', priority: 'low', deadline: futureDate(), assignedToList: ['bob'] } });
    const id = create.data.id;
    await api(baseUrl, `/api/tasks/${id}/close`, { method: 'POST', token: aliceToken });
    const cancelAttempt = await api(baseUrl, `/api/tasks/${id}/cancel`, { method: 'POST', token: aliceToken, body: { reason: 'Trying anyway' } });
    assert.equal(cancelAttempt.status, 400, 'an already-closed task must not be cancellable — closed and cancelled are mutually exclusive terminal states');
  });

  await t.test('INVALID: cannot reopen a task that is still open', async () => {
    const create = await api(baseUrl, '/api/tasks', { method: 'POST', token: aliceToken, body: { title: 'SM Reopen While Open', priority: 'low', deadline: futureDate(), assignedToList: ['bob'] } });
    const res = await api(baseUrl, `/api/tasks/${create.data.id}/reopen`, { method: 'POST', token: aliceToken, body: { reason: 'testing' } });
    assert.equal(res.status, 400, 'reopen only makes sense on a closed or cancelled task');
  });

  await t.test('INVALID: an on-hold (not yet released) assignee cannot submit their part', async () => {
    const create = await api(baseUrl, '/api/tasks', {
      method: 'POST', token: aliceToken,
      body: { title: 'SM On Hold Submit', priority: 'low', deadline: futureDate(), assignedToList: ['alice', 'bob'], stages: [{ usernames: ['alice'] }, { usernames: ['bob'] }] },
    });
    const id = create.data.id;
    const res = await api(baseUrl, `/api/tasks/${id}/submit-mine`, { method: 'POST', token: bobToken, body: { note: 'Trying to submit while still on hold.' } });
    assert.equal(res.status, 400, 'bob is on Level 2, still on hold — he must not be able to submit before being released');
  });

  await t.test('INVALID: cannot approve someone twice without a fresh submission in between', async () => {
    const create = await api(baseUrl, '/api/tasks', { method: 'POST', token: aliceToken, body: { title: 'SM Double Approve Sequential', priority: 'low', deadline: futureDate(), assignedToList: ['alice', 'bob'] } });
    const id = create.data.id;
    await api(baseUrl, `/api/tasks/${id}/submit-mine`, { method: 'POST', token: bobToken, body: { note: 'Done here.' } });
    await api(baseUrl, `/api/tasks/${id}/approve/bob`, { method: 'POST', token: aliceToken });
    const secondApprove = await api(baseUrl, `/api/tasks/${id}/approve/bob`, { method: 'POST', token: aliceToken });
    assert.equal(secondApprove.status, 400);
  });
});

test('level workflow with 3 levels, and a rejection at an earlier level blocking the next', async (t) => {
  const { baseUrl, stop } = await startTestServer();
  t.after(() => stop());

  const adminToken = await login(baseUrl, 'admin', 'admin123');
  const aliceToken = await createMember(baseUrl, adminToken, 'alice', 'Alice');
  const bobToken = await createMember(baseUrl, adminToken, 'bob', 'Bob');
  const carolToken = await createMember(baseUrl, adminToken, 'carol', 'Carol');

  await t.test('Level 3 cannot release even if Level 1 is done, while Level 2 is still pending', async () => {
    const create = await api(baseUrl, '/api/tasks', {
      method: 'POST', token: aliceToken,
      body: { title: '3-Level Task', priority: 'medium', deadline: futureDate(), assignedToList: ['alice', 'bob', 'carol'], stages: [{ usernames: ['alice'] }, { usernames: ['bob'] }, { usernames: ['carol'] }] },
    });
    const id = create.data.id;
    await api(baseUrl, `/api/tasks/${id}/submit-mine`, { method: 'POST', token: aliceToken, body: { note: 'Level 1 done.' } });
    await api(baseUrl, `/api/tasks/${id}/approve/alice`, { method: 'POST', token: aliceToken });

    const level3Attempt = await api(baseUrl, `/api/tasks/${id}/release-stage/3`, { method: 'POST', token: aliceToken });
    assert.equal(level3Attempt.status, 400, 'Level 3 must not release while Level 2 has not even started');

    await api(baseUrl, `/api/tasks/${id}/release-stage/2`, { method: 'POST', token: aliceToken });
    const level3StillBlocked = await api(baseUrl, `/api/tasks/${id}/release-stage/3`, { method: 'POST', token: aliceToken });
    assert.equal(level3StillBlocked.status, 400, 'Level 3 must not release just because Level 2 was released — it must be APPROVED, not merely released');

    await api(baseUrl, `/api/tasks/${id}/submit-mine`, { method: 'POST', token: bobToken, body: { note: 'Level 2 done.' } });
    await api(baseUrl, `/api/tasks/${id}/approve/bob`, { method: 'POST', token: aliceToken });
    const level3Now = await api(baseUrl, `/api/tasks/${id}/release-stage/3`, { method: 'POST', token: aliceToken });
    assert.equal(level3Now.status, 200, 'Level 3 should release once Level 2 is genuinely approved');
  });

  await t.test('rejecting Level 1 keeps Level 2 blocked until Level 1 is resubmitted and approved', async () => {
    const create = await api(baseUrl, '/api/tasks', {
      method: 'POST', token: aliceToken,
      body: { title: 'Rejected Level 1 Test', priority: 'medium', deadline: futureDate(), assignedToList: ['alice', 'bob'], stages: [{ usernames: ['alice'] }, { usernames: ['bob'] }] },
    });
    const id = create.data.id;
    await api(baseUrl, `/api/tasks/${id}/submit-mine`, { method: 'POST', token: aliceToken, body: { note: 'First attempt at Level 1.' } });
    await api(baseUrl, `/api/tasks/${id}/reject/alice`, { method: 'POST', token: aliceToken, body: { reason: 'Not quite right, please redo' } });

    const blockedRelease = await api(baseUrl, `/api/tasks/${id}/release-stage/2`, { method: 'POST', token: aliceToken });
    assert.equal(blockedRelease.status, 400, 'Level 2 must stay blocked while Level 1 was rejected and not yet resubmitted/approved');

    await api(baseUrl, `/api/tasks/${id}/submit-mine`, { method: 'POST', token: aliceToken, body: { note: 'Fixed and resubmitted.' } });
    await api(baseUrl, `/api/tasks/${id}/approve/alice`, { method: 'POST', token: aliceToken });
    const nowRelease = await api(baseUrl, `/api/tasks/${id}/release-stage/2`, { method: 'POST', token: aliceToken });
    assert.equal(nowRelease.status, 200, 'Level 2 should release once Level 1 is properly resubmitted and approved');
  });

  await t.test('auto-release: approving the last person in Level 1 automatically releases Level 2 with no manual call', async () => {
    const create = await api(baseUrl, '/api/tasks', {
      method: 'POST', token: aliceToken,
      body: { title: 'Auto Release Test', priority: 'medium', deadline: futureDate(), assignedToList: ['alice', 'bob'], stages: [{ usernames: ['alice'] }, { usernames: ['bob'] }], autoReleaseStages: true },
    });
    const id = create.data.id;
    await api(baseUrl, `/api/tasks/${id}/submit-mine`, { method: 'POST', token: aliceToken, body: { note: 'Level 1 done.' } });
    await api(baseUrl, `/api/tasks/${id}/approve/alice`, { method: 'POST', token: aliceToken });

    // No explicit release-stage call — verify bob is already released.
    const task = await api(baseUrl, `/api/tasks/${id}`, { token: aliceToken });
    const bobRow = task.data.assignees.find(a => a.username === 'bob');
    assert.equal(bobRow.is_released, 1, 'with auto-release enabled, Level 2 should already be released without a manual call');
  });
});
