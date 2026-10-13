const test = require('node:test');
const assert = require('node:assert/strict');
const geocoder = require('../backend/location/geocode');
const { startTestServer, api, login, createMember } = require('../testlib/helpers');

// Simulated search services: the real ones are on the internet and are never called by tests.
function fakeServices(behaviour) {
  const calls = [];
  geocoder._setHttp(async ({ url, method, body }) => {
    const host = new URL(url).host;
    const p = host.includes('photon') ? 'photon' : host.includes('nominatim') ? 'nominatim' : host.includes('googleapis') ? 'google' : host.includes('maptiler') ? 'maptiler' : host;
    const q = p === 'google' ? JSON.parse(body).textQuery : p === 'maptiler' ? decodeURIComponent(new URL(url).pathname.split('/').pop().replace(/\.json$/, '')) : new URL(url).searchParams.get('q');
    calls.push({ p, q, url, method });
    const b = behaviour[p];
    if (!b) throw Object.assign(new Error('not reachable'), { status: 502 });
    return b(q, url);
  });
  return calls;
}
const busy = () => { throw Object.assign(new Error('busy'), { status: 503, busy: true }); };
const photonHit = (name, lat, lng, extra = {}) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: { name, city: 'Pune', state: 'Maharashtra', countrycode: 'IN', osm_key: 'place', osm_value: 'suburb', ...extra } });
test.afterEach(() => { geocoder._setHttp(null); geocoder._setRedirect(null); geocoder._reset(); });

test('parseCoordinates reads typed coordinates and map links', () => {
  const p = geocoder.parseCoordinates;
  assert.deepEqual([p('18.5590, 73.7868').lat, p('18.5590, 73.7868').lng], [18.559, 73.7868]);
  assert.equal(p('18.5590 73.7868').lng, 73.7868);
  assert.equal(p('(18.5590, 73.7868)').lat, 18.559);
  const g = p('https://www.google.com/maps/place/Baner/@18.5600,73.7800,15z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d18.559!4d73.7868');
  assert.deepEqual([g.lat, g.lng], [18.559, 73.7868], 'the !3d/!4d pin wins over the @ view centre');
  assert.deepEqual([p('https://www.google.com/maps/@18.5204,73.8567,17z').lat, p('https://maps.google.com/?q=18.52,73.85').lng], [18.5204, 73.85]);
  assert.equal(p('https://www.google.com/maps/search/?api=1&query=18.52%2C73.85').lat, 18.52);
  const dms = p(`18°33'32.4"N 73°47'12.5"E`);
  assert.ok(Math.abs(dms.lat - 18.559) < 1e-4 && Math.abs(dms.lng - 73.78681) < 1e-4);
  assert.ok(p(`33°52'0"S 151°12'0"E`).lat < 0, 'south is negative');
  assert.equal(p('Baner Pune'), null);
  assert.equal(p('12 34'), null, 'whole numbers alone are not coordinates');
  assert.equal(p('95.1, 73.2'), null, 'latitude out of range');
  assert.equal(p('0.0, 0.0'), null, '0,0 is a GPS error, not a place');
});

test('saved places match every word, in any order, on name, project or address', () => {
  const places = [
    { id: 1, name: 'Mihir Amara — Tower B', kind: 'site', project: 'Mihir Amara', address: 'Survey 12, Baner', center_lat: 18.56, center_lng: 73.78 },
    { id: 2, name: 'Head office', kind: 'office', project: null, address: 'FC Road, Shivajinagar', center_lat: 18.52, center_lng: 73.84 },
    { id: 3, name: 'Main gate', kind: 'site', project: 'Equinox', address: '', center_lat: 18.6, center_lng: 73.7 },
  ];
  const m = (q) => geocoder.matchPlaces(places, q).map(r => r.placeId);
  assert.deepEqual(m('tower amara'), [1]);
  assert.deepEqual(m('equinox'), [3], 'project name finds its place');
  assert.deepEqual(m('shivajinagar'), [2], 'address words count');
  assert.deepEqual(m('amara xyz'), [], 'every word must match');
  assert.equal(geocoder.matchPlaces(places, 'equinox')[0].address, 'Project: Equinox');
});

