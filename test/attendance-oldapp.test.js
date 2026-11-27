// Old MIHIR app (camera never opens): check-in without the photo is allowed and marked; new apps / browsers still need it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember } = require('../testlib/helpers');

test('old app may check in without photo (marked); others need the live photo', async (t) => {
  const { baseUrl, stop } = await startTestServer();
  t.after(() => stop());
  const admin = await login(baseUrl, 'admin', 'admin123');
  assert.equal((await api(baseUrl, '/api/payroll/settings', { method: 'POST', token: admin, body: { selfieRequired: true } })).status, 200);
  const a = await createMember(baseUrl, admin, 'old.app', 'Old App', 'Execution Department');
  const b = await createMember(baseUrl, admin, 'new.app', 'New App', 'Execution Department');
  const punch = (tok, app, body) => fetch(`${baseUrl}/api/attendance/check-in`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}`, 'X-Mihir-App': app }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, data: await r.json() }));
  assert.equal((await punch(b, 'android-9', { noCamera: true })).status, 400, 'a new app needs the photo');
  assert.equal((await punch(b, 'web', { noCamera: true })).status, 400, 'a browser needs the photo');
  assert.equal((await punch(a, 'android-7', {})).status, 400, 'without asking for it, the photo is still required');
  const r = await punch(a, 'android-7', { noCamera: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const today = (await api(baseUrl, '/api/attendance/today', { token: admin })).data;
  const row = today.list.find(p => p.username === 'old.app');
  assert.ok(row.in, 'checked in');
  assert.match(JSON.stringify(row), /no photo \(old app/);
});
