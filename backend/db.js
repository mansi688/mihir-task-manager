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
  max: 10,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
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
async function run(sql, params) { return pool.query(q(sql, params)); }
async function get(sql, params) { const r = await pool.query(q(sql, params)); return r.rows[0]; }
async function all(sql, params) { const r = await pool.query(q(sql, params)); return r.rows; }

// The Postgres equivalent of better-sqlite3's synchronous `db.transaction(fn)()` wrapper — one
// dedicated client from the pool so BEGIN/COMMIT/ROLLBACK all happen on the same connection, and
// a genuine rollback on any error instead of a partial write staying committed.
async function runInTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tx = {
      run: async (sql, params) => client.query(q(sql, params)),
      get: async (sql, params) => (await client.query(q(sql, params))).rows[0],
      all: async (sql, params) => (await client.query(q(sql, params))).rows,
    };
    const result = await fn(tx);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
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

  const existingTeams = await all("SELECT DISTINCT team FROM users WHERE team IS NOT NULL AND team != ''");
  for (const r of existingTeams) {
    await run('INSERT INTO teams(name, created_at) VALUES(?, ?) ON CONFLICT (name) DO NOTHING', [r.team, new Date().toISOString()]);
  }

  const userCountRow = await get('SELECT COUNT(*) c FROM users');
  if (Number(userCountRow.c) === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    await run(`INSERT INTO users(username,password_hash,role,name,team,is_team_lead,must_change_password,created_at)
                VALUES('admin',?,'admin','Mihir Sabadra',NULL,1,1,?)`, [hash, new Date().toISOString()]);
    console.log('First run: created default account admin / admin123 — you will be asked to set a real password on first login.');
  } else {
    const existingAdmin = await get("SELECT username FROM users WHERE username='admin' AND name='Admin'");
    if (existingAdmin) {
      await run("UPDATE users SET name='Mihir Sabadra' WHERE username='admin'");
      console.log('Renamed the default admin account\'s display name to "Mihir Sabadra".');
    }
  }

  const AUTO_SEED_ACCOUNTS = [
    { name: 'Rohit Kamble', username: 'rohit.k', team: 'Estimation Department', designation: 'Estimate', teamLead: false },
    { name: 'Suraj Kathale', username: 'suraj_kathale', team: 'Estimation Department', designation: 'Estimate Head', teamLead: true },
    { name: 'Tanishq Mutha', username: 'tanishq.m', team: 'Purchase Department', designation: 'Purchase Lead', teamLead: true },
    { name: 'Tejas', username: 'tejas.l', team: 'Estimation Department', designation: '', teamLead: false },
    { name: 'Yuvraj Patil', username: 'yuvraj.p', team: 'Purchase Department', designation: 'Purchase', teamLead: false },
  ];
  const autoSeedHash = bcrypt.hashSync('MHR123456', 10);
  for (const acc of AUTO_SEED_ACCOUNTS) {
    const exists = await get('SELECT 1 FROM users WHERE username=?', [acc.username]);
    if (exists) continue;
    await run(`INSERT INTO users(username,password_hash,role,name,team,designation,is_team_lead,must_change_password,created_at)
                VALUES(?,?,?,?,?,?,?,1,?)`,
      [acc.username, autoSeedHash, 'member', acc.name, acc.team, acc.designation || null, acc.teamLead ? 1 : 0, new Date().toISOString()]);
    await run('INSERT INTO teams(name, created_at) VALUES(?, ?) ON CONFLICT (name) DO NOTHING', [acc.team, new Date().toISOString()]);
    console.log(`Auto-created account: ${acc.username} (${acc.name}) — temporary password MHR123456, must be changed on first login.`);
  }
}

