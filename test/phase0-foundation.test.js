const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');
const { MIGRATIONS } = require('../backend/migrations');
const LATEST = MIGRATIONS[MIGRATIONS.length - 1].version;

test('Phase 0 foundation: migrations, health, limits, timezone, audit log', async (t) => {
  const { baseUrl, stop, getRawClient } = await startTestServer();
  t.after(() => stop());
  const admin = await login(baseUrl, 'admin', 'admin123');

  await t.test('migrations: foundation tables exist, version recorded once, re-running is harmless', async () => {
    const raw = await getRawClient();
    for (const tbl of ['schema_migrations', 'task_activity_events', 'notification_deliveries', 'automation_jobs', 'automation_job_runs', 'integration_events', 'ai_usage_events', 'file_objects']) {
      const r = await raw.query('SELECT to_regclass($1) IS NOT NULL AS ok', [tbl]);
      assert.equal(r.rows[0].ok, true, `${tbl} exists`);
    }
    await require('../backend/db').init(); // a restart
    const v = await raw.query('SELECT version FROM schema_migrations');
    assert.deepEqual(v.rows.map(r => r.version).sort(), MIGRATIONS.map(m => m.version), 'each migration recorded exactly once');
    const col = await raw.query("SELECT column_default FROM information_schema.columns WHERE table_name='tasks' AND column_name='source_type' AND table_schema=current_schema()");
    assert.match(col.rows[0].column_default, /web/);
    await raw.end();
  });

  await t.test('health, readiness and request ids', async () => {
    const h = await fetch(`${baseUrl}/health`);
    assert.equal(h.status, 200);
    assert.ok(h.headers.get('x-request-id'), 'every response carries a request id');
    const r = await (await fetch(`${baseUrl}/readiness`)).json();
    assert.equal(r.status, 'ready'); assert.equal(r.database, 'ok'); assert.equal(r.schemaVersion, LATEST);
    assert.equal(r.timezone, 'Asia/Kolkata');
    assert.ok(!JSON.stringify(r).match(/postgres:|password|secret/i), 'no secrets');
  });

  await t.test('large bodies only with a valid login', async () => {
    const big = JSON.stringify({ username: 'x', password: 'y'.repeat(2 * 1024 * 1024) });
    const anon = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: big });
    assert.equal(anon.status, 413, 'anonymous 2MB body refused before parsing');
    const forged = await fetch(`${baseUrl}/api/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer not-a-real-token' }, body: big });
    assert.equal(forged.status, 413, 'a fake token does not unlock large bodies');
    const att = 'data:application/pdf;base64,' + Buffer.alloc(2 * 1024 * 1024, 7).toString('base64');
    const ok = await api(baseUrl, '/api/tasks', { method: 'POST', token: admin, body: { title: 'Big attachment', deadline: futureDate(3), assignedToList: [], attachment: att, attachmentName: 'big.pdf' } });
    assert.equal(ok.status, 200, 'logged-in uploads still work: ' + JSON.stringify(ok.data).slice(0, 120));
  });

  await t.test('business timezone is Asia/Kolkata for every date calculation', async () => {
    assert.equal(process.env.TZ, 'Asia/Kolkata');
    assert.equal(new Date('2026-10-05T17:00').toISOString(), '2026-10-05T11:30:00.000Z', 'a 17:00 deadline means 17:00 IST');
  });

  await t.test('audit log: one entry per login, real client IP, paging, filters, admin only', async () => {
    const before = (await api(baseUrl, '/api/audit-log?format=page&action=login&actor=admin', { token: admin })).data.entries.length;
    const hdrs = { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.7', 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) Chrome/141' };
    for (let i = 0; i < 4; i++) await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: hdrs, body: JSON.stringify({ username: 'admin', password: 'admin123' }) });
    const logins = (await api(baseUrl, '/api/audit-log?format=page&action=login&actor=admin', { token: admin })).data.entries;
    assert.equal(logins.length, before + 1, 'four logins within seconds from one device = one audit entry');
    assert.equal(logins[0].ip_address, '203.0.113.7', 'the real client IP, not the proxy');
    for (let i = 0; i < 5; i++) await createMember(baseUrl, admin, `audit.u${i}`, `Audit U${i}`, 'Site');
    const p1 = (await api(baseUrl, '/api/audit-log?format=page&limit=3', { token: admin })).data;
    assert.equal(p1.entries.length, 3); assert.equal(p1.hasMore, true);
    const p2 = (await api(baseUrl, `/api/audit-log?format=page&limit=3&before_id=${p1.nextBeforeId}`, { token: admin })).data;
    assert.ok(p2.entries.every(e => e.id < p1.entries[2].id), 'next page continues with older entries');
    const created = (await api(baseUrl, '/api/audit-log?format=page&action=account_created', { token: admin })).data;
    assert.ok(created.entries.length >= 5 && created.entries.every(e => e.action === 'account_created'));
    assert.ok(created.actions.some(a => a.action === 'login'), 'action list for the filter dropdown');
    const search = (await api(baseUrl, '/api/audit-log?format=page&q=audit.u3', { token: admin })).data;
    assert.ok(search.entries.length >= 1 && search.entries.every(e => /audit\.u3/i.test(JSON.stringify(e))));
    const member = await login(baseUrl, 'audit.u0', 'TestPass123').catch(() => null);
    if (member) assert.equal((await api(baseUrl, '/api/audit-log', { token: member })).status, 403);
    const legacy = (await api(baseUrl, '/api/audit-log', { token: admin })).data;
    assert.ok(Array.isArray(legacy), 'without format=page the endpoint still returns the original plain list');
  });

  await t.test('imported tasks record their source', async () => {
    const csv = 'data:text/csv;base64,' + Buffer.from(`Title,Deadline\nFrom file,${futureDate(5).split('-').reverse().join('/')}\n`).toString('base64');
    const r = await api(baseUrl, '/api/tasks/import', { method: 'POST', token: admin, body: { fileData: csv, fileName: 'src.csv' } });
    const raw = await getRawClient();
    const row = (await raw.query('SELECT source_type, source_ref FROM tasks WHERE id=$1', [r.data.created[0].id])).rows[0];
    assert.deepEqual([row.source_type, row.source_ref], ['import', 'src.csv']);
    const web = await api(baseUrl, '/api/tasks', { method: 'POST', token: admin, body: { title: 'Typed in', deadline: futureDate(2), assignedToList: [] } });
    assert.equal((await raw.query('SELECT source_type FROM tasks WHERE id=$1', [web.data.id])).rows[0].source_type, 'web');
    await raw.end();
  });
});
