// Place search for the location maps ("search a place").
//
// The browser never talks to a search service directly: it calls GET /api/location/geocode and
// this module answers. That keeps API keys on the server, lets us cache answers and keeps within
// each service's limits.
//
// Order of answers:
//   1. Coordinates typed or pasted ("18.5590, 73.7868", "18°33'32\"N 73°47'12\"E") and map links
//      (Google Maps ".../@18.55,73.78,17z", "?q=18.55,73.78", "!3d18.55!4d73.78") — read directly,
//      no service needed, always work.
//   2. A CHAIN of search services, tried in order until one answers with results:
//        google     — Google Places text search (GOOGLE_MAPS_API_KEY). Best for Indian builder
//                     projects, societies, shops and landmarks. Paid after Google's free credit.
//        maptiler   — MapTiler geocoding (MAPTILER_KEY or GEOCODER_KEY).
//        photon     — Komoot's free OpenStreetMap search, made for search-as-you-type: tolerant of
//                     partial words and typos. No key. Default first choice.
//        nominatim  — OpenStreetMap's own free search. Strict fair use (max 1 request/second) — used
//                     as a backup only.
//      A service that is busy (HTTP 429), down or slow is skipped for a while ("cooling down") and
//      the next one answers, so one busy service never breaks the search box.
//   3. If nothing is found, the words are simplified (filler words like "site", "project", "near"
//      removed, then the last word dropped) and tried again — at most a few extra lookups.
// Settings: GEOCODER = auto (default) | a comma list like "google,photon" | mock | off.
// Results are limited to GEOCODER_COUNTRY (default "in") and favour the area the map is showing.
const https = require('https');

const CACHE_MS = 24 * 3600 * 1000;      // a found answer is reused for a day
const EMPTY_CACHE_MS = 10 * 60 * 1000;  // "nothing found" is remembered for 10 minutes only
const CACHE_MAX = 1000;
const cache = new Map();
const cooldown = new Map();             // provider -> { until, reason }
let lastNominatimAt = 0;
const INDIA_BBOX = [68.0, 6.5, 97.5, 35.7]; // minLng, minLat, maxLng, maxLat

function round(n, d = 6) { const f = 10 ** d; return Math.round(n * f) / f; }
function validLatLng(lat, lng) { return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0); }
function err(message, status, extra = {}) { return Object.assign(new Error(message), { status }, extra); }

// ---- 1. coordinates and map links ----
function dmsToDecimal(deg, min, sec, hemi) {
  let v = Number(deg) + (Number(min) || 0) / 60 + (Number(sec) || 0) / 3600;
  if (/[SW]/i.test(hemi || '')) v = -v;
  return v;
}
function parseCoordinates(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  let m;
  // Google Maps place links carry the exact pin as !3d<lat>!4d<lng>; prefer it over the view centre.
  if ((m = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/.exec(s))) return pack(+m[1], +m[2], 'Google Maps link');
  if ((m = /[?&](?:q|query|ll|destination|center)=(-?\d+(?:\.\d+)?)(?:\s|%20|\+)*(?:,|%2C)(?:\s|%20|\+)*(-?\d+(?:\.\d+)?)/i.exec(s))) return pack(+m[1], +m[2], 'Map link');
  if ((m = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(s))) return pack(+m[1], +m[2], 'Google Maps link');
  // Degrees-minutes-seconds: 18°33'32.4"N 73°47'12.5"E
  if ((m = /(\d{1,3})[°\s]+(\d{1,2})['′\s]+(\d{1,2}(?:\.\d+)?)["″]?\s*([NS])[\s,]+(\d{1,3})[°\s]+(\d{1,2})['′\s]+(\d{1,2}(?:\.\d+)?)["″]?\s*([EW])/i.exec(s))) {
    return pack(dmsToDecimal(m[1], m[2], m[3], m[4]), dmsToDecimal(m[5], m[6], m[7], m[8]), 'Coordinates');
  }
  // Plain decimal pair: "18.5590, 73.7868" or "18.5590 73.7868" (needs a decimal point, so "12 34" isn't mistaken)
  if ((m = /^\s*\(?\s*(-?\d{1,2}\.\d+)\s*[,\s]\s*(-?\d{1,3}\.\d+)\s*\)?\s*$/.exec(s))) return pack(+m[1], +m[2], 'Coordinates');
  return null;
}
function pack(lat, lng, label) {
  if (!validLatLng(lat, lng)) return null;
  return { name: `${round(lat, 6)}, ${round(lng, 6)}`, address: label, lat: round(lat), lng: round(lng), type: 'coordinates', source: 'typed' };
}
// Short links (maps.app.goo.gl/…, goo.gl/maps/…) hide the coordinates: the server follows the
// redirect (without downloading the page) and reads the full link it points to.
const SHORT_LINK = /https?:\/\/(?:maps\.app\.goo\.gl|goo\.gl\/maps|g\.co\/kgs)\/[A-Za-z0-9_\-/?=&.%]+/i;
function isShortMapLink(s) { return SHORT_LINK.test(String(s || '')); }
function realRedirect(url, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0 (MIHIR Task Manager link reader)' }, timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.headers.location || null);
    });
    req.on('timeout', () => req.destroy(err('timed out', 504)));
    req.on('error', (e) => reject(e.status ? e : err('not reachable', 502)));
    req.end();
  });
}
let redirect = realRedirect;
async function expandShortLink(input) {
  let url = String(input).match(SHORT_LINK)[0];
  for (let hop = 0; hop < 4; hop++) {
    const next = await redirect(url);
    if (!next) break;
    url = new URL(next, url).toString();
    if (!isShortMapLink(url)) break;
  }
  return url;
}
// A full Google Maps link with a place name but no coordinates (…/maps/place/Kolte+Patil+Life+Republic/…).
function placeNameFromLink(url) {
  const m = /\/maps\/(?:place|search)\/([^/@?]+)/.exec(url) || /[?&]q=([^&]+)/.exec(url);
  if (!m) return null;
  const name = decodeURIComponent(m[1].replace(/\+/g, ' ')).trim();
  return name && !parseCoordinates(name) ? name.slice(0, 200) : null;
}

