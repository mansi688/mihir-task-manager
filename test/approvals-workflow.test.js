const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember } = require('../testlib/helpers');

test('Send for Approval document workflow', async (t) => {
  const { baseUrl, stop } = await startTestServer();
  t.after(() => stop());

  const adminToken = await login(baseUrl, 'admin', 'admin123');
  const reviewer1Token = await createMember(baseUrl, adminToken, 'reviewer1', 'Reviewer One');
  const reviewer2Token = await createMember(baseUrl, adminToken, 'reviewer2', 'Reviewer Two');
  const outsiderToken = await createMember(baseUrl, adminToken, 'outsider', 'Outsider');

  const fileData = 'data:text/plain;base64,dGVzdCBkb2N1bWVudA==';

  let requestId;
  await t.test('creating a request with two reviewers works', async () => {
    const res = await api(baseUrl, '/api/approvals', { method: 'POST', token: adminToken, body: { title: 'Vendor Contract', description: 'Please review', fileName: 'contract.txt', fileData, reviewers: ['reviewer1', 'reviewer2'] } });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    requestId = res.data.id;
  });

  await t.test('someone not tagged as a reviewer cannot decide on it', async () => {
    const res = await api(baseUrl, `/api/approvals/${requestId}/decide`, { method: 'POST', token: outsiderToken, body: { decision: 'approved' } });
    assert.equal(res.status, 403);
  });

  await t.test('rejecting requires a real reason', async () => {
    const noReason = await api(baseUrl, `/api/approvals/${requestId}/decide`, { method: 'POST', token: reviewer1Token, body: { decision: 'rejected' } });
    assert.equal(noReason.status, 400);
  });

  await t.test('one rejection immediately moves the whole request to needs_revision', async () => {
    const reject = await api(baseUrl, `/api/approvals/${requestId}/decide`, { method: 'POST', token: reviewer1Token, body: { decision: 'rejected', reason: 'Missing signature page' } });
    assert.equal(reject.status, 200);
    assert.equal(reject.data.status, 'needs_revision');
  });

  await t.test('the OTHER reviewer cannot still approve a request that already needs revision', async () => {
    const res = await api(baseUrl, `/api/approvals/${requestId}/decide`, { method: 'POST', token: reviewer2Token, body: { decision: 'approved' } });
    assert.equal(res.status, 400, 'a request no longer pending should refuse any further decision');
  });

  await t.test('only the creator (or Admin) can upload a revision', async () => {
    const outsiderTries = await api(baseUrl, `/api/approvals/${requestId}/revise`, { method: 'POST', token: outsiderToken, body: { fileName: 'revised.txt', fileData } });
    assert.equal(outsiderTries.status, 403);

    const revised = await api(baseUrl, `/api/approvals/${requestId}/revise`, { method: 'POST', token: adminToken, body: { fileName: 'revised.txt', fileData } });
    assert.equal(revised.status, 200, JSON.stringify(revised.data));
  });

  await t.test('after a revision, reviewers are reset to pending — the earlier rejection does not carry over', async () => {
    const firstApprove = await api(baseUrl, `/api/approvals/${requestId}/decide`, { method: 'POST', token: reviewer1Token, body: { decision: 'approved' } });
    assert.equal(firstApprove.status, 200, 'reviewer1 should be able to decide again on the revised document');

    const secondApprove = await api(baseUrl, `/api/approvals/${requestId}/decide`, { method: 'POST', token: reviewer2Token, body: { decision: 'approved' } });
    assert.equal(secondApprove.status, 200);
    assert.equal(secondApprove.data.status, 'approved', 'once every reviewer has approved, the whole request should be fully approved');
  });

  await t.test('a fully-approved request can no longer receive decisions', async () => {
    const res = await api(baseUrl, `/api/approvals/${requestId}/decide`, { method: 'POST', token: reviewer1Token, body: { decision: 'approved' } });
    assert.equal(res.status, 400);
  });
});
