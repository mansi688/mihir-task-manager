const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');

test('closure requests: tagged people ask, the creator decides', async (t) => {
  const { baseUrl, stop } = await startTestServer();
  t.after(stop);
  const admin = await login(baseUrl, 'admin', 'admin123');
  const priya = await createMember(baseUrl, admin, 'priya', 'Priya Creator', 'Site');
  const ravi = await createMember(baseUrl, admin, 'ravi', 'Ravi Kumar', 'Site');
  const asha = await createMember(baseUrl, admin, 'asha', 'Asha Shah', 'Site');
  const omar = await createMember(baseUrl, admin, 'omar', 'Omar Khan', 'Design');
  const P = (tok, path, body) => api(baseUrl, path, { method: 'POST', token: tok, body });
  const G = (tok, path) => api(baseUrl, path, { token: tok });
  const mk = async (title, extra = {}) => (await P(priya, '/api/tasks', { title, priority: 'medium', deadline: futureDate(4), assignedToList: ['ravi', 'asha'], ...extra })).data.id;
  const notes = async (tok, type) => (await G(tok, '/api/notifications')).data.items.filter(n => n.type === type);
  const task = async (id) => (await G(admin, '/api/tasks')).data.find(x => x.id === id);

  const t1 = await mk('Pour slab — Tower B');
  let reqId;
  await t.test('only tagged people (not the creator, not outsiders) can ask; a reason is required; one pending at a time', async () => {
    assert.equal((await P(omar, `/api/tasks/${t1}/closure-requests`, { reason: 'I think it is done' })).status, 403);
    assert.equal((await P(priya, `/api/tasks/${t1}/closure-requests`, { reason: 'Done already' })).status, 400);
    assert.equal((await P(ravi, `/api/tasks/${t1}/closure-requests`, { reason: 'ok' })).status, 400, 'reason too short');
    const r = await P(ravi, `/api/tasks/${t1}/closure-requests`, { reason: 'Slab poured, cubes taken — photos in reply' });
    assert.equal(r.status, 200, JSON.stringify(r.data)); reqId = r.data.request.id;
    assert.equal((await P(ravi, `/api/tasks/${t1}/closure-requests`, { reason: 'asking again please' })).status, 400, 'no duplicate pending request');
    const n = await notes(priya, 'closure_requested');
    assert.equal(n.length, 1); assert.match(n[0].message, /Ravi Kumar asked to close "Pour slab — Tower B": Slab poured/);
  });

  await t.test('lists: the creator sees it to decide; the requester sees it as theirs; others see nothing', async () => {
    const c = (await G(priya, '/api/closure-requests')).data;
    assert.deepEqual(c.toDecide.map(r => [r.id, r.task_title, r.requested_by]), [[reqId, 'Pour slab — Tower B', 'ravi']]);
    assert.equal((await G(ravi, '/api/closure-requests')).data.mine[0].status, 'pending');
    assert.equal((await G(omar, '/api/closure-requests')).data.toDecide.length, 0);
    assert.equal((await G(admin, '/api/closure-requests')).data.toDecide.length, 0, 'admin default: tasks they created');
    assert.equal((await G(admin, '/api/closure-requests?scope=all')).data.toDecide.length, 1, 'admin can see all');
  });

  await t.test('declining needs a reason, keeps the task open and tells the requester', async () => {
    assert.equal((await P(ravi, `/api/closure-requests/${reqId}/decline`, { note: 'no way' })).status, 403, 'requester cannot decide');
    assert.equal((await P(priya, `/api/closure-requests/${reqId}/decline`, { note: 'no' })).status, 400);
    assert.equal((await P(priya, `/api/closure-requests/${reqId}/decline`, { note: 'Curing is not finished yet — 7 more days' })).status, 200);
    assert.equal((await task(t1)).status, 'open');
    const n = await notes(ravi, 'closure_declined'); assert.equal(n.length, 1); assert.match(n[0].message, /kept "Pour slab — Tower B" open: Curing/);
    assert.equal((await G(ravi, '/api/closure-requests')).data.mine[0].status, 'declined');
    assert.equal((await P(priya, `/api/closure-requests/${reqId}/approve`, {})).status, 400, 'already answered');
  });

  await t.test('approving closes the task (even with parts still open) and records it in history', async () => {
    const r = await P(asha, `/api/tasks/${t1}/closure-requests`, { reason: 'Curing done now, consultant signed off' });
    const r2 = await P(ravi, `/api/tasks/${t1}/closure-requests`, { reason: 'Agree — all done on site' });
    assert.equal(r2.status, 200);
    const ok = await P(priya, `/api/closure-requests/${r.data.request.id}/approve`, { note: 'Thanks, closing' });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal((await task(t1)).status, 'closed');
    const ashaNotes = await notes(asha, 'closure_approved');
    assert.equal(ashaNotes.length, 1, 'requester gets exactly one notice'); assert.match(ashaNotes[0].message, /approved your request/);
    assert.equal((await notes(ravi, 'closure_approved')).length, 1, 'the other pending request is answered too');
    assert.equal((await G(ravi, '/api/closure-requests')).data.mine.find(x => x.id === r2.data.request.id).status, 'closed');
    assert.equal((await G(asha, '/api/closure-requests')).data.mine[0].status, 'approved');
    const hist = (await G(priya, `/api/tasks/${t1}/events`)).data;
    const types = (hist.events || hist.items || hist).map(e => e.event_type || e.type);
    for (const ty of ['CLOSURE_REQUESTED', 'CLOSURE_DECLINED', 'COMPLETED']) assert.ok(types.includes(ty), `history has ${ty}: ${types.join(',')}`);
    assert.equal((await P(ravi, `/api/tasks/${t1}/closure-requests`, { reason: 'closed already?' })).status, 400, 'no requests on closed tasks');
  });

  await t.test('the usual close rules still apply (open subtask blocks closing)', async () => {
    const t2 = await mk('Plaster — Tower A');
    await P(priya, '/api/tasks', { title: 'Buy plaster sand', priority: 'medium', deadline: futureDate(2), assignedToList: ['asha'], parentTaskId: t2 });
    const r = await P(ravi, `/api/tasks/${t2}/closure-requests`, { reason: 'All plaster done' });
    const ap = await P(priya, `/api/closure-requests/${r.data.request.id}/approve`, {});
    assert.equal(ap.status, 400); assert.match(ap.data.error, /open subtask/);
    assert.equal((await task(t2)).status, 'open');
    assert.equal((await G(priya, '/api/closure-requests')).data.toDecide.length, 1, 'request stays waiting');
  });

  await t.test('withdraw: only by the person who asked', async () => {
    const t3 = await mk('Labour count');
    const r = await P(asha, `/api/tasks/${t3}/closure-requests`, { reason: 'Not needed any more' });
    assert.equal((await P(ravi, `/api/closure-requests/${r.data.request.id}/cancel`)).status, 403);
    assert.equal((await P(asha, `/api/closure-requests/${r.data.request.id}/cancel`)).status, 200);
    assert.equal((await G(priya, '/api/closure-requests')).data.toDecide.filter(x => x.task_id === t3).length, 0);
  });

  await t.test('admin can decide on any task; closing with the normal Close button settles requests', async () => {
    const t4 = await mk('Order tiles');
    const r = await P(ravi, `/api/tasks/${t4}/closure-requests`, { reason: 'Tiles delivered today' });
    assert.equal((await P(priya, `/api/tasks/${t4}/close`)).status, 200);
    assert.equal((await G(ravi, '/api/closure-requests')).data.mine.find(x => x.id === r.data.request.id).status, 'closed');
    const t5 = await mk('Fix site gate');
    const r5 = await P(asha, `/api/tasks/${t5}/closure-requests`, { reason: 'Gate repaired by vendor' });
    assert.equal((await P(admin, `/api/closure-requests/${r5.data.request.id}/approve`, {})).status, 200);
    assert.equal((await task(t5)).status, 'closed');
  });
});
