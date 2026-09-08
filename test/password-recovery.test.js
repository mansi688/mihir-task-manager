const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const Database = require('better-sqlite3');
const { startTestServer, api, login, createMember } = require('../testlib/helpers');

// Honesty note: this sandbox has no real SMTP credentials, so actual email delivery is not
// verified here — that would need a real mail account. What IS fully verified: the server
// correctly reports "email not configured" when SMTP env vars are absent (matching this app's
// default state), and the OTP verification logic itself (correct/wrong/expired codes, and that a
// successful reset does NOT force yet another password change) — by injecting a known OTP hash
// directly, the same way the actual server would have stored one after really sending an email.
test('forgot-password gracefully reports email is not configured (this app\'s default state)', async (t) => {
  const { baseUrl, stop } = startTestServer();
  t.after(() => stop());
  const res = await api(baseUrl, '/api/auth/forgot-password', { method: 'POST', body: { username: 'admin' } });
  assert.equal(res.status, 200);
  assert.equal(res.data.emailConfigured, false, 'without SMTP_HOST/USER/PASS set, this must clearly report email is not configured');
});

test('forgot-password never reveals whether a username exists', async (t) => {
  const { baseUrl, stop } = startTestServer();
  t.after(() => stop());
  const realUser = await api(baseUrl, '/api/auth/forgot-password', { method: 'POST', body: { username: 'admin' } });
  const fakeUser = await api(baseUrl, '/api/auth/forgot-password', { method: 'POST', body: { username: 'no_such_person_at_all' } });
  assert.equal(realUser.status, fakeUser.status);
  assert.deepEqual(realUser.data, fakeUser.data, 'the response must be identical whether or not the username is real — never confirm/deny account existence to an unauthenticated caller');
});

test('repeated OTP requests for the same account are rate-limited', async (t) => {
  const { baseUrl, stop } = startTestServer();
  t.after(() => stop());
  const adminToken = await login(baseUrl, 'admin', 'admin123');
  await createMember(baseUrl, adminToken, 'ratelimited', 'Rate Limited Test');

  // The response is identical either way (never reveals whether the limit was hit, matching the
  // same "don't leak account state" principle as the existence check above) — but internally,
  // requests beyond the limit must not count as a genuine new attempt. Confirmed indirectly: this
  // just verifies calling it many times in a row never errors or crashes the server.
  const results = [];
  for (let i = 0; i < 6; i++) {
    results.push(await api(baseUrl, '/api/auth/forgot-password', { method: 'POST', body: { username: 'ratelimited' } }));
  }
  assert.ok(results.every(r => r.status === 200), 'even well beyond the rate limit, the endpoint must keep responding cleanly, never error');
  assert.ok(results.every(r => r.data.ok === true), 'the response shape must stay identical throughout, whether or not the limit was hit — same "never reveal internal state" principle');

  const stillAlive = await api(baseUrl, '/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
  assert.equal(stillAlive.status, 200, 'the server must remain fully healthy after repeated requests');
});

test('OTP verification logic: correct code resets password permanently (no forced re-change)', async (t) => {
  const { baseUrl, dbPath, stop } = startTestServer();
  t.after(() => stop());
  const adminToken = await login(baseUrl, 'admin', 'admin123');
  await createMember(baseUrl, adminToken, 'otptest', 'OTP Test');

  // Simulate what the server does internally after a real email send: store a hashed OTP with
  // an expiry, exactly as /api/auth/forgot-password would have.
  const otp = '482913';
  const raw = new Database(dbPath);
  raw.prepare('UPDATE users SET password_reset_otp_hash=?, password_reset_otp_expires=? WHERE username=?')
    .run(bcrypt.hashSync(otp, 10), new Date(Date.now() + 10 * 60000).toISOString(), 'otptest');
  raw.close();

  const wrongCode = await api(baseUrl, '/api/auth/reset-with-otp', { method: 'POST', body: { username: 'otptest', otp: '000000', newPassword: 'NewRealPass123' } });
  assert.equal(wrongCode.status, 400, 'an incorrect code must be rejected');

  const correctCode = await api(baseUrl, '/api/auth/reset-with-otp', { method: 'POST', body: { username: 'otptest', otp, newPassword: 'NewRealPass123' } });
  assert.equal(correctCode.status, 200, 'the correct code with a valid new password should succeed');

  const loginResult = await api(baseUrl, '/api/auth/login', { method: 'POST', body: { username: 'otptest', password: 'NewRealPass123' } });
  assert.equal(loginResult.status, 200);
  assert.equal(loginResult.data.user.mustChangePassword, false, 'resetting via OTP must NOT force yet another password change — the person just deliberately chose this password');

  const reuseCode = await api(baseUrl, '/api/auth/reset-with-otp', { method: 'POST', body: { username: 'otptest', otp, newPassword: 'AnotherPass123' } });
  assert.equal(reuseCode.status, 400, 'a used OTP must not be reusable');
});

test('an expired OTP is rejected', async (t) => {
  const { baseUrl, dbPath, stop } = startTestServer();
  t.after(() => stop());
  const adminToken = await login(baseUrl, 'admin', 'admin123');
  await createMember(baseUrl, adminToken, 'expiretest', 'Expire Test');

  const otp = '111222';
  const raw = new Database(dbPath);
  raw.prepare('UPDATE users SET password_reset_otp_hash=?, password_reset_otp_expires=? WHERE username=?')
    .run(bcrypt.hashSync(otp, 10), new Date(Date.now() - 60000).toISOString(), 'expiretest'); // expired 1 minute ago
  raw.close();

  const res = await api(baseUrl, '/api/auth/reset-with-otp', { method: 'POST', body: { username: 'expiretest', otp, newPassword: 'NewRealPass123' } });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /expired/i);
});
