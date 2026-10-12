// Document / photo / video → task suggestions (app upload + WhatsApp media), with stand-ins for the AI
// (mock provider reads bytes as text), Meta's Graph API and Supabase Storage.
const crypto = require('crypto');
Object.assign(process.env, {
  AI_PROVIDER: 'mock', ENABLE_AI_TASK_EXTRACTION: 'true', ENABLE_WHATSAPP_INTEGRATION: 'true',
  WHATSAPP_APP_SECRET: 'app-secret', WHATSAPP_VERIFY_TOKEN: 'v', WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_NUMBER_ID: '1',
  SUPABASE_URL: 'https://mock-supabase.local', SUPABASE_SERVICE_ROLE_KEY: 'svc', STORAGE_BUCKET: 'mihir-private',
});
const sent = []; const media = new Map(); const bucket = new Map();
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('https://graph.facebook.com/')) {
    if (u.endsWith('/messages')) { sent.push(JSON.parse(opts.body).text.body); return new Response('{}'); }
    const id = decodeURIComponent(u.split('/').pop());
    if (u.includes('/download/')) return new Response(media.get(id).buf);
    return new Response(JSON.stringify({ url: `https://graph.facebook.com/download/${id}`, mime_type: media.get(id).mime }));
  }
  if (u.startsWith('https://mock-supabase.local/')) { if (opts.method === 'POST') bucket.set(u, opts.body); return new Response('{}'); }
  return realFetch(url, opts);
};
const test = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const ExcelJS = require('exceljs');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');
const dataUrl = (mime, buf) => `data:${mime};base64,${Buffer.from(buf).toString('base64')}`;

test('Documents, photos and videos → task suggestions', async (t) => {
  const { baseUrl, stop, getRawClient } = await startTestServer();
  t.after(() => stop());
  const { jobs } = require('../backend/server');
  const admin = await login(baseUrl, 'admin', 'admin123');
  const me = await createMember(baseUrl, admin, 'doc.user', 'Doc User', 'Site');
  const raw = await getRawClient(); t.after(() => raw.end());
  const tomorrow = futureDate(1);
  const upload = (file, name) => api(baseUrl, '/api/ingestion/file', { method: 'POST', token: me, body: { file, name } });

  await t.test('Word (.docx) — text extracted on the server', async () => {
    const zip = new JSZip();
    zip.file('word/document.xml', '<w:document><w:body><w:p><w:r><w:t>Site meeting notes</w:t></w:r></w:p><w:p><w:r><w:t>Rohit, send the plumbing BOQ tomorrow.</w:t></w:r></w:p></w:body></w:document>');
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    const r = await upload(dataUrl('application/vnd.openxmlformats-officedocument.wordprocessingml.document', buf), 'notes.docx');
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const s = r.data.suggestions.find(x => /plumbing BOQ/.test(x.title));
    assert.ok(s); assert.deepEqual(s.assignees, ['rohit.k']); assert.equal(s.deadline, tomorrow);
  });

  await t.test('Excel (.xlsx) — rows read on the server', async () => {
    const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Actions');
    ws.addRow(['Action', 'Who', 'When']); ws.addRow(['Send railing quotes', 'Tanishq', 'tomorrow']);
    const r = await upload(dataUrl('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', await wb.xlsx.writeBuffer()), 'actions.xlsx');
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.ok(r.data.suggestions.some(s => /railing quotes/.test(s.title) && s.assignees.includes('tanishq.m')));
  });

  await t.test('PDF and photo — sent to the AI as files; uploads kept privately for 90 days', async () => {
    const pdf = await upload(dataUrl('application/pdf', 'Yuvraj, float the cement enquiry tomorrow.'), 'enquiry.pdf');
    assert.equal(pdf.status, 200); assert.ok(pdf.data.suggestions.some(s => s.assignees.includes('yuvraj.p')));
    const img = await upload(dataUrl('image/jpeg', 'Rohit check the slab reinforcement today.'), 'site.jpg');
    assert.equal(img.status, 200); assert.ok(img.data.suggestions.length >= 1);
    const files = (await raw.query("SELECT retention_policy, owner_type, original_name FROM file_objects WHERE owner_type='upload' ORDER BY created_at")).rows;
    assert.ok(files.length >= 2); assert.ok(files.every(f => f.retention_policy === 'days:90'));
    const usage = (await raw.query("SELECT feature FROM ai_usage_events WHERE feature IN ('document_extraction','image_extraction')")).rows.map(r => r.feature);
    assert.ok(usage.includes('document_extraction') && usage.includes('image_extraction'), 'each file type is tracked for cost');
  });

  await t.test('unsupported, old-format and oversized files are refused clearly', async () => {
    const zip = await upload(dataUrl('application/zip', 'PK'), 'drawings.zip');
    assert.equal(zip.status, 415); assert.match(zip.data.error, /not supported/);
    const doc = await upload(dataUrl('application/msword', 'x'), 'old.doc');
    assert.equal(doc.status, 415); assert.match(doc.data.error, /\.docx/);
    const big = await upload(dataUrl('application/pdf', Buffer.alloc(16 * 1024 * 1024)), 'big.pdf');
    assert.equal(big.status, 413);
  });

  await t.test('WhatsApp document + video: prepared reply, processed once even if Meta re-sends', async () => {
    const ph = await api(baseUrl, '/api/auth/update-phone', { method: 'POST', token: me, body: { phone: '+919812345678' } });
    assert.equal(ph.status, 200, JSON.stringify(ph.data));
    media.set('DOC1', { buf: Buffer.from('Tanishq, send the UPVC quotation tomorrow.'), mime: 'application/pdf' });
    media.set('VID1', { buf: Buffer.from('Rohit, fix the leaking pipe on level 3 today.'), mime: 'video/mp4' });
    const post = (msg) => { const body = JSON.stringify({ entry: [{ changes: [{ value: { messages: [msg] } }] }] });
      return fetch(`${baseUrl}/api/integrations/whatsapp/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': 'sha256=' + crypto.createHmac('sha256', 'app-secret').update(body).digest('hex') }, body }); };
    const docMsg = { id: 'wamid.D1', from: '919812345678', type: 'document', document: { id: 'DOC1', filename: 'quote-request.pdf', mime_type: 'application/pdf' } };
    await post(docMsg); await post(docMsg); await jobs.tick();
    const dbg = (await raw.query("SELECT status, last_error FROM automation_jobs WHERE idempotency_key='wa:wamid.D1'")).rows; const evd = (await raw.query("SELECT status, error FROM integration_events WHERE external_id='wamid.D1'")).rows;
    assert.equal(sent.filter(x => /prepared from your document/.test(x)).length, 1, JSON.stringify({ dbg, evd, sent }));
    assert.ok(sent.some(x => /UPVC quotation/.test(x)));
    await post({ id: 'wamid.V9', from: '919812345678', type: 'video', video: { id: 'VID1', mime_type: 'video/mp4' } }); await jobs.tick();
    assert.ok(sent.some(x => /prepared from your video/.test(x) && /leaking pipe/.test(x)));
    await post({ id: 'wamid.S1', from: '919812345678', type: 'sticker', sticker: { id: 'X' } }); await jobs.tick();
    assert.ok(sent.some(x => /documents, photos and short videos/.test(x)), 'unsupported types get a helpful reply');
  });
});
