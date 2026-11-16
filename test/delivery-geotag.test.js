const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('delivery photos keep where they were taken', async (t) => {
  const { baseUrl, stop } = await startTestServer();
  t.after(stop);
  const admin = await login(baseUrl, 'admin', 'admin123');
  const site = await createMember(baseUrl, admin, 'geo.site', 'Geo Site', 'Execution Department');
  const P = (tok, path, body) => api(baseUrl, path, { method: 'POST', token: tok, body });
  const c = await P(admin, '/api/deliveries', { title: 'Cement 50 bags', expected_at: futureDate(1), receivers: ['geo.site'] });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  const id = c.data.id || (c.data.delivery && c.data.delivery.id);
  const r = await P(site, `/api/deliveries/${id}/proof`, { stage: 'delivered', attachments: [
    { name: 'a.jpg', data: PNG, geo: { lat: 18.520431, lng: 73.856743, acc: 12.4 } },
    { name: 'b.jpg', data: PNG, geo: { lat: 999, lng: 5 } },
    { name: 'c.jpg', data: PNG },
  ], takenAt: [new Date().toISOString()] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const d = (await api(baseUrl, '/api/deliveries', { token: site })).data.items.find(x => x.id === id);
  const photos = d.files.filter(f => f.kind === 'delivery_proof');
  assert.equal(photos.length, 3);
  assert.deepEqual([photos[0].geo_lat, photos[0].geo_lng, photos[0].geo_acc], [18.520431, 73.856743, 12]);
  assert.equal(photos[1].geo_lat, null, 'impossible coordinates are not kept');
  assert.equal(photos[2].geo_lat, null);
});
