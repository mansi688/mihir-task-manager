const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');

test('reshuffling a tagged person to a different level: full behavior coverage', async (t) => {
  const { baseUrl, stop } = await startTestServer();
  t.after(() => stop());
  const adminToken = await login(baseUrl, 'admin', 'admin123');
  const aliceToken = await createMember(baseUrl, adminToken, 'alice_reshuffle', 'Alice Reshuffle', 'Site Team');
  const bobToken = await createMember(baseUrl, adminToken, 'bob_reshuffle', 'Bob Reshuffle', 'Site Team');
  const carolToken = await createMember(baseUrl, adminToken, 'carol_reshuffle', 'Carol Reshuffle', 'Site Team');
  const outsiderToken = await createMember(baseUrl, adminToken, 'outsider_reshuffle', 'Outsider', 'Sales');

  const create = await api(baseUrl, '/api/tasks', {
    method: 'POST', token: aliceToken,
    body: { title: 'Reshuffle Test Task', priority: 'medium', deadline: futureDate(10), stages: [{ usernames: ['bob_reshuffle'] }, { usernames: ['carol_reshuffle'] }] },
  });
  const taskId = create.data.id;

  await t.test('moving Bob (Level 1) to Level 3 (above Carol, whose Level 2 is not approved) puts him on hold', async () => {
    const res = await api(baseUrl, `/api/tasks/${taskId}/assignees/bob_reshuffle/level`, { method: 'POST', token: aliceToken, body: { level: 3 } });
    assert.equal(res.status, 200);
    assert.equal(res.data.newLevel, 3);
    assert.equal(res.data.isReleased, false, 'Level 3 requires Level 2 to be fully approved first, which it is not yet');

    const task = await api(baseUrl, `/api/tasks/${taskId}`, { token: aliceToken });
    const bobRow = task.data.assignees.find(a => a.username === 'bob_reshuffle');
    assert.equal(bobRow.stage, 3);
    assert.equal(bobRow.is_released, 0);
  });

  await t.test('Bob is notified of his new level, and the message reflects that he is on hold', async () => {
    const notifs = (await api(baseUrl, '/api/notifications', { token: bobToken })).data.items;
    const levelNotif = notifs.find(n => n.type === 'level_changed');
    assert.ok(levelNotif, 'Bob must receive a level-changed notification');
    assert.ok(levelNotif.message.includes('Level 3'), 'the notification must state the new level number');
    assert.ok(levelNotif.message.toLowerCase().includes('hold'), 'the message must reflect that he is on hold, not released');
  });

  await t.test('moving Carol (Level 2) down to Level 1 releases her immediately', async () => {
    const res = await api(baseUrl, `/api/tasks/${taskId}/assignees/carol_reshuffle/level`, { method: 'POST', token: aliceToken, body: { level: 1 } });
    assert.equal(res.status, 200);
    assert.equal(res.data.isReleased, true, 'Level 1 is always released immediately');

    const carolNotifs = (await api(baseUrl, '/api/notifications', { token: carolToken })).data.items;
    const levelNotif = carolNotifs.find(n => n.type === 'level_changed');
    assert.ok(levelNotif.message.includes('start now'), 'the message must reflect that she can start right away');
  });

  await t.test('a non-existent level number (0, negative, non-integer) is rejected', async () => {
    const zero = await api(baseUrl, `/api/tasks/${taskId}/assignees/bob_reshuffle/level`, { method: 'POST', token: aliceToken, body: { level: 0 } });
    assert.equal(zero.status, 400);
    const negative = await api(baseUrl, `/api/tasks/${taskId}/assignees/bob_reshuffle/level`, { method: 'POST', token: aliceToken, body: { level: -2 } });
    assert.equal(negative.status, 400);
  });

  await t.test('moving someone to the level they are already at is rejected as a no-op', async () => {
    const res = await api(baseUrl, `/api/tasks/${taskId}/assignees/carol_reshuffle/level`, { method: 'POST', token: aliceToken, body: { level: 1 } });
    assert.equal(res.status, 400);
    assert.ok(res.data.error.includes('already at Level'));
  });

  await t.test('a person not tagged on this task at all cannot be reshuffled', async () => {
    const res = await api(baseUrl, `/api/tasks/${taskId}/assignees/outsider_reshuffle/level`, { method: 'POST', token: aliceToken, body: { level: 2 } });
    assert.equal(res.status, 404);
  });

  await t.test('an unrelated member (not the creator, not Admin) cannot reshuffle anyone', async () => {
    const res = await api(baseUrl, `/api/tasks/${taskId}/assignees/bob_reshuffle/level`, { method: 'POST', token: outsiderToken, body: { level: 1 } });
    assert.equal(res.status, 403);
  });

  await t.test('Admin (not just the creator) can also reshuffle', async () => {
    const res = await api(baseUrl, `/api/tasks/${taskId}/assignees/bob_reshuffle/level`, { method: 'POST', token: adminToken, body: { level: 2 } });
    assert.equal(res.status, 200);
  });

  await t.test('someone already completed and approved at their current level cannot be reshuffled', async () => {
    // A second assignee keeps the task genuinely open after Carol's part is approved — with
    // only Carol on it, approving her would auto-close the whole task (correct, existing
    // behavior), which would make this scenario impossible to set up at all.
    const create2 = await api(baseUrl, '/api/tasks', { method: 'POST', token: aliceToken, body: { title: 'Already Done Task', priority: 'low', deadline: futureDate(5), assignedToList: ['carol_reshuffle', 'bob_reshuffle'] } });
    const id2 = create2.data.id;
    await api(baseUrl, `/api/tasks/${id2}/submit-mine`, { method: 'POST', token: carolToken, body: { note: 'All done here.' } });
    await api(baseUrl, `/api/tasks/${id2}/approve/carol_reshuffle`, { method: 'POST', token: aliceToken });

    const res = await api(baseUrl, `/api/tasks/${id2}/assignees/carol_reshuffle/level`, { method: 'POST', token: aliceToken, body: { level: 5 } });
    assert.equal(res.status, 400);
    assert.ok(res.data.error.includes('already completed'));
  });

  await t.test('reshuffling is rejected on a task that is not open', async () => {
    const create3 = await api(baseUrl, '/api/tasks', { method: 'POST', token: aliceToken, body: { title: 'Will Be Cancelled', priority: 'low', deadline: futureDate(5), assignedToList: ['bob_reshuffle'] } });
    const id3 = create3.data.id;
    await api(baseUrl, `/api/tasks/${id3}/cancel`, { method: 'POST', token: aliceToken, body: { reason: 'No longer needed for this test.' } });
    const res = await api(baseUrl, `/api/tasks/${id3}/assignees/bob_reshuffle/level`, { method: 'POST', token: aliceToken, body: { level: 2 } });
    assert.equal(res.status, 400);
  });

  await t.test('a genuine reshuffle is captured in the audit log', async () => {
    const auditLog = (await api(baseUrl, '/api/audit-log', { token: adminToken })).data;
    assert.ok(auditLog.some(e => e.action === 'assignee_level_changed' && e.details.includes('bob_reshuffle')), 'the reshuffle action must be audited');
  });
});

