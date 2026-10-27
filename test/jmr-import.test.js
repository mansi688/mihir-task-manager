const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { readJmrFile, buildJmrTemplate } = require('../backend/jmr-import');
const { startTestServer, api, login, createMember } = require('../testlib/helpers');
const XLSX_MIME = 'data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,';
const toUrl = (buf) => XLSX_MIME + Buffer.from(buf).toString('base64');

test('JMR import: template, section headings, deductions, mismatched Qty, CSV', async () => {
  // the downloadable template reads back as two JMRs
  const t = await readJmrFile(toUrl(await buildJmrTemplate()), 'JMR-template.xlsx');
  assert.equal(t.jmrs.length, 2);
  const [a, b] = t.jmrs;
  assert.equal(a.project, 'Mihir Amara'); assert.equal(a.contractor, 'Shree Builders'); assert.equal(a.work_item, 'Block work 150 mm');
  assert.equal(a.unit, 'sqm'); assert.equal(a.material, 'AAC blocks 150 mm'); assert.equal(a.rate, undefined); assert.equal(a.measured_on, '2026-10-25'); assert.equal(a.ra_bill_no, 'RA-03');
  assert.equal(a.lines.length, 3); assert.equal(a.total, 40.4);
  assert.equal(a.lines[1].deduct, true); assert.equal(a.lines[1].description, 'Door opening D1');
  assert.equal(a.lines[2].manual, true); assert.equal(a.lines[2].qty, 12.5);
  assert.match(b.work_item, /^Plaster 12 mm/); assert.equal(b.total, 30);

  // a messier office sheet: title rows, "Sr", "Particulars", "Thk", units per row, negative deduction, sheet Qty that differs
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Tower A');
  ws.addRow(['MIHIR AMARA — JOINT MEASUREMENT RECORD']);
  ws.addRow(['Name of Contractor', 'Patil Constructions', '', 'Date', new Date('2026-10-20T00:00:00Z')]);
  ws.addRow([]);
  ws.addRow(['Sr', 'Particulars', 'No.', 'Length', 'Width', 'Thk', 'Quantity', 'Unit', 'Remarks']);
  ws.addRow(['', 'RCC M25 slab', '', '', '', '', '', '', '']);
  ws.addRow([1, 'Slab panel S1', 1, '10.5', 6, 0.15, 9.45, 'cum', '']);
  ws.addRow([2, 'Cut-out for shaft', -1, 2, 1.5, 0.15, -0.45, 'cum', '']);
  ws.addRow([3, 'Beam B1', 2, 6, 0.3, 0.45, 1.7, 'cum', 'site said 1.7']); // 2×6×0.3×0.45 = 1.62 ≠ 1.7
  ws.addRow(['', 'Sub Total', '', '', '', '', 10.7, '', '']);
  ws.addRow(['', 'Shuttering', '', '', '', '', '', '', '']);
  ws.addRow([1, 'Slab soffit', 1, 10.5, 6, '', 63, 'sqm', '']);
  const r = await readJmrFile(toUrl(await wb.xlsx.writeBuffer()), 'site.xlsx');
  assert.equal(r.jmrs.length, 2);
  const [s1, s2] = r.jmrs;
  assert.equal(s1.contractor, 'Patil Constructions'); assert.equal(s1.measured_on, '2026-10-20'); assert.equal(s1.work_item, 'RCC M25 slab'); assert.equal(s1.unit, 'cum');
  assert.equal(s1.lines.length, 3);
  assert.equal(s1.lines[1].deduct, true, 'negative = deduction');
  assert.equal(s1.lines[2].manual, true); assert.equal(s1.lines[2].qty, 1.7);
  assert.ok(r.warnings.some(w => /row 8/.test(w)));
  assert.equal(s1.total, 10.7); // 9.45 − 0.45 + 1.7
  assert.equal(s2.work_item, 'Shuttering'); assert.equal(s2.unit, 'sqm'); assert.equal(s2.total, 63);

  // CSV
  const csv = 'Description,Nos,L,B,H,Qty\nColumn C1,4,0.3,0.45,3,\nLess: duct,1,0.3,0.3,3,\n';
  const c = await readJmrFile('data:text/csv;base64,' + Buffer.from(csv).toString('base64'), 'c.csv');
  assert.equal(c.jmrs.length, 1); assert.equal(c.jmrs[0].total, 1.35);

  // nothing usable
  await assert.rejects(readJmrFile('data:text/csv;base64,' + Buffer.from('a,b\n1,2\n').toString('base64'), 'x.csv'), /No measurement table/);
});

test('JMR import API: preview for the Estimation team only; imported JMRs save as drafts', async (t) => {
  const { baseUrl, stop } = await startTestServer();
  t.after(stop);
  const admin = await login(baseUrl, 'admin', 'admin123');
  const est = await createMember(baseUrl, admin, 'est.i', 'Est Import', 'Estimation & Billing Department');
  const other = await createMember(baseUrl, admin, 'oth.i', 'Other', 'Sales Department');
  const fileData = toUrl(await buildJmrTemplate());
  assert.equal((await api(baseUrl, '/api/estimation/jmr/import/preview', { method: 'POST', token: other, body: { fileData, fileName: 't.xlsx' } })).status, 403);
  const p = await api(baseUrl, '/api/estimation/jmr/import/preview', { method: 'POST', token: est, body: { fileData, fileName: 't.xlsx' } });
  assert.equal(p.status, 200, JSON.stringify(p.data)); assert.equal(p.data.jmrs.length, 2);
  const bad = await api(baseUrl, '/api/estimation/jmr/import/preview', { method: 'POST', token: est, body: { fileData: 'data:text/csv;base64,' + Buffer.from('x\n').toString('base64'), fileName: 'x.csv' } });
  assert.equal(bad.status, 400);
  // create the drafts the way the screen does
  for (const j of p.data.jmrs) {
    const r = await api(baseUrl, '/api/estimation/jmr', { method: 'POST', token: est, body: { ...j, project: 'Mihir Amara', attachments: [{ name: 't.xlsx', data: fileData }] } });
    assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.total_qty, j.total);
  }
  const list = (await api(baseUrl, '/api/estimation', { token: est })).data.jmr;
  assert.equal(list.length, 2); assert.ok(list.every(j => j.status === 'draft'));
  const tpl = await api(baseUrl, '/api/estimation/jmr/template', { token: est });
  assert.equal(tpl.status, 200); assert.match(tpl.data.data, /^data:application\/vnd\.openxml/);
});
