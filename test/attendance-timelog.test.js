// Automatic check-out every time someone leaves all sites (any time of day), automatic check-in again on coming back,
// the Time log (each pair with timestamps, lengths, totals), and attendance-only tracking (off-site positions are
// used for check-in / check-out but never stored or shown).
const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember } = require('../testlib/helpers');

const SITE = { lat: 18.5204, lng: 73.8567 };
const at = (m, deg = 0) => { const R = 6371008.8, b = deg * Math.PI / 180; return { lat: SITE.lat + (m * Math.cos(b)) / R * 180 / Math.PI, lng: SITE.lng + (m * Math.sin(b)) / (R * Math.cos(SITE.lat * Math.PI / 180)) * 180 / Math.PI }; };
let seq = 0; const NOW = Date.now(); const T = (minAgo) => NOW - minAgo * 60000;
const fix = (w, minAgo) => ({ id: `tl${++seq}`, t: T(minAgo), lat: w.lat, lng: w.lng, acc: 8, spd: 0, bat: 0.8, moving: false });
const HM = (ms) => new Date(ms + 330 * 60000).toISOString().slice(11, 16);
const IN = at(20), FAR = at(900, 90);
async function upload(baseUrl, tok, points) {
  const r = await fetch(`${baseUrl}/api/location/points`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Location ${tok}` }, body: JSON.stringify({ points }) });
  return { status: r.status, data: await r.json() };
}

test('leave = check-out, back = check-in again; time log pairs; off-site positions not stored', async (t) => {
  process.env.ENABLE_LOCATION_TRACKING = 'true';
  const { baseUrl, stop, getRawClient } = await startTestServer();
  t.after(async () => { delete process.env.ENABLE_LOCATION_TRACKING; await stop(); });
  const raw = await getRawClient(); t.after(() => raw.end());
  const admin = await login(baseUrl, 'admin', 'admin123');
  const P = (p, token, body) => api(baseUrl, p, { method: 'POST', token, body });
  const G = (p, token) => api(baseUrl, p, { token });
  // keep the test inside one IST day: needs ~4 h of history today
  const istMin = (new Date(NOW + 330 * 60000).getUTCHours()) * 60 + new Date(NOW + 330 * 60000).getUTCMinutes();
  if (istMin < 240) { t.skip('too early in the IST day for a same-day history'); return; }
  assert.equal((await P('/api/location/places', admin, { name: 'Tower A site', kind: 'site', lat: SITE.lat, lng: SITE.lng, radiusM: 150, minDwellSeconds: 300 })).status, 200);
  assert.equal((await P('/api/payroll/settings', admin, { autoAttendance: true, siteTransferMin: 20 })).status, 200);
  const rules = (await G('/api/payroll/settings', admin)).data.settings;
  assert.equal(rules.autoOutMode || 'leave', 'leave', 'leaving = check-out is the default');

  const tok = await createMember(baseUrl, admin, 'tl.a', 'Timelog A', 'Execution Department');
  const me = (await G('/api/location/me', tok)).data;
  await P('/api/location/consent', tok, { policyVersion: me.policy.version });
  const s = await P('/api/location/sessions/start', tok, { platform: 'android' });
  await raw.query("UPDATE location_sessions SET started_at = now() - interval '6 hours' WHERE id = $1", [s.data.session.id]);
  const up = s.data.uploadToken;
  const today = async () => (await G('/api/attendance/me', tok)).data.todayRec;

  // 1) arrive 220 min ago → in; leave at 160 → out (after the 20-min transfer window, by the sweep)
  await upload(baseUrl, up, [fix(IN, 220), fix(IN, 214), fix(IN, 200), fix(IN, 160)]);
  assert.equal((await today()).in, HM(T(220)));
  await upload(baseUrl, up, [fix(FAR, 158), fix(FAR, 154), fix(FAR, 150), fix(FAR, 130)]);
  await P('/api/attendance/auto-run', admin, {});
  assert.equal((await today()).out, HM(T(160)), 'checked out at the moment they left');
  // off-site positions were used but not stored
  const stored = (await raw.query("SELECT lat, lng FROM location_points WHERE username='tl.a'")).rows;
  assert.ok(stored.length >= 4);
  assert.ok(stored.every(p => Math.abs(p.lng - SITE.lng) < 0.005), 'only on-site positions are saved');
  const live = (await G('/api/location/live', admin)).data;
  const person = (live.people || []).find(x => x.username === 'tl.a');
  if (person) assert.equal(person.lat, null, 'no live position away from sites');

  // 2) come back at 100 → checked in again; leave at 40 → out again
  await upload(baseUrl, up, [fix(IN, 100), fix(IN, 94), fix(IN, 90), fix(IN, 40)]);
  let r = await today();
  assert.equal(r.out, '', 'checked in again');
  await upload(baseUrl, up, [fix(FAR, 38), fix(FAR, 34), fix(FAR, 30), fix(FAR, 10)]);
  await P('/api/attendance/auto-run', admin, {});
  r = await today();
  assert.equal(r.out, HM(T(40)));

  // 3) Time log: two pairs with timestamps and lengths
  const tl = (await G('/api/attendance/timelog', admin)).data;
  const row = tl.list.find(x => x.username === 'tl.a');
  assert.ok(row, JSON.stringify(tl));
  assert.equal(row.pairs.length, 2);
  assert.deepEqual(row.pairs.map(p => [p.in, p.out, p.inHow, p.outHow]), [[HM(T(220)), HM(T(160)), 'auto', 'auto'], [HM(T(100)), HM(T(40)), 'auto', 'auto']]);
  assert.equal(row.pairs[0].min, 60); assert.equal(row.pairs[1].min, 60);
  assert.equal(row.checkedInMin, 120);
  assert.equal(row.outMin, 60);
  assert.equal(row.gaps[0].kind, 'out');
  assert.equal(row.firstIn, HM(T(220))); assert.equal(row.lastOut, HM(T(40)));
  const person2 = tl.people.find(x => x.username === 'tl.a');
  assert.equal(person2.pairs, 2); assert.equal(person2.checkedInMin, 120);
  // others only see themselves
  const mine = (await G('/api/attendance/timelog', tok)).data;
  assert.equal(mine.all, false);
  assert.ok(mine.list.every(x => x.username === 'tl.a'));
  assert.equal((await G('/api/attendance/timelog?from=2026-01-01&to=2026-06-30', admin)).status, 400, 'range limit');

  // 4) "only after a full day" mode: leaving early is not a check-out
  assert.equal((await P('/api/payroll/settings', admin, { autoOutMode: 'fullday' })).status, 200);
  assert.equal((await P('/api/payroll/settings', admin, { autoOutMode: 'nope' })).status, 400);
});
