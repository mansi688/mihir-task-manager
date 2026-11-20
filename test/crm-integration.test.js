const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');

const SECRET = 'crm-test-secret-123';
async function crm(baseUrl, path, { method, body, secret } = {}) {
  const res = await fetch(baseUrl + path, {
    method: method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(secret === null ? {} : { 'X-CRM-Secret': secret || SECRET }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null; try { data = await res.json(); } catch (e) { /* empty */ }
  return { status: res.status, data };
}

test('CRM link: secret required, creates one task per complaint through the normal task path, reports status', async (t) => {
  process.env.CRM_INTEGRATION_SECRET = SECRET;
  const { baseUrl, stop } = await startTestServer();
  t.after(async () => { delete process.env.CRM_INTEGRATION_SECRET; await stop(); });
  const admin = await login(baseUrl, 'admin', 'admin123');
  const plumberToken = await createMember(baseUrl, admin, 'suresh.p', 'Suresh Plumber', 'Maintenance');

  // no / wrong secret
  assert.equal((await crm(baseUrl, '/api/integrations/crm/options', { secret: null })).status, 401);
  assert.equal((await crm(baseUrl, '/api/integrations/crm/options', { secret: 'nope' })).status, 401);

  const opts = await crm(baseUrl, '/api/integrations/crm/options');
  assert.equal(opts.status, 200);
  assert.ok(opts.data.projects.includes('Sierra (Tathawade)'));
  assert.ok(opts.data.people.some(p => p.username === 'suresh.p' && p.name === 'Suresh Plumber'));

  // validation comes from the normal New Task rules
  const bad = await crm(baseUrl, '/api/integrations/crm/tasks', { method: 'POST', body: { complaintId: 'c-0', title: 'X leak', deadline: futureDate(2), project: 'Nowhere', assignees: ['suresh.p'] } });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /project/i);
  const unknown = await crm(baseUrl, '/api/integrations/crm/tasks', { method: 'POST', body: { complaintId: 'c-0', title: 'X leak', deadline: futureDate(2), project: 'Mihir Amara', assignees: ['ghost.user'] } });
  assert.equal(unknown.status, 400);

  const body = { complaintId: 'c-1', title: '[CMP-2611-00001] Bathroom leak — Amara B-704', description: 'Water leaking from ceiling.', deadline: futureDate(3), priority: 'high', project: 'Mihir Amara', assignees: ['suresh.p'], requestedBy: 'Test Manager', link: 'https://crm.example/complaints/c-1' };
  const made = await crm(baseUrl, '/api/integrations/crm/tasks', { method: 'POST', body });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const task = made.data.task;
  assert.match(task.id, /^TASK/);
  assert.equal(task.status, 'open');
  assert.equal(task.priority, 'high');
  assert.deepEqual(task.assignees.map(a => a.username), ['suresh.p']);
  assert.match(task.url, /\?task=/);

  // the same complaint never creates a second task
  const again = await crm(baseUrl, '/api/integrations/crm/tasks', { method: 'POST', body });
  assert.equal(again.data.duplicate, true);
  assert.equal(again.data.task.id, task.id);

  // it is a normal task: the assignee sees it, with the CRM link in the description
  const mine = await api(baseUrl, '/api/tasks/mine', { token: plumberToken });
  const list = Array.isArray(mine.data) ? mine.data : (mine.data && (mine.data.tasks || mine.data.mine)) || [];
  const seen = JSON.stringify(mine.data);
  assert.ok(seen.includes(task.id), 'assignee can see the task');
  assert.ok(seen.includes('Open in CRM: https://crm.example/complaints/c-1'));
  void list;

  const st = await crm(baseUrl, `/api/integrations/crm/tasks/${task.id}`);
  assert.equal(st.status, 200);
  assert.equal(st.data.task.title, body.title);
  assert.equal((await crm(baseUrl, '/api/integrations/crm/tasks/TASK-nope')).status, 404);
});

test('CRM link is off when no secret is configured', async (t) => {
  delete process.env.CRM_INTEGRATION_SECRET;
  const { baseUrl, stop } = await startTestServer();
  t.after(stop);
  assert.equal((await crm(baseUrl, '/api/integrations/crm/options')).status, 503);
});
