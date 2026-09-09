const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');

test('day-5 escalation flags BOTH HR and Admin, and tells the person only that THEY are flagged for that task — never mentioning HR/Admin', async (t) => {
  const { baseUrl, dbPath, stop } = startTestServer();
  t.after(() => stop());
  const adminToken = await login(baseUrl, 'admin', 'admin123');
  const hrToken = await createMember(baseUrl, adminToken, 'hr_escalation_test', 'HR Escalation Test', 'HR Department');
  const lateToken = await createMember(baseUrl, adminToken, 'late_person', 'Late Person', 'Site Team');

  const create = await api(baseUrl, '/api/tasks', { method: 'POST', token: adminToken, body: { title: 'Overdue Task', priority: 'medium', deadline: futureDate(), assignedToList: ['late_person'] } });
  const id = create.data.id;

  // Backdate the task's escalation clock to 6 days ago, so the day-5 threshold has been crossed.
  const raw = new Database(dbPath);
  raw.prepare('UPDATE task_assignees SET escalation_baseline_at=? WHERE task_id=?').run(new Date(Date.now() - 6 * 86400000).toISOString(), id);
  raw.close();

  await api(baseUrl, '/api/tasks/send-reminders-now', { method: 'POST', token: adminToken });

  await t.test('HR receives the flag notification', async () => {
    const hrNotifs = await api(baseUrl, '/api/notifications', { token: hrToken });
    assert.ok(hrNotifs.data.items.some(n => n.type === 'admin_late_flag' && n.message.includes('late_person') && n.message.includes('5 days')), 'HR must be notified when someone hits the 5-day threshold');
  });

  await t.test('Admin also receives the flag notification', async () => {
    const adminNotifs = await api(baseUrl, '/api/notifications', { token: adminToken });
    assert.ok(adminNotifs.data.items.some(n => n.type === 'admin_late_flag' && n.message.includes('late_person')), 'Admin must still be notified too');
  });

  await t.test('the flagged person is told only that they are flagged for this task, never that HR/Admin specifically were notified', async () => {
    const lateNotifs = await api(baseUrl, '/api/notifications', { token: lateToken });
    const flagNotif = lateNotifs.data.items.find(n => n.type === 'task_flagged');
    assert.ok(flagNotif, 'the person must receive their own notification at the 5-day mark');
    assert.equal(flagNotif.message, 'You are flagged for incompletion of "Overdue Task".');
    assert.ok(!flagNotif.message.toLowerCase().includes('hr'), 'must never reveal HR visibility to the flagged person');
    assert.ok(!flagNotif.message.toLowerCase().includes('admin'), 'must never reveal Admin visibility to the flagged person');
  });

  await t.test('this same person now shows as red-flagged on the HR roster', async () => {
    const roster = (await api(baseUrl, '/api/reports/hr-roster', { token: hrToken })).data.roster;
    const entry = roster.find(r => r.username === 'late_person');
    assert.equal(entry.isPendingRedFlag, true, 'a real 5-day escalation must show up as a red flag on the roster');
  });
});

test('performance statistics use submission date, never approval date', async (t) => {
  const { baseUrl, dbPath, stop } = startTestServer();
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
  const raw = new Database(dbPath);
  const fortyDaysAgo = new Date(Date.now() - 40 * 86400000).toISOString();
  raw.prepare('UPDATE task_assignees SET submitted_at=? WHERE task_id=? AND username=?').run(fortyDaysAgo, id, 'bob');
  raw.close();

  await api(baseUrl, `/api/tasks/${id}/approve/bob`, { method: 'POST', token: aliceToken });

  const stats = await api(baseUrl, '/api/reports/completion', { token: adminToken });
  const bobStats = stats.data.find(s => s.username === 'bob');
  assert.equal(bobStats.month, 0, 'a task submitted 40 days ago must not count in "this month," even though it was approved just now');
  assert.equal(bobStats.year, 1, 'it should still count in "this year," since 40 days ago is within the last year');
  assert.equal(bobStats.allTime, 1);
});

test('response time excludes hold/block time — only counts from release to submission', async (t) => {
  const { baseUrl, dbPath, stop } = startTestServer();
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
  const raw = new Database(dbPath);
  const twentyDaysAgo = new Date(Date.now() - 20 * 86400000).toISOString();
  raw.prepare('UPDATE tasks SET created_at=? WHERE id=?').run(twentyDaysAgo, id);
  raw.close();

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

test('escalation thresholds (3/5/7/12-day) fire at the right times and respect blocked/on-hold exemption', async (t) => {
  const { baseUrl, dbPath, stop } = startTestServer();
  t.after(() => stop());

  const adminToken = await login(baseUrl, 'admin', 'admin123');
  const aliceToken = await createMember(baseUrl, adminToken, 'alice', 'Alice');
  const bobToken = await createMember(baseUrl, adminToken, 'bob', 'Bob');

  await t.test('a task 6 days old triggers the 3-day and 5-day flags, but not 7 or 12 yet', async () => {
    const create = await api(baseUrl, '/api/tasks', { method: 'POST', token: aliceToken, body: { title: 'Six Days Old', priority: 'low', deadline: futureDate(30), assignedToList: ['bob'] } });
    const id = create.data.id;
    const raw = new Database(dbPath);
    raw.prepare('UPDATE task_assignees SET escalation_baseline_at=? WHERE task_id=?').run(new Date(Date.now() - 6 * 86400000).toISOString(), id);
    raw.close();

    await api(baseUrl, '/api/tasks/send-reminders-now', { method: 'POST', token: adminToken });

    const bobNotifs = (await api(baseUrl, '/api/notifications', { token: bobToken })).data.items;
    assert.ok(bobNotifs.some(n => n.type === 'task_reminder_3day'), '3-day reminder should have fired');

    const adminNotifs = (await api(baseUrl, '/api/notifications', { token: adminToken })).data.items;
    assert.ok(adminNotifs.some(n => n.type === 'admin_late_flag' && n.message.includes('5 days')), '5-day admin flag should have fired');
    assert.ok(!adminNotifs.some(n => n.message.includes('7 days')), '7-day flag should NOT have fired yet at only 6 days old');
  });

  await t.test('a blocked task is fully exempt from every escalation, even when very old', async () => {
    const prereq = await api(baseUrl, '/api/tasks', { method: 'POST', token: aliceToken, body: { title: 'Prereq For Block Test', priority: 'low', deadline: futureDate(), assignedToList: ['bob'] } });
    const dependent = await api(baseUrl, '/api/tasks', { method: 'POST', token: aliceToken, body: { title: 'Blocked And Old', priority: 'high', deadline: futureDate(), assignedToList: ['alice'], dependsOnTaskId: prereq.data.id } });

    const raw = new Database(dbPath);
    raw.prepare('UPDATE tasks SET created_at=? WHERE id=?').run(new Date(Date.now() - 30 * 86400000).toISOString(), dependent.data.id);
    raw.prepare('UPDATE task_assignees SET escalation_baseline_at=? WHERE task_id=?').run(new Date(Date.now() - 30 * 86400000).toISOString(), dependent.data.id);
    raw.close();

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
    assert.ok(thisTasksNotifs.every(n => n.type !== 'task_reminder_3day'), 'a brand-new task must not trigger the age-based 3-day reminder');
  });
});
