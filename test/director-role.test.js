const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');

test('Director role: department-scoped by default, expandable only by Admin', async (t) => {
  const { baseUrl, stop } = await startTestServer();
  t.after(() => stop());
  const adminToken = await login(baseUrl, 'admin', 'admin123');

  // Admin's own display name should now be "Mihir Sabadra" on a fresh install.
  const me = await api(baseUrl, '/api/auth/me', { token: adminToken });
  assert.equal(me.data.name, 'Mihir Sabadra');

  await api(baseUrl, '/api/teams', { method: 'POST', token: adminToken, body: { name: 'Estimation Department' } });
  await api(baseUrl, '/api/teams', { method: 'POST', token: adminToken, body: { name: 'Purchase Department' } });

  // Create a director in Estimation, and regular staff in both departments with real completed work.
  const createDirectorRes = await api(baseUrl, '/api/users', { method: 'POST', token: adminToken, body: { username: 'director1', password: 'ValidPass123', name: 'Director One', role: 'director', team: 'Estimation Department' } });
  assert.equal(createDirectorRes.status, 200);
  const directorToken = await login(baseUrl, 'director1', 'ValidPass123');

  const estStaffToken = await createMember(baseUrl, adminToken, 'est_staff', 'Est Staff', 'Estimation Department');
  const purStaffToken = await createMember(baseUrl, adminToken, 'pur_staff', 'Pur Staff', 'Purchase Department');

  const t1 = await api(baseUrl, '/api/tasks', { method: 'POST', token: adminToken, body: { title: 'Est Task', priority: 'low', deadline: futureDate(), assignedToList: ['est_staff'] } });
  await api(baseUrl, `/api/tasks/${t1.data.id}/submit-mine`, { method: 'POST', token: estStaffToken, body: { note: 'Fully done here.' } });
  await api(baseUrl, `/api/tasks/${t1.data.id}/approve/est_staff`, { method: 'POST', token: adminToken });

  const t2 = await api(baseUrl, '/api/tasks', { method: 'POST', token: adminToken, body: { title: 'Pur Task', priority: 'low', deadline: futureDate(), assignedToList: ['pur_staff'] } });
  await api(baseUrl, `/api/tasks/${t2.data.id}/submit-mine`, { method: 'POST', token: purStaffToken, body: { note: 'Fully done here too.' } });
  await api(baseUrl, `/api/tasks/${t2.data.id}/approve/pur_staff`, { method: 'POST', token: adminToken });

  await t.test('by default, a Director sees only their own department\'s Performance stats', async () => {
    const stats = await api(baseUrl, '/api/reports/completion', { token: directorToken });
    assert.equal(stats.status, 200);
    const usernames = stats.data.map(s => s.username);
    assert.ok(usernames.includes('est_staff'), 'must see their own department');
    assert.ok(!usernames.includes('pur_staff'), 'must NOT see a department they have not been granted');
  });

  await t.test('by default, a Director\'s Peak Hours is scoped the same way', async () => {
    const requestOwnDept = await api(baseUrl, '/api/reports/peak-hours?username=est_staff', { token: directorToken });
    assert.equal(requestOwnDept.status, 200);
    const requestOtherDept = await api(baseUrl, '/api/reports/peak-hours?username=pur_staff', { token: directorToken });
    assert.equal(requestOtherDept.status, 403, 'a Director must not be able to view an individual outside their visible departments');
  });

  await t.test('a Director cannot grant themselves additional visibility', async () => {
    const res = await api(baseUrl, '/api/users/director1/visible-departments', { method: 'POST', token: directorToken, body: { departments: ['Purchase Department'] } });
    assert.equal(res.status, 403, 'only Admin can grant visibility, never the Director themselves');
  });

  await t.test('once Admin grants Purchase Department visibility, the Director can see it', async () => {
    const grant = await api(baseUrl, '/api/users/director1/visible-departments', { method: 'POST', token: adminToken, body: { departments: ['Purchase Department'] } });
    assert.equal(grant.status, 200);

    const stats = await api(baseUrl, '/api/reports/completion', { token: directorToken });
    const usernames = stats.data.map(s => s.username);
    assert.ok(usernames.includes('pur_staff'), 'after being granted, the Director should now see the additional department too');
    assert.ok(usernames.includes('est_staff'), 'and should still see their own department');

    const peakHoursNowAllowed = await api(baseUrl, '/api/reports/peak-hours?username=pur_staff', { token: directorToken });
    assert.equal(peakHoursNowAllowed.status, 200, 'Peak Hours visibility should expand the same way once granted');
  });

  await t.test('Admin itself is never restricted, regardless of department', async () => {
    const stats = await api(baseUrl, '/api/reports/completion', { token: adminToken });
    const usernames = stats.data.map(s => s.username);
    assert.ok(usernames.includes('est_staff') && usernames.includes('pur_staff'), 'Admin always sees everyone, unrestricted');
  });

  await t.test('Audit Log and Accounts management stay strictly Admin-only, even for a Director', async () => {
    const auditAttempt = await api(baseUrl, '/api/audit-log', { token: directorToken });
    assert.equal(auditAttempt.status, 403);
    const accountsAttempt = await api(baseUrl, '/api/users', { token: directorToken });
    assert.equal(accountsAttempt.status, 403);
  });

  await t.test('a Director can still do everything a normal member can — create and work on tasks', async () => {
    const create = await api(baseUrl, '/api/tasks', { method: 'POST', token: directorToken, body: { title: 'Director Made This', priority: 'low', deadline: futureDate(), assignedToList: ['director1'] } });
    assert.equal(create.status, 200, 'a Director is not blocked from ordinary task workflows, only reporting visibility is scoped');
  });
});
