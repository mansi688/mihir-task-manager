// Refused check-ins are kept with the reason, GPS and live photo; HR sees them on Today and can accept them.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember } = require('../testlib/helpers');

const SITE = { lat: 18.5204, lng: 73.8567 };
const PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACv/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AN//Z';

test('refused check-in → HR sees why → HR accepts it', async (t) => {
  process.env.ENABLE_LOCATION_TRACKING = 'true';
  const { baseUrl, stop } = await startTestServer();
  t.after(async () => { delete process.env.ENABLE_LOCATION_TRACKING; await stop(); });
  const admin = await login(baseUrl, 'admin', 'admin123');
  const P = (p, token, body) => api(baseUrl, p, { method: 'POST', token, body });
  const G = (p, token) => api(baseUrl, p, { token });
  assert.equal((await P('/api/location/places', admin, { name: 'Nyati Equinox', kind: 'site', lat: SITE.lat, lng: SITE.lng, radiusM: 100, minDwellSeconds: 120 })).status, 200);
  const hr = await createMember(baseUrl, admin, 'hr.x', 'HR X', 'HR Department');
  const w = await createMember(baseUrl, admin, 'dhanaji.t', 'Dhanaji T', 'Execution Department');

  // weak GPS indoors: refused and kept — nothing is sent to HR by itself
  const r1 = await P('/api/attendance/check-in', w, { lat: SITE.lat, lng: SITE.lng, acc: 450, photo: PHOTO });
  assert.equal(r1.status, 400);
  assert.match(r1.data.error, /not accurate enough/);
  assert.match(r1.data.error, /tell HR or Admin/);
  assert.equal(r1.data.sentToHr, true);
  await P('/api/attendance/check-in', w, { lat: SITE.lat, lng: SITE.lng, acc: 400, photo: PHOTO });
  const notes = (await G('/api/notifications', hr)).data;
  const list = Array.isArray(notes) ? notes : (notes.notifications || notes.items || []);
  assert.equal(list.filter(n => /could not check in/.test(n.message)).length, 0, 'no automatic message to HR');

  // no photo: refused, kept, but not sent to HR as acceptable
  const r2 = await P('/api/attendance/check-in', w, { lat: SITE.lat, lng: SITE.lng, acc: 20 });
  assert.equal(r2.status, 400); assert.equal(r2.data.sentToHr, false);

  const today = (await G('/api/attendance/today', hr)).data;
  const mine = today.attempts.filter(a => a.username === 'dhanaji.t');
  assert.equal(mine.length, 3);
  assert.ok(mine.every(a => a.action === 'in' && !a.done));
  const withPhoto = mine.find(a => a.has_photo);
  assert.match(withPhoto.map, /^https:\/\/www\.google\.com\/maps\?q=/);
  assert.equal(withPhoto.nearest, 'Nyati Equinox');
  assert.ok((await G(`/api/attendance/attempts/${withPhoto.id}/photo`, hr)).data.data.startsWith('data:image/'));

  // the worker cannot see / accept attempts
  assert.equal((await G('/api/attendance/attempts', w)).status, 403);
  assert.equal((await P(`/api/attendance/attempts/${withPhoto.id}/accept`, w)).status, 403);

  // HR accepts → checked in at the attempt time, marked as accepted by HR
  const acc = await P(`/api/attendance/attempts/${withPhoto.id}/accept`, hr);
  assert.equal(acc.status, 200, JSON.stringify(acc.data));
  const me = (await G('/api/attendance/me', w)).data.todayRec;
  assert.equal(me.in, withPhoto.at_hm);
  const t2 = (await G('/api/attendance/today', hr)).data;
  const row = t2.list.find(p => p.username === 'dhanaji.t');
  assert.equal(row.inHow, 'hr');
  assert.ok(t2.attempts.filter(a => a.username === 'dhanaji.t').every(a => a.done));
  assert.equal((await P(`/api/attendance/attempts/${withPhoto.id}/accept`, hr)).status, 400, 'twice is refused');

  // check-out refused then accepted
  const r3 = await P('/api/attendance/check-out', w, { lat: SITE.lat + 0.05, lng: SITE.lng, acc: 10, photo: PHOTO });
  assert.equal(r3.status, 400); assert.match(r3.data.error, /not inside a site/);
  const out = (await G('/api/attendance/attempts', hr)).data.list.find(a => a.action === 'out');
  assert.ok(out.nearest_m > 5000);
  assert.equal((await P(`/api/attendance/attempts/${out.id}/accept`, hr)).status, 200);
  assert.ok((await G('/api/attendance/me', w)).data.todayRec.out);

  // deny: another person's refused check-in is denied, they are told, nothing is marked
  const w2 = await createMember(baseUrl, admin, 'ramraj.t', 'Ramraj T', 'Execution Department');
  await P('/api/attendance/check-in', w2, { lat: SITE.lat, lng: SITE.lng, acc: 500, photo: PHOTO });
  const a2 = (await G('/api/attendance/attempts', hr)).data.list.find(a => a.username === 'ramraj.t');
  assert.equal((await P(`/api/attendance/attempts/${a2.id}/deny`, hr)).status, 200);
  assert.equal((await G('/api/attendance/me', w2)).data.todayRec, null);
  assert.equal((await G('/api/attendance/attempts', hr)).data.list.find(a => a.username === 'ramraj.t').status, 'denied');
  const n2 = (await G('/api/notifications', w2)).data; const l2 = Array.isArray(n2) ? n2 : (n2.notifications || n2.items || []);
  assert.ok(l2.some(n => /did not accept/.test(n.message)));
});
