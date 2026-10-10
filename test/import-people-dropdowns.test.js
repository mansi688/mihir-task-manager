const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { startTestServer, api, login, createMember } = require('../testlib/helpers');

const csvDataUrl = (s) => 'data:text/csv;base64,' + Buffer.from(s, 'utf8').toString('base64');
function ddmmyyyy(days) { const d = new Date(Date.now() + days * 86400000); return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`; }

test('Excel template: people dropdowns from live accounts, one-person-per-cell columns merge into levels', async (t) => {
  const { baseUrl, stop } = await startTestServer();
  t.after(() => stop());
  const admin = await login(baseUrl, 'admin', 'admin123');
  await createMember(baseUrl, admin, 'alice', 'Alice Test', 'Site');
  await createMember(baseUrl, admin, 'bob', 'Bob Test', 'Site');
  await createMember(baseUrl, admin, 'carol', 'Carol Test', 'Design');

  const loadTemplate = async () => {
    const r = await api(baseUrl, '/api/tasks/import/template', { token: admin });
    assert.equal(r.status, 200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(r.data.data.split(',')[1], 'base64'));
    return wb;
  };

  await t.test('template has a People pick list (people + departments) and a dropdown on every person column', async () => {
    const wb = await loadTemplate();
    const tasks = wb.getWorksheet('Tasks');
    const headers = tasks.getRow(1).values.slice(1);
    for (const h of ['Level 1 - Person 1', 'Level 1 - Person 3', 'Level 2 - Person 1', 'Level 3 - Person 2', 'Follow Up 1']) assert.ok(headers.includes(h), `missing ${h}`);
    const picks = [];
    wb.getWorksheet('People').eachRow((row, n) => { if (n > 1) picks.push(row.getCell(1).value); });
    assert.ok(picks.includes('Alice Test (alice)'));
    assert.ok(picks.includes('Department: Design'));
    const col = headers.indexOf('Level 2 - Person 1') + 1;
    const dv = tasks.getCell(50, col).dataValidation;
    assert.equal(dv.type, 'list'); assert.deepEqual(dv.formulae, ['PeopleList']);
    assert.equal(dv.errorStyle, 'warning', 'typing a username must still be allowed');
  });

  await t.test('a new account appears in the next template download', async () => {
    await createMember(baseUrl, admin, 'newhire', 'New Hire', 'Site');
    const wb = await loadTemplate();
    const picks = [];
    wb.getWorksheet('People').eachRow((row, n) => { if (n > 1) picks.push(row.getCell(1).value); });
    assert.ok(picks.includes('New Hire (newhire)'));
  });

  await t.test('person columns merge per level; picked labels, typed usernames and departments all resolve', async () => {
    const csv = [
      'Title,Deadline,Level 1 - Person 1,Level 1 - Person 2,Level 2 - Person 1,Level 3 - Person 1,Follow Up 1,Follow Up 2',
      `Slots,${ddmmyyyy(7)},Alice Test (alice),Bob Test (bob),Carol Test (carol),newhire,Bob Test (bob),`,
      `Dept,${ddmmyyyy(7)},Department: Site,,,,,`,
      `Typed list,${ddmmyyyy(7)},"alice, carol",,newhire,,,`,
    ].join('\n');
    const fileData = csvDataUrl(csv);
    const pv = await api(baseUrl, '/api/tasks/import/preview', { method: 'POST', token: admin, body: { fileData, fileName: 't.csv' } });
    assert.equal(pv.status, 200, JSON.stringify(pv.data));
    assert.equal(pv.data.errorCount, 0, JSON.stringify(pv.data.rows.map(r => r.errors)));
    const imp = await api(baseUrl, '/api/tasks/import', { method: 'POST', token: admin, body: { fileData, fileName: 't.csv' } });
    assert.equal(imp.status, 200, JSON.stringify(imp.data));
    const all = (await api(baseUrl, '/api/tasks', { token: admin })).data;
    const byTitle = (title) => all.find(x => x.title === title);
    const lv = (task) => Object.fromEntries(task.assignees.map(a => [a.username, a.stage]));
    assert.deepEqual(lv(byTitle('Slots')), { alice: 1, bob: 1, carol: 2, newhire: 3 });
    assert.deepEqual(lv(byTitle('Dept')), { alice: 1, bob: 1, newhire: 1 });
    assert.deepEqual(lv(byTitle('Typed list')), { alice: 1, carol: 1, newhire: 2 });
  });

  await t.test('the old single "Assignees" + "Level 2" layout still imports', async () => {
    const csv = `Title,Deadline,Assignees,Level 2\nOld layout,${ddmmyyyy(5)},"alice, bob",carol`;
    const imp = await api(baseUrl, '/api/tasks/import', { method: 'POST', token: admin, body: { fileData: csvDataUrl(csv), fileName: 'o.csv' } });
    assert.equal(imp.status, 200, JSON.stringify(imp.data));
    const task = (await api(baseUrl, '/api/tasks', { token: admin })).data.find(x => x.title === 'Old layout');
    assert.deepEqual(Object.fromEntries(task.assignees.map(a => [a.username, a.stage])), { alice: 1, bob: 1, carol: 2 });
  });
});
