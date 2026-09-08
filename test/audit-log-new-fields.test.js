const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember } = require('../testlib/helpers');

test('audit log now captures IP address, device, and actor department', async (t) => {
  const { baseUrl, stop } = startTestServer();
  t.after(() => stop());

  const adminToken = await login(baseUrl, 'admin', 'admin123');
  await createMember(baseUrl, adminToken, 'deptcheck', 'Dept Check', 'Estimation Department');

  const res = await fetch(`${baseUrl}/api/users/deptcheck/team-lead`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}`, 'User-Agent': 'RealBrowserTestAgent/1.0' },
    body: JSON.stringify({ isTeamLead: true }),
  });
  assert.equal(res.status, 200);

  const log = (await api(baseUrl, '/api/audit-log', { token: adminToken })).data;
  const entry = log.find(e => e.action === 'team_lead_changed' && e.details.includes('deptcheck'));
  assert.ok(entry, 'the team-lead-change entry must exist');
  assert.ok(entry.ip_address, 'an IP address must be recorded');
  assert.equal(entry.device, 'RealBrowserTestAgent/1.0', 'the device/user-agent string must be captured exactly');
  assert.equal(entry.actor_team, null, 'admin has no team of their own, so actor_team is correctly null here — not a bug');

  // Verify department capture through an audit-logged action a departmental member can
  // trigger directly: cancelling a task they created themselves.
  const leadToken = await login(baseUrl, 'deptcheck', 'TestPass123');
  const futureDeadline = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  const task = await api(baseUrl, '/api/tasks', { method: 'POST', token: leadToken, body: { title: 'Dept Audit Test Task', priority: 'low', deadline: futureDeadline, assignedToList: ['deptcheck'] } });
  await api(baseUrl, `/api/tasks/${task.data.id}/cancel`, { method: 'POST', token: leadToken, body: { reason: 'Testing department capture in the audit log' } });

  const log2 = (await api(baseUrl, '/api/audit-log', { token: adminToken })).data;
  const cancelEntry = log2.find(e => e.action === 'task_cancelled' && e.details.includes('Dept Audit Test Task'));
  assert.ok(cancelEntry, 'the cancellation must be logged');
  assert.equal(cancelEntry.actor_team, 'Estimation Department', "the actor's real department must be captured correctly, not left blank");
});
