// Earlier refused check-ins (from before check-in was allowed from anywhere) stay visible to HR, who can still accept
// or deny them; photos on them are deleted at 12:00 the next day.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember } = require('../testlib/helpers');

const PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACv/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AN//Z';

test('old refused check-in → HR sees it → HR accepts or denies it', async (t) => {
  const { baseUrl, stop, getRawClient } = await startTestServer();
  t.after(stop);
  const raw = await getRawClient(); t.after(() => raw.end());
  const admin = await login(baseUrl, 'admin', 'admin123');
  const P = (p, token, body) => api(baseUrl, p, { method: 'POST', token, body });
  const G = (p, token) => api(baseUrl, p, { token });
  const hr = await createMember(baseUrl, admin, 'hr.x', 'HR X', 'HR Department');
  const w = await createMember(baseUrl, admin, 'dhanaji.t', 'Dhanaji T', 'Execution Department');
  const w2 = await createMember(baseUrl, admin, 'ramraj.t', 'Ramraj T', 'Execution Department');
  const day = (await G('/api/attendance/me', w)).data.today;
  const attempt = async (u, action, hm, photo = PHOTO) => (await raw.query(`INSERT INTO attendance_attempts(username, day, action, at, reason, lat, lng, acc, nearest, nearest_m, photo)
    VALUES($1,$2,$3,$4,'You are not inside a site',18.5,73.8,20,'Nyati Equinox',900,$5) RETURNING id`, [u, day, action, new Date(`${day}T${hm}:00+05:30`).toISOString(), photo])).rows[0].id;

  // nothing new is refused any more: a check-in from anywhere works
  const probe = await createMember(baseUrl, admin, 'probe.t', 'Probe', 'Execution Department');
  assert.equal((await P('/api/attendance/check-in', probe, { lat: 18.9, lng: 73.1, acc: 400, photo: PHOTO })).status, 200);

  const inId = await attempt('dhanaji.t', 'in', '09:40');
  const list = (await G('/api/attendance/today', hr)).data.attempts.filter(a => a.username === 'dhanaji.t');
  assert.equal(list.length, 1); assert.match(list[0].map, /^https:\/\/www\.google\.com\/maps\?q=/);
  assert.ok((await G(`/api/attendance/attempts/${inId}/photo`, hr)).data.data.startsWith('data:image/'));
  assert.equal((await G('/api/attendance/attempts', w)).status, 403);
  assert.equal((await P(`/api/attendance/attempts/${inId}/accept`, w)).status, 403);

  assert.equal((await P(`/api/attendance/attempts/${inId}/accept`, hr)).status, 200);
  const me = (await G('/api/attendance/me', w)).data.todayRec;
  assert.equal(me.in, '09:40');
  assert.equal((await G('/api/attendance/today', hr)).data.list.find(p => p.username === 'dhanaji.t').inHow, 'hr');
  assert.equal((await P(`/api/attendance/attempts/${inId}/accept`, hr)).status, 400, 'twice is refused');

  const outId = await attempt('dhanaji.t', 'out', '18:20');
  assert.equal((await P(`/api/attendance/attempts/${outId}/accept`, hr)).status, 200);
  assert.equal((await G('/api/attendance/me', w)).data.todayRec.out, '18:20');

  const a2 = await attempt('ramraj.t', 'in', '10:00');
  assert.equal((await P(`/api/attendance/attempts/${a2}/deny`, hr)).status, 200);
  assert.equal((await G('/api/attendance/me', w2)).data.todayRec, null);
  assert.equal((await G('/api/attendance/attempts', hr)).data.list.find(a => a.username === 'ramraj.t').status, 'denied');
  const n2 = (await G('/api/notifications', w2)).data.items;
  assert.ok(n2.some(n => /did not accept/.test(n.message)));
});
