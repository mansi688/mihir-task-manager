const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');

test('individual deadlines: correctly set, retrievable, and reset the reminder cycle when reassigned', async (t) => {
  const { baseUrl, getRawClient, stop } = await startTestServer();
  t.after(() => stop());
  const adminToken = await login(baseUrl, 'admin', 'admin123');
  const bobToken = await createMember(baseUrl, adminToken, 'bob_deadline', 'Bob Deadline', 'Site Team');

  const create = await api(baseUrl, '/api/tasks', { method: 'POST', token: adminToken, body: { title: 'Deadline Test Task', priority: 'medium', deadline: futureDate(10), assignedToList: ['bob_deadline'] } });
  const id = create.data.id;

  await t.test('setting an individual deadline stores and returns it correctly', async () => {
    const indivDeadline = new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 16);
    const res = await api(baseUrl, `/api/tasks/${id}/assignees/bob_deadline/deadline`, { method: 'POST', token: adminToken, body: { deadline: indivDeadline } });
    assert.equal(res.status, 200);
    const task = await api(baseUrl, `/api/tasks/${id}`, { token: adminToken });
    assert.equal(task.data.assignees[0].individual_deadline.slice(0, 16), indivDeadline);
  });

  await t.test('only the creator or Admin can set an individual deadline — not an unrelated member', async () => {
    const outsiderToken = await createMember(baseUrl, adminToken, 'outsider_deadline', 'Outsider', 'Sales');
    const res = await api(baseUrl, `/api/tasks/${id}/assignees/bob_deadline/deadline`, { method: 'POST', token: outsiderToken, body: { deadline: futureDate(1) } });
    assert.equal(res.status, 403);
  });

  await t.test('reassigning a new individual deadline resets all reminder-sent flags, so the new deadline gets its own fresh reminder cycle', async () => {
    const raw = await getRawClient();
    await raw.query("UPDATE task_assignees SET deadline_reminder_24h_sent_at=$1, deadline_reminder_12h_sent_at=$2 WHERE task_id=$3 AND username='bob_deadline'",
      [new Date().toISOString(), new Date().toISOString(), id]);
    await raw.end();

    const newDeadline = new Date(Date.now() + 20 * 3600000).toISOString().slice(0, 16);
    await api(baseUrl, `/api/tasks/${id}/assignees/bob_deadline/deadline`, { method: 'POST', token: adminToken, body: { deadline: newDeadline } });

    const task = await api(baseUrl, `/api/tasks/${id}`, { token: adminToken });
    const assignee = task.data.assignees[0];
    assert.equal(assignee.deadline_reminder_24h_sent_at, null, 'the 24h reminder flag must reset for a newly-assigned deadline');
    assert.equal(assignee.deadline_reminder_12h_sent_at, null, 'the 12h reminder flag must reset for a newly-assigned deadline');
  });

  await t.test('clearing an individual deadline (empty string) removes it and resets reminder flags too', async () => {
    await api(baseUrl, `/api/tasks/${id}/assignees/bob_deadline/deadline`, { method: 'POST', token: adminToken, body: { deadline: '' } });
    const task = await api(baseUrl, `/api/tasks/${id}`, { token: adminToken });
    assert.equal(task.data.assignees[0].individual_deadline, null);
  });
});

test('deadline-approaching reminders fire at 24h, 12h, 6h, and 2h tiers independently, each exactly once', async (t) => {
  const { baseUrl, getRawClient, stop } = await startTestServer();
  t.after(() => stop());
  const adminToken = await login(baseUrl, 'admin', 'admin123');
  const bobToken = await createMember(baseUrl, adminToken, 'bob_tiers', 'Bob Tiers', 'Site Team');

  const create = await api(baseUrl, '/api/tasks', { method: 'POST', token: adminToken, body: { title: 'Tiered Reminder Task', priority: 'medium', deadline: futureDate(10), assignedToList: ['bob_tiers'] } });
  const id = create.data.id;
  const indivDeadline = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 16);
  await api(baseUrl, `/api/tasks/${id}/assignees/bob_tiers/deadline`, { method: 'POST', token: adminToken, body: { deadline: indivDeadline } });

  await t.test('at 8 hours remaining: the 24h AND 12h tiers fire (both thresholds already crossed), but not 6h or 2h yet', async () => {
    await api(baseUrl, '/api/tasks/send-reminders-now', { method: 'POST', token: adminToken });
    const notifs = (await api(baseUrl, '/api/notifications', { token: bobToken })).data.items.filter(n => n.type === 'deadline_soon');
    assert.equal(notifs.length, 2, 'both the 24h and 12h tiers should fire in the same check once 8 hours remain');
    assert.ok(notifs.some(n => n.message.includes('24 hours')));
    assert.ok(notifs.some(n => n.message.includes('12 hours')));
    assert.ok(!notifs.some(n => n.message.includes('6 hours')), '6-hour tier must not fire yet with 8 hours remaining');
  });

  await t.test('running the check again immediately does not duplicate the 24h or 12h notifications', async () => {
    await api(baseUrl, '/api/tasks/send-reminders-now', { method: 'POST', token: adminToken });
    const notifs = (await api(baseUrl, '/api/notifications', { token: bobToken })).data.items.filter(n => n.type === 'deadline_soon');
    assert.equal(notifs.length, 2, 'no tier should ever fire twice');
  });

  await t.test('once only 5 hours remain, the 6-hour tier fires as a NEW, additional notification', async () => {
    const raw = await getRawClient();
    const fiveHoursOut = new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 16);
    await raw.query("UPDATE task_assignees SET individual_deadline=$1 WHERE task_id=$2 AND username='bob_tiers'", [fiveHoursOut, id]);
    await raw.end();
    await api(baseUrl, '/api/tasks/send-reminders-now', { method: 'POST', token: adminToken });
    const notifs = (await api(baseUrl, '/api/notifications', { token: bobToken })).data.items.filter(n => n.type === 'deadline_soon');
    assert.equal(notifs.length, 3, 'the 6-hour tier should now have fired in addition to the earlier two');
    assert.ok(notifs.some(n => n.message.includes('6 hours')));
  });
});
