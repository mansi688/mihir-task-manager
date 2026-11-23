// People: dates (HR only), birthdays / anniversaries, who is out, directory privacy, Raise Request, daily greetings.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember } = require('../testlib/helpers');

const istDay = (ms = Date.now()) => new Date(ms + 330 * 60000).toISOString().slice(0, 10);
const yearsAgo = (day, n) => `${Number(day.slice(0, 4)) - n}${day.slice(4)}`;

test('people, celebrations, who is out, Raise Request', async (t) => {
  const { baseUrl, stop, getRawClient } = await startTestServer();
  t.after(stop);
  const raw = await getRawClient(); t.after(() => raw.end());
  const admin = await login(baseUrl, 'admin', 'admin123');
  const hr = await createMember(baseUrl, admin, 'pp.hr', 'HR Person', 'HR Department');
  const a = await createMember(baseUrl, admin, 'pp.a', 'Asha A', 'Execution Department');
  const b = await createMember(baseUrl, admin, 'pp.b', 'Bhavin B', 'Execution Department');
  const P = (tok, p, body) => api(baseUrl, p, { method: 'POST', token: tok, body });
  const G = (tok, p) => api(baseUrl, p, { token: tok });
  const today = istDay();

  await t.test('only HR / Admin set dates; birth year stays private', async () => {
    assert.equal((await P(a, '/api/people/pp.a/profile', { dob: '1995-03-04' })).status, 403);
    assert.equal((await P(hr, '/api/people/pp.a/profile', { dob: 'nope' })).status, 400);
    assert.equal((await P(hr, '/api/people/pp.a/profile', { dob: yearsAgo(today, 30), joinDate: yearsAgo(today, 3), designation: 'Site Engineer' })).status, 200);
    const d = (await G(b, '/api/people/directory')).data;
    const row = d.list.find(p => p.username === 'pp.a');
    assert.equal(row.birthday, today.slice(5)); assert.equal(row.dob, undefined, 'no birth year for colleagues'); assert.equal(row.designation, 'Site Engineer');
    assert.equal(row.joined, yearsAgo(today, 3).slice(0, 4), 'only the joining year for colleagues');
    assert.equal(d.canEdit, false);
    const h = (await G(hr, '/api/people/directory')).data;
    assert.equal(h.list.find(p => p.username === 'pp.a').dob, yearsAgo(today, 30)); assert.equal(h.canEdit, true);
  });

  await t.test('CSV import (either date format); bad lines are reported, good ones saved', async () => {
    const r = await P(hr, '/api/people/dates/import', { text: 'username,dob,joinDate\npp.b,15-08-1990,01/04/2022\nnobody,1990-01-01,\npp.b,notadate,\n' });
    assert.equal(r.status, 200); assert.equal(r.data.updated, 1); assert.equal(r.data.errors.length, 2);
    assert.equal((await G(hr, '/api/people/directory')).data.list.find(p => p.username === 'pp.b').dob, '1990-08-15');
    assert.equal((await P(a, '/api/people/dates/import', { text: 'pp.b,1990-01-01,' })).status, 403);
  });

  await t.test('overview: birthday today, anniversary, on leave today, holiday', async () => {
    await raw.query("INSERT INTO leave_requests(username, from_day, to_day, half_day, kind, days, reason, status, created_at) VALUES('pp.b',$1,$1,false,'paid',1,'x','approved',$1)", [today]);
    await raw.query("INSERT INTO payroll_holidays(day, name) VALUES($1,'Diwali') ON CONFLICT DO NOTHING", [new Date(Date.now() + 330 * 60000 + 5 * 864e5).toISOString().slice(0, 10)]);
    const o = (await G(b, '/api/people/overview')).data;
    const bd = o.celebrations.find(c => c.type === 'birthday' && c.username === 'pp.a');
    assert.equal(bd.inDays, 0);
    const an = o.celebrations.find(c => c.type === 'anniversary' && c.username === 'pp.a');
    assert.equal(an.years, 3); assert.equal(an.inDays, 0);
    assert.deepEqual(o.outToday.map(x => x.username), ['pp.b']);
    assert.ok(o.holidays.some(h => h.name === 'Diwali'));
  });

  await t.test('daily greetings: once a day, after 08:00 IST', async () => {
    const at = (hh) => new Date(`${today}T${hh}:00+05:30`).toISOString();
    assert.equal((await P(admin, '/api/people/greetings-run', { at: at('06:00') })).data.skipped, 'early');
    const r = await P(admin, '/api/people/greetings-run', { at: at('09:00') });
    assert.ok(r.data.sent >= 2);
    assert.equal((await P(admin, '/api/people/greetings-run', { at: at('10:00') })).data.skipped, 'done');
    const mine = (await G(a, '/api/notifications')).data.items.map(n => n.message);
    assert.ok(mine.some(m => /Happy birthday/.test(m)) && mine.some(m => /work anniversary/.test(m)));
    assert.ok((await G(b, '/api/notifications')).data.items.some(n => /Today is Asha A's birthday/.test(n.message)));
    assert.equal((await P(a, '/api/people/greetings-run', {})).status, 403);
  });

  await t.test('Raise Request: validation, approve → day corrected, reject, withdraw, permissions', async () => {
    assert.equal((await P(a, '/api/attendance/requests', { day: today, kind: 'missed_out', reason: 'x' })).status, 400, 'needs a time');
    assert.equal((await P(a, '/api/attendance/requests', { day: '2020-01-01', kind: 'missed_out', outTime: '18:30', reason: 'old' })).status, 400, 'too old');
    const mk = await P(a, '/api/attendance/requests', { day: today, kind: 'missed_out', inTime: '09:30', outTime: '18:30', reason: 'Forgot to clock out at the site' });
    assert.equal(mk.status, 200, JSON.stringify(mk.data));
    assert.equal((await P(a, '/api/attendance/requests', { day: today, kind: 'other', outTime: '19:00', reason: 'again' })).status, 400, 'one waiting request per day');
    assert.ok((await G(hr, '/api/attendance/requests')).data.waiting.some(r => r.id === mk.data.id));
    assert.equal((await G(b, '/api/attendance/requests')).data.waiting.length, 0, 'colleagues see nothing');
    assert.equal((await P(b, `/api/attendance/requests/${mk.data.id}/approve`)).status, 403);
    assert.equal((await P(b, `/api/attendance/requests/${mk.data.id}/withdraw`)).status, 403);
    assert.equal((await P(hr, `/api/attendance/requests/${mk.data.id}/approve`, { note: 'ok' })).status, 200);
    const day = (await G(a, '/api/attendance/me')).data.days.find(d => d.day === today);
    assert.equal(day.in, '09:30'); assert.equal(day.out, '18:30'); assert.equal(day.status, 'P'); assert.equal(day.worked, 540);
    assert.equal((await P(hr, `/api/attendance/requests/${mk.data.id}/approve`)).status, 400, 'decided once');
    assert.ok((await G(a, '/api/notifications')).data.items.some(n => /accepted your attendance request/.test(n.message)));
    // reject + withdraw
    const y = istDay(Date.now() - 864e5);
    const r2 = await P(b, '/api/attendance/requests', { day: y, kind: 'wrong_time', inTime: '08:00', reason: 'wrong time' });
    assert.equal((await P(hr, `/api/attendance/requests/${r2.data.id}/reject`, { note: 'no proof' })).status, 200);
    assert.equal((await G(b, '/api/attendance/requests')).data.mine[0].status, 'rejected');
    const r3 = await P(b, '/api/attendance/requests', { day: y, kind: 'missed_in', inTime: '09:00', reason: 'again' });
    assert.equal((await P(b, `/api/attendance/requests/${r3.data.id}/withdraw`)).status, 200);
    // clock-out before clock-in cannot be approved
    const r4 = await P(b, '/api/attendance/requests', { day: y, kind: 'missed_out', inTime: '18:00', outTime: '09:00', reason: 'typo' });
    assert.match((await P(hr, `/api/attendance/requests/${r4.data.id}/approve`)).data.error, /before the clock-in/);
    // night shift: out the next morning
    const r5 = await P(a, '/api/attendance/requests', { day: y, kind: 'missed_out', inTime: '22:00', outTime: '06:00', outNextDay: true, reason: 'night shift' });
    assert.equal((await P(hr, `/api/attendance/requests/${r5.data.id}/approve`)).status, 200);
  });
});
