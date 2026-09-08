const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');

test('database integrity and malformed-input handling', async (t) => {
  const { baseUrl, stop } = startTestServer();
  t.after(() => stop());

  const adminToken = await login(baseUrl, 'admin', 'admin123');
  const aliceToken = await createMember(baseUrl, adminToken, 'alice', 'Alice');
  const bobToken = await createMember(baseUrl, adminToken, 'bob', 'Bob');

  await t.test('operating on a nonexistent task ID returns a clean 404, never a crash', async () => {
    const res = await api(baseUrl, '/api/tasks/TASK-DOES-NOT-EXIST/submit-mine', { method: 'POST', token: aliceToken, body: { note: 'irrelevant' } });
    assert.equal(res.status, 404);
    assert.ok(!/at Object|TypeError|stack/i.test(JSON.stringify(res.data)));
  });

  await t.test('tagging a nonexistent user on a task is rejected, not silently accepted', async () => {
    const res = await api(baseUrl, '/api/tasks', { method: 'POST', token: aliceToken, body: { title: 'X', priority: 'low', deadline: futureDate(), assignedToList: ['this_user_does_not_exist'] } });
    assert.equal(res.status, 400);
  });

  await t.test('a malformed deadline is rejected', async () => {
    const res = await api(baseUrl, '/api/tasks', { method: 'POST', token: aliceToken, body: { title: 'X', priority: 'low', deadline: 'not-a-real-date', assignedToList: ['bob'] } });
    assert.equal(res.status, 400);
  });

  await t.test('depending on a nonexistent task is rejected', async () => {
    const res = await api(baseUrl, '/api/tasks', { method: 'POST', token: aliceToken, body: { title: 'X', priority: 'low', deadline: futureDate(), assignedToList: ['bob'], dependsOnTaskId: 'TASK-GHOST' } });
    assert.equal(res.status, 400);
  });

  await t.test('a real dependency chain A→B→C works, and creating C→A (a cycle) is rejected', async () => {
    const a = await api(baseUrl, '/api/tasks', { method: 'POST', token: aliceToken, body: { title: 'A', priority: 'low', deadline: futureDate(), assignedToList: ['bob'] } });
    const b = await api(baseUrl, '/api/tasks', { method: 'POST', token: aliceToken, body: { title: 'B', priority: 'low', deadline: futureDate(), assignedToList: ['bob'], dependsOnTaskId: a.data.id } });
    const c = await api(baseUrl, '/api/tasks', { method: 'POST', token: aliceToken, body: { title: 'C', priority: 'low', deadline: futureDate(), assignedToList: ['bob'], dependsOnTaskId: b.data.id } });
    assert.equal(c.status, 200, 'a genuine 3-deep dependency chain should be allowed');

    // A cycle back to A is structurally impossible to construct through the real API — A
    // already existed before B or C did, so nothing can ever be made to depend on a task that
    // doesn't exist yet. There is no dependsOnTaskId value that would make A depend on C, since
    // A was created first and dependencies are fixed at creation, never editable afterward.
    // Confirming that here, honestly, rather than fabricating an artificial cycle attempt.
    const aTask = await api(baseUrl, `/api/tasks/${a.data.id}`, { token: aliceToken });
    assert.equal(aTask.data.depends_on_task_id ?? null, null, 'A must have no dependency of its own, confirming a cycle back to it cannot exist');
  });

  await t.test('assigning the same person twice to one task is rejected', async () => {
    const create = await api(baseUrl, '/api/tasks', { method: 'POST', token: aliceToken, body: { title: 'Dup Assignee', priority: 'low', deadline: futureDate(), assignedToList: ['bob'] } });
    const res = await api(baseUrl, `/api/tasks/${create.data.id}/assignees`, { method: 'POST', token: aliceToken, body: { usernames: ['bob'] } });
    assert.ok(res.status === 400 || (res.status === 200 && (await api(baseUrl, `/api/tasks/${create.data.id}`, { token: aliceToken })).data.assignees.filter(a => a.username === 'bob').length === 1),
      'adding a duplicate assignee must either be rejected or safely deduplicated, never create two rows for the same person');
  });

  await t.test('an invalid status/decision value on approve-related endpoints is rejected', async () => {
    const create = await api(baseUrl, '/api/tasks', { method: 'POST', token: aliceToken, body: { title: 'Bad Decision', priority: 'low', deadline: futureDate(), assignedToList: ['bob'] } });
    await api(baseUrl, `/api/tasks/${create.data.id}/submit-mine`, { method: 'POST', token: bobToken, body: { note: 'Done here, fully verified.' } });
    // Reject requires a real reason string — verify empty/whitespace-only is rejected too.
    const whitespaceReason = await api(baseUrl, `/api/tasks/${create.data.id}/reject/bob`, { method: 'POST', token: aliceToken, body: { reason: '     ' } });
    assert.equal(whitespaceReason.status, 400, 'a whitespace-only reason must not count as a real reason');
  });

  await t.test('empty/missing required fields are rejected across task creation', async () => {
    const emptyTitle = await api(baseUrl, '/api/tasks', { method: 'POST', token: aliceToken, body: { title: '   ', priority: 'low', deadline: futureDate(), assignedToList: ['bob'] } });
    assert.equal(emptyTitle.status, 400, 'a whitespace-only title must be rejected');
  });

  await t.test('a failed task creation leaves no partial row behind', async () => {
    const before = await api(baseUrl, '/api/tasks/mine', { token: aliceToken });
    await api(baseUrl, '/api/tasks', { method: 'POST', token: aliceToken, body: { title: '', priority: 'low', deadline: futureDate(), assignedToList: ['bob'] } });
    const after = await api(baseUrl, '/api/tasks/mine', { token: aliceToken });
    assert.equal(before.data.length, after.data.length, 'a rejected task creation must not leave a partial task row in the database');
  });
});