// ---- words: normalising and simplifying ----
const FILLER = new Set(['site', 'project', 'projects', 'near', 'nr', 'opp', 'opposite', 'behind', 'next', 'to', 'the', 'at', 'in', 'of', 'and', 'phase', 'plot', 'no', 'building', 'bldg', 'tower', 'wing', 'office', 'new', 'road', 'rd', 'chowk', 'nagar']);
function norm(s) { return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ऀ-ॿ]+/g, ' ').trim(); }
function variants(q) {
  const out = [q];
  const words = norm(q).split(' ').filter(Boolean);
  const kept = words.filter(w => !FILLER.has(w) && !/^\d+[a-z]?$/.test(w));
  const add = (v) => { if (v && v.length >= 3 && !out.some(o => norm(o) === norm(v))) out.push(v); };
  add(kept.join(' '));
  if (kept.length >= 3) add(kept.slice(0, -1).join(' '));
  if (kept.length >= 2 && kept[0].length >= 4) add(kept.slice(0, 2).join(' '));
  return out.slice(0, 3);
}

// Saved company places matched on the server: every word typed must appear (any order) in the
// place's name, project or address — so "amara tower" finds "Mihir Amara — Tower B".
function matchPlaces(places, q, limit = 5) {
  const words = norm(q).split(' ').filter(Boolean);
  if (!words.length) return [];
  const scored = [];
  for (const g of places || []) {
    const name = norm(g.name), project = norm(g.project), address = norm(g.address);
    const hay = `${name} ${project} ${address}`;
    if (!words.every(w => hay.includes(w))) continue;
    let score = 0;
    for (const w of words) { if (name.includes(w)) score += 3; else if (project.includes(w)) score += 2; else score += 1; }
    if (name.startsWith(words[0])) score += 2;
    scored.push({ g, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map(({ g }) => ({
    name: g.name, address: [g.project ? `Project: ${g.project}` : '', g.address || ''].filter(Boolean).join(' · '),
    lat: g.center_lat, lng: g.center_lng, type: 'saved', kind: g.kind, placeId: g.id, saved: true, source: 'saved',
  }));
}

// ---- HTTP (replaceable in tests) ----
function realHttp({ method = 'GET', url, headers = {}, body, timeoutMs = 7000 }) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers: { Accept: 'application/json', ...headers, ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}) }, timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; if (data.length > 3e6) req.destroy(new Error('Response too large')); });
      res.on('end', () => {
        if (res.statusCode === 429) return reject(err('busy', 503, { busy: true }));
        if (res.statusCode >= 400) return reject(err(`HTTP ${res.statusCode}${data ? `: ${data.slice(0, 160)}` : ''}`, 502));
        try { resolve(JSON.parse(data)); } catch (e) { reject(err('unreadable answer', 502)); }
      });
    });
    req.on('timeout', () => req.destroy(err('timed out', 504)));
    req.on('error', (e) => reject(e.status ? e : err(`not reachable (${e.code || e.message})`, 502)));
    if (body) req.write(body);
    req.end();
  });
}
let http = realHttp;

