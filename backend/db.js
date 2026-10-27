const { Pool } = require('pg');
const bcrypt = require('bcrypt');

// Real client-server database: PostgreSQL via a connection pool, replacing the previous
// SQLite/better-sqlite3 embedded-file setup. This is the one unavoidable, structural
// consequence of that move: every function below is now async (returns a Promise), since
// Postgres is a network database, not a local synchronous file. Every call site in server.js
// must `await` these, and every route handler that calls one must be `async`.
//
// Connection string comes from DATABASE_URL — the standard Postgres env var name, and exactly
// what Render's (or any managed Postgres provider's) connection string env var is named.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
  // Without these, a managed Postgres provider (Supabase, Render Postgres, etc.) silently
  // dropping an idle connection — which they do routinely — has no bounded recovery: a new
  // query can hang indefinitely waiting for a connection that will never come free, and a
  // connection lost while idle has nowhere to report the error. connectionTimeoutMillis caps
  // how long a query will ever wait for a pool slot before failing loudly instead of hanging.
  max: Number(process.env.DB_POOL_MAX) || 10,
  connectionTimeoutMillis: 10000,
  // Opening a connection to the database (Supabase, Tokyo) from the server (Render, Oregon) costs
  // several ocean round trips — TCP, TLS, auth — about half a second each. With a 30s idle timeout
  // every pause longer than 30s threw all connections away, so the next screen load (or login)
  // re-opened ~10 of them at once and every request took 1.5–2s. Keep them for 10 minutes, with
  // TCP keep-alive so routers in between don't silently drop them, and keep a few warm (warmPool).
  idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS) || 10 * 60 * 1000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 30000,
  // Idle connections must never keep a command-line script (backup, restore, reset-password…)
  // running after it has finished; the web server stays up because it is listening anyway.
  allowExitOnIdle: true,
  // No single query may run longer than this — a stuck query fails fast instead of holding a pool
  // slot for minutes while every other request queues behind it (the 15–140s request durations).
  statement_timeout: Number(process.env.DB_STATEMENT_TIMEOUT_MS) || 25000,
  query_timeout: Number(process.env.DB_STATEMENT_TIMEOUT_MS) + 5000 || 30000,
});
// THE critical missing piece: pg's Pool emits an 'error' event whenever an already-idle client
// in the pool hits a connection-level problem (the remote database closing it, a network blip,
// the provider recycling connections) — completely separate from any error a query itself might
// raise. With no listener for this event, that error becomes an uncaught exception and **crashes
// the entire Node process** — not a graceful failure, a hard crash. On a remote, managed database
// this isn't a rare edge case; it happens routinely, and every time it does, the whole app goes
// down and Render restarts it, producing exactly the kind of intermittent, hard-to-reproduce-
// locally failure burst that shows up as a degraded (not zero) success rate in production. Log
// it and move on — the pool itself recovers by opening a fresh connection on the next query.
pool.on('error', (err) => {
  console.error('Postgres pool error (idle client lost connection — this is expected occasionally on a remote database and does not need to crash the app):', err.message);
});

// Translates better-sqlite3-style `?` positional placeholders into Postgres's `$1, $2, ...` —
// keeps every query below readable and close to its original SQLite form, rather than requiring
// every single query to be hand-renumbered.
function q(sql, params) {
  let i = 0;
  return { text: sql.replace(/\?/g, () => `$${++i}`), values: params || [] };
}
// ---- instrumentation + change tracking ----
// DB_SIMULATED_LATENCY_MS (tests/benchmarks only) adds a fixed delay to every query, to reproduce
// production, where the app server (Render, Oregon) and the database (Supabase, Tokyo) are an
// ocean apart and EVERY query pays a ~100–150ms round trip. Query count is what matters there.
const SIMULATED_LATENCY_MS = Number(process.env.DB_SIMULATED_LATENCY_MS) || 0;
let queryCount = 0;
// dataVersion goes up whenever anything users can see is written. Clients poll it (cheap, no
// database) and only re-download data when it changed; server-side caches are keyed on it.
let dataVersion = 0;
const writeListeners = [];
const USER_CACHE_TTL_MS = 60000;
const userRowCache = new Map();
let userListCache = null;
let usersVersion = 0;
writeListeners.push((table) => { if (table === 'users') { usersVersion++; userRowCache.clear(); userListCache = null; } });
// Writes that don't change anything shown to users (login bookkeeping, the audit trail).
// Chat has its own counter: a chat message must not make every open screen re-download all task
// data (which dataVersion triggers). Clients watch chatVersion separately and refresh only chat.
const UNTRACKED_TABLES = new Set(['sessions', 'audit_log', 'chat_messages', 'chat_files', 'chat_reads', 'chat_private', 'chat_private_members']);
let chatVersion = 0;
function noteWrite(text) {
  const m = /^\s*(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?(\w+)/i.exec(text);
  if (!m) return;
  const table = m[1].toLowerCase();
  if (table.startsWith('chat_')) chatVersion++;
  if (UNTRACKED_TABLES.has(table)) return;
  dataVersion++;
  for (const fn of writeListeners) { try { fn(table); } catch (e) { /* listeners must never break a write */ } }
}
async function query(executor, sql, params) {
  queryCount++;
  if (SIMULATED_LATENCY_MS) await new Promise(r => setTimeout(r, SIMULATED_LATENCY_MS));
  const qq = q(sql, params);
  const r = await executor.query(qq);
  noteWrite(qq.text);
  return r;
}
async function run(sql, params) { return query(pool, sql, params); }
// Keeps DB_POOL_WARM connections open and ready (default 4 — a page load fires ~10 requests in
// parallel). Runs once at start-up and then every 4 minutes, well inside the idle timeout. Costs
// a few `SELECT 1`s, no data. Off when DB_POOL_WARM=0 (tests set it so they don't hold connections).
const POOL_WARM = process.env.DB_POOL_WARM === undefined ? 4 : Number(process.env.DB_POOL_WARM) || 0;
let warmTimer = null;
async function warmPool() {
  const n = Math.min(POOL_WARM, Number(process.env.DB_POOL_MAX) || 10);
  if (!n) return;
  const clients = [];
  try {
    for (const c of await Promise.allSettled(Array.from({ length: n }, () => pool.connect()))) if (c.status === 'fulfilled') clients.push(c.value);
    await Promise.allSettled(clients.map(c => c.query('SELECT 1')));
  } finally { clients.forEach(c => c.release()); }
}
function startPoolWarmer() {
  if (!POOL_WARM || warmTimer) return;
  warmPool().catch(() => {});
  warmTimer = setInterval(() => { warmPool().catch(() => {}); }, 4 * 60 * 1000);
  warmTimer.unref();
}
async function get(sql, params) { const r = await query(pool, sql, params); return r.rows[0]; }
async function all(sql, params) { const r = await query(pool, sql, params); return r.rows; }

// The Postgres equivalent of better-sqlite3's synchronous `db.transaction(fn)()` wrapper — one
// dedicated client from the pool so BEGIN/COMMIT/ROLLBACK all happen on the same connection, and
// a genuine rollback on any error instead of a partial write staying committed.
async function runInTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tx = {
      run: async (sql, params) => query(client, sql, params),
      get: async (sql, params) => (await query(client, sql, params)).rows[0],
      all: async (sql, params) => (await query(client, sql, params)).rows,
    };
    const result = await fn(tx);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    dataVersion++;
    throw e;
  } finally {
    client.release();
  }
}

