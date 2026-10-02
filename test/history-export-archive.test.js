const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const ExcelJS = require('exceljs');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');

const XLSX = 'data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,';
async function readSheet(dataUrl, sheetName) {
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(dataUrl.split(',')[1], 'base64'));
  const ws = sheetName ? wb.getWorksheet(sheetName) : wb.worksheets[0];
  const rows = []; ws.eachRow((r) => rows.push(r.values.slice(1).map(v => (v && v.result !== undefined ? v.result : v))));
  return rows;
}

test('Import column, history export, schedule timestamps and archiving', async (t) => {
  const { baseUrl, stop, getRawClient } = await startTestServer();
  t.after(() => stop());
  const admin = await login(baseUrl, 'admin', 'admin123');
  const worker = await createMember(baseUrl, admin, 'site.eng', 'Site Engineer', 'Estimation');

  // A small schedule with an Import column: rows 3 is "No".
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Tasks');
  ws.addRow(['Import', 'Task Key', 'Title *', 'Deadline *', 'Assignees', 'Project', 'Info: Building']);
  ws.addRow(['Yes', 'K-1', 'Slab quantities L1', futureDate(5), 'site.eng', 'Equinox – 1A Tower', '1A']);
  ws.addRow(['Yes', 'K-2', 'Slab quantities L2', futureDate(6), 'site.eng', 'Equinox – 1A Tower', '1A']);
  ws.addRow(['No', 'K-3', 'Slab quantities L3', futureDate(400), '', 'Equinox – 1A Tower', '1A']);
  const fileData = XLSX + Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');

  let ids;
  await t.test('rows with Import = No are skipped and reported', async () => {
    const p = await api(baseUrl, '/api/tasks/import/preview', { method: 'POST', token: admin, body: { fileData, fileName: 'Equinox.xlsx' } });
    assert.equal(p.status, 200, JSON.stringify(p.data));
    assert.equal(p.data.totalRows, 2); assert.equal(p.data.skippedByImportColumn, 1);
    const r = await api(baseUrl, '/api/tasks/import', { method: 'POST', token: admin, body: { fileData, fileName: 'Equinox.xlsx' } });
    assert.equal(r.data.created.length, 2);
    ids = r.data.created.map(c => c.id);
  });

  await t.test('the upload is saved as a master schedule', async () => {
    const list = await api(baseUrl, '/api/schedules', { token: admin });
    assert.equal(list.data.length, 1); assert.equal(list.data[0].file_name, 'Equinox.xlsx');
    // uploading the same file name again replaces it rather than piling up copies
    await api(baseUrl, '/api/tasks/import', { method: 'POST', token: admin, body: { fileData, fileName: 'Equinox.xlsx' } }).catch(() => {});
    assert.equal((await api(baseUrl, '/api/schedules', { token: admin })).data.length, 1);
  });

  // complete task 1: submit + approve (auto-closes)
  await api(baseUrl, `/api/tasks/${ids[0]}/submit-mine`, { method: 'POST', token: worker, body: { note: 'Quantities attached' } });
  await api(baseUrl, `/api/tasks/${ids[0]}/reply`, { method: 'POST', token: admin, body: { message: 'Checked, fine' } });
  await api(baseUrl, `/api/tasks/${ids[0]}/approve/site.eng`, { method: 'POST', token: admin });

  await t.test('downloading the saved schedule fills status + timestamps by Task Key, keeping the original columns', async () => {
    const id = (await api(baseUrl, '/api/schedules', { token: admin })).data[0].id;
    const d = await api(baseUrl, `/api/schedules/${id}/download`, { token: admin });
    assert.equal(d.status, 200, JSON.stringify(d.data));
    assert.deepEqual([d.data.stats.completed, d.data.stats.open, d.data.stats.notImported], [1, 1, 1]);
    const rows = await readSheet(d.data.data);
    const head = rows[0];
    const col = name => head.indexOf(name);
    assert.ok(col('Info: Building') >= 0 && col('Import') === 0, 'original columns kept');
    assert.equal(rows[1][col('Info: Status')], 'Completed');
    assert.equal(rows[1][col('Info: Task ID')], ids[0]);
    assert.ok(rows[1][col('Info: Approved')] instanceof Date, 'approval time is a real Excel date');
    assert.ok(rows[1][col('Info: Submitted')] instanceof Date);
    assert.equal(rows[1][col('Info: Result')], 'On time');
    assert.equal(rows[2][col('Info: Status')], 'Open');
    assert.equal(rows[3][col('Info: Status')], 'Not imported (Import = No)');
    // and the filled file can be uploaded again without errors or duplicates
    const again = await api(baseUrl, '/api/tasks/import/preview', { method: 'POST', token: admin, body: { fileData: d.data.data, fileName: 'Equinox.xlsx' } });
    assert.equal(again.data.errorCount, 0); assert.deepEqual(again.data.unknownColumns, []);
    assert.equal(again.data.createCount, 0);
  });

  await t.test('history export lists completed tasks with timestamps and comments', async () => {
    const e = await api(baseUrl, '/api/tasks/history-export?mode=completed', { token: admin });
    assert.equal(e.status, 200); assert.equal(e.data.count, 1);
    const rows = await readSheet(e.data.data, 'Task history');
    const h = rows[0];
    assert.equal(rows[1][h.indexOf('Status')], 'Completed');
    assert.ok(rows[1][h.indexOf('Completed / Cancelled')] instanceof Date);
    assert.match(rows[1][h.indexOf('Comments')], /Checked, fine/);
    const all = await api(baseUrl, '/api/tasks/history-export?mode=all', { token: admin });
    assert.equal(all.data.count, 2);
    const member = await api(baseUrl, '/api/tasks/history-export', { token: worker });
    assert.equal(member.status, 403, 'admin only');
  });

  await t.test('archiving removes completed tasks from the site but keeps history, reports and re-import safety', async () => {
    const before = (await api(baseUrl, '/api/reports/my-dashboard?username=site.eng', { token: admin })).data;
    const today = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const pv = await api(baseUrl, `/api/tasks/archive/preview?before=${today}`, { token: admin });
    assert.equal(pv.data.count, 1);
    const ar = await api(baseUrl, '/api/tasks/archive', { method: 'POST', token: admin, body: { before: today } });
    assert.equal(ar.data.archived, 1);
    const list = (await api(baseUrl, '/api/tasks', { token: admin })).data;
    assert.ok(!list.some(x => x.id === ids[0]), 'gone from task screens');
    assert.ok(list.some(x => x.id === ids[1]), 'open task untouched');
    const raw = await getRawClient();
    assert.equal(Number((await raw.query('SELECT COUNT(*) c FROM task_replies WHERE task_id=$1', [ids[0]])).rows[0].c), 0, 'comment thread deleted');
    await raw.end();
    const after = (await api(baseUrl, '/api/reports/my-dashboard?username=site.eng', { token: admin })).data;
    assert.deepEqual(after.completion || after.stats || after, before.completion || before.stats || before, 'performance numbers unchanged');
    // history still has it, comments included
    const e = await api(baseUrl, '/api/tasks/history-export?mode=completed', { token: admin });
    const rows = await readSheet(e.data.data, 'Task history');
    assert.match(rows[1][rows[0].indexOf('Comments')], /Checked, fine/);
    assert.ok(rows[1][rows[0].indexOf('Removed From Site')] instanceof Date);
    // re-uploading the schedule does not re-create it
    const p = await api(baseUrl, '/api/tasks/import/preview', { method: 'POST', token: admin, body: { fileData, fileName: 'Equinox.xlsx' } });
    assert.equal(p.data.createCount, 0); assert.equal(p.data.closedCount, 1);
    // schedule timestamps still filled for it
    const id = (await api(baseUrl, '/api/schedules', { token: admin })).data[0].id;
    const d = await api(baseUrl, `/api/schedules/${id}/download`, { token: admin });
    const srows = await readSheet(d.data.data);
    assert.equal(srows[1][srows[0].indexOf('Info: Status')], 'Completed (removed from site)');
    // nothing left to archive
    assert.equal((await api(baseUrl, `/api/tasks/archive/preview?before=${today}`, { token: admin })).data.count, 0);
  });

  await t.test('fill timestamps into an uploaded copy', async () => {
    const r = await api(baseUrl, '/api/schedules/fill', { method: 'POST', token: admin, body: { fileData, fileName: 'My copy.xlsx' } });
    assert.equal(r.status, 200); assert.equal(r.data.stats.matched, 2);
    assert.match(r.data.name, /^My copy \(with timestamps/);
  });
});
