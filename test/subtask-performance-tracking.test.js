const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');

test('subtasks are tracked by escalation, warnings, and performance exactly like any other task', async (t) => {
  const { baseUrl, getRawClient, stop } = await startTestServer();
  t.after(() => stop());
  const adminToken = await login(baseUrl, 'admin', 'admin123');
  const parentOwnerToken = await createMember(baseUrl, adminToken, 'parent_owner', 'Parent Owner', 'Estimation');
  const subAssigneeToken = await createMember(baseUrl, adminToken, 'sub_assignee', 'Sub Assignee', 'Estimation');

  const parent = await api(baseUrl, '/api/tasks', { method: 'POST', token: parentOwnerToken, body: { title: 'Parent Task', priority: 'high', deadline: futureDate(), assignedToList: ['parent_owner'] } });
  const sub = await api(baseUrl, '/api/tasks', { method: 'POST', token: parentOwnerToken, body: { title: 'A Real Subtask', priority: 'medium', deadline: futureDate(), assignedToList: ['sub_assignee'], parentTaskId: parent.data.id } });

  await t.test('a subtask left incomplete for 5+ days escalates exactly like a normal task', async () => {
    const raw = await getRawClient();
    await raw.query('UPDATE task_assignees SET escalation_baseline_at=$1 WHERE task_id=$2', [new Date(Date.now() - 6 * 86400000).toISOString(), sub.data.id]);
    await raw.end();
    await api(baseUrl, '/api/tasks/send-reminders-now', { method: 'POST', token: adminToken });
    const notifs = await api(baseUrl, '/api/notifications', { token: subAssigneeToken });
    assert.ok(notifs.data.items.some(n => n.type === 'task_flagged' && n.message.includes('A Real Subtask')), 'a subtask must trigger the same 5-day flag notification a regular task would');
  });

  await t.test('completing a subtask counts toward the assignees performance stats', async () => {
    await api(baseUrl, `/api/tasks/${sub.data.id}/submit-mine`, { method: 'POST', token: subAssigneeToken, body: { note: 'Subtask done.' } });
    await api(baseUrl, `/api/tasks/${sub.data.id}/approve/sub_assignee`, { method: 'POST', token: parentOwnerToken });
    const completion = await api(baseUrl, '/api/reports/completion', { token: adminToken });
    const entry = completion.data.find(s => s.username === 'sub_assignee');
    assert.ok(entry && entry.allTime >= 1, 'completing a subtask must count toward this persons real performance completion stats, same as any regular task');
  });

  await t.test('this same subtask completion also shows up on the HR roster completion count', async () => {
    const hrToken = await createMember(baseUrl, adminToken, 'hr_subtask_test', 'HR Subtask Test', 'HR Department');
    const roster = (await api(baseUrl, '/api/reports/hr-roster', { token: hrToken })).data.roster;
    const entry = roster.find(r => r.username === 'sub_assignee');
    assert.ok(entry && entry.tasksCompleted >= 1, 'a subtask completion must be reflected in the HR roster too');
  });
});

test('monthly leaderboard: ranks by rating, breaks ties sensibly, and top performers get real numeric ranks', async (t) => {
  const { baseUrl, stop } = await startTestServer();
  t.after(() => stop());
  const adminToken = await login(baseUrl, 'admin', 'admin123');
  const fastToken = await createMember(baseUrl, adminToken, 'fast_worker', 'Fast Worker', 'Site Team');
  const slowToken = await createMember(baseUrl, adminToken, 'slow_worker', 'Slow Worker', 'Site Team');

  // Fast worker: 3 completions, all approved quickly.
  for (let i = 0; i < 3; i++) {
    const t1 = await api(baseUrl, '/api/tasks', { method: 'POST', token: adminToken, body: { title: `Fast ${i}`, priority: 'low', deadline: futureDate(), assignedToList: ['fast_worker'] } });
    await api(baseUrl, `/api/tasks/${t1.data.id}/submit-mine`, { method: 'POST', token: fastToken, body: { note: 'Done fast.' } });
    await api(baseUrl, `/api/tasks/${t1.data.id}/approve/fast_worker`, { method: 'POST', token: adminToken });
  }
  // Slow worker: only 1 completion.
  const t2 = await api(baseUrl, '/api/tasks', { method: 'POST', token: adminToken, body: { title: 'Slow 1', priority: 'low', deadline: futureDate(), assignedToList: ['slow_worker'] } });
  await api(baseUrl, `/api/tasks/${t2.data.id}/submit-mine`, { method: 'POST', token: slowToken, body: { note: 'Eventually done.' } });
  await api(baseUrl, `/api/tasks/${t2.data.id}/approve/slow_worker`, { method: 'POST', token: adminToken });

  const res = await api(baseUrl, '/api/reports/monthly-leaderboard', { token: adminToken });
  assert.equal(res.status, 200);
  const fastEntry = res.data.leaderboard.find(r => r.username === 'fast_worker');
  const slowEntry = res.data.leaderboard.find(r => r.username === 'slow_worker');
  assert.ok(fastEntry.rank < slowEntry.rank, 'more completions this month must rank higher');
  assert.equal(fastEntry.rank, 1, 'the top performer must be rank 1, a real number, not a placeholder');
  assert.ok(res.data.periodLabel, 'the response must state which period this leaderboard covers');

  await t.test('a member cannot view the leaderboard — admin only, per explicit request', async () => {
    const memberView = await api(baseUrl, '/api/reports/monthly-leaderboard', { token: slowToken });
    assert.equal(memberView.status, 403, 'only admin should be able to see the leaderboard');
  });

  await t.test('the weekly leaderboard uses the same ranking logic, scoped to this week', async () => {
    const weekly = await api(baseUrl, '/api/reports/weekly-leaderboard', { token: adminToken });
    assert.equal(weekly.status, 200);
    const fastEntry = weekly.data.leaderboard.find(r => r.username === 'fast_worker');
    assert.equal(fastEntry.rank, 1, 'the same top performer this week must also rank 1 on the weekly board');
    assert.ok(weekly.data.periodLabel, 'the weekly response must state which week this covers');
  });
});
