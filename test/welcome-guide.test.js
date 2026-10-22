const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember } = require('../testlib/helpers');

test('welcome guide: new accounts must finish it once; score kept; Admin can ask again', async (t) => {
  const { baseUrl, stop } = await startTestServer();
  t.after(stop);
  const admin = await login(baseUrl, 'admin', 'admin123');
  const P = (tok, path, body) => api(baseUrl, path, { method: 'POST', token: tok, body });
  const G = (tok, path) => api(baseUrl, path, { token: tok });

  // the starter admin account is not new → no guide
  const adminLogin = await P(null, '/api/auth/login', { username: 'admin', password: 'admin123' });
  assert.equal(adminLogin.data.user.needsGuide, false);

  const ravi = await createMember(baseUrl, admin, 'ravi.g', 'Ravi Guide', 'Site');
  const raviLogin = await P(null, '/api/auth/login', { username: 'ravi.g', password: 'TestPass123' });
  assert.equal(raviLogin.status, 200, JSON.stringify(raviLogin.data));
  assert.equal(raviLogin.data.user.needsGuide, true, 'a new account sees the guide');
  assert.equal((await G(ravi, '/api/auth/me')).data.needsGuide, true);

  for (const bad of [{}, { lang: 'fr', score: 5, total: 5 }, { lang: 'hi', score: 6, total: 5 }, { lang: 'hi', score: -1, total: 5 }, { lang: 'hi', score: 3 }]) {
    assert.equal((await P(ravi, '/api/auth/guide-complete', bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await P(null, '/api/auth/guide-complete', { lang: 'hi', score: 5, total: 5 })).status, 401);
  assert.equal((await P(ravi, '/api/auth/guide-complete', { lang: 'mr', score: 4, total: 5, attempts: 2 })).status, 200);
  assert.equal((await G(ravi, '/api/auth/me')).data.needsGuide, false);
  assert.equal((await P(null, '/api/auth/login', { username: 'ravi.g', password: 'TestPass123' })).data.user.needsGuide, false, 'not again on the next login');

  const row = (await G(admin, '/api/users')).data.find(u => u.username === 'ravi.g');
  assert.equal(row.guide_lang, 'mr'); assert.equal(row.guide_score, 4); assert.equal(row.guide_total, 5); assert.ok(row.guide_done_at);

  assert.equal((await P(ravi, '/api/users/ravi.g/guide-again')).status, 403, 'only Admin');
  assert.equal((await P(admin, '/api/users/nobody.x/guide-again')).status, 404);
  assert.equal((await P(admin, '/api/users/ravi.g/guide-again')).status, 200);
  assert.equal((await G(ravi, '/api/auth/me')).data.needsGuide, true, 'Admin asked for it again');
  // Skipping counts as done (never shown again) and is recorded without a score
  const sita = await createMember(baseUrl, admin, 'sita.g', 'Sita Guide', 'Site');
  assert.equal((await G(sita, '/api/auth/me')).data.needsGuide, true);
  assert.equal((await P(sita, '/api/auth/guide-complete', { skipped: true, lang: 'hi' })).status, 200);
  assert.equal((await G(sita, '/api/auth/me')).data.needsGuide, false, 'skipped → not shown again');
  assert.equal((await P(null, '/api/auth/login', { username: 'sita.g', password: 'TestPass123' })).data.user.needsGuide, false);
  const sRow = (await G(admin, '/api/users')).data.find(u => u.username === 'sita.g');
  assert.ok(sRow.guide_done_at); assert.equal(sRow.guide_score, null); assert.equal(sRow.guide_lang, 'hi');
  const audit = (await G(admin, '/api/audit-log?limit=50')).data;
  const items = Array.isArray(audit) ? audit : (audit.items || audit.entries || []);
  assert.ok(items.some(e => e.action === 'guide_completed'), 'finishing is in the audit log');
  assert.ok(items.some(e => e.action === 'guide_skipped'), 'skipping is in the audit log');
});
