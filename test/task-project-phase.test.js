const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');

test('tasks can be created project-wise and phase-wise, and both are retrievable', async (t) => {
  const { baseUrl, stop } = await startTestServer();
  t.after(() => stop());
  const adminToken = await login(baseUrl, 'admin', 'admin123');
  const bobToken = await createMember(baseUrl, adminToken, 'bob_phase', 'Bob Phase');

  const create = await api(baseUrl, '/api/tasks', {
    method: 'POST', token: adminToken,
    body: { title: 'Foundation work', priority: 'high', deadline: futureDate(), assignedToList: ['bob_phase'], project: 'Nyati Equinox', phase: 'Foundation' },
  });
  assert.equal(create.status, 200);

  await t.test('the created task stores project and phase correctly', async () => {
    const detail = await api(baseUrl, `/api/tasks/${create.data.id}`, { token: bobToken });
    assert.equal(detail.data.project, 'Nyati Equinox');
    assert.equal(detail.data.phase, 'Foundation');
  });

  await t.test('project is required and must be one of the firm\'s projects; phase stays optional', async () => {
    const none = await api(baseUrl, '/api/tasks', { method: 'POST', token: adminToken, body: { title: 'Untagged task', priority: 'low', deadline: futureDate(), assignedToList: ['bob_phase'], project: '' } });
    assert.equal(none.status, 400);
    const other = await api(baseUrl, '/api/tasks', { method: 'POST', token: adminToken, body: { title: 'Other site', priority: 'low', deadline: futureDate(), assignedToList: ['bob_phase'], project: 'Sunrise Residency' } });
    assert.equal(other.status, 400);
    const plain = await api(baseUrl, '/api/tasks', { method: 'POST', token: adminToken, body: { title: 'No phase', priority: 'low', deadline: futureDate(), assignedToList: ['bob_phase'], project: 'Mihir Projects' } });
    assert.equal(plain.status, 200);
    const detail = await api(baseUrl, `/api/tasks/${plain.data.id}`, { token: bobToken });
    assert.equal(detail.data.project, 'Mihir Projects');
    assert.equal(detail.data.phase, null);
  });

  await t.test('the new project and phase are auto-registered into their shared, reusable lists', async () => {
    const projects = await api(baseUrl, '/api/projects', { token: bobToken });
    const phases = await api(baseUrl, '/api/task-phases', { token: bobToken });
    assert.ok(projects.data.includes('Nyati Equinox'), 'the project used on task creation appears in the shared project list');
    assert.ok(phases.data.includes('Foundation'), 'a brand-new phase name typed on task creation must appear in the shared phase list afterward');
  });

  await t.test('creating a second task with the same project name does not duplicate it in the list', async () => {
    await api(baseUrl, '/api/tasks', { method: 'POST', token: adminToken, body: { title: 'Structure work', priority: 'medium', deadline: futureDate(), assignedToList: ['bob_phase'], project: 'Nyati Equinox', phase: 'Structure' } });
    const projects = await api(baseUrl, '/api/projects', { token: bobToken });
    const occurrences = projects.data.filter(p => p === 'Nyati Equinox').length;
    assert.equal(occurrences, 1, 'the same project name used on a second task must not appear twice in the shared list');
  });

  await t.test('My Tasks and All Tasks both return project/phase fields on every task', async () => {
    const mine = await api(baseUrl, '/api/tasks/mine', { token: bobToken });
    const foundationTask = mine.data.find(t => t.id === create.data.id);
    assert.equal(foundationTask.project, 'Nyati Equinox');
    assert.equal(foundationTask.phase, 'Foundation');

    const all = await api(baseUrl, '/api/tasks', { token: adminToken });
    const sameTask = all.data.find(t => t.id === create.data.id);
    assert.equal(sameTask.project, 'Nyati Equinox');
    assert.equal(sameTask.phase, 'Foundation');
  });
});
