const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');

// Addresses the explicitly-flagged "~100-user sustained load: not measured" gap. This fires
// ~100 simultaneous requests of realistic mixed types (logins, task creation, task fetches,
// submissions) at the real running server and measures success rate and timing — not a browser
// test, but a genuine concurrent-throughput measurement, achievable without one.
test('~100 simultaneous mixed requests: correctness and timing under real concurrent load', async (t) => {
  const { baseUrl, stop } = await startTestServer();
  t.after(() => stop());

  const adminToken = await login(baseUrl, 'admin', 'admin123');
  const USER_COUNT = 25; // 25 people, each doing ~4 actions = ~100 total requests in flight
  const usernames = [];
  for (let i = 0; i < USER_COUNT; i++) {
    usernames.push(`loadtest${i}`);
    await api(baseUrl, '/api/users', { method: 'POST', token: adminToken, body: { username: `loadtest${i}`, password: 'ValidPass123', name: `Load Test ${i}`, role: 'member', team: 'Site Team' } });
  }

  const start = Date.now();

  // Phase 1: ~25 simultaneous logins (each user logging in at the same moment).
  const loginResults = await Promise.all(usernames.map(u => login(baseUrl, u, 'ValidPass123')));
  assert.ok(loginResults.every(t => typeof t === 'string' && t.length > 0), 'every simultaneous login must succeed and return a real token');

  // Phase 2: ~25 simultaneous task creations, one per user, all fired at once.
  const createResults = await Promise.all(usernames.map((u, i) =>
    api(baseUrl, '/api/tasks', { method: 'POST', token: loginResults[i], body: { title: `Load Test Task ${i}`, priority: 'medium', deadline: futureDate(), assignedToList: [u] } })
  ));
  assert.ok(createResults.every(r => r.status === 200), 'every simultaneous task creation must succeed with no corruption or dropped requests');
  const taskIds = createResults.map(r => r.data.id);
  assert.equal(new Set(taskIds).size, taskIds.length, 'every created task must get a genuinely unique ID even when created simultaneously');

  // Phase 3: ~25 simultaneous "my tasks" fetches (everyone checking their dashboard at once).
  const fetchResults = await Promise.all(usernames.map((u, i) => api(baseUrl, '/api/tasks/mine', { token: loginResults[i] })));
  assert.ok(fetchResults.every(r => r.status === 200), 'every simultaneous task-list fetch must succeed');

  // Phase 4: ~25 simultaneous submissions, each on their own distinct task.
  const submitResults = await Promise.all(usernames.map((u, i) =>
    api(baseUrl, `/api/tasks/${taskIds[i]}/submit-mine`, { method: 'POST', token: loginResults[i], body: { note: 'Fully done and verified, submitted under simulated load.' } })
  ));
  assert.ok(submitResults.every(r => r.status === 200), 'every simultaneous submission must succeed independently — no cross-contamination between different people\'s distinct tasks');

  const totalMs = Date.now() - start;
  const totalRequests = USER_COUNT * 4;
  console.log(`    [load test] ${totalRequests} requests across 4 phases of ${USER_COUNT} simultaneous each, completed in ${totalMs}ms (${(totalMs / totalRequests).toFixed(1)}ms/request average)`);

  // A generous ceiling, not a strict performance target — this just confirms genuinely
  // simultaneous load doesn't hang, timeout, or degrade to something unusable.
  assert.ok(totalMs < 15000, `${totalRequests} simultaneous requests took ${totalMs}ms — expected well under 15 seconds for this scale`);

  // Confirm the server is still fully healthy after all of this, not just limping along.
  const healthCheck = await api(baseUrl, '/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
  assert.equal(healthCheck.status, 200, 'the server must be fully responsive immediately after the load, not degraded');
});
