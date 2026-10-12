const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember } = require('../testlib/helpers');

test('Company chat: every department room, @person and @[department] tags', async (t) => {
  const { baseUrl, stop } = await startTestServer();
  t.after(() => stop());
  const admin = await login(baseUrl, 'admin', 'admin123');
  const est1 = await createMember(baseUrl, admin, 'chat.est1', 'Est One', 'Estimation Department');
  const est2 = await createMember(baseUrl, admin, 'chat.est2', 'Est Two', 'Estimation Department');
  const pur = await createMember(baseUrl, admin, 'chat.pur', 'Pur Chase', 'Purchase Department');
  const site = await createMember(baseUrl, admin, 'chat.site', 'Site Guy', 'Site');
  const notifs = async (tok) => (await api(baseUrl, '/api/notifications', { token: tok })).data.items.filter(n => n.type === 'chat_mention');
  const post = (tok, room, message) => api(baseUrl, `/api/chat/rooms/${encodeURIComponent(room)}/messages`, { method: 'POST', token: tok, body: { message } });

  await t.test('rooms: All Company + one per department, visible to everyone', async () => {
    const rooms = (await api(baseUrl, '/api/chat/rooms', { token: site })).data;
    assert.equal(rooms[0].key, 'general');
    for (const d of ['Estimation Department', 'Purchase Department', 'Site']) assert.ok(rooms.some(r => r.key === `dept:${d}`), d);
    assert.equal(rooms.find(r => r.key === 'dept:Site').mine, true);
  });

  await t.test('anyone can post in any department room (site → estimation)', async () => {
    const r = await post(site, 'dept:Estimation Department', 'Need slab 3 quantities by evening');
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const msgs = (await api(baseUrl, `/api/chat/rooms/${encodeURIComponent('dept:Estimation Department')}/messages`, { token: pur })).data.messages;
    assert.equal(msgs.at(-1).message, 'Need slab 3 quantities by evening'); assert.equal(msgs.at(-1).by_team, 'Site');
  });

  await t.test('@person tags notify that person (not the sender); unknown names ignored', async () => {
    const r = await post(pur, 'general', '@chat.est1 please share the railing BOQ @nobody.here');
    assert.deepEqual(r.data.message.mentions, ['chat.est1']); assert.equal(r.data.notified, 1);
    const n = await notifs(est1);
    assert.equal(n.length, 1); assert.match(n[0].message, /Pur Chase tagged you in All Company chat/); assert.equal(n[0].chat_room, 'general');
    assert.equal((await notifs(pur)).length, 0);
  });

  await t.test('@[Department] tags notify every member of that department', async () => {
    const r = await post(site, 'dept:Purchase Department', 'Cement shortage at Wing 2A — @[estimation department] please recheck and @chat.pur arrange');
    assert.deepEqual(r.data.message.mention_teams, ['Estimation Department']);
    const users = (await api(baseUrl, '/api/users/directory', { token: admin })).data;
    const estimation = users.filter(u => u.team === 'Estimation Department').length;
    assert.ok(estimation >= 2);
    assert.equal(r.data.notified, estimation + 1, 'every Estimation member + chat.pur');
    assert.equal((await notifs(est2)).length, 1);
  });

  await t.test('@everyone only for Admin/Directors', async () => {
    assert.equal((await post(site, 'general', '@everyone meeting at 5')).status, 403);
    const r = await post(admin, 'general', '@everyone safety audit tomorrow 9 am');
    assert.equal(r.status, 200); assert.ok(r.data.notified >= 4);
  });

  await t.test('unread counts per room, with tags; reading clears them', async () => {
    const before = (await api(baseUrl, '/api/chat/unread', { token: est1 })).data;
    assert.ok(before.unread >= 3); assert.ok(before.mentions >= 2);
    const rooms = (await api(baseUrl, '/api/chat/rooms', { token: est1 })).data;
    for (const r of rooms.filter(x => x.unread)) await api(baseUrl, `/api/chat/rooms/${encodeURIComponent(r.key)}/read`, { method: 'POST', token: est1, body: { lastId: r.last.id } });
    assert.deepEqual((await api(baseUrl, '/api/chat/unread', { token: est1 })).data, { unread: 0, mentions: 0 });
    const own = (await api(baseUrl, '/api/chat/unread', { token: site })).data;
    assert.ok(own.unread >= 1, 'others\' messages count; own do not');
  });

  await t.test('delete own message; others cannot; Admin can (audited)', async () => {
    const m = (await post(est2, 'general', 'typo message')).data.message;
    assert.equal((await api(baseUrl, `/api/chat/messages/${m.id}`, { method: 'DELETE', token: site })).status, 403);
    assert.equal((await api(baseUrl, `/api/chat/messages/${m.id}`, { method: 'DELETE', token: est2 })).status, 200);
    const shown = (await api(baseUrl, '/api/chat/rooms/general/messages', { token: site })).data.messages.find(x => x.id === m.id);
    assert.equal(shown.message, null); assert.ok(shown.deleted_at);
    const m2 = (await post(site, 'general', 'off-topic')).data.message;
    assert.equal((await api(baseUrl, `/api/chat/messages/${m2.id}`, { method: 'DELETE', token: admin })).status, 200);
    const audit = (await api(baseUrl, '/api/audit-log?format=page&action=chat_message_deleted', { token: admin })).data.entries;
    assert.equal(audit.length, 1);
  });

  await t.test('validation, unknown rooms, paging, flood limit', async () => {
    assert.equal((await post(site, 'general', '   ')).status, 400);
    assert.equal((await post(site, 'general', 'x'.repeat(2001))).status, 400);
    assert.equal((await post(site, 'dept:Nope', 'hi')).status, 404);
    for (let i = 0; i < 25; i++) await post(est2, 'dept:Site', `m${i}`);
    const p1 = (await api(baseUrl, `/api/chat/rooms/${encodeURIComponent('dept:Site')}/messages?limit=10`, { token: site })).data;
    assert.equal(p1.messages.length, 10); assert.equal(p1.hasMore, true); assert.equal(p1.messages.at(-1).message, 'm24');
    const p2 = (await api(baseUrl, `/api/chat/rooms/${encodeURIComponent('dept:Site')}/messages?limit=10&before=${p1.messages[0].id}`, { token: site })).data;
    assert.equal(p2.messages.at(-1).message, 'm14');
    let limited = false;
    for (let i = 0; i < 10; i++) if ((await post(est2, 'dept:Site', 'flood')).status === 429) limited = true;
    assert.ok(limited, '30 messages a minute per person');
    assert.equal((await api(baseUrl, '/api/chat/rooms/general/messages')).status, 401, 'login required');
  });
});
