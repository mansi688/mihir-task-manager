const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember } = require('../testlib/helpers');
const { ptFor } = require('../backend/payroll');
const SELFIE = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACv/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AN//Z';
const r2 = (n) => Math.round(n * 100) / 100;

test('Maharashtra professional tax slabs', () => {
  assert.equal(ptFor(7000, 'standard', '2026-10'), 0);
  assert.equal(ptFor(9000, 'standard', '2026-10'), 175);
  assert.equal(ptFor(30000, 'standard', '2026-10'), 200);
  assert.equal(ptFor(30000, 'standard', '2027-02'), 300);
  assert.equal(ptFor(24000, 'women', '2026-10'), 0);
  assert.equal(ptFor(26000, 'women', '2026-10'), 200);
  assert.equal(ptFor(90000, 'exempt', '2026-10'), 0);
});

test('attendance, leave and a month of payroll', async (t) => {
  const { baseUrl, stop } = await startTestServer();
  t.after(stop);
  const admin = await login(baseUrl, 'admin', 'admin123');
  const hr = await createMember(baseUrl, admin, 'pay.hr', 'HR Person', 'HR Department');
  const acc = await createMember(baseUrl, admin, 'pay.acc', 'Accounts Person', 'Accounts Department');
  const emp = await createMember(baseUrl, admin, 'pay.emp', 'Site Engineer', 'Execution Department');
  const other = await createMember(baseUrl, admin, 'pay.other', 'Other Person', 'Execution Department');
  const P = (tok, path, body) => api(baseUrl, path, { method: 'POST', token: tok, body });
  const G = (tok, path) => api(baseUrl, path, { token: tok });

  await t.test('check in / out on the phone (selfie required)', async () => {
    assert.equal((await P(emp, '/api/attendance/check-in', { lat: 18.5, lng: 73.8, acc: 10 })).status, 400, 'selfie needed');
    const a = await P(emp, '/api/attendance/check-in', { lat: 18.5, lng: 73.8, acc: 10, photo: SELFIE });
    assert.equal(a.status, 200, JSON.stringify(a.data));
    assert.equal((await P(emp, '/api/attendance/check-in', { photo: SELFIE })).status, 400, 'only once a day');
    assert.equal((await P(emp, '/api/attendance/check-out', { lat: 18.5, lng: 73.8, photo: SELFIE })).status, 200);
    const me = (await G(emp, '/api/attendance/me')).data;
    assert.ok(me.todayRec.in && me.todayRec.out);
    assert.equal((await G(emp, '/api/attendance/today')).status, 403);
    const today = (await G(hr, '/api/attendance/today')).data;
    assert.ok(today.list.find(x => x.username === 'pay.emp').in);
    const day = me.today;
    assert.equal((await G(hr, `/api/attendance/photo/pay.emp/${day}/in`)).status, 200);
    assert.equal((await G(other, `/api/attendance/photo/pay.emp/${day}/in`)).status, 403);
  });

  await t.test('October 2026: corrections, a paid leave, late marks', async () => {
    // Oct 2026: 31 days, Sundays 4, 11, 18, 25 are weekly offs → 27 working days
    const work = []; for (let d = 1; d <= 31; d++) { const day = `2026-10-${String(d).padStart(2, '0')}`; if (new Date(`${day}T12:00:00Z`).getUTCDay() !== 0) work.push(day); }
    assert.equal(work.length, 27);
    const absent = '2026-10-05', half = '2026-10-06', leave = '2026-10-15', late = ['2026-10-07', '2026-10-08', '2026-10-09'];
    assert.equal((await P(emp, '/api/attendance/correct', { username: 'pay.emp', day: '2026-10-02', status: 'P', reason: 'x' })).status, 403);
    for (const day of work) {
      if (day === absent || day === leave) continue;
      const body = late.includes(day) ? { in: '10:00', out: '20:00' } : day === half ? { status: 'H' } : day === '2026-10-02' ? { in: '09:30', out: '18:45' } : { status: 'P' };
      const r = await P(hr, '/api/attendance/correct', { username: 'pay.emp', day, reason: 'Register', ...body });
      assert.equal(r.status, 200, JSON.stringify(r.data));
    }
    const lv = await P(emp, '/api/leave', { from: leave, to: leave, kind: 'paid', reason: 'Family function' });
    assert.equal(lv.status, 200, JSON.stringify(lv.data)); assert.equal(lv.data.days, 1);
    assert.equal((await P(emp, '/api/leave', { from: leave, kind: 'paid', reason: 'again' })).status, 400, 'no overlapping leave');
    assert.equal((await P(emp, `/api/leave/${lv.data.id}/decide`, { decision: 'approve' })).status, 403);
    assert.equal((await P(hr, `/api/leave/${lv.data.id}/decide`, { decision: 'reject', note: '' })).status, 400);
    assert.equal((await P(hr, `/api/leave/${lv.data.id}/decide`, { decision: 'approve' })).status, 200);
    const reg = (await G(hr, '/api/attendance/register?month=2026-10')).data;
    const row = reg.people.find(p => p.username === 'pay.emp');
    const s = row.summary;
    assert.deepEqual([s.counts.P, s.counts.WO, s.counts.H, s.counts.L, s.counts.A], [24, 4, 1, 1, 1]);
    assert.equal(s.lateMarks, 3); assert.equal(s.lateCutDays, 0.5); assert.equal(s.paidDays, 29); assert.equal(s.lopDays, 2);
    assert.equal(s.otMinutes, 180, '1 hour beyond the 9-hour shift on each late day; 15 minutes extra is not overtime');
  });

  await t.test('salary, advance, prepare → approve → paid → payslip', async () => {
    assert.equal((await P(acc, '/api/payroll/salaries/pay.emp', { basic: 1 })).status, 403, 'Accounts does not set salaries');
    const sv = await P(hr, '/api/payroll/salaries/pay.emp', { basic: 20000, hra: 8000, conveyance: 2000, special: 5000, pt_slab: 'standard', bank_name: 'HDFC Bank', account_no: '50100012345678', ifsc: 'HDFC0001234', employee_code: 'M-101' });
    assert.equal(sv.status, 200, JSON.stringify(sv.data));
    assert.equal((await P(hr, '/api/payroll/salaries/pay.emp', { basic: 20000, ifsc: 'BAD' })).status, 400);
    assert.equal((await P(hr, '/api/payroll/advances', { username: 'pay.emp', amount: 6000, instalment: 2000, given_on: '2026-09-20', reason: 'Medical' })).status, 200);
    assert.equal((await P(acc, '/api/payroll/runs/2026-10/prepare')).status, 403);
    const pr = await P(hr, '/api/payroll/runs/2026-10/prepare');
    assert.equal(pr.status, 200, JSON.stringify(pr.data));
    const l = pr.data.lines.find(x => x.username === 'pay.emp');
    assert.equal(pr.data.lines.length, 1, 'only people with a salary');
    assert.equal(l.paidDays, 29);
    const f = 29 / 31;
    const g = r2(r2(20000 * f) + r2(8000 * f) + r2(2000 * f) + r2(5000 * f));
    assert.equal(l.earned.gross, g);
    assert.equal(l.pf, 1800, '12% of the 15,000 ceiling');
    assert.equal(l.esi, 0, 'gross above the ESI limit');
    assert.equal(l.pt, 200);
    assert.equal(l.otHours, 3); assert.equal(l.otRate, r2(35000 / 30 / 8)); assert.equal(l.otPay, r2(3 * r2(35000 / 30 / 8)));
    assert.equal(l.advance, 2000);
    assert.equal(l.net, r2(g + l.otPay - 1800 - 200 - 2000));
    // an adjustment
    assert.equal((await P(hr, '/api/payroll/runs/2026-10/lines/pay.emp', { other_earn: 500 })).status, 400, 'needs a note');
    const adj = await P(hr, '/api/payroll/runs/2026-10/lines/pay.emp', { other_earn: 500, other_earn_note: 'Site allowance', ot_hours: 2 });
    const l2 = adj.data.lines[0];
    assert.equal(l2.otHours, 2); assert.equal(l2.otherEarn, 500); assert.equal(l2.net, r2(g + r2(2 * l.otRate) + 500 - 4000));
    // employee cannot see it before it is paid; bank sheet only after approval
    assert.equal((await G(emp, '/api/payslips/2026-10/pay.emp')).status, 404);
    assert.equal((await G(acc, '/api/payroll/runs/2026-10/export?kind=bank')).status, 400);
    assert.equal((await P(hr, '/api/payroll/runs/2026-10/approve')).status, 403);
    assert.equal((await P(hr, '/api/payroll/runs/2026-10/submit')).status, 200);
    assert.equal((await P(acc, '/api/payroll/runs/2026-10/paid')).status, 400, 'not approved yet');
    assert.equal((await P(admin, '/api/payroll/runs/2026-10/approve')).status, 200);
    assert.equal((await P(hr, '/api/payroll/runs/2026-10/prepare')).status, 409, 'approved month is locked');
    const bank = await G(acc, '/api/payroll/runs/2026-10/export?kind=bank');
    assert.equal(bank.status, 200); assert.match(bank.data.name, /Bank-transfer-2026-10/);
    assert.equal((await G(acc, '/api/payroll/runs/2026-10/export')).status, 200);
    assert.equal((await P(acc, '/api/payroll/runs/2026-10/paid', { note: 'NEFT batch 44' })).status, 200);
    const slip = await G(emp, '/api/payslips/2026-10/pay.emp');
    assert.equal(slip.status, 200); assert.equal(slip.data.line.net, l2.net); assert.equal(slip.data.line.employerPf, undefined);
    assert.equal((await G(other, '/api/payslips/2026-10/pay.emp')).status, 403);
    const adv = (await G(hr, '/api/payroll/advances')).data.list[0];
    assert.equal(adv.recovered, 2000);
    const me = (await G(emp, '/api/attendance/me?month=2026-10')).data;
    assert.equal(me.payslips[0].period, '2026-10');
    assert.ok((await G(emp, '/api/notifications')).data.items.some(n => n.type === 'payslip_ready'));
  });
});
