const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');

test('deadline extension requests: the person asks, the task creator reviews', async (t) => {
  const { baseUrl, stop, getRawClient } = await startTestServer();
  t.after(() => stop());
  const admin = await login(baseUrl, 'admin', 'admin123');
  const creator = await createMember(baseUrl, admin, 'ext_creator', 'Ext Creator', 'Estimation');
  const worker = await createMember(baseUrl, admin, 'ext_worker', 'Ext Worker', 'Estimation');
  const mate = await createMember(baseUrl, admin, 'ext_mate', 'Ext Mate', 'Estimation');
  const other = await createMember(baseUrl, admin, 'ext_other', 'Ext Other', 'Estimation');
  const P = (tok, path, body) => api(baseUrl, path, { method: 'POST', token: tok, body });
  const task = await P(creator, '/api/tasks', { title: 'Extension task', deadline: futureDate(3), assignedToList: ['ext_worker', 'ext_mate'] });
  const id = task.data.id;

  await t.test('the creator can no longer move deadlines directly', async () => {
    assert.equal((await P(creator, `/api/tasks/${id}/deadline`, { deadline: futureDate(9), reason: 'Moving it myself' })).status, 403);
    assert.equal((await P(creator, `/api/tasks/${id}/assignees/ext_worker/deadline`, { deadline: futureDate(9) })).status, 403);
  });

  let reqId;
  await t.test('only someone on the task can ask; a reason and a later date are needed; one pending at a time', async () => {
    assert.equal((await P(other, `/api/tasks/${id}/extension-request`, { deadline: futureDate(8), reason: 'Need more time' })).status, 403);
    assert.equal((await P(worker, `/api/tasks/${id}/extension-request`, { deadline: futureDate(8), reason: 'x' })).status, 400);
    assert.equal((await P(worker, `/api/tasks/${id}/extension-request`, { deadline: futureDate(1), reason: 'Need more time' })).status, 400);
    const r = await P(worker, `/api/tasks/${id}/extension-request`, { deadline: futureDate(8), reason: 'Vendor delivery delayed' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal((await P(worker, `/api/tasks/${id}/extension-request`, { deadline: futureDate(9), reason: 'Asking again' })).status, 400);
    const list = (await api(baseUrl, '/api/extension-requests', { token: creator })).data;
    assert.equal(list.toDecide.length, 1);
    reqId = list.toDecide[0].id;
    assert.equal(list.toDecide[0].task_title, 'Extension task');
    const n = (await api(baseUrl, '/api/notifications', { token: creator })).data.items;
    assert.ok(n.some(x => x.type === 'extension_requested'));
    assert.equal((await api(baseUrl, '/api/extension-requests', { token: worker })).data.mine[0].status, 'pending');
  });

  await t.test('someone else cannot decide; rejecting needs a reason', async () => {
    assert.equal((await P(mate, `/api/extension-requests/${reqId}/decide`, { decision: 'approve' })).status, 403);
    assert.equal((await P(creator, `/api/extension-requests/${reqId}/decide`, { decision: 'reject', note: '' })).status, 400);
  });

  await t.test('approving moves only that person\'s deadline and tells them', async () => {
    const r = await P(creator, `/api/extension-requests/${reqId}/decide`, { decision: 'approve', deadline: futureDate(7) });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const raw = await getRawClient();
    const rows = (await raw.query('SELECT username, individual_deadline FROM task_assignees WHERE task_id=$1 ORDER BY username', [id])).rows;
    await raw.end();
    assert.equal(rows.find(x => x.username === 'ext_worker').individual_deadline, futureDate(7));
    assert.ok(!rows.find(x => x.username === 'ext_mate').individual_deadline);
    const n = (await api(baseUrl, '/api/notifications', { token: worker })).data.items;
    assert.ok(n.some(x => x.type === 'extension_decided'));
    assert.equal((await api(baseUrl, '/api/extension-requests', { token: creator })).data.toDecide.length, 0);
    assert.equal((await P(creator, `/api/extension-requests/${reqId}/decide`, { decision: 'approve' })).status, 409);
  });

  await t.test('a rejected request leaves the deadline as it was; the requester can withdraw a pending one', async () => {
    const r = await P(mate, `/api/tasks/${id}/extension-request`, { deadline: futureDate(10), reason: 'Waiting for drawings' });
    const rid = (await api(baseUrl, '/api/extension-requests', { token: creator })).data.toDecide[0].id;
    assert.equal((await P(creator, `/api/extension-requests/${rid}/decide`, { decision: 'reject', note: 'Drawings are already issued' })).status, 200);
    const mine = (await api(baseUrl, '/api/extension-requests', { token: mate })).data.mine;
    assert.equal(mine[0].status, 'rejected');
    await P(mate, `/api/tasks/${id}/extension-request`, { deadline: futureDate(11), reason: 'Second try please' });
    const pend = (await api(baseUrl, '/api/extension-requests', { token: mate })).data.mine.find(x => x.status === 'pending');
    assert.notEqual((await P(worker, `/api/extension-requests/${pend.id}/cancel`)).status, 200);
    assert.equal((await P(mate, `/api/extension-requests/${pend.id}/cancel`)).status, 200);
    assert.ok(r.status === 200);
  });

  await t.test('when the creator asks for more time on their own task, Admin decides', async () => {
    const own = await P(creator, '/api/tasks', { title: 'Own task', deadline: futureDate(2), assignedToList: ['ext_creator'] });
    assert.equal((await P(creator, `/api/tasks/${own.data.id}/extension-request`, { deadline: futureDate(6), reason: 'Site closed for two days' })).status, 200);
    assert.equal((await api(baseUrl, '/api/extension-requests', { token: creator })).data.toDecide.length, 0);
    const a = (await api(baseUrl, '/api/extension-requests', { token: admin })).data.toDecide;
    assert.ok(a.some(x => x.task_id === own.data.id));
  });
});
