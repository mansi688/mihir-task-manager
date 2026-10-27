const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');

test('notifications: approval actions info, no mark-all, admin read tracking, project required', async (t) => {
  const { baseUrl, stop } = await startTestServer();
  t.after(stop);
  const admin = await login(baseUrl, 'admin', 'admin123');
  const boss = await createMember(baseUrl, admin, 'boss.n', 'Boss Creator', 'Execution Department');
  const ravi = await createMember(baseUrl, admin, 'ravi.n', 'Ravi Worker', 'Site');
  const asha = await createMember(baseUrl, admin, 'asha.n', 'Asha Worker', 'Site');
  const P = (tok, path, body) => api(baseUrl, path, { method: 'POST', token: tok, body });
  const G = (tok, path) => api(baseUrl, path, { token: tok });

  // ---- project is required and must be one of the firm's projects
  const base = { title: 'Pour slab', priority: 'medium', deadline: futureDate(3), assignedToList: ['ravi.n', 'asha.n'] };
  assert.equal((await P(boss, '/api/tasks', { ...base, project: '' })).status, 400);
  assert.equal((await P(boss, '/api/tasks', { ...base, project: 'Some Other Site' })).status, 400);
  const c = await P(boss, '/api/tasks', { ...base, project: 'Sierra (Tathawade)' });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  const tid = c.data.id;
  assert.equal((await G(boss, `/api/tasks/${tid}`)).data.project, 'Sierra (Tathawade)');

  // ---- submitted part → the creator's notification carries who waits for approval
  assert.equal((await P(ravi, `/api/tasks/${tid}/submit-mine`, { note: 'Slab poured and cured' })).status, 200);
  let nb = (await G(boss, '/api/notifications')).data;
  assert.deepEqual(nb.tasks[tid].toApprove, ['ravi.n']);
  assert.equal(nb.tasks[tid].canDecide, true);
  assert.ok(nb.tasks[tid].people.some(p => p.u === 'asha.n' && !p.done));
  // not shown to people who cannot approve
  assert.deepEqual((await G(asha, '/api/notifications')).data.tasks[tid].toApprove, []);
  // approve from there → gone
  assert.equal((await P(boss, `/api/tasks/${tid}/approve/ravi.n`)).status, 200);
  nb = (await G(boss, '/api/notifications')).data;
  assert.deepEqual(nb.tasks[tid].toApprove, []);

  // ---- closure request → closureId for the creator only
  assert.equal((await P(asha, `/api/tasks/${tid}/closure-requests`, { reason: 'Work is complete on site' })).status, 200);
  nb = (await G(boss, '/api/notifications')).data;
  assert.ok(nb.tasks[tid].closureId, 'creator sees the closure request id');
  assert.equal((await G(asha, '/api/notifications')).data.tasks[tid].closureId, null);

  // ---- approval request → notification references it, with my decision state
  const fileData = 'data:text/plain;base64,dGVzdA==';
  const ap = await P(boss, '/api/approvals', { title: 'Vendor quote', description: 'Check rates', fileName: 'q.txt', fileData, reviewers: ['ravi.n'] });
  assert.equal(ap.status, 200, JSON.stringify(ap.data));
  let nr = (await G(ravi, '/api/notifications')).data;
  const apn = nr.items.find(n => n.type === 'approval_requested');
  assert.equal(apn.ref_type, 'approval'); assert.equal(apn.ref_id, ap.data.id);
  assert.equal(nr.refs.approval[ap.data.id].status, 'pending'); assert.equal(nr.refs.approval[ap.data.id].mine, null);
  assert.equal((await P(ravi, `/api/approvals/${ap.data.id}/decide`, { decision: 'approved' })).status, 200);
  nr = (await G(ravi, '/api/notifications')).data;
  assert.equal(nr.refs.approval[ap.data.id].mine, 'approved');

  // ---- no "mark all as seen"
  assert.equal((await P(ravi, '/api/notifications/read-all')).status, 404);
  const one = nr.items.find(n => !n.read);
  assert.equal((await P(ravi, '/api/notifications/read', { ids: [one.id] })).status, 200);

  // ---- Admin sees who has seen what; others cannot
  assert.equal((await G(ravi, '/api/admin/notification-reads')).status, 403);
  const rd = (await G(admin, '/api/admin/notification-reads?days=7')).data;
  const rr = rd.people.find(p => p.username === 'ravi.n');
  assert.ok(rr.sent >= 2); assert.equal(rr.seen, 1); assert.equal(rr.unseen, rr.sent - 1); assert.ok(rr.last_seen);
  const det = (await G(admin, '/api/admin/notification-reads/ravi.n')).data;
  assert.equal(det.name, 'Ravi Worker');
  assert.ok(det.items.some(n => n.id === one.id && n.read && n.read_at));
  assert.ok(det.items.some(n => !n.read));
  assert.equal((await G(admin, '/api/admin/notification-reads/nobody.x')).status, 404);
});
