const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember } = require('../testlib/helpers');

const du = (s) => 'data:text/plain;base64,' + Buffer.from(s).toString('base64');

test('private chats: only the people in them can see them', async (t) => {
  const { baseUrl, stop } = await startTestServer();
  t.after(() => stop());
  const admin = await login(baseUrl, 'admin', 'admin123');
  // ravi and meena are both AI Engineers; only ravi is tagged.
  const asha = await createMember(baseUrl, admin, 'asha', 'Asha Shah', 'Site');
  const ravi = await createMember(baseUrl, admin, 'ravi', 'Ravi Kumar', 'AI Engineer');
  const meena = await createMember(baseUrl, admin, 'meena', 'Meena Iyer', 'AI Engineer');
  const omar = await createMember(baseUrl, admin, 'omar', 'Omar Khan', 'Design');
  const P = (p, token, body) => api(baseUrl, p, { method: 'POST', token, body });
  const G = (p, token) => api(baseUrl, p, { token });
  const roomKeys = async (token) => (await G('/api/chat/rooms', token)).data.map(r => r.key);
  let room;

  await t.test('starting a private chat: visible to its members only — not their department, not Admin', async () => {
    assert.equal((await P('/api/chat/private', asha, { members: [] })).status, 400, 'needs at least one person');
    const c = await P('/api/chat/private', asha, { name: 'Model review', members: ['ravi'] });
    assert.equal(c.status, 200, JSON.stringify(c.data));
    room = c.data.key;
    assert.match(room, /^p:\d+$/);
    assert.deepEqual(c.data.members.map(m => m.username).sort(), ['asha', 'ravi']);
    assert.ok((await roomKeys(asha)).includes(room));
    assert.ok((await roomKeys(ravi)).includes(room));
    for (const outsider of [meena, omar, admin]) assert.ok(!(await roomKeys(outsider)).includes(room), 'outsiders do not see it in their list');
    assert.ok((await G('/api/notifications', ravi)).data.items.some(n => n.chat_room === room), 'ravi is told he was added');
  });

  await t.test('outsiders cannot read, post, download files, mark read or delete', async () => {
    const sent = await P('/api/chat/messages', asha, { room, message: 'secret plan', attachments: [{ name: 'plan.txt', data: du('x') }] });
    assert.equal(sent.status, 200);
    const msgs = (await G(`/api/chat/messages?room=${encodeURIComponent(room)}`, ravi)).data;
    assert.equal(msgs[0].message, 'secret plan');
    const fileId = msgs[0].files[0].id;
    for (const outsider of [meena, omar, admin]) {
      assert.equal((await G(`/api/chat/messages?room=${encodeURIComponent(room)}`, outsider)).status, 403);
      assert.equal((await P('/api/chat/messages', outsider, { room, message: 'let me in' })).status, 403);
      assert.equal((await G(`/api/chat/files/${fileId}`, outsider)).status, 403);
      assert.equal((await P('/api/chat/read', outsider, { room, lastId: 999 })).status, 403);
      assert.equal((await api(baseUrl, `/api/chat/messages/${sent.data.id}`, { method: 'DELETE', token: outsider })).status, 404);
      assert.equal((await P(`/api/chat/private/${room.slice(2)}/members`, outsider, { members: ['omar'] })).status, 404, 'cannot add themselves');
    }
  });

  await t.test('department and @everyone tags do nothing in a private chat; tagging a person adds them', async () => {
    const before = (await G('/api/notifications', meena)).data.items.length;
    const d = await P('/api/chat/messages', asha, { room, message: 'hey @[AI Engineer] and @AI and @everyone' });
    assert.deepEqual(d.data.departments, []); assert.equal(d.data.everyone, false);
    assert.equal((await G('/api/notifications', meena)).data.items.length, before, 'meena is not notified');
    assert.ok(!(await roomKeys(meena)).includes(room), 'and still cannot see it');
    const tag = await P('/api/chat/messages', ravi, { room, message: '@omar can you check the drawing?' });
    assert.deepEqual(tag.data.addedToPrivate, ['omar']);
    assert.ok((await roomKeys(omar)).includes(room), 'tagged person is now a member');
    assert.equal((await G(`/api/chat/messages?room=${encodeURIComponent(room)}`, omar)).status, 200);
    assert.ok(!(await roomKeys(meena)).includes(room), 'untagged colleague still cannot see it');
  });

  await t.test('members can add people and leave; the last one out deletes the chat', async () => {
    const add = await P(`/api/chat/private/${room.slice(2)}/members`, ravi, { members: ['meena'] });
    assert.deepEqual(add.data.added, ['meena']);
    for (const who of [asha, ravi, omar, meena]) assert.equal((await P(`/api/chat/private/${room.slice(2)}/leave`, who)).status, 200);
    assert.ok(!(await roomKeys(asha)).includes(room));
    assert.equal((await G(`/api/chat/messages?room=${encodeURIComponent(room)}`, asha)).status, 403);
  });
});
