// Someone left: their open work moves to another person; closed tasks keep their history.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');

test('hand over open work (tagged, owned, follow-ups) from a leaver to the new owner', async (t) => {
  const { baseUrl, stop, getRawClient } = await startTestServer();
  t.after(() => stop());
  const raw = await getRawClient(); t.after(() => raw.end());
  const admin = await login(baseUrl, 'admin', 'admin123');
  const yuv = await createMember(baseUrl, admin, 'leaver.y', 'Leaver Y', 'Purchase Department');
  const tan = await createMember(baseUrl, admin, 'taker.t', 'Tanishq Muttha', 'Purchase Department');
  const eng = await createMember(baseUrl, admin, 'ho.eng', 'Site Eng', 'Execution Department');
  const mk = (tok, body) => api(baseUrl, '/api/tasks', { method: 'POST', token: tok, body: { deadline: futureDate(3), ...body } });
  const tagged = (await mk(eng, { title: 'Get cement quotes', assignedToList: ['leaver.y'] })).data.id;
  const both = (await mk(eng, { title: 'Steel PO', assignedToList: ['leaver.y', 'taker.t'] })).data.id;
  const ow = await mk(yuv, { title: 'Vendor follow-up', assignedToList: ['ho.eng'] }); assert.equal(ow.status, 200, JSON.stringify(ow.data)); const owned = ow.data.id;
  const closed = (await mk(eng, { title: 'Old done task', assignedToList: ['leaver.y'] })).data.id;
  await raw.query("UPDATE tasks SET status='closed', closed_at=now()::text WHERE id=$1", [closed]);
  await raw.query("INSERT INTO task_followups(task_id, username, tagged_by, created_at) VALUES($1,'leaver.y','ho.eng',now()::text)", [tagged === null ? '' : (await mk(eng, { title: 'Watch only', assignedToList: ['ho.eng'] })).data.id]);

  assert.equal((await api(baseUrl, '/api/users/leaver.y/hand-over', { method: 'POST', token: eng, body: { to: 'taker.t' } })).status, 403, 'admin only');
  assert.equal((await api(baseUrl, '/api/users/leaver.y/hand-over', { method: 'POST', token: admin, body: { to: 'leaver.y' } })).status, 400);
  const r = await api(baseUrl, '/api/users/leaver.y/hand-over', { method: 'POST', token: admin, body: { to: 'taker.t' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual([r.data.tagged, r.data.created, r.data.followups], [2, 1, 1]);

  const who = async (id) => (await raw.query('SELECT username FROM task_assignees WHERE task_id=$1 ORDER BY username', [id])).rows.map(x => x.username);
  assert.deepEqual(await who(tagged), ['taker.t']);
  assert.deepEqual(await who(both), ['taker.t'], 'no duplicate place when already tagged');
  assert.equal((await raw.query('SELECT created_by_username, created_by FROM tasks WHERE id=$1', [owned])).rows[0].created_by_username, 'taker.t');
  assert.deepEqual(await who(closed), ['leaver.y'], 'closed tasks keep their history');
  assert.equal((await raw.query("SELECT COUNT(*)::int n FROM task_followups WHERE username='leaver.y'")).rows[0].n, 0);
  const notes = (await api(baseUrl, '/api/notifications', { token: tan })).data.items;
  assert.ok(notes.some(n => /Leaver Y's open work was handed over to you/.test(n.message)));
  // tanishq sees them in his tasks
  const mine = (await api(baseUrl, `/api/tasks/${tagged}`, { token: tan }));
  assert.equal(mine.status, 200);
  void yuv;
  // the one-time hand-over (Yuvraj Patil → Tanishq, both starter accounts) runs once at start and is recorded
  const y = (await mk(eng, { title: 'Yuvraj task', assignedToList: ['yuvraj.p'] })).data.id;
  const server = require('../backend/server');
  await server.oneTimeHandOvers();
  assert.deepEqual(await who(y), ['tanishq.m']);
  await raw.query("INSERT INTO task_assignees(task_id, username, stage) SELECT $1, 'yuvraj.p', 1 WHERE NOT EXISTS (SELECT 1 FROM task_assignees WHERE task_id=$1 AND username='yuvraj.p')", [both]);
  await server.oneTimeHandOvers();
  assert.ok((await who(both)).includes('yuvraj.p'), 'runs only once');
  const once = (await raw.query("SELECT value FROM company_settings WHERE key='handover_yuvraj_patil_to_tanishq'")).rows[0];
  assert.ok(once, 'one-time hand-over recorded');
  const v = JSON.parse(once.value);
  assert.equal(v.from, 'yuvraj.p'); assert.equal(v.to, 'tanishq.m');
});
