const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');

test('subtasks: a full task with a parent link, gating the parent\'s close, with notifications matching regular tasks', async (t) => {
  const { baseUrl, stop } = await startTestServer();
  t.after(() => stop());
  const adminToken = await login(baseUrl, 'admin', 'admin123');
  const aliceToken = await createMember(baseUrl, adminToken, 'alice', 'Alice');
  const bobToken = await createMember(baseUrl, adminToken, 'bob', 'Bob');

  const parent = await api(baseUrl, '/api/tasks', { method: 'POST', token: adminToken, body: { title: 'Main Task', priority: 'high', deadline: futureDate(), assignedToList: ['alice'] } });
  const parentId = parent.data.id;

  await t.test('a subtask can be created under an open parent', async () => {
    const sub = await api(baseUrl, '/api/tasks', { method: 'POST', token: adminToken, body: { title: 'Subtask A', priority: 'medium', deadline: futureDate(), assignedToList: ['bob'], parentTaskId: parentId } });
    assert.equal(sub.status, 200, JSON.stringify(sub.data));
  });

  await t.test('the parent task\'s response lists its subtask', async () => {
    const task = await api(baseUrl, `/api/tasks/${parentId}`, { token: adminToken });
    assert.equal(task.data.subtasks.length, 1);
    assert.equal(task.data.subtasks[0].title, 'Subtask A');
  });

  await t.test('the subtask assignee (bob) got a normal task_assigned notification — same as any regular task', async () => {
    const notifs = (await api(baseUrl, '/api/notifications', { token: bobToken })).data.items;
    assert.ok(notifs.some(n => n.type === 'task_assigned'), 'a subtask assignee must get the exact same assignment notification a regular task assignee gets');
  });

  await t.test('the parent\'s assignee (alice) is notified that a subtask now gates her task\'s closing', async () => {
    const notifs = (await api(baseUrl, '/api/notifications', { token: aliceToken })).data.items;
    assert.ok(notifs.some(n => n.message.includes('subtask') && n.message.includes('Main Task')), 'alice should learn a subtask now blocks her task from closing');
  });

  await t.test('the parent CANNOT be closed while the subtask is still open — even by Admin', async () => {
    const attempt = await api(baseUrl, `/api/tasks/${parentId}/close`, { method: 'POST', token: adminToken });
    assert.equal(attempt.status, 400);
    assert.match(attempt.data.error, /open subtask/i);
    assert.ok(attempt.data.error.includes('Subtask A'), 'the error should name which subtask is blocking it');
  });

  await t.test('closing the subtask itself works exactly like any normal task', async () => {
    const task = await api(baseUrl, `/api/tasks/${parentId}`, { token: adminToken });
    const subId = task.data.subtasks[0].id;
    const submit = await api(baseUrl, `/api/tasks/${subId}/submit-mine`, { method: 'POST', token: bobToken, body: { note: 'Subtask fully done.' } });
    assert.equal(submit.status, 200);
    const approve = await api(baseUrl, `/api/tasks/${subId}/approve/bob`, { method: 'POST', token: adminToken });
    assert.equal(approve.status, 200);
  });

  await t.test('once the subtask is closed, the parent can finally be closed too', async () => {
    const attempt = await api(baseUrl, `/api/tasks/${parentId}/close`, { method: 'POST', token: adminToken });
    assert.equal(attempt.status, 200, JSON.stringify(attempt.data));
  });

  await t.test('a subtask cannot be added to a task that is already closed', async () => {
    const res = await api(baseUrl, '/api/tasks', { method: 'POST', token: adminToken, body: { title: 'Too Late Subtask', priority: 'low', deadline: futureDate(), assignedToList: ['bob'], parentTaskId: parentId } });
    assert.equal(res.status, 400);
    assert.match(res.data.error, /already closed/i);
  });

  await t.test('a nonexistent parent task ID is rejected', async () => {
    const res = await api(baseUrl, '/api/tasks', { method: 'POST', token: adminToken, body: { title: 'Orphan Subtask', priority: 'low', deadline: futureDate(), assignedToList: ['bob'], parentTaskId: 'TASK-NOPE' } });
    assert.equal(res.status, 400);
    assert.match(res.data.error, /not found/i);
  });

  await t.test('multiple open subtasks are all named in the block message, and closing works once ALL are done', async () => {
    const parent2 = await api(baseUrl, '/api/tasks', { method: 'POST', token: adminToken, body: { title: 'Multi-Subtask Parent', priority: 'medium', deadline: futureDate(), assignedToList: ['alice'] } });
    const p2 = parent2.data.id;
    const s1 = await api(baseUrl, '/api/tasks', { method: 'POST', token: adminToken, body: { title: 'Sub One', priority: 'low', deadline: futureDate(), assignedToList: ['bob'], parentTaskId: p2 } });
    const s2 = await api(baseUrl, '/api/tasks', { method: 'POST', token: adminToken, body: { title: 'Sub Two', priority: 'low', deadline: futureDate(), assignedToList: ['bob'], parentTaskId: p2 } });

    const blockedAttempt = await api(baseUrl, `/api/tasks/${p2}/close`, { method: 'POST', token: adminToken });
    assert.ok(blockedAttempt.data.error.includes('Sub One') && blockedAttempt.data.error.includes('Sub Two'), 'both open subtasks must be named');
    assert.ok(blockedAttempt.data.error.includes('2 open subtasks'), 'the count must be accurate');

    await api(baseUrl, `/api/tasks/${s1.data.id}/submit-mine`, { method: 'POST', token: bobToken, body: { note: 'Done.' } });
    await api(baseUrl, `/api/tasks/${s1.data.id}/approve/bob`, { method: 'POST', token: adminToken });

    const stillBlockedAttempt = await api(baseUrl, `/api/tasks/${p2}/close`, { method: 'POST', token: adminToken });
    assert.ok(stillBlockedAttempt.data.error.includes('1 open subtask') && !stillBlockedAttempt.data.error.includes('Sub One'), 'only the still-open subtask should be named now');

    await api(baseUrl, `/api/tasks/${s2.data.id}/submit-mine`, { method: 'POST', token: bobToken, body: { note: 'Done.' } });
    await api(baseUrl, `/api/tasks/${s2.data.id}/approve/bob`, { method: 'POST', token: adminToken });

    const finalAttempt = await api(baseUrl, `/api/tasks/${p2}/close`, { method: 'POST', token: adminToken });
    assert.equal(finalAttempt.status, 200);
  });

  await t.test('subtasks appear in the light task listing with an accurate subtask count', async () => {
    const parent3 = await api(baseUrl, '/api/tasks', { method: 'POST', token: adminToken, body: { title: 'Light Listing Parent', priority: 'low', deadline: futureDate(), assignedToList: ['alice'] } });
    await api(baseUrl, '/api/tasks', { method: 'POST', token: adminToken, body: { title: 'Light Sub', priority: 'low', deadline: futureDate(), assignedToList: ['bob'], parentTaskId: parent3.data.id } });
    const mine = await api(baseUrl, '/api/tasks/mine', { token: adminToken });
    const found = mine.data.find(t => t.id === parent3.data.id);
    assert.equal(found.subtaskCount, 1);
    assert.equal(found.openSubtaskCount, 1);
  });
});
