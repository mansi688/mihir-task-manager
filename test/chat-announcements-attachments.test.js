const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');

const du = (s) => 'data:text/plain;base64,' + Buffer.from(s).toString('base64');

test('multiple attachments, chat room and announcements', async (t) => {
  const { baseUrl, stop } = await startTestServer();
  t.after(() => stop());
  const admin = await login(baseUrl, 'admin', 'admin123');
  const alice = await createMember(baseUrl, admin, 'alice', 'Alice Test', 'Site');
  const bob = await createMember(baseUrl, admin, 'bob', 'Bob Test', 'Site');
  const carol = await createMember(baseUrl, admin, 'carol', 'Carol Test', 'Design');
  const P = (p, token, body) => api(baseUrl, p, { method: 'POST', token, body });
  const G = (p, token) => api(baseUrl, p, { token });

  await t.test('a task and a reply can each carry several files, only visible to people on the task', async () => {
    const create = await P('/api/tasks', alice, { title: 'Multi', deadline: futureDate(), assignedToList: ['bob'], attachments: [{ name: 'a.pdf', data: du('a') }, { name: 'b.dwg', data: du('b') }] });
    assert.equal(create.status, 200, JSON.stringify(create.data));
    const id = create.data.id;
    const reply = await P(`/api/tasks/${id}/reply`, bob, { message: 'files', attachments: [{ name: 'c.txt', data: du('c') }, { name: 'd.txt', data: du('d') }] });
    assert.equal(reply.status, 200, JSON.stringify(reply.data));
    const task = (await G('/api/tasks/mine', alice)).data.find(x => x.id === id);
    assert.deepEqual(task.files.map(f => f.name), ['a.pdf', 'b.dwg']);
    assert.deepEqual(task.replies[0].attachments.map(f => f.name), ['c.txt', 'd.txt']);
    const f = await G(`/api/tasks/${id}/files/${task.files[1].id}`, bob);
    assert.equal(f.status, 200); assert.equal(f.data.name, 'b.dwg');
    const rf = await G(`/api/tasks/${id}/replies/${task.replies[0].id}/files/${task.replies[0].attachments[0].id}`, alice);
    assert.equal(rf.status, 200); assert.equal(rf.data.name, 'c.txt');
    assert.equal((await G(`/api/tasks/${id}/files/${task.files[0].id}`, carol)).status, 403, 'someone not on the task cannot download');
    assert.equal((await G(`/api/tasks/${id}/replies/999999/files/${task.replies[0].attachments[0].id}`, alice)).status, 404, 'file must belong to that reply');
  });

  await t.test('attachment limits and blocked file types still apply per file', async () => {
    const eleven = Array.from({ length: 11 }, (_, i) => ({ name: `f${i}.txt`, data: du('x') }));
    assert.equal((await P('/api/tasks', alice, { title: 'x', deadline: futureDate(), attachments: eleven })).status, 400);
    const bad = await P('/api/tasks', alice, { title: 'x', deadline: futureDate(), attachments: [{ name: 'ok.txt', data: du('x') }, { name: 'bad.exe', data: du('x') }] });
    assert.equal(bad.status, 400); assert.match(bad.data.error, /bad\.exe/);
  });

  await t.test('chat rooms: General for everyone, department rooms only for that department (Admin sees all)', async () => {
    assert.deepEqual((await G('/api/chat/rooms', alice)).data.map(r => r.key), ['general', 'team:Site']);
    assert.deepEqual((await G('/api/chat/rooms', carol)).data.map(r => r.key), ['general', 'team:Design']);
    const adminRooms = (await G('/api/chat/rooms', admin)).data.map(r => r.key);
    assert.ok(adminRooms.includes('team:Site') && adminRooms.includes('team:Design'));
    assert.equal((await G('/api/chat/messages?room=team%3ASite', carol)).status, 403);
    assert.equal((await P('/api/chat/messages', carol, { room: 'team:Site', message: 'hi' })).status, 403);
  });

  await t.test('chat messages carry files, @mentions notify only people who can see the room, unread counts work', async () => {
    const sent = await P('/api/chat/messages', alice, { room: 'team:Site', message: 'hi @bob and @carol', attachments: [{ name: 'plan.pdf', data: du('p') }] });
    assert.equal(sent.status, 200);
    assert.deepEqual(sent.data.mentioned, ['bob'], 'carol is not in the Site room, so she is not notified');
    const bobNotes = (await G('/api/notifications', bob)).data.items.filter(n => n.type === 'chat_mention');
    assert.equal(bobNotes.length, 1);
    const rooms = (await G('/api/chat/rooms', bob)).data;
    assert.equal(rooms.find(r => r.key === 'team:Site').unread, 1);
    const msgs = (await G('/api/chat/messages?room=team%3ASite', bob)).data;
    assert.equal(msgs.length, 1); assert.equal(msgs[0].files[0].name, 'plan.pdf');
    assert.equal((await G(`/api/chat/files/${msgs[0].files[0].id}`, bob)).status, 200);
    assert.equal((await G(`/api/chat/files/${msgs[0].files[0].id}`, carol)).status, 403);
    await P('/api/chat/read', bob, { room: 'team:Site', lastId: msgs[0].id });
    assert.equal((await G('/api/chat/rooms', bob)).data.find(r => r.key === 'team:Site').unread, 0);
    assert.equal((await P('/api/chat/messages', alice, { room: 'general', message: '' })).status, 400, 'empty message rejected');
  });

  await t.test('only the author (or Admin) can delete a chat message', async () => {
    const id = (await P('/api/chat/messages', alice, { room: 'general', message: 'oops' })).data.id;
    assert.equal((await api(baseUrl, `/api/chat/messages/${id}`, { method: 'DELETE', token: bob })).status, 403);
    assert.equal((await api(baseUrl, `/api/chat/messages/${id}`, { method: 'DELETE', token: alice })).status, 200);
    const m = (await G('/api/chat/messages?room=general', bob)).data.find(x => x.id === id);
    assert.ok(m.deleted_at); assert.equal(m.message, null);
  });

  await t.test('announcements: Admin posts, members cannot, everyone is notified and can read', async () => {
    assert.equal((await P('/api/announcements', alice, { title: 'Nope' })).status, 403);
    const post = await P('/api/announcements', admin, { title: 'Holiday', body: 'Office closed', category: 'holiday', emoji: '🪔', eventDate: futureDate(3) });
    assert.equal(post.status, 200);
    const list = (await G('/api/announcements', alice)).data;
    assert.equal(list.canPost, false);
    assert.equal(list.items[0].title, 'Holiday'); assert.equal(list.items[0].emoji, '🪔'); assert.equal(list.items[0].event_date, futureDate(3));
    assert.ok((await G('/api/notifications', carol)).data.items.some(n => n.type === 'announcement'));
    assert.equal((await P('/api/announcements', admin, { title: 'x', eventDate: 'not-a-date' })).status, 400);
    assert.equal((await api(baseUrl, `/api/announcements/${post.data.id}`, { method: 'DELETE', token: bob })).status, 403);
    assert.equal((await api(baseUrl, `/api/announcements/${post.data.id}`, { method: 'DELETE', token: admin })).status, 200);
    assert.equal((await G('/api/announcements', alice)).data.items.length, 0);
  });
});
