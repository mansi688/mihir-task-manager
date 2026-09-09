const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');

test('task creation transaction: a mid-sequence failure leaves NO partial task, assignees, or notifications behind', async (t) => {
  const { baseUrl, stop } = await startTestServer();
  t.after(() => stop());
  const adminToken = await login(baseUrl, 'admin', 'admin123');
  await createMember(baseUrl, adminToken, 'alice', 'Alice');

  const db = require('../backend/db');
  const beforeTaskCount = (await db.listAllTasks()).length;

  let threw = false;
  try {
    await db.runInTransaction(async (tx) => {
      await db.createTask({
        id: 'TASK-ROLLBACK-TEST', title: 'Should Not Survive', priority: 'medium',
        deadline: futureDate(), created_by: 'Admin', created_by_username: 'admin',
      }, tx);
      await db.addTaskAssignee('TASK-ROLLBACK-TEST', 'alice', 'Sales', 1, true, null, tx);
      throw new Error('Simulated failure partway through');
    });
  } catch (e) {
    threw = true;
  }

  assert.ok(threw, 'the error must still propagate, not be silently swallowed');
  const afterTaskCount = (await db.listAllTasks()).length;
  assert.equal(afterTaskCount, beforeTaskCount, 'no task row should exist after a rolled-back transaction');
  assert.equal(await db.getTask('TASK-ROLLBACK-TEST'), undefined, 'the specific task must not exist at all');
  assert.equal((await db.listAssignees('TASK-ROLLBACK-TEST')).length, 0, 'no assignee row should have survived either');
});

test('a genuinely successful task creation still commits everything together, as normal', async (t) => {
  const { baseUrl, stop } = await startTestServer();
  t.after(() => stop());
  const adminToken = await login(baseUrl, 'admin', 'admin123');
  const bobToken = await createMember(baseUrl, adminToken, 'bob', 'Bob');

  const create = await api(baseUrl, '/api/tasks', { method: 'POST', token: adminToken, body: { title: 'Normal Task', priority: 'medium', deadline: futureDate(), assignedToList: ['bob'] } });
  assert.equal(create.status, 200);

  const notifs = (await api(baseUrl, '/api/notifications', { token: bobToken })).data.items;
  assert.ok(notifs.some(n => n.task_id === create.data.id), 'the normal, successful path must still create the notification as before');
});
