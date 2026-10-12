const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');

test('Phase 1 — task history', async (t) => {
  const { baseUrl, stop, getRawClient } = await startTestServer();
  t.after(() => stop());
  const admin = await login(baseUrl, 'admin', 'admin123');
  const rohit = await createMember(baseUrl, admin, 'h.rohit', 'Rohit H', 'Estimation');
  const suraj = await createMember(baseUrl, admin, 'h.suraj', 'Suraj H', 'Estimation');
  const outsider = await createMember(baseUrl, admin, 'h.out', 'Outsider', 'Accounts');
  const ev = async (id, q = '', token = admin) => (await api(baseUrl, `/api/tasks/${id}/events${q}`, { token })).data;

  const created = await api(baseUrl, '/api/tasks', { method: 'POST', token: admin, body: { title: 'BOQ Tower 2A', deadline: futureDate(5), assignedToList: ['h.rohit', 'h.suraj'] } });
  const id = created.data.id;

  await t.test('creation writes CREATED + one ASSIGNED per person, with actor and source', async () => {
    const e = await ev(id, '?order=asc');
    assert.deepEqual(e.events.map(x => x.event_type), ['CREATED', 'ASSIGNED', 'ASSIGNED']);
    assert.equal(e.events[0].actor_username, 'admin');
    assert.equal(e.events[0].source_type, 'web');
    assert.match(e.events[1].details, /Tagged Rohit H \(Level 1\)/);
  });

  await t.test('every action is recorded once, with old/new values where they apply', async () => {
    const newDl = futureDate(9);
    await api(baseUrl, `/api/tasks/${id}/deadline`, { method: 'POST', token: admin, body: { deadline: newDl, reason: 'Drawings late' } });
    await api(baseUrl, `/api/tasks/${id}/reply`, { method: 'POST', token: rohit, body: { message: 'Working on it' } });
    await api(baseUrl, `/api/tasks/${id}/followup`, { method: 'POST', token: admin, body: { usernames: ['h.out'] } });
    await api(baseUrl, `/api/tasks/${id}/submit-mine`, { method: 'POST', token: rohit, body: { note: 'Quantities done' } });
    await api(baseUrl, `/api/tasks/${id}/reject/h.rohit`, { method: 'POST', token: admin, body: { reason: 'Missing slab 3' } });
    await api(baseUrl, `/api/tasks/${id}/submit-mine`, { method: 'POST', token: rohit, body: { note: 'Fixed slab 3' } });
    await api(baseUrl, `/api/tasks/${id}/approve/h.rohit`, { method: 'POST', token: admin });
    await api(baseUrl, `/api/tasks/${id}/submit-mine`, { method: 'POST', token: suraj, body: { note: 'My part done' } });
    await api(baseUrl, `/api/tasks/${id}/approve/h.suraj`, { method: 'POST', token: admin });
    const e = await ev(id, '?order=asc&limit=100');
    const types = e.events.map(x => x.event_type);
    assert.deepEqual(types, ['CREATED', 'ASSIGNED', 'ASSIGNED', 'DEADLINE_CHANGED', 'COMMENTED', 'FOLLOW_UP', 'SUBMITTED', 'REJECTED', 'SUBMITTED', 'APPROVED', 'SUBMITTED', 'APPROVED', 'COMPLETED']);
    const dl = e.events.find(x => x.event_type === 'DEADLINE_CHANGED');
    assert.equal(dl.new_value, newDl); assert.ok(dl.old_value); assert.match(dl.details, /Drawings late/);
    const subs = e.events.filter(x => x.event_type === 'SUBMITTED');
    assert.match(subs[0].details, /Quantities done/); assert.match(subs[1].details, /Fixed slab 3/, 'resubmission is a NEW event — the first round is not lost');
    const comment = e.events.find(x => x.event_type === 'COMMENTED');
    assert.equal(comment.actor_username, 'h.rohit'); assert.equal(comment.actor_team, 'Estimation');
  });

  await t.test('filters, search, ordering and paging', async () => {
    assert.ok((await ev(id, '?type=SUBMITTED')).events.every(x => x.event_type === 'SUBMITTED'));
    assert.ok((await ev(id, '?actor=h.rohit')).events.every(x => x.actor_username === 'h.rohit'));
    assert.equal((await ev(id, '?q=slab%203')).events.length, 2);
    const newest = await ev(id, '?limit=1');
    assert.equal(newest.events[0].event_type, 'COMPLETED'); assert.equal(newest.hasMore, true);
    const page1 = await ev(id, '?limit=5'); const page2 = await ev(id, `?limit=5&cursor=${encodeURIComponent(page1.nextCursor)}`);
    const ids = new Set([...page1.events, ...page2.events].map(x => x.id));
    assert.equal(ids.size, 10, 'pages do not overlap');
    assert.equal(page1.total, 13);
    assert.ok(page1.types.includes('REJECTED') && page1.actors.some(a => a.username === 'h.rohit'));
  });

  await t.test('history is append-only — the database refuses edits and deletes', async () => {
    const raw = await getRawClient();
    await assert.rejects(raw.query("UPDATE task_activity_events SET details='tampered' WHERE task_id=$1", [id]), /append-only/);
    await assert.rejects(raw.query('DELETE FROM task_activity_events WHERE task_id=$1', [id]), /append-only/);
    await raw.end();
  });

  await t.test('authorization: only people allowed to see the task see its history (and the task)', async () => {
    const other = await api(baseUrl, '/api/tasks', { method: 'POST', token: admin, body: { title: 'Private', deadline: futureDate(3), assignedToList: ['h.suraj'] } });
    const outsiderTok = outsider;
    assert.equal((await api(baseUrl, `/api/tasks/${other.data.id}/events`, { token: outsiderTok })).status, 403);
    assert.equal((await api(baseUrl, `/api/tasks/${other.data.id}`, { token: outsiderTok })).status, 403, 'task details no longer readable by anyone');
    assert.equal((await api(baseUrl, `/api/tasks/${other.data.id}/events`, { token: suraj })).status, 200);
    assert.equal((await api(baseUrl, `/api/tasks/${id}/events`, { token: outsiderTok })).status, 200, 'follow-up people may see it');
  });

  await t.test('subtasks, people added/removed, cancel and reopen', async () => {
    const parent = await api(baseUrl, '/api/tasks', { method: 'POST', token: admin, body: { title: 'Parent', deadline: futureDate(4), assignedToList: ['h.rohit'] } });
    await api(baseUrl, '/api/tasks', { method: 'POST', token: admin, body: { title: 'Child', deadline: futureDate(4), assignedToList: ['h.rohit'], parentTaskId: parent.data.id } });
    await api(baseUrl, `/api/tasks/${parent.data.id}/assignees`, { method: 'POST', token: admin, body: { usernames: ['h.suraj'] } });
    await api(baseUrl, `/api/tasks/${parent.data.id}/assignees/h.suraj`, { method: 'DELETE', token: admin });
    await api(baseUrl, `/api/tasks/${parent.data.id}/cancel`, { method: 'POST', token: admin, body: { reason: 'Scope changed' } });
    const types = (await ev(parent.data.id, '?order=asc')).events.map(x => x.event_type);
    for (const tp of ['SUBTASK_CREATED', 'PERSON_ADDED', 'PERSON_REMOVED', 'CANCELLED']) assert.ok(types.includes(tp), tp);
  });

  await t.test('backfill reconstructs history for old tasks, once', async () => {
    const raw = await getRawClient();
    const now = new Date().toISOString();
    await raw.query("INSERT INTO tasks(id,title,status,created_by,created_by_username,created_at,closed_at,closed_by) VALUES('TASK-OLD001','Legacy task','closed','Mihir Sabadra','admin',$1,$1,'Mihir Sabadra')", [now]);
    await raw.query("INSERT INTO task_assignees(task_id,username,stage,is_released,submitted_at,submission_note,completed_at,completed_by,decision) VALUES('TASK-OLD001','h.rohit',1,1,$1,'old note',$1,'Mihir Sabadra','approve')", [now]);
    await raw.query("INSERT INTO task_replies(task_id,by_username,by_name,message,created_at) VALUES('TASK-OLD001','h.rohit','Rohit H','legacy comment',$1)", [now]);
    await raw.query("DELETE FROM schema_migrations WHERE version='002'");
    await raw.end();
    await require('../backend/db').init();
    await require('../backend/db').init();
    const e = await ev('TASK-OLD001', '?order=asc&limit=50');
    assert.deepEqual(e.events.map(x => x.event_type).sort(), ['APPROVED', 'ASSIGNED', 'COMMENTED', 'COMPLETED', 'CREATED', 'SUBMITTED'].sort());
    assert.ok(e.events.every(x => x.metadata && x.metadata.backfilled === true));
    const again = await ev(id, '?limit=100');
    assert.equal(again.total, 13, 'tasks that already had history were not backfilled again');
  });

  await t.test('imported tasks record TASK_IMPORTED with source "import"', async () => {
    const csv = 'data:text/csv;base64,' + Buffer.from(`Title,Deadline,Assignees\nFrom sheet,${futureDate(6).split('-').reverse().join('/')},h.rohit\n`).toString('base64');
    const r = await api(baseUrl, '/api/tasks/import', { method: 'POST', token: admin, body: { fileData: csv, fileName: 'eq.csv' } });
    const e = await ev(r.data.created[0].id, '?order=asc');
    assert.deepEqual(e.events.map(x => x.event_type), ['TASK_IMPORTED', 'ASSIGNED']);
    assert.ok(e.events.every(x => x.source_type === 'import'));
    assert.match(e.events[0].details, /eq\.csv/);
  });
});
