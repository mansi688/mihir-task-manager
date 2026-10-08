const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');

test('removing an account removes everything tied to it and repairs shared tasks', async (t) => {
  const { baseUrl, stop, getRawClient } = await startTestServer();
  t.after(() => stop());
  const admin = await login(baseUrl, 'admin', 'admin123');
  const leaver = await createMember(baseUrl, admin, 'leaver', 'Leaving Person', 'Site Team');
  const stay = await createMember(baseUrl, admin, 'stayer', 'Staying Person', 'Site Team');
  await createMember(baseUrl, admin, 'lvl2', 'Level Two', 'Site Team');

  // Task the leaver created (with a subtask by someone else under it)
  const own = await api(baseUrl, '/api/tasks', { method: 'POST', token: leaver, body: { title: 'Leaver own task', deadline: futureDate(), assignedToList: ['stayer'] } });
  await api(baseUrl, '/api/tasks', { method: 'POST', token: stay, body: { title: 'Sub of leaver task', deadline: futureDate(), assignedToList: ['stayer'], parentTaskId: own.data.id } });
  // Task where the leaver is the only person tagged
  const sole = await api(baseUrl, '/api/tasks', { method: 'POST', token: stay, body: { title: 'Only leaver on it', deadline: futureDate(), assignedToList: ['leaver'] } });
  // A task that depends on the sole task
  const dependent = await api(baseUrl, '/api/tasks', { method: 'POST', token: stay, body: { title: 'Waits on sole', deadline: futureDate(), assignedToList: ['stayer'], dependsOnTaskId: sole.data.id } });
  // Shared staged task: Level 1 = leaver, Level 2 = lvl2 (on hold)
  const staged = await api(baseUrl, '/api/tasks', { method: 'POST', token: admin, body: { title: 'Staged shared', deadline: futureDate(), stages: [{ usernames: ['leaver'] }, { usernames: ['lvl2'] }] } });
  // Shared task where the other person is already approved → should auto-close
  const almost = await api(baseUrl, '/api/tasks', { method: 'POST', token: admin, body: { title: 'Almost done', deadline: futureDate(), assignedToList: ['leaver', 'stayer'] } });
  await api(baseUrl, `/api/tasks/${almost.data.id}/submit-mine`, { method: 'POST', token: stay, body: { note: 'done my part' } });
  await api(baseUrl, `/api/tasks/${almost.data.id}/approve/stayer`, { method: 'POST', token: admin });
  // A reply and a follow-up by the leaver on someone else's task
  await api(baseUrl, `/api/tasks/${staged.data.id}/reply`, { method: 'POST', token: leaver, body: { message: 'reply from leaver' } });
  const fu = await api(baseUrl, '/api/tasks', { method: 'POST', token: admin, body: { title: 'Followed', deadline: futureDate(), assignedToList: ['stayer'] } });
  await api(baseUrl, `/api/tasks/${fu.data.id}/followup`, { method: 'POST', token: admin, body: { usernames: ['leaver'] } });

  const impact = await api(baseUrl, '/api/users/leaver/deletion-impact', { token: admin });
  assert.equal(impact.status, 200);
  assert.equal(impact.data.tasksCreated, 1);
  assert.equal(impact.data.soleAssigneeTasks, 1);
  assert.equal(impact.data.sharedTasks, 2);
  assert.equal(impact.data.followups, 1);
  assert.equal(impact.data.replies, 1);

  const del = await api(baseUrl, '/api/users/leaver', { method: 'DELETE', token: admin });
  assert.equal(del.status, 200, JSON.stringify(del.data));

  const all = (await api(baseUrl, '/api/tasks', { token: admin })).data;
  const titles = all.map(x => x.title);
  assert.ok(!titles.includes('Leaver own task'), 'their own task is deleted');
  assert.ok(!titles.includes('Sub of leaver task'), 'subtasks of their task go with it');
  assert.ok(!titles.includes('Only leaver on it'), 'task where they were the only person is deleted');
  const dep = all.find(x => x.id === dependent.data.id);
  assert.equal(dep.depends_on_task_id, null, 'dependency on a deleted task is cleared');
  assert.equal(dep.blocked, false);

  const st = all.find(x => x.id === staged.data.id);
  assert.equal(st.assignees.length, 1);
  assert.equal(st.assignees[0].username, 'lvl2');
  assert.equal(st.assignees[0].stage, 1, 'levels renumbered — the old Level 2 becomes Level 1');
  assert.equal(st.assignees[0].is_released, 1, 'and is released instead of waiting forever');
  assert.ok(!st.replies.some(r => r.by_username === 'leaver'), 'their replies are removed');

  const al = all.find(x => x.id === almost.data.id);
  assert.equal(al.status, 'closed', 'task closes when everyone left is already approved');

  const f = all.find(x => x.id === fu.data.id);
  assert.ok(!f.followups.some(x => x.username === 'leaver'));

  const lvl2Token = await login(baseUrl, 'lvl2', 'TestPass123');
  const notifs = (await api(baseUrl, '/api/notifications', { token: lvl2Token })).data.items;
  assert.ok(notifs.some(n => /released to start/.test(n.message)), 'newly released person is told');

  const raw = await getRawClient();
  for (const [table, col] of [['task_assignees', 'username'], ['task_followups', 'username'], ['task_replies', 'by_username'], ['notifications', 'username'], ['sessions', 'username'], ['users', 'username']]) {
    const r = await raw.query(`SELECT COUNT(*) c FROM ${table} WHERE ${col}='leaver'`);
    assert.equal(Number(r.rows[0].c), 0, `${table} should hold nothing for the removed account`);
  }
  const audit = await raw.query("SELECT details FROM audit_log WHERE action='account_removed'");
  assert.ok(audit.rows.some(r => r.details.includes('leaver')), 'removal is kept in the audit log');
  await raw.end();

  const relogin = await api(baseUrl, '/api/auth/login', { method: 'POST', body: { username: 'leaver', password: 'TestPass123' } });
  assert.notEqual(relogin.status, 200);
});

