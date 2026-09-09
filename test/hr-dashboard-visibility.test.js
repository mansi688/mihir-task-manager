const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');

test('HR team members get full cross-employee dashboard visibility, matching Admin', async (t) => {
  const { baseUrl, stop } = await startTestServer();
  t.after(() => stop());
  const adminToken = await login(baseUrl, 'admin', 'admin123');

  const hrToken = await createMember(baseUrl, adminToken, 'hr_person', 'HR Person', 'HR Department');
  const estStaffToken = await createMember(baseUrl, adminToken, 'est_staff2', 'Est Staff Two', 'Estimation Department');
  const purStaffToken = await createMember(baseUrl, adminToken, 'pur_staff2', 'Pur Staff Two', 'Purchase Department');
  const plainMemberToken = await createMember(baseUrl, adminToken, 'plain2', 'Plain Two', 'Site Team');

  const t1 = await api(baseUrl, '/api/tasks', { method: 'POST', token: adminToken, body: { title: 'HR Vis Test 1', priority: 'low', deadline: futureDate(), assignedToList: ['est_staff2'] } });
  await api(baseUrl, `/api/tasks/${t1.data.id}/submit-mine`, { method: 'POST', token: estStaffToken, body: { note: 'Done here.' } });
  await api(baseUrl, `/api/tasks/${t1.data.id}/approve/est_staff2`, { method: 'POST', token: adminToken });

  await t.test('HR can view an employee in a totally different department (unlike a Director, who is department-scoped)', async () => {
    const res = await api(baseUrl, '/api/reports/my-dashboard?username=est_staff2', { token: hrToken });
    assert.equal(res.status, 200);
    assert.equal(res.data.username, 'est_staff2');
    assert.equal(res.data.completion.allTime, 1);
  });

  await t.test('HR can view a second, unrelated department just as freely', async () => {
    const res = await api(baseUrl, '/api/reports/my-dashboard?username=pur_staff2', { token: hrToken });
    assert.equal(res.status, 200);
    assert.equal(res.data.username, 'pur_staff2');
  });

  await t.test('a plain member (not HR, not Admin) still cannot view anyone else', async () => {
    const res = await api(baseUrl, '/api/reports/my-dashboard?username=est_staff2', { token: plainMemberToken });
    assert.equal(res.data.username, 'plain2', 'a non-HR, non-admin member must always be forced back to their own dashboard, never anyone else\'s');
  });

  await t.test('the whole-company aggregate ("all") stays Admin-only, even for HR', async () => {
    const res = await api(baseUrl, '/api/reports/my-dashboard?username=all', { token: hrToken });
    assert.notEqual(res.data.username, 'all', 'HR should NOT get the whole-company sum — that stays Admin-only — falls back to their own dashboard instead');
    assert.equal(res.data.username, 'hr_person');
  });

  await t.test('Peak Hours company-wide reporting is unaffected — HR does not automatically gain Peak Hours access (a separate, still Admin-only endpoint)', async () => {
    const res = await api(baseUrl, '/api/reports/peak-hours?username=all', { token: hrToken });
    assert.equal(res.status, 403, 'HR\'s expanded visibility is specific to the personal dashboard — company-wide Peak Hours analytics stays Admin-only unless HR is also made a Director');
  });
});
