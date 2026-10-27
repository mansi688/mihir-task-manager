const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember } = require('../testlib/helpers');
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('Estimation: JMR with previous/cumulative quantities, reconciliation maths, approval workflow and access', async (t) => {
  const { baseUrl, stop } = await startTestServer();
  t.after(stop);
  const admin = await login(baseUrl, 'admin', 'admin123');
  const P = (tok, path, body) => api(baseUrl, path, { method: 'POST', token: tok, body });
  const G = (tok, path) => api(baseUrl, path, { token: tok });
  const est = await createMember(baseUrl, admin, 'vaibhav.e', 'Vaibhav Estimation', 'Estimation & Billing Department');
  const head = await createMember(baseUrl, admin, 'dnyaneshwar.k', 'Dnyaneshwar Kolekar', 'Execution Department'); // the estimation approver
  const other = await createMember(baseUrl, admin, 'suraj.k', 'Suraj Kathale', 'Execution Department'); // a project head, not an approver
  const pur = await createMember(baseUrl, admin, 'tanu.p', 'Tanu Purchase', 'Purchase Department');
  const acc = await createMember(baseUrl, admin, 'niraj.a', 'Niraj Accounts', 'Accounts Department');
  const sales = await createMember(baseUrl, admin, 'sales.x', 'Sales Person', 'Sales Department');
  const nots = async (tok, type) => (await G(tok, '/api/notifications')).data.items.filter(n => n.type === type);

  // access
  assert.equal((await G(sales, '/api/estimation')).status, 403);
  assert.equal((await G(sales, '/api/estimation/summary')).data.canView, false);
  assert.equal((await G(acc, '/api/estimation')).status, 403, 'Accounts people are not in Estimation');
  assert.equal((await G(pur, '/api/estimation')).status, 200, 'Purchase can see Estimation');
  assert.equal((await G(pur, '/api/estimation')).data.me.canEdit, false);
  assert.equal((await G(head, '/api/estimation/summary')).data.canView, true);
  assert.equal((await G(other, '/api/estimation')).status, 403, 'project heads no longer approve estimation');

  // JMR: validation, line maths (Nos × L × B × H, manual qty, deduction)
  const jmr = { project: 'Mihir Amara', location: 'Tower B, 4th floor', work_item: 'Block work 150 mm', material: 'AAC blocks 150 mm', contractor: 'Shree Builders', unit: 'sqm',
    measured_on: '2026-10-25', client_rep: 'Rahul P', contractor_rep: 'Mr. Patil',
    lines: [{ description: 'Wall A', nos: 2, length: 5, height: 3 }, { description: 'Door opening', nos: 1, length: 1, height: 2.1, deduct: true }, { description: 'Lift wall', qty: 12.5, manual: true }, {}] };
  assert.equal((await P(pur, '/api/estimation/jmr', jmr)).status, 403, 'Purchase cannot write JMRs');
  assert.equal((await P(est, '/api/estimation/jmr', { ...jmr, project: 'Elsewhere' })).status, 400);
  assert.equal((await P(est, '/api/estimation/jmr', { ...jmr, lines: [{}] })).status, 400);
  assert.equal((await P(est, '/api/estimation/jmr', { ...jmr, lines: [{ nos: 'abc' }] })).status, 400);
  const j1 = await P(est, '/api/estimation/jmr', { ...jmr, attachments: [{ name: 'site.png', data: PNG }] });
  assert.equal(j1.status, 200, JSON.stringify(j1.data));
  assert.equal(j1.data.total_qty, 40.4); // 30 − 2.1 + 12.5
  // edit while draft, then submit → approvers (project head) told
  assert.equal((await P(est, `/api/estimation/jmr/${j1.data.id}/update`, { ...jmr, material: 'AAC blocks 200 mm' })).status, 200);
  // the HighRise / estimation document is required to send for approval
  const XLSX = 'data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,UEsDBBQAAAAIAA==';
  const noSrc = await P(est, `/api/estimation/jmr/${j1.data.id}/submit`);
  assert.equal(noSrc.status, 400); assert.match(noSrc.data.error, /HighRise/);
  assert.equal((await P(est, '/api/estimation/jmr', { ...jmr, submit: true })).status, 400, 'create + send without the document');
  assert.equal((await P(est, `/api/estimation/jmr/${j1.data.id}/files`, { kind: 'source', attachments: [{ name: 'highrise-boq.xlsx', data: XLSX }] })).status, 200);
  assert.equal((await P(est, `/api/estimation/jmr/${j1.data.id}/submit`, { remarks: 'Tower B walls, please check lift wall' })).status, 200);
  assert.ok((await nots(head, 'est_submitted')).some(n => /JMR .* Block work 150 mm/.test(n.message) && /please check lift wall/.test(n.message)));
  assert.equal((await nots(other, 'est_submitted')).length, 0);
  // remarks thread
  assert.equal((await P(head, `/api/estimation/jmr/${j1.data.id}/remark`, { text: 'Looking at it today' })).status, 200);
  assert.equal((await P(sales, `/api/estimation/jmr/${j1.data.id}/remark`, { text: 'hello' })).status, 403);
  assert.ok((await nots(est, 'est_remark')).some(n => /Looking at it today/.test(n.message)));
  assert.equal((await P(est, `/api/estimation/jmr/${j1.data.id}/update`, jmr)).status, 400, 'locked while waiting');
  // approval rules
  assert.equal((await P(pur, `/api/estimation/jmr/${j1.data.id}/decide`, { decision: 'approve' })).status, 403);
  assert.equal((await P(est, `/api/estimation/jmr/${j1.data.id}/decide`, { decision: 'approve' })).status, 403);
  assert.equal((await P(head, `/api/estimation/jmr/${j1.data.id}/decide`, { decision: 'return' })).status, 400, 'return needs a note');
  assert.equal((await P(head, `/api/estimation/jmr/${j1.data.id}/decide`, { decision: 'return', note: 'Lift wall height missing' })).status, 200);
  assert.ok((await nots(est, 'est_decided')).some(n => /returned .*Lift wall height missing/.test(n.message)));
  assert.equal((await P(est, `/api/estimation/jmr/${j1.data.id}/update`, { ...jmr, submit: true, remarks: 'Fixed' })).status, 200, 'edit + send again');
  assert.equal((await P(head, `/api/estimation/jmr/${j1.data.id}/decide`, { decision: 'approve' })).status, 200);
  assert.equal((await P(est, `/api/estimation/jmr/${j1.data.id}/update`, jmr)).status, 400, 'approved = locked');
  assert.equal((await P(est, `/api/estimation/jmr/${j1.data.id}/delete`)).status, 403);

  // second JMR, same work item + contractor → previous / cumulative
  const j2 = await P(est, '/api/estimation/jmr', { ...jmr, lines: [{ description: 'Wall C', nos: 1, length: 4, height: 3 }], source_files: [{ name: 'highrise-2.xlsx', data: XLSX }], submit: true });
  assert.equal(j2.data.status, 'submitted');
  let data = (await G(pur, '/api/estimation')).data;
  const a = data.jmr.find(x => x.id === j1.data.id), b = data.jmr.find(x => x.id === j2.data.id);
  assert.equal(a.prev_qty, 0); assert.equal(a.cum_qty, 40.4); assert.equal(a.lines.length, 3); assert.equal(a.files.length, 2); assert.equal(a.files.filter(f => f.kind === 'source').length, 1);
  assert.equal(b.prev_qty, 40.4); assert.equal(b.cum_qty, 52.4);
  assert.equal(a.material, 'AAC blocks 150 mm'); assert.equal(a.amount, null);
  assert.ok(a.comments.some(c => c.kind === 'submit' && /lift wall/.test(c.text)));
  assert.ok(a.comments.some(c => c.kind === 'returned') && a.comments.some(c => c.kind === 'approved'));
  const srcF = a.files.find(f => f.kind === 'source'), attF = a.files.find(f => f.kind !== 'source');
  assert.equal((await G(pur, `/api/estimation/files/${srcF.id}`)).status, 200, 'HighRise document can be downloaded');
  assert.equal((await G(pur, `/api/estimation/files/${attF.id}`)).status, 403, 'other attachments: view only');
  assert.equal((await G(est, `/api/estimation/files/${attF.id}`)).status, 403);
  assert.equal((await G(admin, `/api/estimation/files/${attF.id}`)).status, 200);
  assert.equal((await G(pur, `/api/estimation/files/${srcF.id}/view`)).data.canDownload, true);
  assert.equal((await G(pur, `/api/estimation/files/${attF.id}/view`)).data.canDownload, false);
  // view-only: images come back as an image, spreadsheets as a table
  const img = a.files.find(f => /png$/.test(f.name));
  assert.equal((await G(pur, `/api/estimation/files/${img.id}/view`)).data.kind, 'image');
  const wb = new (require('exceljs').Workbook)(); const ws = wb.addWorksheet('BOQ'); ws.addRow(['Item', 'Qty']); ws.addRow(['Block work', 40.4]);
  const realX = 'data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,' + Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
  assert.equal((await P(est, `/api/estimation/jmr/${j2.data.id}/files`, { attachments: [{ name: 'boq.xlsx', data: realX }] })).status, 200);
  const xf = (await G(pur, '/api/estimation')).data.jmr.find(x => x.id === j2.data.id).files.find(f => f.name === 'boq.xlsx');
  const v = await G(pur, `/api/estimation/files/${xf.id}/view`);
  assert.equal(v.data.kind, 'sheet', JSON.stringify(v.data)); assert.equal(v.data.sheets[0].name, 'BOQ'); assert.deepEqual(v.data.sheets[0].rows[1].map(String), ['Block work', '40.4']);
  assert.equal((await G(sales, `/api/estimation/files/${xf.id}/view`)).status, 403);
  assert.equal((await G(sales, `/api/estimation/files/${a.files[0].id}`)).status, 403);
  // signed copy after approval
  assert.equal((await P(est, `/api/estimation/jmr/${j1.data.id}/files`, { attachments: [{ name: 'signed.png', data: PNG }] })).status, 200);

  // Reconciliation maths
  const rec = { project: 'Mihir Amara', material: 'Cement OPC 53', unit: 'bags', contractor: 'Shree Builders', work_item: 'Block work 150 mm',
    issued: 500, returned: 20, balance_at_site: 30, work_qty: 1000, work_unit: 'sqm', norm: 0.4, wastage_pct: 3, rate: 380 };
  assert.equal((await P(est, '/api/estimation/recon', { ...rec, returned: 400, balance_at_site: 200 })).status, 400, 'returned + balance > issued');
  const r1 = await P(est, '/api/estimation/recon', { ...rec, source_files: [{ name: 'stock.xlsx', data: XLSX }] });
  assert.equal(r1.status, 200, JSON.stringify(r1.data));
  // actual 450, theoretical 400, allowed 412, excess 38, recovery 14440
  assert.deepEqual({ ...r1.data.calc }, { actual: 450, theoretical: 400, allowed: 412, excess: 38, saving: 0, variancePct: 12.5, recovery: 14440 });
  assert.equal((await P(est, `/api/estimation/recon/${r1.data.id}/submit`)).status, 200);
  assert.equal((await P(head, `/api/estimation/recon/${r1.data.id}/decide`, { decision: 'approve' })).status, 200);
  data = (await G(head, '/api/estimation')).data;
  assert.equal(data.recon[0].status, 'approved'); assert.equal(data.recon[0].calc.recovery, 14440);
  // summary counts (badge)
  assert.equal((await G(head, '/api/estimation/summary')).data.toApprove, 1, 'j2 waiting');
  // remove a draft
  const d = await P(est, '/api/estimation/recon', { ...rec, material: 'Steel' });
  assert.equal((await P(est, `/api/estimation/recon/${d.data.id}/delete`)).status, 200);
});
