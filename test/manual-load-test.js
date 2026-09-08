// A standalone load test (not part of `npm test` — this is a deliberate one-off measurement
// tool, not something that should run on every CI cycle). Run directly:
//   node test/manual-load-test.js
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');

function percentile(sorted, p) {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

async function timedRequest(fn) {
  const start = Date.now();
  const res = await fn();
  return { ms: Date.now() - start, status: res.status };
}

async function runScenario(name, concurrency, requestFn) {
  const start = Date.now();
  const results = await Promise.all(Array.from({ length: concurrency }, () => timedRequest(requestFn)));
  const totalMs = Date.now() - start;
  const durations = results.map(r => r.ms).sort((a, b) => a - b);
  const errors = results.filter(r => r.status >= 400).length;
  console.log(`\n=== ${name} (concurrency: ${concurrency}) ===`);
  console.log(`  total wall time: ${totalMs}ms | requests/sec: ${(concurrency / (totalMs / 1000)).toFixed(1)}`);
  console.log(`  p50: ${percentile(durations, 50)}ms | p95: ${percentile(durations, 95)}ms | p99: ${percentile(durations, 99)}ms | max: ${durations[durations.length - 1]}ms`);
  console.log(`  errors: ${errors}/${concurrency} (${((errors / concurrency) * 100).toFixed(1)}%)`);
  return { name, concurrency, totalMs, p50: percentile(durations, 50), p95: percentile(durations, 95), p99: percentile(durations, 99), errors };
}

(async () => {
  const { baseUrl, stop } = startTestServer();
  const adminToken = await login(baseUrl, 'admin', 'admin123');

  // Seed 150 real member accounts so login/dashboard/task-list scenarios reflect a realistic
  // company size, not an empty database.
  const usernames = [];
  for (let i = 0; i < 150; i++) {
    usernames.push(`loadtest${i}`);
    await api(baseUrl, '/api/users', { method: 'POST', token: adminToken, body: { username: `loadtest${i}`, password: 'ValidPass123', name: `Load Test ${i}`, role: 'member', team: 'Site Team' } });
  }
  const tokens = await Promise.all(usernames.slice(0, 100).map(u => login(baseUrl, u, 'ValidPass123')));
  // Give each of the first 50 a couple of real tasks so list/dashboard endpoints have real rows to return.
  for (let i = 0; i < 50; i++) {
    await api(baseUrl, '/api/tasks', { method: 'POST', token: adminToken, body: { title: `Load Task ${i}`, priority: 'medium', deadline: futureDate(), assignedToList: [usernames[i]] } });
  }

  const results = [];
  results.push(await runScenario('Login (100 concurrent)', 100, () => api(baseUrl, '/api/auth/login', { method: 'POST', body: { username: 'loadtest0', password: 'ValidPass123' } })));
  results.push(await runScenario('Dashboard (My Tasks, 100 concurrent, distinct users)', 100, (() => { let i = 0; return () => api(baseUrl, '/api/tasks/mine', { token: tokens[i++ % tokens.length] }); })()));
  results.push(await runScenario('Task creation (100 concurrent, distinct users)', 100, (() => { let i = 0; return () => api(baseUrl, '/api/tasks', { method: 'POST', token: tokens[i % tokens.length], body: { title: `Concurrent Create ${i++}`, priority: 'low', deadline: futureDate(), assignedToList: [usernames[i % usernames.length]] } }); })()));
  results.push(await runScenario('Admin All Tasks listing (50 concurrent)', 50, () => api(baseUrl, '/api/tasks', { token: adminToken })));
  results.push(await runScenario('Notifications fetch (100 concurrent, distinct users)', 100, (() => { let i = 0; return () => api(baseUrl, '/api/notifications', { token: tokens[i++ % tokens.length] }); })()));

  console.log('\n=== Summary ===');
  results.forEach(r => console.log(`${r.name}: p50=${r.p50}ms p95=${r.p95}ms p99=${r.p99}ms errors=${r.errors}`));

  await stop();
  process.exit(0);
})();
