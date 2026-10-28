const test = require('node:test');
const assert = require('node:assert/strict');
process.env.AI_PROVIDER = 'mock';
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');

test('Assistant commands: show tasks, mark done, approve, send back, follow up, comment, create — confirm-first actions', async (t) => {
  const { baseUrl, stop } = await startTestServer();
  t.after(stop);
  const admin = await login(baseUrl, 'admin', 'admin123');
  const boss = await createMember(baseUrl, admin, 'tanishq.v', 'Tanishq Mutha', 'Purchase Department');
  const ruchita = await createMember(baseUrl, admin, 'ruchita.v', 'Ruchita Thorve', 'Design Department');
  const harsh = await createMember(baseUrl, admin, 'harsh.v', 'Harsh Patil', 'Execution Department');
  const outsider = await createMember(baseUrl, admin, 'other.v', 'Other Person', 'Sales Department');
  const mk = async (title, who, days, project) => (await api(baseUrl, '/api/tasks', { method: 'POST', token: boss, body: { title, deadline: futureDate(days), assignedToList: who, project } })).data.id;
  const carpet = await mk('Carpet sample confirmation', ['ruchita.v'], 3, 'Nyati Equinox');
  const slab = await mk('Slab shuttering check', ['harsh.v'], 1, 'Mihir Amara');
  const tiles = await mk('Tiles vendor follow up', ['harsh.v'], 10, 'Mihir Amara');
  const C = (tok, text) => api(baseUrl, '/api/assistant/command', { method: 'POST', token: tok, body: { text } });

  assert.equal((await api(baseUrl, '/api/features', { token: harsh })).data.assistant, true);
  assert.equal((await C(harsh, '')).status, 400);

  // show my tasks / this week / project / a person's tasks / waiting for approval
  let r = await C(harsh, 'show my tasks');
  assert.equal(r.data.intent, 'show_tasks'); assert.deepEqual(r.data.list.tasks.map(x => x.id).sort(), [slab, tiles].sort());
  assert.match(r.data.reply, /You have 2 pending tasks/);
  r = await C(harsh, 'show my tasks this week');
  assert.deepEqual(r.data.list.tasks.map(x => x.id), [slab]);
  r = await C(boss, 'show Harsh tasks in Amara');
  assert.equal(r.data.list.scope, 'person'); assert.equal(r.data.list.project, 'Mihir Amara'); assert.equal(r.data.list.total, 2);
  assert.match(r.data.reply, /Harsh Patil has 2/);
  assert.equal((await C(outsider, 'show Harsh tasks')).data.list.total, 0, 'only tasks the asker can see');
  // mark done → a confirm card, nothing changed yet
  r = await C(ruchita, 'mark the carpet sample task done');
  assert.equal(r.data.action.kind, 'submit'); assert.equal(r.data.action.task.id, carpet);
  let me = (await api(baseUrl, '/api/tasks/mine', { token: ruchita })).data.find(x => x.id === carpet).assignees.find(a => a.username === 'ruchita.v');
  assert.equal(me.submitted_at, null, 'nothing happens until Confirm');
  assert.equal((await api(baseUrl, `/api/tasks/${carpet}/submit-mine`, { method: 'POST', token: ruchita, body: { note: r.data.action.note } })).status, 200);
  assert.equal((await C(ruchita, 'mark the unknown xyz task done')).data.action, undefined);
  // approve / send back — only for whoever can approve
  r = await C(boss, 'show tasks to approve');
  assert.equal(r.data.list.scope, 'to_approve'); assert.deepEqual(r.data.list.tasks.map(x => x.id), [carpet]);
  r = await C(boss, 'approve Ruchita carpet task');
  assert.equal(r.data.action.kind, 'approve'); assert.equal(r.data.action.username, 'ruchita.v'); assert.equal(r.data.action.task.id, carpet);
  r = await C(boss, 'send back Ruchita carpet task because photos missing');
  assert.equal(r.data.action.kind, 'sendback'); assert.equal(r.data.action.note, 'photos missing');
  assert.equal((await C(harsh, 'approve Ruchita carpet task')).data.action, undefined, 'cannot approve others\' tasks');
  // follow up a person's tasks / comment
  r = await C(boss, 'follow up on Harsh');
  assert.equal(r.data.action.kind, 'followup'); assert.equal(r.data.action.tasks.length, 2);
  r = await C(harsh, 'add comment on slab shuttering: vendor will deliver tomorrow');
  assert.equal(r.data.action.kind, 'comment'); assert.equal(r.data.action.task.id, slab); assert.equal(r.data.action.note, 'vendor will deliver tomorrow');
  // create → handed to the usual message flow
  r = await C(boss, 'create task for Harsh to check the lift tomorrow');
  assert.equal(r.data.intent, 'create_task'); assert.match(r.data.createText, /lift/);
  // nonsense
  assert.equal((await C(harsh, 'banana')).data.intent, 'unknown');
});
