// Porter screenshot → filled-in delivery (AI_PROVIDER=mock reads the "image" bytes as text).
const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');

test('a Porter screenshot fills in only what it shows; everything else stays empty', async (t) => {
  process.env.AI_PROVIDER = 'mock';
  const { baseUrl, stop } = await startTestServer();
  t.after(() => stop());
  const admin = await login(baseUrl, 'admin', 'admin123');
  const buyer = await createMember(baseUrl, admin, 'shot.buy', 'Buyer', 'Purchase Department');
  await createMember(baseUrl, admin, 'shot.store', 'Store Keeper', 'Store Department');
  const store = await login(baseUrl, 'shot.store', 'TestPass123');
  const P = (tok, path, body) => api(baseUrl, path, { method: 'POST', token: tok, body });
  assert.equal((await P(buyer, '/api/deliveries', { title: 'Cement', expected_at: futureDate(1), project: 'Mihir Amara', receivers: ['shot.store'] })).status, 200);
  const text = 'Porter\nCRN 2840194477\nDriver: Ramesh Pawar\n+91 98765 43210\nVehicle: Tata Ace\nMH 12 AB 1234\nPickup: Kratex Tradetech, Bhosari\nDrop: Mihir Amara, Wakad\n2026-12-01 14:30\nFare ₹1,240\nGoods: Tiles 400 boxes';
  const image = 'data:image/png;base64,' + Buffer.from(text).toString('base64');
  assert.equal((await P(store, '/api/deliveries/read-screenshot', { image })).status, 403, 'only people who add deliveries');
  assert.equal((await P(buyer, '/api/deliveries/read-screenshot', { image: 'data:text/plain;base64,eA==' })).status, 400);
  const r = await P(buyer, '/api/deliveries/read-screenshot', { image });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const f = r.data.fields;
  assert.equal(f.porter_order_id, 'CRN 2840194477'); assert.equal(f.vehicle_no, 'MH 12 AB 1234'); assert.equal(f.driver_name, 'Ramesh Pawar');
  assert.equal(f.driver_phone, '9876543210'); assert.equal(f.transport, 'Porter'); assert.equal(f.project, 'Mihir Amara');
  assert.equal(f.expected_date, '2026-12-01'); assert.equal(f.expected_time, '14:30'); assert.equal(f.title, 'Tiles 400 boxes');
  assert.equal(f.site_location, 'Mihir Amara, Wakad');
  assert.equal(f.receivers, undefined, 'nobody is guessed'); assert.equal(f.vendor, undefined, 'no vendor guessed from the pickup');
  assert.match(f.description, /Pickup: Kratex Tradetech, Bhosari/); assert.match(f.description, /Porter fare: ₹1240/);
  // A screenshot with only a vehicle number and the locations fills only those.
  const part = await P(buyer, '/api/deliveries/read-screenshot', { image: 'data:image/png;base64,' + Buffer.from('MH 14 XY 4321\nPickup: Chakan depot\nDrop: Nyati Equinox gate 2').toString('base64') });
  assert.deepEqual(Object.keys(part.data.fields).sort(), ['description', 'project', 'site_location', 'transport', 'vehicle_no']);
  assert.equal(part.data.fields.title, undefined); assert.equal(part.data.fields.expected_date, undefined);
  const d = await P(buyer, '/api/deliveries', { ...f, receivers: ['shot.store'], expected_at: `${f.expected_date}T${f.expected_time}`, attachments: [{ name: 'porter.png', data: image }] });
  assert.equal(d.status, 200, JSON.stringify(d.data));
});
