const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login } = require('../testlib/helpers');

test('a temporary password set by Admin always works for the new person', async (t) => {
  const { baseUrl, stop } = await startTestServer();
  t.after(() => stop());
  const admin = await login(baseUrl, 'admin', 'admin123');
  const P = (tok, path, body) => api(baseUrl, path, { method: 'POST', token: tok, body });
  const L = (username, password) => P(null, '/api/auth/login', { username, password });

  await t.test('created with a capital in the username and a space copied with the password', async () => {
    const c = await P(admin, '/api/users', { username: 'Mahesh.K', name: 'Mahesh K', password: ' Site@4821 ', role: 'member' });
    assert.equal(c.status, 200, JSON.stringify(c.data));
    assert.equal(c.data.username, 'mahesh.k');
    for (const [u, pw] of [['mahesh.k', 'Site@4821'], ['Mahesh.k', 'Site@4821'], [' mahesh.k ', 'Site@4821 ']]) {
      const r = await L(u, pw);
      assert.equal(r.status, 200, `${u} / ${JSON.stringify(pw)}: ${JSON.stringify(r.data)}`);
      assert.equal(r.data.user.mustChangePassword, true);
    }
    assert.equal((await L('mahesh.k', 'site@4821')).status, 401, 'the password itself is still exact');
  });

  await t.test('resetting the password also unlocks a locked account', async () => {
    for (let i = 0; i < 5; i++) await L('mahesh.k', 'wrong-password-1');
    assert.equal((await L('mahesh.k', 'Site@4821')).status, 423);
    assert.equal((await P(admin, '/api/users/mahesh.k/reset-password', { newPassword: 'Tower@7310 ' })).status, 200);
    const r = await L('mahesh.k', 'Tower@7310');
    assert.equal(r.status, 200, JSON.stringify(r.data));
  });
});