test('word variants drop filler words, then the last word', () => {
  assert.deepEqual(geocoder.variants('Kolte Patil Life Republic site'), ['Kolte Patil Life Republic site', 'kolte patil life republic', 'kolte patil life']);
  assert.deepEqual(geocoder.variants('Baner'), ['Baner']);
  assert.deepEqual(geocoder.variants('near Balewadi High Street'), ['near Balewadi High Street', 'balewadi high street', 'balewadi high']);
});

test('service chain: default order, keys switch services on, single choice keeps free backups', () => {
  assert.deepEqual(geocoder.chain({}), ['photon', 'nominatim']);
  assert.deepEqual(geocoder.chain({ GOOGLE_MAPS_API_KEY: 'k' }), ['google', 'photon', 'nominatim']);
  assert.deepEqual(geocoder.chain({ MAPTILER_KEY: 'k', GOOGLE_MAPS_API_KEY: 'g' }), ['google', 'maptiler', 'photon', 'nominatim']);
  assert.deepEqual(geocoder.chain({ GEOCODER: 'nominatim' }), ['nominatim', 'photon'], 'old setting still works, with a backup');
  assert.deepEqual(geocoder.chain({ GEOCODER: 'google' }), ['photon', 'nominatim'], 'google without a key is skipped');
  assert.deepEqual(geocoder.chain({ GEOCODER: 'off' }), []);
  assert.deepEqual(geocoder.chain({ GEOCODER: 'mock' }), ['mock']);
});

test('a busy service is skipped and rested; the next one answers', async () => {
  const calls = fakeServices({ nominatim: busy, photon: (q) => ({ features: [photonHit('Baner', 18.559, 73.7868)] }) });
  const env = { GEOCODER: 'nominatim,photon' };
  const r = await geocoder.geocode('Baner', { env, lat: 18.5, lng: 73.8 });
  assert.equal(r.provider, 'photon'); assert.equal(r.results[0].name, 'Baner'); assert.equal(r.results[0].address, 'Baner, Pune, Maharashtra');
  assert.deepEqual(calls.map(c => c.p), ['nominatim', 'photon']);
  assert.ok(geocoder._cooldown.get('nominatim').until > Date.now() + 100000, 'busy service rests ~2 minutes');
  await geocoder.geocode('Wakad', { env });
  assert.deepEqual(calls.map(c => c.p).slice(2), ['photon'], 'resting service is not asked again');
  // photon gets the map centre as a bias and is limited to India
  const u = new URL(calls[1].url);
  assert.equal(u.searchParams.get('lat'), '18.5'); assert.match(u.searchParams.get('bbox'), /^68/);
});

test('nothing found → simplified words are tried; results from other countries are dropped', async () => {
  const calls = fakeServices({ photon: (q) => ({ features: q === 'kolte patil life republic' ? [photonHit('Life Republic', 18.65, 73.70), photonHit('Life Republic', 51.5, -0.1, { countrycode: 'GB' })] : [] }), nominatim: () => [] });
  const r = await geocoder.geocode('Kolte Patil Life Republic site', { env: {} });
  assert.equal(r.results.length, 1, 'UK result dropped'); assert.equal(r.query, 'kolte patil life republic');
  assert.ok(calls.length <= 6, 'a bounded number of lookups');
  assert.equal((await geocoder.geocode('Kolte Patil Life Republic site', { env: {} })).cached, true);
});

