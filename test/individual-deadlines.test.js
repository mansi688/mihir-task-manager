const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');

test('per-individual task deadlines drive personal reminders independently of the overall task deadline', async (t) => {
  const { baseUrl, getRawClient, stop } = await startTestServer();
  t.after(() => stop());
  const adminToken = await login(baseUrl, 'admin', 'admin123');
  const aliceToken = await createMember(baseUrl, adminToken, 'alice', 'Alice');
  const bobToken = await createMember(baseUrl, adminToken, 'bob', 'Bob');

  await t.test('creating a task with per-person individual deadlines is accepted and stored', async () => {
    const overallDeadline = futureDate(30); // far away — the task itself isn't due soon
    const create = await api(baseUrl, '/api/tasks', {
      method: 'POST', token: adminToken,
      body: {
        title: 'Individual Deadline Test', priority: 'medium', deadline: overallDeadline,
        assignedToList: ['alice', 'bob'],
        individualDeadlines: { bob: futureDate(0) }, // bob's own deadline is TODAY, unlike the task
      },
    });
    assert.equal(create.status, 200, JSON.stringify(create.data));
    const task = await api(baseUrl, `/api/tasks/${create.data.id}`, { token: adminToken });
    const bobRow = task.data.assignees.find(a => a.username === 'bob');
    const aliceRow = task.data.assignees.find(a => a.username === 'alice');
    assert.equal(bobRow.individual_deadline, futureDate(0));
    assert.equal(aliceRow.individual_deadline ?? null, null, 'alice has no individual deadline set, so it must stay null (falls back to the task deadline)');
  });

  await t.test('an invalid individual deadline is rejected at creation time', async () => {
    const res = await api(baseUrl, '/api/tasks', {
      method: 'POST', token: adminToken,
      body: { title: 'Bad Individual Deadline', priority: 'low', deadline: futureDate(), assignedToList: ['bob'], individualDeadlines: { bob: 'not-a-date' } },
    });
    assert.equal(res.status, 400);
  });

  await t.test('bob (due today) gets a deadline-passed style reminder even though the overall task deadline is 30 days away; alice does not', async () => {
    const create = await api(baseUrl, '/api/tasks', {
      method: 'POST', token: adminToken,
      body: { title: 'Reminder Isolation Test', priority: 'medium', deadline: futureDate(30), assignedToList: ['alice', 'bob'], individualDeadlines: { bob: futureDate(0) } },
    });
    const id = create.data.id;
    // Back-date bob's individual deadline into the past so it's genuinely overdue right now
    // (futureDate(0) is "today", which may not yet be strictly <= now at test-run time).
    const raw = await getRawClient();
    await raw.query('UPDATE task_assignees SET individual_deadline=$1 WHERE task_id=$2 AND username=$3', [new Date(Date.now() - 3600000).toISOString().slice(0, 16), id, 'bob']);
    await raw.end();

    await api(baseUrl, '/api/tasks/send-reminders-now', { method: 'POST', token: adminToken });

    const bobNotifs = (await api(baseUrl, '/api/notifications', { token: bobToken })).data.items.filter(n => n.task_id === id && n.type.startsWith('deadline_'));
    const aliceNotifs = (await api(baseUrl, '/api/notifications', { token: aliceToken })).data.items.filter(n => n.task_id === id && n.type.startsWith('deadline_'));
    assert.ok(bobNotifs.some(n => n.type === 'deadline_passed' && n.message.includes('your individual deadline')), 'bob should get a deadline-passed notice referencing HIS individual deadline specifically');
    assert.equal(aliceNotifs.length, 0, "alice's own deadline (falling back to the far-off task deadline) must not have passed, so she should get no DEADLINE-type notification yet (she may still get unrelated ones like being tagged)");
  });

  await t.test('an existing task\'s individual deadline can be set/updated afterward by the creator', async () => {
    const create = await api(baseUrl, '/api/tasks', { method: 'POST', token: adminToken, body: { title: 'Set Later Test', priority: 'low', deadline: futureDate(20), assignedToList: ['bob'] } });
    const id = create.data.id;

    const outsiderToken = await createMember(baseUrl, adminToken, 'outsider', 'Outsider');
    const blocked = await api(baseUrl, `/api/tasks/${id}/assignees/bob/deadline`, { method: 'POST', token: outsiderToken, body: { deadline: futureDate(2) } });
    assert.equal(blocked.status, 403, 'only the creator or Admin can set an individual deadline');

    const invalidTarget = await api(baseUrl, `/api/tasks/${id}/assignees/nobody/deadline`, { method: 'POST', token: adminToken, body: { deadline: futureDate(2) } });
    assert.equal(invalidTarget.status, 404, 'setting a deadline for someone not tagged on the task must fail');

    const ok = await api(baseUrl, `/api/tasks/${id}/assignees/bob/deadline`, { method: 'POST', token: adminToken, body: { deadline: futureDate(2) } });
    assert.equal(ok.status, 200);
    const task = await api(baseUrl, `/api/tasks/${id}`, { token: adminToken });
    assert.equal(task.data.assignees.find(a => a.username === 'bob').individual_deadline, futureDate(2));

    const cleared = await api(baseUrl, `/api/tasks/${id}/assignees/bob/deadline`, { method: 'POST', token: adminToken, body: { deadline: '' } });
    assert.equal(cleared.status, 200);
    const task2 = await api(baseUrl, `/api/tasks/${id}`, { token: adminToken });
    assert.equal(task2.data.assignees.find(a => a.username === 'bob').individual_deadline ?? null, null, 'clearing it should fall back to the task deadline again');
  });

  await t.test('a blocked task remains fully exempt even when an individual deadline has passed', async () => {
    const prereq = await api(baseUrl, '/api/tasks', { method: 'POST', token: adminToken, body: { title: 'Prereq For Individual Deadline Block Test', priority: 'low', deadline: futureDate(), assignedToList: ['bob'] } });
    const dependent = await api(baseUrl, '/api/tasks', {
      method: 'POST', token: adminToken,
      body: { title: 'Blocked Individual Deadline Test', priority: 'high', deadline: futureDate(30), assignedToList: ['bob'], dependsOnTaskId: prereq.data.id },
    });
    const raw = await getRawClient();
    await raw.query('UPDATE task_assignees SET individual_deadline=$1 WHERE task_id=$2 AND username=$3', [new Date(Date.now() - 3600000).toISOString().slice(0, 16), dependent.data.id, 'bob']);
    await raw.end();

    await api(baseUrl, '/api/tasks/send-reminders-now', { method: 'POST', token: adminToken });
    const bobNotifs = (await api(baseUrl, '/api/notifications', { token: bobToken })).data.items.filter(n => n.task_id === dependent.data.id && n.type.startsWith('deadline_'));
    assert.equal(bobNotifs.length, 0, 'a blocked task must stay exempt from deadline reminders even with an overdue individual deadline');
  });
});
