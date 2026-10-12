const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');

test('Employee of the Quarter/Year: snapshots the period that just ended, never the current one, and never duplicates', async (t) => {
  const { baseUrl, getRawClient, stop } = await startTestServer();
  t.after(() => stop());
  const adminToken = await login(baseUrl, 'admin', 'admin123');
  const starToken = await createMember(baseUrl, adminToken, 'star_performer', 'Star Performer', 'Sales');

  const create = await api(baseUrl, '/api/tasks', { method: 'POST', token: adminToken, body: { title: 'Last Quarter Work', priority: 'low', deadline: futureDate(), assignedToList: ['star_performer'] } });
  await api(baseUrl, `/api/tasks/${create.data.id}/submit-mine`, { method: 'POST', token: starToken, body: { note: 'Done.' } });
  await api(baseUrl, `/api/tasks/${create.data.id}/approve/star_performer`, { method: 'POST', token: adminToken });

  // Backdate the submission into the quarter that JUST ENDED — the one the awards job snapshots.
  // 30 days before the current quarter's first day is always inside it, whatever today's date.
  // (The old "120 days ago" landed two quarters back on some dates, e.g. 1 October → 3 June,
  // so this test failed on the first days of every quarter.)
  const raw = await getRawClient();
  const now = new Date();
  const quarterStart = Date.UTC(now.getUTCFullYear(), Math.floor(now.getUTCMonth() / 3) * 3, 1);
  const inPreviousQuarter = new Date(quarterStart - 30 * 86400000).toISOString();
  await raw.query('UPDATE task_assignees SET submitted_at=$1 WHERE task_id=$2', [inPreviousQuarter, create.data.id]);
  await raw.end();

  await api(baseUrl, '/api/reports/check-period-awards-now', { method: 'POST', token: adminToken });

  await t.test('the star performer is recorded as an award winner for that past quarter, rank 1', async () => {
    const awards = await api(baseUrl, '/api/reports/period-awards?type=quarter', { token: adminToken });
    const win = awards.data.awards.find(a => a.username === 'star_performer');
    assert.ok(win, 'a real completed-quarter award must be recorded for this person');
    assert.equal(win.rank, 1);
  });

  await t.test('running the check again does not create a duplicate award for the same quarter', async () => {
    const before = (await api(baseUrl, '/api/reports/period-awards?type=quarter', { token: adminToken })).data.awards.length;
    await api(baseUrl, '/api/reports/check-period-awards-now', { method: 'POST', token: adminToken });
    const after = (await api(baseUrl, '/api/reports/period-awards?type=quarter', { token: adminToken })).data.awards.length;
    assert.equal(after, before, 'a period that already has an award must never be re-processed');
  });

  await t.test('a member cannot view past award winners — admin only, per explicit request', async () => {
    const memberView = await api(baseUrl, '/api/reports/period-awards?type=quarter', { token: starToken });
    assert.equal(memberView.status, 403);
  });
});
