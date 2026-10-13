const test = require('node:test');
const assert = require('node:assert/strict');
const geocoder = require('../backend/location/geocode');
const { startTestServer, api, login, createMember } = require('../testlib/helpers');

test('parseCoordinates reads typed coordinates and map links', () => {
  const p = geocoder.parseCoordinates;
  assert.deepEqual([p('18.5590, 73.7868').lat, p('18.5590, 73.7868').lng], [18.559, 73.7868]);
  assert.equal(p('18.5590 73.7868').lng, 73.7868);
  const g = p('https://www.google.com/maps/place/Baner/@18.5600,73.7800,15z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d18.559!4d73.7868');
  assert.deepEqual([g.lat, g.lng], [18.559, 73.7868], 'the !3d/!4d pin wins over the @ view centre');
  assert.deepEqual([p('https://www.google.com/maps/@18.5204,73.8567,17z').lat, p('https://maps.google.com/?q=18.52,73.85').lng], [18.5204, 73.85]);
  const dms = p(`18°33'32.4"N 73°47'12.5"E`);
  assert.ok(Math.abs(dms.lat - 18.559) < 1e-4 && Math.abs(dms.lng - 73.78681) < 1e-4);
  assert.ok(p(`33°52'0"S 151°12'0"E`).lat < 0, 'south is negative');
  assert.equal(p('Baner Pune'), null);
  assert.equal(p('12 34'), null, 'whole numbers alone are not coordinates');
  assert.equal(p('95.1, 73.2'), null, 'latitude out of range');
  assert.equal(p('0.0, 0.0'), null, '0,0 is a GPS error, not a place');
});

test('geocode: providers, off switch and cache', async () => {
  const env = { GEOCODER: 'mock' };
  const r = await geocoder.geocode('baner', { env });
  assert.equal(r.provider, 'mock'); assert.equal(r.results[0].name, 'Baner'); assert.equal(r.results[0].source, 'Demo search');
  assert.equal((await geocoder.geocode('baner', { env })).cached, true);
  assert.deepEqual((await geocoder.geocode('b', { env })).results, [], 'one letter is not searched');
  const off = await geocoder.geocode('baner', { env: { GEOCODER: 'off' } });
  assert.deepEqual(off.results, []); assert.match(off.note, /switched off/);
  assert.equal((await geocoder.geocode('18.55, 73.78', { env: { GEOCODER: 'off' } })).results[0].type, 'coordinates', 'coordinates work even when search is off');
  assert.equal(geocoder.providerName({}), 'nominatim');
  assert.equal(geocoder.providerName({ GEOCODER: 'nonsense' }), 'nominatim');
  await assert.rejects(geocoder.geocode('anything', { env: { GEOCODER: 'maptiler' } }), (e) => e.status === 503 && /GEOCODER_KEY/.test(e.message));
});

test('GET /api/location/geocode', async (t) => {
  process.env.ENABLE_LOCATION_TRACKING = 'false';
  process.env.GEOCODER = 'mock';
  const { baseUrl, stop } = await startTestServer();
  t.after(async () => { delete process.env.ENABLE_LOCATION_TRACKING; delete process.env.GEOCODER; await stop(); });
  const admin = await login(baseUrl, 'admin', 'admin123');
  const ravi = await createMember(baseUrl, admin, 'ravi', 'Ravi Kumar', 'Site');

  await t.test('hidden while tracking is switched off; needs a login', async () => {
    assert.equal((await api(baseUrl, '/api/location/geocode?q=baner', { token: admin })).status, 404);
    process.env.ENABLE_LOCATION_TRACKING = 'true';
    assert.equal((await api(baseUrl, '/api/location/geocode?q=baner')).status, 401);
  });

  await t.test('finds places, reads coordinates and Google links; /me reports the provider', async () => {
    const r = await api(baseUrl, '/api/location/geocode?q=Wakad&lat=18.55&lng=73.78', { token: ravi });
    assert.equal(r.status, 200); assert.equal(r.data.results[0].name, 'Wakad');
    const link = await api(baseUrl, `/api/location/geocode?q=${encodeURIComponent('https://www.google.com/maps/@18.5204,73.8567,17z')}`, { token: ravi });
    assert.deepEqual([link.data.results[0].lat, link.data.results[0].lng, link.data.provider], [18.5204, 73.8567, 'typed']);
    assert.equal((await api(baseUrl, '/api/location/me', { token: ravi })).data.map.search, 'mock');
  });

  await t.test('at most 40 searches per person in 5 minutes', async () => {
    let last;
    for (let i = 0; i < 40; i++) last = await api(baseUrl, `/api/location/geocode?q=shivaji${i}`, { token: admin });
    assert.equal(last.status, 200);
    const over = await api(baseUrl, '/api/location/geocode?q=shivajinagar', { token: admin });
    assert.equal(over.status, 429); assert.match(over.data.error, /Too many searches/);
    assert.equal((await api(baseUrl, '/api/location/geocode?q=baner', { token: ravi })).status, 200, 'another person is not affected');
  });
});
