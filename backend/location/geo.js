// Pure geometry helpers for location tracking — no database, no I/O, fully unit-tested
// (test/location-geo.test.js). Coordinates are WGS84 degrees; distances are metres.

const EARTH_R = 6371008.8; // mean Earth radius (m)
const toRad = (d) => (d * Math.PI) / 180;

function distanceM(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function validLatLng(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 && !(lat === 0 && lng === 0);
}

// Ray casting on a small area (fine for site-sized polygons). polygon = [[lat, lng], ...]
function pointInPolygon(lat, lng, polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [yi, xi] = polygon[i];
    const [yj, xj] = polygon[j];
    if (((yi > lat) !== (yj > lat)) && (lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

// Shortest distance (m) from a point to a polygon's edges (0 if inside). Uses a local flat
// projection around the point — accurate to well under a metre at site scale.
function distanceToPolygonM(lat, lng, polygon) {
  if (pointInPolygon(lat, lng, polygon)) return 0;
  const kx = Math.cos(toRad(lat)) * (Math.PI / 180) * EARTH_R;
  const ky = (Math.PI / 180) * EARTH_R;
  const P = polygon.map(([a, b]) => [(b - lng) * kx, (a - lat) * ky]);
  let best = Infinity;
  for (let i = 0; i < P.length; i++) {
    const [x1, y1] = P[i];
    const [x2, y2] = P[(i + 1) % P.length];
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? -(x1 * dx + y1 * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(x1 + t * dx, y1 + t * dy));
  }
  return best;
}

// How far outside the place the point is (≤ 0 = inside). For a circle: distance − radius.
function geofenceDistanceM(g, lat, lng) {
  if (g.shape === 'polygon' && Array.isArray(g.polygon) && g.polygon.length >= 3) {
    return pointInPolygon(lat, lng, g.polygon) ? -1 : distanceToPolygonM(lat, lng, g.polygon);
  }
  return distanceM(g.center_lat, g.center_lng, lat, lng) - Number(g.radius_m || 0);
}

// Inside/outside decision with GPS uncertainty and hysteresis:
//  - counts as INSIDE only if the fix is inside the place (a poor fix near the edge is not proof);
//  - counts as clearly OUTSIDE only if it's beyond the edge by more than the fix's accuracy plus a
//    margin (so GPS jitter at the boundary doesn't produce fake departures);
//  - anything in between is 'uncertain' and changes nothing.
function classifyAgainstGeofence(g, lat, lng, accuracyM, marginM = 25) {
  const d = geofenceDistanceM(g, lat, lng);
  const acc = Math.max(0, Number(accuracyM) || 0);
  if (d <= 0) return 'inside';
  if (d > acc + marginM) return 'outside';
  return 'uncertain';
}

// Douglas–Peucker route simplification for display (keeps first/last; tolerance in metres).
function simplifyRoute(points, toleranceM = 8) {
  if (!Array.isArray(points) || points.length <= 2) return points || [];
  const lat0 = points[0].lat;
  const kx = Math.cos(toRad(lat0)) * (Math.PI / 180) * EARTH_R;
  const ky = (Math.PI / 180) * EARTH_R;
  const xy = points.map(p => [p.lng * kx, p.lat * ky]);
  const keep = new Uint8Array(points.length);
  keep[0] = 1; keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = -1, idx = -1;
    const [ax, ay] = xy[a], [bx, by] = xy[b];
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy);
    for (let i = a + 1; i < b; i++) {
      const [px, py] = xy[i];
      const d = len ? Math.abs(dy * px - dx * py + bx * ay - by * ax) / len : Math.hypot(px - ax, py - ay);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > toleranceM && idx > 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return points.filter((_, i) => keep[i]);
}

// Total path length, skipping jumps that are physically implausible (GPS glitches).
function routeDistanceM(points, maxSpeedMps = 70) {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const d = distanceM(a.lat, a.lng, b.lat, b.lng);
    const dt = (new Date(b.recorded_at || b.t) - new Date(a.recorded_at || a.t)) / 1000;
    if (dt > 0 && d / dt > maxSpeedMps) continue;
    total += d;
  }
  return total;
}

// ---- Indoor (floor-plan pixel coordinates) ----
function pointInPixelPolygon(x, y, polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

// BLE positioning from beacon sightings. Honest about precision:
//  - 1–2 usable beacons → "nearest beacon" (room/zone level);
//  - ≥3 → RSSI-weighted centroid of the strongest beacons (typically 2–5 m — still not desk-exact).
// sightings: [{ identifier, rssi }], anchors: Map identifier -> { x, y, floor_id, tx_power }
function estimateBlePosition(sightings, anchors, { metersPerPx = null, minRssi = -95 } = {}) {
  const usable = (sightings || [])
    .map(s => ({ ...s, rssi: Number(s.rssi), anchor: anchors.get(String(s.identifier || '').toLowerCase()) }))
    .filter(s => s.anchor && Number.isFinite(s.rssi) && s.rssi >= minRssi && s.rssi < 0)
    .sort((a, b) => b.rssi - a.rssi);
  if (!usable.length) return null;
  // All on the strongest beacon's floor.
  const floorId = usable[0].anchor.floor_id;
  const same = usable.filter(s => String(s.anchor.floor_id) === String(floorId)).slice(0, 4);
  if (same.length < 3) {
    const a = same[0].anchor;
    // Rough distance from RSSI (log-distance model, n = 2.5) — only for the accuracy estimate.
    const tx = Number.isFinite(Number(a.tx_power)) ? Number(a.tx_power) : -59;
    const dist = Math.pow(10, (tx - same[0].rssi) / 25);
    return { floorId, x: a.x, y: a.y, method: 'ble_nearest', accuracyM: Math.max(2, Math.round(dist * 10) / 10) };
  }
  let sw = 0, sx = 0, sy = 0;
  for (const s of same) {
    const w = Math.pow(10, s.rssi / 20); // stronger = much heavier
    sw += w; sx += w * s.anchor.x; sy += w * s.anchor.y;
  }
  const x = sx / sw, y = sy / sw;
  let spreadPx = 0;
  for (const s of same) spreadPx = Math.max(spreadPx, Math.hypot(s.anchor.x - x, s.anchor.y - y));
  const accuracyM = metersPerPx ? Math.max(2, Math.round(spreadPx * metersPerPx * 0.5 * 10) / 10) : null;
  return { floorId, x, y, method: 'ble_weighted', accuracyM };
}

module.exports = {
  distanceM, validLatLng, pointInPolygon, distanceToPolygonM, geofenceDistanceM, classifyAgainstGeofence,
  simplifyRoute, routeDistanceM, pointInPixelPolygon, estimateBlePosition,
};
