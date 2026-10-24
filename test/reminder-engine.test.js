const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');

// All scenarios are evaluated "as of" tomorrow (IST) at exact times via ?at=, so they do not depend
// on when the suite runs. Tasks are created now, so at tomorrow 09:05 they are < 48 h old (no
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

  await t.test('09:05 — each rule sends one message per person per task, with the spec wording', async () => {
    const s = await run(at(D, '09:05'));
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
    const s = await run(at(D, '09:40'));
    assert.equal(s.remindersSent + s.deadlineRemindersSent + s.escalationsSent, 0);
    assert.equal((await api(baseUrl, '/api/notifications', { token: eng })).data.items.length, before);
  });

  await t.test('15:05 — the next slot sends again (3 a day); 17:30 — nothing (outside any slot); 18:05 — third', async () => {
    // The delivery log keeps every send; the notification list keeps only the latest one per task
    // (a new slot's reminder replaces the earlier card instead of stacking copies).
    const sentFor = async (taskId, type) => (await api(baseUrl, '/api/notifications/deliveries?limit=500', { token: admin })).data
      .filter(d => d.task_id === taskId && d.recipient_username === 'eng.x' && d.status === 'sent' && (!type || d.notification_type === type)).length;
    await run(at(D, '15:05'));
    assert.equal(await sentFor(tA), 2, 'second slot sent');
    assert.equal((await mine(tA)).length, 1, 'but it replaced the 9 AM card — one card per task');
    assert.match((await mine(tA))[0].message, /3 days remain/);
    const outside = await run(at(D, '17:30'));
    assert.equal(outside.outsideSlot, true, '17:30 is outside the 9 AM / 3 PM / 6 PM slots');
    assert.equal(await sentFor(tA), 2, 'nothing is sent between slots');
    await run(at(D, '18:05'));
    assert.equal(await sentFor(tA), 3, 'three slot reminders on a T-3 day');
    assert.equal((await mine(tA)).length, 1, 'still one card for the task');
    assert.equal(await sentFor(tD, 'deadline_due_today'), 1, '"due today" is sent once, not every slot');
    assert.ok(await sentFor(tD, 'deadline_soon') >= 1, 'the 6-hour warning still goes out after "due today" was sent');
    assert.equal((await mine(tD)).length, 1, 'each new one replaced the earlier card — one card for the task');
  });

  await t.test('catch-up: a window missed while the server slept is sent within 2 h, not later', async () => {
    const tCatch = await mk('Catch-up task', futureDate(3));   // T-2 on day D
    await run(at(D, '10:50'));   // server woke 1 h 50 m after the 09:00 slot
    assert.equal((await mine(tCatch)).filter(n => /Only 2 days/.test(n.message)).length, 1, 'missed 09:00 slot sent on wake-up');
    const tLate = await mk('Late window task', futureDate(4));
    await run(at(D, '17:30'));   // 15:00 slot is 2.5 h old → too late; 18:00 not reached
    assert.equal((await mine(tLate)).filter(n => n.type === 'deadline_window').length, 0, 'a slot more than 2 h old is not sent late');
  });

  await t.test('warnings wait for the next slot too: an overdue task found at 12:30 is warned at 15:00, not before', async () => {
    const D2 = futureDate(2);
    const tO = await mk('Overdue slot task', futureDate(-2));   // overdue on day D2
    const s = await run(at(D2, '12:30'));
    assert.equal(s.outsideSlot, true);
    assert.equal((await mine(tO)).length, 0, 'no warning between slots');
    await run(at(D2, '15:02'));
    assert.ok((await mine(tO)).some(n => ['deadline_passed', 'task_overdue_days', 'task_warning_urgent', 'task_flagged'].includes(n.type)), 'overdue warning sent in the 3 PM slot');
  });

  await t.test('delivery log: sent / combined / skipped with reasons — Admin only', async () => {
    const all = (await api(baseUrl, '/api/notifications/deliveries?limit=500', { token: admin })).data;
    assert.ok(all.some(d => d.status === 'sent' && d.notification_type === 'deadline_window'));
    assert.ok(all.some(d => d.status === 'cancelled' && /combined into/.test(d.failure_reason)));
    assert.equal((await api(baseUrl, '/api/notifications/deliveries', { token: eng })).status, 403);
  });

  await t.test('Follow up: anyone involved can press it; everyone else involved is notified; 5-hour gap; task unchanged', async () => {
    const outsider = await createMember(baseUrl, admin, 'eng.z', 'Eng Z', 'Site');
    const id = await mk('Follow-up task', futureDate(6), ['eng.x', 'eng.y']);
    await api(baseUrl, `/api/tasks/${id}/submit-mine`, { method: 'POST', token: eng2, body: { note: 'My part is done' } });
    await api(baseUrl, `/api/tasks/${id}/approve/eng.y`, { method: 'POST', token: admin });
    const before = (await api(baseUrl, `/api/tasks/${id}`, { token: admin })).data;
    const r = await api(baseUrl, `/api/tasks/${id}/nudge`, { method: 'POST', token: admin });
    assert.equal(r.status, 200); assert.deepEqual([...r.data.sent].sort(), ['eng.x', 'eng.y'], 'everyone involved except the presser');
    assert.ok((await mine(id)).some(n => n.type === 'follow_up' && /^Follow-up: Your assigned part of "Follow-up task" is still open/.test(n.message)), 'open part → "your part is still open"');
    assert.ok((await mine(id, eng2)).some(n => n.type === 'follow_up' && /asked everyone on "Follow-up task" to look into it/.test(n.message)), 'approved person → "look into it"');
    const again = await api(baseUrl, `/api/tasks/${id}/nudge`, { method: 'POST', token: admin });
    assert.equal(again.status, 429, 'second follow-up within 5 hours is refused');
    assert.match(again.data.error, /next follow-up is possible after/);
    const byMember = await api(baseUrl, `/api/tasks/${id}/nudge`, { method: 'POST', token: eng });
    assert.equal(byMember.status, 200, 'an assignee can follow up too');
    assert.deepEqual(byMember.data.sent, ['admin'], 'the creator is notified; people followed up in the last 5 h are not re-sent');
    assert.ok((await mine(id, admin)).some(n => n.type === 'follow_up' && /Eng X asked everyone/.test(n.message)));
    assert.equal((await api(baseUrl, `/api/tasks/${id}/nudge`, { method: 'POST', token: outsider })).status, 403, 'someone not on the task cannot');
    const after = (await api(baseUrl, `/api/tasks/${id}`, { token: admin })).data;
    assert.deepEqual([after.status, after.deadline, after.assignees.length], [before.status, before.deadline, before.assignees.length], 'follow-up never changes the task');
    const hist = (await api(baseUrl, `/api/tasks/${id}/events?type=FOLLOW_UP_SENT`, { token: admin })).data.events;
    assert.equal(hist.length, 2);
  });
});
