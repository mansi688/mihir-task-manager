const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember } = require('../testlib/helpers');
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const XLSX = 'data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,UEsDBBQAAAAIAA==';
const PDF = 'data:application/pdf;base64,JVBERi0xLjQK';

test('Estimation workflow: estimate (HighRise + Excel) → both project heads approve → JMR open → final JMR → reconciliation → completed; rejection and resubmission', async (t) => {
  const { baseUrl, stop } = await startTestServer();
  t.after(stop);
  const admin = await login(baseUrl, 'admin', 'admin123');
  const P = (tok, path, body) => api(baseUrl, path, { method: 'POST', token: tok, body });
  const G = (tok, path) => api(baseUrl, path, { token: tok });
  const est = await createMember(baseUrl, admin, 'vaibhav.e', 'Vaibhav Estimation', 'Estimation & Billing Department');
  // Mihir Amara heads (PROJECT_HEADS): suraj.k and rahul.p
  const suraj = await createMember(baseUrl, admin, 'suraj.k', 'Suraj Kathale', 'Senior management');
  const rahul = await createMember(baseUrl, admin, 'rahul.p', 'Rahul Paigude', 'Execution Department');
  const anil = await createMember(baseUrl, admin, 'anil.w', 'Anil Wagh', 'Execution Department'); // Equinox head — not Amara
  const pur = await createMember(baseUrl, admin, 'tanu.p', 'Tanu Purchase', 'Purchase Department');
  const sales = await createMember(baseUrl, admin, 'sales.x', 'Sales Person', 'Sales Department');
  const nots = async (tok, type) => (await G(tok, '/api/notifications')).data.items.filter(n => n.type === type);

  // access
  assert.equal((await G(sales, '/api/estimation')).status, 403);
  assert.equal((await G(suraj, '/api/estimation')).status, 200, 'project heads can see Estimation');
  assert.equal((await G(pur, '/api/estimation')).data.me.canEdit, false);

  // 1. Estimate: HighRise and Excel are both required, separately
  const base = { project: 'Mihir Amara', title: 'Block work 150 mm — Tower B', contractor: 'Shree Builders', description: 'Floors 1–7' };
  assert.equal((await P(est, '/api/estimation/estimate', { ...base, submit: true })).status, 400);
  assert.match((await P(est, '/api/estimation/estimate', { ...base, submit: true, excel_files: [{ name: 'boq.xlsx', data: XLSX }] })).data.error, /HighRise/);
  assert.match((await P(est, '/api/estimation/estimate', { ...base, submit: true, highrise_files: [{ name: 'highrise.pdf', data: PDF }] })).data.error, /Excel/);
  assert.equal((await P(est, '/api/estimation/estimate', { ...base, highrise_files: [{ name: 'h.pdf', data: PDF }], excel_files: [{ name: 'not-excel.pdf', data: PDF }] })).status, 400, 'excel must be a spreadsheet');
  const e1 = await P(est, '/api/estimation/estimate', { ...base, highrise_files: [{ name: 'highrise.pdf', data: PDF }], excel_files: [{ name: 'boq.xlsx', data: XLSX }] });
  assert.equal(e1.status, 200, JSON.stringify(e1.data));
  const eid = e1.data.id;
  // JMR cannot start before approval
  const jmrBase = { estimate_id: eid, work_item: 'Block work 150 mm', unit: 'sqm', lines: [{ description: 'Wall A', qty: 40, manual: true }] };
  assert.match((await P(est, '/api/estimation/jmr', jmrBase)).data.error, /not approved/);
  // send → both heads + Admin told, nobody else
  assert.equal((await P(est, `/api/estimation/estimate/${eid}/submit`, { remarks: 'Rates as per HighRise rev 2' })).status, 200);
  for (const tok of [suraj, rahul, admin]) assert.ok((await nots(tok, 'est_submitted')).some(n => /Estimate .*Block work 150 mm/.test(n.message) && /Both project heads/.test(n.message)));
  assert.equal((await nots(anil, 'est_submitted')).length, 0, 'another project\'s head is not asked');
  assert.equal((await G(suraj, '/api/estimation/summary')).data.toApprove, 1);
  // permissions: other project's head / Purchase / the writer cannot approve
  assert.equal((await P(anil, `/api/estimation/estimate/${eid}/decide`, { decision: 'approve' })).status, 403);
  assert.equal((await P(pur, `/api/estimation/estimate/${eid}/decide`, { decision: 'approve' })).status, 403);
  // 2. Rejection needs a reason; goes back to the writer
  assert.equal((await P(rahul, `/api/estimation/estimate/${eid}/decide`, { decision: 'return' })).status, 400);
  assert.equal((await P(rahul, `/api/estimation/estimate/${eid}/decide`, { decision: 'return', note: 'Plaster quantity missing for floor 7' })).status, 200);
  assert.ok((await nots(est, 'est_decided')).some(n => /rejected .*Plaster quantity missing/.test(n.message)));
  // corrected and sent again (new round)
  assert.equal((await P(est, `/api/estimation/estimate/${eid}/update`, { ...base, description: 'Floors 1–7 incl. floor 7 plaster', submit: true })).status, 200);
  // both heads must approve
  let r = await P(suraj, `/api/estimation/estimate/${eid}/decide`, { decision: 'approve' });
  assert.equal(r.data.status, 'submitted'); assert.deepEqual(r.data.waitingFor, ['rahul.p']);
  assert.equal((await P(suraj, `/api/estimation/estimate/${eid}/decide`, { decision: 'approve' })).status, 400, 'no double approval');
  assert.ok((await nots(est, 'est_decided')).some(n => /waiting for Rahul Paigude/.test(n.message)));
  assert.equal((await G(suraj, '/api/estimation/summary')).data.toApprove, 0, 'Suraj has done his part');
  assert.equal((await G(rahul, '/api/estimation/summary')).data.toApprove, 1);
  r = await P(rahul, `/api/estimation/estimate/${eid}/decide`, { decision: 'approve' });
  assert.equal(r.data.status, 'approved');
  // 3. JMR open → notification
  assert.ok((await nots(est, 'est_jmr_open')).some(n => /approved — JMR is now open/.test(n.message)));
  let data = (await G(est, '/api/estimation')).data;
  let e = data.estimates.find(x => x.id === eid);
  assert.equal(e.status, 'approved'); assert.equal(e.stage, 'jmr');
  assert.deepEqual(e.approval.heads.map(h => h.decision), ['approve', 'approve']);
  assert.ok(e.comments.some(c => c.kind === 'returned') && e.comments.some(c => c.kind === 'submit'));
  assert.deepEqual(data.heads['Mihir Amara'].map(h => h.username), ['suraj.k', 'rahul.p']);
  // JMR 1 (not final): approved by both
  const j1 = await P(est, '/api/estimation/jmr', { ...jmrBase, ra_bill_no: 'RA-01', submit: true });
  assert.equal(j1.status, 200, JSON.stringify(j1.data));
  assert.equal((await P(suraj, `/api/estimation/jmr/${j1.data.id}/decide`, { decision: 'approve' })).data.status, 'submitted');
  assert.equal((await P(rahul, `/api/estimation/jmr/${j1.data.id}/decide`, { decision: 'approve' })).data.status, 'approved');
  // reconciliation not yet
  const recBase = { estimate_id: eid, material: 'AAC blocks', unit: 'nos', issued: 1000, returned: 20, balance_at_site: 30, work_qty: 100, norm: 9, wastage_pct: 3, rate: 60 };
  assert.match((await P(est, '/api/estimation/recon', recBase)).data.error, /final JMR/);
  // JMR 2 = final; rejected once, then Admin approves on behalf of both heads
  const j2 = await P(est, '/api/estimation/jmr', { ...jmrBase, ra_bill_no: 'RA-02', is_final: true, lines: [{ description: 'Wall B', qty: 25, manual: true }], submit: true });
  assert.equal((await P(suraj, `/api/estimation/jmr/${j2.data.id}/decide`, { decision: 'return', note: 'Wall B length wrong' })).status, 200);
  data = (await G(est, '/api/estimation')).data;
  assert.equal(data.estimates.find(x => x.id === eid).stage, 'jmr', 'a rejected final JMR does not close JMR');
  assert.equal((await P(est, `/api/estimation/jmr/${j2.data.id}/update`, { ...jmrBase, ra_bill_no: 'RA-02', is_final: true, lines: [{ description: 'Wall B', qty: 24, manual: true }], submit: true })).status, 200);
  r = await P(admin, `/api/estimation/jmr/${j2.data.id}/decide`, { decision: 'approve' });
  assert.equal(r.data.status, 'approved', 'Admin approves for both heads');
  // 4. Reconciliation report requested
  assert.ok((await nots(est, 'est_recon_due')).some(n => /Final JMR .* approved .*reconciliation report/.test(n.message)));
  data = (await G(est, '/api/estimation')).data;
  e = data.estimates.find(x => x.id === eid);
  assert.equal(e.stage, 'reconciliation'); assert.equal(e.jmrApproved, 2); assert.equal(e.jmrQty, 64);
  assert.match((await P(est, '/api/estimation/jmr', jmrBase)).data.error, /closed/, 'no more JMRs after the final one');
  const rc = await P(est, '/api/estimation/recon', { ...recBase, submit: true, remarks: 'Store issue slips attached' });
  assert.equal(rc.status, 200, JSON.stringify(rc.data));
  assert.equal((await P(rahul, `/api/estimation/recon/${rc.data.id}/decide`, { decision: 'approve' })).data.status, 'submitted');
  assert.equal((await P(suraj, `/api/estimation/recon/${rc.data.id}/decide`, { decision: 'approve' })).data.status, 'approved');
  // 5. Completed
  data = (await G(est, '/api/estimation')).data;
  assert.equal(data.estimates.find(x => x.id === eid).stage, 'completed');
  assert.ok((await nots(est, 'est_completed')).some(n => /is completed/.test(n.message)));
  // files: HighRise downloadable, Excel view-only (except Admin)
  const hf = e.files.find(f => f.kind === 'highrise'), xf = e.files.find(f => f.kind === 'excel');
  assert.equal((await G(suraj, `/api/estimation/files/${hf.id}`)).status, 200);
  assert.equal((await G(suraj, `/api/estimation/files/${xf.id}`)).status, 403);
  assert.equal((await G(admin, `/api/estimation/files/${xf.id}`)).status, 200);
  // a project without heads (Mihir Projects) is approved by Admin
  const e2 = await P(est, '/api/estimation/estimate', { project: 'Mihir Projects', title: 'Office fit-out', highrise_files: [{ name: 'h.pdf', data: PDF }], excel_files: [{ name: 'e.xlsx', data: XLSX }], submit: true });
  assert.equal(e2.status, 200);
  assert.equal((await P(admin, `/api/estimation/estimate/${e2.data.id}/decide`, { decision: 'approve' })).data.status, 'approved');
  // an estimate with JMRs cannot be deleted
  assert.equal((await P(admin, `/api/estimation/estimate/${eid}/delete`)).status, 400);
  // remarks reach the heads
  assert.equal((await P(suraj, `/api/estimation/estimate/${eid}/remark`, { text: 'Good work on this package' })).status, 200);
  assert.ok((await nots(est, 'est_remark')).some(n => /Good work/.test(n.message)));
  assert.ok(PNG);
});
