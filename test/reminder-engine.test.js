const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');

// All scenarios are evaluated "as of" tomorrow (IST) at exact times via ?at=, so they do not depend
// on when the suite runs. Tasks are created now, so at tomorrow 10:05 they are < 48 h old (no
// age escalations interfere).
test('Phase 2 — reminder engine: windows, due today, overdue days, combining, anti-spam, idempotency, follow-up', async (t) => {
  const { baseUrl, stop, getRawClient } = await startTestServer();
  t.after(() => stop());
  const admin = await login(baseUrl, 'admin', 'admin123');
  const eng = await createMember(baseUrl, admin, 'eng.x', 'Eng X', 'Site');
  const eng2 = await createMember(baseUrl, admin, 'eng.y', 'Eng Y', 'Site');
  const D = futureDate(1);
  const at = (date, hhmm) => `${date}T${hhmm}:00+05:30`;
  const run = async (when) => (await api(baseUrl, '/api/tasks/send-reminders-now', { method: 'POST', token: admin, body: { at: when } })).data;
  const mine = async (taskId, token = eng) => (await api(baseUrl, '/api/notifications', { token })).data.items.filter(n => n.task_id === taskId && n.type !== 'task_assigned');
  const mk = async (title, deadline, who = ['eng.x'], extra = {}) => (await api(baseUrl, '/api/tasks', { method: 'POST', token: admin, body: { title, deadline, assignedToList: who, ...extra } })).data.id;

  const tA = await mk('T-3 task', futureDate(4));
  const tB = await mk('T-2 task', futureDate(3));
  const tC = await mk('T-1 task', futureDate(2));
  const tD = await mk('Due today task', `${D}T18:00`);
  const tE = await mk('Overdue 3 task', futureDate(-2));
  const tF = await mk('Overdue 7 task', futureDate(-6));
  const tG = await (async () => { const r = await api(baseUrl, '/api/tasks', { method: 'POST', token: admin, body: { title: 'Levels task', deadline: futureDate(4), stages: [{ usernames: ['eng.y'] }, { usernames: ['eng.x'] }] } }); return r.data.id; })();
  const tH = await mk('Blocked task', futureDate(4), ['eng.x'], { dependsOnTaskId: tA });

  await t.test('10:05 — each rule sends one message per person per task, with the spec wording', async () => {
    const s = await run(at(D, '10:05'));
    assert.match((await mine(tA))[0].message, /^Reminder: 3 days remain to complete this task\. "T-3 task"/);
    assert.match((await mine(tB))[0].message, /^Reminder: Only 2 days remain/);
    assert.match((await mine(tC))[0].message, /^Urgent: This task is due tomorrow\./);
    const dToday = await mine(tD);
    assert.equal(dToday.length, 1, 'due today + 24h + 12h tiers + daily nudge → combined into ONE');
    assert.match(dToday[0].message, /^Due today: Please complete this task/);
    assert.match((await mine(tE))[0].message, /^Overdue by 3 days/);
    assert.match((await mine(tF))[0].message, /^Overdue by 7 days/);
    assert.ok((await mine(tF, admin)).some(n => /overdue by 7 days/.test(n.message)), 'creator copied at 7 days');
    for (const id of [tA, tB, tC, tD, tE, tF]) assert.equal((await mine(id)).length, 1, `exactly one message for ${id}`);
    assert.ok(s.combined > 0, 'other rules were combined, not dropped silently');
  });

  await t.test('excluded: people on hold, blocked tasks, and (later) anyone already approved', async () => {
    assert.equal((await mine(tG)).length, 0, 'Level 2 (on hold) gets nothing');
    assert.equal((await mine(tH)).length, 0, 'a task blocked by another task gets nothing');
    assert.ok((await mine(tG, eng2)).length >= 1, 'Level 1 person on the same task is reminded');
  });

  await t.test('running again for the same window sends nothing (idempotent — restarts / catch-up can never duplicate)', async () => {
    const before = (await api(baseUrl, '/api/notifications', { token: eng })).data.items.length;
    const s = await run(at(D, '10:40'));
    assert.equal(s.remindersSent + s.deadlineRemindersSent + s.escalationsSent, 0);
    assert.equal((await api(baseUrl, '/api/notifications', { token: eng })).data.items.length, before);
  });

  await t.test('14:05 — the next window sends again (3 a day); 16:30 — nothing (outside catch-up, gap); 18:05 — third', async () => {
    await run(at(D, '14:05'));
    assert.equal((await mine(tA)).length, 2);
    await run(at(D, '16:30'));
    assert.equal((await mine(tA)).length, 2, 'no window at 16:30, and routine nudges are spaced out');
    await run(at(D, '18:05'));
    assert.equal((await mine(tA)).length, 3, 'three window reminders on a T-3 day');
    assert.equal((await mine(tD)).filter(n => /^Due today:/.test(n.message)).length, 1, '"due today" is sent once, not every window');
    assert.ok((await mine(tD)).some(n => /about 6 hours/.test(n.message)), 'the 6-hour warning still goes out after "due today" was sent');
  });

  await t.test('catch-up: a window missed while the server slept is sent within 2 h, not later', async () => {
    const tCatch = await mk('Catch-up task', futureDate(3));   // T-2 on day D
    await run(at(D, '11:50'));   // server woke 1 h 50 m after the 10:00 window
    assert.equal((await mine(tCatch)).filter(n => /Only 2 days/.test(n.message)).length, 1, 'missed 10:00 window sent on wake-up');
    const tLate = await mk('Late window task', futureDate(4));
    await run(at(D, '17:30'));   // 14:00 window is 3.5 h old → too late; 18:00 not reached
    assert.equal((await mine(tLate)).filter(n => n.type === 'deadline_window').length, 0, 'a window more than 2 h old is not sent late');
  });

  await t.test('delivery log: sent / combined / skipped with reasons — Admin only', async () => {
    const all = (await api(baseUrl, '/api/notifications/deliveries?limit=500', { token: admin })).data;
    assert.ok(all.some(d => d.status === 'sent' && d.notification_type === 'deadline_window'));
    assert.ok(all.some(d => d.status === 'cancelled' && /combined into/.test(d.failure_reason)));
    assert.equal((await api(baseUrl, '/api/notifications/deliveries', { token: eng })).status, 403);
  });

  await t.test('Follow up: notifies open people only, 5-hour gap, recorded in history, task unchanged', async () => {
    const id = await mk('Follow-up task', futureDate(6), ['eng.x', 'eng.y']);
    await api(baseUrl, `/api/tasks/${id}/submit-mine`, { method: 'POST', token: eng2, body: { note: 'My part is done' } });
    await api(baseUrl, `/api/tasks/${id}/approve/eng.y`, { method: 'POST', token: admin });
    const before = (await api(baseUrl, `/api/tasks/${id}`, { token: admin })).data;
    const r = await api(baseUrl, `/api/tasks/${id}/nudge`, { method: 'POST', token: admin });
    assert.equal(r.status, 200); assert.deepEqual(r.data.sent, ['eng.x'], 'approved person excluded');
    assert.ok((await mine(id)).some(n => n.type === 'follow_up' && /^Follow-up: Your assigned part of "Follow-up task" is still open/.test(n.message)));
    const again = await api(baseUrl, `/api/tasks/${id}/nudge`, { method: 'POST', token: admin });
    assert.equal(again.status, 429, 'second follow-up within 5 hours is refused');
    assert.match(again.data.error, /next follow-up is possible after/);
    const after = (await api(baseUrl, `/api/tasks/${id}`, { token: admin })).data;
    assert.deepEqual([after.status, after.deadline, after.assignees.length], [before.status, before.deadline, before.assignees.length], 'follow-up never changes the task');
    const hist = (await api(baseUrl, `/api/tasks/${id}/events?type=FOLLOW_UP_SENT`, { token: admin })).data.events;
    assert.equal(hist.length, 1); assert.deepEqual(hist[0].metadata.recipients, ['eng.x']);
    assert.equal((await api(baseUrl, `/api/tasks/${id}/nudge`, { method: 'POST', token: eng })).status, 403, 'only creator/Admin/Director');
  });
});
