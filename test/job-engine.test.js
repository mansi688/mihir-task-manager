const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');

test('Phase 7A — job engine', async (t) => {
  const { baseUrl, stop, getRawClient } = await startTestServer();
  t.after(() => stop());
  const { jobs } = require('../backend/server');
  const admin = await login(baseUrl, 'admin', 'admin123');
  let okRuns = 0, failRuns = 0;
  jobs.register('TEST_OK', async (p) => { okRuns++; return { echo: p.v }; });
  jobs.register('TEST_FAIL', async () => { failRuns++; throw new Error('provider unavailable'); }, { maxAttempts: 3, baseDelayMs: 1 });
  const raw = await getRawClient();
  const row = async (id) => (await raw.query('SELECT * FROM automation_jobs WHERE id=$1', [id])).rows[0];
  t.after(() => raw.end());

  await t.test('enqueue is idempotent by key; a job runs once and records its run', async () => {
    const id = await jobs.enqueue('TEST_OK', { v: 1 }, { key: 'k-ok-1' });
    assert.ok(id);
    assert.equal(await jobs.enqueue('TEST_OK', { v: 1 }, { key: 'k-ok-1' }), null, 'same key → not enqueued again');
    await jobs.tick(); await jobs.tick();
    assert.equal(okRuns, 1);
    const j = await row(id); assert.equal(j.status, 'completed');
    const runs = (await raw.query('SELECT * FROM automation_job_runs WHERE job_id=$1', [id])).rows;
    assert.equal(runs.length, 1); assert.equal(runs[0].status, 'completed');
  });

  await t.test('failures retry with exponential backoff, then dead-letter (never lost), and Admin can retry', async () => {
    const id = await jobs.enqueue('TEST_FAIL', {}, { key: 'k-fail-1' });
    await jobs.tick();
    let j = await row(id);
    assert.equal(j.status, 'retrying'); assert.equal(j.attempt_count, 1); assert.match(j.last_error, /provider unavailable/);
    for (let i = 0; i < 2; i++) { await raw.query('UPDATE automation_jobs SET scheduled_at = now() WHERE id=$1', [id]); await jobs.tick(); }
    j = await row(id);
    assert.equal(j.status, 'dead_letter'); assert.equal(j.attempt_count, 3); assert.equal(failRuns, 3);
    assert.equal((await raw.query('SELECT COUNT(*)::int c FROM automation_job_runs WHERE job_id=$1', [id])).rows[0].c, 3, 'every attempt recorded');
    const list = await api(baseUrl, '/api/admin/jobs?status=dead_letter', { token: admin });
    assert.ok(list.data.jobs.some(x => x.id == id)); assert.equal(list.data.counts.dead_letter, 1);
    assert.equal((await api(baseUrl, `/api/admin/jobs/${id}/retry`, { method: 'POST', token: admin })).status, 200);
    assert.equal((await row(id)).status, 'queued');
    const member = await createMember(baseUrl, admin, 'jobs.m', 'Jobs M', 'Site');
    assert.equal((await api(baseUrl, '/api/admin/jobs', { token: member })).status, 403);
  });

  await t.test('two workers never claim the same job (SKIP LOCKED)', async () => {
    for (let i = 0; i < 6; i++) await jobs.enqueue('TEST_OK', { v: i }, { key: `k-par-${i}`, runAt: new Date(Date.now() + 3600000).toISOString() });
    await raw.query("UPDATE automation_jobs SET scheduled_at = now() WHERE idempotency_key LIKE 'k-par-%'");
    await raw.query("UPDATE automation_jobs SET scheduled_at = now() + interval '1 day' WHERE job_type <> 'TEST_OK' AND status IN ('queued','retrying')"); // only this test's jobs are due
    const [a, b] = await Promise.all([jobs.claim(4), jobs.claim(4)]);
    const ids = [...a, ...b].map(x => x.id);
    assert.equal(ids.length, 6); assert.equal(new Set(ids).size, 6, 'no job claimed twice');
    for (const j of [...a, ...b]) await jobs.runJob(j);
  });

  await t.test('a job left "running" by a crashed worker is recovered and retried', async () => {
    const id = await jobs.enqueue('TEST_OK', { v: 'crash' }, { key: 'k-crash' });
    await raw.query("UPDATE automation_jobs SET status='running', attempt_count=1, locked_by='dead-worker', locked_until = now() - interval '1 minute' WHERE id=$1", [id]);
    await jobs.tick();
    const j = await row(id);
    assert.equal(j.status, 'completed'); assert.match(j.last_error || '', /|/);
  });

  await t.test('schedules create exactly one job per time slot', async () => {
    jobs.every('TEST_OK', 60 * 60 * 1000, { v: 'hourly' });
    await jobs.enqueueDue(); await jobs.enqueueDue(); await jobs.enqueueDue();
    const n = (await raw.query("SELECT COUNT(*)::int c FROM automation_jobs WHERE idempotency_key LIKE 'schedule:TEST_OK:%'")).rows[0].c;
    assert.equal(n, 1);
  });

  await t.test('the reminder engine runs as a job and sends reminders', async () => {
    const eng = await createMember(baseUrl, admin, 'jobs.e', 'Jobs E', 'Site');
    const task = await api(baseUrl, '/api/tasks', { method: 'POST', token: admin, body: { title: 'Job-run reminder', deadline: futureDate(4), assignedToList: ['jobs.e'] } });
    const D = futureDate(1);
    const id = await jobs.enqueue('REMINDER_RUN', { at: `${D}T10:05:00+05:30` }, { key: 'k-rem-1' });
    await jobs.tick();
    assert.equal((await row(id)).status, 'completed');
    const n = (await api(baseUrl, '/api/notifications', { token: eng })).data.items.filter(x => x.task_id === task.data.id && x.type === 'deadline_window');
    assert.equal(n.length, 1);
  });
});