// ---- providers ----
function countryOk(code, country) {
  if (!country) return true;
  return !code || country.split(',').map(c => c.trim()).includes(String(code).toLowerCase());
}
const PROVIDERS = {
  async google(q, o) {
    const body = { textQuery: q, languageCode: 'en', maxResultCount: Math.min(o.limit, 10) };
    if (o.country && !o.country.includes(',')) body.regionCode = o.country.toUpperCase();
    if (validLatLng(o.lat, o.lng)) body.locationBias = { circle: { center: { latitude: o.lat, longitude: o.lng }, radius: 50000 } };
    const data = await http({ method: 'POST', url: 'https://places.googleapis.com/v1/places:searchText', body: JSON.stringify(body),
      headers: { 'X-Goog-Api-Key': o.googleKey, 'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location,places.primaryTypeDisplayName' } });
    return ((data && data.places) || []).map(p => ({
      name: (p.displayName && p.displayName.text) || String(p.formattedAddress || '').split(',')[0],
      address: p.formattedAddress || '', lat: round(p.location && p.location.latitude), lng: round(p.location && p.location.longitude),
      type: (p.primaryTypeDisplayName && p.primaryTypeDisplayName.text) || '', source: 'Google',
    }));
  },
  async maptiler(q, o) {
    const p = new URLSearchParams({ key: o.maptilerKey, limit: String(Math.min(o.limit, 10)), language: 'en', fuzzyMatch: 'true', autocomplete: 'true' });
    if (o.country) p.set('country', o.country);
    if (validLatLng(o.lat, o.lng)) p.set('proximity', `${o.lng},${o.lat}`);
    const data = await http({ url: `https://api.maptiler.com/geocoding/${encodeURIComponent(q)}.json?${p}` });
    return ((data && data.features) || []).map(f => ({
      name: f.text || String(f.place_name || '').split(',')[0], address: f.place_name || '',
      lat: round(f.center[1]), lng: round(f.center[0]), type: (f.place_type || []).join(' · '), source: 'MapTiler',
    }));
  },
  async photon(q, o) {
    const p = new URLSearchParams({ q, limit: String(Math.min(o.limit + 4, 15)), lang: 'en' });
    if (validLatLng(o.lat, o.lng)) { p.set('lat', String(o.lat)); p.set('lon', String(o.lng)); }
    if (o.country === 'in') p.set('bbox', INDIA_BBOX.join(','));
    const data = await http({ url: `https://photon.komoot.io/api/?${p}`, headers: { 'User-Agent': o.userAgent } });
    return ((data && data.features) || []).filter(f => countryOk(f.properties && f.properties.countrycode, o.country)).map(f => {
      const pr = f.properties || {};
      const street = [pr.housenumber, pr.street].filter(Boolean).join(' ');
      const parts = [pr.name !== street ? street : '', pr.locality, pr.district, pr.city, pr.county !== pr.city ? pr.county : '', pr.state, pr.postcode].filter(Boolean);
      const name = pr.name || street || pr.district || pr.city || parts[0] || '';
      return { name, address: [name, ...parts.filter(x => x !== name)].join(', '), lat: round(f.geometry.coordinates[1]), lng: round(f.geometry.coordinates[0]),
        type: [pr.osm_key, pr.osm_value].filter(Boolean).join(' · '), source: 'OpenStreetMap (Photon)' };
    });
  },
  async nominatim(q, o) {
    // One request a second at most (OpenStreetMap's usage policy) — later callers wait their turn.
    const wait = lastNominatimAt + 1100 - Date.now();
    lastNominatimAt = Math.max(Date.now(), lastNominatimAt + 1100);
    if (wait > 3000) throw err('busy (queue)', 503, { busy: true });
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    const p = new URLSearchParams({ q, format: 'jsonv2', addressdetails: '1', limit: String(Math.min(o.limit, 10)), 'accept-language': 'en' });
    if (o.country) p.set('countrycodes', o.country);
    if (validLatLng(o.lat, o.lng)) p.set('viewbox', `${o.lng - 0.5},${o.lat + 0.5},${o.lng + 0.5},${o.lat - 0.5}`);
    if (o.email) p.set('email', o.email);
    const rows = await http({ url: `https://nominatim.openstreetmap.org/search?${p}`, headers: { 'User-Agent': o.userAgent } });
    return (Array.isArray(rows) ? rows : []).map(r => ({
      name: r.name || String(r.display_name || '').split(',')[0], address: r.display_name || '',
      lat: round(Number(r.lat)), lng: round(Number(r.lon)), type: [r.category || r.class, r.type].filter(Boolean).join(' · '), source: 'OpenStreetMap',
    }));
  },
};
const MOCK = [
  { name: 'Hinjewadi Phase 1', address: 'Hinjewadi Phase 1, Pune, Maharashtra, India', lat: 18.5913, lng: 73.7389, type: 'place · suburb' },
  { name: 'Baner', address: 'Baner, Pune, Maharashtra, India', lat: 18.559, lng: 73.7868, type: 'place · suburb' },
  { name: 'Shivajinagar', address: 'Shivajinagar, Pune, Maharashtra, India', lat: 18.5308, lng: 73.8475, type: 'place · suburb' },
  { name: 'Wakad', address: 'Wakad, Pimpri-Chinchwad, Maharashtra, India', lat: 18.5984, lng: 73.7638, type: 'place · suburb' },
  { name: 'Balewadi High Street', address: 'Balewadi High Street, Baner, Pune, Maharashtra, India', lat: 18.5701, lng: 73.7745, type: 'amenity · marketplace' },
];
PROVIDERS.mock = async (q, o) => {
  const words = norm(q).split(' ').filter(Boolean);
  return MOCK.filter(r => words.every(w => norm(`${r.name} ${r.address}`).includes(w))).slice(0, o.limit).map(r => ({ ...r, source: 'Demo search' }));
};

