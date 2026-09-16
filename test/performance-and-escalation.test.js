const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');

test('performance statistics use submission date, never approval date', async (t) => {
  const { baseUrl, getRawClient, stop } = await startTestServer();
  t.after(() => stop());

  const adminToken = await login(baseUrl, 'admin', 'admin123');
  const aliceToken = await createMember(baseUrl, adminToken, 'alice', 'Alice');
  const bobToken = await createMember(baseUrl, adminToken, 'bob', 'Bob');

  const create = await api(baseUrl, '/api/tasks', { method: 'POST', token: aliceToken, body: { title: 'Old Submission Test', priority: 'low', deadline: futureDate(), assignedToList: ['bob'] } });
  const id = create.data.id;
  await api(baseUrl, `/api/tasks/${id}/submit-mine`, { method: 'POST', token: bobToken, body: { note: 'Submitted long ago, approved just now.' } });

  // Directly backdate the submission to 40 days ago — outside the "this month" bucket — while
  // approval happens for real, right now, through the actual API. If completion stats were
  // (incorrectly) keyed on approval date, this would show up in "this month." The exact claim
  // being verified: it must NOT.
  const raw = await getRawClient();
  const fortyDaysAgo = new Date(Date.now() - 40 * 86400000).toISOString();
  await raw.query('UPDATE task_assignees SET submitted_at=$1 WHERE task_id=$2 AND username=$3', [fortyDaysAgo, id, 'bob']);
  await raw.end();

  await api(baseUrl, `/api/tasks/${id}/approve/bob`, { method: 'POST', token: aliceToken });

  const stats = await api(baseUrl, '/api/reports/completion', { token: adminToken });
  const bobStats = stats.data.find(s => s.username === 'bob');
  assert.equal(bobStats.month, 0, 'a task submitted 40 days ago must not count in "this month," even though it was approved just now');
  assert.equal(bobStats.year, 1, 'it should still count in "this year," since 40 days ago is within the last year');
  assert.equal(bobStats.allTime, 1);
});

test('response time excludes hold/block time — only counts from release to submission', async (t) => {
  const { baseUrl, getRawClient, stop } = await startTestServer();
  t.after(() => stop());

  const adminToken = await login(baseUrl, 'admin', 'admin123');
  const aliceToken = await createMember(baseUrl, adminToken, 'alice', 'Alice');
  const bobToken = await createMember(baseUrl, adminToken, 'bob', 'Bob');

  const create = await api(baseUrl, '/api/tasks', {
    method: 'POST', token: aliceToken,
    body: { title: 'Response Time Test', priority: 'low', deadline: futureDate(), assignedToList: ['alice', 'bob'], stages: [{ usernames: ['alice'] }, { usernames: ['bob'] }] },
  });
  const id = create.data.id;

  // Bob sits on Level 2, on hold, for a long time (simulated: the task was created 20 days ago),
  // then gets released and submits almost immediately. If response time were measured from task
  // creation instead of from release, this would wrongly show ~20 days. It must show ~0.
  const raw = await getRawClient();
  const twentyDaysAgo = new Date(Date.now() - 20 * 86400000).toISOString();
  await raw.query('UPDATE tasks SET created_at=$1 WHERE id=$2', [twentyDaysAgo, id]);
  await raw.end();

  await api(baseUrl, `/api/tasks/${id}/submit-mine`, { method: 'POST', token: aliceToken, body: { note: 'Level 1 done.' } });
  await api(baseUrl, `/api/tasks/${id}/approve/alice`, { method: 'POST', token: aliceToken });
  // Level 2 (bob) is released only now, NOT 20 days ago — the real release moment.
  await api(baseUrl, `/api/tasks/${id}/release-stage/2`, { method: 'POST', token: aliceToken });
  await api(baseUrl, `/api/tasks/${id}/submit-mine`, { method: 'POST', token: bobToken, body: { note: 'Submitted right after being released.' } });
  await api(baseUrl, `/api/tasks/${id}/approve/bob`, { method: 'POST', token: aliceToken });

  const dashboard = await api(baseUrl, '/api/reports/my-dashboard?username=bob', { token: adminToken });
  assert.ok(dashboard.data.avgResponseDays !== null, 'bob should have a computed response time');
  assert.ok(dashboard.data.avgResponseDays < 1, `bob's response time should be under 1 day (measured from his real release moment, not the 20-day-old task creation) — got ${dashboard.data.avgResponseDays}`);
});

