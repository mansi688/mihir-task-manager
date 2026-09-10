const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');

test('authentication, account management, and delegated team-lead permissions', async (t) => {
  const { baseUrl, stop } = await startTestServer();
  t.after(() => stop());

  const adminToken = await login(baseUrl, 'admin', 'admin123');

  await t.test('wrong password is rejected with a clear error, not a stack trace', async () => {
    const res = await api(baseUrl, '/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'totally-wrong' } });
    assert.equal(res.status, 401);
    assert.ok(res.data.error && !/error:|at Object|stack/i.test(res.data.error));
  });

  await t.test('5 failed logins lock the account, and a 6th (even correct) attempt is refused', async () => {
    await createMember(baseUrl, adminToken, 'locktest', 'Lock Test', 'Site Team');
    for (let i = 0; i < 5; i++) {
      await api(baseUrl, '/api/auth/login', { method: 'POST', body: { username: 'locktest', password: 'wrong-password' } });
    }
    const correctButLocked = await api(baseUrl, '/api/auth/login', { method: 'POST', body: { username: 'locktest', password: 'TestPass123' } });
    assert.equal(correctButLocked.status, 423, 'account should be locked after 5 failed attempts, even with the right password on the 6th try');
  });

  await t.test('account creation validates username format and password length', async () => {
    const badUsername = await api(baseUrl, '/api/users', { method: 'POST', token: adminToken, body: { username: 'a b!', password: 'ValidPass123', name: 'Bad', role: 'member' } });
    assert.equal(badUsername.status, 400);

    const shortPassword = await api(baseUrl, '/api/users', { method: 'POST', token: adminToken, body: { username: 'shortpw', password: '123', name: 'Short', role: 'member' } });
    assert.equal(shortPassword.status, 400);

    const duplicate = await api(baseUrl, '/api/users', { method: 'POST', token: adminToken, body: { username: 'locktest', password: 'ValidPass123', name: 'Dup', role: 'member' } });
    assert.equal(duplicate.status, 409, 'creating a duplicate username must be refused');
  });

  await t.test('a team lead can add members to their OWN team, but not assign an arbitrary team', async () => {
    const leadToken = await createMember(baseUrl, adminToken, 'purchase_lead', 'Purchase Lead Test', 'Purchase Department');
    await api(baseUrl, '/api/users/purchase_lead/team-lead', { method: 'POST', token: adminToken, body: { isTeamLead: true } });
    const relogin = await login(baseUrl, 'purchase_lead', 'TestPass123');

    const added = await api(baseUrl, '/api/team/members', { method: 'POST', token: relogin, body: { username: 'new_hire', password: 'ValidPass123', name: 'New Hire' } });
    assert.equal(added.status, 200, JSON.stringify(added.data));

    const newHireCheck = await api(baseUrl, '/api/users/directory', { token: adminToken });
    const newHire = newHireCheck.data.find(u => u.username === 'new_hire');
    assert.equal(newHire.team, 'Purchase Department', 'a delegated team lead should only ever be able to add someone to their own team');
  });

  await t.test('a plain (non-lead) member cannot add team members at all', async () => {
    const plainToken = await createMember(baseUrl, adminToken, 'plain_member', 'Plain Member', 'Site Team');
    const res = await api(baseUrl, '/api/team/members', { method: 'POST', token: plainToken, body: { username: 'sneaky', password: 'ValidPass123', name: 'Sneaky' } });
    assert.equal(res.status, 403);
  });

  await t.test('removing an account with open tasks is blocked; removing one with none succeeds', async () => {
    const busyToken = await createMember(baseUrl, adminToken, 'busy_person', 'Busy Person', 'Site Team');
    await api(baseUrl, '/api/tasks', { method: 'POST', token: adminToken, body: { title: 'Keeps busy_person busy', priority: 'low', deadline: futureDate(), assignedToList: ['busy_person'] } });

    const blockedRemoval = await api(baseUrl, '/api/users/busy_person', { method: 'DELETE', token: adminToken });
    assert.equal(blockedRemoval.status, 400, 'an account still involved in an open task must not be removable');

    await createMember(baseUrl, adminToken, 'free_person', 'Free Person', 'Site Team');
    const freeRemoval = await api(baseUrl, '/api/users/free_person', { method: 'DELETE', token: adminToken });
    assert.equal(freeRemoval.status, 200, 'an account with no open tasks should be removable');
  });

  await t.test('admin cannot remove their own account', async () => {
    const res = await api(baseUrl, '/api/users/admin', { method: 'DELETE', token: adminToken });
    assert.equal(res.status, 400);
  });

  await t.test('a member cannot access admin-only account management endpoints', async () => {
    const memberToken = await login(baseUrl, 'plain_member', 'TestPass123');
    const res = await api(baseUrl, '/api/users', { token: memberToken });
    assert.equal(res.status, 403);
  });
});