const LABEL = { google: 'Google', maptiler: 'MapTiler', photon: 'OpenStreetMap (Photon)', nominatim: 'OpenStreetMap (Nominatim)', mock: 'Demo search' };

function chain(env = process.env) {
  const raw = String(env.GEOCODER || 'auto').toLowerCase().replace(/\s+/g, '');
  if (raw === 'off') return [];
  if (raw === 'mock') return ['mock'];
  const googleKey = env.GOOGLE_MAPS_API_KEY || '';
  const maptilerKey = env.MAPTILER_KEY || env.GEOCODER_KEY || '';
  const wanted = raw === 'auto' || !raw ? ['google', 'maptiler', 'photon', 'nominatim'] : raw.split(',');
  // An explicit single choice still gets the free services as backup, so one outage never breaks search.
  if (raw !== 'auto' && wanted.length === 1 && wanted[0] !== 'mock') wanted.push('photon', 'nominatim');
  const seen = new Set();
  return wanted.filter(p => PROVIDERS[p] && p !== 'mock' && !seen.has(p) && seen.add(p))
    .filter(p => (p !== 'google' || googleKey) && (p !== 'maptiler' || maptilerKey));
}
function providerName(env = process.env) {
  const c = chain(env);
  if (String(env.GEOCODER || '').toLowerCase() === 'off') return 'off';
  if (String(env.GEOCODER || '').toLowerCase() === 'mock') return 'mock';
  return c.join(',') || 'off';
}
function opts(env, { lat, lng, limit }) {
  const country = env.GEOCODER_COUNTRY === undefined ? 'in' : String(env.GEOCODER_COUNTRY).toLowerCase().replace(/\s+/g, '');
  const email = env.GEOCODER_EMAIL || '';
  return { lat, lng, limit, country, email, googleKey: env.GOOGLE_MAPS_API_KEY || '', maptilerKey: env.MAPTILER_KEY || env.GEOCODER_KEY || '',
    userAgent: `MIHIR-Task-Manager/1.1 (site location search${email ? `; ${email}` : ''})` };
}
function cooling(p) { const c = cooldown.get(p); return c && c.until > Date.now() ? c : null; }

