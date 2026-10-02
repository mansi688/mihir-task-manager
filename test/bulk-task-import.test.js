const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');

const csvDataUrl = (text) => 'data:text/csv;base64,' + Buffer.from(text, 'utf8').toString('base64');
function ddmmyyyy(daysAhead) {
  const d = new Date(Date.now() + daysAhead * 86400000);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

test('bulk task import from CSV and Excel', async (t) => {
  const { baseUrl, stop } = await startTestServer();
  t.after(() => stop());
  const admin = await login(baseUrl, 'admin', 'admin123');
  await createMember(baseUrl, admin, 'ravi.s', 'Ravi Shinde', 'Site Team');
  await createMember(baseUrl, admin, 'priya.d', 'Priya Deshmukh', 'Purchase Dept');
  await createMember(baseUrl, admin, 'amit.k', 'Amit Kulkarni', 'Purchase Dept');
  const ravi = await login(baseUrl, 'ravi.s', 'TestPass123');

  const csv = [
    'Sr No,Task Name,Details,Priority,Due Date,Assigned To,Level 2,Auto Release,CC,Site,Phase,Checklist,Depends On,Parent Task,Individual Deadlines,Some Other Column',
    `1,Prepare BOQ,Tower B,High,${ddmmyyyy(7)} 5:00 PM,Ravi Shinde,priya.d,Yes,amit.k,Tower B,Structure,Drawings | Takeoff | Rates,,,ravi.s: ${ddmmyyyy(5)},x`,
    `2,Cement enquiry,"Based on BOQ, qty",medium,${ddmmyyyy(10)},@priya.d,,,,Tower B,,,1,,,y`,
    `3,Vendor quotes,,Low,${ddmmyyyy(12)},Purchase Dept,,,,,,,,Cement enquiry,,z`,
  ].join('\n');

  await t.test('preview maps columns, resolves people, and reports no errors for a good file', async () => {
    const r = await api(baseUrl, '/api/tasks/import/preview', { method: 'POST', token: ravi, body: { fileData: csvDataUrl(csv), fileName: 'tasks.csv' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.totalRows, 3);
    assert.equal(r.data.errorCount, 0, JSON.stringify(r.data.rows.map(x => x.errors)));
    assert.deepEqual(r.data.unknownColumns, ['Some Other Column']);
    const row1 = r.data.rows[0];
    assert.equal(row1.priority, 'high');
    assert.match(row1.deadline, /T17:00$/);
    assert.equal(row1.levels.length, 2);
    assert.equal(row1.checklist.length, 3);
    assert.equal(r.data.rows[2].levels[0].length, 2, 'department name tags everyone in it');
  });

  await t.test('import creates every task with levels, checklist, follow-ups, dependencies and subtasks', async () => {
    const r = await api(baseUrl, '/api/tasks/import', { method: 'POST', token: ravi, body: { fileData: csvDataUrl(csv), fileName: 'tasks.csv' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.created.length, 3);
    const ids = Object.fromEntries(r.data.created.map(c => [c.rowNumber, c.id]));
    const boq = (await api(baseUrl, `/api/tasks/${ids[2]}`, { token: admin })).data;
    assert.equal(boq.title, 'Prepare BOQ');
    assert.equal(boq.created_by_username, 'ravi.s', 'importer is the creator');
    assert.equal(boq.project, 'Tower B');
    assert.equal(boq.auto_release_stages, 1);
    assert.equal(boq.checklist.length, 3);
    assert.ok(boq.followups.some(f => f.username === 'amit.k'));
    const priya = boq.assignees.find(a => a.username === 'priya.d');
    assert.equal(priya.stage, 2); assert.equal(priya.is_released, 0);
    assert.ok(boq.assignees.find(a => a.username === 'ravi.s').individual_deadline);
    const cement = (await api(baseUrl, `/api/tasks/${ids[3]}`, { token: admin })).data;
    assert.equal(cement.depends_on_task_id, ids[2]);
    assert.equal(cement.blocked, true);
    const quotes = (await api(baseUrl, `/api/tasks/${ids[4]}`, { token: admin })).data;
    assert.equal(quotes.parent_task_id, ids[3], 'parent resolved by title');

    const priyaToken = await login(baseUrl, 'priya.d', 'TestPass123');
    const n = (await api(baseUrl, '/api/notifications', { token: priyaToken })).data.items;
    assert.ok(n.some(x => /Prepare BOQ/.test(x.message)), 'tagged people are notified');
  });

  await t.test('rows with problems are reported, and blocked unless skipInvalid is chosen', async () => {
    const bad = [
      'Title,Deadline,Assignees,Depends On',
      `Good row,${ddmmyyyy(3)},ravi.s,`,
      `No deadline,,ravi.s,`,
      `Unknown person,${ddmmyyyy(3)},nobody.here,`,
      `Bad date,31/02/2026,ravi.s,`,
      `Relies on bad,${ddmmyyyy(3)},ravi.s,Unknown person`,
      `,${ddmmyyyy(3)},ravi.s,`,
    ].join('\n');
    const p = await api(baseUrl, '/api/tasks/import/preview', { method: 'POST', token: admin, body: { fileData: csvDataUrl(bad), fileName: 'bad.csv' } });
    assert.equal(p.data.validCount, 1);
    assert.equal(p.data.errorCount, 5);
    const rel = p.data.rows.find(x => x.title === 'Relies on bad');
    assert.ok(rel.errors.some(e => /has errors/.test(e)));

    const blocked = await api(baseUrl, '/api/tasks/import', { method: 'POST', token: admin, body: { fileData: csvDataUrl(bad), fileName: 'bad.csv' } });
    assert.equal(blocked.status, 400);
    const partial = await api(baseUrl, '/api/tasks/import', { method: 'POST', token: admin, body: { fileData: csvDataUrl(bad), fileName: 'bad.csv', skipInvalid: true } });
    assert.equal(partial.status, 200);
    assert.equal(partial.data.created.length, 1);
    assert.equal(partial.data.skipped.length, 5);
  });

  await t.test('Excel (.xlsx) with real date cells and a heading row above the table', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('My Tasks');
    ws.addRow(['Site tasks — October']);
    ws.addRow(['Task', 'Target Date', 'Responsible', 'Priority']);
    const d = new Date(Date.now() + 9 * 86400000);
    ws.addRow(['Excel task one', new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())), 'amit.k, Priya Deshmukh', 'Urgent']);
    ws.addRow([{ richText: [{ text: 'Rich ' }, { text: 'title' }] }, new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), 14, 30)), 'amit.k', '']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const fileData = 'data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,' + buf.toString('base64');
    const r = await api(baseUrl, '/api/tasks/import', { method: 'POST', token: admin, body: { fileData, fileName: 'tasks.xlsx' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.created.length, 2);
    const t2 = (await api(baseUrl, `/api/tasks/${r.data.created[1].id}`, { token: admin })).data;
    assert.equal(t2.title, 'Rich title');
    assert.match(t2.deadline, /T14:30$/);
    const t1 = (await api(baseUrl, `/api/tasks/${r.data.created[0].id}`, { token: admin })).data;
    assert.equal(t1.priority, 'high');
    assert.equal(t1.assignees.length, 2);
  });

  await t.test('an .xlsx containing cell comments (e.g. the standalone template) still imports', async () => {
    const buf = require('fs').readFileSync(require('path').join(__dirname, 'fixtures', 'template-with-comments.xlsx'));
    const fileData = 'data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,' + buf.toString('base64');
    const r = await api(baseUrl, '/api/tasks/import/preview', { method: 'POST', token: admin, body: { fileData, fileName: 'template.xlsx' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.totalRows, 1);
    assert.deepEqual(r.data.unknownColumns, []);
    assert.equal(r.data.rows[0].title, 'Prepare BOQ for Tower B');
  });

  await t.test('untagged rows import; Task Key re-upload changes deadlines instead of duplicating; Info: columns are ignored', async () => {
    const v1 = ['Task Key,Title,Deadline,Assignees,Info: Construction Start',
      `EQX-T-1,Keyed one,${ddmmyyyy(20)},,01/01/2027`,
      `EQX-T-2,Keyed two,${ddmmyyyy(21)},ravi.s,01/01/2027`,
      `EQX-T-3,Keyed three,${ddmmyyyy(22)},,01/01/2027`].join('\n');
    const p1 = await api(baseUrl, '/api/tasks/import/preview', { method: 'POST', token: admin, body: { fileData: csvDataUrl(v1), fileName: 'v1.csv' } });
    assert.equal(p1.data.errorCount, 0, JSON.stringify(p1.data.rows.map(r => r.errors)));
    assert.deepEqual(p1.data.unknownColumns, [], 'Info: columns are silently ignored');
    assert.equal(p1.data.createCount, 3);
    const i1 = await api(baseUrl, '/api/tasks/import', { method: 'POST', token: admin, body: { fileData: csvDataUrl(v1), fileName: 'v1.csv' } });
    assert.equal(i1.data.created.length, 3);
    const one = (await api(baseUrl, `/api/tasks/${i1.data.created[0].id}`, { token: admin })).data;
    assert.equal(one.assignees.length, 0, 'created untagged');
    assert.equal(one.import_key, 'EQX-T-1');
    // close task 3, then re-upload with shifted dates for 1 and 3, unchanged 2, plus a new row
    await api(baseUrl, `/api/tasks/${i1.data.created[2].id}/close`, { method: 'POST', token: admin });
    const v2 = ['Task Key,Title,Deadline,Assignees',
      `EQX-T-1,Keyed one,${ddmmyyyy(30)},`,
      `EQX-T-2,Keyed two,${ddmmyyyy(21)},ravi.s`,
      `EQX-T-3,Keyed three,${ddmmyyyy(40)},`,
      `EQX-T-4,Keyed four,${ddmmyyyy(25)},`].join('\n');
    const p2 = await api(baseUrl, '/api/tasks/import/preview', { method: 'POST', token: admin, body: { fileData: csvDataUrl(v2), fileName: 'v2.csv' } });
    assert.deepEqual([p2.data.createCount, p2.data.updateCount, p2.data.unchangedCount, p2.data.closedCount], [1, 1, 1, 1]);
    const i2 = await api(baseUrl, '/api/tasks/import', { method: 'POST', token: admin, body: { fileData: csvDataUrl(v2), fileName: 'v2.csv' } });
    assert.equal(i2.data.created.length, 1); assert.equal(i2.data.updated.length, 1);
    const oneAfter = (await api(baseUrl, `/api/tasks/${i1.data.created[0].id}`, { token: admin })).data;
    const d30 = ddmmyyyy(30).split('/');
    assert.equal(oneAfter.deadline, `${d30[2]}-${d30[1]}-${d30[0]}`);
    const threeAfter = (await api(baseUrl, `/api/tasks/${i1.data.created[2].id}`, { token: admin })).data;
    assert.equal(threeAfter.status, 'closed', 'closed tasks are never touched');
    const count = (await api(baseUrl, '/api/tasks', { token: admin })).data.filter(t => (t.import_key || '').startsWith('EQX-T-')).length;
    assert.equal(count, 4, 'no duplicates');
    // A deadline changed inside the app survives re-uploading an unchanged file…
    const appDate = futureDate(60);
    await api(baseUrl, `/api/tasks/${i1.data.created[1].id}/deadline`, { method: 'POST', token: admin, body: { deadline: appDate } });
    const p3 = await api(baseUrl, '/api/tasks/import/preview', { method: 'POST', token: admin, body: { fileData: csvDataUrl(v2), fileName: 'v2.csv' } });
    const row2 = p3.data.rows.find(r => r.taskKey === 'EQX-T-2');
    assert.equal(row2.action, 'unchanged'); assert.equal(row2.existing.keptAppChange, true);
    assert.equal(p3.data.updateCount, 0);
    // …but if the FILE changes that row later, the file's new date applies.
    const v3 = v2.replace(`EQX-T-2,Keyed two,${ddmmyyyy(21)}`, `EQX-T-2,Keyed two,${ddmmyyyy(45)}`);
    const p4 = await api(baseUrl, '/api/tasks/import/preview', { method: 'POST', token: admin, body: { fileData: csvDataUrl(v3), fileName: 'v3.csv' } });
    assert.equal(p4.data.rows.find(r => r.taskKey === 'EQX-T-2').action, 'update');
    const dup = await api(baseUrl, '/api/tasks/import/preview', { method: 'POST', token: admin, body: { fileData: csvDataUrl(`Task Key,Title,Deadline\nK1,A,${ddmmyyyy(5)}\nK1,B,${ddmmyyyy(5)}`), fileName: 'd.csv' } });
    assert.equal(dup.data.errorCount, 1, 'the same Task Key twice in one file is an error');
  });

  await t.test('template downloads work, and a file with no Title column gets a clear error', async () => {
    const x = await api(baseUrl, '/api/tasks/import/template', { token: ravi });
    assert.equal(x.status, 200); assert.match(x.data.data, /^data:application\/vnd/);
    const c = await api(baseUrl, '/api/tasks/import/template?format=csv', { token: ravi });
    assert.equal(c.status, 200);
    const bad = await api(baseUrl, '/api/tasks/import/preview', { method: 'POST', token: ravi, body: { fileData: csvDataUrl('Foo,Bar\n1,2'), fileName: 'x.csv' } });
    assert.equal(bad.status, 400); assert.match(bad.data.error, /Title/);
  });
});
