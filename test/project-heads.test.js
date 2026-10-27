const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');
const csvDataUrl = (text) => 'data:text/csv;base64,' + Buffer.from(text, 'utf8').toString('base64');

test('project heads are always kept informed on new tasks of their project', async (t) => {
  const { baseUrl, stop } = await startTestServer();
  t.after(stop);
  const admin = await login(baseUrl, 'admin', 'admin123');
  const P = (tok, path, body) => api(baseUrl, path, { method: 'POST', token: tok, body });
  const G = (tok, path) => api(baseUrl, path, { token: tok });
  const suraj = await createMember(baseUrl, admin, 'suraj.k', 'Suraj Kathale', 'Senior management');
  await createMember(baseUrl, admin, 'rahul.p', 'Rahul Paigude', 'Execution Department');
  await createMember(baseUrl, admin, 'anil.w', 'Anil Wagh', 'Execution Department');
  // siddheshwar.p does not exist here — skipped quietly
  const dk = await createMember(baseUrl, admin, 'dnyaneshwar.k', 'Dnyaneshwar Kolekar', 'Senior management');
  const eng = await createMember(baseUrl, admin, 'eng.h', 'Site Engineer', 'Execution Department');
  await createMember(baseUrl, admin, 'work.h', 'Worker', 'Site');
  const followers = async (id) => ((await G(admin, `/api/tasks/${id}`)).data.followups || []).map(f => f.username || f).sort();

  // Amara → Suraj + Rahul P kept informed, notified, can open the task
  const a = (await P(eng, '/api/tasks', { title: 'Amara slab', project: 'Mihir Amara', priority: 'medium', deadline: futureDate(3), assignedToList: ['work.h'] })).data;
  assert.deepEqual(await followers(a.id), ['rahul.p', 'suraj.k']);
  assert.ok((await G(suraj, '/api/notifications')).data.items.some(n => n.type === 'followup_tagged' && n.task_id === a.id && /project head/.test(n.message)));
  assert.equal((await G(suraj, `/api/tasks/${a.id}`)).status, 200);
  assert.ok((await G(admin, `/api/tasks/${a.id}/events`)).data.events.some(e => /project head, Mihir Amara/.test(e.details)));

  // Equinox → Anil only (Siddheshwar's account is missing)
  const e = (await P(eng, '/api/tasks', { title: 'Equinox lift', project: 'Nyati Equinox', priority: 'medium', deadline: futureDate(3), assignedToList: ['work.h'] })).data;
  assert.deepEqual(await followers(e.id), ['anil.w']);

  // A head who is already doing the task, or created it, is not added again
  const s1 = (await P(eng, '/api/tasks', { title: 'Tathawade check', project: 'Sierra (Tathawade)', priority: 'medium', deadline: futureDate(3), assignedToList: ['dnyaneshwar.k'] })).data;
  assert.deepEqual(await followers(s1.id), []);
  const s2 = (await P(dk, '/api/tasks', { title: 'Tathawade estimate', project: 'Sierra (Tathawade)', priority: 'medium', deadline: futureDate(3), assignedToList: ['work.h'] })).data;
  assert.deepEqual(await followers(s2.id), [], 'the creator is not kept informed of their own task');
  const s3 = (await P(eng, '/api/tasks', { title: 'Tathawade pour', project: 'Sierra (Tathawade)', priority: 'medium', deadline: futureDate(3), assignedToList: ['work.h'] })).data;
  assert.deepEqual(await followers(s3.id), ['dnyaneshwar.k']);

  // Mihir Projects has no heads
  const m = (await P(eng, '/api/tasks', { title: 'Office', project: 'Mihir Projects', priority: 'medium', deadline: futureDate(3), assignedToList: ['work.h'] })).data;
  assert.deepEqual(await followers(m.id), []);

  // Bulk import too
  const dd = (n) => { const d = new Date(Date.now() + n * 864e5); return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`; };
  const csv = ['Task Name,Priority,Due Date,Assigned To,Site', `Imported Amara task,High,${dd(5)},work.h,Mihir Amara`].join('\n');
  const imp = await P(eng, '/api/tasks/import', { fileData: csvDataUrl(csv), fileName: 'x.csv' });
  assert.equal(imp.status, 200, JSON.stringify(imp.data));
  assert.deepEqual(await followers(imp.data.created[0].id), ['rahul.p', 'suraj.k']);
});
