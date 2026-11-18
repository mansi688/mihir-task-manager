const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');
const { pageAllowedFor } = require('../frontend/access');

test('page access list', () => {
  const ok = (page, team, role = 'member') => pageAllowedFor(page, role, team);
  assert.ok(ok('updates', '', 'admin')); assert.ok(!ok('updates', 'Senior management'));
  assert.ok(ok('accountsdept', 'Accounts Department')); assert.ok(ok('accountsdept', 'Senior management')); assert.ok(!ok('accountsdept', 'Store Department'));
  for (const t of ['Senior management', 'Estimation & Billing Department', 'Compliance Department']) assert.ok(ok('estimation', t), t);
  assert.ok(ok('estimation', '', 'director')); assert.ok(!ok('estimation', 'Execution Department')); assert.ok(!ok('estimation', 'Purchase Department'));
  assert.ok(ok('dpr', 'Store Department')); assert.ok(ok('dpr', 'Purchase Department')); assert.ok(!ok('dpr', 'Execution Department'));
  assert.ok(ok('payroll', 'HR Department')); assert.ok(!ok('payroll', 'Accounts Department'));
  assert.ok(ok('deliveries', 'Store Department')); assert.ok(ok('deliveries', 'Purchase Department')); assert.ok(!ok('deliveries', 'Execution Department')); assert.ok(!ok('deliveries', 'Accounts'));
  for (const t of ['Senior management', 'Purchase Department', 'Compliance Department']) assert.ok(ok('meetings', t), t);
  assert.ok(!ok('meetings', 'Store Department'));
});

test('server enforces it: meetings, deliveries, accounts dept, user activity', async (t) => {
  const { baseUrl, stop } = await startTestServer();
  t.after(stop);
  const admin = await login(baseUrl, 'admin', 'admin123');
  const store = await createMember(baseUrl, admin, 'pa.store', 'Store K', 'Store Department');
  const buyer = await createMember(baseUrl, admin, 'pa.buy', 'Buyer', 'Purchase Department');
  const exec = await createMember(baseUrl, admin, 'pa.exec', 'Site Eng', 'Execution Department');
  const senior = await createMember(baseUrl, admin, 'pa.sen', 'Senior', 'Senior management');
  const G = (tok, path) => api(baseUrl, path, { token: tok });
  assert.equal((await G(store, '/api/meetings')).status, 403);
  assert.equal((await G(buyer, '/api/meetings')).status, 200);
  assert.equal((await G(senior, '/api/meetings')).status, 200);
  assert.equal((await G(exec, '/api/deliveries')).data.canView, false);
  assert.equal((await G(store, '/api/deliveries')).data.canView, true);
  const bad = await api(baseUrl, '/api/deliveries', { method: 'POST', token: buyer, body: { title: 'Sand', expected_at: futureDate(1), receivers: ['pa.exec'] } });
  assert.equal(bad.status, 400); assert.match(bad.data.error, /can't be tagged/);
  const good = await api(baseUrl, '/api/deliveries', { method: 'POST', token: buyer, body: { title: 'Sand', expected_at: futureDate(1), receivers: ['pa.store'] } });
  assert.equal(good.status, 200, JSON.stringify(good.data));
  assert.equal((await G(senior, '/api/payables/summary')).data.canView, true);
  assert.equal((await G(exec, '/api/payables/summary')).data.canView, false);
  assert.equal((await G(senior, '/api/reports/user-activity')).status, 200);
  assert.equal((await G(store, '/api/reports/user-activity')).status, 403);
});
