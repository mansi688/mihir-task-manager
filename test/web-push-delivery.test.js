// Proves the whole push chain without a real phone: a local stand-in for the browser's push
// service receives what the server sends, and decrypts it with the "device's" private key exactly
// like Chrome/Android would — so this checks signing, encryption, headers and content end to end.
const crypto = require('crypto');
const https = require('https');
const { execSync } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
// Real push services are HTTPS; the stand-in uses a throwaway self-signed certificate.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-'));
execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${certDir}/k.pem -out ${certDir}/c.pem -days 1 -subj /CN=127.0.0.1 2>/dev/null`);
const webpush = require('web-push');
const keys = webpush.generateVAPIDKeys();
process.env.VAPID_PUBLIC_KEY = keys.publicKey;
process.env.VAPID_PRIVATE_KEY = keys.privateKey;
const test = require('node:test');
const assert = require('node:assert/strict');
const ece = require('http_ece');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');

test('Web Push: a new task reaches the person\'s device, readable, with urgency + expiry set', async (t) => {
  // the "device": its own encryption keys, as a browser would generate on subscribe
  const device = crypto.createECDH('prime256v1'); device.generateKeys();
  const authSecret = crypto.randomBytes(16);
  const received = [];
  const pushService = https.createServer({ key: fs.readFileSync(`${certDir}/k.pem`), cert: fs.readFileSync(`${certDir}/c.pem`) }, (req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c));
    req.on('end', () => { received.push({ headers: req.headers, body: Buffer.concat(chunks) }); res.writeHead(201); res.end(); });
  });
  await new Promise(r => pushService.listen(0, r));
  const endpoint = `https://127.0.0.1:${pushService.address().port}/push/device-1`;
  const { baseUrl, stop } = await startTestServer();
  t.after(() => { stop(); pushService.close(); });

  const admin = await login(baseUrl, 'admin', 'admin123');
  const worker = await createMember(baseUrl, admin, 'push.user', 'Push User', 'Site');
  const pk = await api(baseUrl, '/api/push/vapid-public-key', { token: worker });
  assert.equal(pk.data.publicKey, keys.publicKey, 'server hands out its public key');
  const sub = { endpoint, keys: { p256dh: device.getPublicKey().toString('base64url'), auth: authSecret.toString('base64url') } };
  assert.equal((await api(baseUrl, '/api/push/subscribe', { method: 'POST', token: worker, body: { subscription: sub } })).status, 200);
  const st = await api(baseUrl, '/api/push/status', { method: 'POST', token: worker, body: { endpoint } });
  assert.deepEqual([st.data.configured, st.data.subscribed], [true, true]);

  await api(baseUrl, '/api/tasks', { method: 'POST', token: admin, body: { title: 'Pour slab B2', deadline: futureDate(2), assignedToList: ['push.user'] } });
  for (let i = 0; i < 50 && received.length === 0; i++) await new Promise(r => setTimeout(r, 100));
  assert.equal(received.length, 1, 'exactly one push sent to the device');
  const msg = received[0];
  assert.equal(msg.headers['content-encoding'], 'aes128gcm');
  assert.equal(msg.headers.urgency, 'high');
  assert.equal(msg.headers.ttl, '86400');
  assert.match(msg.headers.authorization, /^vapid t=.+, k=/, 'signed with the server\'s VAPID key');
  const plain = ece.decrypt(msg.body, { version: 'aes128gcm', privateKey: device, authSecret });
  const payload = JSON.parse(plain.toString('utf8'));
  assert.match(payload.body, /Pour slab B2/);
  assert.ok(payload.taskId, 'tapping it can open the task');

  // after the person logs out on that device, nothing more is sent there
  await api(baseUrl, '/api/push/unsubscribe', { method: 'POST', token: worker, body: { endpoint } });
  await api(baseUrl, '/api/tasks', { method: 'POST', token: admin, body: { title: 'Second task', deadline: futureDate(2), assignedToList: ['push.user'] } });
  await new Promise(r => setTimeout(r, 800));
  assert.equal(received.length, 1, 'unsubscribed device gets nothing');
});