test('escalation thresholds (6hr/48hr/60hr) respect blocked/on-hold exemption and stay independent of deadline reminders', async (t) => {
  const { baseUrl, getRawClient, stop } = await startTestServer();
  t.after(() => stop());

  const adminToken = await login(baseUrl, 'admin', 'admin123');
  const aliceToken = await createMember(baseUrl, adminToken, 'alice', 'Alice');
  const bobToken = await createMember(baseUrl, adminToken, 'bob', 'Bob');

  await t.test('a task 49 hours old triggers the 48-hour warning, but not the 60-hour flag yet', async () => {
    const create = await api(baseUrl, '/api/tasks', { method: 'POST', token: aliceToken, body: { title: 'Forty-Nine Hours Old', priority: 'low', deadline: futureDate(30), assignedToList: ['bob'] } });
    const id = create.data.id;
    const raw = await getRawClient();
    await raw.query('UPDATE task_assignees SET escalation_baseline_at=$1 WHERE task_id=$2', [new Date(Date.now() - 49 * 3600000).toISOString(), id]);
    await raw.end();

    await api(baseUrl, '/api/tasks/send-reminders-now', { method: 'POST', token: adminToken });

    const bobNotifs = (await api(baseUrl, '/api/notifications', { token: bobToken })).data.items;
    assert.ok(bobNotifs.some(n => n.type === 'task_warning_urgent'), '48-hour urgent warning should have fired');

    const adminNotifs = (await api(baseUrl, '/api/notifications', { token: adminToken })).data.items;
    assert.ok(!adminNotifs.some(n => n.type === 'admin_late_flag' && n.message.includes('Forty-Nine')), '60-hour admin flag should NOT have fired yet at only 49 hours old');
  });

  await t.test('a blocked task is fully exempt from every escalation, even when very old', async () => {
    const prereq = await api(baseUrl, '/api/tasks', { method: 'POST', token: aliceToken, body: { title: 'Prereq For Block Test', priority: 'low', deadline: futureDate(), assignedToList: ['bob'] } });
    const dependent = await api(baseUrl, '/api/tasks', { method: 'POST', token: aliceToken, body: { title: 'Blocked And Old', priority: 'high', deadline: futureDate(), assignedToList: ['alice'], dependsOnTaskId: prereq.data.id } });

    const raw = await getRawClient();
    await raw.query('UPDATE tasks SET created_at=$1 WHERE id=$2', [new Date(Date.now() - 30 * 86400000).toISOString(), dependent.data.id]);
    await raw.query('UPDATE task_assignees SET escalation_baseline_at=$1 WHERE task_id=$2', [new Date(Date.now() - 30 * 86400000).toISOString(), dependent.data.id]);
    await raw.end();

    await api(baseUrl, '/api/tasks/send-reminders-now', { method: 'POST', token: adminToken });

    const aliceNotifs = (await api(baseUrl, '/api/notifications', { token: aliceToken })).data.items;
    const gotFlaggedForBlockedTask = aliceNotifs.some(n => n.task_id === dependent.data.id);
    assert.equal(gotFlaggedForBlockedTask, false, 'a blocked task, however old, must never trigger a reminder/escalation for the person waiting on it');
  });

  await t.test('deadline-based reminders are independent of age-based escalation', async () => {
    const create = await api(baseUrl, '/api/tasks', { method: 'POST', token: aliceToken, body: { title: 'Deadline Soon Test', priority: 'medium', deadline: futureDate(0), assignedToList: ['bob'] } });
    // A brand-new task (0 days old) — none of the age-based escalations should fire — but its
    // deadline is today, so the independent deadline-based reminder should fire on its own.
    await api(baseUrl, '/api/tasks/send-reminders-now', { method: 'POST', token: adminToken });
    const bobNotifs = (await api(baseUrl, '/api/notifications', { token: bobToken })).data.items;
    const thisTasksNotifs = bobNotifs.filter(n => n.task_id === create.data.id);
    assert.ok(thisTasksNotifs.every(n => n.type !== 'task_reminder_recurring'), 'a brand-new task must not trigger the age-based recurring reminder before 6 hours have passed');
  });
});
