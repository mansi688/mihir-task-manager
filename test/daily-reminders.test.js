const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');

test('daily reminders fire for an ongoing task, and stop the moment the person completes their part', async (t) => {
  const { baseUrl, getRawClient, stop } = await startTestServer();
  t.after(() => stop());

  const adminToken = await login(baseUrl, 'admin', 'admin123');
  const aliceToken = await createMember(baseUrl, adminToken, 'alice', 'Alice');
  const bobToken = await createMember(baseUrl, adminToken, 'bob', 'Bob');

  const create = await api(baseUrl, '/api/tasks', { method: 'POST', token: aliceToken, body: { title: 'Daily Reminder Test', priority: 'medium', deadline: futureDate(10), assignedToList: ['bob'] } });
  const id = create.data.id;

  await t.test('a reminder fires while the task is still open and not yet done', async () => {
    await api(baseUrl, '/api/tasks/send-reminders-now', { method: 'POST', token: adminToken });
    const notifs = (await api(baseUrl, '/api/notifications', { token: bobToken })).data.items;
    assert.ok(notifs.some(n => n.type === 'task_reminder' && n.task_id === id), 'a reminder should fire for an ongoing, incomplete task');
  });

  await t.test('running the check again immediately does NOT send a second reminder within the same day', async () => {
    await api(baseUrl, '/api/tasks/send-reminders-now', { method: 'POST', token: adminToken });
    const notifs = (await api(baseUrl, '/api/notifications', { token: bobToken })).data.items;
    const reminderCount = notifs.filter(n => n.type === 'task_reminder' && n.task_id === id).length;
    assert.equal(reminderCount, 1, 'reminders repeat daily, not on every single check — running the check twice in a row must not double-send');
  });

  await t.test('a fresh day, still incomplete, gets another reminder', async () => {
    const raw = await getRawClient();
    await raw.query('UPDATE task_assignees SET last_reminded_at=$1 WHERE task_id=$2', [new Date(Date.now() - 25 * 3600000).toISOString(), id]);
    await raw.end();
    await api(baseUrl, '/api/tasks/send-reminders-now', { method: 'POST', token: adminToken });
    const notifs = (await api(baseUrl, '/api/notifications', { token: bobToken })).data.items;
    const reminderCount = notifs.filter(n => n.type === 'task_reminder' && n.task_id === id).length;
    assert.equal(reminderCount, 2, 'a full day later, still incomplete, should get a second daily reminder');
  });

  await t.test('once the person completes their part, reminders stop immediately — even the same day', async () => {
    await api(baseUrl, `/api/tasks/${id}/submit-mine`, { method: 'POST', token: bobToken, body: { note: 'Work is fully done and verified.' } });
    await api(baseUrl, `/api/tasks/${id}/approve/bob`, { method: 'POST', token: aliceToken });

    // Task auto-closed (single assignee) — notifications for it were already cleared by that.
    // Force the reminder check again to prove no NEW reminder gets created for this now-done task.
    await api(baseUrl, '/api/tasks/send-reminders-now', { method: 'POST', token: adminToken });
    const notifs = (await api(baseUrl, '/api/notifications', { token: bobToken })).data.items;
    const stillHasReminders = notifs.some(n => n.task_id === id);
    assert.equal(stillHasReminders, false, 'once completed and closed, no further reminders should ever fire for this task, and old ones should be gone');
  });
});