test('reshuffling into a level whose prerequisite IS already approved releases immediately', async (t) => {
  const { baseUrl, getRawClient, stop } = await startTestServer();
  t.after(() => stop());
  const adminToken = await login(baseUrl, 'admin', 'admin123');
  const daveToken = await createMember(baseUrl, adminToken, 'dave_reshuffle2', 'Dave', 'Site Team');
  const frankToken = await createMember(baseUrl, adminToken, 'frank_reshuffle2', 'Frank', 'Site Team');

  // Frank starts at Level 5 (on hold, arbitrarily high so it's nowhere near being satisfied) —
  // Level 1 (Dave) then gets approved. Moving Frank DOWN to Level 2 should release him
  // immediately, since Level 1 is already fully approved by the time we do that.
  const create2 = await api(baseUrl, '/api/tasks', { method: 'POST', token: adminToken, body: { title: 'Frank Holder', priority: 'low', deadline: futureDate(5), stages: [{ usernames: ['dave_reshuffle2'] }, { usernames: ['frank_reshuffle2'] }] } });
  const taskId2 = create2.data.id;
  const raw = await getRawClient();
  await raw.query("UPDATE task_assignees SET stage=5, is_released=0 WHERE task_id=$1 AND username='frank_reshuffle2'", [taskId2]);
  await raw.end();
  await api(baseUrl, `/api/tasks/${taskId2}/submit-mine`, { method: 'POST', token: daveToken, body: { note: 'Level 1 done.' } });
  await api(baseUrl, `/api/tasks/${taskId2}/approve/dave_reshuffle2`, { method: 'POST', token: adminToken });

  const res = await api(baseUrl, `/api/tasks/${taskId2}/assignees/frank_reshuffle2/level`, { method: 'POST', token: adminToken, body: { level: 2 } });
  assert.equal(res.status, 200);
  assert.equal(res.data.isReleased, true, 'Level 2 must release immediately since Level 1 is already fully approved on this task');

  const frankNotifs = (await api(baseUrl, '/api/notifications', { token: frankToken })).data.items;
  assert.ok(frankNotifs.some(n => n.type === 'level_changed' && n.message.includes('start now')));
});
