const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember } = require('../testlib/helpers');

// Forgot password without email: the person's own recovery PIN; otherwise their team lead (or Admin) resets it.
test('forgot password with a recovery PIN; team leads reset their own team', async (t) => {
  const { baseUrl, stop } = await startTestServer();
  t.after(() => stop());
  const admin = await login(baseUrl, 'admin', 'admin123');
  const P = (tok, path, body) => api(baseUrl, path, { method: 'POST', token: tok, body });
  const amit = await createMember(baseUrl, admin, 'amit.s', 'Amit S', 'Store Department');
  const lead = await createMember(baseUrl, admin, 'store.lead', 'Store Lead', 'Store Department');
  const other = await createMember(baseUrl, admin, 'sales.one', 'Sales One', 'Sales Department');
  assert.equal((await P(admin, '/api/users/store.lead/team-lead', { isTeamLead: true })).status, 200);
  const L = (u, p) => P(null, '/api/auth/login', { username: u, password: p });

  await t.test('no PIN yet → told to ask the team lead', async () => {
    const r = await P(null, '/api/auth/forgot-password', { username: 'amit.s', pin: '4826', newPassword: 'Brick@2468' });
    assert.equal(r.status, 400); assert.equal(r.data.noPin, true); assert.match(r.data.error, /Store Lead/);
    assert.equal((await L('amit.s', 'TestPass123')).data.user.hasRecoveryPin, false);
  });
  await t.test('setting a PIN (no weak PINs)', async () => {
    assert.equal((await P(amit, '/api/auth/recovery-pin', { pin: '12' })).status, 400);
    assert.equal((await P(amit, '/api/auth/recovery-pin', { pin: '1111' })).status, 400);
    assert.equal((await P(amit, '/api/auth/recovery-pin', { pin: '1234' })).status, 400);
    assert.equal((await P(amit, '/api/auth/recovery-pin', { pin: '4826' })).status, 200);
    assert.equal((await api(baseUrl, '/api/auth/me', { token: amit })).data.hasRecoveryPin, true);
  });
  await t.test('reset with the PIN; wrong PINs lock it for a while', async () => {
    assert.equal((await P(null, '/api/auth/forgot-password', { username: 'amit.s', pin: '0000', newPassword: 'Brick@2468' })).status, 400);
    const ok = await P(null, '/api/auth/forgot-password', { username: 'Amit.S', pin: '4826', newPassword: 'Brick@2468' });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    const li = await L('amit.s', 'Brick@2468');
    assert.equal(li.status, 200); assert.equal(li.data.user.mustChangePassword, false);
    for (let i = 0; i < 5; i++) await P(null, '/api/auth/forgot-password', { username: 'amit.s', pin: '9137', newPassword: 'Brick@1357' });
    assert.equal((await P(null, '/api/auth/forgot-password', { username: 'amit.s', pin: '4826', newPassword: 'Brick@1357' })).status, 429);
    assert.equal((await P(null, '/api/auth/reset-with-otp', { username: 'amit.s', otp: '1' })).status, 410, 'email codes are switched off');
  });
  await t.test('the team lead resets people of their own team only', async () => {
    assert.equal((await P(lead, '/api/users/amit.s/reset-password', { newPassword: 'Store@5512' })).status, 200);
    assert.equal((await L('amit.s', 'Store@5512')).data.user.mustChangePassword, true);
    assert.equal((await P(lead, '/api/users/sales.one/reset-password', { newPassword: 'Store@5512' })).status, 403);
    assert.equal((await P(other, '/api/users/amit.s/reset-password', { newPassword: 'Store@5512' })).status, 403);
    assert.equal((await P(lead, '/api/users/admin/reset-password', { newPassword: 'Store@5512' })).status, 403);
  });
});
