// A long meeting (> 14 MB of audio) goes through Gemini's Files API instead of the request body.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAI } = require('../backend/services/ai');

test('large audio is uploaded as a file, referenced, then deleted', async () => {
  const calls = [];
  const json = (o, headers = {}) => ({ ok: true, status: 200, headers: { get: (k) => headers[k.toLowerCase()] || null }, json: async () => o, text: async () => JSON.stringify(o) });
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body });
    if (url.includes('/upload/v1beta/files')) return json({}, { 'x-goog-upload-url': 'https://upload.example/session1' });
    if (url === 'https://upload.example/session1') return json({ file: { name: 'files/abc', uri: 'https://gen/files/abc', state: 'ACTIVE' } });
    if (url.includes(':generateContent')) return json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ language: 'en', transcript: 'x', summary: 's', decisions: [], risks: [], tasks: [] }) }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } });
    if ((opts.method || '') === 'DELETE') return json({});
    return json({});
  };
  const pool = { query: async () => ({ rows: [{ s: 0, n: 0 }], rowCount: 0 }) };
  const ai = createAI({ pool, env: { AI_PROVIDER: 'gemini', AI_API_KEY: 'k' }, fetchImpl });
  const big = Buffer.alloc(15 * 1024 * 1024, 7);
  await ai.processAudio({ buffer: big, mime: 'audio/webm', source: 'meeting', username: 'a', ctx: { people: [], projects: [], today: '2026-11-19' }, mode: 'meeting' });
  const gen = calls.find(c => c.url.includes(':generateContent'));
  const body = JSON.parse(gen.body);
  const part = body.contents[0].parts[0];
  assert.deepEqual(part, { file_data: { mime_type: 'audio/webm', file_uri: 'https://gen/files/abc' } });
  assert.ok(gen.body.length < 100000, 'the audio is not in the request');
  await new Promise(r => setTimeout(r, 10));
  assert.ok(calls.some(c => c.method === 'DELETE' && c.url.endsWith('/v1beta/files/abc')), 'file deleted afterwards');
});
