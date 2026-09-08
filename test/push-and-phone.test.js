const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember } = require('../testlib/helpers');

test('push notification subscription management', async (t) => {
  const { baseUrl, stop } = startTestServer();
  t.after(() => stop());
  const adminToken = await login(baseUrl, 'admin', 'admin123');

  await t.test('the VAPID public key endpoint reports unconfigured when no keys are set (this test env\'s default)', async () => {
    const res = await api(baseUrl, '/api/push/vapid-public-key');
    assert.equal(res.status, 200);
    assert.equal(res.data.publicKey, null, 'without VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY set, this must clearly report unconfigured, not error');
  });

  await t.test('subscribing requires a well-formed subscription object', async () => {
    const missingEverything = await api(baseUrl, '/api/push/subscribe', { method: 'POST', token: adminToken, body: {} });
    assert.equal(missingEverything.status, 400);

    const missingKeys = await api(baseUrl, '/api/push/subscribe', { method: 'POST', token: adminToken, body: { subscription: { endpoint: 'https://example.com/push/abc' } } });
    assert.equal(missingKeys.status, 400, 'a subscription with no keys must be rejected');
  });

  await t.test('a well-formed subscription is accepted and can be unsubscribed', async () => {
    const validSub = { endpoint: 'https://fcm.googleapis.com/fcm/send/test-endpoint-123', keys: { p256dh: 'test-p256dh-key', auth: 'test-auth-key' } };
    const subscribeRes = await api(baseUrl, '/api/push/subscribe', { method: 'POST', token: adminToken, body: { subscription: validSub } });
    assert.equal(subscribeRes.status, 200);

    const unsubscribeRes = await api(baseUrl, '/api/push/unsubscribe', { method: 'POST', token: adminToken, body: { endpoint: validSub.endpoint } });
    assert.equal(unsubscribeRes.status, 200);
  });

  await t.test('subscribing again with the same endpoint updates rather than duplicates', async () => {
    const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/dup-test', keys: { p256dh: 'key-1', auth: 'auth-1' } };
    await api(baseUrl, '/api/push/subscribe', { method: 'POST', token: adminToken, body: { subscription: sub } });
    const secondSub = { endpoint: sub.endpoint, keys: { p256dh: 'key-2', auth: 'auth-2' } };
    const res = await api(baseUrl, '/api/push/subscribe', { method: 'POST', token: adminToken, body: { subscription: secondSub } });
    assert.equal(res.status, 200, 'resubscribing with the same endpoint (e.g. browser refreshed its own subscription) must succeed, not conflict');
  });

  await t.test('an unauthenticated request cannot subscribe on someone else\'s behalf', async () => {
    const res = await api(baseUrl, '/api/push/subscribe', { method: 'POST', body: { subscription: { endpoint: 'x', keys: { p256dh: 'a', auth: 'b' } } } });
    assert.equal(res.status, 401);
  });
});

test('phone number (WhatsApp) profile update', async (t) => {
  const { baseUrl, stop } = startTestServer();
  t.after(() => stop());
  const adminToken = await login(baseUrl, 'admin', 'admin123');
  const memberToken = await createMember(baseUrl, adminToken, 'phonetest', 'Phone Test');

  await t.test('a valid E.164 phone number is accepted', async () => {
    const res = await api(baseUrl, '/api/auth/update-phone', { method: 'POST', token: memberToken, body: { phone: '+919876543210' } });
    assert.equal(res.status, 200);
    assert.equal(res.data.phone, '+919876543210');
  });

  await t.test('an invalid phone number is rejected', async () => {
    const noCountryCode = await api(baseUrl, '/api/auth/update-phone', { method: 'POST', token: memberToken, body: { phone: '9876543210' } });
    assert.equal(noCountryCode.status, 400, 'a number missing the required + country code must be rejected');

    const garbage = await api(baseUrl, '/api/auth/update-phone', { method: 'POST', token: memberToken, body: { phone: 'not-a-phone-number' } });
    assert.equal(garbage.status, 400);
  });

  await t.test('the phone number is reflected back via /api/auth/me', async () => {
    await api(baseUrl, '/api/auth/update-phone', { method: 'POST', token: memberToken, body: { phone: '+14155552671' } });
    const me = await api(baseUrl, '/api/auth/me', { token: memberToken });
    assert.equal(me.data.phone, '+14155552671');
  });

  await t.test('clearing the phone number back to empty is allowed', async () => {
    const res = await api(baseUrl, '/api/auth/update-phone', { method: 'POST', token: memberToken, body: { phone: '' } });
    assert.equal(res.status, 200);
    assert.equal(res.data.phone, null);
  });
});
