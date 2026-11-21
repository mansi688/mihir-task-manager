const test = require('node:test');
const assert = require('node:assert/strict');
const geo = require('../backend/location/geo');

// Pune-area reference point.
const P = { lat: 18.5204, lng: 73.8567 };
const offset = (m, bearingDeg = 0) => {
  const R = 6371008.8, b = bearingDeg * Math.PI / 180;
  return { lat: P.lat + (m * Math.cos(b)) / R * 180 / Math.PI, lng: P.lng + (m * Math.sin(b)) / (R * Math.cos(P.lat * Math.PI / 180)) * 180 / Math.PI };
};

test('distance is accurate at site scale', () => {
  const q = offset(500, 90);
  const d = geo.distanceM(P.lat, P.lng, q.lat, q.lng);
  assert.ok(Math.abs(d - 500) < 0.5, `got ${d}`);
});

test('coordinate validation rejects junk and the 0,0 null island', () => {
  assert.equal(geo.validLatLng(18.5, 73.8), true);
  assert.equal(geo.validLatLng(0, 0), false);
  assert.equal(geo.validLatLng(91, 10), false);
  assert.equal(geo.validLatLng(NaN, 10), false);
});

test('circle place: inside / outside / uncertain band uses GPS accuracy', () => {
  const g = { shape: 'circle', center_lat: P.lat, center_lng: P.lng, radius_m: 100 };
  const near = offset(50), edge = offset(120), far = offset(400);
  assert.equal(geo.classifyAgainstGeofence(g, near.lat, near.lng, 10), 'inside');
  assert.equal(geo.classifyAgainstGeofence(g, edge.lat, edge.lng, 30), 'uncertain', '20 m outside with a 30 m fix is not proof of leaving');
  assert.equal(geo.classifyAgainstGeofence(g, edge.lat, edge.lng, 0, 5), 'outside');
  assert.equal(geo.classifyAgainstGeofence(g, far.lat, far.lng, 50), 'outside');
});

test('polygon place: point in polygon and distance to the edge', () => {
  const sq = [offset(100, 0), offset(100, 90), offset(100, 180), offset(100, 270)].map(p => [p.lat, p.lng]); // a diamond
  const g = { shape: 'polygon', polygon: sq };
  assert.equal(geo.classifyAgainstGeofence(g, P.lat, P.lng, 10), 'inside');
  const out = offset(300, 45);
  assert.equal(geo.classifyAgainstGeofence(g, out.lat, out.lng, 10), 'outside');
  const d = geo.distanceToPolygonM(out.lat, out.lng, sq);
  assert.ok(d > 200 && d < 260, `edge distance ${d}`);
});

test('route simplification keeps the shape and drops straight-line noise', () => {
  const pts = [];
  for (let i = 0; i <= 100; i++) { const p = offset(i * 10, 90); pts.push({ ...p, recorded_at: new Date(i * 10000) }); }
  const corner = offset(1000, 90);
  for (let i = 1; i <= 50; i++) pts.push({ lat: corner.lat + (i * 10) / 111195, lng: corner.lng, recorded_at: new Date((100 + i) * 10000) });
  const s = geo.simplifyRoute(pts, 5);
  assert.ok(s.length <= 5, `kept ${s.length}`);
  assert.equal(s[0], pts[0]); assert.equal(s[s.length - 1], pts[pts.length - 1]);
  const total = geo.routeDistanceM(pts);
  assert.ok(Math.abs(total - 1500) < 5, `distance ${total}`);
});

test('route distance ignores impossible GPS jumps', () => {
  const a = { ...P, recorded_at: new Date(0) };
  const jump = { ...offset(5000, 0), recorded_at: new Date(5000) }; // 5 km in 5 s
  const b = { ...offset(20, 90), recorded_at: new Date(10000) };
  assert.ok(geo.routeDistanceM([a, jump, b]) < 5100);
  assert.ok(geo.routeDistanceM([a, b]) > 19);
});

test('BLE: nearest beacon with 1–2 beacons, weighted centroid with 3+', () => {
  const anchors = new Map([
    ['b1', { x: 0, y: 0, floor_id: 1, tx_power: -59 }],
    ['b2', { x: 100, y: 0, floor_id: 1 }],
    ['b3', { x: 0, y: 100, floor_id: 1 }],
    ['other', { x: 50, y: 50, floor_id: 2 }],
  ]);
  const one = geo.estimateBlePosition([{ identifier: 'b1', rssi: -60 }, { identifier: 'unknown', rssi: -40 }], anchors);
  assert.equal(one.method, 'ble_nearest'); assert.equal(one.x, 0); assert.equal(one.floorId, 1);
  const three = geo.estimateBlePosition([{ identifier: 'b1', rssi: -55 }, { identifier: 'b2', rssi: -80 }, { identifier: 'b3', rssi: -80 }], anchors, { metersPerPx: 0.05 });
  assert.equal(three.method, 'ble_weighted');
  assert.ok(three.x < 20 && three.y < 20, 'pulled strongly toward the loudest beacon');
  assert.equal(geo.estimateBlePosition([{ identifier: 'b1', rssi: -120 }], anchors), null, 'too weak to use');
  assert.equal(geo.pointInPixelPolygon(5, 5, [[0, 0], [10, 0], [10, 10], [0, 10]]), true);
  assert.equal(geo.pointInPixelPolygon(15, 5, [[0, 0], [10, 0], [10, 10], [0, 10]]), false);
});

test('cleanTrack: standing-still jitter and spikes are removed, real walks and drives are kept', () => {
  const geo = require('../backend/location/geo');
  const base = { lat: 18.5204, lng: 73.8567 };
  const off = (m, b = 0) => ({ lat: base.lat + m * Math.cos(b) / 111320, lng: base.lng + m * Math.sin(b) / (111320 * Math.cos(base.lat * Math.PI / 180)) });
  let t = Date.parse('2026-11-21T04:00:00Z');
  const P = (o, acc = 15) => ({ ...o, accuracy_m: acc, speed_mps: null, recorded_at: new Date(t += 30000).toISOString() });
  const site = [P(off(0)), P(off(10, 1)), P(off(250, 2)), P(off(5, 3)), P(off(300, 4)), P(off(280, 4.1)), P(off(8, 5)), P(off(12, 6)), P(off(200, 1)), P(off(3, 2))];
  assert.ok(geo.routeDistanceM(site) > 1000);
  assert.equal(Math.round(geo.routeDistanceM(geo.cleanTrack(site))), 0, 'on site all day = 0 km');
  const walk = []; for (let i = 0; i < 20; i++) walk.push(P(off(i * 36, 0.5), 10));
  assert.equal(Math.round(geo.routeDistanceM(geo.cleanTrack(walk))), Math.round(geo.routeDistanceM(walk)));
  const drive = []; for (let i = 0; i < 20; i++) drive.push(P(off(i * 300, 1.2), 10));
  assert.equal(Math.round(geo.routeDistanceM(geo.cleanTrack(drive))), Math.round(geo.routeDistanceM(drive)));
  const go = [P(off(0)), P(off(5)), P(off(400, 1)), P(off(405, 1)), P(off(398, 1)), P(off(402, 1))];
  assert.ok(Math.abs(geo.routeDistanceM(geo.cleanTrack(go)) - 400) < 15, 'moved and stayed = kept');
});
