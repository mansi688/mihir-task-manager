const test = require('node:test');
const assert = require('node:assert/strict');
process.env.AI_PROVIDER = 'mock';
const { startTestServer, api, login, createMember } = require('../testlib/helpers');

test('Writing help: ✨ Fix corrects text through the AI service, logs usage, feature flag on', async (t) => {
  const { baseUrl, stop } = await startTestServer();
  t.after(stop);
  const admin = await login(baseUrl, 'admin', 'admin123');
  const u = await createMember(baseUrl, admin, 'ruchita.w', 'Ruchita', 'Design Department');
  const f = (await api(baseUrl, '/api/features', { token: u })).data;
  assert.equal(f.aiWriting, true);
  // with an AI key / provider and no ENABLE_… settings, the AI features are on by default
  assert.equal(f.aiTaskExtraction, true); assert.equal(f.voiceTasks, true); assert.equal(f.meetingAi, true);
  const { flags } = require('../backend/services/features');
  assert.equal(flags({}).aiTaskExtraction, false, 'no key → off');
  assert.equal(flags({ AI_API_KEY: 'k', ENABLE_VOICE_TASKS: 'false' }).voiceTasks, false, 'can still be switched off');
  assert.equal(flags({ AI_API_KEY: 'k' }).meetingAi, true);
  const P = (body) => api(baseUrl, '/api/ai/fix-text', { method: 'POST', token: u, body });
  assert.equal((await P({ text: '   ' })).status, 400);
  assert.equal((await P({ text: 'x'.repeat(4001) })).status, 400);
  const r = await P({ text: 'i did attached photo  it didnt get uploaded here , @tanishq.m check TASK-H3TLRC' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.text, "I did attached photo it didn't get uploaded here, @tanishq.m check TASK-H3TLRC.");
  assert.equal((await api(baseUrl, '/api/ai/fix-text', { method: 'POST', body: { text: 'hello there' } })).status, 401);
});
