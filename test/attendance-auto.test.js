// Automatic check-in / check-out from location tracking (backend/payroll.js → Places engine hooks).
//   · leaving a site is NOT a break and NOT a check-out (other sites, head office, shops are work)
//   · 8 hours worked + left every site (and not at another within siteTransferMin) → session complete, checked out
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
const IN = at(20), FAR = at(900, 90), STORE = at(400, 180);

async function upload(baseUrl, tok, points) {
  const r = await fetch(`${baseUrl}/api/location/points`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Location ${tok}` }, body: JSON.stringify({ points }) });
  return { status: r.status, data: await r.json() };
}

test('automatic check-in / out from location tracking', async (t) => {
  process.env.ENABLE_LOCATION_TRACKING = 'true';
  const { baseUrl, stop, getRawClient } = await startTestServer();
  t.after(async () => { delete process.env.ENABLE_LOCATION_TRACKING; await stop(); });
  const raw = await getRawClient(); t.after(() => raw.end());
  const admin = await login(baseUrl, 'admin', 'admin123');
  const P = (p, token, body) => api(baseUrl, p, { method: 'POST', token, body });
  const G = (p, token) => api(baseUrl, p, { token });
  assert.equal((await P('/api/location/places', admin, { name: 'Tower A site', kind: 'site', lat: SITE.lat, lng: SITE.lng, radiusM: 150, minDwellSeconds: 300 })).status, 200);
  // The site across the road (e.g. Amara ↔ WBB): people walk over for material.
  assert.equal((await P('/api/location/places', admin, { name: 'Store site', kind: 'site', lat: STORE.lat, lng: STORE.lng, radiusM: 120, minDwellSeconds: 300 })).status, 200);
  assert.equal((await P('/api/payroll/settings', admin, { autoAttendance: true, fullDayHours: 8, siteTransferMin: 20, autoOutMode: 'fullday' })).status, 200);

  async function startTracking(username, name) {
    const tok = await createMember(baseUrl, admin, username, name, 'Execution Department');
    const me = (await G('/api/location/me', tok)).data;
    await P('/api/location/consent', tok, { policyVersion: me.policy.version });
    const s = await P('/api/location/sessions/start', tok, { platform: 'android' });
    assert.equal(s.status, 200, JSON.stringify(s.data));
    await raw.query("UPDATE location_sessions SET started_at = now() - interval '12 hours' WHERE id = $1", [s.data.session.id]);
    return { tok, up: s.data.uploadToken };
  }
  const today = async (tok) => (await G('/api/attendance/me', tok)).data.todayRec;
  const sweep = async () => { const r = await P('/api/attendance/auto-run', admin, {}); assert.equal(r.status, 200); return r.data; };

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
    assert.match((await P('/api/attendance/check-in', a.tok, { lat: IN.lat, lng: IN.lng, acc: 10, photo: PHOTO })).data.error, /already checked in/, 'no second check-in');
  });
  await t.test('leaving a site is not a break and not a check-out; a stray fix changes nothing', async () => {
    await upload(baseUrl, a.up, [fix(IN, 150), fix(FAR, 148), fix(IN, 146), fix(IN, 140)]);
    await upload(baseUrl, a.up, [fix(FAR, 120), fix(FAR, 116), fix(FAR, 112)]);
    const visit = (await raw.query("SELECT end_reason FROM geofence_visits WHERE username='auto.a' ORDER BY id DESC LIMIT 1")).rows[0];
    assert.equal(visit.end_reason, 'left', 'the departure itself is recorded');
    const r = await today(a.tok);
    assert.equal(r.onBreak, false, 'no automatic break'); assert.equal(r.out, '', 'still checked in');
    await sweep();
    assert.equal((await today(a.tok)).out, '', 'only ~1 h worked, so leaving the site does not end the day');
    // coming back later: still one session, one check-in
    await upload(baseUrl, a.up, [fix(IN, 90), fix(IN, 85), fix(IN, 80)]);
    const back = await today(a.tok);
    assert.equal(back.in, HM(T(170))); assert.equal(back.out, '');
  });

  const f = await startTracking('auto.f', 'Auto F');
  await t.test('8 hours worked and then out of every site → the session is complete, checked out when they left', async () => {
    await upload(baseUrl, f.up, [fix(IN, 560), fix(IN, 555), fix(IN, 550), fix(IN, 300), fix(IN, 40)]);
    assert.equal((await today(f.tok)).in, HM(T(560)));
    await upload(baseUrl, f.up, [fix(FAR, 36), fix(FAR, 32), fix(FAR, 28)]);
    assert.equal((await today(f.tok)).out, '', 'not at the moment of leaving — they may be walking to another site');
    await sweep();
    const r = await today(f.tok);
    assert.equal(r.out, HM(T(40))); assert.equal(r.outAuto, true);
    const day = (await G('/api/attendance/me', f.tok)).data.days.find(d => d.in);
    assert.equal(day.status, 'P'); assert.equal(day.outHow, 'auto');
  });

  const g = await startTracking('auto.g', 'Auto G');
  await t.test('left the site after 5 hours → NOT checked out (other sites, head office, material)', async () => {
    await upload(baseUrl, g.up, [fix(IN, 300), fix(IN, 295), fix(IN, 290), fix(IN, 60)]);
    await upload(baseUrl, g.up, [fix(FAR, 56), fix(FAR, 52), fix(FAR, 48)]);
    await sweep();
    const r = await today(g.tok);
    assert.equal(r.in, HM(T(300))); assert.equal(r.out, ''); assert.equal(r.onBreak, false);
  });

  const h = await startTracking('auto.h', 'Auto H');
  await t.test('after 8 hours, walking over to another of our sites does not check them out', async () => {
    await upload(baseUrl, h.up, [fix(IN, 560), fix(IN, 555), fix(IN, 550), fix(IN, 50)]);
    await upload(baseUrl, h.up, [fix(at(250, 180), 46), fix(at(260, 180), 43), fix(at(270, 180), 40), fix(STORE, 37), fix(STORE, 31)]);
    const dep = (await raw.query("SELECT end_reason FROM geofence_visits WHERE username='auto.h' AND geofence_id = (SELECT id FROM geofences WHERE name='Tower A site')")).rows[0];
    assert.equal(dep.end_reason, 'left');
    await sweep();
    const r = await today(h.tok);
    assert.equal(r.in, HM(T(560))); assert.equal(r.out, '', 'inside the other site now');
  });

  await t.test('GPS jumps are ignored: a "teleporting" fix neither leaves nor arrives', async () => {
    const j = await startTracking('auto.j', 'Auto J');
    await upload(baseUrl, j.up, [fix(IN, 100), fix(IN, 96), fix(IN, 92)]);
    assert.equal((await today(j.tok)).in, HM(T(100)));
    // 3 "fixes" 40 km away within seconds, then back at the site
    const far = at(40000, 45);
    await upload(baseUrl, j.up, [{ ...fix(far, 90) }, { ...fix(far, 89.9) }, fix(IN, 88)]);
    const v = (await raw.query("SELECT end_reason, outside_streak FROM geofence_visits WHERE username='auto.j'")).rows;
    assert.equal(v.length, 1); assert.equal(v[0].end_reason, null, 'still on site');
  });
});
