const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');

test('changing a task deadline and working with untagged tasks', async (t) => {
  const { baseUrl, stop, getRawClient } = await startTestServer();
  t.after(() => stop());
  const admin = await login(baseUrl, 'admin', 'admin123');
  const creator = await createMember(baseUrl, admin, 'creator1', 'Creator One', 'Estimation');
  const worker = await createMember(baseUrl, admin, 'worker1', 'Worker One', 'Estimation');
  const other = await createMember(baseUrl, admin, 'other1', 'Other One', 'Estimation');

  const task = await api(baseUrl, '/api/tasks', { method: 'POST', token: creator, body: { title: 'Deadline task', deadline: futureDate(5), assignedToList: ['worker1'] } });

  await t.test('creator can change the deadline; worker is notified; reminder flags reset', async () => {
    const raw = await getRawClient();
    await raw.query("UPDATE tasks SET deadline_reminder_sent=1, deadline_overdue_notified=1 WHERE id=$1", [task.data.id]);
    await raw.query("UPDATE task_assignees SET deadline_reminder_24h_sent_at='x' WHERE task_id=$1", [task.data.id]);
    const newDate = futureDate(20) + 'T15:00';
    const r = await api(baseUrl, `/api/tasks/${task.data.id}/deadline`, { method: 'POST', token: creator, body: { deadline: newDate, reason: 'Slab cycle shifted' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const row = (await raw.query('SELECT deadline, deadline_reminder_sent, deadline_overdue_notified FROM tasks WHERE id=$1', [task.data.id])).rows[0];
    assert.equal(row.deadline, newDate); assert.equal(row.deadline_reminder_sent, 0); assert.equal(row.deadline_overdue_notified, 0);
    const a = (await raw.query('SELECT deadline_reminder_24h_sent_at FROM task_assignees WHERE task_id=$1', [task.data.id])).rows[0];
    assert.equal(a.deadline_reminder_24h_sent_at, null);
    const audit = await raw.query("SELECT details FROM audit_log WHERE action='task_deadline_changed'");
    assert.ok(audit.rows[0].details.includes('Slab cycle shifted'));
    await raw.end();
    const n = (await api(baseUrl, '/api/notifications', { token: worker })).data.items;
    assert.ok(n.some(x => /changed the deadline/.test(x.message)));
  });

  await t.test('only creator/admin can change it, and the date must be valid', async () => {
    assert.equal((await api(baseUrl, `/api/tasks/${task.data.id}/deadline`, { method: 'POST', token: worker, body: { deadline: futureDate(9) } })).status, 403);
    assert.equal((await api(baseUrl, `/api/tasks/${task.data.id}/deadline`, { method: 'POST', token: other, body: { deadline: futureDate(9) } })).status, 403);
    assert.equal((await api(baseUrl, `/api/tasks/${task.data.id}/deadline`, { method: 'POST', token: creator, body: { deadline: 'not-a-date' } })).status, 400);
    assert.equal((await api(baseUrl, `/api/tasks/${task.data.id}/deadline`, { method: 'POST', token: admin, body: { deadline: futureDate(30) } })).status, 200);
  });

  await t.test('an untagged task can have people added later, who then see it and can work on it', async () => {
    const u = await api(baseUrl, '/api/tasks', { method: 'POST', token: creator, body: { title: 'Untagged schedule item', deadline: futureDate(10), assignedToList: [] } });
    assert.equal(u.status, 200);
    assert.ok(!(await api(baseUrl, '/api/tasks/mine', { token: worker })).data.some(x => x.id === u.data.id));
    const add = await api(baseUrl, `/api/tasks/${u.data.id}/assignees`, { method: 'POST', token: creator, body: { usernames: ['worker1'] } });
    assert.equal(add.status, 200);
    const mine = (await api(baseUrl, '/api/tasks/mine', { token: worker })).data.find(x => x.id === u.data.id);
    assert.ok(mine, 'worker now sees it');
    assert.equal(mine.assignees[0].is_released, 1);
    const sub = await api(baseUrl, `/api/tasks/${u.data.id}/submit-mine`, { method: 'POST', token: worker, body: { note: 'quantities done' } });
    assert.equal(sub.status, 200, JSON.stringify(sub.data));
    // and the last person can be removed again (untagged is a valid state) if they haven't submitted
    const t2 = await api(baseUrl, '/api/tasks', { method: 'POST', token: creator, body: { title: 'Remove last', deadline: futureDate(10), assignedToList: ['other1'] } });
    assert.equal((await api(baseUrl, `/api/tasks/${t2.data.id}/assignees/other1`, { method: 'DELETE', token: creator })).status, 200);
  });

  await t.test('batched task lists return the same shape as the single-task endpoint', async () => {
    const list = (await api(baseUrl, '/api/tasks', { token: admin })).data.find(x => x.id === task.data.id);
    const single = (await api(baseUrl, `/api/tasks/${task.data.id}`, { token: admin })).data;
    for (const k of ['assignees', 'followups', 'checklist', 'replies', 'subtasks', 'blocked', 'title', 'deadline']) assert.ok(k in list, k);
    assert.equal(list.attachment, undefined, 'list never ships attachment data');
    assert.deepEqual(list.assignees.map(a => a.username), single.assignees.map(a => a.username));
  });
});
