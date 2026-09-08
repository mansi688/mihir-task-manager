const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');

// Schema note (see GUIDE.md): audit_log stores actor_username, actor_name, action, details,
// created_at — a narrative "details" string, not separate structured old-value/new-value
// columns. This verifies what the schema actually captures is accurate and complete for who,
// what, when, and reason — not that it matches a richer structured schema it was never built
// with.
test('audit log captures who/what/when/reason correctly for every major action', async (t) => {
  const { baseUrl, stop } = startTestServer();
  t.after(() => stop());

  const adminToken = await login(baseUrl, 'admin', 'admin123');
  const aliceToken = await createMember(baseUrl, adminToken, 'alice', 'Alice');
  const bobToken = await createMember(baseUrl, adminToken, 'bob', 'Bob');

  await t.test('account_created captures the actor and the new account\'s details', async () => {
    const before = (await api(baseUrl, '/api/audit-log', { token: adminToken })).data.length;
    await api(baseUrl, '/api/users', { method: 'POST', token: adminToken, body: { username: 'audit_check', password: 'ValidPass123', name: 'Audit Check', role: 'member' } });
    const log = (await api(baseUrl, '/api/audit-log', { token: adminToken })).data;
    assert.equal(log.length, before + 1);
    const entry = log[0];
    assert.equal(entry.actor_username, 'admin', 'actor (who) must be recorded');
    assert.equal(entry.action, 'account_created', 'action (what) must be recorded');
    assert.ok(entry.created_at, 'timestamp (when) must be recorded');
    assert.match(entry.details, /audit_check/, 'the new username should appear in the details');
  });

  await t.test('task_reopened captures the exact reason text, verbatim', async () => {
    const create = await api(baseUrl, '/api/tasks', { method: 'POST', token: aliceToken, body: { title: 'Audit Reopen Test', priority: 'low', deadline: futureDate(), assignedToList: ['bob'] } });
    const id = create.data.id;
    await api(baseUrl, `/api/tasks/${id}/close`, { method: 'POST', token: aliceToken });
    const uniqueReason = 'Missing the specific site photo from the east wall, needs redoing';
    await api(baseUrl, `/api/tasks/${id}/reopen`, { method: 'POST', token: aliceToken, body: { reason: uniqueReason } });

    const log = (await api(baseUrl, '/api/audit-log', { token: adminToken })).data;
    const entry = log.find(e => e.action === 'task_reopened' && e.details.includes('Audit Reopen Test'));
    assert.ok(entry, 'a task_reopened entry must exist for this task');
    assert.match(entry.details, new RegExp(uniqueReason), 'the exact reason text must be preserved verbatim in the audit log, not paraphrased or dropped');
    assert.equal(entry.actor_username, 'alice');
  });

  await t.test('task_cancelled captures the reason too', async () => {
    const create = await api(baseUrl, '/api/tasks', { method: 'POST', token: aliceToken, body: { title: 'Audit Cancel Test', priority: 'low', deadline: futureDate(), assignedToList: ['bob'] } });
    const uniqueReason = 'Duplicate of another request already in progress';
    await api(baseUrl, `/api/tasks/${create.data.id}/cancel`, { method: 'POST', token: aliceToken, body: { reason: uniqueReason } });

    const log = (await api(baseUrl, '/api/audit-log', { token: adminToken })).data;
    const entry = log.find(e => e.action === 'task_cancelled' && e.details.includes('Audit Cancel Test'));
    assert.ok(entry);
    assert.match(entry.details, new RegExp(uniqueReason));
  });

  await t.test('password_reset and team_lead_changed both correctly identify who was affected', async () => {
    await api(baseUrl, '/api/users/bob/reset-password', { method: 'POST', token: adminToken, body: { newPassword: 'NewPassword123' } });
    await api(baseUrl, '/api/users/bob/team-lead', { method: 'POST', token: adminToken, body: { isTeamLead: true } });

    const log = (await api(baseUrl, '/api/audit-log', { token: adminToken })).data;
    const pwEntry = log.find(e => e.action === 'password_reset' && e.details.includes('bob'));
    const leadEntry = log.find(e => e.action === 'team_lead_changed' && e.details.includes('bob'));
    assert.ok(pwEntry, 'password reset for bob must be logged and name him');
    assert.ok(leadEntry, 'team-lead change for bob must be logged and name him');
  });

  await t.test('a rejected/unauthorized reopen attempt logs nothing at all', async () => {
    const create = await api(baseUrl, '/api/tasks', { method: 'POST', token: aliceToken, body: { title: 'Audit No False Entry Test', priority: 'low', deadline: futureDate(), assignedToList: ['bob'] } });
    await api(baseUrl, `/api/tasks/${create.data.id}/close`, { method: 'POST', token: aliceToken });
    const before = (await api(baseUrl, '/api/audit-log', { token: adminToken })).data.length;
    // bob is an assignee, not the creator — this reopen attempt must be rejected (403) and
    // must not create any audit trail implying a reopen happened.
    await api(baseUrl, `/api/tasks/${create.data.id}/reopen`, { method: 'POST', token: bobToken, body: { reason: 'unauthorized attempt' } });
    const after = (await api(baseUrl, '/api/audit-log', { token: adminToken })).data.length;
    assert.equal(after, before, 'a rejected reopen attempt must not create any audit log entry');
  });
});
