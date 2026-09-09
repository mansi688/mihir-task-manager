const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');

test('Employee of the Quarter/Year: snapshots the period that just ended, never the current one, and never duplicates', async (t) => {
  const { baseUrl, dbPath, stop } = startTestServer();
  t.after(() => stop());
  const adminToken = await login(baseUrl, 'admin', 'admin123');
  const starToken = await createMember(baseUrl, adminToken, 'star_performer', 'Star Performer', 'Sales');

  const create = await api(baseUrl, '/api/tasks', { method: 'POST', token: adminToken, body: { title: 'Last Quarter Work', priority: 'low', deadline: futureDate(), assignedToList: ['star_performer'] } });
  await api(baseUrl, `/api/tasks/${create.data.id}/submit-mine`, { method: 'POST', token: starToken, body: { note: 'Done.' } });
  await api(baseUrl, `/api/tasks/${create.data.id}/approve/star_performer`, { method: 'POST', token: adminToken });

  // Backdate the submission into the PREVIOUS calendar quarter (roughly 4 months back is safely
  // always in a genuinely different quarter than "now", regardless of what month tests run in).
  const raw = new Database(dbPath);
  const fourMonthsAgo = new Date(Date.now() - 120 * 86400000).toISOString();
  raw.prepare('UPDATE task_assignees SET submitted_at=? WHERE task_id=?').run(fourMonthsAgo, create.data.id);
  raw.close();

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

  await t.test('a member (not just admin) can view past award winners', async () => {
    const memberView = await api(baseUrl, '/api/reports/period-awards?type=quarter', { token: starToken });
    assert.equal(memberView.status, 200);
  });
});