// Merge results from different services, dropping near-duplicates (same name within ~60 m).
function dedupe(list, limit) {
  const out = [];
  for (const r of list) {
    if (!validLatLng(r.lat, r.lng)) continue;
    const dup = out.find(o => Math.abs(o.lat - r.lat) < 0.0006 && Math.abs(o.lng - r.lng) < 0.0006 && norm(o.name) === norm(r.name));
    if (!dup) out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

async function geocode(query, { lat, lng, env = process.env, limit = 6 } = {}) {
  const q = String(query || '').trim().replace(/\s+/g, ' ').slice(0, 200);
  const providers = chain(env);
  if (q.length < 2) return { results: [], provider: providers[0] || 'off' };
  const typed = parseCoordinates(q);
  if (typed) return { results: [typed], provider: 'typed' };
  if (isShortMapLink(q)) {
    const fail = { results: [], provider: 'typed', note: 'Could not open that short Google link. Open it on your phone, long-press the pin, copy the coordinates and paste them here (or paste the full link from the browser address bar).' };
    let full;
    try { full = await expandShortLink(q); } catch (e) { return fail; }
    const at = parseCoordinates(full);
    if (at) return { results: [{ ...at, name: placeNameFromLink(full) || at.name, address: 'Google Maps link' }], provider: 'typed' };
    const name = placeNameFromLink(full);
    if (!name) return fail;
    return geocode(name, { lat, lng, env, limit });
  }
  if (/^https?:\/\//i.test(q)) {
    const name = placeNameFromLink(q);
    if (name) return geocode(name, { lat, lng, env, limit });
    return { results: [], provider: 'typed', note: 'That link has no location in it. Paste a Google Maps link to a place, or coordinates.' };
  }
  if (!providers.length) return { results: [], provider: 'off', note: 'Street search is switched off — paste coordinates or a Google Maps link instead.' };
  const o = opts(env, { lat, lng, limit });
  const area = validLatLng(lat, lng) ? `${Math.round(lat * 10)}:${Math.round(lng * 10)}` : '-';
  const key = `${providers.join(',')}|${o.country}|${area}|${norm(q)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < (hit.results.length ? CACHE_MS : EMPTY_CACHE_MS)) return { results: hit.results, provider: hit.provider, cached: true, ...(hit.query ? { query: hit.query } : {}) };

  const failures = [];
  let calls = 0;
  for (const v of variants(q)) {
    for (const p of providers) {
      if (cooling(p)) { if (!failures.some(f => f.provider === p)) failures.push({ provider: p, error: cooling(p).reason }); continue; }
      if (calls >= 6) break;
      calls++;
      try {
        const found = dedupe(await PROVIDERS[p](v, o), limit);
        if (found.length) {
          const out = { results: found, provider: p, ...(v !== q ? { query: v } : {}) };
          if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
          cache.set(key, { at: Date.now(), ...out });
          return out;
        }
      } catch (e) {
        // Busy → rest that service for 2 minutes; other errors → 30 seconds. Try the next one now.
        const ms = e.busy ? 120000 : 30000;
        cooldown.set(p, { until: Date.now() + ms, reason: e.busy ? 'busy (too many requests)' : e.message });
        failures.push({ provider: p, error: e.busy ? 'busy (too many requests)' : e.message });
      }
    }
  }
  if (failures.length && failures.length >= providers.length) {
    throw err('Street search is not answering right now — saved places, coordinates and Google Maps links still work. Try again in a minute.', 503, { failures });
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), results: [], provider: providers[0] });
  return { results: [], provider: providers[0], ...(failures.length ? { failures } : {}) };
}

// Admin check: ask each configured service once and report how it did.
async function selfTest(env = process.env, query = 'Shivajinagar, Pune') {
  const o = opts(env, { lat: 18.53, lng: 73.85, limit: 3 });
  const out = [];
  const list = String(env.GEOCODER || '').toLowerCase() === 'mock' ? ['mock'] : chain(env);
  for (const p of list) {
    const t0 = Date.now();
    try {
      const r = await PROVIDERS[p](query, o);
      out.push({ provider: p, label: LABEL[p], ok: true, results: r.length, first: r[0] ? `${r[0].name} — ${r[0].address}`.slice(0, 160) : null, ms: Date.now() - t0 });
      cooldown.delete(p);
    } catch (e) {
      out.push({ provider: p, label: LABEL[p], ok: false, error: e.busy ? 'busy (too many requests)' : e.message, ms: Date.now() - t0 });
    }
  }
  return { query, providers: out, country: o.country };
}

module.exports = {
  geocode, parseCoordinates, providerName, chain, matchPlaces, variants, selfTest, LABEL,
  _cache: cache, _cooldown: cooldown, _setHttp(fn) { http = fn || realHttp; }, _setRedirect(fn) { redirect = fn || realRedirect; }, _reset() { cache.clear(); cooldown.clear(); lastNominatimAt = 0; },
};
