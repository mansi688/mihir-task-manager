const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember } = require('../testlib/helpers');

test('removing a whole department clears the team field but never deletes accounts', async (t) => {
  const { baseUrl, stop } = startTestServer();
  t.after(() => stop());
  const adminToken = await login(baseUrl, 'admin', 'admin123');

  await api(baseUrl, '/api/teams', { method: 'POST', token: adminToken, body: { name: 'Legal' } });
  await createMember(baseUrl, adminToken, 'legal1', 'Legal One', 'Legal');
  await createMember(baseUrl, adminToken, 'legal2', 'Legal Two', 'Legal');

  const beforeCount = (await api(baseUrl, '/api/users/directory', { token: adminToken })).data.length;

  const res = await api(baseUrl, '/api/teams/Legal', { method: 'DELETE', token: adminToken });
  assert.equal(res.status, 200);
  assert.equal(res.data.affected, 2, 'should report exactly 2 accounts affected');

  const afterCount = (await api(baseUrl, '/api/users/directory', { token: adminToken })).data.length;
  assert.equal(afterCount, beforeCount, 'removing a department must never delete any accounts');

  const directory = (await api(baseUrl, '/api/users/directory', { token: adminToken })).data;
  const legal1 = directory.find(u => u.username === 'legal1');
  assert.equal(legal1.team, null, 'the account should still exist, just with no team assigned');

  const teams = (await api(baseUrl, '/api/teams', { token: adminToken })).data;
  assert.ok(!teams.includes('Legal'), 'the department itself should no longer appear in the list');

  const auditLog = (await api(baseUrl, '/api/audit-log', { token: adminToken })).data;
  assert.ok(auditLog.some(e => e.action === 'department_removed' && e.details.includes('Legal')), 'removing a department must be audit-logged');
});

test('a non-admin cannot remove a department', async (t) => {
  const { baseUrl, stop } = startTestServer();
  t.after(() => stop());
  const adminToken = await login(baseUrl, 'admin', 'admin123');
  const memberToken = await createMember(baseUrl, adminToken, 'plainmember', 'Plain Member');
  await api(baseUrl, '/api/teams', { method: 'POST', token: adminToken, body: { name: 'Sales' } });

  const res = await api(baseUrl, '/api/teams/Sales', { method: 'DELETE', token: memberToken });
  assert.equal(res.status, 403);
});

test('removing a nonexistent department returns a clean 404', async (t) => {
  const { baseUrl, stop } = startTestServer();
  t.after(() => stop());
  const adminToken = await login(baseUrl, 'admin', 'admin123');
  const res = await api(baseUrl, '/api/teams/NoSuchDepartment', { method: 'DELETE', token: adminToken });
  assert.equal(res.status, 404);
});
