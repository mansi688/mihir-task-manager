const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');

test('User Activity: never logged in, away, inactive, no task made, idle on assigned tasks', async (t) => {
  const { baseUrl, stop, getRawClient } = await startTestServer();
  t.after(stop);
  const admin = await login(baseUrl, 'admin', 'admin123');
  await api(baseUrl, '/api/users', { method: 'POST', token: admin, body: { username: 'act.never', password: 'TestPass123', name: 'Never In', role: 'member', team: 'Store' } });
  await createMember(baseUrl, admin, 'act.away', 'Away Person', 'Store');
  await createMember(baseUrl, admin, 'act.lazy', 'Lazy Person', 'Store');
  const worker = await createMember(baseUrl, admin, 'act.worker', 'Worker', 'Execution');
  const c = await api(baseUrl, '/api/tasks', { method: 'POST', token: worker, body: { title: 'Pour slab', deadline: futureDate(), assignedToList: ['act.lazy'] } });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  const raw = await getRawClient();
  const old = new Date(Date.now() - 20 * 864e5).toISOString();
  await raw.query('UPDATE sessions SET created_at=$1 WHERE username=$2', [old, 'act.away']);
  await raw.query('UPDATE users SET last_active_at=NULL WHERE username=$1', ['act.away']);
  await raw.query('UPDATE tasks SET created_at=$1 WHERE id=$2', [old, c.data.id]);
  await raw.query('UPDATE task_assignees SET released_at=NULL WHERE task_id=$1', [c.data.id]);
  await raw.end();

  const r = await api(baseUrl, '/api/reports/user-activity?days=7', { token: admin });
  assert.equal(r.status, 200);
  const P = Object.fromEntries(r.data.people.map(p => [p.username, p]));
  assert.ok(!P.admin, 'admin accounts are left out');
  assert.equal(P['act.never'].logins, 0);
  assert.equal(P['act.never'].lastLogin, null);
  assert.equal(P['act.away'].daysSinceLogin, 20);
  assert.equal(P['act.lazy'].lastWork, null, 'logged in, did nothing');
  assert.equal(P['act.lazy'].tasksCreated, 0);
  assert.equal(P['act.lazy'].openTasks, 1);
  assert.equal(P['act.lazy'].idleCount, 1);
  assert.equal(P['act.lazy'].idleTasks[0].title, 'Pour slab');
  assert.equal(P['act.worker'].tasksCreated, 1);
  assert.equal(P['act.worker'].daysSinceWork, 0, 'creating a task counts as work');

  // An update on the task clears it from the idle list.
  const lazy = await login(baseUrl, 'act.lazy', 'TestPass123');
  const rep = await api(baseUrl, `/api/tasks/${c.data.id}/reply`, { method: 'POST', token: lazy, body: { message: 'Started shuttering' } });
  assert.equal(rep.status, 200, JSON.stringify(rep.data));
  const r2 = await api(baseUrl, '/api/reports/user-activity?days=7', { token: admin });
  const L = r2.data.people.find(p => p.username === 'act.lazy');
  assert.equal(L.idleCount, 0);
  assert.equal(L.daysSinceWork, 0);
  assert.ok(L.lastActive, 'last active is recorded');

  assert.equal((await api(baseUrl, '/api/reports/user-activity', { token: lazy })).status, 403, 'members cannot see it');
});
