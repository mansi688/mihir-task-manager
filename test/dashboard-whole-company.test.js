const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');

test('My Dashboard "Whole Company" aggregates across everyone, not one person', async (t) => {
  const { baseUrl, stop } = startTestServer();
  t.after(() => stop());
  const adminToken = await login(baseUrl, 'admin', 'admin123');
  const aliceToken = await createMember(baseUrl, adminToken, 'alice', 'Alice');
  const bobToken = await createMember(baseUrl, adminToken, 'bob', 'Bob');

  const t1 = await api(baseUrl, '/api/tasks', { method: 'POST', token: adminToken, body: { title: 'Company Dash Test 1', priority: 'low', deadline: futureDate(), assignedToList: ['alice'] } });
  await api(baseUrl, `/api/tasks/${t1.data.id}/submit-mine`, { method: 'POST', token: aliceToken, body: { note: 'Alice work fully done.' } });
  await api(baseUrl, `/api/tasks/${t1.data.id}/approve/alice`, { method: 'POST', token: adminToken });

  const t2 = await api(baseUrl, '/api/tasks', { method: 'POST', token: adminToken, body: { title: 'Company Dash Test 2', priority: 'low', deadline: futureDate(), assignedToList: ['bob'] } });
  await api(baseUrl, `/api/tasks/${t2.data.id}/submit-mine`, { method: 'POST', token: bobToken, body: { note: 'Bob work fully done.' } });
  await api(baseUrl, `/api/tasks/${t2.data.id}/approve/bob`, { method: 'POST', token: adminToken });

  const alice = await api(baseUrl, '/api/reports/my-dashboard?username=alice', { token: adminToken });
  const bob = await api(baseUrl, '/api/reports/my-dashboard?username=bob', { token: adminToken });
  const company = await api(baseUrl, '/api/reports/my-dashboard?username=all', { token: adminToken });

  assert.equal(company.data.username, 'all');
  assert.equal(company.data.completion.allTime, alice.data.completion.allTime + bob.data.completion.allTime, 'company-wide completion total must equal the sum of individuals, not just one person\'s count');

  const memberCheck = await api(baseUrl, '/api/reports/my-dashboard?username=all', { token: aliceToken });
  assert.equal(memberCheck.data.username, 'alice', 'a non-admin must never get the whole-company aggregate, even if they ask for it — forced back to their own data');
});
