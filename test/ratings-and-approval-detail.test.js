const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');

test('ratings: transparent, fair, and correct even for a very fast responder', async (t) => {
  const { baseUrl, stop } = startTestServer();
  t.after(() => stop());
  const adminToken = await login(baseUrl, 'admin', 'admin123');
  const bobToken = await createMember(baseUrl, adminToken, 'bob', 'Bob');

  await t.test('someone with zero completed work this quarter gets "not enough data," never a punitive 0', async () => {
    const res = await api(baseUrl, '/api/reports/ratings', { token: adminToken });
    const adminRating = res.data.ratings.find(r => r.username === 'admin');
    assert.equal(adminRating.rating, null);
  });

  await t.test('a near-instant responder gets full timeliness marks, not a crushed-to-zero score (the exact bug found and fixed)', async () => {
    const create = await api(baseUrl, '/api/tasks', { method: 'POST', token: adminToken, body: { title: 'Fast Response Test', priority: 'medium', deadline: futureDate(), assignedToList: ['bob'] } });
    await api(baseUrl, `/api/tasks/${create.data.id}/submit-mine`, { method: 'POST', token: bobToken, body: { note: 'Done immediately after being tagged.' } });
    await api(baseUrl, `/api/tasks/${create.data.id}/approve/bob`, { method: 'POST', token: adminToken });

    const res = await api(baseUrl, '/api/reports/ratings', { token: adminToken });
    const bobRating = res.data.ratings.find(r => r.username === 'bob');
    assert.equal(bobRating.timelinessScore, 2.5, 'responding near-instantly (the only data point, so exactly at the company average) must score full timeliness marks, never a near-zero score from a division artifact');
    assert.equal(bobRating.rating, 5, 'full volume + full timeliness should combine to a perfect 5');
  });

  await t.test('a non-admin, non-director cannot access ratings', async () => {
    const res = await api(baseUrl, '/api/reports/ratings', { token: bobToken });
    assert.equal(res.status, 403);
  });

  await t.test('the rating always shows its real components, never just a bare opaque number', async () => {
    const res = await api(baseUrl, '/api/reports/ratings', { token: adminToken });
    const bobRating = res.data.ratings.find(r => r.username === 'bob');
    assert.ok(typeof bobRating.volumeScore === 'number' && typeof bobRating.timelinessScore === 'number', 'both components must be present, not just the combined rating');
    assert.ok(typeof res.data.companyAvgQuarterCompletions === 'number', 'the company average used for comparison must also be exposed, not hidden inside the formula');
  });
});

test('Documents Approved detail log: real per-decision records', async (t) => {
  const { baseUrl, stop } = startTestServer();
  t.after(() => stop());
  const adminToken = await login(baseUrl, 'admin', 'admin123');
  const bobToken = await createMember(baseUrl, adminToken, 'bob', 'Bob');
  const carolToken = await createMember(baseUrl, adminToken, 'carol', 'Carol');

  const create = await api(baseUrl, '/api/approvals', {
    method: 'POST', token: adminToken,
    body: { title: 'Vendor Contract Detail Test', fileName: 'x.txt', fileData: 'data:text/plain;base64,dGVzdA==', reviewers: ['bob', 'carol'] },
  });
  await api(baseUrl, `/api/approvals/${create.data.id}/decide`, { method: 'POST', token: bobToken, body: { decision: 'rejected', reason: 'Needs the signature page' } });

  await t.test('the rejection shows up with the exact reviewer, decision, reason, and who originally asked', async () => {
    const res = await api(baseUrl, '/api/reports/approval-decisions', { token: adminToken });
    assert.equal(res.status, 200);
    const entry = res.data.find(d => d.request_title === 'Vendor Contract Detail Test');
    assert.ok(entry, 'the decision must appear in the detailed log');
    assert.equal(entry.reviewer_username, 'bob');
    assert.equal(entry.decision, 'rejected');
    assert.equal(entry.reason, 'Needs the signature page');
    assert.equal(entry.created_by_username, 'admin', 'must show who originally asked for the approval');
    assert.ok(entry.decided_at, 'must have a real timestamp');
  });

  await t.test('carol, who has not decided yet, does not appear for this request', async () => {
    const res = await api(baseUrl, '/api/reports/approval-decisions', { token: adminToken });
    const carolEntries = res.data.filter(d => d.request_title === 'Vendor Contract Detail Test' && d.reviewer_username === 'carol');
    assert.equal(carolEntries.length, 0, 'someone who has not made a decision yet must not show up as if they had');
  });

  await t.test('a non-admin, non-director cannot access the detailed log', async () => {
    const res = await api(baseUrl, '/api/reports/approval-decisions', { token: bobToken });
    assert.equal(res.status, 403);
  });
});