test('Google Places: POST with key, India region and map bias; then cached', async () => {
  const calls = fakeServices({ google: () => ({ places: [{ displayName: { text: 'VTP Blue Waters' }, formattedAddress: 'Mahalunge, Pune 411045', location: { latitude: 18.566, longitude: 73.739 }, primaryTypeDisplayName: { text: 'Apartment complex' } }] }) });
  const r = await geocoder.geocode('vtp blue waters', { env: { GOOGLE_MAPS_API_KEY: 'secret' }, lat: 18.5, lng: 73.8 });
  assert.equal(r.provider, 'google'); assert.equal(r.results[0].name, 'VTP Blue Waters'); assert.equal(r.results[0].source, 'Google');
  assert.equal(calls[0].method, 'POST');
  assert.equal((await geocoder.geocode('VTP  Blue Waters', { env: { GOOGLE_MAPS_API_KEY: 'secret' }, lat: 18.5, lng: 73.8 })).cached, true, 'same words → cache');
});

test('every service failing gives a clear message; short links get advice; off/mock', async () => {
  fakeServices({ photon: busy, nominatim: busy });
  await assert.rejects(geocoder.geocode('Baner', { env: {} }), (e) => e.status === 503 && /saved places, coordinates and Google Maps links still work/.test(e.message));
  geocoder._setRedirect(async () => { throw Object.assign(new Error('x'), { status: 502 }); });
  const s = await geocoder.geocode('https://maps.app.goo.gl/AbCdEf123', { env: {} });
  assert.match(s.note, /Could not open that short Google link/);
  const off = await geocoder.geocode('baner', { env: { GEOCODER: 'off' } });
  assert.deepEqual(off.results, []); assert.match(off.note, /switched off/);
  assert.equal((await geocoder.geocode('18.55, 73.78', { env: { GEOCODER: 'off' } })).results[0].type, 'coordinates');
  assert.equal((await geocoder.geocode('balewadi high', { env: { GEOCODER: 'mock' } })).results[0].name, 'Balewadi High Street');
});

test('short Google links (WhatsApp shares) are opened and read', async () => {
  const opened = [];
  geocoder._setRedirect(async (u) => { opened.push(u); return u.includes('/AAA') ? 'https://maps.app.goo.gl/AAB' : u.includes('/AAB') ? 'https://www.google.com/maps/place/Life+Republic/@18.65,73.70,17z/data=!3d18.6512!4d73.7043' : u.includes('/BBB') ? 'https://www.google.com/maps/place/Balewadi+High+Street/data=x' : 'https://evil.example/@1.5,2.5'; });
  const a = await geocoder.geocode('Site location: https://maps.app.goo.gl/AAA?g_st=iw', { env: { GEOCODER: 'mock' } });
  assert.deepEqual([a.results[0].name, a.results[0].lat, a.results[0].lng], ['Life Republic', 18.6512, 73.7043]);
  assert.deepEqual(opened, ['https://maps.app.goo.gl/AAA?g_st=iw', 'https://maps.app.goo.gl/AAB'], 'only Google short links are ever opened');
  const b = await geocoder.geocode('https://maps.app.goo.gl/BBB', { env: { GEOCODER: 'mock' } });
  assert.equal(b.results[0].name, 'Balewadi High Street', 'a link with only a place name is searched by name');
  const full = await geocoder.geocode('https://www.google.com/maps/place/Wakad', { env: { GEOCODER: 'mock' } });
  assert.equal(full.results[0].name, 'Wakad');
  opened.length = 0;
  await geocoder.geocode('https://maps.app.goo.gl/ZZZ', { env: { GEOCODER: 'mock' } });
  assert.deepEqual(opened, ['https://maps.app.goo.gl/ZZZ'], 'the redirect target is read, not requested');
});

test('self-test reports each service', async () => {
  fakeServices({ photon: () => ({ features: [photonHit('Shivajinagar', 18.53, 73.84)] }), nominatim: busy });
  const r = await geocoder.selfTest({});
  assert.deepEqual(r.providers.map(p => [p.provider, p.ok]), [['photon', true], ['nominatim', false]]);
  assert.match(r.providers[1].error, /busy/);
});

