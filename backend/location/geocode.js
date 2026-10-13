// Place search for the location maps ("search a place").
//
// The browser never talks to a search provider directly: it calls GET /api/location/geocode, and
// this module answers it. That keeps any API key on the server, lets us cache answers (the same
// site gets searched again and again) and respect the provider's rate limits.
//
// Order of answers:
//   1. Coordinates typed or pasted ("18.5590, 73.7868", "18°33'32\"N 73°47'12\"E") and Google Maps
//      links (".../@18.5590,73.7868,17z", "?q=18.55,73.78", "!3d18.55!4d73.78") — read directly,
//      no provider call, works even with no provider configured.
//   2. The provider set in GEOCODER:
//        nominatim (default) — OpenStreetMap's free service. Fair-use policy: at most 1 request a
//                              second, a real contact in the User-Agent, no bulk use. Fine for an
//                              Admin searching a few places; set GEOCODER_EMAIL to your address.
//        maptiler           — commercial (GEOCODER_KEY). Better Indian address coverage, no 1/s limit.
//        mock               — fixed answers, for tests and demos.
//        off                — only coordinates/links (1.) work.
//   Results are biased to India (GEOCODER_COUNTRY, default "in") and towards the map's current view.
const https = require('https');

const CACHE_MS = 24 * 3600 * 1000;
const CACHE_MAX = 500;
const cache = new Map();
let lastNominatimAt = 0;

function round(n, d = 6) { const f = 10 ** d; return Math.round(n * f) / f; }
function validLatLng(lat, lng) { return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0); }

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
  if ((m = /[?&](?:q|query|ll|destination)=(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/.exec(s))) return pack(+m[1], +m[2], 'Map link');
  if ((m = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(s))) return pack(+m[1], +m[2], 'Google Maps link');
  // Degrees-minutes-seconds: 18°33'32.4"N 73°47'12.5"E
  if ((m = /(\d{1,3})[°\s]+(\d{1,2})['′\s]+(\d{1,2}(?:\.\d+)?)["″]?\s*([NS])[\s,]+(\d{1,3})[°\s]+(\d{1,2})['′\s]+(\d{1,2}(?:\.\d+)?)["″]?\s*([EW])/i.exec(s))) {
    return pack(dmsToDecimal(m[1], m[2], m[3], m[4]), dmsToDecimal(m[5], m[6], m[7], m[8]), 'Coordinates');
  }
  // Plain decimal pair: "18.5590, 73.7868" or "18.5590 73.7868" (needs a decimal point, so "12 34" isn't mistaken)
  if ((m = /^\s*(-?\d{1,2}\.\d+)\s*[,\s]\s*(-?\d{1,3}\.\d+)\s*$/.exec(s))) return pack(+m[1], +m[2], 'Coordinates');
  return null;
}
function pack(lat, lng, label) {
  if (!validLatLng(lat, lng)) return null;
  return { name: `${round(lat, 6)}, ${round(lng, 6)}`, address: label, lat: round(lat), lng: round(lng), type: 'coordinates', source: 'typed' };
}

// ---- 2. providers ----
function getJson(url, headers, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; if (body.length > 2e6) req.destroy(new Error('Response too large')); });
      res.on('end', () => {
        if (res.statusCode === 429) return reject(Object.assign(new Error('The map search service is busy — try again in a few seconds.'), { status: 503 }));
        if (res.statusCode >= 400) return reject(Object.assign(new Error(`Map search failed (${res.statusCode}).`), { status: 502 }));
        try { resolve(JSON.parse(body)); } catch (e) { reject(Object.assign(new Error('Map search returned an unreadable answer.'), { status: 502 })); }
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('Map search took too long — try again.'), { status: 504 })));
    req.on('error', (e) => reject(e.status ? e : Object.assign(new Error('Map search is not reachable right now.'), { status: 502 })));
  });
}
async function nominatim(q, { lat, lng, country, email, limit }) {
  // One request a second at most (OpenStreetMap's usage policy) — later callers wait their turn.
  const wait = lastNominatimAt + 1100 - Date.now();
  lastNominatimAt = Math.max(Date.now(), lastNominatimAt + 1100);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  const p = new URLSearchParams({ q, format: 'jsonv2', addressdetails: '1', limit: String(limit), 'accept-language': 'en' });
  if (country) p.set('countrycodes', country);
  if (validLatLng(lat, lng)) p.set('viewbox', `${lng - 0.5},${lat + 0.5},${lng + 0.5},${lat - 0.5}`); // prefer, don't restrict
  if (email) p.set('email', email);
  const rows = await getJson(`https://nominatim.openstreetmap.org/search?${p}`, { 'User-Agent': `MIHIR-Task-Manager/1.0 (${email || 'location search'})`, Accept: 'application/json' });
  return (Array.isArray(rows) ? rows : []).map(r => ({
    name: r.name || String(r.display_name || '').split(',')[0],
    address: r.display_name || '',
    lat: round(Number(r.lat)), lng: round(Number(r.lon)),
    type: [r.category || r.class, r.type].filter(Boolean).join(' · '),
    source: 'OpenStreetMap',
  })).filter(r => validLatLng(r.lat, r.lng));
}
async function maptiler(q, { lat, lng, country, key, limit }) {
  if (!key) throw Object.assign(new Error('Map search needs GEOCODER_KEY for MapTiler.'), { status: 503 });
  const p = new URLSearchParams({ key, limit: String(limit), language: 'en' });
  if (country) p.set('country', country);
  if (validLatLng(lat, lng)) p.set('proximity', `${lng},${lat}`);
  const data = await getJson(`https://api.maptiler.com/geocoding/${encodeURIComponent(q)}.json?${p}`, { Accept: 'application/json' });
  return ((data && data.features) || []).map(f => ({
    name: f.text || String(f.place_name || '').split(',')[0],
    address: f.place_name || '',
    lat: round(f.center[1]), lng: round(f.center[0]),
    type: (f.place_type || []).join(' · '),
    source: 'MapTiler',
  })).filter(r => validLatLng(r.lat, r.lng));
}
const MOCK = [
  { name: 'Hinjewadi Phase 1', address: 'Hinjewadi Phase 1, Pune, Maharashtra, India', lat: 18.5913, lng: 73.7389, type: 'place · suburb' },
  { name: 'Baner', address: 'Baner, Pune, Maharashtra, India', lat: 18.559, lng: 73.7868, type: 'place · suburb' },
  { name: 'Shivajinagar', address: 'Shivajinagar, Pune, Maharashtra, India', lat: 18.5308, lng: 73.8475, type: 'place · suburb' },
  { name: 'Wakad', address: 'Wakad, Pimpri-Chinchwad, Maharashtra, India', lat: 18.5984, lng: 73.7638, type: 'place · suburb' },
];
async function mock(q, { limit }) {
  const t = q.toLowerCase();
  return MOCK.filter(r => r.name.toLowerCase().includes(t) || r.address.toLowerCase().includes(t)).slice(0, limit).map(r => ({ ...r, source: 'Demo search' }));
}

