const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate, getRawClient } = require('../testlib/helpers');

test('creating a task twice by accident makes only one task', async (t) => {
  const { baseUrl, stop, getRawClient: raw } = await startTestServer();
  t.after(stop);
  const admin = await login(baseUrl, 'admin', 'admin123');
  const ravi = await createMember(baseUrl, admin, 'ravi', 'Ravi Kumar', 'Site');
  const asha = await createMember(baseUrl, admin, 'asha', 'Asha Shah', 'Site');
  const post = (tok, body) => api(baseUrl, '/api/tasks', { method: 'POST', token: tok, body });
  const count = async (title) => (await api(baseUrl, '/api/tasks/mine', { token: ravi })).data.filter(x => x.title === title).length;
  const base = { priority: 'medium', deadline: futureDate(3), assignedToList: ['asha'] };

  await t.test('double tap: two requests at the same moment with the same form id', async () => {
    const body = { ...base, title: 'Pour slab — Tower B', clientRequestId: 'form-1' };
    const [a, b] = await Promise.all([post(ravi, body), post(ravi, body)]);
    assert.equal(a.status, 200); assert.equal(b.status, 200);
    assert.equal(a.data.id, b.data.id, 'both answers point to the same task');
    assert.ok(a.data.duplicate || b.data.duplicate);
    assert.equal(await count('Pour slab — Tower B'), 1);
    const notes = (await api(baseUrl, '/api/notifications', { token: asha })).data.items.filter(n => /Pour slab/.test(n.message));
    assert.equal(notes.length, 1, 'Asha is notified once, not twice');
  });

  await t.test('retry later with the same form id (answer lost on a bad connection)', async () => {
    const body = { ...base, title: 'Order cement', clientRequestId: 'form-2' };
    const a = await post(ravi, body);
    const b = await post(ravi, body);
    assert.equal(b.data.id, a.data.id); assert.equal(b.data.duplicate, true);
    assert.equal(await count('Order cement'), 1);
  });

  await t.test('a new form (new id) with the same title is a real second task', async () => {
    await post(ravi, { ...base, title: 'Site visit', clientRequestId: 'form-3' });
    await post(ravi, { ...base, title: 'Site visit', clientRequestId: 'form-4' });
    assert.equal(await count('Site visit'), 2);
  });

  await t.test('old pages without a form id: same task within 15 seconds is merged', async () => {
    const body = { ...base, title: 'Check scaffolding' };
    const [a, b] = await Promise.all([post(ravi, body), post(ravi, body)]);
    assert.equal(a.data.id, b.data.id);
    const c = await post(ravi, body);
    assert.equal(c.data.id, a.data.id);
    assert.equal(await count('Check scaffolding'), 1);
    await post(ravi, { ...body, title: 'Check scaffolding — Tower C' });
    assert.equal(await count('Check scaffolding — Tower C'), 1);
  });

  await t.test("one person's form id never matches another person's task", async () => {
    const r1 = await post(ravi, { ...base, title: 'Labour count', clientRequestId: 'same-id' });
    const r2 = await post(admin, { ...base, title: 'Labour count', clientRequestId: 'same-id' });
    assert.notEqual(r1.data.id, r2.data.id);
  });

  await t.test('a request that fails validation does not block a corrected retry', async () => {
    const bad = await post(ravi, { ...base, title: 'Curing plan', deadline: 'not a date', clientRequestId: 'form-9' });
    assert.equal(bad.status, 400);
    const good = await post(ravi, { ...base, title: 'Curing plan', clientRequestId: 'form-9' });
    assert.equal(good.status, 200); assert.ok(!good.data.duplicate);
    assert.equal(await count('Curing plan'), 1);
  });
});
