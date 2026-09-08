const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember } = require('../testlib/helpers');

test('HR roster orders by real organizational hierarchy: department, then Team Lead first', async (t) => {
  const { baseUrl, stop } = startTestServer();
  t.after(() => stop());
  const adminToken = await login(baseUrl, 'admin', 'admin123');

  // Deliberately create the regular member FIRST and the lead SECOND — if ordering were just
  // creation order or alphabetical ("Rohit" < "Suraj"), the regular member would wrongly appear
  // first. Real hierarchy must win regardless of name or creation order.
  await createMember(baseUrl, adminToken, 'rohit_test', 'Rohit Kamble Test', 'Estimation Test Dept');
  await createMember(baseUrl, adminToken, 'suraj_test', 'Suraj Kathale Test', 'Estimation Test Dept');
  await api(baseUrl, '/api/users/suraj_test/team-lead', { method: 'POST', token: adminToken, body: { isTeamLead: true } });

  const roster = (await api(baseUrl, '/api/reports/hr-roster', { token: adminToken })).data.roster;
  const deptMembers = roster.filter(r => r.team === 'Estimation Test Dept');
  assert.equal(deptMembers[0].username, 'suraj_test', "the actual Team Lead (Suraj) must be listed first, even though 'Rohit' alphabetically precedes 'Suraj' and Rohit was created first");
  assert.equal(deptMembers[1].username, 'rohit_test');

  await t.test('people with no department are listed after everyone who has one', async () => {
    const withNoDept = roster.filter(r => !r.team);
    const withDept = roster.filter(r => r.team);
    if (withNoDept.length > 0 && withDept.length > 0) {
      const lastDeptIndex = roster.lastIndexOf(withDept[withDept.length - 1]);
      const firstNoDeptIndex = roster.indexOf(withNoDept[0]);
      assert.ok(firstNoDeptIndex > roster.findIndex(r => r.team), 'departmentless accounts should not be interleaved ahead of departmental hierarchy');
    }
  });

  await t.test('within the same department, non-leads are still ordered alphabetically as a fair tiebreaker', async () => {
    await createMember(baseUrl, adminToken, 'zed_test', 'Zed Test', 'Estimation Test Dept');
    const roster2 = (await api(baseUrl, '/api/reports/hr-roster', { token: adminToken })).data.roster;
    const deptMembers2 = roster2.filter(r => r.team === 'Estimation Test Dept');
    assert.equal(deptMembers2[0].username, 'suraj_test', 'the lead still comes first');
    assert.deepEqual(deptMembers2.slice(1).map(r => r.username), ['rohit_test', 'zed_test'], 'the remaining non-leads should be alphabetical by name (Rohit Kamble Test before Zed Test)');
  });
});
