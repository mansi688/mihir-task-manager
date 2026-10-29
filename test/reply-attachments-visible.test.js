const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');
const JPG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

test('Comment with photos only: files listed on the comment and in history, viewable by people on the task, not by others', async (t) => {
  const { baseUrl, stop } = await startTestServer();
  t.after(stop);
  const admin = await login(baseUrl, 'admin', 'admin123');
  const owner = await createMember(baseUrl, admin, 'tanishq.x', 'Tanishq', 'Purchase Department');
  const designer = await createMember(baseUrl, admin, 'ruchita.x', 'Ruchita', 'Design Department');
  const watcher = await createMember(baseUrl, admin, 'komal.x', 'Komal', 'Purchase Department');
  const outsider = await createMember(baseUrl, admin, 'out.x', 'Outsider', 'Sales Department');
  const task = (await api(baseUrl, '/api/tasks', { method: 'POST', token: owner, body: { title: 'Carpet sample', deadline: futureDate(), assignedToList: ['ruchita.x'] } })).data;
  assert.equal((await api(baseUrl, `/api/tasks/${task.id}/followup`, { method: 'POST', token: owner, body: { usernames: ['komal.x'] } })).status, 200);
  // photo only, no text
  const r = await api(baseUrl, `/api/tasks/${task.id}/reply`, { method: 'POST', token: designer, body: { message: '', attachments: [{ name: '306- L-Grey.jpg', data: JPG }, { name: 'shot.jpg', data: JPG }] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const mine = (await api(baseUrl, '/api/tasks/mine', { token: owner })).data;
  const tk = mine.find(x => x.id === task.id);
  const reply = tk.replies.find(x => x.by_username === 'ruchita.x');
  assert.deepEqual(reply.attachments.map(f => f.name), ['306- L-Grey.jpg', 'shot.jpg']);
  // history row names the files (not blank) and points at the comment
  const ev = (await api(baseUrl, `/api/tasks/${task.id}/events`, { token: owner })).data;
  const list = Array.isArray(ev) ? ev : ev.events;
  const row = list.find(e => e.event_type === 'ATTACHMENT_ADDED');
  assert.ok(row, JSON.stringify(list.map(e => e.event_type)));
  assert.match(row.details, /Attached 306- L-Grey\.jpg, shot\.jpg/);
  assert.equal(String((row.metadata || {}).reply_id), String(reply.id));
  // Task updates: the kept-informed person's notification carries the task's latest update (with the file count)
  const nt = (await api(baseUrl, '/api/notifications', { token: watcher })).data;
  assert.ok(nt.items.some(n => n.task_id === task.id && n.type === 'task_reply'));
  assert.equal(nt.tasks[task.id].lastUpdate.by, 'ruchita.x'); assert.equal(nt.tasks[task.id].lastUpdate.files, 2);
  // the file opens for the creator, the person kept informed, Admin — not for someone not on the task
  const url = `/api/tasks/${task.id}/replies/${reply.id}/files/${reply.attachments[0].id}`;
  for (const tok of [owner, watcher, admin, designer]) assert.equal((await api(baseUrl, url, { token: tok })).data.data, JPG);
  assert.equal((await api(baseUrl, url, { token: outsider })).status, 403);
});