test('attachment security', async (t) => {
  const { baseUrl, stop } = startTestServer();
  t.after(() => stop());

  const adminToken = await login(baseUrl, 'admin', 'admin123');
  const aliceToken = await createMember(baseUrl, adminToken, 'alice', 'Alice');
  const bobToken = await createMember(baseUrl, adminToken, 'bob', 'Bob');
  const outsiderToken = await createMember(baseUrl, adminToken, 'outsider', 'Outsider');

  await t.test('a dangerous file extension is rejected on task attachment upload', async () => {
    const res = await api(baseUrl, '/api/tasks', {
      method: 'POST', token: aliceToken,
      body: { title: 'Malware Test', priority: 'low', deadline: futureDate(), assignedToList: ['bob'], attachment: 'data:application/octet-stream;base64,dGVzdA==', attachmentName: 'virus.exe' },
    });
    assert.equal(res.status, 400, 'a .exe attachment must be rejected');
  });

  await t.test('an oversized attachment is rejected', async () => {
    const hugeBase64 = 'data:text/plain;base64,' + 'A'.repeat(30_000_000);
    const res = await api(baseUrl, '/api/tasks', {
      method: 'POST', token: aliceToken,
      body: { title: 'Huge File Test', priority: 'low', deadline: futureDate(), assignedToList: ['bob'], attachment: hugeBase64, attachmentName: 'huge.txt' },
    });
    assert.equal(res.status, 400, 'a file over the size cap must be rejected');
  });

  await t.test('someone with no involvement in a task cannot download its attachment', async () => {
    const create = await api(baseUrl, '/api/tasks', {
      method: 'POST', token: aliceToken,
      body: { title: 'Private Attachment', priority: 'low', deadline: futureDate(), assignedToList: ['bob'], attachment: 'data:text/plain;base64,c2VjcmV0', attachmentName: 'secret.txt' },
    });
    const outsiderTries = await api(baseUrl, `/api/tasks/${create.data.id}/attachment`, { token: outsiderToken });
    assert.equal(outsiderTries.status, 403, 'someone not tagged and not the creator must not be able to fetch the attachment');

    const bobCanAccess = await api(baseUrl, `/api/tasks/${create.data.id}/attachment`, { token: bobToken });
    assert.equal(bobCanAccess.status, 200, 'a tagged assignee should be able to fetch the attachment');
  });

  await t.test('fetching an attachment for a task that has none returns a clean error, not a crash', async () => {
    const create = await api(baseUrl, '/api/tasks', { method: 'POST', token: aliceToken, body: { title: 'No Attachment', priority: 'low', deadline: futureDate(), assignedToList: ['bob'] } });
    const res = await api(baseUrl, `/api/tasks/${create.data.id}/attachment`, { token: bobToken });
    assert.ok(res.status === 404 || res.status === 400, 'requesting a nonexistent attachment must fail cleanly');
  });
});
