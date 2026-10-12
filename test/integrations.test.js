// Phases 5–6: ingestion + AI suggestions + voice + WhatsApp + email + meetings, end to end, with
// stand-ins for the external services (mock AI provider, captured WhatsApp Graph API, in-memory
// Supabase Storage). Feature flags are switched on here; they default to OFF in production.
const crypto = require('crypto');
Object.assign(process.env, {
  AI_PROVIDER: 'mock', ENABLE_AI_TASK_EXTRACTION: 'true', ENABLE_VOICE_TASKS: 'true', ENABLE_WHATSAPP_INTEGRATION: 'true',
  ENABLE_EMAIL_INGESTION: 'true', ENABLE_MEETING_AI: 'true', WHATSAPP_APP_SECRET: 'app-secret', WHATSAPP_VERIFY_TOKEN: 'verify-me',
  WHATSAPP_TOKEN: 'wa-token', WHATSAPP_PHONE_NUMBER_ID: '12345', EMAIL_INBOUND_SECRET: 'mail-secret',
  SUPABASE_URL: 'https://mock-supabase.local', SUPABASE_SERVICE_ROLE_KEY: 'svc', STORAGE_BUCKET: 'mihir-private',
});
const sentWhatsApp = []; const bucket = new Map(); const media = new Map();
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('https://graph.facebook.com/')) {
    if (u.endsWith('/messages')) { sentWhatsApp.push(JSON.parse(opts.body)); return new Response('{}', { status: 200 }); }
    const id = decodeURIComponent(u.split('/').pop());
    if (u.includes('/download/')) return new Response(media.get(id), { status: 200 });
    if (media.has(id)) return new Response(JSON.stringify({ url: `https://graph.facebook.com/download/${id}`, mime_type: 'audio/ogg' }), { status: 200 });
    return new Response('not found', { status: 404 });
  }
  if (u.startsWith('https://mock-supabase.local/storage/v1/')) {
    const path = u.replace('https://mock-supabase.local/storage/v1/', '');
    if (path.startsWith('object/sign/')) return new Response(JSON.stringify({ signedURL: `/object/sign/${path.slice(12)}?token=t` }), { status: 200 });
    if (opts.method === 'POST' && path.startsWith('object/')) { bucket.set(path.slice(7), Buffer.from(opts.body)); return new Response('{}', { status: 200 }); }
    if (opts.method === 'DELETE') { for (const p of JSON.parse(opts.body).prefixes) bucket.delete(`mihir-private/${p}`); return new Response('[]', { status: 200 }); }
    const b = bucket.get(path.slice(7)); return b ? new Response(b, { status: 200 }) : new Response('nf', { status: 404 });
  }
  return realFetch(url, opts);
};
const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');
const sign = (body) => 'sha256=' + crypto.createHmac('sha256', 'app-secret').update(body).digest('hex');
const waBody = (msg) => JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { messages: [msg] } }] }] });

