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
  idleTimeoutMillis: 30000,
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
const UNTRACKED_TABLES = new Set(['sessions', 'audit_log']);
function noteWrite(text) {
  const m = /^\s*(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?(\w+)/i.exec(text);
  if (!m) return;
  const table = m[1].toLowerCase();
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
  async getUserFresh(username) { return get('SELECT * FROM users WHERE username=?', [username]); },
  async listUsers() {
    if (userListCache && Date.now() - userListCache.at < USER_CACHE_TTL_MS) return userListCache.rows.map(r => ({ ...r }));
    const version = usersVersion;
    const rows = await all('SELECT username,role,name,email,phone,team,designation,is_team_lead,visible_departments,must_change_password,created_at FROM users ORDER BY name');
    if (version === usersVersion) userListCache = { at: Date.now(), rows };
    return rows.map(r => ({ ...r }));
  },
  async updateOwnPhone(username, phone) { await run('UPDATE users SET phone=? WHERE username=?', [phone || null, username]); },
  async setVisibleDepartments(username, departmentsCsv) { await run('UPDATE users SET visible_departments=? WHERE username=?', [departmentsCsv || null, username]); },
  async createUser({ username, password_hash, role, name, team, designation, must_change_password }) {
    await run(`INSERT INTO users(username,password_hash,role,name,team,designation,must_change_password,created_at)
                VALUES(?,?,?,?,?,?,?,?)`,
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
  async listTasksFullLight(scope, username) {
    const cols = await taskListColumns();
    const tasks = scope === 'user'
      ? await all(`SELECT ${cols}, (t.attachment IS NOT NULL) AS has_attachment FROM tasks t
          WHERE t.archived_at IS NULL AND (t.created_by_username = ? OR EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.username = ?))
          ORDER BY t.created_at DESC`, [username, username])
      : await all(`SELECT ${cols}, (t.attachment IS NOT NULL) AS has_attachment FROM tasks t WHERE t.archived_at IS NULL ORDER BY t.created_at DESC LIMIT 5000`);
    if (tasks.length === 0) return [];
    const ids = tasks.map(t => t.id);
    const group = (rows) => { const m = new Map(); for (const r of rows) { if (!m.has(r.task_id)) m.set(r.task_id, []); m.get(r.task_id).push(r); } return m; };
    const assignees = group(await all('SELECT * FROM task_assignees WHERE task_id = ANY(?::text[])', [ids]));
    const followups = group(await all('SELECT * FROM task_followups WHERE task_id = ANY(?::text[])', [ids]));
    const checklist = group(await all('SELECT * FROM task_checklist_items WHERE task_id = ANY(?::text[]) ORDER BY sort_order, id', [ids]));
    const replies = group(await all(`SELECT id, task_id, by_username, by_name, message, attachment_name, created_at, (attachment IS NOT NULL) AS has_attachment
      FROM task_replies WHERE task_id = ANY(?::text[]) ORDER BY created_at`, [ids]));
    const subs = await all('SELECT id, title, status, priority, deadline, parent_task_id FROM tasks WHERE parent_task_id = ANY(?::text[]) ORDER BY created_at ASC', [ids]);
    const subsByParent = new Map();
    for (const sub of subs) {
      const { parent_task_id, ...rest } = sub;
      if (!subsByParent.has(parent_task_id)) subsByParent.set(parent_task_id, []);
      subsByParent.get(parent_task_id).push(rest);
    }
    const depIds = Array.from(new Set(tasks.map(t => t.depends_on_task_id).filter(Boolean)));
    const depStatus = new Map((depIds.length ? await all('SELECT id, status FROM tasks WHERE id = ANY(?::text[])', [depIds]) : []).map(d => [d.id, d.status]));
    return tasks.map(t => {
      const subtasks = subsByParent.get(t.id) || [];
      return {
        ...t,
        blocked: t.depends_on_task_id ? depStatus.get(t.depends_on_task_id) === 'open' : false,
        assignees: assignees.get(t.id) || [],
        followups: followups.get(t.id) || [],
        checklist: checklist.get(t.id) || [],
        replies: replies.get(t.id) || [],
        subtasks,
        subtaskCount: subtasks.length,
        openSubtaskCount: subtasks.filter(x => x.status === 'open').length,
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
        for (const table of ['task_replies', 'task_checklist_items', 'task_followups', 'notifications']) {
          await tx.run(`DELETE FROM ${table} WHERE task_id = ANY(?::text[])`, [chunk]);
        }
      }
      return count;
    });
  },
  async countArchivedTasks() { return Number((await get('SELECT COUNT(*) c FROM tasks WHERE archived_at IS NOT NULL')).c); },
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
      ['id', 'title', 'description', 'priority', 'deadline', 'status', 'created_by', 'created_by_username', 'depends_on_task_id', 'is_drawing_request', 'parent_task_id', 'project', 'phase', 'auto_release_stages', 'import_key', 'import_deadline', 'created_at'],
      tasks.map(t => [t.id, t.title, t.description || null, t.priority, t.deadline, 'open', t.created_by, t.created_by_username, t.depends_on_task_id || null, 0, t.parent_task_id || null, t.project || null, t.phase || null, t.auto_release_stages ? 1 : 0, t.import_key || null, t.import_key ? t.deadline : null, now]));
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
    await run('INSERT INTO task_replies(task_id,by_username,by_name,message,attachment,attachment_name,created_at) VALUES(?,?,?,?,?,?,?)',
      [taskId, by_username, by_name, message || null, attachment || null, attachment_name || null, new Date().toISOString()]);
  },
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
    const subtaskCountRow = await get('SELECT COUNT(*) c FROM tasks WHERE parent_task_id=?', [id]);
    const openSubtaskCountRow = await get("SELECT COUNT(*) c FROM tasks WHERE parent_task_id=? AND status='open'", [id]);
    return {
      ...t,
      has_attachment: hasAttachment,
      blocked: await module.exports.isTaskBlocked(id),
      assignees: await all('SELECT * FROM task_assignees WHERE task_id=?', [id]),
      followups: await all('SELECT * FROM task_followups WHERE task_id=?', [id]),
      checklist: await all('SELECT * FROM task_checklist_items WHERE task_id=? ORDER BY sort_order, id', [id]),
      replies,
      subtasks: await all('SELECT id,title,status,priority,deadline FROM tasks WHERE parent_task_id=? ORDER BY created_at ASC', [id]),
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
             t.title, t.deadline as task_deadline
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

  // ---- notifications ----
  _notificationHook: null,
  setNotificationHook(fn) { module.exports._notificationHook = fn; },
  async createNotification({ username, type, message, task_id }, tx) {
    const runner = tx ? tx.run : run;
    await runner('INSERT INTO notifications(username,type,message,task_id,read,created_at) VALUES(?,?,?,?,0,?)',
      [username, type, message, task_id || null, new Date().toISOString()]);
    // The push/WhatsApp dispatch hook deliberately never runs on the transaction's own client —
    // it's fire-and-forget external I/O (an HTTP call to a push service or WhatsApp), which has
    // no business holding open a database transaction while it happens. It's called here
    // regardless of whether `tx` was passed, same as the non-transactional path.
    if (module.exports._notificationHook) {
      try { module.exports._notificationHook({ username, type, message, task_id }); }
      catch (e) { console.error('Notification hook (push/WhatsApp dispatch) failed:', e.message); }
    }
  },
  async savePushSubscription(username, endpoint, p256dh, auth) {
    await run(`INSERT INTO push_subscriptions(username,endpoint,p256dh,auth,created_at) VALUES(?,?,?,?,?)
      ON CONFLICT (endpoint) DO UPDATE SET username=EXCLUDED.username, p256dh=EXCLUDED.p256dh, auth=EXCLUDED.auth, created_at=EXCLUDED.created_at`,
      [username, endpoint, p256dh, auth, new Date().toISOString()]);
  },
  async removePushSubscription(endpoint) { await run('DELETE FROM push_subscriptions WHERE endpoint=?', [endpoint]); },
  async listPushSubscriptionsForUser(username) { return all('SELECT * FROM push_subscriptions WHERE username=?', [username]); },
  async deleteNotificationsForTask(taskId) { await run('DELETE FROM notifications WHERE task_id=?', [taskId]); },
  async getLatestNotificationId(username) { const r = await get('SELECT MAX(id) m FROM notifications WHERE username=?', [username]); return Number(r.m) || 0; },
  async listUnreadNotificationsAfter(username, afterId, limit) {
    return all('SELECT id, message, task_id, created_at FROM notifications WHERE username=? AND id > ? AND read=0 ORDER BY id ASC LIMIT ?', [username, afterId, limit]);
  },
  async listNotifications(username) { return all('SELECT * FROM notifications WHERE username=? ORDER BY created_at DESC LIMIT 100', [username]); },
  async markNotificationRead(id, username) { await run('UPDATE notifications SET read=1 WHERE id=? AND username=?', [id, username]); },
  async markAllNotificationsRead(username) { await run('UPDATE notifications SET read=1 WHERE username=?', [username]); },
  async countUnreadNotifications(username) { const r = await get('SELECT COUNT(*) c FROM notifications WHERE username=? AND read=0', [username]); return Number(r.c); },
};
