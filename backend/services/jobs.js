// Phase 7A — central job engine on PostgreSQL (automation_jobs / automation_job_runs).
// No Redis/queues: jobs are rows; workers CLAIM them with FOR UPDATE SKIP LOCKED so two server
// instances never run the same job; every attempt is recorded; failures retry with exponential
// backoff and end in 'dead_letter' after max_attempts (never silently lost); a worker that crashes
// mid-job has its lock expire and the job is retried. Recurring schedules enqueue one job per time
// slot with an idempotency key, so restarts/instances can't double-schedule.
const os = require('os');

function createJobEngine({ pool, log }) {
  const handlers = new Map();
  const schedules = [];
  const workerId = `${os.hostname()}:${process.pid}`;
  const LOCK_MINUTES = 10;
  let ticking = false;

  function register(type, handler, opts = {}) { handlers.set(type, { handler, maxAttempts: opts.maxAttempts || 5, baseDelayMs: opts.baseDelayMs || 30000 }); }

  async function enqueue(type, payload = {}, opts = {}) {
    const def = handlers.get(type);
    const r = await pool.query(`INSERT INTO automation_jobs (job_type, payload, priority, scheduled_at, max_attempts, idempotency_key, related_task_id, related_username)
      VALUES ($1, $2::jsonb, $3, COALESCE($4::timestamptz, now()), $5, $6, $7, $8)
      ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING id`,
      [type, JSON.stringify(payload), opts.priority || 100, opts.runAt || null, opts.maxAttempts || (def && def.maxAttempts) || 5,
       opts.key || null, opts.relatedTaskId || null, opts.relatedUsername || null]);
    return r.rows[0] ? r.rows[0].id : null; // null = already enqueued (idempotent)
  }

  // Recurring work: every(ms) or dailyAt('HH:MM') — one job per slot.
  function every(type, ms, payload = {}) { schedules.push({ type, slot: (now) => Math.floor(now / ms) * ms, payload }); }
  function dailyAt(type, hhmm, payload = {}) {
    const [h, m] = hhmm.split(':').map(Number);
    schedules.push({ type, payload, slot: (now) => { const d = new Date(now); d.setHours(h, m, 0, 0); if (d.getTime() > now) d.setDate(d.getDate() - 1); return d.getTime(); } });
  }
  function weeklyOn(type, weekday, hhmm, payload = {}) { // weekday 0=Sun … 6=Sat
    const [h, m] = hhmm.split(':').map(Number);
    schedules.push({ type, payload, slot: (now) => { const d = new Date(now); d.setHours(h, m, 0, 0); while (d.getDay() !== weekday || d.getTime() > now) d.setDate(d.getDate() - 1); return d.getTime(); } });
  }
  async function enqueueDue(now = Date.now()) {
    for (const s of schedules) await enqueue(s.type, s.payload, { key: `schedule:${s.type}:${new Date(s.slot(now)).toISOString()}`, runAt: new Date(s.slot(now)).toISOString() });
  }

  async function reclaimStale() {
    // A worker died mid-job: its lock expired → put the job back for a retry (attempt already counted).
    await pool.query(`UPDATE automation_jobs SET status = CASE WHEN attempt_count >= max_attempts THEN 'dead_letter' ELSE 'retrying' END,
      last_error = COALESCE(last_error, '') || ' [lock expired — worker stopped mid-job]', locked_by = NULL, locked_until = NULL, updated_at = now()
      WHERE status = 'running' AND locked_until < now()`);
  }
  // notStartedSince: never re-claim a job that already ran in the current tick (a job that just
  // failed waits for its backoff and the next tick, even if its delay is tiny).
  async function claim(limit = 5, notStartedSince = null) {
    const r = await pool.query(`UPDATE automation_jobs SET status = 'running', locked_by = $1, locked_until = now() + ($2 || ' minutes')::interval,
        started_at = now(), attempt_count = attempt_count + 1, updated_at = now()
      WHERE id IN (SELECT id FROM automation_jobs WHERE status IN ('queued', 'retrying') AND scheduled_at <= now()
                     AND ($4::timestamptz IS NULL OR started_at IS NULL OR started_at < $4::timestamptz)
                   ORDER BY priority, scheduled_at FOR UPDATE SKIP LOCKED LIMIT $3)
      RETURNING *`, [workerId, String(LOCK_MINUTES), limit, notStartedSince]);
    return r.rows;
  }
  async function runJob(job) {
    const def = handlers.get(job.job_type);
    const started = Date.now();
    const run = await pool.query('INSERT INTO automation_job_runs (job_id, attempt, status, worker_id) VALUES ($1, $2, $3, $4) RETURNING id', [job.id, job.attempt_count, 'running', workerId]);
    const runId = run.rows[0].id;
    try {
      if (!def) throw new Error(`No handler registered for job type ${job.job_type}`);
      const result = await def.handler(job.payload || {}, job);
      await pool.query(`UPDATE automation_jobs SET status='completed', completed_at=now(), locked_by=NULL, locked_until=NULL, last_error=NULL, updated_at=now() WHERE id=$1`, [job.id]);
      await pool.query(`UPDATE automation_job_runs SET status='completed', finished_at=now(), duration_ms=$2 WHERE id=$1`, [runId, Date.now() - started]);
      return { ok: true, result };
    } catch (e) {
      const dead = job.attempt_count >= job.max_attempts;
      const delay = Math.min(3600000, (def ? def.baseDelayMs : 30000) * 2 ** (job.attempt_count - 1));
      await pool.query(`UPDATE automation_jobs SET status=$2, last_error=$3, locked_by=NULL, locked_until=NULL,
          scheduled_at = CASE WHEN $2 = 'retrying' THEN now() + ($4 || ' milliseconds')::interval ELSE scheduled_at END, updated_at=now() WHERE id=$1`,
        [job.id, dead ? 'dead_letter' : 'retrying', String(e.message).slice(0, 1000), String(delay)]);
      await pool.query(`UPDATE automation_job_runs SET status='failed', finished_at=now(), duration_ms=$2, error=$3 WHERE id=$1`, [runId, Date.now() - started, String(e.message).slice(0, 1000)]);
      log(dead ? 'ERROR' : 'WARN', dead ? 'job dead-lettered' : 'job failed, will retry', { jobId: job.id, type: job.job_type, attempt: job.attempt_count, error: e.message });
      return { ok: false, error: e.message };
    }
  }
  // If a tick is already running, wait for it and then run one more (callers like "run now" and
  // webhooks expect the work to be done when tick() resolves). Never two ticks at once per process.
  let current = null, again = false;
  function tick() {
    if (current) { again = true; return current; }
    current = (async () => {
      do { again = false; await tickOnce(); } while (again);
    })().finally(() => { current = null; });
    return current;
  }
  async function tickOnce() {
    ticking = true;
    try {
      await enqueueDue();
      await reclaimStale();
      const tickStart = new Date().toISOString();
      for (let round = 0; round < 4; round++) { const jobs = await claim(5, tickStart); if (!jobs.length) break; for (const j of jobs) await runJob(j); }
    } catch (e) { log('ERROR', 'job worker tick failed', { error: e.message }); }
    finally { ticking = false; }
  }
  async function retry(id) {
    const r = await pool.query(`UPDATE automation_jobs SET status='queued', scheduled_at=now(), max_attempts = GREATEST(max_attempts, attempt_count + 1), updated_at=now()
      WHERE id=$1 AND status IN ('failed','dead_letter','retrying') RETURNING id`, [id]);
    return r.rowCount > 0;
  }
  async function list({ status, limit = 100 } = {}) {
    const r = await pool.query(`SELECT id, job_type, status, priority, scheduled_at, started_at, completed_at, attempt_count, max_attempts, last_error, related_task_id, related_username, created_at,
        EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000 AS duration_ms
      FROM automation_jobs ${status ? 'WHERE status = $2' : ''} ORDER BY id DESC LIMIT $1`, status ? [limit, status] : [limit]);
    return r.rows;
  }
  async function counts() {
    const r = await pool.query(`SELECT status, COUNT(*)::int AS n FROM automation_jobs GROUP BY status`);
    return Object.fromEntries(r.rows.map(x => [x.status, x.n]));
  }
  async function cleanup(days = 30) {
    // Completed jobs older than N days are removed (their runs cascade). Failed/dead-letter jobs are KEPT.
    const r = await pool.query(`DELETE FROM automation_jobs WHERE status = 'completed' AND completed_at < now() - ($1 || ' days')::interval`, [String(days)]);
    return r.rowCount;
  }
  return { register, enqueue, every, dailyAt, weeklyOn, enqueueDue, tick, runJob, claim, reclaimStale, retry, list, counts, cleanup, workerId };
}
module.exports = { createJobEngine };
