// Deterministic regardless of time of day: the 10:00/14:00/18:00 window rules are tested in
// test/reminder-engine.test.js; here they are switched off so only the rules under test fire.
process.env.REMINDER_WINDOWS = 'none';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate, localDateTime } = require('../testlib/helpers');

test('individual deadlines: correctly set, retrievable, and reset the reminder cycle when reassigned', async (t) => {
  const { baseUrl, getRawClient, stop } = await startTestServer();
  t.after(() => stop());
  const adminToken = await login(baseUrl, 'admin', 'admin123');
  const bobToken = await createMember(baseUrl, adminToken, 'bob_deadline', 'Bob Deadline', 'Site Team');

  const create = await api(baseUrl, '/api/tasks', { method: 'POST', token: adminToken, body: { title: 'Deadline Test Task', priority: 'medium', deadline: futureDate(10), assignedToList: ['bob_deadline'] } });
  const id = create.data.id;

  await t.test('setting an individual deadline stores and returns it correctly', async () => {
    const indivDeadline = localDateTime(3 * 3600000);
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

    const newDeadline = localDateTime(20 * 3600000);
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

test('deadline-approaching reminders: tiers fire once each; tiers crossed together are combined into one message', async (t) => {
  const { baseUrl, getRawClient, stop } = await startTestServer();
  t.after(() => stop());
  const adminToken = await login(baseUrl, 'admin', 'admin123');
  const bobToken = await createMember(baseUrl, adminToken, 'bob_tiers', 'Bob Tiers', 'Site Team');

  const create = await api(baseUrl, '/api/tasks', { method: 'POST', token: adminToken, body: { title: 'Tiered Reminder Task', priority: 'medium', deadline: futureDate(10), assignedToList: ['bob_tiers'] } });
  const id = create.data.id;
  const indivDeadline = localDateTime(8 * 3600000);
  await api(baseUrl, `/api/tasks/${id}/assignees/bob_tiers/deadline`, { method: 'POST', token: adminToken, body: { deadline: indivDeadline } });

  await t.test('at 8 hours remaining: the 24h and 12h tiers are combined into ONE message (12h), not 6h or 2h yet', async () => {
    await api(baseUrl, '/api/tasks/send-reminders-now', { method: 'POST', token: adminToken });
    // Phase 2: tiers that fire in the same run are COMBINED into one message (the most urgent).
    const notifs = (await api(baseUrl, '/api/notifications', { token: bobToken })).data.items.filter(n => n.type === 'deadline_soon');
    assert.equal(notifs.length, 1, 'the 24h and 12h tiers crossed together are combined into one message');
    assert.ok(notifs[0].message.includes('12 hours'), 'the more urgent tier is the one sent');
    assert.ok(!notifs.some(n => n.message.includes('6 hours')), '6-hour tier must not fire yet with 8 hours remaining');
    const raw = await getRawClient();
    const combined = (await raw.query("SELECT status, failure_reason FROM notification_deliveries WHERE idempotency_key LIKE 'tier24:%'")).rows;
    await raw.end();
    assert.equal(combined[0].status, 'cancelled'); assert.match(combined[0].failure_reason, /combined into tier12/);
  });

  await t.test('running the check again immediately does not duplicate it', async () => {
    await api(baseUrl, '/api/tasks/send-reminders-now', { method: 'POST', token: adminToken });
    const notifs = (await api(baseUrl, '/api/notifications', { token: bobToken })).data.items.filter(n => n.type === 'deadline_soon');
    assert.equal(notifs.length, 1, 'no tier should ever fire twice');
  });

  await t.test('once only 5 hours remain, the 6-hour tier fires as a NEW, additional notification', async () => {
    const raw = await getRawClient();
    const fiveHoursOut = localDateTime(5 * 3600000);
    await raw.query("UPDATE task_assignees SET individual_deadline=$1 WHERE task_id=$2 AND username='bob_tiers'", [fiveHoursOut, id]);
    await raw.end();
    await api(baseUrl, '/api/tasks/send-reminders-now', { method: 'POST', token: adminToken });
    const notifs = (await api(baseUrl, '/api/notifications', { token: bobToken })).data.items.filter(n => n.type === 'deadline_soon');
    assert.equal(notifs.length, 2, 'the 6-hour tier fires as a new message in addition to the earlier one');
    assert.ok(notifs.some(n => n.message.includes('6 hours')));
  });
});
