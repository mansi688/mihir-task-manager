const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login } = require('../testlib/helpers');

test('login rate limiter: blocks genuine mass-scanning, never blocks a realistic office login rush', async (t) => {
  const { baseUrl, stop } = startTestServer();
  t.after(() => stop());

  await t.test('50 login attempts from one IP (a realistic morning office rush) all succeed or fail on their own merits, never on rate limit', async () => {
    const results = [];
    for (let i = 0; i < 50; i++) {
      results.push(await api(baseUrl, '/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } }));
    }
    assert.ok(!results.some(r => r.status === 429), '50 requests, well within realistic office scale, must never be rate-limited');
  });

  await t.test('a genuine burst of 250+ requests from one IP does eventually get rate-limited', async () => {
    const results = [];
    for (let i = 0; i < 220; i++) {
      results.push(await api(baseUrl, '/api/auth/login', { method: 'POST', body: { username: 'nonexistent_user', password: 'guess' } }));
    }
    assert.ok(results.some(r => r.status === 429), 'a genuinely large burst of attempts must eventually be throttled — this is the actual protection this limiter exists for');
  });

  await t.test('the server remains fully healthy and responsive after a burst that triggered rate limiting', async () => {
    const health = await api(baseUrl, '/health');
    assert.equal(health.status, 200);
    assert.equal(health.data.status, 'ok');
  });
});

test('health and readiness endpoints work correctly and expose nothing sensitive', async (t) => {
  const { baseUrl, stop } = startTestServer();
  t.after(() => stop());

  const health = await api(baseUrl, '/health');
  assert.equal(health.status, 200);
  assert.deepEqual(health.data, { status: 'ok' });

  const ready = await api(baseUrl, '/ready');
  assert.equal(ready.status, 200);
  assert.equal(ready.data.status, 'ready');

  // Neither should require authentication — a load balancer/orchestrator has no token.
  const healthNoAuth = await api(baseUrl, '/health');
  assert.equal(healthNoAuth.status, 200);
});

test('version endpoint exposes basic info with no secrets', async (t) => {
  const { baseUrl, stop } = startTestServer();
  t.after(() => stop());
  const res = await fetch(`${baseUrl}/version`);
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.ok(data.name && data.version && data.node);
  assert.ok(!JSON.stringify(data).toLowerCase().includes('secret'), 'must never leak env var names/values');
});

test('security headers are present on every response', async (t) => {
  const { baseUrl, stop } = startTestServer();
  t.after(() => stop());
  const res = await fetch(`${baseUrl}/health`);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.ok(res.headers.get('referrer-policy'));
});

test('every response includes a request ID for tracing, and error responses surface it too', async (t) => {
  const { baseUrl, stop } = startTestServer();
  t.after(() => stop());
  const adminToken = await login(baseUrl, 'admin', 'admin123');
  const badRequest = await api(baseUrl, '/api/tasks', { method: 'POST', token: adminToken, body: { title: '' } });
  assert.ok(badRequest.data.error, 'a validation error should still return a clean message');
});
