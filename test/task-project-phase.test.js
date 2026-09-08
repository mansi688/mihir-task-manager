const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');

test('tasks can be created project-wise and phase-wise, and both are retrievable', async (t) => {
  const { baseUrl, stop } = startTestServer();
  t.after(() => stop());
  const adminToken = await login(baseUrl, 'admin', 'admin123');
  const bobToken = await createMember(baseUrl, adminToken, 'bob_phase', 'Bob Phase');

  const create = await api(baseUrl, '/api/tasks', {
    method: 'POST', token: adminToken,
    body: { title: 'Foundation work', priority: 'high', deadline: futureDate(), assignedToList: ['bob_phase'], project: 'Sunrise Residency', phase: 'Foundation' },
  });
  assert.equal(create.status, 200);

  await t.test('the created task stores project and phase correctly', async () => {
    const detail = await api(baseUrl, `/api/tasks/${create.data.id}`, { token: bobToken });
    assert.equal(detail.data.project, 'Sunrise Residency');
    assert.equal(detail.data.phase, 'Foundation');
  });

  await t.test('a task created with no project/phase leaves both null, not an error', async () => {
    const plain = await api(baseUrl, '/api/tasks', { method: 'POST', token: adminToken, body: { title: 'Untagged task', priority: 'low', deadline: futureDate(), assignedToList: ['bob_phase'] } });
    assert.equal(plain.status, 200);
    const detail = await api(baseUrl, `/api/tasks/${plain.data.id}`, { token: bobToken });
    assert.equal(detail.data.project, null);
    assert.equal(detail.data.phase, null);
  });

  await t.test('the new project and phase are auto-registered into their shared, reusable lists', async () => {
    const projects = await api(baseUrl, '/api/projects', { token: bobToken });
    const phases = await api(baseUrl, '/api/task-phases', { token: bobToken });
    assert.ok(projects.data.includes('Sunrise Residency'), 'a brand-new project name typed on task creation must appear in the shared project list afterward');
    assert.ok(phases.data.includes('Foundation'), 'a brand-new phase name typed on task creation must appear in the shared phase list afterward');
  });

  await t.test('creating a second task with the same project name does not duplicate it in the list', async () => {
    await api(baseUrl, '/api/tasks', { method: 'POST', token: adminToken, body: { title: 'Structure work', priority: 'medium', deadline: futureDate(), assignedToList: ['bob_phase'], project: 'Sunrise Residency', phase: 'Structure' } });
    const projects = await api(baseUrl, '/api/projects', { token: bobToken });
    const occurrences = projects.data.filter(p => p === 'Sunrise Residency').length;
    assert.equal(occurrences, 1, 'the same project name used on a second task must not appear twice in the shared list');
  });

  await t.test('My Tasks and All Tasks both return project/phase fields on every task', async () => {
    const mine = await api(baseUrl, '/api/tasks/mine', { token: bobToken });
    const foundationTask = mine.data.find(t => t.id === create.data.id);
    assert.equal(foundationTask.project, 'Sunrise Residency');
    assert.equal(foundationTask.phase, 'Foundation');

    const all = await api(baseUrl, '/api/tasks', { token: adminToken });
    const sameTask = all.data.find(t => t.id === create.data.id);
    assert.equal(sameTask.project, 'Sunrise Residency');
    assert.equal(sameTask.phase, 'Foundation');
  });
});
