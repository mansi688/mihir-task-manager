// Automatic check-in / check-out from location tracking (backend/payroll.js → Places engine hooks).
const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember } = require('../testlib/helpers');

const SITE = { lat: 18.5204, lng: 73.8567 };
const at = (m, bearingDeg = 0) => {
  const R = 6371008.8, b = bearingDeg * Math.PI / 180;
  return { lat: SITE.lat + (m * Math.cos(b)) / R * 180 / Math.PI, lng: SITE.lng + (m * Math.sin(b)) / (R * Math.cos(SITE.lat * Math.PI / 180)) * 180 / Math.PI };
};
let seq = 0;
const NOW = Date.now();
const T = (minAgo) => NOW - minAgo * 60000;
const fix = (where, minAgo, acc = 8) => ({ id: `a${++seq}`, t: T(minAgo), lat: where.lat, lng: where.lng, acc, spd: 0, bat: 0.8, moving: false });
const HM = (ms) => new Date(ms + 330 * 60000).toISOString().slice(11, 16);
const PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACv/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AN//Z';
const IN = at(20), FAR = at(900, 90);

async function upload(baseUrl, tok, points) {
  const r = await fetch(`${baseUrl}/api/location/points`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Location ${tok}` }, body: JSON.stringify({ points }) });
  return { status: r.status, data: await r.json() };
}

test('automatic check-in / out from location tracking', async (t) => {
  const istHour = Number(HM(NOW).slice(0, 2));
  if (istHour < 4) { t.skip('needs the last 4 hours to be the same IST day'); return; }
  process.env.ENABLE_LOCATION_TRACKING = 'true';
  const { baseUrl, stop, getRawClient } = await startTestServer();
  t.after(async () => { delete process.env.ENABLE_LOCATION_TRACKING; await stop(); });
  const raw = await getRawClient(); t.after(() => raw.end());
  const admin = await login(baseUrl, 'admin', 'admin123');
  const P = (p, token, body) => api(baseUrl, p, { method: 'POST', token, body });
  const G = (p, token) => api(baseUrl, p, { token });
  await api(baseUrl, '/api/location/settings', { method: 'PUT', token: admin, body: { allowedHours: null } });
  assert.equal((await P('/api/location/places', admin, { name: 'Tower A site', kind: 'site', lat: SITE.lat, lng: SITE.lng, radiusM: 150, minDwellSeconds: 300 })).status, 200);
  // The site across the road (e.g. Amara ↔ WBB): people walk over for material.
  assert.equal((await P('/api/location/places', admin, { name: 'Store site', kind: 'site', lat: at(400, 180).lat, lng: at(400, 180).lng, radiusM: 120, minDwellSeconds: 300 })).status, 200);
  // Shift ended 40 minutes ago; auto check-out waits 30 minutes after it.
  assert.equal((await P('/api/payroll/settings', admin, { shiftStart: HM(T(180)), shiftEnd: HM(T(40)), checkoutAfterShiftMin: 30, autoAttendance: true })).status, 200);

  async function startTracking(username, name) {
    const tok = await createMember(baseUrl, admin, username, name, 'Execution Department');
    const me = (await G('/api/location/me', tok)).data;
    await P('/api/location/consent', tok, { policyVersion: me.policy.version });
    const s = await P('/api/location/sessions/start', tok, { platform: 'android' });
    assert.equal(s.status, 200, JSON.stringify(s.data));
    await raw.query("UPDATE location_sessions SET started_at = now() - interval '5 hours' WHERE id = $1", [s.data.session.id]);
    return { tok, up: s.data.uploadToken };
  }
  const today = async (tok) => (await G('/api/attendance/me', tok)).data.todayRec;

  const a = await startTracking('auto.a', 'Auto A');
  await t.test('arrival → checked in at the first fix inside, once', async () => {
    await upload(baseUrl, a.up, [fix(FAR, 200), fix(IN, 170), fix(IN, 168)]);
    assert.equal(await today(a.tok), null, 'not before the minimum stay');
    const batch = [fix(IN, 165), fix(IN, 160)];
    await upload(baseUrl, a.up, batch);
    const r = await today(a.tok);
    assert.equal(r.in, HM(T(170))); assert.equal(r.inAuto, true); assert.equal(r.inPlace, 'Tower A site');
    const again = await upload(baseUrl, a.up, batch);
    assert.equal(again.data.accepted, 0);
    assert.equal((await today(a.tok)).in, HM(T(170)));
    assert.equal((await P('/api/attendance/check-in', a.tok, { lat: IN.lat, lng: IN.lng, acc: 10 })).status, 400, 'no second check-in');
  });
  await t.test('a jittery outside fix does not end the stay; leaving during the shift starts a break', async () => {
    await upload(baseUrl, a.up, [fix(IN, 150), fix(FAR, 148), fix(IN, 146), fix(IN, 140)]);
    assert.equal((await today(a.tok)).onBreak, false, 'one stray fix is ignored');
    await upload(baseUrl, a.up, [fix(FAR, 120), fix(FAR, 118)]);
    const r = await today(a.tok);
    assert.equal(r.onBreak, true); assert.equal(r.breakSince, HM(T(140)), 'break from the last fix inside');
  });
  await t.test('coming back ends the break; leaving after the shift checks out at the last fix inside', async () => {
    await upload(baseUrl, a.up, [fix(IN, 100), fix(IN, 97), fix(IN, 90)]);
    let r = await today(a.tok);
    assert.equal(r.onBreak, false); assert.equal(r.breakUsedMin, 40);
    await upload(baseUrl, a.up, [fix(IN, 60), fix(IN, 38), fix(FAR, 30), fix(FAR, 28)]);
    assert.equal((await today(a.tok)).out, '', 'not before the time allowed to reach another site');
    await P('/api/attendance/auto-run', admin, {});
    r = await today(a.tok);
    assert.equal(r.out, HM(T(38))); assert.equal(r.outAuto, true);
    const month = (await G('/api/attendance/me', a.tok)).data.days.find(d => d.out);
    assert.equal(month.inHow, 'auto'); assert.equal(month.outHow, 'auto');
  });

  const w = await startTracking('auto.w', 'Auto W');
  await t.test('walking over to another of our sites is not a break', async () => {
    const STORE = at(400, 180);
    await upload(baseUrl, w.up, [fix(IN, 170), fix(IN, 160), fix(IN, 130), fix(at(250, 180), 127), fix(at(260, 180), 126), fix(STORE, 124), fix(STORE, 118), fix(STORE, 100)]);
    const r = await today(w.tok);
    assert.equal(r.in, HM(T(170))); assert.equal(r.onBreak, false); assert.equal(r.breakUsedMin, 0);
  });

  const b = await startTracking('auto.b', 'Auto B');
  await t.test('left before the shift end and never came back → checked out at the time they left', async () => {
    await upload(baseUrl, b.up, [fix(IN, 150), fix(IN, 145), fix(IN, 130), fix(FAR, 110), fix(FAR, 108)]);
    assert.equal((await today(b.tok)).onBreak, true);
    const sw = await P('/api/attendance/auto-run', admin, {});
    assert.equal(sw.status, 200); assert.ok(sw.data.closed >= 1);
    const r = await today(b.tok);
    assert.equal(r.out, HM(T(130))); assert.equal(r.outAuto, true); assert.equal(r.breakUsedMin, 0, 'the open break is not a break');
  });

  const c = await startTracking('auto.c', 'Auto C');
  await t.test('location stopped after the shift → checked out at the last fix inside', async () => {
    await upload(baseUrl, c.up, [fix(IN, 150), fix(IN, 140), fix(IN, 50)]);
    await P('/api/location/sessions/stop', c.tok, {});
    await P('/api/attendance/auto-run', admin, {});
    const r = await today(c.tok);
    assert.equal(r.in, HM(T(150))); assert.equal(r.out, HM(T(50)));
  });

  await t.test('button check-in is strict: live photo, accurate GPS inside the circle only', async () => {
    const d = await createMember(baseUrl, admin, 'auto.d', 'Auto D', 'Execution Department');
    assert.match((await P('/api/attendance/check-in', d, { lat: IN.lat, lng: IN.lng, acc: 260, photo: PHOTO })).data.error, /not accurate enough/);
    assert.equal((await P('/api/attendance/check-in', d, { lat: at(175).lat, lng: at(175).lng, acc: 40, photo: PHOTO })).status, 400, '25 m outside the circle is refused even with ±40 m GPS');
    assert.match((await P('/api/attendance/check-in', d, { lat: at(160).lat, lng: at(160).lng, acc: 170, photo: PHOTO })).data.error, /edge of the site/, 'weak GPS: the position itself must be inside');
    // Indoors (±170 m) with a live photo and the position inside the site → accepted.
    const ok = await P('/api/attendance/check-in', d, { lat: IN.lat, lng: IN.lng, acc: 170, photo: PHOTO });
    assert.equal(ok.status, 200, JSON.stringify(ok.data)); assert.equal(ok.data.place, 'Tower A site');
  });
});
