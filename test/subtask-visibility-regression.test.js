const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');

test('subtask/parent visibility never bleeds into each other\'s task list — no confusion between the two', async (t) => {
  const { baseUrl, stop } = await startTestServer();
  t.after(() => stop());
  const adminToken = await login(baseUrl, 'admin', 'admin123');
  const suraj = await createMember(baseUrl, adminToken, 'suraj', 'Suraj');
  const rohit = await createMember(baseUrl, adminToken, 'rohit', 'Rohit');

  const parent = await api(baseUrl, '/api/tasks', { method: 'POST', token: suraj, body: { title: 'Finalize Estimate', priority: 'high', deadline: futureDate(), assignedToList: ['suraj'] } });
  const parentId = parent.data.id;
  const sub = await api(baseUrl, '/api/tasks', { method: 'POST', token: suraj, body: { title: 'Get Steel Pricing', priority: 'medium', deadline: futureDate(), assignedToList: ['rohit'], parentTaskId: parentId } });
  const subId = sub.data.id;

  await t.test('Rohit (tagged ONLY on the subtask) sees the subtask in his task list', async () => {
    const mine = await api(baseUrl, '/api/tasks/mine', { token: rohit });
    assert.ok(mine.data.some(t => t.id === subId), 'the subtask must appear in the assignee\'s task list');
  });

  await t.test('Rohit does NOT see the parent task in his task list — he is neither its assignee nor its creator', async () => {
    const mine = await api(baseUrl, '/api/tasks/mine', { token: rohit });
    assert.ok(!mine.data.some(t => t.id === parentId), 'the parent task must not appear for someone who is only tagged on its subtask');
  });

  await t.test('Suraj (tagged on the parent, and its creator) sees the parent in his task list', async () => {
    const mine = await api(baseUrl, '/api/tasks/mine', { token: suraj });
    assert.ok(mine.data.some(t => t.id === parentId), 'the parent assignee/creator must see it');
  });

  await t.test('Suraj also sees the subtask in his list, but only because he created it, not because he is tagged on it', async () => {
    const mine = await api(baseUrl, '/api/tasks/mine', { token: suraj });
    const subEntry = mine.data.find(t => t.id === subId);
    assert.ok(subEntry, 'the creator of a subtask sees it in their list');
    assert.ok(!subEntry.assignees.some(a => a.username === 'suraj'), 'Suraj should not be listed as an assignee on the subtask');
  });

  await t.test('Rohit cannot approve or close the PARENT task', async () => {
    await api(baseUrl, `/api/tasks/${subId}/submit-mine`, { method: 'POST', token: rohit, body: { note: 'Got the pricing.' } });
    const closeAttempt = await api(baseUrl, `/api/tasks/${parentId}/close`, { method: 'POST', token: rohit });
    assert.equal(closeAttempt.status, 403, 'Rohit has no authority over the parent task');
  });

  await t.test('Suraj cannot submit-mine on the subtask he is not assigned to, even though he created it', async () => {
    const submitAttempt = await api(baseUrl, `/api/tasks/${subId}/submit-mine`, { method: 'POST', token: suraj, body: { note: 'Trying to submit on behalf of Rohit.' } });
    assert.notEqual(submitAttempt.status, 200, 'creating a subtask does not grant the creator submit rights on it');
  });

  await t.test('the parent detail lists the subtask with only light summary fields, not its full internal data', async () => {
    const parentDetail = await api(baseUrl, `/api/tasks/${parentId}`, { token: suraj });
    assert.equal(parentDetail.data.subtasks.length, 1);
    const listedSub = parentDetail.data.subtasks[0];
    assert.equal(listedSub.id, subId);
    assert.equal(listedSub.title, 'Get Steel Pricing');
    assert.equal(listedSub.assignees, undefined, 'the parent subtask summary must be a light reference, not the subtask full data');
  });

  await t.test('All Tasks (admin) shows both as two separate, distinct entries', async () => {
    const all = await api(baseUrl, '/api/tasks', { token: adminToken });
    const parentEntry = all.data.find(t => t.id === parentId);
    const subEntry = all.data.find(t => t.id === subId);
    assert.ok(parentEntry && subEntry, 'both must exist as distinct task entries');
    assert.notEqual(parentEntry.title, subEntry.title);
  });
});