test('GET /api/location/geocode', async (t) => {
  process.env.ENABLE_LOCATION_TRACKING = 'false';
  process.env.GEOCODER = 'mock';
  const { baseUrl, stop } = await startTestServer();
  t.after(async () => { delete process.env.ENABLE_LOCATION_TRACKING; delete process.env.GEOCODER; geocoder._setHttp(null); geocoder._reset(); await stop(); });
  const admin = await login(baseUrl, 'admin', 'admin123');
  const ravi = await createMember(baseUrl, admin, 'ravi', 'Ravi Kumar', 'Site');
  const G = (p, tok) => api(baseUrl, p, { token: tok });

  await t.test('hidden while tracking is switched off; needs a login', async () => {
    assert.equal((await G('/api/location/geocode?q=baner', admin)).status, 404);
    process.env.ENABLE_LOCATION_TRACKING = 'true';
    assert.equal((await api(baseUrl, '/api/location/geocode?q=baner')).status, 401);
  });

  await t.test('saved places (by name or project) come first, then streets; coordinates and links work', async () => {
    assert.equal((await api(baseUrl, '/api/location/places', { method: 'POST', token: admin, body: { name: 'Tower B', kind: 'site', lat: 18.561, lng: 73.789, radiusM: 60, project: 'Baner Heights' } })).status, 200);
    const r = await G('/api/location/geocode?q=Baner&lat=18.55&lng=73.78', ravi);
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.results.map(x => [x.name, !!x.saved]), [['Tower B', true], ['Baner', false], ['Balewadi High Street', false]]);
    assert.equal((await G('/api/location/geocode?q=heights%20tower&saved=1', ravi)).data.results[0].name, 'Tower B');
    assert.equal((await G('/api/location/geocode?q=to', ravi)).data.provider, 'saved', 'under 3 letters: saved places only');
    const link = await G(`/api/location/geocode?q=${encodeURIComponent('https://www.google.com/maps/@18.5204,73.8567,17z')}`, ravi);
    assert.deepEqual([link.data.results[0].lat, link.data.results[0].lng, link.data.provider], [18.5204, 73.8567, 'typed']);
    assert.equal((await G('/api/location/me', ravi)).data.map.search, 'mock');
  });

  await t.test('a project with no place yet gets advice instead of "nothing found"', async () => {
    assert.equal((await api(baseUrl, '/api/projects', { method: 'POST', token: admin, body: { name: 'Equinox Residency' } })).status, 200);
    const r = await G('/api/location/geocode?q=equinox', ravi);
    assert.deepEqual(r.data.results, []); assert.match(r.data.note, /"Equinox Residency" is a project in the app but has no place on the map yet/);
  });

  await t.test('street search down → saved places still returned with a note (never an error)', async () => {
    process.env.GEOCODER = 'photon';
    fakeServices({ photon: busy, nominatim: busy });
    const r = await G('/api/location/geocode?q=tower%20b', ravi);
    assert.equal(r.status, 200);
    assert.equal(r.data.results[0].name, 'Tower B'); assert.match(r.data.note, /not answering right now/);
    process.env.GEOCODER = 'mock';
  });

  await t.test('admin can test the services; others cannot', async () => {
    assert.equal((await G('/api/location/geocode/test', ravi)).status, 403);
    const r = await G('/api/location/geocode/test?q=wakad', admin);
    assert.equal(r.status, 200); assert.equal(r.data.providers[0].provider, 'mock'); assert.equal(r.data.providers[0].ok, true);
  });

  await t.test('heavy use: after 80 street lookups in 5 minutes only saved places are returned', async () => {
    let last;
    for (let i = 0; i < 80; i++) last = await G(`/api/location/geocode?q=shivaji${i}`, admin);
    assert.equal(last.status, 200);
    const over = await G('/api/location/geocode?q=tower%20b', admin);
    assert.equal(over.status, 200); assert.equal(over.data.provider, 'saved'); assert.match(over.data.note, /Too many searches/);
    assert.equal(over.data.results[0].name, 'Tower B');
    assert.notEqual((await G('/api/location/geocode?q=wakad', ravi)).data.provider, 'saved', 'another person is not affected');
  });
});
