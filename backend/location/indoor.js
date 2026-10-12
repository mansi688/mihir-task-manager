// Indoor positioning. GPS does not work reliably indoors and cannot tell floors or desks apart, so
// indoor positions come only from hardware installed in the building:
//   - BLE beacons (iBeacon): the phone app scans and uploads sightings; we estimate room/zone level
//     (nearest beacon, or an RSSI-weighted centroid with ≥3 beacons — typically 2–5 m).
//   - UWB / other RTLS systems (Pozyx, Sewio, Quuppa, Kontakt.io…): the vendor's engine computes
//     positions (~10–30 cm) and pushes them here with an integration key. That is what "desk level" needs.
// Positions are only stored for people who currently have a work session on — a badge or phone
// that reports outside a session is ignored.
const crypto = require('crypto');
const geo = require('./geo');

function createIndoorService({ pool, service }) {
  const q = (t, p) => pool.query(t, p);
  let anchorCache = null;
  const invalidate = () => { anchorCache = null; };

  async function anchors() {
    if (anchorCache && Date.now() - anchorCache.at < 60000) return anchorCache;
    const rows = (await q('SELECT a.*, f.meters_per_px FROM indoor_anchors a JOIN indoor_floors f ON f.id = a.floor_id')).rows;
    anchorCache = { at: Date.now(), map: new Map(rows.map(a => [String(a.identifier).toLowerCase(), a])), rows };
    return anchorCache;
  }
  async function zonesOf(floorId) {
    return (await q('SELECT * FROM indoor_zones WHERE floor_id = $1', [floorId])).rows;
  }
  function zoneAt(zones, x, y) {
    // Smallest containing zone wins (a desk inside a room).
    const hits = zones.filter(z => geo.pointInPixelPolygon(x, y, z.polygon));
    if (!hits.length) return null;
    const area = (poly) => Math.abs(poly.reduce((s, [x1, y1], i) => { const [x2, y2] = poly[(i + 1) % poly.length]; return s + (x1 * y2 - x2 * y1); }, 0) / 2);
    return hits.sort((a, b) => area(a.polygon) - area(b.polygon))[0];
  }

  async function store(session, pos, t) {
    const zones = await zonesOf(pos.floorId);
    const zone = pos.zoneId ? zones.find(z => String(z.id) === String(pos.zoneId)) || null : (pos.x != null ? zoneAt(zones, pos.x, pos.y) : null);
    const r = await q(`INSERT INTO indoor_positions (username, session_id, floor_id, zone_id, x, y, accuracy_m, method, recorded_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [session.username, session.id, pos.floorId, zone ? zone.id : null, pos.x, pos.y, pos.accuracyM, pos.method, t]);
    if (zone && zone.restricted) {
      await service.fireRules('restricted_entry', session, { geofence: null, dedupe: `zone:${zone.id}:${session.id}:${Math.floor(new Date(t).getTime() / 1800000)}`,
        message: (u) => `${u} is in restricted zone "${zone.name}"` });
    }
    service.bump();
    return { id: r.rows[0].id, zone: zone ? { id: zone.id, name: zone.name, kind: zone.kind } : null };
  }

  // From the phone: { t, beacons: [{ id: "uuid:major:minor", rssi }] }
  async function ingestSightings(session, body) {
    const t = new Date(body.t || Date.now());
    if (isNaN(t)) { const e = new Error('bad time'); e.status = 400; throw e; }
    const list = Array.isArray(body.beacons) ? body.beacons.slice(0, 50) : [];
    const a = await anchors();
    const sightings = list.map(b => ({ identifier: String(b.id || '').toLowerCase(), rssi: b.rssi }));
    const known = sightings.filter(s => a.map.has(s.identifier));
    if (known.length) await q('UPDATE indoor_anchors SET last_seen_at = now() WHERE lower(identifier) = ANY($1::text[])', [known.map(s => s.identifier)]);
    const strongest = known.length ? a.map.get(known.sort((x, y) => y.rssi - x.rssi)[0].identifier) : null;
    const pos = geo.estimateBlePosition(sightings, a.map, { metersPerPx: strongest ? strongest.meters_per_px : null });
    if (!pos) return { stored: false, reason: 'no known beacons in range' };
    const out = await store(session, pos, t);
    return { stored: true, method: pos.method, accuracyM: pos.accuracyM, zone: out.zone };
  }

  // ---- RTLS vendor integration keys ----
  const hash = (k) => crypto.createHash('sha256').update(k).digest('hex');
  async function createKey(name, by) {
    const key = 'mtk_loc_' + crypto.randomBytes(24).toString('base64url');
    const r = await q('INSERT INTO location_integration_keys (name, key_prefix, key_hash, created_by) VALUES ($1,$2,$3,$4) RETURNING id, name, key_prefix, created_at',
      [name, key.slice(0, 12), hash(key), by]);
    return { ...r.rows[0], key }; // the full key is shown ONCE
  }
  async function checkKey(key) {
    if (!key || typeof key !== 'string') return null;
    const r = await q('UPDATE location_integration_keys SET last_used_at = now() WHERE key_hash = $1 AND revoked_at IS NULL RETURNING id, name', [hash(key)]);
    return r.rows[0] || null;
  }
  // { positions: [{ tag, floorId, x, y, accuracyM?, zoneId?, t? }] } — x/y in floor-plan pixels.
  async function ingestRtls(body) {
    const list = Array.isArray(body.positions) ? body.positions.slice(0, 1000) : [];
    const out = { stored: 0, ignoredNoSession: 0, unknownTag: 0, invalid: 0 };
    if (!list.length) return out;
    const tags = new Map((await q('SELECT tag_id, username FROM indoor_tags WHERE tag_id = ANY($1::text[])', [list.map(p => String(p.tag || ''))])).rows.map(r => [r.tag_id, r.username]));
    const floors = new Set((await q('SELECT id FROM indoor_floors')).rows.map(r => String(r.id)));
    for (const p of list) {
      const username = tags.get(String(p.tag || ''));
      if (!username) { out.unknownTag++; continue; }
      const x = Number(p.x), y = Number(p.y), t = new Date(p.t || Date.now());
      if (!floors.has(String(p.floorId)) || !Number.isFinite(x) || !Number.isFinite(y) || isNaN(t)) { out.invalid++; continue; }
      const session = await service.activeSession(username);
      if (!session) { out.ignoredNoSession++; continue; }
      await store(session, { floorId: Number(p.floorId), x, y, zoneId: p.zoneId || null, accuracyM: Number.isFinite(Number(p.accuracyM)) ? Number(p.accuracyM) : null, method: 'uwb' }, t);
      out.stored++;
    }
    return out;
  }

  return { anchors, invalidate, zonesOf, zoneAt, ingestSightings, createKey, checkKey, ingestRtls };
}

module.exports = { createIndoorService };
