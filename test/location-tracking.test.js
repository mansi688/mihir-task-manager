const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');

// A site in Pune and helpers to make fixes around it.
const SITE = { lat: 18.5204, lng: 73.8567 };
const at = (m, bearingDeg = 0) => {
  const R = 6371008.8, b = bearingDeg * Math.PI / 180;
  return { lat: SITE.lat + (m * Math.cos(b)) / R * 180 / Math.PI, lng: SITE.lng + (m * Math.sin(b)) / (R * Math.cos(SITE.lat * Math.PI / 180)) * 180 / Math.PI };
};
let seq = 0;
const fix = (where, tMs, extra = {}) => ({ id: `p${++seq}`, t: tMs, lat: where.lat, lng: where.lng, acc: 8, spd: 0, bat: 0.8, moving: false, ...extra });

async function upload(baseUrl, uploadToken, body) {
  const res = await fetch(`${baseUrl}/api/location/points`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Location ${uploadToken}` }, body: JSON.stringify(body) });
  return { status: res.status, data: await res.json() };
}

test('employee location tracking', async (t) => {
  process.env.ENABLE_LOCATION_TRACKING = 'false';
  const { baseUrl, stop, getRawClient } = await startTestServer();
  t.after(async () => { delete process.env.ENABLE_LOCATION_TRACKING; await stop(); });
  const admin = await login(baseUrl, 'admin', 'admin123');
  const ravi = await createMember(baseUrl, admin, 'ravi', 'Ravi Kumar', 'Site');
  const asha = await createMember(baseUrl, admin, 'asha', 'Asha Shah', 'Site');
  const omar = await createMember(baseUrl, admin, 'omar', 'Omar Khan', 'Design');
  const P = (p, token, body) => api(baseUrl, p, { method: 'POST', token, body });
  const G = (p, token) => api(baseUrl, p, { token });
  const raw = await getRawClient();
  t.after(() => raw.end());

  await t.test('switched off by default: nothing is exposed', async () => {
    assert.deepEqual((await G('/api/location/me', ravi)).data, { enabled: false });
    assert.equal((await P('/api/location/sessions/start', ravi, {})).status, 404);
    assert.equal((await G('/api/location/live', admin)).status, 404);
    process.env.ENABLE_LOCATION_TRACKING = 'true';
    // Tests must not depend on the time of day they run at.
    assert.equal((await api(baseUrl, '/api/location/settings', { method: 'PUT', token: admin, body: { allowedHours: null } })).status, 200);
  });

  let sessionId, uploadToken, t0;
  await t.test('consent first: no session until the current notice is accepted', async () => {
    const me = (await G('/api/location/me', ravi)).data;
    assert.equal(me.enabled, true); assert.equal(me.consent.accepted, false);
    assert.match(me.policy.text, /ONLY while you have a work session/);
    const r = await P('/api/location/sessions/start', ravi, {});
    assert.equal(r.status, 409); assert.equal(r.data.code, 'consent_required');
    assert.equal((await P('/api/location/consent', ravi, { policyVersion: 999 })).status, 409, 'must accept the version actually shown');
    assert.equal((await P('/api/location/consent', ravi, { policyVersion: me.policy.version })).status, 200);
    assert.equal((await G('/api/location/me', ravi)).data.consent.accepted, true);
  });

  await t.test('starting a session gives a narrow upload token; starting twice resumes the same session', async () => {
    const r = await P('/api/location/sessions/start', ravi, { platform: 'android', deviceLabel: 'Redmi Note 12', appVersion: '1.5' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    sessionId = r.data.session.id; uploadToken = r.data.uploadToken;
    assert.ok(r.data.config.movingIntervalSec > 0);
    const again = await P('/api/location/sessions/start', ravi, { platform: 'android' });
    assert.equal(again.data.session.id, sessionId); assert.equal(again.data.resumed, true);
    // The upload token cannot be used as a login.
    assert.equal((await api(baseUrl, '/api/tasks/mine', { token: uploadToken })).status, 401);
  });

  await t.test('ingestion: validation, offline re-upload is idempotent, SDK format accepted', async () => {
    t0 = Date.now() - 30 * 60000;
    // The session started "now"; pretend it started 40 minutes ago so earlier fixes are inside it.
    await raw.query("UPDATE location_sessions SET started_at = now() - interval '40 minutes' WHERE id = $1", [sessionId]);
    const far = at(2000);
    const pts = [fix(far, t0), fix(at(1500), t0 + 60000, { spd: 8, moving: true })];
    const r = await upload(baseUrl, uploadToken, { points: [...pts,
      { id: 'bad1', t: t0, lat: 0, lng: 0 }, { id: 'bad2', t: t0, lat: 18.5, lng: 73.8, acc: 5000 },
      { id: 'bad3', t: Date.now() - 5 * 3600000, lat: 18.5, lng: 73.8 }, { t: t0, lat: 18.5, lng: 73.8 }] });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.accepted, 2);
    assert.deepEqual(r.data.rejected.map(x => x.reason).sort(), ['bad coordinates', 'missing id', 'outside the work session', 'too inaccurate']);
    const again = await upload(baseUrl, uploadToken, { points: pts });
    assert.equal(again.data.accepted, 0); assert.equal(again.data.duplicates, 2, 'phone re-sending after a timeout creates no duplicates');
    const sdk = await upload(baseUrl, uploadToken, { location: { uuid: 'sdk-1', timestamp: new Date(t0 + 90000).toISOString(), coords: { latitude: at(1200).lat, longitude: at(1200).lng, accuracy: 12, speed: 7 }, battery: { level: 0.79 }, is_moving: true } });
    assert.equal(sdk.data.accepted, 1);
  });

  let placeId, taskId;
  await t.test('places: arrival is confirmed only after the minimum stay; it links to open tasks in that project', async () => {
    assert.equal((await P('/api/location/places', ravi, { name: 'x', lat: 1, lng: 1 })).status, 403, 'members cannot create places');
    const pl = await P('/api/location/places', admin, { name: 'Tower B site', kind: 'site', lat: SITE.lat, lng: SITE.lng, radiusM: 150, project: 'Mihir Amara', minDwellSeconds: 300 });
    assert.equal(pl.status, 200, JSON.stringify(pl.data));
    placeId = pl.data.id;
    await P('/api/projects', admin, { name: 'Mihir Amara' });
    const task = await P('/api/tasks', admin, { title: 'Check slab shuttering', deadline: futureDate(), assignedToList: ['ravi'], project: 'Mihir Amara' });
    assert.equal(task.status, 200, JSON.stringify(task.data));
    taskId = task.data.id;
    // Drive-by first: 2 minutes inside then gone — never becomes a visit.
    let tt = t0 + 120000;
    await upload(baseUrl, uploadToken, { points: [fix(at(20), tt), fix(at(30), tt + 60000), fix(at(900), tt + 120000), fix(at(1000), tt + 150000)] });
    assert.equal((await raw.query('SELECT COUNT(*)::int c FROM geofence_visits')).rows[0].c, 0, 'a 1-minute pass is not a visit');
    // Real visit: 8 minutes inside.
    tt += 300000;
    const inside = [0, 2, 4, 6, 8].map(m => fix(at(40, m * 30), tt + m * 60000));
    await upload(baseUrl, uploadToken, { points: inside });
    const v = (await raw.query('SELECT * FROM geofence_visits')).rows;
    assert.equal(v.length, 1); assert.ok(v[0].confirmed_at); assert.equal(v[0].departed_at, null);
    const link = (await raw.query('SELECT * FROM visit_task_links')).rows;
    assert.deepEqual(link.map(l => [l.task_id, l.how]), [[taskId, 'project']]);
    const note = (await G('/api/notifications', ravi)).data.items.find(n => n.type === 'location');
    assert.match(note.message, /You're at Tower B site — 1 open task here/);
    // Uncertain GPS near the edge changes nothing; two clear outside fixes = departure.
    tt += 9 * 60000;
    await upload(baseUrl, uploadToken, { points: [fix(at(170), tt, { acc: 40 })] });
    assert.equal((await raw.query('SELECT departed_at FROM geofence_visits')).rows[0].departed_at, null);
    await upload(baseUrl, uploadToken, { points: [fix(at(800), tt + 60000), fix(at(900), tt + 120000)] });
    const done = (await raw.query('SELECT * FROM geofence_visits')).rows[0];
    assert.ok(done.departed_at); assert.equal(done.duration_s, 8 * 60);
  });

  await t.test('who can see what: Admin all, team lead own department (if allowed), members only themselves — and it is logged', async () => {
    const live = await G('/api/location/live', admin);
    assert.equal(live.status, 200);
    assert.deepEqual(live.data.people.map(p => p.username), ['ravi']);
    assert.equal(live.data.people[0].platform, 'android');
    assert.equal((await G('/api/location/live', asha)).status, 403, 'a colleague cannot see the live map');
    assert.equal((await G('/api/location/history?username=ravi', asha)).status, 403);
    assert.equal((await G('/api/location/history?username=ravi', omar)).status, 403);
    for (const u of ['asha', 'omar']) assert.equal((await P(`/api/users/${u}/team-lead`, admin, { isTeamLead: true })).status, 200);
    assert.deepEqual((await G('/api/location/live', asha)).data.people.map(p => p.username), ['ravi'], 'Site team lead sees Site');
    assert.deepEqual((await G('/api/location/live', omar)).data.people, [], 'Design team lead does not see Site');
    await api(baseUrl, '/api/location/settings', { method: 'PUT', token: admin, body: { teamLeadsCanView: false } });
    assert.equal((await G('/api/location/live', asha)).status, 403, 'policy switch takes effect');
    await api(baseUrl, '/api/location/settings', { method: 'PUT', token: admin, body: { teamLeadsCanView: true } });
    const hist = await G(`/api/location/history?username=ravi&from=${new Date(t0 - 60000).toISOString()}&to=${new Date().toISOString()}`, admin);
    assert.equal(hist.status, 200);
    assert.ok(hist.data.points.length >= 2 && hist.data.points.length <= hist.data.totalPoints);
    assert.equal(hist.data.visits.length, 1); assert.equal(hist.data.visits[0].place_name, 'Tower B site');
    assert.ok(hist.data.stats.distanceM > 1000);
    const myLog = (await G('/api/location/me/access-log', ravi)).data;
    assert.ok(myLog.some(l => l.viewer_username === 'admin' && l.action === 'history'));
    assert.ok(myLog.some(l => l.viewer_username === 'asha' && l.action === 'live_map'));
    assert.equal((await G('/api/location/me/history', ravi)).status, 200, 'own history is always visible');
  });

  await t.test('task integration: tie a task to a place; visits show on the task with history', async () => {
    const t2 = await P('/api/tasks', admin, { title: 'Collect cement from supplier', deadline: futureDate(), assignedToList: ['ravi'] });
    const sup = await P('/api/location/places', admin, { name: 'UltraTech depot', kind: 'supplier', lat: at(3000, 90).lat, lng: at(3000, 90).lng, radiusM: 100, minDwellSeconds: 0 });
    assert.equal((await P(`/api/location/tasks/${t2.data.id}/places`, ravi, { placeId: sup.data.id })).status, 403, 'only creator/Directors/Admin');
    assert.equal((await P(`/api/location/tasks/${t2.data.id}/places`, admin, { placeId: sup.data.id, purpose: 'Pick up 200 bags' })).status, 200);
    const tt = Date.now() - 4 * 60000;
    await upload(baseUrl, uploadToken, { points: [fix(at(3000, 90), tt), fix(at(3010, 90), tt + 60000)] });
    const view = await G(`/api/location/tasks/${t2.data.id}`, admin);
    assert.equal(view.data.places[0].name, 'UltraTech depot');
    assert.equal(view.data.visits.length, 1); assert.equal(view.data.visits[0].how, 'place');
    const hist = await G(`/api/tasks/${t2.data.id}/events?limit=100`, admin);
    const items = hist.data.items || hist.data.events || hist.data;
    assert.ok(JSON.stringify(items).includes('Arrived at UltraTech depot'), 'task history notes the arrival');
    assert.equal((await G(`/api/location/tasks/${t2.data.id}`, omar)).status, 403, 'someone not on the task sees nothing');
  });

  await t.test('alerts: arrival rule notifies its recipients; speeding needs two fast fixes; signal lost via monitor', async () => {
    assert.equal((await P('/api/location/alert-rules', admin, { kind: 'speeding' })).status, 400, 'speeding needs a limit');
    await P('/api/location/alert-rules', admin, { name: 'Gate', kind: 'arrive', placeId, recipients: ['asha'] });
    await P('/api/location/alert-rules', admin, { name: 'Speed', kind: 'speeding', threshold: 60, recipients: ['asha'] });
    await P('/api/location/alert-rules', admin, { name: 'Lost', kind: 'signal_lost', threshold: 15, recipients: ['asha'], notifyEmployee: true });
    await api(baseUrl, `/api/location/places/${placeId}`, { method: 'PUT', token: admin, body: { minDwellSeconds: 60 } });
    const tt = Date.now() - 150000;
    await upload(baseUrl, uploadToken, { points: [fix(at(10), tt), fix(at(15), tt + 20000)] }); // 20 s < 60 s minimum stay → not yet
    assert.equal((await G('/api/notifications', asha)).data.items.filter(n => n.type === 'location_alert').length, 0);
    await upload(baseUrl, uploadToken, { points: [fix(at(12), tt + 70000)] });
    const ashaNotes = async () => (await G('/api/notifications', asha)).data.items.filter(n => n.type === 'location_alert').map(n => n.message);
    assert.ok((await ashaNotes()).some(m => /Ravi Kumar arrived at Tower B site/.test(m)), JSON.stringify(await ashaNotes()));
    const before = (await ashaNotes()).length;
    await upload(baseUrl, uploadToken, { points: [fix(at(2000), Date.now() - 50000, { spd: 25 }), fix(at(2500), Date.now() - 40000, { spd: 10 })] });
    assert.equal((await ashaNotes()).length, before, 'one fast fix is GPS noise');
    await upload(baseUrl, uploadToken, { points: [fix(at(3000), Date.now() - 30000, { spd: 25 }), fix(at(3500), Date.now() - 20000, { spd: 24 })] });
    assert.ok((await ashaNotes()).some(m => /travelling at 86 km\/h/.test(m)));
    await raw.query("UPDATE location_sessions SET last_received_at = now() - interval '30 minutes' WHERE id = $1", [sessionId]);
    const app = require('../backend/server');
    await app.jobs.enqueue('LOCATION_MONITOR', {}, { key: `test-monitor-${Date.now()}` });
    await app.jobs.tick();
    assert.ok((await ashaNotes()).some(m => /no location received for 30 min/.test(m)));
    assert.ok((await G('/api/notifications', ravi)).data.items.some(n => /no location received/.test(n.message)), 'the employee is told too');
    const events = (await G('/api/location/alerts', admin)).data;
    assert.ok(events.length >= 3);
    assert.equal((await P(`/api/location/alerts/${events[0].id}/ack`, admin)).status, 200);
  });

  await t.test('stopping ends collection: later points are refused, earlier offline points are still accepted', async () => {
    assert.equal((await P('/api/location/sessions/stop', ravi)).status, 200);
    const late = await upload(baseUrl, uploadToken, { points: [fix(at(50), Date.now() + 60000 * 5)] });
    assert.equal(late.status, 409); assert.equal(late.data.sessionActive, false);
    const offline = await upload(baseUrl, uploadToken, { points: [fix(at(60), Date.now() - 60000)] });
    assert.equal(offline.data.accepted, 1, 'recorded before stop, uploaded after reconnecting');
    assert.deepEqual((await G('/api/location/live', admin)).data.people, []);
  });

  await t.test('the phone notification "Stop" ends the session with only the upload token', async () => {
    const r = await P('/api/location/sessions/start', ravi, { platform: 'android' });
    const stopRes = await fetch(`${baseUrl}/api/location/sessions/stop-upload`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Location ${r.data.uploadToken}` }, body: '{}' });
    assert.equal(stopRes.status, 200);
    assert.equal((await G('/api/location/me', ravi)).data.activeSession, null);
    assert.equal((await fetch(`${baseUrl}/api/location/sessions/stop-upload`, { method: 'POST', headers: { Authorization: 'Location nonsense' } })).status, 401);
  });

  await t.test('changing the notice requires everyone to accept it again; withdrawing stops tracking', async () => {
    const s = await api(baseUrl, '/api/location/settings', { method: 'PUT', token: admin, body: { policyText: 'New notice: we record location only during work sessions you start yourself, for site coordination.' } });
    assert.equal(s.data.policyVersion, 2);
    assert.equal((await P('/api/location/sessions/start', ravi, {})).status, 409);
    await P('/api/location/consent', ravi, { policyVersion: 2 });
    assert.equal((await P('/api/location/sessions/start', ravi, {})).status, 200);
    await P('/api/location/consent/withdraw', ravi);
    assert.equal((await G('/api/location/me', ravi)).data.activeSession, null);
    assert.equal((await api(baseUrl, '/api/location/settings', { method: 'PUT', token: asha, body: { maxSessionHours: 2 } })).status, 403);
    assert.equal((await api(baseUrl, '/api/location/settings', { method: 'PUT', token: admin, body: { maxSessionHours: 99 } })).status, 400);
  });

  await t.test('sessions stop automatically after the maximum length', async () => {
    await P('/api/location/consent', asha, { policyVersion: 2 });
    const r = await P('/api/location/sessions/start', asha, { platform: 'web' });
    await raw.query("UPDATE location_sessions SET started_at = now() - interval '15 hours' WHERE id = $1", [r.data.session.id]);
    const app = require('../backend/server');
    await app.jobs.enqueue('LOCATION_MONITOR', {}, { key: `test-monitor2-${Date.now()}` });
    await app.jobs.tick();
    assert.equal((await G('/api/location/me', asha)).data.activeSession, null);
    assert.ok((await G('/api/notifications', asha)).data.items.some(n => /stopped automatically after 14 hours/.test(n.message)));
  });

  await t.test('reports, export, retention and deletion', async () => {
    const rep = await G(`/api/location/reports/summary?from=${new Date(Date.now() - 86400000).toISOString()}&to=${new Date(Date.now() + 60000).toISOString()}`, admin);
    assert.equal(rep.status, 200);
    const r = rep.data.byPerson.find(p => p.username === 'ravi');
    assert.ok(r.visits >= 2 && r.distanceKm > 1);
    assert.ok(rep.data.byPlace.some(p => p.name === 'Tower B site'));
    const csv = await fetch(`${baseUrl}/api/location/reports/summary?format=csv&from=${new Date(Date.now() - 86400000).toISOString()}`, { headers: { Authorization: `Bearer ${admin}` } });
    assert.match(await csv.text(), /Employee,Username,Department/);
    assert.equal((await G('/api/location/reports/summary', ravi)).status, 403);
    const mine = (await G('/api/location/me/export', ravi)).data;
    assert.ok(mine.points.length >= 10 && mine.consents.length >= 2 && mine.accessLog.length >= 1);
    // Retention: back-date some points beyond the 90-day window.
    await raw.query("UPDATE location_points SET recorded_at = now() - interval '100 days' WHERE client_point_id IN ('p1','p2')");
    const app = require('../backend/server');
    await app.jobs.enqueue('LOCATION_RETENTION', {}, { key: `test-ret-${Date.now()}` });
    await app.jobs.tick();
    assert.equal((await raw.query("SELECT COUNT(*)::int c FROM location_points WHERE client_point_id IN ('p1','p2')")).rows[0].c, 0);
    assert.equal((await api(baseUrl, '/api/location/data/ravi', { method: 'DELETE', token: asha })).status, 403);
    const del = await api(baseUrl, '/api/location/data/ravi', { method: 'DELETE', token: admin });
    assert.equal(del.status, 200); assert.ok(del.data.deleted.points > 0 || del.data.deleted.sessions > 0);
    assert.equal((await raw.query("SELECT COUNT(*)::int c FROM location_points WHERE username = 'ravi'")).rows[0].c, 0);
    const audit = (await raw.query("SELECT action FROM audit_log WHERE action LIKE 'location_%'")).rows.map(r2 => r2.action);
    for (const a of ['location_consent_accepted', 'location_session_started', 'location_place_created', 'location_policy_updated', 'location_data_deleted']) assert.ok(audit.includes(a), `audit has ${a}`);
  });

  await t.test('indoor: BLE sightings give a zone; UWB pushes need a key and an active session; restricted zones alert', async () => {
    await api(baseUrl, '/api/location/settings', { method: 'PUT', token: admin, body: { indoorEnabled: true } });
    const floor = await P('/api/location/indoor/floors', admin, { name: 'HQ 2nd floor', level: 2, planImage: 'data:image/png;base64,iVBORw0KGgo=', widthPx: 1000, heightPx: 600, metersPerPx: 0.05 });
    assert.equal(floor.status, 200, JSON.stringify(floor.data));
    const fid = floor.data.id;
    await P(`/api/location/indoor/floors/${fid}/zones`, admin, { name: 'Design studio', kind: 'room', polygon: [[0, 0], [500, 0], [500, 600], [0, 600]] });
    await P(`/api/location/indoor/floors/${fid}/zones`, admin, { name: 'Server room', kind: 'restricted', polygon: [[600, 0], [1000, 0], [1000, 300], [600, 300]] });
    const U = 'f7826da6-4fa2-4e98-8024-bc5b71e0893e';
    assert.equal((await P(`/api/location/indoor/floors/${fid}/anchors`, admin, { identifier: 'nope', x: 1, y: 1 })).status, 400);
    for (const [minor, x, y] of [[1, 100, 100], [2, 400, 100], [3, 250, 500], [4, 800, 150]]) {
      assert.equal((await P(`/api/location/indoor/floors/${fid}/anchors`, admin, { identifier: `${U}:1:${minor}`, x, y, label: `B${minor}` })).status, 200);
    }
    await P('/api/location/consent', omar, { policyVersion: 2 });
    const s = await P('/api/location/sessions/start', omar, { platform: 'android' });
    const me = await G('/api/location/me', omar);
    assert.deepEqual(me.data.config.indoor.uuids, [U], 'the phone is told which beacon UUIDs to scan for');
    const sight = await fetch(`${baseUrl}/api/location/indoor/sightings`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Location ${s.data.uploadToken}` },
      body: JSON.stringify({ t: Date.now(), beacons: [{ id: `${U}:1:1`, rssi: -58 }, { id: `${U}:1:2`, rssi: -75 }, { id: `${U}:1:3`, rssi: -80 }] }) }).then(r => r.json());
    assert.equal(sight.stored, true); assert.equal(sight.method, 'ble_weighted'); assert.equal(sight.zone.name, 'Design studio');
    // UWB vendor push.
    const key = await P('/api/location/integration-keys', admin, { name: 'Pozyx HQ' });
    assert.match(key.data.key, /^mtk_loc_/);
    await P('/api/location/indoor/tags', admin, { tagId: 'uwb-77', username: 'omar' });
    await P('/api/location/indoor/tags', admin, { tagId: 'uwb-78', username: 'asha' }); // asha has no active session
    await P('/api/location/alert-rules', admin, { name: 'Server room', kind: 'restricted_entry', recipients: ['admin'] });
    const push = (k, body) => fetch(`${baseUrl}/api/location/indoor/rtls`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Location-Key': k }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, data: await r.json() }));
    assert.equal((await push('wrong', { positions: [] })).status, 401);
    const out = await push(key.data.key, { positions: [{ tag: 'uwb-77', floorId: fid, x: 700, y: 100, accuracyM: 0.3 }, { tag: 'uwb-78', floorId: fid, x: 10, y: 10 }, { tag: 'unknown', floorId: fid, x: 1, y: 1 }] });
    assert.deepEqual(out.data, { stored: 1, ignoredNoSession: 1, unknownTag: 1, invalid: 0 }, 'no session = not tracked, even with a badge');
    assert.ok((await G('/api/notifications', admin)).data.items.some(n => /restricted zone "Server room"/.test(n.message)));
    const liveIndoor = (await G(`/api/location/indoor/live?floorId=${fid}`, admin)).data;
    assert.equal(liveIndoor[0].zone_name, 'Server room'); assert.equal(liveIndoor[0].method, 'uwb');
    const live = (await G('/api/location/live', admin)).data.people.find(p => p.username === 'omar');
    assert.equal(live.indoor.zone, 'Server room');
    await api(baseUrl, `/api/location/integration-keys/${key.data.id}`, { method: 'DELETE', token: admin });
    assert.equal((await push(key.data.key, { positions: [] })).status, 401, 'revoked keys stop working');
  });
});