test('Phases 5–6 — AI ingestion, voice, WhatsApp, email, meetings', async (t) => {
  const { baseUrl, stop, getRawClient } = await startTestServer();
  t.after(() => stop());
  const { jobs } = require('../backend/server');
  const admin = await login(baseUrl, 'admin', 'admin123');
  const raw = await getRawClient(); t.after(() => raw.end());
  const sonal = await createMember(baseUrl, admin, 'sonal.p', 'Sonal Patil', 'Purchase');
  const outsider = await createMember(baseUrl, admin, 'out.x', 'Out Sider', 'Accounts');
  await raw.query("UPDATE users SET phone='+91 98765 43210', email='sonal@mihirgroup.com' WHERE username='sonal.p'");
  const tomorrow = futureDate(1);
  const postWA = (msg, sig) => { const body = waBody(msg); return fetch(`${baseUrl}/api/integrations/whatsapp/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': sig || sign(body) }, body }); };

  await t.test('pasted text → only real actions become suggestions; accept creates the task through the normal path', async () => {
    const r = await api(baseUrl, '/api/ingestion', { method: 'POST', token: sonal, body: { text: 'Rohit, send the Tower 2A electrical quotation tomorrow by 2 pm. We discussed the MCB rates.' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.suggestions.length, 1, 'the discussion sentence is not a task');
    const s = r.data.suggestions[0];
    assert.deepEqual(s.assignees, ['rohit.k']); assert.equal(s.deadline, `${tomorrow}T14:00`);
    assert.equal((await api(baseUrl, `/api/suggestions/${s.id}/accept`, { method: 'POST', token: outsider })).status, 403);
    const acc = await api(baseUrl, `/api/suggestions/${s.id}/accept`, { method: 'POST', token: sonal, body: { title: 'Send revised Tower 2A electrical quotation' } });
    assert.equal(acc.status, 200, JSON.stringify(acc.data));
    assert.equal((await api(baseUrl, `/api/suggestions/${s.id}/accept`, { method: 'POST', token: sonal })).status, 409, 'cannot create twice');
    const task = (await api(baseUrl, `/api/tasks/${acc.data.taskId}`, { token: admin })).data;
    assert.equal(task.title, 'Send revised Tower 2A electrical quotation'); assert.equal(task.assignees[0].username, 'rohit.k');
    const ev = (await api(baseUrl, `/api/tasks/${acc.data.taskId}/events?order=asc`, { token: admin })).data.events[0];
    assert.equal(ev.source_type, 'manual'); assert.match(ev.details, /AI suggestion, 90% confidence, edited, approved by Sonal Patil/);
    assert.equal(ev.metadata.model, 'mock'); assert.equal(ev.metadata.approved_by, 'sonal.p');
  });

  await t.test('voice (Marathi + English) → transcript kept in the original language, task in English fields', async () => {
    const speech = 'Rohit ला Tower 2A चा electrical quotation उद्या check करून पाठवायला सांग.';
    const r = await api(baseUrl, '/api/ingestion/voice', { method: 'POST', token: sonal, body: { audio: 'data:audio/webm;base64,' + Buffer.from(speech).toString('base64') } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.transcript, speech, 'original speech preserved');
    assert.deepEqual(r.data.suggestions[0].assignees, ['rohit.k']); assert.equal(r.data.suggestions[0].deadline, tomorrow);
    assert.equal((await api(baseUrl, '/api/ingestion/voice', { method: 'POST', token: sonal, body: { audio: 'data:text/plain;base64,aGk=' } })).status, 400, 'audio only');
    process.env.ENABLE_VOICE_TASKS = 'false';
    assert.equal((await api(baseUrl, '/api/ingestion/voice', { method: 'POST', token: sonal, body: { audio: 'data:audio/webm;base64,aGk=' } })).status, 403, 'feature flag off');
    process.env.ENABLE_VOICE_TASKS = 'true';
  });

  await t.test('AI budget: when the monthly budget is used up, AI stops with a clear message; manual tasks still work', async () => {
    await raw.query("INSERT INTO ai_usage_events (feature, provider, model, cost_inr) VALUES ('test','gemini','x', 5000)");
    const r = await api(baseUrl, '/api/ingestion', { method: 'POST', token: sonal, body: { text: 'Rohit send BOQ tomorrow.' } });
    assert.equal(r.status, 429); assert.match(r.data.error, /Monthly AI budget reached/);
    assert.equal((await api(baseUrl, '/api/tasks', { method: 'POST', token: sonal, body: { title: 'Manual still works', deadline: futureDate(2), assignedToList: [] } })).status, 200);
    await raw.query("DELETE FROM ai_usage_events WHERE feature='test'");
  });

  await t.test('WhatsApp: verification, signatures, duplicates, unknown senders, CONFIRM creates the task', async () => {
    assert.equal((await fetch(`${baseUrl}/api/integrations/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/integrations/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42`)).status, 403);
    assert.equal((await postWA({ id: 'wamid.1', from: '919876543210', type: 'text', text: { body: 'x' } }, 'sha256=forged')).status, 401, 'forged signature rejected');
    const msg = { id: 'wamid.A1', from: '919876543210', type: 'text', text: { body: 'Tanishq ko Tower 2A quotation kal tak bhejne bolo' } };
    assert.equal((await postWA(msg)).status, 200);
    assert.equal((await postWA(msg)).status, 200, 'Meta retries the same message');
    await jobs.tick();
    const prepared = sentWhatsApp.filter(m => /Task prepared/.test(m.text.body));
    assert.equal(prepared.length, 1, 'duplicate webhook did not create a second suggestion');
    assert.match(prepared[0].text.body, /Assigned: tanishq\.m/); assert.match(prepared[0].text.body, /Reply CONFIRM/);
    await postWA({ id: 'wamid.A2', from: '919876543210', type: 'text', text: { body: 'CONFIRM' } }); await jobs.tick();
    const created = sentWhatsApp.find(m => /^Created:/.test(m.text.body));
    assert.ok(created, 'confirmation reply sent');
    const taskId = /(TASK-[A-Z0-9]+)/.exec(created.text.body)[1];
    assert.equal((await api(baseUrl, `/api/tasks/${taskId}`, { token: admin })).data.source_type, 'whatsapp');
    const before = sentWhatsApp.length;
    await postWA({ id: 'wamid.U1', from: '910000000000', type: 'text', text: { body: 'Rohit send BOQ tomorrow' } }); await jobs.tick();
    assert.equal(sentWhatsApp.length, before, 'unknown numbers get no reply and create nothing');
  });

  await t.test('WhatsApp voice note → downloaded, stored with retention, transcribed, CANCEL creates nothing', async () => {
    media.set('MEDIA1', Buffer.from('Rohit, check the plumbing drawing tomorrow.'));
    await postWA({ id: 'wamid.V1', from: '919876543210', type: 'audio', audio: { id: 'MEDIA1' } }); await jobs.tick();
    const ev = (await raw.query("SELECT status, error FROM integration_events WHERE external_id='wamid.V1'")).rows[0]; const jb = (await raw.query("SELECT status, last_error FROM automation_jobs WHERE idempotency_key='wa:wamid.V1'")).rows[0];
    assert.ok(sentWhatsApp.some(m => /Task: Rohit, check the plumbing drawing tomorrow/.test(m.text.body)), JSON.stringify({ ev, jb, last: sentWhatsApp.slice(-2) }));
    const f = (await raw.query("SELECT * FROM file_objects WHERE owner_type='whatsapp'")).rows[0];
    assert.equal(f.retention_policy, 'days:30'); assert.ok(bucket.size >= 1, 'audio is in object storage, not PostgreSQL');
    await postWA({ id: 'wamid.V2', from: '919876543210', type: 'text', text: { body: 'cancel' } }); await jobs.tick();
    assert.ok(sentWhatsApp.some(m => /Cancelled — nothing was created/.test(m.text.body)));
  });

  await t.test('email → task: secret required, unknown senders ignored, each Message-ID once', async () => {
    const send = (body, secret = 'mail-secret') => fetch(`${baseUrl}/api/integrations/email/inbound`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-inbound-secret': secret }, body: JSON.stringify(body) });
    assert.equal((await send({ message_id: 'm1', from: 'sonal@mihirgroup.com' }, 'wrong')).status, 401);
    assert.equal((await send({ message_id: 'm0', from: 'stranger@gmail.com', subject: 'x', text: 'Rohit send BOQ tomorrow.' })).status, 202);
    const mail = { message_id: '<abc@mihirgroup.com>', from: 'Sonal Patil <sonal@mihirgroup.com>', subject: 'Tower 2A electrical quotation', text: 'Rohit, get the revised quotation from ABC Electrical tomorrow.' };
    const r1 = await send(mail); assert.equal(r1.status, 202);
    const r2 = await (await send(mail)).json(); assert.equal(r2.duplicate, true);
    await jobs.tick();
    const pending = (await api(baseUrl, '/api/suggestions', { token: sonal })).data.filter(s => s.source === 'email');
    assert.equal(pending.length, 1); assert.deepEqual(pending[0].assignees, ['rohit.k']);
    assert.ok((await api(baseUrl, '/api/notifications', { token: sonal })).data.items.some(n => /from your email "Tower 2A electrical quotation"/.test(n.message)));
  });

  await t.test('meeting: actions vs discussion/decision/question, review, access control, 30-day recording retention', async () => {
    const speech = 'Rohit, send the quotation tomorrow. We discussed the quotation. We will use the approved MCB. Can someone check the quotation?';
    const r = await api(baseUrl, '/api/meetings', { method: 'POST', token: sonal, body: { title: 'Electrical coordination — Wing 2A', participants: ['rohit.k'], audio: 'data:audio/webm;base64,' + Buffer.from(speech).toString('base64'), startedAt: new Date(Date.now() - 1800000).toISOString() } });
    assert.equal(r.status, 202, JSON.stringify(r.data));
    await jobs.tick();
    const m = (await api(baseUrl, `/api/meetings/${r.data.meeting.id}`, { token: sonal })).data;
    assert.equal(m.status, 'ready'); assert.equal(m.transcript, speech);
    assert.equal(m.suggestions.length, 1, 'only the real action item'); assert.match(m.suggestions[0].title, /send the quotation tomorrow/);
    assert.ok(m.decisions.some(d => /approved MCB/.test(d)));
    assert.equal((await api(baseUrl, `/api/meetings/${m.id}`, { token: outsider })).status, 403);
    const rohit = await login(baseUrl, 'rohit.k', 'MHR123456').catch(() => null);
    if (rohit) assert.equal((await api(baseUrl, `/api/meetings/${m.id}`, { token: rohit })).status, 200, 'participants can see it');
    assert.match((await api(baseUrl, `/api/meetings/${m.id}/recording`, { token: sonal })).data.url, /token=t/);
    await raw.query("UPDATE file_objects SET created_at = now() - interval '31 days' WHERE owner_type='meeting'");
    await jobs.enqueue('STORAGE_RETENTION', {}, { key: 'test-retention' }); await jobs.tick();
    assert.equal((await api(baseUrl, `/api/meetings/${m.id}/recording`, { token: sonal })).status, 404, 'recording deleted after 30 days');
    assert.equal((await api(baseUrl, `/api/meetings/${m.id}`, { token: sonal })).data.transcript, speech, 'transcript kept');
  });

  await t.test('System page data: health, jobs, integrations, features, AI usage — Admin only', async () => {
    const s = (await api(baseUrl, '/api/admin/system', { token: admin })).data;
    assert.equal(s.database, 'ok'); assert.equal(s.features.autoTaskCreation, false); assert.equal(s.integrations.storage, true);
    assert.ok(s.ai && typeof s.ai.monthInr === 'number');
    assert.equal((await api(baseUrl, '/api/admin/system', { token: sonal })).status, 403);
  });
});