let schemaVersion = null;
let _taskListColumns = null;
// Every tasks column except the (potentially many-MB) attachment data — used by the list
// endpoints so loading thousands of tasks never drags every attached file across the network.
async function taskListColumns() {
  if (_taskListColumns) return _taskListColumns;
  const rows = await all("SELECT column_name FROM information_schema.columns WHERE table_name='tasks' AND table_schema=current_schema() ORDER BY ordinal_position");
  _taskListColumns = rows.map(r => r.column_name).filter(c => c !== 'attachment').map(c => `t."${c}"`).join(', ');
  return _taskListColumns;
}
async function ensureColumn(table, column, decl) {
  // Postgres supports "IF NOT EXISTS" directly on ADD COLUMN (SQLite never did, which is why
  // this used to manually check information_schema.columns first) — that manual check had a
  // real bug on Postgres specifically: it didn't filter by schema, so it could see a
  // same-named column in a completely different schema (e.g. a different test's isolated
  // schema) and wrongly conclude it already existed here too. Letting Postgres's own
  // IF NOT EXISTS handle it is both simpler and correctly schema-scoped by default.
  await run(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${decl}`);
}

// Runs once at startup (server.js must `await db.init()` before listening) — creates every
// table if it doesn't exist, applies every column migration, backfills the teams table, and
// seeds the default/legacy accounts on first run. All of this used to happen as synchronous
// top-level code at module load; Postgres makes that impossible (every query is a Promise), so
// it's now one explicit async function instead.
async function init() {
  await run(`
    CREATE TABLE IF NOT EXISTS users(
      username TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      name TEXT NOT NULL,
      email TEXT,
      team TEXT,
      is_team_lead INTEGER DEFAULT 0,
      token_version INTEGER DEFAULT 0,
      must_change_password INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS teams(
      name TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS projects(
      name TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS drawing_sections(
      name TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS period_awards(
      id SERIAL PRIMARY KEY,
      period_type TEXT NOT NULL,
      period_label TEXT NOT NULL,
      rank INTEGER NOT NULL,
      username TEXT NOT NULL,
      name TEXT NOT NULL,
      team TEXT,
      rating REAL,
      completions INTEGER,
      awarded_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS period_tracking(
      period_type TEXT PRIMARY KEY,
      last_processed_label TEXT
    );
    CREATE TABLE IF NOT EXISTS task_phases(
      name TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS drawings(
      id SERIAL PRIMARY KEY,
      project TEXT NOT NULL,
      section TEXT,
      title TEXT,
      file_name TEXT,
      file_data TEXT,
      uploaded_by_username TEXT,
      uploaded_by_name TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions(
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      device TEXT,
      ip TEXT,
      created_at TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      revoked INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS tasks(
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      priority TEXT NOT NULL DEFAULT 'medium',
      deadline TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      created_by TEXT,
      created_by_username TEXT,
      depends_on_task_id TEXT,
      attachment TEXT,
      attachment_name TEXT,
      is_drawing_request INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      closed_at TEXT,
      closed_by TEXT
    );
    CREATE TABLE IF NOT EXISTS task_assignees(
      task_id TEXT NOT NULL,
      username TEXT NOT NULL,
      team TEXT,
      completed_at TEXT,
      completed_by TEXT,
      decision TEXT,
      last_reminded_at TEXT,
      reminder_3day_sent_at TEXT,
      warning_7day_sent_at TEXT,
      warning_12day_sent_at TEXT,
      PRIMARY KEY (task_id, username)
    );
    CREATE TABLE IF NOT EXISTS task_checklist_items(
      id SERIAL PRIMARY KEY,
      task_id TEXT NOT NULL,
      text TEXT NOT NULL,
      is_checked INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_followups(
      task_id TEXT NOT NULL,
      username TEXT NOT NULL,
      tagged_by TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (task_id, username)
    );
    CREATE TABLE IF NOT EXISTS task_replies(
      id SERIAL PRIMARY KEY,
      task_id TEXT NOT NULL,
      by_username TEXT,
      by_name TEXT,
      message TEXT,
      attachment TEXT,
      attachment_name TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS approval_requests(
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      file_data TEXT,
      file_name TEXT,
      created_by_username TEXT,
      created_by_name TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );
    CREATE TABLE IF NOT EXISTS approval_reviewers(
      request_id TEXT NOT NULL,
      username TEXT NOT NULL,
      decision TEXT,
      decided_at TEXT,
      reason TEXT,
      PRIMARY KEY (request_id, username)
    );
    CREATE TABLE IF NOT EXISTS approval_history(
      id SERIAL PRIMARY KEY,
      request_id TEXT NOT NULL,
      actor_username TEXT,
      actor_name TEXT,
      event_text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_log(
      id SERIAL PRIMARY KEY,
      actor_username TEXT,
      actor_name TEXT,
      action TEXT NOT NULL,
      details TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notifications(
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      task_id TEXT,
      read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS push_subscriptions(
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  await ensureColumn('users', 'email', 'TEXT');
  await ensureColumn('users', 'designation', 'TEXT');
  await ensureColumn('users', 'failed_login_count', 'INTEGER DEFAULT 0');
  await ensureColumn('users', 'locked_until', 'TEXT');
  // Welcome guide (language → video → questions): new accounts must finish it once.
  // Admin can let anyone (e.g. the purchase head's assistant in another department) manage deliveries.
  await ensureColumn('users', 'manage_deliveries', 'INTEGER DEFAULT 0');
  await ensureColumn('users', 'needs_guide', 'INTEGER DEFAULT 0');
  await ensureColumn('users', 'guide_done_at', 'TEXT');
  await ensureColumn('users', 'guide_lang', 'TEXT');
  await ensureColumn('users', 'guide_score', 'INTEGER');
  await ensureColumn('users', 'guide_total', 'INTEGER');
  await ensureColumn('users', 'guide_attempts', 'INTEGER');
  await ensureColumn('task_assignees', 'submitted_at', 'TEXT');
  await ensureColumn('task_assignees', 'submission_note', 'TEXT');
  await ensureColumn('task_assignees', 'escalation_baseline_at', 'TEXT');
  await ensureColumn('task_assignees', 'stage', 'INTEGER DEFAULT 1');
  await ensureColumn('task_assignees', 'is_released', 'INTEGER DEFAULT 1');
  await ensureColumn('task_assignees', 'released_at', 'TEXT');
  await ensureColumn('task_assignees', 'released_by', 'TEXT');
  await ensureColumn('tasks', 'auto_release_stages', 'INTEGER DEFAULT 0');
  await ensureColumn('drawings', 'section', 'TEXT');
  await ensureColumn('tasks', 'cancelled_at', 'TEXT');
  await ensureColumn('tasks', 'cancelled_by', 'TEXT');
  await ensureColumn('tasks', 'cancel_reason', 'TEXT');
  await ensureColumn('tasks', 'deadline_reminder_sent', 'INTEGER DEFAULT 0');
  await ensureColumn('tasks', 'deadline_overdue_notified', 'INTEGER DEFAULT 0');
  await ensureColumn('tasks', 'ai_summary', 'TEXT');
  await ensureColumn('tasks', 'ai_summary_reply_count', 'INTEGER DEFAULT 0');
  await ensureColumn('task_assignees', 'warning_5day_sent_at', 'TEXT');
  await ensureColumn('tasks', 'report_data', 'TEXT');
  await ensureColumn('tasks', 'report_generated_at', 'TEXT');
  await ensureColumn('tasks', 'version', 'INTEGER DEFAULT 1');
  await ensureColumn('audit_log', 'ip_address', 'TEXT');
  await ensureColumn('audit_log', 'device', 'TEXT');
  await ensureColumn('audit_log', 'actor_team', 'TEXT');
  await ensureColumn('users', 'password_reset_otp_hash', 'TEXT');
  await ensureColumn('users', 'password_reset_otp_expires', 'TEXT');
  await ensureColumn('users', 'visible_departments', 'TEXT');
  await ensureColumn('task_assignees', 'individual_deadline', 'TEXT');
  await ensureColumn('users', 'phone', 'TEXT');
  await ensureColumn('tasks', 'parent_task_id', 'TEXT');
  await ensureColumn('tasks', 'project', 'TEXT');
  await ensureColumn('notifications', 'read_at', 'TEXT');
  // What a notification is about when it is not a task (approval request id, payment id) — for action buttons.
  await ensureColumn('notifications', 'ref_type', 'TEXT');
  await ensureColumn('notifications', 'ref_id', 'TEXT');
  await run(`CREATE TABLE IF NOT EXISTS task_closure_requests(
    id SERIAL PRIMARY KEY,
    task_id TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    decided_by TEXT,
    decision_note TEXT,
    created_at TEXT NOT NULL,
    decided_at TEXT
  )`);
  await run('CREATE INDEX IF NOT EXISTS idx_closure_req_task ON task_closure_requests(task_id, status)');
  await run('CREATE INDEX IF NOT EXISTS idx_closure_req_user ON task_closure_requests(requested_by, created_at)');
  await ensureColumn('tasks', 'client_request_id', 'TEXT'); // one per New Task form — stops a double tap creating two tasks
  await run('CREATE INDEX IF NOT EXISTS idx_tasks_client_request ON tasks(created_by_username, client_request_id) WHERE client_request_id IS NOT NULL'); // when the person first saw it (the ✓ on the Notifications page)
  await ensureColumn('tasks', 'phase', 'TEXT');
  await ensureColumn('task_assignees', 'deadline_reminder_sent_at', 'TEXT');
  await ensureColumn('task_assignees', 'deadline_overdue_notified_at', 'TEXT');
  await ensureColumn('task_assignees', 'last_recurring_reminder_at', 'TEXT');
  await ensureColumn('task_assignees', 'warning_48hr_sent_at', 'TEXT');
  await ensureColumn('task_assignees', 'flagged_60hr_sent_at', 'TEXT');
  await ensureColumn('task_assignees', 'individual_deadline_set_at', 'TEXT');
  await ensureColumn('task_assignees', 'deadline_reminder_24h_sent_at', 'TEXT');
  await ensureColumn('task_assignees', 'deadline_reminder_12h_sent_at', 'TEXT');
  await ensureColumn('task_assignees', 'deadline_reminder_6h_sent_at', 'TEXT');
  await ensureColumn('task_assignees', 'deadline_reminder_2h_sent_at', 'TEXT');
  // Permanent key from an imported schedule row (e.g. "EQX-1A-3F9C21") — lets re-uploading an
  // updated schedule change the deadlines of tasks already imported, instead of duplicating them.
  await run('CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at)');
  await run('CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor_username, created_at)');
  await run('CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action)');
  await ensureColumn('tasks', 'import_key', 'TEXT');
  // The deadline this row had in the file when last imported — so a re-upload only changes a
  // deadline when the FILE changed, never undoing a change someone made inside the app.
  await ensureColumn('tasks', 'import_deadline', 'TEXT');
  // Completed tasks "removed from the site" (hidden from task screens, heavy data deleted) but
  // kept as a summary for history exports, schedule timestamps and reports.
  await ensureColumn('tasks', 'archived_at', 'TEXT');
  await ensureColumn('tasks', 'archive_summary', 'TEXT');
  // The last uploaded copy of each schedule file — "download it again with timestamps filled in".
  await run(`CREATE TABLE IF NOT EXISTS import_files(
    id SERIAL PRIMARY KEY, file_name TEXT NOT NULL, data TEXT NOT NULL, uploaded_by TEXT, uploaded_at TEXT NOT NULL)`);
  // Multiple attachments per task / per reply. reply_id NULL = attached to the task itself.
  // Deleting a task or a reply removes its files with it.
  await run(`CREATE TABLE IF NOT EXISTS task_files(
    id SERIAL PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    reply_id INTEGER REFERENCES task_replies(id) ON DELETE CASCADE,
    name TEXT NOT NULL, data TEXT NOT NULL, uploaded_by TEXT, created_at TEXT NOT NULL)`);
  await run('CREATE INDEX IF NOT EXISTS idx_task_files_task ON task_files(task_id)');
  // Deliveries: material coming to a site — who is bringing it (Porter order, driver, vehicle), who receives
  // it, and photo proof of delivery and of unloading, each with its time. Optionally linked to a task.
  await run(`CREATE TABLE IF NOT EXISTS deliveries(
    id SERIAL PRIMARY KEY, ref TEXT UNIQUE NOT NULL, title TEXT NOT NULL, quantity TEXT, description TEXT,
    vendor TEXT, project TEXT, site_location TEXT, transport TEXT, porter_order_id TEXT, delivery_ref TEXT,
    driver_name TEXT, driver_phone TEXT, vehicle_no TEXT, expected_at TEXT, receivers TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'scheduled', task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    created_by TEXT NOT NULL, created_by_name TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    dispatched_at TEXT, dispatched_by TEXT,
    delivered_at TEXT, delivered_by TEXT, delivered_note TEXT,
    unloaded_at TEXT, unloaded_by TEXT, unloaded_note TEXT,
    cancelled_at TEXT, cancelled_by TEXT, cancel_reason TEXT)`);
  await run('CREATE INDEX IF NOT EXISTS idx_deliveries_task ON deliveries(task_id)');
  await ensureColumn('deliveries', 'closed_task', 'INTEGER DEFAULT 0'); // 1 = adding it to Deliveries closed its task
  await ensureColumn('deliveries', 'last_followup_at', 'TEXT');
  // Budget for porter / transport / unloading, and which documents this delivery needs.
  await ensureColumn('deliveries', 'budget_amount', 'NUMERIC(12,2)');
  await ensureColumn('deliveries', 'budget_note', 'TEXT');
  await ensureColumn('deliveries', 'required_docs', "TEXT DEFAULT 'challan,signed_challan'");
  await run(`CREATE TABLE IF NOT EXISTS delivery_payments(
    id SERIAL PRIMARY KEY, delivery_id INTEGER NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
    amount NUMERIC(12,2) NOT NULL CHECK (amount > 0), purpose TEXT NOT NULL, paid_to TEXT, mode TEXT, paid_at TEXT NOT NULL,
    note TEXT, no_bill_reason TEXT, paid_by TEXT NOT NULL, paid_by_name TEXT, created_at TEXT NOT NULL)`);
  await run('CREATE INDEX IF NOT EXISTS idx_delivery_payments_delivery ON delivery_payments(delivery_id)');
  // Allotted money (advance / imprest): Director or Admin gives a site person an amount; that person pays porters etc.
  // on their behalf and records each payment with its bill; the Director verifies each one.
  // A payment may be for a delivery or not (delivery_id NULL); deleting a delivery keeps its payments.
  await run('ALTER TABLE delivery_payments ALTER COLUMN delivery_id DROP NOT NULL');
  await ensureColumn('delivery_payments', 'delivery_ref', 'TEXT');
  await ensureColumn('delivery_payments', 'delivery_title', 'TEXT');
  await ensureColumn('delivery_payments', 'verify_status', "TEXT DEFAULT 'pending'"); // pending | verified | rejected | query
  await ensureColumn('delivery_payments', 'verify_note', 'TEXT');
  await ensureColumn('delivery_payments', 'verified_by', 'TEXT');
  await ensureColumn('delivery_payments', 'verified_at', 'TEXT');
  await ensureColumn('delivery_payments', 'reply_note', 'TEXT'); // the payer's answer to a question
  await run(`CREATE TABLE IF NOT EXISTS budget_allotments(
    id SERIAL PRIMARY KEY, username TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'allot', amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    note TEXT, mode TEXT, reference TEXT, by_username TEXT NOT NULL, by_name TEXT, created_at TEXT NOT NULL)`);
  await run('CREATE INDEX IF NOT EXISTS idx_budget_allotments_user ON budget_allotments(username)');
  await ensureColumn('users', 'budget_topup_asked_at', 'TEXT');
  await ensureColumn('deliveries', 'last_followup_by', 'TEXT');
  await ensureColumn('deliveries', 'followup_count', 'INTEGER DEFAULT 0');
  await run('CREATE INDEX IF NOT EXISTS idx_deliveries_status ON deliveries(status, expected_at)');
  await run(`CREATE TABLE IF NOT EXISTS delivery_files(
    id SERIAL PRIMARY KEY, delivery_id INTEGER NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'attachment', name TEXT NOT NULL, data TEXT NOT NULL,
    taken_at TEXT, uploaded_by TEXT, created_at TEXT NOT NULL)`);
  await run('CREATE INDEX IF NOT EXISTS idx_delivery_files_delivery ON delivery_files(delivery_id)');
  // ---- Accounts payable: vendor bills sent by Purchase, credit period, payment by Accounts ----
  await run(`CREATE TABLE IF NOT EXISTS ap_bills(
    id SERIAL PRIMARY KEY, ref TEXT UNIQUE NOT NULL, vendor TEXT NOT NULL, bill_no TEXT, bill_date TEXT, amount NUMERIC(16,2) NOT NULL,
    credit_days INTEGER, due_date TEXT NOT NULL, project TEXT, delivery_id INTEGER, delivery_ref TEXT, delivery_done_on TEXT, description TEXT,
    status TEXT NOT NULL DEFAULT 'open', paid_amount NUMERIC(16,2) NOT NULL DEFAULT 0, scheduled_for TEXT, hold_reason TEXT,
    source TEXT NOT NULL DEFAULT 'manual', created_by TEXT NOT NULL, created_by_name TEXT, created_at TEXT NOT NULL, updated_at TEXT,
    last_followup_at TEXT, last_followup_by TEXT, followup_count INTEGER NOT NULL DEFAULT 0, paid_at TEXT)`);
  await run('CREATE INDEX IF NOT EXISTS idx_ap_bills_status ON ap_bills(status, due_date)');
  await run(`CREATE TABLE IF NOT EXISTS ap_bill_events(
    id SERIAL PRIMARY KEY, bill_id INTEGER NOT NULL REFERENCES ap_bills(id) ON DELETE CASCADE, kind TEXT NOT NULL, message TEXT,
    amount NUMERIC(16,2), pay_date TEXT, pay_mode TEXT, pay_ref TEXT, by_username TEXT, by_name TEXT, created_at TEXT NOT NULL)`);
  await run('CREATE INDEX IF NOT EXISTS idx_ap_bill_events ON ap_bill_events(bill_id)');
  await run(`CREATE TABLE IF NOT EXISTS ap_files(
    id SERIAL PRIMARY KEY, bill_id INTEGER NOT NULL REFERENCES ap_bills(id) ON DELETE CASCADE, event_id INTEGER, kind TEXT NOT NULL DEFAULT 'bill',
    name TEXT NOT NULL, data TEXT NOT NULL, uploaded_by TEXT, created_at TEXT NOT NULL)`);
  await run('CREATE INDEX IF NOT EXISTS idx_ap_files_bill ON ap_files(bill_id)');
  // ---- Estimation & Billing: JMR (joint measurement records) and material reconciliation ----
  await run(`CREATE TABLE IF NOT EXISTS est_jmr(
    id SERIAL PRIMARY KEY, ref TEXT UNIQUE NOT NULL, project TEXT NOT NULL, location TEXT, work_item TEXT NOT NULL, boq_item TEXT,
    contractor TEXT, unit TEXT NOT NULL, rate NUMERIC(14,2), measured_on TEXT, period_from TEXT, period_to TEXT, ra_bill_no TEXT,
    client_rep TEXT, contractor_rep TEXT, notes TEXT, total_qty NUMERIC(16,3) NOT NULL DEFAULT 0, amount NUMERIC(16,2),
    status TEXT NOT NULL DEFAULT 'draft', created_by TEXT NOT NULL, created_by_name TEXT, created_at TEXT NOT NULL, updated_at TEXT,
    submitted_at TEXT, decided_by TEXT, decided_by_name TEXT, decided_at TEXT, decision_note TEXT)`);
  await run('CREATE INDEX IF NOT EXISTS idx_est_jmr_key ON est_jmr(project, work_item, contractor)');
  await run(`CREATE TABLE IF NOT EXISTS est_jmr_lines(
    id SERIAL PRIMARY KEY, jmr_id INTEGER NOT NULL REFERENCES est_jmr(id) ON DELETE CASCADE, sort INTEGER NOT NULL DEFAULT 0,
    description TEXT, nos NUMERIC(14,3), length NUMERIC(14,3), breadth NUMERIC(14,3), height NUMERIC(14,3),
    qty NUMERIC(16,3) NOT NULL DEFAULT 0, manual INTEGER NOT NULL DEFAULT 0, deduct INTEGER NOT NULL DEFAULT 0, remarks TEXT)`);
  await run('CREATE INDEX IF NOT EXISTS idx_est_jmr_lines ON est_jmr_lines(jmr_id)');
  await run(`CREATE TABLE IF NOT EXISTS est_recon(
    id SERIAL PRIMARY KEY, ref TEXT UNIQUE NOT NULL, project TEXT NOT NULL, material TEXT NOT NULL, unit TEXT NOT NULL, contractor TEXT,
    work_item TEXT, period_from TEXT, period_to TEXT,
    issued NUMERIC(16,3) NOT NULL DEFAULT 0, returned NUMERIC(16,3) NOT NULL DEFAULT 0, balance_at_site NUMERIC(16,3) NOT NULL DEFAULT 0,
    work_qty NUMERIC(16,3) NOT NULL DEFAULT 0, work_unit TEXT, norm NUMERIC(16,6) NOT NULL DEFAULT 0, wastage_pct NUMERIC(8,3) NOT NULL DEFAULT 0,
    rate NUMERIC(14,2), notes TEXT,
    status TEXT NOT NULL DEFAULT 'draft', created_by TEXT NOT NULL, created_by_name TEXT, created_at TEXT NOT NULL, updated_at TEXT,
    submitted_at TEXT, decided_by TEXT, decided_by_name TEXT, decided_at TEXT, decision_note TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS est_files(
    id SERIAL PRIMARY KEY, parent_type TEXT NOT NULL, parent_id INTEGER NOT NULL, name TEXT NOT NULL, data TEXT NOT NULL,
    uploaded_by TEXT, created_at TEXT NOT NULL)`);
  await run('CREATE INDEX IF NOT EXISTS idx_est_files_parent ON est_files(parent_type, parent_id)');
  await ensureColumn('est_files', 'kind', "TEXT NOT NULL DEFAULT 'attachment'"); // 'source' = the HighRise / estimation document
  await run('ALTER TABLE delivery_files ALTER COLUMN delivery_id DROP NOT NULL'); // bills of payments not tied to a delivery
  await ensureColumn('delivery_files', 'doc_type', 'TEXT');
  await ensureColumn('delivery_files', 'note', 'TEXT');
  await ensureColumn('delivery_files', 'payment_id', 'INTEGER');
  // Chat: 'general' (everyone) or 'team:<department>' rooms; files hang off a message.
  await run(`CREATE TABLE IF NOT EXISTS chat_messages(
    id SERIAL PRIMARY KEY, room TEXT NOT NULL DEFAULT 'general',
    by_username TEXT NOT NULL, by_name TEXT, message TEXT, created_at TEXT NOT NULL, deleted_at TEXT)`);
  await run('CREATE INDEX IF NOT EXISTS idx_chat_room_time ON chat_messages(room, id)');
  await run(`CREATE TABLE IF NOT EXISTS chat_files(
    id SERIAL PRIMARY KEY, message_id INTEGER NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    name TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL)`);
  await run('CREATE INDEX IF NOT EXISTS idx_chat_files_msg ON chat_files(message_id)');
  await run(`CREATE TABLE IF NOT EXISTS chat_reads(
    username TEXT NOT NULL, room TEXT NOT NULL, last_read_id INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(username, room))`);
  // Announcements: circulated to everyone; event_date (optional) puts it on the calendar.
  await run(`CREATE TABLE IF NOT EXISTS announcements(
    id SERIAL PRIMARY KEY, title TEXT NOT NULL, body TEXT, emoji TEXT, category TEXT,
    event_date TEXT, pinned INTEGER DEFAULT 0,
    created_by_username TEXT, created_by_name TEXT, created_at TEXT NOT NULL, deleted_at TEXT)`);
  await run('CREATE INDEX IF NOT EXISTS idx_tasks_import_key ON tasks(import_key)');
  await run('CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id)');
  await run('CREATE INDEX IF NOT EXISTS idx_task_assignees_user ON task_assignees(username)');
  await run('CREATE INDEX IF NOT EXISTS idx_task_replies_task ON task_replies(task_id)');
  await run('CREATE INDEX IF NOT EXISTS idx_task_checklist_task ON task_checklist_items(task_id)');
  await run('CREATE INDEX IF NOT EXISTS idx_task_followups_task ON task_followups(task_id)');
  _taskListColumns = null;

  const existingTeams = await all("SELECT DISTINCT team FROM users WHERE team IS NOT NULL AND team != ''");
  for (const r of existingTeams) {
    await run('INSERT INTO teams(name, created_at) VALUES(?, ?) ON CONFLICT (name) DO NOTHING', [r.team, new Date().toISOString()]);
  }

  // Versioned migrations (backend/migrations.js) — after the legacy schema code above.
  schemaVersion = await require('./migrations').runMigrations(pool, (m) => console.log(m));
  startPoolWarmer();
  // Older builds stacked a new copy of the same automatic reminder at every slot (9 AM, 3 PM, 6 PM...).
  // Keep only the newest automatic reminder/warning per person per task. Runs in the background after
  // start-up, in batches, so a large backlog never delays the server; safe to run on every start.
  setTimeout(() => module.exports.dedupeAutoNotifications().catch(e => console.error('Reminder de-duplication skipped:', e.message)), 5000).unref();
  // Starter accounts are created ONLY on a brand-new, empty database. They used to be re-created
  // on EVERY server start whenever missing — and Render's free plan restarts the server many times
  // a day (it sleeps when idle), so accounts Admin deliberately removed kept coming back, with the
  // default password. Once the company has its own users, the app never adds accounts by itself.
  const userCountRow = await get('SELECT COUNT(*) c FROM users');
  if (Number(userCountRow.c) === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    await run(`INSERT INTO users(username,password_hash,role,name,team,is_team_lead,must_change_password,created_at)
                VALUES('admin',?,'admin','Mihir Sabadra',NULL,1,1,?)`, [hash, new Date().toISOString()]);
    console.log('First run: created default account admin / admin123 — you will be asked to set a real password on first login.');
    const STARTER_ACCOUNTS = [
      { name: 'Rohit Kamble', username: 'rohit.k', team: 'Estimation Department', designation: 'Estimate', teamLead: false },
      { name: 'Suraj Kathale', username: 'suraj_kathale', team: 'Estimation Department', designation: 'Estimate Head', teamLead: true },
      { name: 'Tanishq Mutha', username: 'tanishq.m', team: 'Purchase Department', designation: 'Purchase Lead', teamLead: true },
      { name: 'Tejas', username: 'tejas.l', team: 'Estimation Department', designation: '', teamLead: false },
      { name: 'Yuvraj Patil', username: 'yuvraj.p', team: 'Purchase Department', designation: 'Purchase', teamLead: false },
    ];
    const starterHash = bcrypt.hashSync('MHR123456', 10);
    for (const acc of STARTER_ACCOUNTS) {
      await run(`INSERT INTO users(username,password_hash,role,name,team,designation,is_team_lead,must_change_password,created_at)
                  VALUES(?,?,?,?,?,?,?,1,?) ON CONFLICT (username) DO NOTHING`,
        [acc.username, starterHash, 'member', acc.name, acc.team, acc.designation || null, acc.teamLead ? 1 : 0, new Date().toISOString()]);
      await run('INSERT INTO teams(name, created_at) VALUES(?, ?) ON CONFLICT (name) DO NOTHING', [acc.team, new Date().toISOString()]);
      console.log(`First run: created starter account ${acc.username} (${acc.name}) — temporary password MHR123456, must be changed on first login.`);
    }
  } else {
    const existingAdmin = await get("SELECT username FROM users WHERE username='admin' AND name='Admin'");
    if (existingAdmin) {
      await run("UPDATE users SET name='Mihir Sabadra' WHERE username='admin'");
      console.log('Renamed the default admin account\'s display name to "Mihir Sabadra".');
    }
  }
}

module.exports = {
  init,
  pool, // exposed for a clean shutdown (pool.end()) and for /ready health checks
  runInTransaction,
  getDataVersion() { return dataVersion; },
  // Real database round-trip for readiness checks (never served from a cache).
  async ping() { await pool.query('SELECT 1'); return { schemaVersion }; },
  getChatVersion() { return chatVersion; },
  bumpDataVersion() { dataVersion++; },
  onWrite(fn) { writeListeners.push(fn); },
  getQueryCount() { return queryCount; },

  // ---- users ----
  // Users are read on EVERY request (auth) and several times inside reports — each a full round
  // trip to the database. Cached in memory, dropped the instant anything writes to the users
  // table (login lockouts, password/role changes, deletions…), and never older than a minute.
  async getUser(username) {
    const hit = userRowCache.get(username);
    if (hit && Date.now() - hit.at < USER_CACHE_TTL_MS) return hit.row ? { ...hit.row } : undefined;
    const version = usersVersion;
    const row = await get('SELECT * FROM users WHERE username=?', [username]);
    if (version === usersVersion) userRowCache.set(username, { at: Date.now(), row: row || null });
    return row;
  },
  async recordFailedLogin(username) {
    const user = await get('SELECT failed_login_count FROM users WHERE username=?', [username]);
    if (!user) return;
    const count = (user.failed_login_count || 0) + 1;
    const lockedUntil = count >= 5 ? new Date(Date.now() + 3 * 60 * 1000).toISOString() : null;
    await run('UPDATE users SET failed_login_count=?, locked_until=? WHERE username=?', [count, lockedUntil, username]);
  },
  async clearFailedLogins(username) { await run('UPDATE users SET failed_login_count=0, locked_until=NULL WHERE username=?', [username]); },
  async bumpTokenVersion(username) { await run('UPDATE users SET token_version=COALESCE(token_version,0)+1 WHERE username=?', [username]); },
  // Uncached read for security decisions (login, reset codes, password changes) — these must see
  // the database exactly as it is, even if something changed it outside the app.
  async completeGuide(username, { lang, score, total, attempts }) {
    await run('UPDATE users SET needs_guide=0, guide_done_at=?, guide_lang=?, guide_score=?, guide_total=?, guide_attempts=? WHERE username=?',
      [new Date().toISOString(), lang, score, total, attempts, username]);
  },
  async setDeliveryAccess(username, allowed) { await run('UPDATE users SET manage_deliveries=? WHERE username=?', [allowed ? 1 : 0, username]); },
  async requireGuideAgain(username) { await run('UPDATE users SET needs_guide=1, guide_done_at=NULL WHERE username=?', [username]); },
  async getUserFresh(username) { return get('SELECT * FROM users WHERE username=?', [username]); },
  async listUsers() {
    if (userListCache && Date.now() - userListCache.at < USER_CACHE_TTL_MS) return userListCache.rows.map(r => ({ ...r }));
    const version = usersVersion;
    const rows = await all('SELECT username,role,name,email,phone,team,designation,is_team_lead,visible_departments,must_change_password,created_at,needs_guide,guide_done_at,guide_lang,guide_score,guide_total,manage_deliveries FROM users ORDER BY name');
    if (version === usersVersion) userListCache = { at: Date.now(), rows };
    return rows.map(r => ({ ...r }));
  },
  async updateOwnPhone(username, phone) { await run('UPDATE users SET phone=? WHERE username=?', [phone || null, username]); },
  async setVisibleDepartments(username, departmentsCsv) { await run('UPDATE users SET visible_departments=? WHERE username=?', [departmentsCsv || null, username]); },
  async createUser({ username, password_hash, role, name, team, designation, must_change_password }) {
    // Every account created from now on sees the welcome guide once, on its first login.
    await run(`INSERT INTO users(username,password_hash,role,name,team,designation,must_change_password,created_at,needs_guide)
                VALUES(?,?,?,?,?,?,?,?,1)`,
      [username, password_hash, role, name, team || null, designation || null, must_change_password ? 1 : 0, new Date().toISOString()]);
    if (team) await module.exports.addTeam(team);
  },
  async deleteUser(username) { await run('DELETE FROM users WHERE username=?', [username]); },
  // What removing an account would wipe out — shown to Admin before they confirm, so a removal
  // is never a surprise. Mirrors exactly what deleteUserCompletely() below deletes.
  async getAccountDeletionImpact(username) {
    const n = async (sql, params) => Number((await get(sql, params)).c);
    return {
      tasksCreated: await n('SELECT COUNT(*) c FROM tasks WHERE created_by_username=?', [username]),
      openTasksCreated: await n("SELECT COUNT(*) c FROM tasks WHERE created_by_username=? AND status='open'", [username]),
      soleAssigneeTasks: await n(`SELECT COUNT(*) c FROM task_assignees ta JOIN tasks t ON t.id=ta.task_id
        WHERE ta.username=? AND t.created_by_username IS DISTINCT FROM ?
          AND NOT EXISTS (SELECT 1 FROM task_assignees o WHERE o.task_id=ta.task_id AND o.username<>ta.username)`, [username, username]),
      sharedTasks: await n(`SELECT COUNT(*) c FROM task_assignees ta JOIN tasks t ON t.id=ta.task_id
        WHERE ta.username=? AND t.created_by_username IS DISTINCT FROM ?
          AND EXISTS (SELECT 1 FROM task_assignees o WHERE o.task_id=ta.task_id AND o.username<>ta.username)`, [username, username]),
      followups: await n('SELECT COUNT(*) c FROM task_followups WHERE username=?', [username]),
      replies: await n('SELECT COUNT(*) c FROM task_replies WHERE by_username=?', [username]),
      approvalsCreated: await n('SELECT COUNT(*) c FROM approval_requests WHERE created_by_username=?', [username]),
      approvalReviews: await n('SELECT COUNT(*) c FROM approval_reviewers WHERE username=?', [username]),
      drawings: await n('SELECT COUNT(*) c FROM drawings WHERE uploaded_by_username=?', [username]),
      notifications: await n('SELECT COUNT(*) c FROM notifications WHERE username=?', [username]),
    };
  },
  // Permanently removes an account AND everything tied to it, in one transaction (all or
  // nothing — a failure halfway can never leave half-deleted data behind):
  //   - every task they created (with its subtasks, tags, checklist, replies, notifications)
  //   - every task where they were the ONLY person tagged (nothing meaningful is left of it)
  //   - their tag on shared tasks — those tasks are then repaired: levels renumbered so no
  //     level is left waiting on an empty one, the next level released if due, and the task
  //     closed if everyone still on it was already approved
  //   - their follow-ups, replies, notifications, sessions, push subscriptions, period awards
  //   - approval requests they sent; their reviewer slot on others' requests (a request left
  //     with no reviewers is removed; one where everyone left has approved becomes approved)
  //   - drawings they uploaded, only if deleteDrawings is true (project documents — Admin chooses)
  // The audit log is deliberately kept: it's the company's record of who did what, including
  // this removal itself.
  // Returns details the caller needs to notify people and release dependent tasks.
  async deleteUserCompletely(username, { deleteDrawings = false } = {}) {
    return runInTransaction(async (tx) => {
      const now = new Date().toISOString();
      const user = await tx.get('SELECT username, name FROM users WHERE username=?', [username]);
      if (!user) return null;
      const deletedTaskIds = new Set();
      const orphanedOpenTasks = []; // tasks someone else created that were deleted because only this person was on them
      async function deleteTaskTree(taskId) {
        if (deletedTaskIds.has(taskId)) return;
        const subs = await tx.all('SELECT id FROM tasks WHERE parent_task_id=?', [taskId]);
        for (const s of subs) await deleteTaskTree(s.id);
        for (const table of ['notifications', 'task_replies', 'task_followups', 'task_checklist_items', 'task_assignees']) {
          await tx.run(`DELETE FROM ${table} WHERE task_id=?`, [taskId]);
        }
        const r = await tx.run('DELETE FROM tasks WHERE id=?', [taskId]);
        if (r.rowCount > 0) deletedTaskIds.add(taskId);
      }

      // 1. Tasks they created.
      for (const t of await tx.all('SELECT id FROM tasks WHERE created_by_username=?', [username])) await deleteTaskTree(t.id);
      const tasksCreated = deletedTaskIds.size;

      // 2. Tasks where they were the only person tagged.
      const sole = await tx.all(`SELECT t.id, t.title, t.status, t.created_by_username FROM task_assignees ta JOIN tasks t ON t.id=ta.task_id
        WHERE ta.username=? AND NOT EXISTS (SELECT 1 FROM task_assignees o WHERE o.task_id=ta.task_id AND o.username<>ta.username)`, [username]);
      for (const t of sole) {
        if (deletedTaskIds.has(t.id)) continue;
        await deleteTaskTree(t.id);
        if (t.status === 'open' && t.created_by_username && t.created_by_username !== username) orphanedOpenTasks.push({ id: t.id, title: t.title, created_by_username: t.created_by_username });
      }

      // 3. Untag them from every remaining (shared) task, then repair each open one.
      const shared = await tx.all(`SELECT DISTINCT t.id, t.title, t.status, t.auto_release_stages, t.created_by_username
        FROM task_assignees ta JOIN tasks t ON t.id=ta.task_id WHERE ta.username=?`, [username]);
      await tx.run('DELETE FROM task_assignees WHERE username=?', [username]);
      const repairedTasks = [];
      for (const t of shared) {
        if (t.status !== 'open') continue;
        const rows = await tx.all('SELECT username, stage, is_released, decision, completed_at FROM task_assignees WHERE task_id=? ORDER BY stage', [t.id]);
        // Renumber levels 1..n with no gaps (removing the only person on Level 1 would otherwise
        // leave Level 2 on hold forever, waiting for a level that no longer has anyone in it).
        const stages = Array.from(new Set(rows.map(r => r.stage || 1))).sort((a, b) => a - b);
        for (const [idx, oldStage] of stages.entries()) {
          if (oldStage !== idx + 1) await tx.run('UPDATE task_assignees SET stage=? WHERE task_id=? AND stage=?', [idx + 1, t.id, oldStage]);
        }
        const fresh = await tx.all('SELECT username, stage, is_released, decision, completed_at FROM task_assignees WHERE task_id=?', [t.id]);
        const inStage = s => fresh.filter(r => (r.stage || 1) === s);
        const approved = r => r.decision === 'approve' && r.completed_at;
        const released = [];
        const release = async (s) => {
          await tx.run('UPDATE task_assignees SET is_released=1, released_at=?, released_by=?, escalation_baseline_at=? WHERE task_id=? AND stage=? AND is_released=0',
            [now, 'System (account removed)', now, t.id, s]);
          for (const r of inStage(s)) if (!r.is_released) { released.push(r.username); r.is_released = 1; }
        };
        if (inStage(1).some(r => !r.is_released)) await release(1);
        for (let s = 1; s < stages.length; s++) {
          if (!inStage(s).every(approved)) break;
          if (t.auto_release_stages && inStage(s + 1).some(r => !r.is_released)) await release(s + 1);
          else break;
        }
        let closed = false;
        if (fresh.length > 0 && fresh.every(approved)) {
          const r = await tx.run("UPDATE tasks SET status='closed', closed_at=?, closed_by=? WHERE id=? AND status='open'", [now, 'System (account removed)', t.id]);
          if (r.rowCount > 0) { closed = true; await tx.run('DELETE FROM notifications WHERE task_id=?', [t.id]); }
        }
        await tx.run('UPDATE tasks SET version = COALESCE(version, 1) + 1 WHERE id=?', [t.id]);
        repairedTasks.push({ id: t.id, title: t.title, created_by_username: t.created_by_username, closed, released });
      }

      // 4. Everything else personally tied to the account.
      const count = async (sql, params) => (await tx.run(sql, params)).rowCount;
      const followups = await count('DELETE FROM task_followups WHERE username=?', [username]);
      const replies = await count('DELETE FROM task_replies WHERE by_username=?', [username]);
      const notifications = await count('DELETE FROM notifications WHERE username=?', [username]);
      await tx.run('DELETE FROM sessions WHERE username=?', [username]);
      await tx.run('DELETE FROM push_subscriptions WHERE username=?', [username]);
      await tx.run('DELETE FROM period_awards WHERE username=?', [username]);

      // 5. Approvals.
      const ownApprovals = await tx.all('SELECT id FROM approval_requests WHERE created_by_username=?', [username]);
      for (const a of ownApprovals) {
        await tx.run('DELETE FROM approval_reviewers WHERE request_id=?', [a.id]);
        await tx.run('DELETE FROM approval_history WHERE request_id=?', [a.id]);
        await tx.run('DELETE FROM approval_requests WHERE id=?', [a.id]);
      }
      const reviewedRequests = await tx.all('SELECT request_id FROM approval_reviewers WHERE username=?', [username]);
      await tx.run('DELETE FROM approval_reviewers WHERE username=?', [username]);
      await tx.run('DELETE FROM approval_history WHERE actor_username=?', [username]);
      const approvalsCompleted = [];
      for (const { request_id } of reviewedRequests) {
        const req = await tx.get('SELECT id, title, status, created_by_username FROM approval_requests WHERE id=?', [request_id]);
        if (!req) continue;
        const left = await tx.all('SELECT decision FROM approval_reviewers WHERE request_id=?', [request_id]);
        if (left.length === 0) {
          await tx.run('DELETE FROM approval_history WHERE request_id=?', [request_id]);
          await tx.run('DELETE FROM approval_requests WHERE id=?', [request_id]);
        } else if (req.status === 'pending' && left.every(r => r.decision === 'approved')) {
          await tx.run("UPDATE approval_requests SET status='approved', resolved_at=? WHERE id=?", [now, request_id]);
          await tx.run('INSERT INTO approval_history(request_id,actor_username,actor_name,event_text,created_at) VALUES(?,?,?,?,?)',
            [request_id, null, null, 'Fully approved by everyone tagged (a reviewer\'s account was removed)', now]);
          approvalsCompleted.push({ id: req.id, title: req.title, created_by_username: req.created_by_username });
        }
      }

      // 6. Drawings (only if Admin chose to).
      const drawings = deleteDrawings ? await count('DELETE FROM drawings WHERE uploaded_by_username=?', [username]) : 0;

      // 7. Tasks that depended on a deleted task are no longer blocked by it.
      if (deletedTaskIds.size) {
        await tx.run('UPDATE tasks SET depends_on_task_id=NULL WHERE depends_on_task_id = ANY(?::text[])', [Array.from(deletedTaskIds)]);
      }

      await tx.run('DELETE FROM users WHERE username=?', [username]);
      return {
        user,
        summary: {
          tasksDeleted: deletedTaskIds.size, tasksCreated, sharedTasksUntagged: shared.length,
          replies, followups, notifications, approvalsCreated: ownApprovals.length, approvalReviews: reviewedRequests.length, drawings,
        },
        orphanedOpenTasks, repairedTasks, approvalsCompleted,
      };
    });
  },
  async setUserTeam(username, team) {
    await run('UPDATE users SET team=? WHERE username=?', [team || null, username]);
    if (team) await module.exports.addTeam(team);
  },
  async setUserTeamLead(username, isLead) { await run('UPDATE users SET is_team_lead=? WHERE username=?', [isLead ? 1 : 0, username]); },
  async updateOwnName(username, name) { await run('UPDATE users SET name=? WHERE username=?', [name, username]); },
  async updateOwnEmail(username, email) { await run('UPDATE users SET email=? WHERE username=?', [email, username]); },
  async setPasswordResetOtp(username, otpHash, expiresAt) {
    await run('UPDATE users SET password_reset_otp_hash=?, password_reset_otp_expires=? WHERE username=?', [otpHash, expiresAt, username]);
  },
  async clearPasswordResetOtp(username) {
    await run('UPDATE users SET password_reset_otp_hash=NULL, password_reset_otp_expires=NULL WHERE username=?', [username]);
  },
  async updateUserDisplayName(username, name) { await run('UPDATE users SET name=? WHERE username=?', [name, username]); },
  async updateUserDesignation(username, designation) { await run('UPDATE users SET designation=? WHERE username=?', [designation || null, username]); },
  async setPassword(username, hash) {
    await run('UPDATE users SET password_hash=?, must_change_password=0, token_version=COALESCE(token_version,0)+1 WHERE username=?', [hash, username]);
  },
  async forcePasswordReset(username, hash) {
    await run('UPDATE users SET password_hash=?, must_change_password=1, token_version=COALESCE(token_version,0)+1 WHERE username=?', [hash, username]);
  },
  async renameUsername(oldUsername, newUsername) {
    return runInTransaction(async (tx) => {
      await tx.run('UPDATE tasks SET created_by_username=? WHERE created_by_username=?', [newUsername, oldUsername]);
      await tx.run('UPDATE task_assignees SET username=? WHERE username=?', [newUsername, oldUsername]);
      await tx.run('UPDATE task_replies SET by_username=? WHERE by_username=?', [newUsername, oldUsername]);
      await tx.run('UPDATE notifications SET username=? WHERE username=?', [newUsername, oldUsername]);
      await tx.run('UPDATE users SET username=? WHERE username=?', [newUsername, oldUsername]);
    });
  },

  // ---- sessions ----
  async createSession({ id, username, device, ip }) {
    const now = new Date().toISOString();
    await run('INSERT INTO sessions(id,username,device,ip,created_at,last_seen) VALUES(?,?,?,?,?,?)', [id, username, device || null, ip || null, now, now]);
  },
  async getSession(id) { return get('SELECT * FROM sessions WHERE id=?', [id]); },
  async touchSession(id) { await run('UPDATE sessions SET last_seen=? WHERE id=?', [new Date().toISOString(), id]); },
  async revokeSession(id) { await run('UPDATE sessions SET revoked=1 WHERE id=?', [id]); },

  // ---- tasks ----
  // `tx` (optional): pass the object handed to your db.runInTransaction(async (tx) => {...})
  // callback to make this write participate in that same transaction/connection, instead of
  // grabbing its own separate one from the pool — required for real atomicity when several of
  // these calls need to succeed or fail together (e.g. creating a task, its assignees, and their
  // notifications as one unit). Omit it for normal, standalone use.
  async createTask({ id, title, description, priority, deadline, created_by, created_by_username, depends_on_task_id, attachment, attachment_name, is_drawing_request, parent_task_id, project, phase }, tx) {
    if (project) await module.exports.addProject(project, tx);
    if (phase) await module.exports.addPhase(phase, tx);
    const runner = tx ? tx.run : run;
    await runner(`INSERT INTO tasks(id,title,description,priority,deadline,status,created_by,created_by_username,depends_on_task_id,attachment,attachment_name,is_drawing_request,parent_task_id,project,phase,created_at)
                VALUES(?,?,?,?,?,'open',?,?,?,?,?,?,?,?,?,?)`,
      [id, title, description || null, priority, deadline || null, created_by, created_by_username, depends_on_task_id || null, attachment || null, attachment_name || null, is_drawing_request ? 1 : 0, parent_task_id || null, project || null, phase || null, new Date().toISOString()]);
  },
  async getTask(id) { return get('SELECT * FROM tasks WHERE id=?', [id]); },
  // ---- closure requests: a tagged person asks the task's creator to close it ----
  async createClosureRequest({ taskId, username, reason }) {
    return get('INSERT INTO task_closure_requests(task_id, requested_by, reason, status, created_at) VALUES(?,?,?,?,?) RETURNING *', [taskId, username, reason, 'pending', new Date().toISOString()]);
  },
  async getClosureRequest(id) { return get('SELECT * FROM task_closure_requests WHERE id=?', [id]); },
  async pendingClosureRequest(taskId, username) { return get("SELECT * FROM task_closure_requests WHERE task_id=? AND requested_by=? AND status='pending' LIMIT 1", [taskId, username]); },
  async listClosureRequestsToDecide(username, everyTask) {
    return all(`SELECT r.*, t.title AS task_title, t.project AS task_project, t.deadline AS task_deadline, t.priority AS task_priority, t.created_by_username AS task_creator, t.created_by AS task_creator_name
      FROM task_closure_requests r JOIN tasks t ON t.id = r.task_id
      WHERE r.status='pending' AND t.status='open' ${everyTask ? '' : 'AND t.created_by_username=?'} ORDER BY r.created_at`, everyTask ? [] : [username]);
  },
  // Requests the task creator (or Admin) answered with "Keep open" — shown on the Task Closure page.
  async listClosureRequestsKeptOpen(username, everyTask) {
    return all(`SELECT r.*, t.title AS task_title, t.status AS task_status, t.project AS task_project, t.deadline AS task_deadline, t.created_by_username AS task_creator, t.created_by AS task_creator_name
      FROM task_closure_requests r JOIN tasks t ON t.id = r.task_id
      WHERE r.status='declined' ${everyTask ? '' : 'AND (t.created_by_username=? OR r.decided_by=?)'} ORDER BY r.decided_at DESC LIMIT 50`, everyTask ? [] : [username, username]);
  },
  async listMyClosureRequests(username) {
    return all(`SELECT r.*, t.title AS task_title, t.status AS task_status, t.project AS task_project, t.created_by_username AS task_creator, t.created_by AS task_creator_name
      FROM task_closure_requests r JOIN tasks t ON t.id = r.task_id WHERE r.requested_by=? ORDER BY r.created_at DESC LIMIT 50`, [username]);
  },
  async decideClosureRequest(id, status, decidedBy, note) {
    return get("UPDATE task_closure_requests SET status=?, decided_by=?, decision_note=?, decided_at=? WHERE id=? AND status='pending' RETURNING *", [status, decidedBy, note || null, new Date().toISOString(), id]);
  },
  async markClosureApproved(id, decidedBy, note) {
    return get("UPDATE task_closure_requests SET status='approved', decided_by=?, decision_note=?, decided_at=? WHERE id=? RETURNING *", [decidedBy, note || null, new Date().toISOString(), id]);
  },
  // When a task closes (by any route), other open requests on it are settled.
  async settleClosureRequests(taskId, decidedBy) {
    return all("UPDATE task_closure_requests SET status='closed', decided_by=?, decided_at=? WHERE task_id=? AND status='pending' RETURNING *", [decidedBy, new Date().toISOString(), taskId]);
  },
  async findTaskByClientRequest(username, key) { const r = await get('SELECT id FROM tasks WHERE created_by_username=? AND client_request_id=? ORDER BY created_at LIMIT 1', [username, key]); return r ? r.id : null; },
  async findRecentSameTask(username, title, deadline, parentTaskId, sinceIso) {
    const r = await get(`SELECT id FROM tasks WHERE created_by_username=? AND title=? AND COALESCE(deadline,'')=? AND COALESCE(parent_task_id,'')=? AND created_at >= ? ORDER BY created_at LIMIT 1`, [username, title, deadline || '', parentTaskId || '', sinceIso]);
    return r ? r.id : null;
  },
  async listSubtasks(parentTaskId) { return all('SELECT * FROM tasks WHERE parent_task_id=? ORDER BY created_at ASC', [parentTaskId]); },
  async listOpenSubtasks(parentTaskId) { return all("SELECT * FROM tasks WHERE parent_task_id=? AND status='open'", [parentTaskId]); },
  async addTaskAssignee(taskId, username, team, stage, isReleased, individualDeadline, tx) {
    const runner = tx ? tx.run : run;
    await runner('INSERT INTO task_assignees(task_id,username,team,stage,is_released,escalation_baseline_at,individual_deadline) VALUES(?,?,?,?,?,?,?) ON CONFLICT (task_id, username) DO NOTHING',
      [taskId, username, team || null, stage || 1, (isReleased === false ? 0 : 1), new Date().toISOString(), individualDeadline || null]);
  },
  async setIndividualDeadline(taskId, username, deadline) {
    // Tracks WHEN this specific deadline was actually assigned, separate from the deadline value
    // itself — and resets every tiered reminder flag, since a NEW or CHANGED individual deadline
    // means the whole reminder cycle should restart from scratch rather than silently inheriting
    // stale "already reminded" state from a previous deadline that no longer applies.
    await run(`UPDATE task_assignees SET individual_deadline=?, individual_deadline_set_at=?,
                deadline_reminder_sent_at=NULL, deadline_reminder_24h_sent_at=NULL, deadline_reminder_12h_sent_at=NULL,
                deadline_reminder_6h_sent_at=NULL, deadline_reminder_2h_sent_at=NULL, deadline_overdue_notified_at=NULL
                WHERE task_id=? AND username=?`, [deadline || null, deadline ? new Date().toISOString() : null, taskId, username]);
  },
  async isStageFullyApproved(taskId, stage) {
    const rows = await all('SELECT decision, completed_at FROM task_assignees WHERE task_id=? AND stage=?', [taskId, stage]);
    if (rows.length === 0) return false;
    return rows.every(r => r.decision === 'approve' && r.completed_at);

  },
  async hasStage(taskId, stage) {
    const r = await get('SELECT COUNT(*) c FROM task_assignees WHERE task_id=? AND stage=?', [taskId, stage]);
    return Number(r.c) > 0;
  },
  async isStageReleased(taskId, stage) {
    const rows = await all('SELECT is_released FROM task_assignees WHERE task_id=? AND stage=?', [taskId, stage]);
    return rows.length > 0 && rows.every(r => r.is_released);
  },
  async bumpTaskVersion(id) { await run('UPDATE tasks SET version = COALESCE(version, 1) + 1 WHERE id=?', [id]); },
  async releaseStage(taskId, stage, releasedByName) {
    const result = await run('UPDATE task_assignees SET is_released=1, released_at=?, released_by=?, escalation_baseline_at=? WHERE task_id=? AND stage=? AND is_released=0',
      [new Date().toISOString(), releasedByName || null, new Date().toISOString(), taskId, stage]);
    if (result.rowCount === 0) return false;
    await module.exports.bumpTaskVersion(taskId);
    return true;
  },
  // Reshuffles one assignee to a different level (stage) on an existing task. `isReleased`
  // reflects whatever the caller has already determined about the new stage (released
  // immediately if it's Level 1 or the level below it is already fully approved, on hold
  // otherwise) — this function just applies it. When moving someone INTO a released state, their
  // escalation clock restarts from this exact moment, same principle as a normal stage release:
  // their warning/flagging countdown must count from when they actually became free to act at
  // THIS new level, never from whenever they were originally tagged at their old one. Moving
  // someone to an on-hold level clears their release info so they correctly stop being counted
  // as "released" until their new level's turn comes.
  async changeAssigneeStage(taskId, username, newStage, isReleased, changedByName) {
    const now = new Date().toISOString();
    const result = isReleased
      ? await run('UPDATE task_assignees SET stage=?, is_released=1, released_at=?, released_by=?, escalation_baseline_at=? WHERE task_id=? AND username=?',
          [newStage, now, changedByName || null, now, taskId, username])
      : await run('UPDATE task_assignees SET stage=?, is_released=0, released_at=NULL, released_by=NULL WHERE task_id=? AND username=?',
          [newStage, taskId, username]);
    if (result.rowCount === 0) return false;
    await module.exports.bumpTaskVersion(taskId);
    return true;
  },
  async setAutoReleaseStages(taskId, on, tx) { const runner = tx ? tx.run : run; await runner('UPDATE tasks SET auto_release_stages=? WHERE id=?', [on ? 1 : 0, taskId]); },
  async removeTaskAssignee(taskId, username) { await run('DELETE FROM task_assignees WHERE task_id=? AND username=?', [taskId, username]); },
  async listAssignees(taskId) { return all('SELECT * FROM task_assignees WHERE task_id=?', [taskId]); },
  async markAssigneeSubmitted(taskId, username, note) {
    await run('UPDATE task_assignees SET submitted_at=?, submission_note=? WHERE task_id=? AND username=?', [new Date().toISOString(), note || null, taskId, username]);
    await module.exports.bumpTaskVersion(taskId);
  },
  async resetAssigneeSubmission(taskId, username) {
    const result = await run('UPDATE task_assignees SET submitted_at=NULL, submission_note=NULL WHERE task_id=? AND username=? AND submitted_at IS NOT NULL', [taskId, username]);
    if (result.rowCount === 0) return false;
    await module.exports.bumpTaskVersion(taskId);
    return true;
  },
  async markAssigneeDone(taskId, username, byName, decision) {
    const result = await run('UPDATE task_assignees SET completed_at=?, completed_by=?, decision=? WHERE task_id=? AND username=? AND completed_at IS NULL',
      [new Date().toISOString(), byName, decision || 'done', taskId, username]);
    if (result.rowCount === 0) return false;
    await module.exports.bumpTaskVersion(taskId);
    return true;
  },
  async reopenAssignee(taskId, username) {
    await run('UPDATE task_assignees SET completed_at=NULL, completed_by=NULL, decision=NULL, submitted_at=NULL WHERE task_id=? AND username=?', [taskId, username]);
  },
  // Each returns true only if THIS call actually changed the row — false means someone else's
  // simultaneous request already got there first (or the task was never in the expected state
  // to begin with). The WHERE clause's status check is what makes this atomic and race-safe:
  // Postgres guarantees only one concurrent UPDATE can match a given row's current status, so
  // two simultaneous close requests can never both report success.
  async closeTask(id, closedByName) {
    const result = await run("UPDATE tasks SET status='closed', closed_at=?, closed_by=? WHERE id=? AND status='open'", [new Date().toISOString(), closedByName, id]);
    if (result.rowCount === 0) return false;
    await module.exports.bumpTaskVersion(id);
    await module.exports.deleteNotificationsForTask(id);
    return true;
  },
  async cancelTask(id, cancelledByName, reason) {
    const result = await run("UPDATE tasks SET status='cancelled', cancelled_at=?, cancelled_by=?, cancel_reason=? WHERE id=? AND status='open'", [new Date().toISOString(), cancelledByName, reason || null, id]);
    if (result.rowCount === 0) return false;
    await module.exports.bumpTaskVersion(id);
    return true;
  },
  async markAsDrawingRequest(id) { await run('UPDATE tasks SET is_drawing_request=1 WHERE id=?', [id]); },
  async reopenTask(id) {
    const result = await run("UPDATE tasks SET status='open', closed_at=NULL, closed_by=NULL, cancelled_at=NULL, cancelled_by=NULL, cancel_reason=NULL WHERE id=? AND status IN ('closed','cancelled')", [id]);
    if (result.rowCount === 0) return false;
    await module.exports.bumpTaskVersion(id);
    return true;
  },
  // Genuinely, permanently removes a task from the database — not a status change like close or
  // cancel, an actual deletion. Recursively removes any subtasks first (a subtask can't sensibly
  // outlive the parent it belongs to), and everything tied to each task along the way:
  // assignees, checklist items, replies, follow-ups, and any notifications pointing at it. A
  // task depending on this one (via depends_on_task_id) simply stops being blocked afterward —
  // isTaskBlocked() already treats a missing dependency as "not blocked", so nothing extra is
  // needed there. Returns the full list of every task ID actually deleted, so the caller can
  // audit-log and notify accurately even when subtasks were swept up too.
  async deleteTaskCompletely(id) {
    const deletedIds = [];
    async function deleteOne(taskId) {
      const subtasks = await all('SELECT id FROM tasks WHERE parent_task_id=?', [taskId]);
      for (const sub of subtasks) await deleteOne(sub.id);
      await run('DELETE FROM notifications WHERE task_id=?', [taskId]);
      await run('DELETE FROM task_replies WHERE task_id=?', [taskId]);
      await run('DELETE FROM task_followups WHERE task_id=?', [taskId]);
      await run('DELETE FROM task_checklist_items WHERE task_id=?', [taskId]);
      await run('DELETE FROM task_assignees WHERE task_id=?', [taskId]);
      const result = await run('DELETE FROM tasks WHERE id=?', [taskId]);
      if (result.rowCount > 0) deletedIds.push(taskId);
    }
    await deleteOne(id);
    return deletedIds;
  },
  // Every open task currently waiting on an open prerequisite — one query, for the background
  // reminder jobs (they used to ask per row, all at once, flooding the connection pool hourly).
  async listBlockedTaskIds() {
    return new Set((await all(`SELECT t.id FROM tasks t JOIN tasks d ON d.id = t.depends_on_task_id
      WHERE t.status = 'open' AND d.status = 'open'`)).map(r => r.id));
  },
  // Response durations (tagged → submitted, in days) for everyone at once, keyed by username.
  async getResponseDurationsByUser() {
    const rows = await all(`SELECT username, escalation_baseline_at, submitted_at FROM task_assignees
      WHERE decision='approve' AND submitted_at IS NOT NULL AND escalation_baseline_at IS NOT NULL`);
    const byUser = {};
    for (const r of rows) {
      const d = (new Date(r.submitted_at) - new Date(r.escalation_baseline_at)) / 86400000;
      if (d >= 0) (byUser[r.username] = byUser[r.username] || []).push(d);
    }
    return byUser;
  },
  async isTaskBlocked(id) {
    const t = await get('SELECT depends_on_task_id FROM tasks WHERE id=?', [id]);
    if (!t || !t.depends_on_task_id) return false;
    const dep = await get('SELECT status FROM tasks WHERE id=?', [t.depends_on_task_id]);
    return dep ? dep.status === 'open' : false;
  },
  async listTasksForUser(username) {
    // EXISTS instead of an inner JOIN: a task with nobody tagged yet (allowed now) has no
    // task_assignees rows at all, and the old JOIN silently hid it from its own creator.
    return all(`
      SELECT t.* FROM tasks t
      WHERE t.created_by_username = ? OR EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.username = ?)
      ORDER BY t.created_at DESC
    `, [username, username]);
  },
  // Lightweight id/title/status list (no attachments) — used to resolve "Depends On" / "Parent Task" references during bulk import.
  async listTaskRefs() { return all('SELECT id, title, status FROM tasks'); },
  async listAllTasks() { return all('SELECT * FROM tasks ORDER BY created_at DESC LIMIT 5000'); },
  // Same result shape as calling getTaskFullLight() once per task, but in a fixed 7 queries no
  // matter how many tasks — the per-task version cost ~9 queries EACH, which at a few thousand
  // tasks (a full imported schedule) meant tens of thousands of queries on every 8-second refresh.
  // For each task: its most recent closure request, if that request was answered "Keep open" — so everyone
  // on the task sees on the task itself that closing was asked for and declined, and why.
  async closureKeptOpenMap(ids) {
    if (!ids.length) return new Map();
    const rows = await all(`SELECT DISTINCT ON (task_id) task_id, status, requested_by, reason, decided_by, decision_note, decided_at, created_at
      FROM task_closure_requests WHERE task_id = ANY(?::text[]) ORDER BY task_id, created_at DESC`, [ids]);
    return new Map(rows.filter(r => r.status === 'declined').map(r => [r.task_id, { requested_by: r.requested_by, reason: r.reason, decided_by: r.decided_by, decision_note: r.decision_note, decided_at: r.decided_at, asked_at: r.created_at }]));
  },
  async listTasksFullLight(scope, username) {
    const cols = await taskListColumns();
    const tasks = scope === 'user'
      ? await all(`SELECT ${cols}, (t.attachment IS NOT NULL) AS has_attachment FROM tasks t
          WHERE t.archived_at IS NULL AND (t.created_by_username = ? OR EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.username = ?))
          ORDER BY t.created_at DESC`, [username, username])
      : scope === 'watch'
      ? await all(`SELECT ${cols}, (t.attachment IS NOT NULL) AS has_attachment FROM tasks t
          WHERE t.archived_at IS NULL AND EXISTS (SELECT 1 FROM task_followups tf WHERE tf.task_id = t.id AND tf.username = ?)
            AND t.created_by_username IS DISTINCT FROM ? AND NOT EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.username = ?)
          ORDER BY t.created_at DESC LIMIT 1000`, [username, username, username])
      : await all(`SELECT ${cols}, (t.attachment IS NOT NULL) AS has_attachment FROM tasks t WHERE t.archived_at IS NULL ORDER BY t.created_at DESC LIMIT 5000`);
    if (tasks.length === 0) return [];
    const ids = tasks.map(t => t.id);
    const group = (rows) => { const m = new Map(); for (const r of rows) { if (!m.has(r.task_id)) m.set(r.task_id, []); m.get(r.task_id).push(r); } return m; };
    const assignees = group(await all('SELECT * FROM task_assignees WHERE task_id = ANY(?::text[])', [ids]));
    const followups = group(await all('SELECT * FROM task_followups WHERE task_id = ANY(?::text[])', [ids]));
    const checklist = group(await all('SELECT * FROM task_checklist_items WHERE task_id = ANY(?::text[]) ORDER BY sort_order, id', [ids]));
    const replies = group(await all(`SELECT id, task_id, by_username, by_name, message, attachment_name, created_at, (attachment IS NOT NULL) AS has_attachment
      FROM task_replies WHERE task_id = ANY(?::text[]) ORDER BY created_at`, [ids]));
    const fileMeta = await module.exports.listTaskFileMeta(ids);
    const subs = await all('SELECT id, title, status, priority, deadline, parent_task_id FROM tasks WHERE parent_task_id = ANY(?::text[]) ORDER BY created_at ASC', [ids]);
    const subsByParent = new Map();
    for (const sub of subs) {
      const { parent_task_id, ...rest } = sub;
      if (!subsByParent.has(parent_task_id)) subsByParent.set(parent_task_id, []);
      subsByParent.get(parent_task_id).push(rest);
    }
    const depIds = Array.from(new Set(tasks.map(t => t.depends_on_task_id).filter(Boolean)));
    const depStatus = new Map((depIds.length ? await all('SELECT id, status FROM tasks WHERE id = ANY(?::text[])', [depIds]) : []).map(d => [d.id, d.status]));
    const keptOpen = await module.exports.closureKeptOpenMap(ids);
    return tasks.map(t => {
      const subtasks = subsByParent.get(t.id) || [];
      return {
        ...t,
        blocked: t.depends_on_task_id ? depStatus.get(t.depends_on_task_id) === 'open' : false,
        assignees: assignees.get(t.id) || [],
        followups: followups.get(t.id) || [],
        checklist: checklist.get(t.id) || [],
        replies: (replies.get(t.id) || []).map(r => ({ ...r, attachments: fileMeta.filter(f => f.reply_id === r.id).map(f => ({ id: f.id, name: f.name })) })),
        files: fileMeta.filter(f => f.task_id === t.id && !f.reply_id).map(f => ({ id: f.id, name: f.name })),
        subtasks,
        subtaskCount: subtasks.length,
        openSubtaskCount: subtasks.filter(x => x.status === 'open').length,
        closureKeptOpen: keptOpen.get(t.id) || null,
      };
    });
  },
  // Changes the task's own (overall) deadline. Resets every "already reminded" flag tied to the
  // old date — on the task and on each person without an individual deadline of their own (they
  // follow the task deadline) — so reminders restart cleanly for the new date.
  async updateTaskDeadline(id, deadline, tx) {
    const runner = tx ? tx.run : run;
    const r = await runner("UPDATE tasks SET deadline=?, deadline_reminder_sent=0, deadline_overdue_notified=0, version=COALESCE(version,1)+1 WHERE id=? AND status='open'", [deadline, id]);
    if (r.rowCount === 0) return false;
    await runner(`UPDATE task_assignees SET deadline_reminder_sent_at=NULL, deadline_reminder_24h_sent_at=NULL, deadline_reminder_12h_sent_at=NULL,
      deadline_reminder_6h_sent_at=NULL, deadline_reminder_2h_sent_at=NULL, deadline_overdue_notified_at=NULL
      WHERE task_id=? AND individual_deadline IS NULL`, [id]);
    return true;
  },
  // Many deadline changes at once (re-uploading a shifted schedule) — same effect as calling
  // updateTaskDeadline() per task, in two queries per chunk.
  async bulkUpdateDeadlines(tx, updates) {
    for (let i = 0; i < updates.length; i += 5000) {
      const chunk = updates.slice(i, i + 5000);
      const values = chunk.map(() => '(?, ?)').join(',');
      await tx.run(`UPDATE tasks SET deadline = v.deadline, import_deadline = v.deadline, deadline_reminder_sent = 0, deadline_overdue_notified = 0, version = COALESCE(tasks.version, 1) + 1
        FROM (VALUES ${values}) AS v(id, deadline) WHERE tasks.id = v.id AND tasks.status = 'open'`, chunk.flatMap(u => [u.id, u.deadline]));
      await tx.run(`UPDATE task_assignees SET deadline_reminder_sent_at=NULL, deadline_reminder_24h_sent_at=NULL, deadline_reminder_12h_sent_at=NULL,
        deadline_reminder_6h_sent_at=NULL, deadline_reminder_2h_sent_at=NULL, deadline_overdue_notified_at=NULL
        WHERE task_id = ANY(?::text[]) AND individual_deadline IS NULL`, [chunk.map(u => u.id)]);
    }
  },
  // One query each instead of one per open task (dashboard counts).
  async listAssigneeRowsForOpenTasks() {
    return all("SELECT ta.is_released, ta.decision, ta.completed_at FROM task_assignees ta JOIN tasks t ON t.id = ta.task_id WHERE t.status = 'open'");
  },
  async getMyOpenTaskStateCounts(username) {
    const openCount = Number((await get(`SELECT COUNT(*) c FROM tasks t WHERE t.status='open' AND (t.created_by_username = ? OR EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.username = ?))`, [username, username])).c);
    const rows = await all("SELECT ta.is_released, ta.decision, ta.completed_at FROM task_assignees ta JOIN tasks t ON t.id = ta.task_id WHERE t.status='open' AND ta.username = ?", [username]);
    return { openCount, rows };
  },
  async listOpenTaskTitles() { return all("SELECT id, title, deadline FROM tasks WHERE status='open' ORDER BY created_at DESC"); },
  // ---------- History export, master schedules, archiving ----------
  // Every open/closed/cancelled/archived task with its tagged people, for the history export and for
  // writing timestamps back into a schedule spreadsheet. Never loads attachment data.
  // mode 'completed' → closed or cancelled within [from, to]; mode 'all' → created up to `to`.
  async getTaskHistory({ from, to, mode = 'completed', project, keys, titles } = {}) {
    const cols = await taskListColumns();
    const where = []; const params = [];
    if (keys) { where.push('t.import_key = ANY(?::text[])'); params.push(keys); }
    else if (titles) { where.push('LOWER(t.title) = ANY(?::text[])'); params.push(titles.map(x => x.toLowerCase())); }
    else if (mode === 'completed') {
      where.push("t.status IN ('closed','cancelled')");
      if (from) { where.push("COALESCE(t.closed_at, t.cancelled_at) >= ?"); params.push(from); }
      if (to) { where.push("COALESCE(t.closed_at, t.cancelled_at) <= ?"); params.push(to); }
    } else {
      if (from) { where.push('t.created_at >= ?'); params.push(from); }
      if (to) { where.push('t.created_at <= ?'); params.push(to); }
    }
    if (project) { where.push('t.project = ?'); params.push(project); }
    const tasks = await all(`SELECT ${cols} FROM tasks t ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.created_at ASC`, params);
    if (!tasks.length) return [];
    const ids = tasks.map(t => t.id);
    const byTask = new Map();
    for (const a of await all('SELECT task_id, username, stage, is_released, released_at, escalation_baseline_at, submitted_at, submission_note, completed_at, completed_by, decision, individual_deadline FROM task_assignees WHERE task_id = ANY(?::text[]) ORDER BY stage, username', [ids])) {
      if (!byTask.has(a.task_id)) byTask.set(a.task_id, []); byTask.get(a.task_id).push(a);
    }
    const replies = new Map();
    for (const r of await all('SELECT task_id, by_name, by_username, message, attachment_name, created_at FROM task_replies WHERE task_id = ANY(?::text[]) ORDER BY created_at', [ids])) {
      if (!replies.has(r.task_id)) replies.set(r.task_id, []); replies.get(r.task_id).push(r);
    }
    const names = new Map((await all('SELECT username, name FROM users')).map(u => [u.username, u.name]));
    return tasks.map(t => {
      let summary = null; try { summary = t.archive_summary ? JSON.parse(t.archive_summary) : null; } catch (e) { summary = null; }
      return { ...t, assignees: (byTask.get(t.id) || []).map(a => ({ ...a, name: names.get(a.username) || a.username })),
        replies: replies.get(t.id) || (summary && summary.replies) || [] };
    });
  },
  async saveImportFile(fileName, data, username) {
    const now = new Date().toISOString();
    const existing = await get('SELECT id FROM import_files WHERE file_name = ?', [fileName]);
    if (existing) { await run('UPDATE import_files SET data=?, uploaded_by=?, uploaded_at=? WHERE id=?', [data, username, now, existing.id]); return existing.id; }
    const r = await get('INSERT INTO import_files(file_name, data, uploaded_by, uploaded_at) VALUES(?,?,?,?) RETURNING id', [fileName, data, username, now]);
    return r.id;
  },
  async listImportFiles() { return all('SELECT id, file_name, uploaded_by, uploaded_at, LENGTH(data) AS size FROM import_files ORDER BY uploaded_at DESC'); },
  async getImportFile(id) { return get('SELECT * FROM import_files WHERE id = ?', [id]); },
  async deleteImportFile(id) { return (await run('DELETE FROM import_files WHERE id = ?', [id])).rowCount; },
  // Completed (closed/cancelled) tasks, finished on or before `before`, not yet archived, with no
  // open subtask (a closed parent whose subtask is still being worked on stays visible).
  async listArchivableTaskIds(before) {
    return (await all(`SELECT t.id FROM tasks t WHERE t.status IN ('closed','cancelled') AND t.archived_at IS NULL
      AND COALESCE(t.closed_at, t.cancelled_at) <= ?
      AND NOT EXISTS (SELECT 1 FROM tasks s WHERE s.parent_task_id = t.id AND s.status = 'open')`, [before])).map(r => r.id);
  },
  // "Remove from the site": the task disappears from every task screen and its heavy data goes
  // (attachments, comment thread, checklist, follow-ups, notifications) — but a one-row summary
  // stays, with the tagged-people rows, so exports, spreadsheet timestamps, performance numbers,
  // leaderboards and reports are unchanged, and re-uploading the schedule never re-creates it.
  // The comment thread is kept as plain text inside the summary so exports still show it.
  async archiveTasks(ids) {
    if (!ids.length) return 0;
    return runInTransaction(async (tx) => {
      const now = new Date().toISOString();
      let count = 0;
      for (let i = 0; i < ids.length; i += 1000) {
        const chunk = ids.slice(i, i + 1000);
        const replies = await tx.all('SELECT task_id, by_name, by_username, message, attachment_name, created_at FROM task_replies WHERE task_id = ANY(?::text[]) ORDER BY created_at', [chunk]);
        const checklist = await tx.all('SELECT task_id, text, is_checked FROM task_checklist_items WHERE task_id = ANY(?::text[]) ORDER BY sort_order, id', [chunk]);
        const followups = await tx.all('SELECT task_id, username FROM task_followups WHERE task_id = ANY(?::text[])', [chunk]);
        const summaries = new Map(chunk.map(id => [id, { replies: [], checklist: [], followups: [] }]));
        replies.forEach(r => summaries.get(r.task_id).replies.push({ by_name: r.by_name, by_username: r.by_username, message: r.message, attachment_name: r.attachment_name, created_at: r.created_at }));
        checklist.forEach(c => summaries.get(c.task_id).checklist.push({ text: c.text, done: !!c.is_checked }));
        followups.forEach(f => summaries.get(f.task_id).followups.push(f.username));
        const values = chunk.map(() => '(?, ?)').join(',');
        const r = await tx.run(`UPDATE tasks SET archived_at = ?, archive_summary = v.summary, attachment = NULL, report_data = NULL, ai_summary = NULL
          FROM (VALUES ${values}) AS v(id, summary) WHERE tasks.id = v.id AND tasks.archived_at IS NULL`,
          [now, ...chunk.flatMap(id => [id, JSON.stringify(summaries.get(id))])]);
        count += r.rowCount;
        for (const table of ['task_files', 'task_replies', 'task_checklist_items', 'task_followups', 'notifications']) {
          await tx.run(`DELETE FROM ${table} WHERE task_id = ANY(?::text[])`, [chunk]);
        }
      }
      return count;
    });
  },
  async countArchivedTasks() { return Number((await get('SELECT COUNT(*) c FROM tasks WHERE archived_at IS NOT NULL')).c); },
  // ---------- Task history (task_activity_events) — append-only ----------
  async addTaskEvent(ev, tx) {
    const runner = tx ? tx.run : run;
    await runner(`INSERT INTO task_activity_events (task_id, event_type, actor_username, actor_name, actor_team, details, old_value, new_value, metadata, source_type)
      VALUES (?,?,?,?,?,?,?,?,?::jsonb,?)`,
      [ev.taskId, ev.type, ev.actorUsername || null, ev.actorName || null, ev.actorTeam || null, ev.details == null ? null : String(ev.details).slice(0, 2000),
       ev.oldValue == null ? null : String(ev.oldValue).slice(0, 500), ev.newValue == null ? null : String(ev.newValue).slice(0, 500),
       JSON.stringify(ev.metadata || {}), ev.source || 'web']);
  },
  async addTaskEventsBulk(tx, events) {
    for (let i = 0; i < events.length; i += 2000) {
      const chunk = events.slice(i, i + 2000);
      const values = chunk.map(() => '(?,?,?,?,?,?,?,?,?::jsonb,?)').join(',');
      await tx.run(`INSERT INTO task_activity_events (task_id, event_type, actor_username, actor_name, actor_team, details, old_value, new_value, metadata, source_type) VALUES ${values}`,
        chunk.flatMap(ev => [ev.taskId, ev.type, ev.actorUsername || null, ev.actorName || null, ev.actorTeam || null, ev.details == null ? null : String(ev.details).slice(0, 2000),
          ev.oldValue == null ? null : String(ev.oldValue).slice(0, 500), ev.newValue == null ? null : String(ev.newValue).slice(0, 500), JSON.stringify(ev.metadata || {}), ev.source || 'web']));
    }
  },
  // Paged (keyset on created_at + id), filtered, newest or oldest first.
  async listTaskEvents(taskId, { limit = 25, cursor, order = 'desc', type, actor, source, q, from, to } = {}) {
    const where = ['task_id = ?'], params = [taskId];
    if (type) { where.push('event_type = ?'); params.push(type); }
    if (actor) { where.push('actor_username = ?'); params.push(actor); }
    if (source) { where.push('source_type = ?'); params.push(source); }
    if (from) { where.push('created_at >= ?'); params.push(from); }
    if (to) { where.push('created_at <= ?'); params.push(to); }
    if (q) {
      where.push("(details ILIKE ? OR COALESCE(actor_name,'') ILIKE ? OR COALESCE(old_value,'') ILIKE ? OR COALESCE(new_value,'') ILIKE ?)");
      const like = '%' + q.replace(/[%_]/g, m => '\\' + m) + '%'; params.push(like, like, like, like);
    }
    const asc = order === 'asc';
    if (cursor) {
      const [ts, id] = String(cursor).split('|');
      where.push(asc ? '(created_at, id) > (?::timestamptz, ?::bigint)' : '(created_at, id) < (?::timestamptz, ?::bigint)');
      params.push(ts, id);
    }
    const rows = await all(`SELECT id, task_id, event_type, actor_username, actor_name, actor_team, details, old_value, new_value, metadata, source_type, created_at
      FROM task_activity_events WHERE ${where.join(' AND ')} ORDER BY created_at ${asc ? 'ASC' : 'DESC'}, id ${asc ? 'ASC' : 'DESC'} LIMIT ?`, [...params, limit + 1]);
    const hasMore = rows.length > limit;
    const events = (hasMore ? rows.slice(0, limit) : rows).map(r => ({ ...r, created_at: new Date(r.created_at).toISOString() }));
    const last = events[events.length - 1];
    const facets = await get(`SELECT COALESCE(json_agg(DISTINCT event_type), '[]') AS types,
      COALESCE(json_agg(DISTINCT jsonb_build_object('username', actor_username, 'name', actor_name)) FILTER (WHERE actor_username IS NOT NULL), '[]') AS actors,
      COALESCE(json_agg(DISTINCT source_type), '[]') AS sources, COUNT(*)::int AS total
      FROM task_activity_events WHERE task_id = ?`, [taskId]);
    return { events, hasMore, nextCursor: hasMore && last ? `${last.created_at}|${last.id}` : null, total: facets.total, types: facets.types, actors: facets.actors, sources: facets.sources };
  },
  async getTasksByImportKeys(keys) {
    if (!keys.length) return [];
    return all('SELECT id, title, status, deadline, import_key, import_deadline FROM tasks WHERE import_key = ANY(?::text[])', [keys]);
  },
  // Bulk version of createTask + addTaskAssignee + addChecklistItem + addFollowup for imports:
  // multi-row INSERTs in chunks, so thousands of rows take a handful of queries instead of ~10
  // round-trips each (which on a remote database meant many minutes for a full schedule).
  async bulkInsertTasks(tx, { tasks, assignees, checklist, followups }) {
    const now = new Date().toISOString();
    async function insertChunks(table, columns, rows, suffix) {
      const size = Math.max(1, Math.floor(30000 / columns.length));
      for (let i = 0; i < rows.length; i += size) {
        const chunk = rows.slice(i, i + size);
        const placeholders = chunk.map(() => `(${columns.map(() => '?').join(',')})`).join(',');
        await tx.run(`INSERT INTO ${table}(${columns.join(',')}) VALUES ${placeholders} ${suffix || ''}`, chunk.flat());
      }
    }
    const projects = Array.from(new Set(tasks.map(t => t.project).filter(Boolean)));
    const phases = Array.from(new Set(tasks.map(t => t.phase).filter(Boolean)));
    if (projects.length) await insertChunks('projects', ['name', 'created_at'], projects.map(p => [p, now]), 'ON CONFLICT (name) DO NOTHING');
    if (phases.length) await insertChunks('task_phases', ['name', 'created_at'], phases.map(p => [p, now]), 'ON CONFLICT (name) DO NOTHING');
    if (tasks.length) await insertChunks('tasks',
      ['id', 'title', 'description', 'priority', 'deadline', 'status', 'created_by', 'created_by_username', 'depends_on_task_id', 'is_drawing_request', 'parent_task_id', 'project', 'phase', 'auto_release_stages', 'import_key', 'import_deadline', 'source_type', 'source_ref', 'created_at'],
      tasks.map(t => [t.id, t.title, t.description || null, t.priority, t.deadline, 'open', t.created_by, t.created_by_username, t.depends_on_task_id || null, 0, t.parent_task_id || null, t.project || null, t.phase || null, t.auto_release_stages ? 1 : 0, t.import_key || null, t.import_key ? t.deadline : null, 'import', t.source_ref || null, now]));
    if (assignees.length) await insertChunks('task_assignees',
      ['task_id', 'username', 'team', 'stage', 'is_released', 'escalation_baseline_at', 'individual_deadline'],
      assignees.map(a => [a.task_id, a.username, a.team || null, a.stage, a.is_released ? 1 : 0, now, a.individual_deadline || null]), 'ON CONFLICT (task_id, username) DO NOTHING');
    if (checklist.length) await insertChunks('task_checklist_items', ['task_id', 'text', 'is_checked', 'sort_order', 'created_at'],
      checklist.map(c => [c.task_id, c.text, 0, c.sort_order, now]));
    if (followups.length) await insertChunks('task_followups', ['task_id', 'username', 'tagged_by', 'created_at'],
      followups.map(f => [f.task_id, f.username, f.tagged_by, now]), 'ON CONFLICT (task_id, username) DO NOTHING');
  },
  async addChecklistItem(taskId, text, sortOrder, tx) {
    const runner = tx ? tx.run : run;
    await runner('INSERT INTO task_checklist_items(task_id,text,is_checked,sort_order,created_at) VALUES(?,?,0,?,?)', [taskId, text, sortOrder || 0, new Date().toISOString()]);
  },
  async toggleChecklistItem(id, checked) { await run('UPDATE task_checklist_items SET is_checked=? WHERE id=?', [checked ? 1 : 0, id]); },
  async deleteChecklistItem(id) { await run('DELETE FROM task_checklist_items WHERE id=?', [id]); },
  async listChecklistItems(taskId) { return all('SELECT * FROM task_checklist_items WHERE task_id=? ORDER BY sort_order, id', [taskId]); },
  async getChecklistItem(id) { return get('SELECT * FROM task_checklist_items WHERE id=?', [id]); },
  async addReply(taskId, { by_username, by_name, message, attachment, attachment_name }) {
    const r = await get('INSERT INTO task_replies(task_id,by_username,by_name,message,attachment,attachment_name,created_at) VALUES(?,?,?,?,?,?,?) RETURNING id',
      [taskId, by_username, by_name, message || null, attachment || null, attachment_name || null, new Date().toISOString()]);
    return r ? r.id : null;
  },
  // ---- multiple attachments ----
  // ---- deliveries ----
  async createDelivery(d, files) {
    return runInTransaction(async (tx) => {
      const now = new Date().toISOString();
      let row = null;
      for (let i = 0; i < 5 && !row; i++) {
        const ref = 'DLV-' + Math.random().toString(36).slice(2, 7).toUpperCase();
        const r = await tx.run(`INSERT INTO deliveries(ref,title,quantity,description,vendor,project,site_location,transport,porter_order_id,delivery_ref,
            driver_name,driver_phone,vehicle_no,expected_at,receivers,status,task_id,created_by,created_by_name,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'scheduled',?,?,?,?,?) ON CONFLICT (ref) DO NOTHING RETURNING *`,
          [ref, d.title, d.quantity, d.description, d.vendor, d.project, d.site_location, d.transport, d.porter_order_id, d.delivery_ref,
           d.driver_name, d.driver_phone, d.vehicle_no, d.expected_at, d.receivers.join(','), d.task_id || null, d.created_by, d.created_by_name, now, now]);
        row = r.rows && r.rows[0];
      }
      if (!row) throw new Error('Could not create the delivery — please try again.');
      for (const f of files || []) await tx.run('INSERT INTO delivery_files(delivery_id,kind,name,data,uploaded_by,created_at) VALUES(?,?,?,?,?,?)', [row.id, 'attachment', f.name, f.data, d.created_by, now]);
      return row;
    });
  },
  async getDelivery(id) { const n = Number(id); if (!Number.isInteger(n)) return null; return get('SELECT * FROM deliveries WHERE id=?', [n]); },
  async listDeliveriesFor(username, everything) {
    const rows = everything
      ? await all('SELECT d.*, t.status AS task_status FROM deliveries d LEFT JOIN tasks t ON t.id = d.task_id ORDER BY (d.status IN (\'scheduled\',\'dispatched\')) DESC, COALESCE(d.expected_at, d.created_at) DESC LIMIT 2000')
      : await all(`SELECT d.*, (SELECT status FROM tasks WHERE id = d.task_id) AS task_status FROM deliveries d WHERE d.created_by = ? OR (',' || d.receivers || ',') LIKE ?
          OR (d.task_id IS NOT NULL AND (EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = d.task_id AND ta.username = ?)
            OR EXISTS (SELECT 1 FROM tasks t WHERE t.id = d.task_id AND t.created_by_username = ?)
            OR EXISTS (SELECT 1 FROM task_followups tf WHERE tf.task_id = d.task_id AND tf.username = ?)))
          ORDER BY (d.status IN ('scheduled','dispatched')) DESC, COALESCE(d.expected_at, d.created_at) DESC LIMIT 2000`,
          [username, `%,${username},%`, username, username, username]);
    if (!rows.length) return [];
    const ids = rows.map(r => r.id);
    const files = await all('SELECT id, delivery_id, kind, doc_type, note, payment_id, name, taken_at, uploaded_by, created_at FROM delivery_files WHERE delivery_id = ANY(?::int[]) ORDER BY id', [ids]);
    const pays = await all('SELECT * FROM delivery_payments WHERE delivery_id = ANY(?::int[]) ORDER BY paid_at, id', [ids]);
    return rows.map(r => {
      const payments = pays.filter(p => p.delivery_id === r.id).map(p => ({ ...p, amount: Number(p.amount), bills: files.filter(f => f.payment_id === p.id).map(f => ({ id: f.id, name: f.name })) }));
      const paid = Math.round(payments.filter(p => p.verify_status !== 'rejected').reduce((a, p) => a + p.amount, 0) * 100) / 100;
      const budget = r.budget_amount == null ? null : Number(r.budget_amount);
      return { ...r, budget_amount: budget, receivers: r.receivers ? r.receivers.split(',').filter(Boolean) : [],
        required_docs: String(r.required_docs == null ? 'challan,signed_challan' : r.required_docs).split(',').filter(Boolean),
        files: files.filter(f => f.delivery_id === r.id && !f.payment_id), payments, paid, balance: budget == null ? null : Math.round((budget - paid) * 100) / 100 };
    });
  },
  async updateDelivery(id, fields) {
    const keys = Object.keys(fields); if (!keys.length) return null;
    const vals = keys.map(k => k === 'receivers' ? fields[k].join(',') : fields[k]);
    return get(`UPDATE deliveries SET ${keys.map(k => `${k}=?`).join(', ')}, updated_at=? WHERE id=? RETURNING *`, [...vals, new Date().toISOString(), Number(id)]);
  },
  async addDeliveryFiles(id, kind, files, uploadedBy) {
    const now = new Date().toISOString();
    for (const f of files || []) await run('INSERT INTO delivery_files(delivery_id,kind,name,data,taken_at,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?)', [Number(id), kind, f.name, f.data, f.taken_at || null, uploadedBy, now]);
  },
  async listOpenDeliveriesForReminders() {
    const since = new Date(Date.now() - 30 * 864e5).toISOString();
    const rows = await all("SELECT * FROM deliveries WHERE receivers <> '' AND (status IN ('scheduled','dispatched','delivered') OR (status='unloaded' AND unloaded_at >= ?))", [since]);
    if (!rows.length) return [];
    const docs = await all("SELECT delivery_id, doc_type FROM delivery_files WHERE kind='document' AND delivery_id = ANY(?::int[])", [rows.map(r => r.id)]);
    return rows.map(r => ({ ...r, docs_present: docs.filter(x => x.delivery_id === r.id).map(x => x.doc_type) }));
  },
  // One delivery reminder card per person per delivery: the new slot's reminder replaces the last one.
  async removeEarlierDeliveryReminders(username, ref) {
    await run("DELETE FROM notifications WHERE username=? AND type='delivery_reminder' AND message LIKE ?", [username, `%(${ref})%`]);
  },
  async markDeliveryFollowUp(id, by) {
    return get('UPDATE deliveries SET last_followup_at=?, last_followup_by=?, followup_count=COALESCE(followup_count,0)+1 WHERE id=? RETURNING *', [new Date().toISOString(), by, Number(id)]);
  },
  async addDeliveryDocument(id, docType, files, note, uploadedBy) {
    const now = new Date().toISOString();
    for (const f of files || []) await run('INSERT INTO delivery_files(delivery_id,kind,doc_type,note,name,data,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?,?)', [Number(id), 'document', docType, note || null, f.name, f.data, uploadedBy, now]);
  },
  async deliveryDocTypesPresent(id) { return (await all("SELECT DISTINCT doc_type FROM delivery_files WHERE delivery_id=? AND kind='document'", [Number(id)])).map(r => r.doc_type); },
  async deleteDeliveryFile(fileId) { const r = await run('DELETE FROM delivery_files WHERE id=?', [Number(fileId)]); return r.rowCount > 0; },
  async addDeliveryPayment(deliveryId, p, bills) {
    return runInTransaction(async (tx) => {
      const now = new Date().toISOString();
      const did = deliveryId == null ? null : Number(deliveryId);
      const d = did ? await tx.get('SELECT ref, title FROM deliveries WHERE id=?', [did]) : null;
      const r = await tx.get(`INSERT INTO delivery_payments(delivery_id,delivery_ref,delivery_title,amount,purpose,paid_to,mode,paid_at,note,no_bill_reason,paid_by,paid_by_name,created_at,verify_status)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'pending') RETURNING *`, [did, d ? d.ref : null, d ? d.title : null, p.amount, p.purpose, p.paid_to, p.mode, p.paid_at, p.note, p.no_bill_reason, p.paid_by, p.paid_by_name, now]);
      for (const f of bills || []) await tx.run('INSERT INTO delivery_files(delivery_id,kind,payment_id,name,data,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?)', [did, 'bill', r.id, f.name, f.data, p.paid_by, now]);
      return r;
    });
  },
  async getDeliveryPayment(id) { const n = Number(id); if (!Number.isInteger(n)) return null; return get('SELECT * FROM delivery_payments WHERE id=?', [n]); },
  async deleteDeliveryPayment(id) {
    return runInTransaction(async (tx) => {
      await tx.run('DELETE FROM delivery_files WHERE payment_id=?', [Number(id)]);
      const r = await tx.run('DELETE FROM delivery_payments WHERE id=?', [Number(id)]);
      return r.rowCount > 0;
    });
  },
  async deliveryPaidTotal(id) { const r = await get("SELECT COALESCE(SUM(amount),0) AS t FROM delivery_payments WHERE delivery_id=? AND COALESCE(verify_status,'pending') <> 'rejected'", [Number(id)]); return Number(r.t); },
  async deleteDelivery(id) {
    return runInTransaction(async (tx) => {
      // Money already paid stays on record (in the payer's statement) even if the delivery is removed.
      await tx.run("UPDATE delivery_files SET delivery_id=NULL WHERE delivery_id=? AND kind='bill'", [Number(id)]);
      await tx.run('UPDATE delivery_payments SET delivery_id=NULL WHERE delivery_id=?', [Number(id)]);
      const r = await tx.run('DELETE FROM deliveries WHERE id=?', [Number(id)]);
      return r.rowCount > 0;
    });
  },
  // ---- Allotted money
  async addAllotment(a) {
    return get(`INSERT INTO budget_allotments(username,kind,amount,note,mode,reference,by_username,by_name,created_at) VALUES(?,?,?,?,?,?,?,?,?) RETURNING *`,
      [a.username, a.kind, a.amount, a.note || null, a.mode || null, a.reference || null, a.by_username, a.by_name || null, new Date().toISOString()]);
  },
  async getAllotment(id) { const n = Number(id); if (!Number.isInteger(n)) return null; return get('SELECT * FROM budget_allotments WHERE id=?', [n]); },
  async deleteAllotment(id) { const r = await run('DELETE FROM budget_allotments WHERE id=?', [Number(id)]); return r.rowCount > 0; },
  async listAllotments(username) {
    const rows = username ? await all('SELECT * FROM budget_allotments WHERE username=? ORDER BY created_at, id', [username]) : await all('SELECT * FROM budget_allotments ORDER BY created_at, id');
    return rows.map(r => ({ ...r, amount: Number(r.amount) }));
  },
  // Every payment (with or without a delivery), with its delivery's details and bill ids.
  async listBudgetPayments(username) {
    const rows = await all(`SELECT p.*, d.ref AS d_ref, d.title AS d_title, d.project AS d_project, d.budget_amount AS d_budget, d.status AS d_status, d.receivers AS d_receivers
      FROM delivery_payments p LEFT JOIN deliveries d ON d.id = p.delivery_id ${username ? 'WHERE p.paid_by = ?' : ''} ORDER BY p.paid_at DESC, p.id DESC LIMIT 5000`, username ? [username] : []);
    if (!rows.length) return [];
    const bills = await all("SELECT id, payment_id, name FROM delivery_files WHERE kind='bill' AND payment_id = ANY(?::int[]) ORDER BY id", [rows.map(r => r.id)]);
    return rows.map(r => ({ ...r, amount: Number(r.amount), verify_status: r.verify_status || 'pending', d_budget: r.d_budget == null ? null : Number(r.d_budget),
      bills: bills.filter(b => b.payment_id === r.id).map(b => ({ id: b.id, name: b.name })) }));
  },
  async lastTopupRequest(username) { const r = await get('SELECT budget_topup_asked_at AS t FROM users WHERE username=?', [username]); return r && r.t; },
  async markTopupRequest(username) { await run('UPDATE users SET budget_topup_asked_at=? WHERE username=?', [new Date().toISOString(), username]); },
  async allotmentHolderOf(username) { return get('SELECT 1 AS x FROM budget_allotments WHERE username=? LIMIT 1', [username]); },
  async allottersOf(username) { return (await all('SELECT DISTINCT by_username FROM budget_allotments WHERE username=?', [username])).map(r => r.by_username); },
  async setPaymentVerify(id, status, note, by) {
    return get('UPDATE delivery_payments SET verify_status=?, verify_note=?, verified_by=?, verified_at=? WHERE id=? RETURNING *', [status, note || null, by, new Date().toISOString(), Number(id)]);
  },
  async setPaymentReply(id, note) { return get("UPDATE delivery_payments SET reply_note=?, verify_status='pending' WHERE id=? RETURNING *", [note, Number(id)]); },
  async addPaymentBills(paymentId, deliveryId, files, by) {
    const now = new Date().toISOString();
    for (const f of files || []) await run('INSERT INTO delivery_files(delivery_id,kind,payment_id,name,data,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?)', [deliveryId == null ? null : Number(deliveryId), 'bill', Number(paymentId), f.name, f.data, by, now]);
  },
  // Balance for one person: allotted − returned − paid (rejected payments do not count).
  async holderBalance(username) {
    const a = await get("SELECT COALESCE(SUM(CASE WHEN kind='allot' THEN amount ELSE -amount END),0) AS t FROM budget_allotments WHERE username=?", [username]);
    const p = await get("SELECT COALESCE(SUM(amount),0) AS t FROM delivery_payments WHERE paid_by=? AND COALESCE(verify_status,'pending') <> 'rejected'", [username]);
    return Math.round((Number(a.t) - Number(p.t)) * 100) / 100;
  },
  async getDeliveryFile(fileId) { const n = Number(fileId); if (!Number.isInteger(n)) return null; return get('SELECT * FROM delivery_files WHERE id=?', [n]); },
  async addTaskFiles(taskId, replyId, files, uploadedBy, tx) {
    const runner = tx ? tx.run : run;
    const now = new Date().toISOString();
    for (const f of files || []) {
      await runner('INSERT INTO task_files(task_id, reply_id, name, data, uploaded_by, created_at) VALUES(?,?,?,?,?,?)', [taskId, replyId || null, f.name, f.data, uploadedBy || null, now]);
    }
  },
  async listTaskFileMeta(taskIds) {
    if (!taskIds.length) return [];
    return all('SELECT id, task_id, reply_id, name FROM task_files WHERE task_id = ANY(?::text[]) ORDER BY id', [taskIds]);
  },
  async getTaskFile(fileId) {
    const id = Number(fileId);
    if (!Number.isInteger(id)) return null;
    return get('SELECT id, task_id, reply_id, name, data FROM task_files WHERE id=?', [id]);
  },
  // ---- chat ----
  async addChatMessage({ room, by_username, by_name, message, files }) {
    return runInTransaction(async (tx) => {
      const now = new Date().toISOString();
      const row = await tx.get('INSERT INTO chat_messages(room, by_username, by_name, message, created_at) VALUES(?,?,?,?,?) RETURNING id', [room, by_username, by_name, message || null, now]);
      for (const f of files || []) await tx.run('INSERT INTO chat_files(message_id, name, data, created_at) VALUES(?,?,?,?)', [row.id, f.name, f.data, now]);
      return row.id;
    });
  },
  async listChatMessages(room, { afterId = 0, beforeId = null, limit = 60 } = {}) {
    const lim = Math.max(1, Math.min(200, Number(limit) || 60));
    const rows = beforeId
      ? await all('SELECT * FROM chat_messages WHERE room=? AND id < ? ORDER BY id DESC LIMIT ?', [room, Number(beforeId), lim])
      : afterId
        ? await all('SELECT * FROM chat_messages WHERE room=? AND id > ? ORDER BY id DESC LIMIT ?', [room, Number(afterId), lim])
        : await all('SELECT * FROM chat_messages WHERE room=? ORDER BY id DESC LIMIT ?', [room, lim]);
    rows.reverse();
    const ids = rows.map(r => r.id);
    const files = ids.length ? await all('SELECT id, message_id, name FROM chat_files WHERE message_id = ANY(?::int[]) ORDER BY id', [ids]) : [];
    return rows.map(r => ({ ...r, files: r.deleted_at ? [] : files.filter(f => f.message_id === r.id).map(f => ({ id: f.id, name: f.name })), message: r.deleted_at ? null : r.message }));
  },
  async getChatMessage(id) { return get('SELECT * FROM chat_messages WHERE id=?', [Number(id)]); },
  async deleteChatMessage(id) {
    await run('UPDATE chat_messages SET deleted_at=?, message=NULL WHERE id=?', [new Date().toISOString(), Number(id)]);
    await run('DELETE FROM chat_files WHERE message_id=?', [Number(id)]);
  },
  async getChatFile(fileId) {
    const id = Number(fileId);
    if (!Number.isInteger(id)) return null;
    return get('SELECT f.id, f.name, f.data, m.room FROM chat_files f JOIN chat_messages m ON m.id = f.message_id WHERE f.id=?', [id]);
  },
  async chatRoomStats(username, rooms) {
    if (!rooms.length) return [];
    return all(`SELECT r.room,
        COALESCE((SELECT MAX(id) FROM chat_messages m WHERE m.room = r.room), 0) AS last_id,
        COALESCE((SELECT last_read_id FROM chat_reads cr WHERE cr.username = ? AND cr.room = r.room), 0) AS last_read_id,
        (SELECT COUNT(*) FROM chat_messages m WHERE m.room = r.room AND m.deleted_at IS NULL AND m.by_username <> ?
           AND m.id > COALESCE((SELECT last_read_id FROM chat_reads cr WHERE cr.username = ? AND cr.room = r.room), 0)) AS unread
      FROM unnest(?::text[]) AS r(room)`, [username, username, username, rooms]);
  },
  async markChatRead(username, room, lastId) {
    await run(`INSERT INTO chat_reads(username, room, last_read_id) VALUES(?,?,?)
      ON CONFLICT (username, room) DO UPDATE SET last_read_id = GREATEST(chat_reads.last_read_id, excluded.last_read_id)`, [username, room, Number(lastId) || 0]);
  },
  // ---- private chats (room key 'p:<id>') ----
  async createPrivateChat({ name, created_by, members }) {
    return runInTransaction(async (tx) => {
      const now = new Date().toISOString();
      const row = await tx.get('INSERT INTO chat_private(name, created_by, created_at) VALUES(?,?,?) RETURNING id', [name || null, created_by, now]);
      for (const u of new Set([created_by, ...members])) {
        await tx.run('INSERT INTO chat_private_members(chat_id, username, added_by, added_at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING', [row.id, u, created_by, now]);
      }
      return row.id;
    });
  },
  async getPrivateChat(id) {
    const n = Number(id);
    if (!Number.isInteger(n)) return null;
    const chat = await get('SELECT * FROM chat_private WHERE id=?', [n]);
    if (!chat) return null;
    chat.members = (await all('SELECT username FROM chat_private_members WHERE chat_id=? ORDER BY added_at, username', [n])).map(r => r.username);
    return chat;
  },
  async listPrivateChatsFor(username) {
    const chats = await all(`SELECT c.* FROM chat_private c JOIN chat_private_members m ON m.chat_id = c.id
      WHERE m.username=? ORDER BY c.id`, [username]);
    if (!chats.length) return [];
    const members = await all('SELECT chat_id, username FROM chat_private_members WHERE chat_id = ANY(?::int[]) ORDER BY added_at, username', [chats.map(c => c.id)]);
    return chats.map(c => ({ ...c, members: members.filter(m => m.chat_id === c.id).map(m => m.username) }));
  },
  async isPrivateChatMember(id, username) {
    return !!(await get('SELECT 1 AS ok FROM chat_private_members WHERE chat_id=? AND username=?', [Number(id), username]));
  },
  async addPrivateChatMembers(id, usernames, added_by) {
    const now = new Date().toISOString();
    const added = [];
    for (const u of usernames) {
      const r = await get('INSERT INTO chat_private_members(chat_id, username, added_by, added_at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING RETURNING username', [Number(id), u, added_by, now]);
      if (r) added.push(r.username);
    }
    return added;
  },
  async leavePrivateChat(id, username) {
    await run('DELETE FROM chat_private_members WHERE chat_id=? AND username=?', [Number(id), username]);
    const left = await get('SELECT COUNT(*) AS c FROM chat_private_members WHERE chat_id=?', [Number(id)]);
    if (Number(left.c) === 0) {
      // Nobody left to see it — remove the conversation, its messages and files entirely.
      await run("DELETE FROM chat_messages WHERE room=?", [`p:${Number(id)}`]);
      await run("DELETE FROM chat_reads WHERE room=?", [`p:${Number(id)}`]);
      await run('DELETE FROM chat_private WHERE id=?', [Number(id)]);
    }
  },
  // ---- announcements ----
  async createAnnouncement({ title, body, emoji, category, event_date, pinned, created_by_username, created_by_name }) {
    const row = await get(`INSERT INTO announcements(title, body, emoji, category, event_date, pinned, created_by_username, created_by_name, created_at)
      VALUES(?,?,?,?,?,?,?,?,?) RETURNING id`, [title, body || null, emoji || null, category || null, event_date || null, pinned ? 1 : 0, created_by_username, created_by_name, new Date().toISOString()]);
    return row.id;
  },
  async listAnnouncements() { return all('SELECT * FROM announcements WHERE deleted_at IS NULL ORDER BY pinned DESC, created_at DESC LIMIT 500'); },
  async getAnnouncement(id) { return get('SELECT * FROM announcements WHERE id=? AND deleted_at IS NULL', [Number(id)]); },
  async updateAnnouncement(id, { title, body, emoji, category, event_date, pinned }) {
    await run('UPDATE announcements SET title=?, body=?, emoji=?, category=?, event_date=?, pinned=? WHERE id=?', [title, body || null, emoji || null, category || null, event_date || null, pinned ? 1 : 0, Number(id)]);
  },
  async deleteAnnouncement(id) { await run('UPDATE announcements SET deleted_at=? WHERE id=?', [new Date().toISOString(), Number(id)]); },
  async listReplies(taskId) { return all('SELECT * FROM task_replies WHERE task_id=? ORDER BY created_at', [taskId]); },

  // ---- follow-ups ----
  async addFollowup(taskId, username, taggedBy, tx) {
    const runner = tx ? tx.run : run;
    await runner('INSERT INTO task_followups(task_id,username,tagged_by,created_at) VALUES(?,?,?,?) ON CONFLICT (task_id, username) DO NOTHING', [taskId, username, taggedBy || null, new Date().toISOString()]);
  },
  async listFollowups(taskId) { return all('SELECT * FROM task_followups WHERE task_id=?', [taskId]); },

  async getTaskFull(id) {
    const t = await get('SELECT * FROM tasks WHERE id=?', [id]);
    if (!t) return null;
    return {
      ...t,
      blocked: await module.exports.isTaskBlocked(id),
      assignees: await all('SELECT * FROM task_assignees WHERE task_id=?', [id]),
      followups: await all('SELECT * FROM task_followups WHERE task_id=?', [id]),
      checklist: await all('SELECT * FROM task_checklist_items WHERE task_id=? ORDER BY sort_order, id', [id]),
      replies: await all('SELECT * FROM task_replies WHERE task_id=? ORDER BY created_at', [id]),
      subtasks: await all('SELECT id,title,status,priority,deadline FROM tasks WHERE parent_task_id=? ORDER BY created_at ASC', [id]),
      closureKeptOpen: (await module.exports.closureKeptOpenMap([id])).get(id) || null,
    };
  },
  async getTaskFullLight(id) {
    const t = await get('SELECT * FROM tasks WHERE id=?', [id]);
    if (!t) return null;
    const hasAttachment = !!t.attachment;
    delete t.attachment;
    const repliesRaw = await all('SELECT * FROM task_replies WHERE task_id=? ORDER BY created_at', [id]);
    const replies = repliesRaw.map(r => {
      const has = !!r.attachment;
      delete r.attachment;
      return { ...r, has_attachment: has };
    });
    const fileMeta = await module.exports.listTaskFileMeta([id]);
    replies.forEach(r => { r.attachments = fileMeta.filter(f => f.reply_id === r.id).map(f => ({ id: f.id, name: f.name })); });
    const subtaskCountRow = await get('SELECT COUNT(*) c FROM tasks WHERE parent_task_id=?', [id]);
    const openSubtaskCountRow = await get("SELECT COUNT(*) c FROM tasks WHERE parent_task_id=? AND status='open'", [id]);
    return {
      ...t,
      has_attachment: hasAttachment,
      files: fileMeta.filter(f => !f.reply_id).map(f => ({ id: f.id, name: f.name })),
      blocked: await module.exports.isTaskBlocked(id),
      assignees: await all('SELECT * FROM task_assignees WHERE task_id=?', [id]),
      followups: await all('SELECT * FROM task_followups WHERE task_id=?', [id]),
      checklist: await all('SELECT * FROM task_checklist_items WHERE task_id=? ORDER BY sort_order, id', [id]),
      replies,
      subtasks: await all('SELECT id,title,status,priority,deadline FROM tasks WHERE parent_task_id=? ORDER BY created_at ASC', [id]),
      closureKeptOpen: (await module.exports.closureKeptOpenMap([id])).get(id) || null,
      subtaskCount: Number(subtaskCountRow.c),
      openSubtaskCount: Number(openSubtaskCountRow.c),
    };
  },
  async getTaskAttachment(id) { return get('SELECT attachment, attachment_name FROM tasks WHERE id=?', [id]); },
  async getReplyAttachment(replyId) { return get('SELECT attachment, attachment_name, task_id FROM task_replies WHERE id=?', [replyId]); },

  // ---- escalating reminders ----
  async markTaskAssigneeReminded(taskId, username) {
    await run('UPDATE task_assignees SET last_reminded_at=? WHERE task_id=? AND username=?', [new Date().toISOString(), taskId, username]);
  },
  async listIncompleteAssigneesForOpenTasks() {
    return all(`
      SELECT ta.task_id, ta.username, ta.last_reminded_at, ta.is_released, t.title, t.created_at
      FROM task_assignees ta JOIN tasks t ON t.id = ta.task_id
      WHERE t.status = 'open' AND ta.completed_at IS NULL
    `);
  },
  async listIncompleteAssigneesForEscalation() {
    return all(`
      SELECT ta.task_id, ta.username, ta.reminder_3day_sent_at, ta.warning_5day_sent_at, ta.warning_7day_sent_at, ta.warning_12day_sent_at, ta.is_released,
             ta.last_recurring_reminder_at, ta.warning_48hr_sent_at, ta.flagged_60hr_sent_at,
             COALESCE(ta.escalation_baseline_at, t.created_at) as escalation_baseline_at,
             t.title, t.created_at, t.created_by, t.created_by_username
      FROM task_assignees ta JOIN tasks t ON t.id = ta.task_id
      WHERE t.status = 'open' AND ta.completed_at IS NULL
    `);
  },
  async markEscalationStage(taskId, username, stage) {
    const columnMap = { 3: 'reminder_3day_sent_at', 5: 'warning_5day_sent_at', 7: 'warning_7day_sent_at', 12: 'warning_12day_sent_at', recurring: 'last_recurring_reminder_at', 48: 'warning_48hr_sent_at', 60: 'flagged_60hr_sent_at' };
    const col = columnMap[stage] || 'warning_12day_sent_at';
    await run(`UPDATE task_assignees SET ${col}=? WHERE task_id=? AND username=?`, [new Date().toISOString(), taskId, username]);
  },
  async listAdminUsernames() { const rows = await all("SELECT username FROM users WHERE role='admin'"); return rows.map(r => r.username); },
  async listOutstandingTaskWarnings() {
    return all(`
      SELECT ta.username, ta.task_id, t.title, ta.warning_5day_sent_at, ta.warning_7day_sent_at, ta.warning_12day_sent_at
      FROM task_assignees ta JOIN tasks t ON t.id = ta.task_id
      WHERE t.status = 'open' AND ta.completed_at IS NULL
        AND (ta.warning_5day_sent_at IS NOT NULL OR ta.warning_7day_sent_at IS NOT NULL OR ta.warning_12day_sent_at IS NOT NULL)
    `);
  },
  async listDependentTasks(taskId) {
    return all("SELECT id, title FROM tasks WHERE depends_on_task_id = ? AND status = 'open'", [taskId]);
  },
  async resetEscalationTimersForTask(taskId) {
    await run(`UPDATE task_assignees SET last_reminded_at=NULL, reminder_3day_sent_at=NULL, warning_5day_sent_at=NULL, warning_7day_sent_at=NULL, warning_12day_sent_at=NULL, escalation_baseline_at=? WHERE task_id=?`, [new Date().toISOString(), taskId]);
  },

  // ---- deadline-based reminders ----
  async listOpenTasksWithDeadlines() {
    return all(`SELECT id, title, deadline, deadline_reminder_sent, deadline_overdue_notified, created_by_username
      FROM tasks WHERE status='open' AND deadline IS NOT NULL`);
  },
  async markDeadlineReminderSent(id) { await run('UPDATE tasks SET deadline_reminder_sent=1 WHERE id=?', [id]); },
  async markDeadlineOverdueNotified(id) { await run('UPDATE tasks SET deadline_overdue_notified=1 WHERE id=?', [id]); },
  async listIncompleteAssigneesForDeadlineCheck() {
    return all(`
      SELECT ta.task_id, ta.username, ta.individual_deadline, ta.individual_deadline_set_at, ta.deadline_reminder_sent_at, ta.deadline_overdue_notified_at, ta.is_released,
             ta.deadline_reminder_24h_sent_at, ta.deadline_reminder_12h_sent_at, ta.deadline_reminder_6h_sent_at, ta.deadline_reminder_2h_sent_at,
             t.title, t.deadline as task_deadline, t.created_by_username
      FROM task_assignees ta JOIN tasks t ON t.id = ta.task_id
      WHERE t.status='open' AND ta.completed_at IS NULL
    `);
  },
  async markAssigneeDeadlineTierSent(taskId, username, tier) {
    const columnMap = { 24: 'deadline_reminder_24h_sent_at', 12: 'deadline_reminder_12h_sent_at', 6: 'deadline_reminder_6h_sent_at', 2: 'deadline_reminder_2h_sent_at' };
    const col = columnMap[tier];
    if (!col) return;
    await run(`UPDATE task_assignees SET ${col}=? WHERE task_id=? AND username=?`, [new Date().toISOString(), taskId, username]);
  },
  async markAssigneeDeadlineReminderSent(taskId, username) { await run('UPDATE task_assignees SET deadline_reminder_sent_at=? WHERE task_id=? AND username=?', [new Date().toISOString(), taskId, username]); },
  async markAssigneeDeadlineOverdueNotified(taskId, username) { await run('UPDATE task_assignees SET deadline_overdue_notified_at=? WHERE task_id=? AND username=?', [new Date().toISOString(), taskId, username]); },

  // ---- per-task reports ----
  async listReportableTasks() {
    return all("SELECT id, title, status, priority, deadline, created_by, closed_at, cancelled_at, report_generated_at FROM tasks WHERE status IN ('closed','cancelled') ORDER BY COALESCE(closed_at, cancelled_at) DESC");
  },
  async getCachedReport(id) {
    const row = await get('SELECT report_data, report_generated_at FROM tasks WHERE id=?', [id]);
    if (!row || !row.report_data) return null;
    return { ...JSON.parse(row.report_data), generatedAt: row.report_generated_at };
  },
  async saveReport(id, reportObj) {
    await run('UPDATE tasks SET report_data=?, report_generated_at=? WHERE id=?', [JSON.stringify(reportObj), new Date().toISOString(), id]);
  },

  // ---- peak hours ----
  async getAllActivityTimestamps() {
    return {
      taskCreated: await all('SELECT created_at, created_by_username as username FROM tasks'),
      replies: await all('SELECT created_at, by_username as username FROM task_replies'),
      submissions: await all('SELECT submitted_at as created_at, username FROM task_assignees WHERE submitted_at IS NOT NULL'),
      approvals: await all("SELECT completed_at as created_at, username FROM task_assignees WHERE completed_at IS NOT NULL"),
      logins: await all('SELECT created_at, username FROM sessions'),
    };
  },

  // ---- performance / completion stats ----
  async getApprovedCompletions() {
    return all("SELECT username, submitted_at FROM task_assignees WHERE decision='approve' AND submitted_at IS NOT NULL");
  },
  async getOpenTaskInvolvement(username) {
    const asAssignee = await all(`
      SELECT DISTINCT t.id, t.title FROM tasks t
      JOIN task_assignees ta ON ta.task_id = t.id
      WHERE ta.username = ? AND t.status = 'open'
    `, [username]);
    const asCreator = await all(`SELECT id, title FROM tasks WHERE created_by_username = ? AND status = 'open'`, [username]);
    const map = new Map();
    [...asAssignee, ...asCreator].forEach(t => map.set(t.id, t.title));
    return Array.from(map.values());
  },

  // ---- teams / departments ----
  async listTeams() { const rows = await all('SELECT name FROM teams ORDER BY name'); return rows.map(r => r.name); },
  async addTeam(name) {
    const clean = String(name || '').trim();
    if (!clean) return;
    await run('INSERT INTO teams(name, created_at) VALUES(?, ?) ON CONFLICT (name) DO NOTHING', [clean, new Date().toISOString()]);
  },
  async removeTeam(name) {
    await run('UPDATE users SET team=NULL WHERE team=?', [name]);
    await run('DELETE FROM teams WHERE name=?', [name]);
  },

  // ---- projects & drawing library ----
  async listProjects() { const rows = await all('SELECT name FROM projects ORDER BY name'); return rows.map(r => r.name); },
  async addProject(name, tx) {
    const clean = String(name || '').trim();
    if (!clean) return;
    const runner = tx ? tx.run : run;
    await runner('INSERT INTO projects(name, created_at) VALUES(?, ?) ON CONFLICT (name) DO NOTHING', [clean, new Date().toISOString()]);
  },
  async listSections() { const rows = await all('SELECT name FROM drawing_sections ORDER BY name'); return rows.map(r => r.name); },
  async addSection(name) {
    const clean = String(name || '').trim();
    if (!clean) return;
    await run('INSERT INTO drawing_sections(name, created_at) VALUES(?, ?) ON CONFLICT (name) DO NOTHING', [clean, new Date().toISOString()]);
  },
  // ---- task phases ----
  async listPhases() { const rows = await all('SELECT name FROM task_phases ORDER BY name'); return rows.map(r => r.name); },
  async addPhase(name, tx) {
    const clean = String(name || '').trim();
    if (!clean) return;
    const runner = tx ? tx.run : run;
    await runner('INSERT INTO task_phases(name, created_at) VALUES(?, ?) ON CONFLICT (name) DO NOTHING', [clean, new Date().toISOString()]);
  },
  async addDrawing({ project, section, title, file_name, file_data, uploaded_by_username, uploaded_by_name }) {
    await module.exports.addProject(project);
    if (section) await module.exports.addSection(section);
    const row = await get(`INSERT INTO drawings(project,section,title,file_name,file_data,uploaded_by_username,uploaded_by_name,created_at)
      VALUES(?,?,?,?,?,?,?,?) RETURNING id`, [project, section || null, title || null, file_name || null, file_data || null, uploaded_by_username, uploaded_by_name, new Date().toISOString()]);
    return row.id;
  },
  async listDrawingsForProject(project) {
    return all(`SELECT id, project, section, title, file_name, uploaded_by_username, uploaded_by_name, created_at,
      (file_data IS NOT NULL) as has_file FROM drawings WHERE project=? ORDER BY COALESCE(section,'zzz'), created_at DESC`, [project]);
  },
  async getDrawingFile(id) { return get('SELECT file_data, file_name FROM drawings WHERE id=?', [id]); },
  async getDrawingMeta(id) { return get('SELECT id, project, uploaded_by_username FROM drawings WHERE id=?', [id]); },
  async deleteDrawing(id) { await run('DELETE FROM drawings WHERE id=?', [id]); },

  // ---- Send for Approval ----
  async createApprovalRequest({ id, title, description, file_data, file_name, created_by_username, created_by_name, reviewers }) {
    await run(`INSERT INTO approval_requests(id,title,description,file_data,file_name,created_by_username,created_by_name,status,created_at)
      VALUES(?,?,?,?,?,?,?,'pending',?)`, [id, title, description || null, file_data || null, file_name || null, created_by_username, created_by_name, new Date().toISOString()]);
    for (const u of reviewers) {
      await run('INSERT INTO approval_reviewers(request_id,username) VALUES(?,?) ON CONFLICT (request_id, username) DO NOTHING', [id, u]);
    }
    await module.exports.addApprovalHistory(id, created_by_username, created_by_name, `Sent "${file_name || title}" for approval`);
  },
  async addApprovalHistory(requestId, actorUsername, actorName, eventText) {
    await run('INSERT INTO approval_history(request_id,actor_username,actor_name,event_text,created_at) VALUES(?,?,?,?,?)',
      [requestId, actorUsername || null, actorName || null, eventText, new Date().toISOString()]);
  },
  async getApprovalRequest(id) { return get('SELECT * FROM approval_requests WHERE id=?', [id]); },
  async listReviewers(requestId) { return all('SELECT * FROM approval_reviewers WHERE request_id=?', [requestId]); },
  async listApprovalHistory(requestId) { return all('SELECT * FROM approval_history WHERE request_id=? ORDER BY created_at', [requestId]); },
  async getApprovalRequestFullLight(id) {
    const r = await get('SELECT * FROM approval_requests WHERE id=?', [id]);
    if (!r) return null;
    const hasFile = !!r.file_data;
    delete r.file_data;
    return { ...r, has_file: hasFile, reviewers: await module.exports.listReviewers(id), history: await module.exports.listApprovalHistory(id) };
  },
  async getApprovalFile(id) { return get('SELECT file_data, file_name FROM approval_requests WHERE id=?', [id]); },
  async listApprovalRequestsForUser(username) {
    // Rewritten from a LEFT JOIN + SELECT DISTINCT: Postgres rejects that pattern outright
    // (DISTINCT requires every ORDER BY column to also be in the select list — SQLite allowed
    // it, Postgres enforces the SQL standard here), and since this threw as an *unhandled*
    // rejection with no try/catch around it, the request never got a response at all — it hung
    // forever. This EXISTS-based version needs no DISTINCT, no join fan-out, and works
    // identically on both databases.
    const rows = await all(`
      SELECT ar.id FROM approval_requests ar
      WHERE ar.created_by_username = ? OR EXISTS (
        SELECT 1 FROM approval_reviewers rv WHERE rv.request_id = ar.id AND rv.username = ?
      )
      ORDER BY ar.created_at DESC
    `, [username, username]);
    const out = [];
    for (const r of rows) out.push(await module.exports.getApprovalRequestFullLight(r.id));
    return out;
  },
  async listAllApprovalRequests() {
    const rows = await all('SELECT id FROM approval_requests ORDER BY created_at DESC');
    const out = [];
    for (const r of rows) out.push(await module.exports.getApprovalRequestFullLight(r.id));
    return out;
  },
  async recordReviewerDecision(requestId, username, decision, reason) {
    await run('UPDATE approval_reviewers SET decision=?, decided_at=?, reason=? WHERE request_id=? AND username=?',
      [decision, new Date().toISOString(), reason || null, requestId, username]);
  },
  async resetReviewersForRevision(requestId) {
    await run('UPDATE approval_reviewers SET decision=NULL, decided_at=NULL, reason=NULL WHERE request_id=?', [requestId]);
  },
  async setApprovalRequestStatus(requestId, status, resolvedAt) {
    await run('UPDATE approval_requests SET status=?, resolved_at=? WHERE id=?', [status, resolvedAt || null, requestId]);
  },
  async reviseApprovalRequest(requestId, fileData, fileName) {
    await run('UPDATE approval_requests SET file_data=?, file_name=?, status=?, resolved_at=NULL WHERE id=?', [fileData, fileName, 'pending', requestId]);
  },
  async getApprovalDecisionStats() {
    return all("SELECT username, decided_at FROM approval_reviewers WHERE decision='approved' AND decided_at IS NOT NULL");
  },
  async listApprovalDecisionsDetailed() {
    return all(`
      SELECT ar.username as reviewer_username, ar.decision, ar.decided_at, ar.reason,
             req.id as request_id, req.title as request_title,
             req.created_by_username, req.created_by_name
      FROM approval_reviewers ar
      JOIN approval_requests req ON req.id = ar.request_id
      WHERE ar.decision IS NOT NULL AND ar.decided_at IS NOT NULL
      ORDER BY ar.decided_at DESC
    `);
  },
  async getApprovedTaskDurationsByPriority(priority) {
    return all(`
      SELECT t.created_at, ta.completed_at FROM tasks t
      JOIN task_assignees ta ON ta.task_id = t.id
      WHERE ta.decision='approve' AND ta.completed_at IS NOT NULL AND t.priority = ?
    `, [priority]);
  },
  async getMyResponseDurations(username) {
    const rows = await all(`
      SELECT escalation_baseline_at, submitted_at FROM task_assignees
      WHERE username=? AND decision='approve' AND submitted_at IS NOT NULL AND escalation_baseline_at IS NOT NULL
    `, [username]);
    return rows.map(r => (new Date(r.submitted_at) - new Date(r.escalation_baseline_at)) / 86400000).filter(d => d >= 0);
  },
  async getWarningCountsByUser() {
    // Reflects the current hour-based thresholds (48hr urgent warning, 60hr admin flag) — the
    // old 5/7/12-day columns are kept in the schema for historical data but are no longer
    // written to going forward, so counting them here would silently undercount everyone whose
    // lateness happened after this system changed.
    const rows = await all(`
      SELECT username, COUNT(*) as c FROM task_assignees
      WHERE warning_5day_sent_at IS NOT NULL OR warning_7day_sent_at IS NOT NULL OR warning_12day_sent_at IS NOT NULL
         OR warning_48hr_sent_at IS NOT NULL OR flagged_60hr_sent_at IS NOT NULL
      GROUP BY username
    `);
    const map = {};
    rows.forEach(r => { map[r.username] = Number(r.c); });
    return map;
  },
  async getPendingTaskCountsByUser() {
    const rows = await all(`
      SELECT ta.username, COUNT(*) as c
      FROM task_assignees ta JOIN tasks t ON t.id = ta.task_id
      WHERE t.status = 'open' AND ta.completed_at IS NULL AND ta.is_released = 1
      GROUP BY ta.username
    `);
    const map = {};
    rows.forEach(r => { map[r.username] = Number(r.c); });
    return map;
  },

  // ---- calendar-aligned period awards (Employee of the Quarter/Year) ----
  async getApprovedCompletionsInRange(startISO, endISO) {
    return all("SELECT username, submitted_at FROM task_assignees WHERE decision='approve' AND submitted_at >= ? AND submitted_at < ?", [startISO, endISO]);
  },
  async getLastProcessedPeriod(periodType) {
    const row = await get('SELECT last_processed_label FROM period_tracking WHERE period_type=?', [periodType]);
    return row ? row.last_processed_label : null;
  },
  async setLastProcessedPeriod(periodType, label) {
    await run('INSERT INTO period_tracking(period_type, last_processed_label) VALUES(?,?) ON CONFLICT(period_type) DO UPDATE SET last_processed_label=excluded.last_processed_label', [periodType, label]);
  },
  async savePeriodAward({ period_type, period_label, rank, username, name, team, rating, completions }) {
    await run(`INSERT INTO period_awards(period_type,period_label,rank,username,name,team,rating,completions,awarded_at)
                VALUES(?,?,?,?,?,?,?,?,?)`,
      [period_type, period_label, rank, username, name, team || null, rating, completions, new Date().toISOString()]);
  },
  async listPeriodAwards(periodType) {
    return all('SELECT * FROM period_awards WHERE period_type=? ORDER BY awarded_at DESC, rank ASC', [periodType]);
  },

  // ---- audit log ----
  async logAudit({ actor_username, actor_name, actor_team, action, details, ip_address, device }) {
    await run('INSERT INTO audit_log(actor_username,actor_name,actor_team,action,details,ip_address,device,created_at) VALUES(?,?,?,?,?,?,?,?)',
      [actor_username || null, actor_name || null, actor_team || null, action, details || null, ip_address || null, device || null, new Date().toISOString()]);
  },
  async listAuditLog(limit) { return all('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?', [limit || 200]); },
  async hasRecentAudit(username, action, ip, device, seconds) {
    const since = new Date(Date.now() - seconds * 1000).toISOString();
    return !!(await get("SELECT 1 FROM audit_log WHERE actor_username=? AND action=? AND created_at >= ? AND COALESCE(ip_address,'')=COALESCE(?,'') AND COALESCE(device,'')=COALESCE(?,'') LIMIT 1", [username, action, since, ip || null, device || null]));
  },
  // Newest first, keyset-paged by id (stable while new entries keep arriving).
  async queryAuditLog({ limit = 100, beforeId, actor, action, q, from, to }) {
    const where = [], params = [];
    if (beforeId) { where.push('id < ?'); params.push(beforeId); }
    if (actor) { where.push('actor_username = ?'); params.push(actor); }
    if (action) { where.push('action = ?'); params.push(action); }
    if (from) { where.push('created_at >= ?'); params.push(from); }
    if (to) { where.push('created_at <= ?'); params.push(to); }
    if (q) {
      where.push("(details ILIKE ? OR actor_name ILIKE ? OR actor_username ILIKE ? OR COALESCE(actor_team,'') ILIKE ?)");
      const like = '%' + q.replace(/[%_]/g, m => '\\' + m) + '%';
      params.push(like, like, like, like);
    }
    const sqlWhere = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const rows = await all(`SELECT * FROM audit_log ${sqlWhere} ORDER BY id DESC LIMIT ?`, [...params, limit + 1]);
    const hasMore = rows.length > limit;
    const entries = hasMore ? rows.slice(0, limit) : rows;
    const actions = (await all('SELECT action, COUNT(*)::int AS n FROM audit_log GROUP BY action ORDER BY n DESC')).map(r => ({ action: r.action, count: r.n }));
    const actors = await all('SELECT actor_username AS username, MAX(actor_name) AS name FROM audit_log WHERE actor_username IS NOT NULL GROUP BY actor_username ORDER BY MAX(actor_name)');
    return { entries, hasMore, nextBeforeId: hasMore ? entries[entries.length - 1].id : null, actions, actors };
  },

  // ---- notifications ----
  _notificationHook: null,
  setNotificationHook(fn) { module.exports._notificationHook = fn; },
  async createNotification({ username, type, message, task_id, chat_room, ref_type, ref_id }, tx) {
    const runner = tx ? tx.run : run;
    const ins = await runner('INSERT INTO notifications(username,type,message,task_id,chat_room,ref_type,ref_id,read,created_at) VALUES(?,?,?,?,?,?,?,0,?) RETURNING id',
      [username, type, message, task_id || null, chat_room || null, ref_type || null, ref_id == null ? null : String(ref_id), new Date().toISOString()]);
    const notificationId = ins && ins.rows && ins.rows[0] ? ins.rows[0].id : null;
    // The push/WhatsApp dispatch hook deliberately never runs on the transaction's own client —
    // it's fire-and-forget external I/O (an HTTP call to a push service or WhatsApp), which has
    // no business holding open a database transaction while it happens. It's called here
    // regardless of whether `tx` was passed, same as the non-transactional path.
    if (module.exports._notificationHook) {
      try { module.exports._notificationHook({ username, type, message, task_id, notificationId }); }
      catch (e) { console.error('Notification hook (push/WhatsApp dispatch) failed:', e.message); }
    }
    return notificationId;
  },
  // ---------- notification deliveries (Phase 2) ----------
  // Claims an idempotency key. Returns the delivery id if THIS caller should send now; null if the
  // key was already sent/cancelled (duplicate). A previously FAILED key may be claimed again (retry).
  async claimDelivery({ key, recipient, taskId, channel = 'in_app', type, scheduledAt }) {
    const r = await get(`INSERT INTO notification_deliveries (idempotency_key, recipient_username, task_id, channel, notification_type, status, scheduled_at, attempt_count)
      VALUES (?,?,?,?,?,'processing',?,1)
      ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
      DO UPDATE SET status='processing', attempt_count = notification_deliveries.attempt_count + 1, updated_at = now()
        WHERE notification_deliveries.status = 'failed'
      RETURNING id`, [key, recipient, taskId || null, channel, type || null, scheduledAt || new Date().toISOString()]);
    return r ? r.id : null;
  },
  async finishDelivery(id, { status, notificationId, reason, sentAt }) {
    await run(`UPDATE notification_deliveries SET status=?, notification_id=COALESCE(?, notification_id), failure_reason=?,
      sent_at = CASE WHEN ?='sent' THEN COALESCE(?::timestamptz, now()) ELSE sent_at END, updated_at=now() WHERE id=?`,
      [status, notificationId || null, reason || null, status, sentAt || null, id]);
  },
  // Records a delivery that was intentionally not sent (combined / anti-spam), occupying its key.
  async recordSkippedDelivery({ key, recipient, taskId, type, reason }) {
    await run(`INSERT INTO notification_deliveries (idempotency_key, recipient_username, task_id, channel, notification_type, status, failure_reason)
      VALUES (?,?,?,'in_app',?,'cancelled',?) ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`, [key, recipient, taskId || null, type || null, reason]);
  },
  async recordChannelDelivery({ notificationId, recipient, taskId, channel, type, status, reason }) {
    await run(`INSERT INTO notification_deliveries (notification_id, recipient_username, task_id, channel, notification_type, status, failure_reason, sent_at, attempt_count)
      VALUES (?,?,?,?,?,?,?, CASE WHEN ?='sent' THEN now() ELSE NULL END, 1)`, [notificationId || null, recipient, taskId || null, channel, type || null, status, reason || null, status]);
  },
  // Last time each person was sent a reminder-type message about each task (anti-spam gap).
  // One automatic reminder per person per task: a new slot's reminder (9 AM → 3 PM → 6 PM) replaces the
  // earlier one instead of stacking a copy, so the count stays small. The delivery log keeps the history.
  async dedupeAutoNotifications(batch = 20000) {
    const types = ['task_reminder', 'task_reminder_recurring', 'deadline_window', 'deadline_soon', 'deadline_due_today', 'deadline_passed', 'task_overdue_days', 'task_warning_urgent', 'task_warning_creator', 'task_flagged', 'admin_late_flag'];
    let total = 0;
    for (let pass = 0; pass < 100; pass++) {
      const r = await run(`DELETE FROM notifications WHERE id IN (
        SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY username, task_id ORDER BY created_at DESC, id DESC) AS rn
          FROM notifications WHERE task_id IS NOT NULL AND type = ANY(?::text[])) x WHERE rn > 1 LIMIT ?)`, [types, batch]);
      const n = r && r.changes != null ? r.changes : (r && r.rowCount) || 0;
      total += n;
      if (n < batch) break;
      await new Promise(res => setTimeout(res, 300));
    }
    if (total) console.log(`Removed ${total} duplicate automatic reminders (kept the newest per person per task).`);
    return total;
  },
  // For the Notifications page: each task's status, and when this person last pressed Follow up on it.
  async notificationTaskInfo(username, taskIds) {
    const ids = Array.from(new Set((taskIds || []).filter(Boolean)));
    if (!ids.length) return {};
    const me = await get('SELECT role FROM users WHERE username=?', [username]);
    const isAdmin = !!(me && me.role === 'admin');
    const [tasks, fu, people, closures] = await Promise.all([
      all('SELECT id, status, title, deadline, created_at, created_by_username FROM tasks WHERE id = ANY(?::text[])', [ids]),
      all("SELECT task_id, MAX(created_at) AS last FROM task_activity_events WHERE event_type='FOLLOW_UP_SENT' AND actor_username=? AND task_id = ANY(?::text[]) GROUP BY task_id", [username, ids]),
      all('SELECT task_id, username, submitted_at, completed_at, decision, individual_deadline, COALESCE(released_at, escalation_baseline_at) AS since FROM task_assignees WHERE task_id = ANY(?::text[])', [ids]),
      all("SELECT id, task_id FROM task_closure_requests WHERE status='pending' AND task_id = ANY(?::text[])", [ids]),
    ]);
    const out = {};
    for (const t of tasks) {
      const canDecide = isAdmin || t.created_by_username === username;
      const ps = people.filter(p => p.task_id === t.id);
      out[t.id] = { status: t.status, title: t.title, deadline: t.deadline, createdAt: t.created_at, followedUpAt: null, canDecide,
        // People whose part waits for approval — only sent to whoever can approve it.
        toApprove: canDecide && t.status === 'open' ? ps.filter(p => p.submitted_at && !(p.decision === 'approve' && p.completed_at)).map(p => p.username) : [],
        // Everyone's progress (for warnings / flags: how long it has been incomplete).
        people: ps.map(p => ({ u: p.username, done: !!(p.decision === 'approve' && p.completed_at), submitted: !!p.submitted_at, deadline: p.individual_deadline || t.deadline, since: p.since || t.created_at })),
        closureId: null };
    }
    for (const c of closures) if (out[c.task_id] && out[c.task_id].canDecide) out[c.task_id].closureId = c.id;
    for (const f of fu) if (out[f.task_id]) out[f.task_id].followedUpAt = f.last ? new Date(f.last).toISOString() : null;
    return out;
  },
  // Status of the approval requests / payments that notifications point to (for their action buttons).
  async notificationRefInfo(username, items) {
    const ap = [...new Set(items.filter(n => n.ref_type === 'approval' && n.ref_id).map(n => String(n.ref_id)))];
    const pay = [...new Set(items.filter(n => n.ref_type === 'payment' && n.ref_id).map(n => Number(n.ref_id)))].filter(Number.isInteger);
    const out = { approval: {}, payment: {} };
    if (ap.length) {
      const rows = await all(`SELECT r.id, r.status, r.title, v.decision FROM approval_requests r LEFT JOIN approval_reviewers v ON v.request_id = r.id AND v.username = ?
        WHERE r.id = ANY(?::text[])`, [username, ap]);
      for (const r of rows) out.approval[r.id] = { status: r.status, title: r.title, mine: r.decision || null };
    }
    if (pay.length) {
      const rows = await all("SELECT id, COALESCE(verify_status,'pending') AS st, paid_by, amount FROM delivery_payments WHERE id = ANY(?::int[])", [pay]);
      for (const r of rows) out.payment[r.id] = { status: r.st, paidBy: r.paid_by, amount: Number(r.amount) };
    }
    return out;
  },
  // Admin: who has seen their notifications.
  async notificationReadSummary(sinceIso) {
    return all(`SELECT u.username, u.name, u.designation, u.team,
        COUNT(n.id) FILTER (WHERE n.created_at >= ?) AS sent,
        COUNT(n.id) FILTER (WHERE n.created_at >= ? AND n.read<>0) AS seen,
        COUNT(n.id) FILTER (WHERE n.read=0) AS unseen,
        MIN(n.created_at) FILTER (WHERE n.read=0) AS oldest_unseen,
        MAX(n.read_at) AS last_seen
      FROM users u LEFT JOIN notifications n ON n.username = u.username
      GROUP BY u.username, u.name, u.designation, u.team ORDER BY COUNT(n.id) FILTER (WHERE n.read=0) DESC, u.name`, [sinceIso, sinceIso]);
  },
  async notificationReadsFor(username, limit = 60) {
    return all('SELECT id, type, message, task_id, read, read_at, created_at FROM notifications WHERE username=? ORDER BY created_at DESC LIMIT ?', [username, limit]);
  },
  async removeEarlierAutoNotifications(username, taskId, types) {
    if (!taskId || !types.length) return 0;
    const r = await run('DELETE FROM notifications WHERE username=? AND task_id=? AND type = ANY(?::text[])', [username, taskId, types]);
    return r && r.changes != null ? r.changes : 0;
  },
  async lastReminderSentMap(types, sinceIso) {
    const rows = await all(`SELECT recipient_username, task_id, MAX(sent_at) AS last FROM notification_deliveries
      WHERE channel='in_app' AND status='sent' AND notification_type = ANY(?::text[]) AND sent_at >= ? GROUP BY 1, 2`, [types, sinceIso]);
    return new Map(rows.map(r => [`${r.recipient_username}|${r.task_id}`, new Date(r.last).getTime()]));
  },
  async listDeliveries({ status, limit = 100 } = {}) {
    return all(`SELECT id, recipient_username, task_id, channel, notification_type, status, failure_reason, attempt_count, sent_at, created_at
      FROM notification_deliveries ${status ? 'WHERE status = ?' : ''} ORDER BY id DESC LIMIT ?`, status ? [status, limit] : [limit]);
  },
  async savePushSubscription(username, endpoint, p256dh, auth) {
    await run(`INSERT INTO push_subscriptions(username,endpoint,p256dh,auth,created_at) VALUES(?,?,?,?,?)
      ON CONFLICT (endpoint) DO UPDATE SET username=EXCLUDED.username, p256dh=EXCLUDED.p256dh, auth=EXCLUDED.auth, created_at=EXCLUDED.created_at`,
      [username, endpoint, p256dh, auth, new Date().toISOString()]);
    // Keep each person's 5 newest devices only — old phones / browsers are dropped.
    await run(`DELETE FROM push_subscriptions WHERE username=? AND endpoint NOT IN
      (SELECT endpoint FROM push_subscriptions WHERE username=? ORDER BY created_at DESC LIMIT 5)`, [username, username]);
  },
  async removePushSubscription(endpoint) { await run('DELETE FROM push_subscriptions WHERE endpoint=?', [endpoint]); },
  async listPushSubscriptionsForUser(username) { return all('SELECT * FROM push_subscriptions WHERE username=?', [username]); },
  async deleteNotificationsForTask(taskId) { await run('DELETE FROM notifications WHERE task_id=?', [taskId]); },
  async getLatestNotificationId(username) { const r = await get('SELECT MAX(id) m FROM notifications WHERE username=?', [username]); return Number(r.m) || 0; },
  async listUnreadNotificationsAfter(username, afterId, limit) {
    return all('SELECT id, message, task_id, created_at FROM notifications WHERE username=? AND id > ? AND read=0 ORDER BY id ASC LIMIT ?', [username, afterId, limit]);
  },
  // Every unseen notification (up to 500, so the page always matches the unread count) plus the 100
  // most recently seen ones (newest seen first) for the Seen tab.
  async listNotifications(username) {
    return all(`(SELECT * FROM notifications WHERE username=? AND read=0 ORDER BY created_at DESC LIMIT 500)
                UNION ALL
                (SELECT * FROM notifications WHERE username=? AND read<>0 ORDER BY COALESCE(read_at, created_at) DESC LIMIT 100)`, [username, username]);
  },
  async markNotificationsUnread(ids, username) {
    const clean = (ids || []).map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 200);
    if (!clean.length) return 0;
    await run(`UPDATE notifications SET read=0, read_at=NULL WHERE username=? AND id IN (${clean.map(() => '?').join(',')})`, [username, ...clean]);
    return clean.length;
  },
  async markNotificationRead(id, username) { await run('UPDATE notifications SET read=1, read_at=COALESCE(read_at, ?) WHERE id=? AND username=?', [new Date().toISOString(), id, username]); },
  async markNotificationsRead(ids, username) {
    const clean = (ids || []).map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 200);
    if (!clean.length) return 0;
    const r = await run(`UPDATE notifications SET read=1, read_at=COALESCE(read_at, ?) WHERE username=? AND read=0 AND id IN (${clean.map(() => '?').join(',')})`, [new Date().toISOString(), username, ...clean]);
    return r && r.changes != null ? r.changes : clean.length;
  },

  async countUnreadNotifications(username) { const r = await get('SELECT COUNT(*) c FROM notifications WHERE username=? AND read=0', [username]); return Number(r.c); },
};
