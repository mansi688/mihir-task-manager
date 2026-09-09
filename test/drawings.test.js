const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember } = require('../testlib/helpers');

test('drawing upload/fetch/delete permissions across every profile', async (t) => {
  const { baseUrl, stop } = await startTestServer();
  t.after(() => stop());

  const adminToken = await login(baseUrl, 'admin', 'admin123');
  const designLeadToken = await createMember(baseUrl, adminToken, 'design_lead', 'Design Lead Test', 'Design Team');
  const designMemberToken = await createMember(baseUrl, adminToken, 'design_member', 'Design Member Test', 'Design Team');
  const siteMemberToken = await createMember(baseUrl, adminToken, 'site_member', 'Site Member Test', 'Site Team');

  // Make design_lead an actual team lead, to specifically distinguish "any design team member"
  // from "only the lead" — the exact concern raised.
  await api(baseUrl, '/api/users/design_lead/team-lead', { method: 'POST', token: adminToken, body: { isTeamLead: true } });

  const drawingBody = (name) => ({ project: 'Test Project', section: 'Test Section', title: name, fileName: `${name}.txt`, fileData: 'data:text/plain;base64,dGVzdA==' });

  await t.test('Admin can upload', async () => {
    const res = await api(baseUrl, '/api/drawings', { method: 'POST', token: adminToken, body: drawingBody('Admin Upload') });
    assert.equal(res.status, 200, JSON.stringify(res.data));
  });

  await t.test('A Design Team LEAD can upload', async () => {
    const res = await api(baseUrl, '/api/drawings', { method: 'POST', token: designLeadToken, body: drawingBody('Design Lead Upload') });
    assert.equal(res.status, 200, JSON.stringify(res.data));
  });

  await t.test('A Design Team member who is NOT a lead can ALSO upload — the specific thing being verified', async () => {
    const res = await api(baseUrl, '/api/drawings', { method: 'POST', token: designMemberToken, body: drawingBody('Design Member Upload') });
    assert.equal(res.status, 200, JSON.stringify(res.data));
  });

  await t.test('A non-Design-team member is correctly BLOCKED from uploading', async () => {
    const res = await api(baseUrl, '/api/drawings', { method: 'POST', token: siteMemberToken, body: drawingBody('Should Fail') });
    assert.equal(res.status, 403);
    assert.match(res.data.error, /design/i);
  });

  await t.test('Anyone (any role, any team) can fetch/see a project\'s drawings', async () => {
    const res = await api(baseUrl, '/api/drawings?project=Test%20Project', { token: siteMemberToken });
    assert.equal(res.status, 200);
    assert.ok(res.data.length >= 3, 'the site member should see all drawings uploaded to this project, not just their own team\'s');
  });

  await t.test('Only the uploader (or Admin) can delete a drawing — not just any Design team member', async () => {
    const listed = await api(baseUrl, '/api/drawings?project=Test%20Project', { token: adminToken });
    const designMembersDrawing = listed.data.find(d => d.title === 'Design Member Upload');
    assert.ok(designMembersDrawing);

    const wrongPersonDeletes = await api(baseUrl, `/api/drawings/${designMembersDrawing.id}`, { method: 'DELETE', token: designLeadToken });
    assert.equal(wrongPersonDeletes.status, 403, 'a different design team member (even a lead) should not be able to delete someone else\'s upload');

    const uploaderDeletes = await api(baseUrl, `/api/drawings/${designMembersDrawing.id}`, { method: 'DELETE', token: designMemberToken });
    assert.equal(uploaderDeletes.status, 200, 'the original uploader should be able to delete their own upload');
  });
});
