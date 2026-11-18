const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember } = require('../testlib/helpers');
const csvDataUrl = (text) => 'data:text/csv;base64,' + Buffer.from(text, 'utf8').toString('base64');
const istToday = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const dmy = (ymd) => ymd.split('-').reverse().join('-');

test('daily progress report: import, typed entries, material totals, who can see it', async (t) => {
  const { baseUrl, stop } = await startTestServer();
  t.after(stop);
  const admin = await login(baseUrl, 'admin', 'admin123');
  const site = await createMember(baseUrl, admin, 'dpr.site', 'Site Store', 'Store Department');
  const store = await createMember(baseUrl, admin, 'dpr.store', 'Store Keeper', 'Store Department');
  const purchase = await createMember(baseUrl, admin, 'dpr.buy', 'Buyer', 'Purchase Department');
  const hr = await createMember(baseUrl, admin, 'dpr.hr', 'HR Person', 'HR Department');
  const P = (tok, path, body) => api(baseUrl, path, { method: 'POST', token: tok, body });
  const G = (tok, path) => api(baseUrl, path, { token: tok });
  const today = istToday();

  await t.test('who sees it', async () => {
    assert.equal((await G(hr, '/api/dpr')).status, 403);
    const exec = await createMember(baseUrl, admin, 'dpr.exec', 'Site Engineer', 'Execution Department');
    assert.equal((await G(exec, '/api/dpr')).status, 403, 'DPR is Store, Purchase and Admin');
    assert.equal((await G(hr, '/api/dpr/summary')).data.canView, false);
    for (const tok of [admin, site, store, purchase]) assert.equal((await G(tok, '/api/dpr')).status, 200);
    assert.equal((await G(purchase, '/api/dpr/summary')).data.canEdit, false);
    assert.equal((await P(purchase, '/api/dpr/entries', { project: 'Mihir Amara', date: today, kind: 'work', item: 'x' })).status, 403);
  });

  await t.test('the template imports as it is (preview, then save; again adds nothing)', async () => {
    const tpl = (await G(site, '/api/dpr/template')).data;
    const pv = await P(site, '/api/dpr/import', { fileData: tpl.data, fileName: tpl.name });
    assert.equal(pv.status, 200, JSON.stringify(pv.data));
    assert.equal(pv.data.preview, true);
    assert.ok(pv.data.days.length >= 1);
    const sv = await P(site, '/api/dpr/import', { fileData: tpl.data, fileName: tpl.name, confirm: true });
    assert.equal(sv.status, 200, JSON.stringify(sv.data));
    assert.equal(sv.data.added, 9);
    const again = await P(site, '/api/dpr/import', { fileData: tpl.data, fileName: tpl.name, confirm: true });
    assert.equal(again.data.added, 0); assert.equal(again.data.duplicates, 9);
    const r = (await G(store, '/api/dpr?from=2026-11-01&to=2026-11-30')).data;
    const rep = r.reports.find(x => x.project === 'Mihir Amara' && x.report_date === '2026-11-16');
    assert.ok(rep, 'report on the template date');
    const out = rep.entries.find(e => e.kind === 'outward' && /Binding wire/.test(e.item));
    assert.equal(out.party, 'Rahul — steel fixer'); assert.equal(out.at_time, '14:20'); assert.equal(out.qty, 25); assert.equal(out.ref, 'GP-119');
    const cement = r.materials.find(m => m.item === 'Cement OPC 53');
    assert.deepEqual([cement.inward, cement.outward, cement.net], [200, 60, 140]);
  });

  await t.test('one sheet with a Type column; date and project from the screen', async () => {
    const csv = ['Time,Type,Material,Qty,Unit,Issued to,Gate pass', '09:00 AM,Inward,Sand,4,brass,Patil Suppliers,', '2:30 PM,Issued,Sand,1.5,brass,Amit plaster team,GP-9', '17:00,Work,Plaster,120,sqm,Amit,'].join('\n');
    const noDate = await P(site, '/api/dpr/import', { fileData: csvDataUrl(csv), fileName: 'dpr.csv', project: 'Nyati Equinox' });
    assert.equal(noDate.status, 400);
    const ok = await P(site, '/api/dpr/import', { fileData: csvDataUrl(csv), fileName: 'dpr.csv', project: 'Nyati Equinox', date: today, confirm: true });
    assert.equal(ok.status, 200, JSON.stringify(ok.data)); assert.equal(ok.data.added, 3);
    const rep = (await G(admin, `/api/dpr?project=${encodeURIComponent('Nyati Equinox')}`)).data.reports[0];
    assert.deepEqual(rep.entries.map(e => [e.kind, e.at_time]).sort(), [['inward', '09:00'], ['outward', '14:30'], ['work', '17:00']]);
  });

  await t.test('typed entries; outward needs who it was issued to; delete rules', async () => {
    assert.equal((await P(store, '/api/dpr/entries', { project: 'Mihir Amara', date: today, kind: 'outward', item: 'Cement', qty: 10, unit: 'bags' })).status, 400);
    const a = await P(store, '/api/dpr/entries', { project: 'Mihir Amara', date: today, kind: 'outward', item: 'Cement', qty: 10, unit: 'bags', party: 'Mason team', time: '11:05' });
    assert.equal(a.status, 200, JSON.stringify(a.data)); assert.equal(a.data.added, 1);
    const rep = (await G(store, `/api/dpr?project=${encodeURIComponent('Mihir Amara')}`)).data.reports.find(x => x.report_date === today);
    const e = rep.entries.find(x => x.item === 'Cement');
    assert.equal((await api(baseUrl, `/api/dpr/entries/${e.id}`, { method: 'DELETE', token: site })).status, 403);
    assert.equal((await api(baseUrl, `/api/dpr/entries/${e.id}`, { method: 'DELETE', token: store })).status, 200);
    assert.equal((await P(store, '/api/dpr/entries', { project: 'Mihir Amara', date: '2099-01-01', kind: 'work', item: 'x' })).status, 400);
  });
});
