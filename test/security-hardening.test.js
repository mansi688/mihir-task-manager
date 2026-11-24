// Security hardening: headers / CSP, JWT algorithm, progressive account lock, company PIN guard, admin new-device alert.
const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { startTestServer, api, login, createMember } = require('../testlib/helpers');

test('security hardening', async (t) => {
  const { baseUrl, stop, getRawClient } = await startTestServer();
  t.after(() => stop());
  const raw = await getRawClient(); t.after(() => raw.end());
  const admin = await login(baseUrl, 'admin', 'admin123');
  const P = (tok, path, body, headers) => api(baseUrl, path, { method: 'POST', token: tok, body, headers });

  await t.test('security headers and a strict script policy on the page and the API', async () => {
    const page = await fetch(`${baseUrl}/`);
    const csp = page.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self'(;|$)/, 'only scripts from this site');
    assert.doesNotMatch(csp.split(';').find(x => x.trim().startsWith('script-src')), /unsafe-inline|unsafe-eval/);
    assert.match(csp, /object-src 'none'/); assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(page.headers.get('cross-origin-opener-policy'), 'same-origin');
    const html = await page.text();
    assert.doesNotMatch(html, /<script>(?!<\/script>)/, 'no inline scripts in the page');
    assert.doesNotMatch(html, /\son(click|load|error)=/i, 'no inline event handlers');
    assert.match(html, /<script src="\/boot.js"><\/script>/);
    const apiRes = await fetch(`${baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${admin}` } });
    assert.equal(apiRes.headers.get('cache-control'), 'no-store');
    assert.equal(apiRes.headers.get('x-powered-by'), null);
  });

  await t.test('a token with another algorithm or a wrong key is refused', async () => {
    const payload = JSON.parse(Buffer.from(admin.split('.')[1], 'base64url').toString());
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const none = `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.`;
    assert.equal((await api(baseUrl, '/api/auth/me', { token: none })).status, 401);
    const forged = jwt.sign({ username: 'admin', role: 'admin', tv: 0 }, 'guessed-secret');
    assert.equal((await api(baseUrl, '/api/auth/me', { token: forged })).status, 401);
  });

  await t.test('wrong passwords lock the account longer each time; admins are told from the 10th', async () => {
    await createMember(baseUrl, admin, 'brute.x', 'Brute X', 'Store Department');
    const L = (pw) => P(null, '/api/auth/login', { username: 'brute.x', password: pw });
    for (let i = 0; i < 5; i++) await L('wrong' + i);
    assert.equal((await L('TestPass123')).status, 423, 'locked after 5');
    let lock = (await raw.query("SELECT locked_until FROM users WHERE username='brute.x'")).rows[0].locked_until;
    const m1 = (Date.parse(lock) - Date.now()) / 60000; assert.ok(m1 > 2 && m1 <= 3.1, String(m1));
    await raw.query("UPDATE users SET locked_until=NULL WHERE username='brute.x'");
    for (let i = 0; i < 5; i++) await L('again' + i);
    lock = (await raw.query("SELECT locked_until FROM users WHERE username='brute.x'")).rows[0].locked_until;
    const m2 = (Date.parse(lock) - Date.now()) / 60000; assert.ok(m2 > 14 && m2 <= 15.1, String(m2));
    const notes = (await api(baseUrl, '/api/notifications', { token: admin })).data.items;
    assert.ok(notes.some(n => /brute\.x.*10 wrong passwords/.test(n.message)));
    // an unknown username answers the same way
    const u = await P(null, '/api/auth/login', { username: 'nobody.here', password: 'x' });
    assert.equal(u.status, 401); assert.equal(u.data.error, 'Invalid username or password.');
  });

  await t.test('company PIN: 20 wrong PINs company-wide switch it off for an hour', async () => {
    assert.equal((await P(admin, '/api/admin/company-pin', { pin: '583920' })).status, 200);
    for (let k = 0; k < 5; k++) {
      await createMember(baseUrl, admin, `pin.u${k}`, `Pin U${k}`, 'Store Department');
      for (let i = 0; i < 4; i++) await P(null, '/api/auth/forgot-password', { username: `pin.u${k}`, pin: String(100000 + k * 10 + i), newPassword: 'Brick@2468x' });
    }
    await createMember(baseUrl, admin, 'pin.ok', 'Pin OK', 'Store Department');
    const r = await P(null, '/api/auth/forgot-password', { username: 'pin.ok', pin: '583920', newPassword: 'Brick@2468x' });
    assert.equal(r.status, 400, 'the right company PIN no longer works while paused');
    const notes = (await api(baseUrl, '/api/notifications', { token: admin })).data.items;
    assert.ok(notes.some(n => /20 wrong recovery PINs/.test(n.message)));
  });

  await t.test('admin sign-in from a new device is reported', async () => {
    const r = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'NewPhone/1.0 (test)' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) });
    assert.equal(r.status, 200);
    const notes = (await api(baseUrl, '/api/notifications', { token: admin })).data.items;
    assert.ok(notes.some(n => /New sign-in to your admin account/.test(n.message) && /NewPhone/.test(n.message)));
  });
});