function providerName(env = process.env) {
  const p = String(env.GEOCODER || 'nominatim').toLowerCase();
  return ['nominatim', 'maptiler', 'mock', 'off'].includes(p) ? p : 'nominatim';
}

async function geocode(query, { lat, lng, env = process.env, limit = 6 } = {}) {
  const q = String(query || '').trim().slice(0, 200);
  if (q.length < 2) return { results: [], provider: providerName(env) };
  const typed = parseCoordinates(q);
  if (typed) return { results: [typed], provider: 'typed' };
  const provider = providerName(env);
  if (provider === 'off') return { results: [], provider, note: 'Place search is switched off — paste coordinates or a Google Maps link instead.' };
  const country = env.GEOCODER_COUNTRY === undefined ? 'in' : String(env.GEOCODER_COUNTRY).toLowerCase();
  // Cache on the words + a coarse view area (~10 km), so nearby repeat searches are instant and free.
  const area = validLatLng(lat, lng) ? `${Math.round(lat * 10)}:${Math.round(lng * 10)}` : '-';
  const key = `${provider}|${country}|${area}|${q.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return { results: hit.results, provider, cached: true };
  const opts = { lat, lng, country, limit, email: env.GEOCODER_EMAIL || '', key: env.GEOCODER_KEY || '' };
  const results = provider === 'maptiler' ? await maptiler(q, opts) : provider === 'mock' ? await mock(q, opts) : await nominatim(q, opts);
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), results });
  return { results, provider };
}

module.exports = { geocode, parseCoordinates, providerName, _cache: cache };
