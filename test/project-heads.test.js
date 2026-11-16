const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');
const csvDataUrl = (text) => 'data:text/csv;base64,' + Buffer.from(text, 'utf8').toString('base64');

test('project heads are kept informed only when the creator ticks them; departments tag their heads', async (t) => {
  const { baseUrl, stop } = await startTestServer();
  t.after(stop);
  const admin = await login(baseUrl, 'admin', 'admin123');
  const P = (tok, path, body) => api(baseUrl, path, { method: 'POST', token: tok, body });
  const G = (tok, path) => api(baseUrl, path, { token: tok });
  const suraj = await createMember(baseUrl, admin, 'suraj.k', 'Suraj Kathale', 'Senior management');
  await createMember(baseUrl, admin, 'rahul.p', 'Rahul Paigude', 'Execution Department');
  await createMember(baseUrl, admin, 'anil.w', 'Anil Wagh', 'Execution Department');
  const dk = await createMember(baseUrl, admin, 'dnyaneshwar.k', 'Dnyaneshwar Kolekar', 'Senior management');
  const eng = await createMember(baseUrl, admin, 'eng.h', 'Site Engineer', 'Execution Department');
  await createMember(baseUrl, admin, 'work.h', 'Worker', 'Site');
  const followers = async (id) => ((await G(admin, `/api/tasks/${id}`)).data.followups || []).map(f => f.username || f).sort();
  const assignees = async (id) => ((await G(admin, `/api/tasks/${id}`)).data.assignees || []).map(a => a.username).sort();
  const mk = (tok, body) => P(tok, '/api/tasks', { priority: 'medium', deadline: futureDate(3), assignedToList: ['work.h'], ...body });

  await t.test('no automatic tagging any more', async () => {
    const a = (await mk(eng, { title: 'Amara slab', project: 'Mihir Amara' })).data;
    assert.deepEqual(await followers(a.id), []);
    const b = (await mk(eng, { title: 'Imported-like', project: 'Nyati Equinox' })).data;
    assert.deepEqual(await followers(b.id), []);
  });

  await t.test('ticked heads are kept informed (only real heads of that project)', async () => {
    const a = (await mk(eng, { title: 'Amara pour', project: 'Mihir Amara', projectHeads: ['suraj.k', 'anil.w'] })).data;
    assert.deepEqual(await followers(a.id), ['suraj.k'], 'anil.w heads Equinox, not Amara');
    assert.ok((await G(suraj, '/api/notifications')).data.items.some(n => n.type === 'followup_tagged' && n.task_id === a.id && /project head/.test(n.message)));
    const s = (await mk(dk, { title: 'Tathawade own', project: 'Sierra (Tathawade)', projectHeads: ['dnyaneshwar.k'] })).data;
    assert.deepEqual(await followers(s.id), [], 'the creator is not kept informed of their own task');
  });

  await t.test('bulk import adds no heads by itself', async () => {
    const dd = (n) => { const d = new Date(Date.now() + n * 864e5); return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`; };
    const csv = ['Task Name,Priority,Due Date,Assigned To,Site', `Imported Amara task,High,${dd(5)},work.h,Mihir Amara`].join('\n');
    const imp = await P(eng, '/api/tasks/import', { fileData: csvDataUrl(csv), fileName: 'x.csv' });
    assert.equal(imp.status, 200, JSON.stringify(imp.data));
    assert.deepEqual(await followers(imp.data.created[0].id), []);
  });

  await t.test('tagging a department tags its head(s)', async () => {
    await createMember(baseUrl, admin, 'elec.head', 'Elec Head', 'Electrical Department');
    await createMember(baseUrl, admin, 'elec.two', 'Elec Two', 'Electrical Department');
    await createMember(baseUrl, admin, 'qa.one', 'QA One', 'Quality Department');
    const lead = await P(admin, '/api/users/elec.head/team-lead', { isTeamLead: true });
    assert.equal(lead.status, 200, JSON.stringify(lead.data));
    const r = await mk(eng, { title: 'Panel check', project: 'Mihir Projects', departments: ['Electrical Department'] });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(await assignees(r.data.id), ['elec.head', 'work.h']);
    const ev = (await G(admin, `/api/tasks/${r.data.id}/events`)).data.events;
    assert.ok(ev.some(e => /Departments tagged: Electrical Department/.test(e.details)));
    const bad = await mk(eng, { title: 'QA check', project: 'Mihir Projects', departments: ['Quality Department'] });
    assert.equal(bad.status, 400);
    assert.match(bad.data.error, /no head set/);
  });
});