module.exports = {
  init,
  pool, // exposed for a clean shutdown (pool.end()) and for /ready health checks
  runInTransaction,

  // ---- users ----
  async getUser(username) { return get('SELECT * FROM users WHERE username=?', [username]); },
  async recordFailedLogin(username) {
    const user = await get('SELECT failed_login_count FROM users WHERE username=?', [username]);
    if (!user) return;
    const count = (user.failed_login_count || 0) + 1;
    const lockedUntil = count >= 5 ? new Date(Date.now() + 3 * 60 * 1000).toISOString() : null;
    await run('UPDATE users SET failed_login_count=?, locked_until=? WHERE username=?', [count, lockedUntil, username]);
  },
  async clearFailedLogins(username) { await run('UPDATE users SET failed_login_count=0, locked_until=NULL WHERE username=?', [username]); },
  async bumpTokenVersion(username) { await run('UPDATE users SET token_version=COALESCE(token_version,0)+1 WHERE username=?', [username]); },
  async listUsers() { return all('SELECT username,role,name,email,phone,team,designation,is_team_lead,visible_departments,must_change_password,created_at FROM users ORDER BY name'); },
  async updateOwnPhone(username, phone) { await run('UPDATE users SET phone=? WHERE username=?', [phone || null, username]); },
  async setVisibleDepartments(username, departmentsCsv) { await run('UPDATE users SET visible_departments=? WHERE username=?', [departmentsCsv || null, username]); },
  async createUser({ username, password_hash, role, name, team, designation, must_change_password }) {
    await run(`INSERT INTO users(username,password_hash,role,name,team,designation,must_change_password,created_at)
                VALUES(?,?,?,?,?,?,?,?)`,
      [username, password_hash, role, name, team || null, designation || null, must_change_password ? 1 : 0, new Date().toISOString()]);
    if (team) await module.exports.addTeam(team);
  },
  async deleteUser(username) { await run('DELETE FROM users WHERE username=?', [username]); },
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
    await run('UPDATE task_assignees SET individual_deadline=? WHERE task_id=? AND username=?', [deadline || null, taskId, username]);
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
  async isTaskBlocked(id) {
    const t = await get('SELECT depends_on_task_id FROM tasks WHERE id=?', [id]);
    if (!t || !t.depends_on_task_id) return false;
    const dep = await get('SELECT status FROM tasks WHERE id=?', [t.depends_on_task_id]);
    return dep ? dep.status === 'open' : false;
  },
  async listTasksForUser(username) {
    return all(`
      SELECT DISTINCT t.* FROM tasks t
      JOIN task_assignees ta ON ta.task_id = t.id
      WHERE ta.username = ? OR t.created_by_username = ?
      ORDER BY t.created_at DESC
    `, [username, username]);
  },
  async listAllTasks() { return all('SELECT * FROM tasks ORDER BY created_at DESC LIMIT 5000'); },
  async addChecklistItem(taskId, text, sortOrder) {
    await run('INSERT INTO task_checklist_items(task_id,text,is_checked,sort_order,created_at) VALUES(?,?,0,?,?)', [taskId, text, sortOrder || 0, new Date().toISOString()]);
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
  async addFollowup(taskId, username, taggedBy) {
    await run('INSERT INTO task_followups(task_id,username,tagged_by,created_at) VALUES(?,?,?,?) ON CONFLICT (task_id, username) DO NOTHING', [taskId, username, taggedBy || null, new Date().toISOString()]);
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
             COALESCE(ta.escalation_baseline_at, t.created_at) as escalation_baseline_at,
             t.title, t.created_at, t.created_by, t.created_by_username
      FROM task_assignees ta JOIN tasks t ON t.id = ta.task_id
      WHERE t.status = 'open' AND ta.completed_at IS NULL
    `);
  },
  async markEscalationStage(taskId, username, stage) {
    const col = stage === 3 ? 'reminder_3day_sent_at' : (stage === 5 ? 'warning_5day_sent_at' : (stage === 7 ? 'warning_7day_sent_at' : 'warning_12day_sent_at'));
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
      SELECT ta.task_id, ta.username, ta.individual_deadline, ta.deadline_reminder_sent_at, ta.deadline_overdue_notified_at, ta.is_released,
             t.title, t.deadline as task_deadline
      FROM task_assignees ta JOIN tasks t ON t.id = ta.task_id
      WHERE t.status='open' AND ta.completed_at IS NULL
    `);
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
    const rows = await all(`
      SELECT username, COUNT(*) as c FROM task_assignees
      WHERE warning_5day_sent_at IS NOT NULL OR warning_7day_sent_at IS NOT NULL OR warning_12day_sent_at IS NOT NULL
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
  async listNotifications(username) { return all('SELECT * FROM notifications WHERE username=? ORDER BY created_at DESC LIMIT 100', [username]); },
  async markNotificationRead(id, username) { await run('UPDATE notifications SET read=1 WHERE id=? AND username=?', [id, username]); },
  async markAllNotificationsRead(username) { await run('UPDATE notifications SET read=1 WHERE username=?', [username]); },
  async countUnreadNotifications(username) { const r = await get('SELECT COUNT(*) c FROM notifications WHERE username=? AND read=0', [username]); return Number(r.c); },
};
