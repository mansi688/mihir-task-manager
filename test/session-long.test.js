// Logins stay signed in while used (no more "Session expired" every morning), renew quietly, and end at once on logout.
const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { startTestServer, api, login, createMember } = require('../testlib/helpers');

test('long, quietly renewed, revocable sessions', async (t) => {
  const { baseUrl, stop, getRawClient } = await startTestServer();
  t.after(() => stop());
  const raw = await getRawClient(); t.after(() => raw.end());
  const admin = await login(baseUrl, 'admin', 'admin123');
  const tok = await createMember(baseUrl, admin, 'site.w', 'Site Worker', 'Execution Department');
  const days = (x) => (jwt.decode(x).exp - jwt.decode(x).iat) / 86400;
  assert.equal(days(tok), 30, 'members: 30 days');
  assert.equal(days(admin), 7, 'admins: 7 days');

  // a token from yesterday still works and comes back renewed
  const p = jwt.decode(tok);
  const old = jwt.sign({ username: p.username, role: p.role, name: p.name, tv: p.tv, sid: p.sid, iat: Math.floor(Date.now() / 1000) - 20 * 3600 }, process.env.JWT_SECRET, { expiresIn: '30d' });
  const r = await fetch(`${baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${old}` } });
  assert.equal(r.status, 200);
  const fresh = r.headers.get('x-session-token');
  assert.ok(fresh && jwt.decode(fresh).iat > jwt.decode(old).iat, 'renewed');
  assert.equal(jwt.decode(fresh).sid, p.sid, 'same login');
  const r2 = await fetch(`${baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${tok}` } });
  assert.equal(r2.headers.get('x-session-token'), null, 'new tokens are not renewed on every call');

  // unused for longer than 30 days → log in again
  await raw.query("UPDATE sessions SET last_seen=$2 WHERE id=$1", [p.sid, new Date(Date.now() - 31 * 864e5).toISOString()]);
  await new Promise(res => setTimeout(res, 50));
  const tok2 = await login(baseUrl, 'site.w', 'TestPass123');
  const p2 = jwt.decode(tok2);
  await raw.query("UPDATE sessions SET last_seen=$2 WHERE id=$1", [p2.sid, new Date(Date.now() - 31 * 864e5).toISOString()]);
  const idle = await api(baseUrl, '/api/auth/me', { token: tok2 });
  assert.equal(idle.status, 401); assert.match(idle.data.error, /long time/);

  // logout ends the login on the server: the same token no longer works
  const tok3 = await login(baseUrl, 'site.w', 'TestPass123');
  assert.equal((await api(baseUrl, '/api/auth/me', { token: tok3 })).status, 200);
  assert.equal((await api(baseUrl, '/api/auth/logout', { method: 'POST', token: tok3 })).status, 200);
  const after = await api(baseUrl, '/api/auth/me', { token: tok3 });
  assert.equal(after.status, 401); assert.match(after.data.error, /logged out/);

  // the app reports its version; the latest Android version is announced by /api/sync
  const s = await fetch(`${baseUrl}/api/sync`, { headers: { Authorization: `Bearer ${tok}`, 'X-Mihir-App': 'android-7' } }).then(x => x.json());
  assert.ok(s.la >= 10, 'the version inside the APK');
  const v = await fetch(`${baseUrl}/app/android/version`).then(x => x.json());
  assert.equal(v.versionCode, s.la); assert.match(v.sha256, /^[0-9a-f]{64}$/); assert.equal(v.path, '/app/android');
  await new Promise(res => setTimeout(res, 100));
  assert.equal((await raw.query("SELECT app_client FROM users WHERE username='site.w'")).rows[0].app_client, 'android-7');
});
