const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');

test('hour-based escalation: 6hr recurring reminder, 48hr urgent warning, 60hr admin+HR flag', async (t) => {
  const { baseUrl, getRawClient, stop } = await startTestServer();
  t.after(() => stop());
  const adminToken = await login(baseUrl, 'admin', 'admin123');
  const hrToken = await createMember(baseUrl, adminToken, 'hr_hourtest', 'HR Hour Test', 'HR Department');
  const lateToken = await createMember(baseUrl, adminToken, 'late_hour_person', 'Late Hour Person', 'Site Team');

  const create = await api(baseUrl, '/api/tasks', { method: 'POST', token: adminToken, body: { title: 'Hourly Escalation Task', priority: 'medium', deadline: futureDate(), assignedToList: ['late_hour_person'] } });
  const id = create.data.id;

  await t.test('at 7 hours: the 6-hour recurring reminder has fired once', async () => {
    const raw = await getRawClient();
    await raw.query('UPDATE task_assignees SET escalation_baseline_at=$1 WHERE task_id=$2', [new Date(Date.now() - 7 * 3600000).toISOString(), id]);
    await raw.end();
    await api(baseUrl, '/api/tasks/send-reminders-now', { method: 'POST', token: adminToken });
    const notifs = (await api(baseUrl, '/api/notifications', { token: lateToken })).data.items;
    const recurring = notifs.filter(n => n.type === 'task_reminder_recurring');
    assert.equal(recurring.length, 1, 'exactly one recurring reminder should have fired at 7 hours');
  });

  await t.test('at 13 hours (6 more since the last reminder): the recurring reminder fires AGAIN', async () => {
    const raw = await getRawClient();
    await raw.query('UPDATE task_assignees SET escalation_baseline_at=$1, last_recurring_reminder_at=$2 WHERE task_id=$3',
      [new Date(Date.now() - 13 * 3600000).toISOString(), new Date(Date.now() - 6.5 * 3600000).toISOString(), id]);
    await raw.end();
    await api(baseUrl, '/api/tasks/send-reminders-now', { method: 'POST', token: adminToken });
    const notifs = (await api(baseUrl, '/api/notifications', { token: lateToken })).data.items;
    const recurring = notifs.filter(n => n.type === 'task_reminder_recurring');
    assert.equal(recurring.length, 2, 'a second recurring reminder must fire once another 6 hours have passed since the last one');
  });

  await t.test('at 49 hours: the urgent 48-hour warning fires, explicitly mentioning the coming admin flag', async () => {
    const raw = await getRawClient();
    await raw.query('UPDATE task_assignees SET escalation_baseline_at=$1 WHERE task_id=$2', [new Date(Date.now() - 49 * 3600000).toISOString(), id]);
    await raw.end();
    await api(baseUrl, '/api/tasks/send-reminders-now', { method: 'POST', token: adminToken });
    const notifs = (await api(baseUrl, '/api/notifications', { token: lateToken })).data.items;
    const urgent = notifs.find(n => n.type === 'task_warning_urgent');
    assert.ok(urgent, 'the 48-hour urgent warning must fire');
    assert.ok(urgent.message.toLowerCase().includes('flagged'), 'the urgent warning must explicitly mention the coming flag to Admin');
  });

  await t.test('at 61 hours: HR and Admin are both flagged with the task name and assigned date; the person only sees a generic flag notice', async () => {
    const raw = await getRawClient();
    const assignedAt = new Date(Date.now() - 61 * 3600000);
    await raw.query('UPDATE task_assignees SET escalation_baseline_at=$1 WHERE task_id=$2', [assignedAt.toISOString(), id]);
    await raw.end();
    await api(baseUrl, '/api/tasks/send-reminders-now', { method: 'POST', token: adminToken });

    const hrNotifs = (await api(baseUrl, '/api/notifications', { token: hrToken })).data.items;
    const hrFlag = hrNotifs.find(n => n.type === 'admin_late_flag' && n.message.includes('late_hour_person'));
    assert.ok(hrFlag, 'HR must be flagged at 60 hours');
    assert.ok(hrFlag.message.includes('Hourly Escalation Task'), 'the flag must name the actual task');
    const expectedDateStr = assignedAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    assert.ok(hrFlag.message.includes(expectedDateStr), 'the flag must state the date the task was assigned');

    const adminNotifs = (await api(baseUrl, '/api/notifications', { token: adminToken })).data.items;
    assert.ok(adminNotifs.some(n => n.type === 'admin_late_flag' && n.message.includes('late_hour_person')), 'Admin must also be flagged at 60 hours');

    const personNotifs = (await api(baseUrl, '/api/notifications', { token: lateToken })).data.items;
    const personFlag = personNotifs.find(n => n.type === 'task_flagged');
    assert.equal(personFlag.message, 'You are flagged for incompletion of "Hourly Escalation Task".');
    assert.ok(!personFlag.message.toLowerCase().includes('hr') && !personFlag.message.toLowerCase().includes('admin'), 'the person themselves must never be told HR/Admin specifically were notified');
  });

  await t.test('running the check again does not duplicate the 48hr or 60hr one-time notifications', async () => {
    const before = (await api(baseUrl, '/api/notifications', { token: lateToken })).data.items.filter(n => n.type === 'task_warning_urgent' || n.type === 'task_flagged').length;
    await api(baseUrl, '/api/tasks/send-reminders-now', { method: 'POST', token: adminToken });
    const after = (await api(baseUrl, '/api/notifications', { token: lateToken })).data.items.filter(n => n.type === 'task_warning_urgent' || n.type === 'task_flagged').length;
    assert.equal(after, before, 'one-time thresholds must never fire twice');
  });
});

test('escalation baseline starts at release time for a staged assignee, not task creation', async (t) => {
  const { baseUrl, getRawClient, stop } = await startTestServer();
  t.after(() => stop());
  const adminToken = await login(baseUrl, 'admin', 'admin123');
  await createMember(baseUrl, adminToken, 'stage1_hour', 'Stage1 Hour', 'Site Team');
  const stage2Token = await createMember(baseUrl, adminToken, 'stage2_hour', 'Stage2 Hour', 'Site Team');

  const create = await api(baseUrl, '/api/tasks', { method: 'POST', token: adminToken, body: { title: 'Staged Hourly Task', priority: 'medium', deadline: futureDate(), stages: [{ usernames: ['stage1_hour'] }, { usernames: ['stage2_hour'] }] } });
  const id = create.data.id;

  // Backdate the WHOLE task's creation far in the past — if the baseline incorrectly used task
  // creation time instead of actual release time, this would immediately trigger escalation for
  // the still-on-hold stage 2 person.
  const raw = await getRawClient();
  await raw.query("UPDATE tasks SET created_at=$1 WHERE id=$2", [new Date(Date.now() - 100 * 3600000).toISOString(), id]);
  await raw.query("UPDATE task_assignees SET escalation_baseline_at=$1 WHERE task_id=$2 AND username='stage1_hour'", [new Date(Date.now() - 100 * 3600000).toISOString(), id]);
  await raw.end();

  await api(baseUrl, '/api/tasks/send-reminders-now', { method: 'POST', token: adminToken });
  const stage2Notifs = (await api(baseUrl, '/api/notifications', { token: stage2Token })).data.items;
  assert.equal(stage2Notifs.filter(n => n.type.startsWith('task_reminder') || n.type.startsWith('task_warning') || n.type === 'task_flagged').length, 0,
    'a still-on-hold stage 2 person must never be escalated, no matter how old the task itself is');
});