test('approvals and drawings are handled on account removal', async (t) => {
  const { baseUrl, stop } = await startTestServer();
  t.after(() => stop());
  const admin = await login(baseUrl, 'admin', 'admin123');
  const a = await createMember(baseUrl, admin, 'rev_a', 'Reviewer A', 'X');
  const b = await createMember(baseUrl, admin, 'rev_b', 'Reviewer B', 'Design Team');
  const file = 'data:application/pdf;base64,JVBERi0=';
  const req = await api(baseUrl, '/api/approvals', { method: 'POST', token: admin, body: { title: 'Two reviewers', fileData: file, fileName: 'x.pdf', reviewers: ['rev_a', 'rev_b'] } });
  await api(baseUrl, `/api/approvals/${req.data.id}/decide`, { method: 'POST', token: a, body: { decision: 'approved' } });
  const own = await api(baseUrl, '/api/approvals', { method: 'POST', token: b, body: { title: 'Sent by B', fileData: file, fileName: 'y.pdf', reviewers: ['rev_a'] } });
  assert.equal(own.status, 200);
  await api(baseUrl, '/api/drawings', { method: 'POST', token: b, body: { project: 'P1', title: 'D1', fileData: file, fileName: 'd.pdf' } });

  const keep = await api(baseUrl, '/api/users/rev_b', { method: 'DELETE', token: admin });
  assert.equal(keep.status, 200, JSON.stringify(keep.data));
  const approvals = (await api(baseUrl, '/api/approvals', { token: admin })).data;
  assert.ok(!approvals.some(x => x.title === 'Sent by B'), 'their own approval requests are removed');
  assert.equal(approvals.find(x => x.id === req.data.id).status, 'approved', 'remaining reviewers all approved → request approved');
  const drawings = (await api(baseUrl, '/api/drawings?project=P1', { token: admin })).data;
  assert.equal(drawings.length, 1, 'drawings kept unless Admin asks to delete them');

  const c = await createMember(baseUrl, admin, 'rev_c', 'Reviewer C', 'Design Team');
  await api(baseUrl, '/api/drawings', { method: 'POST', token: c, body: { project: 'P2', title: 'D2', fileData: file, fileName: 'e.pdf' } });
  const del = await api(baseUrl, '/api/users/rev_c?deleteDrawings=1', { method: 'DELETE', token: admin });
  assert.equal(del.data.removed.drawings, 1);
  assert.equal((await api(baseUrl, '/api/drawings?project=P2', { token: admin })).data.length, 0);
});

test('a removed account stays removed after the server restarts (starter accounts are first-run only)', async (t) => {
  const { baseUrl, stop } = await startTestServer();
  t.after(() => stop());
  const admin = await login(baseUrl, 'admin', 'admin123');
  // starter accounts exist on a brand-new database…
  const before = (await api(baseUrl, '/api/users', { token: admin })).data.map(u => u.username);
  assert.ok(before.includes('suraj_kathale') && before.includes('tejas.l'));
  for (const u of ['suraj_kathale', 'tejas.l']) {
    const r = await api(baseUrl, `/api/users/${u}`, { method: 'DELETE', token: admin });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  // …simulate the server sleeping and waking up again (Render free plan does this all day)
  await require('../backend/db').init();
  await require('../backend/db').init();
  const after = (await api(baseUrl, '/api/users', { token: admin })).data.map(u => u.username);
  assert.ok(!after.includes('suraj_kathale'), 'suraj_kathale must not come back after a restart');
  assert.ok(!after.includes('tejas.l'), 'tejas.l must not come back after a restart');
  // and nobody can log in with the old default password
  const r = await api(baseUrl, '/api/auth/login', { method: 'POST', body: { username: 'tejas.l', password: 'MHR123456' } });
  assert.notEqual(r.status, 200);
});
