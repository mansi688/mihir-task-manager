const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');

test('HR roster: company-wide overview with real completion and warning counts', async (t) => {
  const { baseUrl, getRawClient, stop } = await startTestServer();
  t.after(() => stop());
  const adminToken = await login(baseUrl, 'admin', 'admin123');
  const hrToken = await createMember(baseUrl, adminToken, 'hr_roster_test', 'HR Roster Test', 'HR Department');
  const bobToken = await createMember(baseUrl, adminToken, 'bob_roster', 'Bob Roster', 'Site Team');
  const plainToken = await createMember(baseUrl, adminToken, 'plain_roster', 'Plain Roster', 'Site Team');

  await t.test('a plain member cannot access the roster', async () => {
    const res = await api(baseUrl, '/api/reports/hr-roster', { token: plainToken });
    assert.equal(res.status, 403);
  });

  await t.test('HR can access it, and it lists every employee', async () => {
    const res = await api(baseUrl, '/api/reports/hr-roster', { token: hrToken });
    assert.equal(res.status, 200);
    const usernames = res.data.roster.map(r => r.username);
    assert.ok(usernames.includes('bob_roster') && usernames.includes('hr_roster_test'), 'the roster must include every employee, not just HR\'s own department');
  });

  await t.test('completion counts are real, not placeholder zeros', async () => {
    const create = await api(baseUrl, '/api/tasks', { method: 'POST', token: adminToken, body: { title: 'Roster Completion Test', priority: 'low', deadline: futureDate(), assignedToList: ['bob_roster'] } });
    await api(baseUrl, `/api/tasks/${create.data.id}/submit-mine`, { method: 'POST', token: bobToken, body: { note: 'Fully done here.' } });
    await api(baseUrl, `/api/tasks/${create.data.id}/approve/bob_roster`, { method: 'POST', token: adminToken });

    const roster = await api(baseUrl, '/api/reports/hr-roster', { token: hrToken });
    const bobEntry = roster.data.roster.find(r => r.username === 'bob_roster');
    assert.equal(bobEntry.tasksCompleted, 1);
  });

  await t.test('warning counts reflect real escalation history, once per task even with multiple thresholds fired', async () => {
    const create = await api(baseUrl, '/api/tasks', { method: 'POST', token: adminToken, body: { title: 'Roster Warning Test', priority: 'medium', deadline: futureDate(20), assignedToList: ['bob_roster'] } });
    const raw = await getRawClient();
    await raw.query('UPDATE task_assignees SET warning_5day_sent_at=$1, warning_7day_sent_at=$2 WHERE task_id=$3 AND username=$4', [new Date().toISOString(), new Date().toISOString(), create.data.id, 'bob_roster']);
    await raw.end();

    const roster = await api(baseUrl, '/api/reports/hr-roster', { token: hrToken });
    const bobEntry = roster.data.roster.find(r => r.username === 'bob_roster');
    assert.equal(bobEntry.warningCount, 1, 'a single task with BOTH a 5-day and 7-day flag must still count as ONE warning-flagged task, not two');
  });

  await t.test('a task with TWO assignees, both approved, counts as ONE completed task company-wide — not two', async () => {
    const alice = await createMember(baseUrl, adminToken, 'alice_roster', 'Alice Roster', 'Site Team');
    const beforeResp = await api(baseUrl, '/api/reports/hr-roster', { token: hrToken });
    const bobBefore = beforeResp.data.roster.find(r => r.username === 'bob_roster').tasksCompleted;
    const totalBefore = beforeResp.data.totalTasksCompleted;

    const create = await api(baseUrl, '/api/tasks', { method: 'POST', token: adminToken, body: { title: 'Two Assignee Completion Test', priority: 'low', deadline: futureDate(), assignedToList: ['bob_roster', 'alice_roster'] } });
    await api(baseUrl, `/api/tasks/${create.data.id}/submit-mine`, { method: 'POST', token: bobToken, body: { note: 'My part done.' } });
    await api(baseUrl, `/api/tasks/${create.data.id}/approve/bob_roster`, { method: 'POST', token: adminToken });
    await api(baseUrl, `/api/tasks/${create.data.id}/submit-mine`, { method: 'POST', token: alice, body: { note: 'My part done too.' } });
    await api(baseUrl, `/api/tasks/${create.data.id}/approve/alice_roster`, { method: 'POST', token: adminToken });
    await api(baseUrl, `/api/tasks/${create.data.id}/close`, { method: 'POST', token: adminToken });

    const afterResp = await api(baseUrl, '/api/reports/hr-roster', { token: hrToken });
    const bobAfter = afterResp.data.roster.find(r => r.username === 'bob_roster').tasksCompleted;
    const aliceAfter = afterResp.data.roster.find(r => r.username === 'alice_roster').tasksCompleted;
    const totalAfter = afterResp.data.totalTasksCompleted;

    assert.equal(bobAfter - bobBefore, 1, 'Bob correctly gets +1 credit for his own part');
    assert.equal(aliceAfter, 1, 'Alice (brand new) correctly gets +1 credit for her own part');
    // This is the actual bug fix being verified: the company-wide total must go up by exactly 1
    // for this ONE shared task, not by 2 (one from Bob's credit, one from Alice's) — which is
    // exactly what summing every person's individual count together used to produce.
    assert.equal(totalAfter - totalBefore, 1, 'the company-wide total must increase by exactly 1 for one shared task, not 2');
  });

  await t.test('a person with exactly 1 pending task is NOT red-flagged, but 2 pending tasks IS', async () => {
    const carol = await createMember(baseUrl, adminToken, 'carol_pending', 'Carol Pending', 'Sales');
    await api(baseUrl, '/api/tasks', { method: 'POST', token: adminToken, body: { title: 'Pending Task 1', priority: 'low', deadline: futureDate(), assignedToList: ['carol_pending'] } });

    let roster = (await api(baseUrl, '/api/reports/hr-roster', { token: hrToken })).data.roster;
    let carolEntry = roster.find(r => r.username === 'carol_pending');
    assert.equal(carolEntry.pendingTaskCount, 1);
    assert.equal(carolEntry.isPendingRedFlag, false, 'one pending task alone must not trigger the red flag');

    await api(baseUrl, '/api/tasks', { method: 'POST', token: adminToken, body: { title: 'Pending Task 2', priority: 'low', deadline: futureDate(), assignedToList: ['carol_pending'] } });
    roster = (await api(baseUrl, '/api/reports/hr-roster', { token: hrToken })).data.roster;
    carolEntry = roster.find(r => r.username === 'carol_pending');
    assert.equal(carolEntry.pendingTaskCount, 2);
    assert.equal(carolEntry.isPendingRedFlag, true, 'two pending tasks must trigger the red flag');
  });

  await t.test('a task that has already been completed is NOT counted as pending', async () => {
    const daveToken = await createMember(baseUrl, adminToken, 'dave_pending', 'Dave Pending', 'Sales');
    const create = await api(baseUrl, '/api/tasks', { method: 'POST', token: adminToken, body: { title: 'Will Be Done', priority: 'low', deadline: futureDate(), assignedToList: ['dave_pending'] } });
    await api(baseUrl, `/api/tasks/${create.data.id}/submit-mine`, { method: 'POST', token: daveToken, body: { note: 'Done.' } });
    await api(baseUrl, `/api/tasks/${create.data.id}/approve/dave_pending`, { method: 'POST', token: adminToken });

    const roster = (await api(baseUrl, '/api/reports/hr-roster', { token: hrToken })).data.roster;
    const daveEntry = roster.find(r => r.username === 'dave_pending');
    assert.equal(daveEntry.pendingTaskCount, 0, 'a completed task must not count toward pending workload');
    assert.equal(daveEntry.isPendingRedFlag, false);
  });

  await t.test('Admin can access the roster too', async () => {
    const res = await api(baseUrl, '/api/reports/hr-roster', { token: adminToken });
    assert.equal(res.status, 200);
  });

  await t.test('Admin and Director accounts never appear as entries in the roster — for anyone, including Admin viewing it', async () => {
    await api(baseUrl, '/api/users', { method: 'POST', token: adminToken, body: { username: 'director_roster_test', password: 'ValidPass123', name: 'Director Roster Test', role: 'director' } });
    const rosterAsAdmin = await api(baseUrl, '/api/reports/hr-roster', { token: adminToken });
    const rosterAsHR = await api(baseUrl, '/api/reports/hr-roster', { token: hrToken });
    [rosterAsAdmin, rosterAsHR].forEach(res => {
      assert.ok(!res.data.roster.some(r => r.role === 'admin'), 'no admin account should ever appear in the roster');
      assert.ok(!res.data.roster.some(r => r.role === 'director'), 'no director account should ever appear in the roster');
      assert.ok(!res.data.roster.some(r => r.username === 'admin'), 'the admin username specifically must never appear');
      assert.ok(!res.data.roster.some(r => r.username === 'director_roster_test'), 'the newly created director must not appear either');
    });
  });
});
