// Import user accounts from Excel / CSV (Accounts page, Admin only).
const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { startTestServer, api, login, createMember } = require('../testlib/helpers');

test('accounts import: template, preview with problems, create, generated credentials, admin only', async (t) => {
  const { baseUrl, stop } = await startTestServer();
  t.after(stop);
  const admin = await login(baseUrl, 'admin', 'admin123');
  const P = (p, token, body) => api(baseUrl, p, { method: 'POST', token, body });
  const tpl = (await api(baseUrl, '/api/users/import/template', { token: admin })).data;
  assert.match(tpl.data, /^data:application\/vnd.openxmlformats/);

  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('People');
  ws.addRow(['Staff list (Nov 2026)']);
  ws.addRow(['Full Name', 'User Name', 'Password', 'Role', 'Department', 'Designation', 'Mobile', 'E-mail', 'DOB', 'Date of Joining', 'Blood group']);
  ws.addRow(['Ganesh Shinde', '', '', 'Team Member', 'Execution Department', 'Site Engineer', '98765 43210', 'g@x.com', '15-08-1995', '2024-04-01', 'O+']);
  ws.addRow(['Ganesh Salunke', '', 'Strong@123', 'Director', 'Senior Management', '', '', '', '', '', '']);
  ws.addRow(['Bad Role', 'bad.role', '', 'Boss', '', '', '', '', '', '', '']);
  ws.addRow(['', 'noname', '', '', '', '', '', '', '', '', '']);
  ws.addRow(['Taken', 'admin', '', '', '', '', '', '', '', '', '']);
  ws.addRow(['Weak Pw', 'weak.pw', 'abc', '', '', '', '', '', '32-13-2020', '', '']);
  const file = 'data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,' + Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');

  const member = await createMember(baseUrl, admin, 'plain.m', 'Plain M', 'Execution Department');
  assert.equal((await P('/api/users/import/preview', member, { file, fileName: 'staff.xlsx' })).status, 403);

  const pv = (await P('/api/users/import/preview', admin, { file, fileName: 'staff.xlsx' })).data;
  assert.equal(pv.total, 6); assert.equal(pv.valid, 2);
  assert.deepEqual(pv.unknownColumns, ['Blood group']);
  const g = pv.rows.find(r => r.name === 'Ganesh Shinde');
  assert.equal(g.username, 'ganesh.s'); assert.equal(g.generatedUsername, true); assert.equal(g.password, undefined, 'no passwords in the preview');
  assert.equal(pv.rows.find(r => r.name === 'Ganesh Salunke').username, 'ganesh.s2', 'made usernames do not clash');
  assert.match(pv.rows.find(r => r.name === 'Bad Role').errors.join(), /Unknown role/);
  assert.match(pv.rows.find(r => r.username === 'noname').errors.join(), /Name is missing/);
  assert.match(pv.rows.find(r => r.name === 'Taken').errors.join(), /already exists/);
  const weak = pv.rows.find(r => r.name === 'Weak Pw').errors.join();
  assert.match(weak, /Password/); assert.match(weak, /Date of birth/);

  const r = (await P('/api/users/import', admin, { file, fileName: 'staff.xlsx' })).data;
  assert.equal(r.created, 2); assert.equal(r.skipped, 4);
  const made = r.rows.find(x => x.username === 'ganesh.s');
  assert.ok(made.password && made.password.length >= 8, 'generated password returned once');
  assert.equal(r.rows.find(x => x.username === 'ganesh.s2').password, undefined, 'a password from the file is not echoed');
  // they can log in with it and must change it
  const lr = await api(baseUrl, '/api/auth/login', { method: 'POST', body: { username: 'ganesh.s', password: made.password } });
  assert.equal(lr.status, 200, JSON.stringify(lr.data));
  const users = (await api(baseUrl, '/api/users', { token: admin })).data;
  const gs = users.find(u => u.username === 'ganesh.s');
  assert.equal(gs.team, 'Execution Department'); assert.equal(gs.designation, 'Site Engineer'); assert.equal(gs.phone, '9876543210'); assert.equal(gs.role, 'member');
  assert.equal(users.find(u => u.username === 'ganesh.s2').role, 'director');
  // CSV works too
  const csv = 'data:text/csv;base64,' + Buffer.from('Name,Department\nKiran Jadhav,Store Department\n').toString('base64');
  const c = (await P('/api/users/import', admin, { file: csv, fileName: 'x.csv' })).data;
  assert.equal(c.created, 1); assert.equal(c.rows[0].username, 'kiran.j');

  // Export: admin only, no passwords, same headings as the import (re-importable), optional list of usernames
  assert.equal((await P('/api/users/export', member, {})).status, 403);
  const ex = (await P('/api/users/export', admin, {})).data;
  assert.match(ex.name, /^accounts_\d{4}-\d{2}-\d{2}\.xlsx$/);
  const wb2 = new ExcelJS.Workbook(); await wb2.xlsx.load(Buffer.from(ex.data.split(',')[1], 'base64'));
  const sh = wb2.worksheets[0];
  const head = sh.getRow(1).values.slice(1);
  assert.deepEqual(head.slice(0, 9), ['Name', 'Username', 'Role', 'Department', 'Designation', 'Phone', 'Email', 'Date of birth', 'Joining date']);
  assert.ok(!head.some(h => /password$/i.test(h) && !/must change/i.test(h)), 'no password column');
  const rowsX = []; sh.eachRow((r, n) => { if (n > 1) rowsX.push(r.values.slice(1)); });
  assert.equal(rowsX.length, ex.count);
  const gx = rowsX.find(r => r[1] === 'ganesh.s');
  assert.deepEqual(gx.slice(0, 9), ['Ganesh Shinde', 'ganesh.s', 'Member', 'Execution Department', 'Site Engineer', '9876543210', 'g@x.com', '15-08-1995', '01-04-2024']);
  const raw = Buffer.from(ex.data.split(',')[1], 'base64').toString('latin1');
  assert.ok(!/\$2[aby]\$/.test(raw), 'no password hashes in the file');
  const some = (await P('/api/users/export', admin, { usernames: ['ganesh.s', 'kiran.j'] })).data;
  assert.equal(some.count, 2);
});
