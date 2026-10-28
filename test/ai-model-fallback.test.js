const test = require('node:test');
const assert = require('node:assert/strict');
const { createAI } = require('../backend/services/ai');

const pool = { inserts: [], async query(sql, params) { if (/INSERT INTO ai_usage_events/.test(sql)) this.inserts.push(params); return { rows: [{ s: 0 }] }; } };
const ok = (text) => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10 } }), text: async () => '' });
const gone = (m) => ({ ok: false, status: 404, json: async () => ({}), text: async () => `{"error":{"code":404,"message":"This model models/${m} is no longer available to new users."}}` });

test('Gemini: a retired model falls through to the next one and is remembered; other errors stop', async () => {
  const calls = [];
  const fetchImpl = async (url) => { const m = /models\/([^:]+):/.exec(url)[1]; calls.push(m); return m === 'gemini-2.5-flash-lite' ? gone(m) : ok('I did attach the photo.'); };
  // configured with the old model (as the live server effectively was)
  const ai = createAI({ pool, env: { AI_API_KEY: 'k', AI_MODEL: 'gemini-2.5-flash-lite' }, fetchImpl });
  assert.equal(await ai.fixText({ text: 'i did attached the photo', username: 'admin' }), 'I did attach the photo.');
  assert.deepEqual(calls, ['gemini-2.5-flash-lite', 'gemini-3.5-flash-lite']);
  assert.equal(ai.model, 'gemini-3.5-flash-lite');
  await ai.fixText({ text: 'second one', username: 'admin' });
  assert.equal(calls[2], 'gemini-3.5-flash-lite', 'remembered — no retry of the retired model');
  assert.equal(pool.inserts.at(-1)[2], 'gemini-3.5-flash-lite', 'usage logged under the model actually used');

  // default (no AI_MODEL) starts with the current model
  const calls2 = [];
  const ai2 = createAI({ pool, env: { AI_API_KEY: 'k' }, fetchImpl: async (url) => { calls2.push(/models\/([^:]+):/.exec(url)[1]); return ok('Fine.'); } });
  await ai2.fixText({ text: 'fine', username: 'u' });
  assert.deepEqual(calls2, ['gemini-3.5-flash-lite']);

  // a bad key is reported, not retried on other models
  const calls3 = [];
  const ai3 = createAI({ pool, env: { AI_API_KEY: 'bad' }, fetchImpl: async (url) => { calls3.push(url); return { ok: false, status: 400, text: async () => 'API key not valid', json: async () => ({}) }; } });
  await assert.rejects(ai3.fixText({ text: 'hello there', username: 'u' }), /400/);
  assert.equal(calls3.length, 1);
});
