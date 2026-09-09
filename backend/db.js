const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const path = require('path');
// Configurable via DB_PATH so the test suite can point at an isolated temp file instead of your
// real data. When not set, resolves to the PROJECT ROOT explicitly (not process.cwd()) — this
// matters now that this file lives in backend/: without this, the database's actual location
// would silently depend on which directory you happened to run `node` from, and could drift out
// of sync with where backup-database.js/restore-database.js look for it. All three now agree on
// exactly one location, resolved the same explicit way.
const db = new Database(process.env.DB_PATH || path.join(__dirname, '..', 'taskmanager.db'));
db.pragma('journal_mode = WAL');

db.exec(`
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
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  actor_username TEXT,
  actor_name TEXT,
  event_text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_username TEXT,
  actor_name TEXT,
  action TEXT NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  task_id TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS push_subscriptions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`);

// Safe column migrations for future upgrades.
function ensureColumn(table, column, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}
ensureColumn('users', 'email', 'TEXT');
ensureColumn('users', 'designation', 'TEXT');
ensureColumn('users', 'failed_login_count', 'INTEGER DEFAULT 0');
ensureColumn('users', 'locked_until', 'TEXT');
ensureColumn('task_assignees', 'submitted_at', 'TEXT');
ensureColumn('task_assignees', 'submission_note', 'TEXT');
ensureColumn('task_assignees', 'escalation_baseline_at', 'TEXT');
ensureColumn('task_assignees', 'stage', 'INTEGER DEFAULT 1');
ensureColumn('task_assignees', 'is_released', 'INTEGER DEFAULT 1');
ensureColumn('task_assignees', 'released_at', 'TEXT');
ensureColumn('task_assignees', 'released_by', 'TEXT');
ensureColumn('tasks', 'auto_release_stages', 'INTEGER DEFAULT 0');
ensureColumn('drawings', 'section', 'TEXT');
ensureColumn('tasks', 'cancelled_at', 'TEXT');
ensureColumn('tasks', 'cancelled_by', 'TEXT');
ensureColumn('tasks', 'cancel_reason', 'TEXT');
ensureColumn('tasks', 'deadline_reminder_sent', 'INTEGER DEFAULT 0');
ensureColumn('tasks', 'deadline_overdue_notified', 'INTEGER DEFAULT 0');
ensureColumn('tasks', 'ai_summary', 'TEXT');
ensureColumn('tasks', 'ai_summary_reply_count', 'INTEGER DEFAULT 0');
ensureColumn('task_assignees', 'warning_5day_sent_at', 'TEXT');
ensureColumn('tasks', 'report_data', 'TEXT');
ensureColumn('tasks', 'report_generated_at', 'TEXT');
ensureColumn('tasks', 'version', 'INTEGER DEFAULT 1');
ensureColumn('audit_log', 'ip_address', 'TEXT');
ensureColumn('audit_log', 'device', 'TEXT');
ensureColumn('audit_log', 'actor_team', 'TEXT');
ensureColumn('users', 'password_reset_otp_hash', 'TEXT');
ensureColumn('users', 'password_reset_otp_expires', 'TEXT');
ensureColumn('users', 'visible_departments', 'TEXT');
ensureColumn('task_assignees', 'individual_deadline', 'TEXT');
ensureColumn('users', 'phone', 'TEXT');
ensureColumn('tasks', 'parent_task_id', 'TEXT');
ensureColumn('tasks', 'project', 'TEXT');
ensureColumn('tasks', 'phase', 'TEXT');
ensureColumn('task_assignees', 'deadline_reminder_sent_at', 'TEXT');
ensureColumn('task_assignees', 'deadline_overdue_notified_at', 'TEXT');

// Migration: backfill the new teams table from whatever team names are already in use on
// existing accounts, so upgrading never loses or hides a department that was already active —
// it just becomes a first-class, addable/listable thing instead of loose free text.
const existingTeams = db.prepare("SELECT DISTINCT team FROM users WHERE team IS NOT NULL AND team != ''").all();
existingTeams.forEach(r => {
  db.prepare('INSERT OR IGNORE INTO teams(name, created_at) VALUES(?, ?)').run(r.team, new Date().toISOString());
});

// Seed a default admin account on first run only, so there's always a way in.
const userCount = db.prepare('SELECT COUNT(*) c FROM users').get().c;
if (userCount === 0) {
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare(`INSERT INTO users(username,password_hash,role,name,team,is_team_lead,must_change_password,created_at)
              VALUES('admin',?,'admin','Mihir Sabadra',NULL,1,1,?)`).run(hash, new Date().toISOString());
  console.log('First run: created default account admin / admin123 — you will be asked to set a real password on first login.');
} else {
  // One-time, narrow rename for an already-running server: only touches the admin account if
  // it's still sitting at the literal generic default name "Admin" — never overwrites a name
  // that's already been customized, so this is safe to leave in permanently.
  const existingAdmin = db.prepare("SELECT username FROM users WHERE username='admin' AND name='Admin'").get();
  if (existingAdmin) {
    db.prepare("UPDATE users SET name='Mihir Sabadra' WHERE username='admin'").run();
    console.log('Renamed the default admin account\'s display name to "Mihir Sabadra".');
  }
}

// Auto-creates these specific team accounts the moment the server starts, if they don't already
// exist — no separate script to run. Temporary password MHR123456, with a MANDATORY password
// change required on first login — matching your production security policy: default/setup
// credentials are never treated as real production credentials. Safe on every restart:
// already-existing accounts are simply left alone (never reset back to the temporary password).
const AUTO_SEED_ACCOUNTS = [
  { name: 'Rohit Kamble', username: 'rohit.k', team: 'Estimation Department', designation: 'Estimate', teamLead: false },
  { name: 'Suraj Kathale', username: 'suraj_kathale', team: 'Estimation Department', designation: 'Estimate Head', teamLead: true },
  { name: 'Tanishq Mutha', username: 'tanishq.m', team: 'Purchase Department', designation: 'Purchase Lead', teamLead: true },
  { name: 'Tejas', username: 'tejas.l', team: 'Estimation Department', designation: '', teamLead: false },
  { name: 'Yuvraj Patil', username: 'yuvraj.p', team: 'Purchase Department', designation: 'Purchase', teamLead: false },
];
const autoSeedHash = bcrypt.hashSync('MHR123456', 10);
AUTO_SEED_ACCOUNTS.forEach(acc => {
  const exists = db.prepare('SELECT 1 FROM users WHERE username=?').get(acc.username);
  if (exists) return;
  db.prepare(`INSERT INTO users(username,password_hash,role,name,team,designation,is_team_lead,must_change_password,created_at)
              VALUES(?,?,?,?,?,?,?,1,?)`)
    .run(acc.username, autoSeedHash, 'member', acc.name, acc.team, acc.designation || null, acc.teamLead ? 1 : 0, new Date().toISOString());
  db.prepare('INSERT OR IGNORE INTO teams(name, created_at) VALUES(?, ?)').run(acc.team, new Date().toISOString());
  console.log(`Auto-created account: ${acc.username} (${acc.name}) — temporary password MHR123456, must be changed on first login.`);
});

function round2(n) { return Math.round(n * 100) / 100; }

module.exports = {
  // ---- users ----
  getUser(username) { return db.prepare('SELECT * FROM users WHERE username=?').get(username); },
  // ---- login security: simple lockout after repeated failed attempts ----
  recordFailedLogin(username) {
    const user = db.prepare('SELECT failed_login_count FROM users WHERE username=?').get(username);
    if (!user) return;
    const count = (user.failed_login_count || 0) + 1;
    // Lock for 15 minutes after 5 consecutive failed attempts — resets on a successful login.
    const lockedUntil = count >= 5 ? new Date(Date.now() + 3 * 60 * 1000).toISOString() : null;
    db.prepare('UPDATE users SET failed_login_count=?, locked_until=? WHERE username=?').run(count, lockedUntil, username);
  },
  clearFailedLogins(username) { db.prepare('UPDATE users SET failed_login_count=0, locked_until=NULL WHERE username=?').run(username); },
  bumpTokenVersion(username) { db.prepare('UPDATE users SET token_version=COALESCE(token_version,0)+1 WHERE username=?').run(username); },
  listUsers() { return db.prepare('SELECT username,role,name,email,phone,team,designation,is_team_lead,visible_departments,must_change_password,created_at FROM users ORDER BY name').all(); },
  updateOwnPhone(username, phone) { db.prepare('UPDATE users SET phone=? WHERE username=?').run(phone || null, username); },
  setVisibleDepartments(username, departmentsCsv) { db.prepare('UPDATE users SET visible_departments=? WHERE username=?').run(departmentsCsv || null, username); },
  createUser({ username, password_hash, role, name, team, designation, must_change_password }) {
    db.prepare(`INSERT INTO users(username,password_hash,role,name,team,designation,must_change_password,created_at)
                VALUES(?,?,?,?,?,?,?,?)`)
      .run(username, password_hash, role, name, team || null, designation || null, must_change_password ? 1 : 0, new Date().toISOString());
    if (team) this.addTeam(team);
  },
  deleteUser(username) { db.prepare('DELETE FROM users WHERE username=?').run(username); },
  setUserTeam(username, team) {
    db.prepare('UPDATE users SET team=? WHERE username=?').run(team || null, username);
    if (team) this.addTeam(team);
  },
  setUserTeamLead(username, isLead) { db.prepare('UPDATE users SET is_team_lead=? WHERE username=?').run(isLead ? 1 : 0, username); },
  updateOwnName(username, name) { db.prepare('UPDATE users SET name=? WHERE username=?').run(name, username); },
  updateOwnEmail(username, email) { db.prepare('UPDATE users SET email=? WHERE username=?').run(email, username); },
  // ---- password-reset OTP (email-based recovery) ----
  setPasswordResetOtp(username, otpHash, expiresAt) {
    db.prepare('UPDATE users SET password_reset_otp_hash=?, password_reset_otp_expires=? WHERE username=?').run(otpHash, expiresAt, username);
  },
  clearPasswordResetOtp(username) {
    db.prepare('UPDATE users SET password_reset_otp_hash=NULL, password_reset_otp_expires=NULL WHERE username=?').run(username);
  },
  updateUserDisplayName(username, name) { db.prepare('UPDATE users SET name=? WHERE username=?').run(name, username); },
  updateUserDesignation(username, designation) { db.prepare('UPDATE users SET designation=? WHERE username=?').run(designation || null, username); },
  setPassword(username, hash) {
    db.prepare('UPDATE users SET password_hash=?, must_change_password=0, token_version=COALESCE(token_version,0)+1 WHERE username=?').run(hash, username);
  },
  forcePasswordReset(username, hash) {
    db.prepare('UPDATE users SET password_hash=?, must_change_password=1, token_version=COALESCE(token_version,0)+1 WHERE username=?').run(hash, username);
  },
  // Renaming the login username itself touches every table that stores it as a functional
  // reference — done as one atomic transaction so it either fully applies or not at all.
  // Deliberately does NOT touch task_assignees.completed_by / task_replies.by_name /
  // tasks.created_by / tasks.closed_by — those store the person's NAME as a point-in-time
  // label ("who did this, as they were called then"), not a lookup key, same as how an audit
  // trail stays historically accurate rather than being rewritten after the fact.
  renameUsername: db.transaction((oldUsername, newUsername) => {
    db.prepare('UPDATE tasks SET created_by_username=? WHERE created_by_username=?').run(newUsername, oldUsername);
    db.prepare('UPDATE task_assignees SET username=? WHERE username=?').run(newUsername, oldUsername);
    db.prepare('UPDATE task_replies SET by_username=? WHERE by_username=?').run(newUsername, oldUsername);
    db.prepare('UPDATE notifications SET username=? WHERE username=?').run(newUsername, oldUsername);
    db.prepare('UPDATE users SET username=? WHERE username=?').run(newUsername, oldUsername);
  }),

  // ---- sessions ----
  createSession({ id, username, device, ip }) {
    const now = new Date().toISOString();
    db.prepare('INSERT INTO sessions(id,username,device,ip,created_at,last_seen) VALUES(?,?,?,?,?,?)').run(id, username, device || null, ip || null, now, now);
  },
  getSession(id) { return db.prepare('SELECT * FROM sessions WHERE id=?').get(id); },
  touchSession(id) { db.prepare('UPDATE sessions SET last_seen=? WHERE id=?').run(new Date().toISOString(), id); },
  revokeSession(id) { db.prepare('UPDATE sessions SET revoked=1 WHERE id=?').run(id); },

  // ---- tasks ----
  createTask({ id, title, description, priority, deadline, created_by, created_by_username, depends_on_task_id, attachment, attachment_name, is_drawing_request, parent_task_id, project, phase }) {
    if (project) this.addProject(project);
    if (phase) this.addPhase(phase);
    db.prepare(`INSERT INTO tasks(id,title,description,priority,deadline,status,created_by,created_by_username,depends_on_task_id,attachment,attachment_name,is_drawing_request,parent_task_id,project,phase,created_at)
                VALUES(?,?,?,?,?,'open',?,?,?,?,?,?,?,?,?,?)`)
      .run(id, title, description || null, priority, deadline || null, created_by, created_by_username, depends_on_task_id || null, attachment || null, attachment_name || null, is_drawing_request ? 1 : 0, parent_task_id || null, project || null, phase || null, new Date().toISOString());
  },
  getTask(id) { return db.prepare('SELECT * FROM tasks WHERE id=?').get(id); },
  // A generic transaction wrapper — exposes better-sqlite3's synchronous transaction capability
  // so multi-step writes (e.g. creating a task, its assignees, and their notifications together)
  // either all commit or all roll back, rather than risking a partial write if something throws
  // partway through. better-sqlite3 is fully synchronous, so this works cleanly with no async
  // complexity — the whole function body runs as one atomic unit.
  runInTransaction(fn) { return db.transaction(fn)(); },
  // ---- subtasks ----
  // A subtask is a full, ordinary task — same assignees, deadlines, reminders, escalations,
  // notifications as any other task — just with parent_task_id pointing at its parent. This is
  // deliberate: it means every existing notification/reminder/escalation mechanism already
  // applies to subtasks automatically, with no separate code path to build or maintain.
  listSubtasks(parentTaskId) { return db.prepare('SELECT * FROM tasks WHERE parent_task_id=? ORDER BY created_at ASC').all(parentTaskId); },
  listOpenSubtasks(parentTaskId) { return db.prepare("SELECT * FROM tasks WHERE parent_task_id=? AND status='open'").all(parentTaskId); },
  addTaskAssignee(taskId, username, team, stage, isReleased, individualDeadline) {
    db.prepare('INSERT OR IGNORE INTO task_assignees(task_id,username,team,stage,is_released,escalation_baseline_at,individual_deadline) VALUES(?,?,?,?,?,?,?)')
      .run(taskId, username, team || null, stage || 1, (isReleased === false ? 0 : 1), new Date().toISOString(), individualDeadline || null);
  },
  setIndividualDeadline(taskId, username, deadline) {
    db.prepare('UPDATE task_assignees SET individual_deadline=? WHERE task_id=? AND username=?').run(deadline || null, taskId, username);
  },
  // ---- staged release ----
  // A task's tagged people can be split into ordered stages (Stage 1, Stage 2, ...); everyone
  // in Stage 1 starts released, everyone else starts on hold. A later stage only becomes
  // releasable once EVERY person in the stage before it is approved — not just one of them.
  isStageFullyApproved(taskId, stage) {
    const rows = db.prepare('SELECT decision, completed_at FROM task_assignees WHERE task_id=? AND stage=?').all(taskId, stage);
    if (rows.length === 0) return false;
    return rows.every(r => r.decision === 'approve' && r.completed_at);
  },
  hasStage(taskId, stage) {
    return db.prepare('SELECT COUNT(*) c FROM task_assignees WHERE task_id=? AND stage=?').get(taskId, stage).c > 0;
  },
  isStageReleased(taskId, stage) {
    const rows = db.prepare('SELECT is_released FROM task_assignees WHERE task_id=? AND stage=?').all(taskId, stage);
    return rows.length > 0 && rows.every(r => r.is_released);
  },
  // A lightweight version counter, bumped on every meaningful state transition. There's no
  // task-editing form in this app (title/description/priority/deadline are fixed at creation),
  // so the classic "stale form overwrite" race this normally guards against doesn't fully apply
  // here — the synchronous SQLite driver plus Node's single-threaded event loop already prevent
  // a check-then-write race within these non-async route handlers. This is cheap defense-in-depth
  // regardless, and gives every task a version number a client could check against if editable
  // fields are ever added later.
  bumpTaskVersion(id) { db.prepare('UPDATE tasks SET version = COALESCE(version, 1) + 1 WHERE id=?').run(id); },
  releaseStage(taskId, stage, releasedByName) {
    db.prepare('UPDATE task_assignees SET is_released=1, released_at=?, released_by=?, escalation_baseline_at=? WHERE task_id=? AND stage=?')
      .run(new Date().toISOString(), releasedByName || null, new Date().toISOString(), taskId, stage);
    this.bumpTaskVersion(taskId);
  },
  setAutoReleaseStages(taskId, on) { db.prepare('UPDATE tasks SET auto_release_stages=? WHERE id=?').run(on ? 1 : 0, taskId); },
  // Only removable before they've contributed anything (no submission, no approval) — once
  // someone has submitted or been approved, that's real recorded work and history, and removing
  // the row would silently erase it from that person's completion stats. Mistagging someone
  // who hasn't acted yet is fully undoable; mistagging someone who already did the work is not
  // "undone" by removing them, it's erasing their credit for it.
  removeTaskAssignee(taskId, username) { db.prepare('DELETE FROM task_assignees WHERE task_id=? AND username=?').run(taskId, username); },
  listAssignees(taskId) { return db.prepare('SELECT * FROM task_assignees WHERE task_id=?').all(taskId); },
  // Assignee submits their own part as ready — this is a REQUEST for approval, not completion.
  // Only the task creator (or Admin) marking it approved via markAssigneeDone actually counts
  // it as done — see the whole-approval-authority-is-the-creator's design. A required note
  // describing what was actually done gives the creator something concrete to check against,
  // rather than a bare "trust me" click — this is the real anti-gaming measure, since code has
  // no way to verify physical or creative work is genuinely finished; only a human reviewing it
  // (with something specific to review) can.
  markAssigneeSubmitted(taskId, username, note) {
    db.prepare('UPDATE task_assignees SET submitted_at=?, submission_note=? WHERE task_id=? AND username=?').run(new Date().toISOString(), note || null, taskId, username);
    this.bumpTaskVersion(taskId);
  },
  // Rejecting a submission resets it back to "not submitted" so the assignee can redo the work
  // and submit again — it does NOT set completed_at/decision, since a rejected part is not done.
  resetAssigneeSubmission(taskId, username) {
    db.prepare('UPDATE task_assignees SET submitted_at=NULL, submission_note=NULL WHERE task_id=? AND username=?').run(taskId, username);
    this.bumpTaskVersion(taskId);
  },
  markAssigneeDone(taskId, username, byName, decision) {
    db.prepare('UPDATE task_assignees SET completed_at=?, completed_by=?, decision=? WHERE task_id=? AND username=?')
      .run(new Date().toISOString(), byName, decision || 'done', taskId, username);
    this.bumpTaskVersion(taskId);
  },
  reopenAssignee(taskId, username) {
    db.prepare('UPDATE task_assignees SET completed_at=NULL, completed_by=NULL, decision=NULL, submitted_at=NULL WHERE task_id=? AND username=?').run(taskId, username);
  },
  closeTask(id, closedByName) {
    db.prepare("UPDATE tasks SET status='closed', closed_at=?, closed_by=? WHERE id=?").run(new Date().toISOString(), closedByName, id);
    this.bumpTaskVersion(id);
    // Once a task is genuinely done, its reminders/assignment/submission notifications are no
    // longer relevant to anyone — they'd just be stale clutter sitting in people's notification
    // lists forever. The task itself, its full activity history, and the audit log are
    // untouched; this only clears the transient notification bell entries about it.
    this.deleteNotificationsForTask(id);
  },
  // Distinct from closing — a cancelled task was abandoned or created by mistake, not
  // completed. Keeping it separate from "closed" matters for two reasons: (1) the activity
  // history and reports should never make abandoned work look like finished work, and (2) a
  // cancelled task blocking a dependent task should release it, since a cancelled prerequisite
  // will never close on its own.
  cancelTask(id, cancelledByName, reason) {
    db.prepare("UPDATE tasks SET status='cancelled', cancelled_at=?, cancelled_by=?, cancel_reason=? WHERE id=?").run(new Date().toISOString(), cancelledByName, reason || null, id);
    this.bumpTaskVersion(id);
  },
  markAsDrawingRequest(id) { db.prepare('UPDATE tasks SET is_drawing_request=1 WHERE id=?').run(id); },
  reopenTask(id) { db.prepare("UPDATE tasks SET status='open', closed_at=NULL, closed_by=NULL, cancelled_at=NULL, cancelled_by=NULL, cancel_reason=NULL WHERE id=?").run(id); this.bumpTaskVersion(id); },
  isTaskBlocked(id) {
    const t = db.prepare('SELECT depends_on_task_id FROM tasks WHERE id=?').get(id);
    if (!t || !t.depends_on_task_id) return false;
    const dep = db.prepare('SELECT status FROM tasks WHERE id=?').get(t.depends_on_task_id);
    // Only an OPEN prerequisite blocks — a closed one satisfies the dependency, and a cancelled
    // one releases it too (a cancelled prerequisite will never close on its own, so treating it
    // as still-blocking would leave the dependent task stuck forever).
    return dep ? dep.status === 'open' : false;
  },
  listTasksForUser(username) {
    return db.prepare(`
      SELECT DISTINCT t.* FROM tasks t
      JOIN task_assignees ta ON ta.task_id = t.id
      WHERE ta.username = ? OR t.created_by_username = ?
      ORDER BY t.created_at DESC
    `).all(username, username);
  },
  // A defensive hard cap, not full pagination (a genuine follow-up item, not done this pass —
  // see PRODUCTION_AUDIT.md P1-3) — but this alone prevents literal unbounded memory growth as
  // task history accumulates over years, which the previous version had no protection against
  // at all. 5000 is far above any realistic near-term task count for this company's scale.
  listAllTasks() { return db.prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT 5000').all(); },
  addChecklistItem(taskId, text, sortOrder) {
    db.prepare('INSERT INTO task_checklist_items(task_id,text,is_checked,sort_order,created_at) VALUES(?,?,0,?,?)').run(taskId, text, sortOrder || 0, new Date().toISOString());
  },
  toggleChecklistItem(id, checked) { db.prepare('UPDATE task_checklist_items SET is_checked=? WHERE id=?').run(checked ? 1 : 0, id); },
  deleteChecklistItem(id) { db.prepare('DELETE FROM task_checklist_items WHERE id=?').run(id); },
  listChecklistItems(taskId) { return db.prepare('SELECT * FROM task_checklist_items WHERE task_id=? ORDER BY sort_order, id').all(taskId); },
  getChecklistItem(id) { return db.prepare('SELECT * FROM task_checklist_items WHERE id=?').get(id); },
  addReply(taskId, { by_username, by_name, message, attachment, attachment_name }) {
    db.prepare('INSERT INTO task_replies(task_id,by_username,by_name,message,attachment,attachment_name,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(taskId, by_username, by_name, message || null, attachment || null, attachment_name || null, new Date().toISOString());
  },
  listReplies(taskId) { return db.prepare('SELECT * FROM task_replies WHERE task_id=? ORDER BY created_at').all(taskId); },

  // ---- follow-ups ----
  // A separate, lighter-weight tag from being a primary assignee: someone tagged for follow-up
  // gets notified on activity and can comment/attach files, but never shows up in the "everyone
  // must complete their part" close-out count, and never gets a close/approve button — only
  // whoever created the task (or Admin) can close it.
  addFollowup(taskId, username, taggedBy) {
    db.prepare('INSERT OR IGNORE INTO task_followups(task_id,username,tagged_by,created_at) VALUES(?,?,?,?)').run(taskId, username, taggedBy || null, new Date().toISOString());
  },
  listFollowups(taskId) { return db.prepare('SELECT * FROM task_followups WHERE task_id=?').all(taskId); },

  // Full task detail: assignees, checklist, replies attached — one call gets everything the UI needs.
  getTaskFull(id) {
    const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    if (!t) return null;
    return {
      ...t,
      blocked: this.isTaskBlocked(id),
      assignees: db.prepare('SELECT * FROM task_assignees WHERE task_id=?').all(id),
      followups: db.prepare('SELECT * FROM task_followups WHERE task_id=?').all(id),
      checklist: db.prepare('SELECT * FROM task_checklist_items WHERE task_id=? ORDER BY sort_order, id').all(id),
      replies: db.prepare('SELECT * FROM task_replies WHERE task_id=? ORDER BY created_at').all(id),
      subtasks: db.prepare('SELECT id,title,status,priority,deadline FROM tasks WHERE parent_task_id=? ORDER BY created_at ASC').all(id),
    };
  },
  // Same shape as getTaskFull, but with every attachment's actual data stripped out (replaced by
  // a has_attachment flag) — this is what every LIST endpoint should use. A task's own
  // attachment and every reply's attachment can each be up to ~100MB of base64 text; embedding
  // that in full for every task, every time the task list is fetched (which happens after every
  // action, and every 30 seconds in the background), was shipping and re-parsing a potentially
  // huge payload constantly even though almost none of it was ever looked at. Real attachment
  // bytes are now only sent by the dedicated per-attachment endpoints below, on demand.
  getTaskFullLight(id) {
    const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    if (!t) return null;
    const hasAttachment = !!t.attachment;
    delete t.attachment;
    const replies = db.prepare('SELECT * FROM task_replies WHERE task_id=? ORDER BY created_at').all(id).map(r => {
      const has = !!r.attachment;
      delete r.attachment;
      return { ...r, has_attachment: has };
    });
    return {
      ...t,
      has_attachment: hasAttachment,
      blocked: this.isTaskBlocked(id),
      assignees: db.prepare('SELECT * FROM task_assignees WHERE task_id=?').all(id),
      followups: db.prepare('SELECT * FROM task_followups WHERE task_id=?').all(id),
      checklist: db.prepare('SELECT * FROM task_checklist_items WHERE task_id=? ORDER BY sort_order, id').all(id),
      replies,
      subtasks: db.prepare('SELECT id,title,status,priority,deadline FROM tasks WHERE parent_task_id=? ORDER BY created_at ASC').all(id),
      subtaskCount: db.prepare('SELECT COUNT(*) c FROM tasks WHERE parent_task_id=?').get(id).c,
      openSubtaskCount: db.prepare("SELECT COUNT(*) c FROM tasks WHERE parent_task_id=? AND status='open'").get(id).c,
    };
  },
  // For the dedicated on-demand attachment endpoints — fetch just one attachment's bytes.
  getTaskAttachment(id) { return db.prepare('SELECT attachment, attachment_name FROM tasks WHERE id=?').get(id); },
  getReplyAttachment(replyId) { return db.prepare('SELECT attachment, attachment_name, task_id FROM task_replies WHERE id=?').get(replyId); },

  // ---- escalating reminders ----
  markTaskAssigneeReminded(taskId, username) {
    db.prepare('UPDATE task_assignees SET last_reminded_at=? WHERE task_id=? AND username=?').run(new Date().toISOString(), taskId, username);
  },
  listIncompleteAssigneesForOpenTasks() {
    return db.prepare(`
      SELECT ta.task_id, ta.username, ta.last_reminded_at, ta.is_released, t.title, t.created_at
      FROM task_assignees ta JOIN tasks t ON t.id = ta.task_id
      WHERE t.status = 'open' AND ta.completed_at IS NULL
    `).all();
  },
  listIncompleteAssigneesForEscalation() {
    return db.prepare(`
      SELECT ta.task_id, ta.username, ta.reminder_3day_sent_at, ta.warning_5day_sent_at, ta.warning_7day_sent_at, ta.warning_12day_sent_at, ta.is_released,
             COALESCE(ta.escalation_baseline_at, t.created_at) as escalation_baseline_at,
             t.title, t.created_at, t.created_by, t.created_by_username
      FROM task_assignees ta JOIN tasks t ON t.id = ta.task_id
      WHERE t.status = 'open' AND ta.completed_at IS NULL
    `).all();
  },
  markEscalationStage(taskId, username, stage) {
    const col = stage === 3 ? 'reminder_3day_sent_at' : (stage === 5 ? 'warning_5day_sent_at' : (stage === 7 ? 'warning_7day_sent_at' : 'warning_12day_sent_at'));
    db.prepare(`UPDATE task_assignees SET ${col}=? WHERE task_id=? AND username=?`).run(new Date().toISOString(), taskId, username);
  },
  listAdminUsernames() { return db.prepare("SELECT username FROM users WHERE role='admin'").all().map(r => r.username); },
  listOutstandingTaskWarnings() {
    return db.prepare(`
      SELECT ta.username, ta.task_id, t.title, ta.warning_5day_sent_at, ta.warning_7day_sent_at, ta.warning_12day_sent_at
      FROM task_assignees ta JOIN tasks t ON t.id = ta.task_id
      WHERE t.status = 'open' AND ta.completed_at IS NULL
        AND (ta.warning_5day_sent_at IS NOT NULL OR ta.warning_7day_sent_at IS NOT NULL OR ta.warning_12day_sent_at IS NOT NULL)
    `).all();
  },
  // Any OPEN task that was waiting on this one — used the moment a task closes, to release
  // whoever was blocked on it with a clean slate rather than a clock that silently kept running
  // the whole time they couldn't act.
  listDependentTasks(taskId) {
    return db.prepare("SELECT id, title FROM tasks WHERE depends_on_task_id = ? AND status = 'open'").all(taskId);
  },
  // Wipes the reminder/escalation timestamps for every assignee of a task, so a task that was
  // blocked for, say, 10 days doesn't immediately fire a 7-day warning the moment it's freed —
  // punishing someone for a wait that was never theirs. Their clock starts fresh from release.
  resetEscalationTimersForTask(taskId) {
    db.prepare(`UPDATE task_assignees SET last_reminded_at=NULL, reminder_3day_sent_at=NULL, warning_5day_sent_at=NULL, warning_7day_sent_at=NULL, warning_12day_sent_at=NULL, escalation_baseline_at=? WHERE task_id=?`).run(new Date().toISOString(), taskId);
  },

  // ---- deadline-based reminders (distinct from creation-age escalation) ----
  // These count DOWN to a future deadline rather than up from creation date — "due soon" and
  // "deadline just passed," the way a calendar app reminds you before an event starts.
  listOpenTasksWithDeadlines() {
    return db.prepare(`SELECT id, title, deadline, deadline_reminder_sent, deadline_overdue_notified, created_by_username
      FROM tasks WHERE status='open' AND deadline IS NOT NULL`).all();
  },
  markDeadlineReminderSent(id) { db.prepare('UPDATE tasks SET deadline_reminder_sent=1 WHERE id=?').run(id); },
  markDeadlineOverdueNotified(id) { db.prepare('UPDATE tasks SET deadline_overdue_notified=1 WHERE id=?').run(id); },
  // Per-assignee deadline check — each person's OWN effective deadline (their individual one if
  // set, else the task's overall deadline) drives their own "due soon"/"passed" notifications,
  // independent of the task-level creator notice above.
  listIncompleteAssigneesForDeadlineCheck() {
    return db.prepare(`
      SELECT ta.task_id, ta.username, ta.individual_deadline, ta.deadline_reminder_sent_at, ta.deadline_overdue_notified_at, ta.is_released,
             t.title, t.deadline as task_deadline
      FROM task_assignees ta JOIN tasks t ON t.id = ta.task_id
      WHERE t.status='open' AND ta.completed_at IS NULL
    `).all();
  },
  markAssigneeDeadlineReminderSent(taskId, username) { db.prepare('UPDATE task_assignees SET deadline_reminder_sent_at=? WHERE task_id=? AND username=?').run(new Date().toISOString(), taskId, username); },
  markAssigneeDeadlineOverdueNotified(taskId, username) { db.prepare('UPDATE task_assignees SET deadline_overdue_notified_at=? WHERE task_id=? AND username=?').run(new Date().toISOString(), taskId, username); },
  // ---- per-task reports (Admin) ----
  listReportableTasks() {
    return db.prepare("SELECT id, title, status, priority, deadline, created_by, closed_at, cancelled_at, report_generated_at FROM tasks WHERE status IN ('closed','cancelled') ORDER BY COALESCE(closed_at, cancelled_at) DESC").all();
  },
  getCachedReport(id) {
    const row = db.prepare('SELECT report_data, report_generated_at FROM tasks WHERE id=?').get(id);
    if (!row || !row.report_data) return null;
    return { ...JSON.parse(row.report_data), generatedAt: row.report_generated_at };
  },
  saveReport(id, reportObj) {
    db.prepare('UPDATE tasks SET report_data=?, report_generated_at=? WHERE id=?').run(JSON.stringify(reportObj), new Date().toISOString(), id);
  },

  // ---- peak hours ----
  // Raw timestamps only — every timestamp here is stored as a UTC ISO string
  // (new Date().toISOString()). Bucketing by hour-of-day happens in server.js using
  // getISTHour(), which converts explicitly to India Standard Time (UTC+5:30) regardless of
  // the server's own system timezone — this used to rely on the server's local clock matching
  // the company's timezone, which broke once this app moved to a cloud host defaulting to UTC.
  getAllActivityTimestamps() {
    return {
      taskCreated: db.prepare('SELECT created_at, created_by_username as username FROM tasks').all(),
      replies: db.prepare('SELECT created_at, by_username as username FROM task_replies').all(),
      submissions: db.prepare('SELECT submitted_at as created_at, username FROM task_assignees WHERE submitted_at IS NOT NULL').all(),
      approvals: db.prepare("SELECT completed_at as created_at, username FROM task_assignees WHERE completed_at IS NOT NULL").all(),
      logins: db.prepare('SELECT created_at, username FROM sessions').all(),
    };
  },

  // ---- performance / completion stats ----
  // Every approved (creator-signed-off) piece of work, with who and WHEN THEY ACTUALLY
  // SUBMITTED IT — deliberately not completed_at (the approval timestamp). An employee's rating
  // must reflect when they did the work, not how quickly the creator got around to approving
  // it; bucketing by approval date would unfairly penalize someone whose work sat waiting for
  // review, and reward someone whose creator happened to approve fast.
  getApprovedCompletions() {
    return db.prepare("SELECT username, submitted_at FROM task_assignees WHERE decision='approve' AND submitted_at IS NOT NULL").all();
  },
  // Every OPEN task this account is still involved in — as a tagged assignee, or as the
  // creator. Deleting an account with open involvement would leave that task permanently
  // waiting on someone who no longer exists (an assignee who can never submit/approve again,
  // or a creator who was the only one allowed to approve/close it) — so account removal checks
  // this first and refuses if the list isn't empty.
  getOpenTaskInvolvement(username) {
    const asAssignee = db.prepare(`
      SELECT DISTINCT t.id, t.title FROM tasks t
      JOIN task_assignees ta ON ta.task_id = t.id
      WHERE ta.username = ? AND t.status = 'open'
    `).all(username);
    const asCreator = db.prepare(`SELECT id, title FROM tasks WHERE created_by_username = ? AND status = 'open'`).all(username);
    const map = new Map();
    [...asAssignee, ...asCreator].forEach(t => map.set(t.id, t.title));
    return Array.from(map.values());
  },

  // ---- teams / departments ----
  // A first-class list of department names — separate from the free-text `team` column still
  // stored on each user, so existing behavior (any string works) never breaks, but Admin and
  // team leads now get a real, addable, listable set of departments to pick from and grow.
  listTeams() { return db.prepare('SELECT name FROM teams ORDER BY name').all().map(r => r.name); },
  addTeam(name) {
    const clean = String(name || '').trim();
    if (!clean) return;
    db.prepare('INSERT OR IGNORE INTO teams(name, created_at) VALUES(?, ?)').run(clean, new Date().toISOString());
  },
  // Removes a department from the picker list, and un-assigns anyone who was in it (their
  // account stays exactly as it was otherwise — just no longer tied to a team that no longer
  // exists). Never deletes any accounts.
  removeTeam(name) {
    db.prepare('UPDATE users SET team=NULL WHERE team=?').run(name);
    db.prepare('DELETE FROM teams WHERE name=?').run(name);
  },

  // ---- projects & drawing library ----
  // A project is just a name — same lightweight pattern as teams/departments, not a full
  // project-management entity. It exists so drawings (and anything else project-scoped later)
  // have a consistent, addable, listable set of project names to file against.
  listProjects() { return db.prepare('SELECT name FROM projects ORDER BY name').all().map(r => r.name); },
  addProject(name) {
    const clean = String(name || '').trim();
    if (!clean) return;
    db.prepare('INSERT OR IGNORE INTO projects(name, created_at) VALUES(?, ?)').run(clean, new Date().toISOString());
  },
  // Sections (Playing Area, Club House, Tower A, etc.) are shared ACROSS projects, same as
  // teams/departments — a builder reuses the same section vocabulary from project to project,
  // so this is one global growing list rather than a separate list per project.
  listSections() { return db.prepare('SELECT name FROM drawing_sections ORDER BY name').all().map(r => r.name); },
  addSection(name) {
    const clean = String(name || '').trim();
    if (!clean) return;
    db.prepare('INSERT OR IGNORE INTO drawing_sections(name, created_at) VALUES(?, ?)').run(clean, new Date().toISOString());
  },
  // ---- task phases ----
  // Same lightweight, reusable-picklist pattern as drawing sections: a shared, growing list of
  // phase names (e.g. "Foundation", "Structure", "Finishing") usable across every project, not a
  // separate custom list per project — simpler to maintain and consistent with how sections
  // already work for drawings.
  listPhases() { return db.prepare('SELECT name FROM task_phases ORDER BY name').all().map(r => r.name); },
  addPhase(name) {
    const clean = String(name || '').trim();
    if (!clean) return;
    db.prepare('INSERT OR IGNORE INTO task_phases(name, created_at) VALUES(?, ?)').run(clean, new Date().toISOString());
  },
  addDrawing({ project, section, title, file_name, file_data, uploaded_by_username, uploaded_by_name }) {
    this.addProject(project);
    if (section) this.addSection(section);
    const info = db.prepare(`INSERT INTO drawings(project,section,title,file_name,file_data,uploaded_by_username,uploaded_by_name,created_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(project, section || null, title || null, file_name || null, file_data || null, uploaded_by_username, uploaded_by_name, new Date().toISOString());
    return info.lastInsertRowid;
  },
  // Lightweight listing — no file_data — same reasoning as task attachments: a drawing can be
  // up to ~100MB, so browsing a project's drawing list should never pull all those bytes down
  // just to show a list of filenames. Real bytes only come from getDrawingFile, on demand.
  // Ordered by section then newest-first within each section, so the frontend can group by
  // section without needing its own sort pass.
  listDrawingsForProject(project) {
    return db.prepare(`SELECT id, project, section, title, file_name, uploaded_by_username, uploaded_by_name, created_at,
      (file_data IS NOT NULL) as has_file FROM drawings WHERE project=? ORDER BY COALESCE(section,'zzz'), created_at DESC`).all(project);
  },
  getDrawingFile(id) { return db.prepare('SELECT file_data, file_name FROM drawings WHERE id=?').get(id); },
  getDrawingMeta(id) { return db.prepare('SELECT id, project, uploaded_by_username FROM drawings WHERE id=?').get(id); },
  deleteDrawing(id) { db.prepare('DELETE FROM drawings WHERE id=?').run(id); },

  // ---- Send for Approval (document approval requests) ----
  // Distinct from a regular task's submit-then-creator-approves flow: here the tagged people ARE
  // the approvers — they directly approve or reject the document itself, no "submit work" step.
  createApprovalRequest({ id, title, description, file_data, file_name, created_by_username, created_by_name, reviewers }) {
    db.prepare(`INSERT INTO approval_requests(id,title,description,file_data,file_name,created_by_username,created_by_name,status,created_at)
      VALUES(?,?,?,?,?,?,?,'pending',?)`).run(id, title, description || null, file_data || null, file_name || null, created_by_username, created_by_name, new Date().toISOString());
    reviewers.forEach(u => db.prepare('INSERT OR IGNORE INTO approval_reviewers(request_id,username) VALUES(?,?)').run(id, u));
    this.addApprovalHistory(id, created_by_username, created_by_name, `Sent "${file_name || title}" for approval`);
  },
  addApprovalHistory(requestId, actorUsername, actorName, eventText) {
    db.prepare('INSERT INTO approval_history(request_id,actor_username,actor_name,event_text,created_at) VALUES(?,?,?,?,?)')
      .run(requestId, actorUsername || null, actorName || null, eventText, new Date().toISOString());
  },
  getApprovalRequest(id) { return db.prepare('SELECT * FROM approval_requests WHERE id=?').get(id); },
  listReviewers(requestId) { return db.prepare('SELECT * FROM approval_reviewers WHERE request_id=?').all(requestId); },
  listApprovalHistory(requestId) { return db.prepare('SELECT * FROM approval_history WHERE request_id=? ORDER BY created_at').all(requestId); },
  // Lightweight full-detail fetch — same reasoning as tasks: the document itself can be sizeable,
  // so list views never carry it; only the dedicated attachment endpoint does.
  getApprovalRequestFullLight(id) {
    const r = db.prepare('SELECT * FROM approval_requests WHERE id=?').get(id);
    if (!r) return null;
    const hasFile = !!r.file_data;
    delete r.file_data;
    return { ...r, has_file: hasFile, reviewers: this.listReviewers(id), history: this.listApprovalHistory(id) };
  },
  getApprovalFile(id) { return db.prepare('SELECT file_data, file_name FROM approval_requests WHERE id=?').get(id); },
  listApprovalRequestsForUser(username) {
    return db.prepare(`
      SELECT DISTINCT ar.id FROM approval_requests ar
      LEFT JOIN approval_reviewers rv ON rv.request_id = ar.id
      WHERE ar.created_by_username = ? OR rv.username = ?
      ORDER BY ar.created_at DESC
    `).all(username, username).map(r => this.getApprovalRequestFullLight(r.id));
  },
  listAllApprovalRequests() {
    return db.prepare('SELECT id FROM approval_requests ORDER BY created_at DESC').all().map(r => this.getApprovalRequestFullLight(r.id));
  },
  recordReviewerDecision(requestId, username, decision, reason) {
    db.prepare('UPDATE approval_reviewers SET decision=?, decided_at=?, reason=? WHERE request_id=? AND username=?')
      .run(decision, new Date().toISOString(), reason || null, requestId, username);
  },
  resetReviewersForRevision(requestId) {
    db.prepare('UPDATE approval_reviewers SET decision=NULL, decided_at=NULL, reason=NULL WHERE request_id=?').run(requestId);
  },
  setApprovalRequestStatus(requestId, status, resolvedAt) {
    db.prepare('UPDATE approval_requests SET status=?, resolved_at=? WHERE id=?').run(status, resolvedAt || null, requestId);
  },
  reviseApprovalRequest(requestId, fileData, fileName) {
    db.prepare('UPDATE approval_requests SET file_data=?, file_name=?, status=?, resolved_at=NULL WHERE id=?').run(fileData, fileName, 'pending', requestId);
  },
  // Objective per-person approval-decision counts (week/month/year/all-time), same
  // admin-only, plain-count philosophy as the task Performance report — no scoring, just
  // numbers, dated to when each person actually made their own decision (nobody else's speed
  // affects a reviewer's own timestamp here, unlike task approval-lag).
  getApprovalDecisionStats() {
    return db.prepare("SELECT username, decided_at FROM approval_reviewers WHERE decision='approved' AND decided_at IS NOT NULL").all();
  },
  // Every individual decision anyone has actually made via the Approve/Reject button — who
  // decided, what request, who asked (the creator), what they decided, and exactly when. This is
  // the real detail behind the plain counts above: not just "3 approvals," but which 3, on what,
  // for whom, and whether any of them were actually rejections.
  listApprovalDecisionsDetailed() {
    return db.prepare(`
      SELECT ar.username as reviewer_username, ar.decision, ar.decided_at, ar.reason,
             req.id as request_id, req.title as request_title,
             req.created_by_username, req.created_by_name
      FROM approval_reviewers ar
      JOIN approval_requests req ON req.id = ar.request_id
      WHERE ar.decision IS NOT NULL AND ar.decided_at IS NOT NULL
      ORDER BY ar.decided_at DESC
    `).all();
  },
  // Raw (created_at, completed_at) pairs for approved work of a given priority — used to compute
  // a real historical average completion time for the deadline-risk check. Server code should
  // never touch raw SQL directly; this is the one proper entry point for that specific query.
  getApprovedTaskDurationsByPriority(priority) {
    return db.prepare(`
      SELECT t.created_at, ta.completed_at FROM tasks t
      JOIN task_assignees ta ON ta.task_id = t.id
      WHERE ta.decision='approve' AND ta.completed_at IS NOT NULL AND t.priority = ?
    `).all(priority);
  },
  // How many days between being released (or the task's creation, if never held) and actually
  // submitting — for one person's own personal dashboard. Only counts their own approved
  // submissions, so it reflects genuine completed responsiveness, not pending work.
  getMyResponseDurations(username) {
    const rows = db.prepare(`
      SELECT escalation_baseline_at, submitted_at FROM task_assignees
      WHERE username=? AND decision='approve' AND submitted_at IS NOT NULL AND escalation_baseline_at IS NOT NULL
    `).all(username);
    return rows.map(r => (new Date(r.submitted_at) - new Date(r.escalation_baseline_at)) / 86400000).filter(d => d >= 0);
  },
  // Real, all-time warning counts per person — one per task where any 5/7/12-day escalation
  // flag ever fired for them (counted once per task even if multiple thresholds fired on it),
  // used for the HR roster overview. Genuinely different information from My Dashboard, which
  // has no concept of warnings at all.
  getWarningCountsByUser() {
    const rows = db.prepare(`
      SELECT username, COUNT(*) as c FROM task_assignees
      WHERE warning_5day_sent_at IS NOT NULL OR warning_7day_sent_at IS NOT NULL OR warning_12day_sent_at IS NOT NULL
      GROUP BY username
    `).all();
    const map = {};
    rows.forEach(r => { map[r.username] = r.c; });
    return map;
  },
  // Counts each person's currently PENDING work — tasks assigned to them, on an open (not yet
  // released-and-blocked) task, that they personally haven't completed their own part of yet.
  // This is deliberately a live count of right-now workload, not a historical escalation count
  // (that's what getWarningCountsByUser is for) — used to flag someone who's accumulating
  // pending tasks right now, regardless of whether any reminder has escalated yet.
  getPendingTaskCountsByUser() {
    const rows = db.prepare(`
      SELECT ta.username, COUNT(*) as c
      FROM task_assignees ta JOIN tasks t ON t.id = ta.task_id
      WHERE t.status = 'open' AND ta.completed_at IS NULL AND ta.is_released = 1
      GROUP BY ta.username
    `).all();
    const map = {};
    rows.forEach(r => { map[r.username] = r.c; });
    return map;
  },
  // ---- calendar-aligned period awards (Employee of the Quarter/Year) ----
  // Distinct from the trailing-90/365-day "quarter"/"year" figures used elsewhere in this app
  // (which are rolling windows, always relative to "now") — these are REAL calendar periods
  // (Jan-Mar, Apr-Jun, etc. / a full Jan-Dec year), computed once a period genuinely ends, and
  // stored permanently so a past winner is never recomputed differently later.
  getApprovedCompletionsInRange(startISO, endISO) {
    return db.prepare("SELECT username, submitted_at FROM task_assignees WHERE decision='approve' AND submitted_at >= ? AND submitted_at < ?").all(startISO, endISO);
  },
  getLastProcessedPeriod(periodType) {
    const row = db.prepare('SELECT last_processed_label FROM period_tracking WHERE period_type=?').get(periodType);
    return row ? row.last_processed_label : null;
  },
  setLastProcessedPeriod(periodType, label) {
    db.prepare('INSERT INTO period_tracking(period_type, last_processed_label) VALUES(?,?) ON CONFLICT(period_type) DO UPDATE SET last_processed_label=excluded.last_processed_label').run(periodType, label);
  },
  savePeriodAward({ period_type, period_label, rank, username, name, team, rating, completions }) {
    db.prepare(`INSERT INTO period_awards(period_type,period_label,rank,username,name,team,rating,completions,awarded_at)
                VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(period_type, period_label, rank, username, name, team || null, rating, completions, new Date().toISOString());
  },
  listPeriodAwards(periodType) {
    return db.prepare('SELECT * FROM period_awards WHERE period_type=? ORDER BY awarded_at DESC, rank ASC').all(periodType);
  },

  // ---- audit log ----
  // A permanent record of sensitive admin actions — account creation/removal, password resets
  // done TO someone else, team-lead changes, task cancellations, drawing removals. This was
  // part of the original plan for this app and got dropped when it was trimmed down; restoring
  // it here since the app now manages real accountability (approvals feeding into performance
  // stats, project drawings, account access) that's worth being able to trace after the fact.
  logAudit({ actor_username, actor_name, actor_team, action, details, ip_address, device }) {
    db.prepare('INSERT INTO audit_log(actor_username,actor_name,actor_team,action,details,ip_address,device,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(actor_username || null, actor_name || null, actor_team || null, action, details || null, ip_address || null, device || null, new Date().toISOString());
  },
  listAuditLog(limit) { return db.prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?').all(limit || 200); },

  // ---- notifications ----
  // A single, safe integration point for push/WhatsApp dispatch — rather than touching every one
  // of the dozens of createNotification call sites throughout server.js (high regression risk),
  // server.js registers ONE hook here at startup. Every notification that's ever created flows
  // through this one place, so push/WhatsApp dispatch never has to be wired up per-call-site.
  _notificationHook: null,
  setNotificationHook(fn) { this._notificationHook = fn; },
  createNotification({ username, type, message, task_id }) {
    db.prepare('INSERT INTO notifications(username,type,message,task_id,read,created_at) VALUES(?,?,?,?,0,?)')
      .run(username, type, message, task_id || null, new Date().toISOString());
    if (this._notificationHook) {
      try { this._notificationHook({ username, type, message, task_id }); }
      catch (e) { console.error('Notification hook (push/WhatsApp dispatch) failed:', e.message); }
    }
  },
  // ---- push notification subscriptions ----
  savePushSubscription(username, endpoint, p256dh, auth) {
    db.prepare('INSERT OR REPLACE INTO push_subscriptions(username,endpoint,p256dh,auth,created_at) VALUES(?,?,?,?,?)')
      .run(username, endpoint, p256dh, auth, new Date().toISOString());
  },
  removePushSubscription(endpoint) { db.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').run(endpoint); },
  listPushSubscriptionsForUser(username) { return db.prepare('SELECT * FROM push_subscriptions WHERE username=?').all(username); },
  // Called when a task closes — clears every notification tied to it, for every user, since a
  // completed task's reminders/assignment/submission notices are no longer relevant to anyone.
  deleteNotificationsForTask(taskId) {
    db.prepare('DELETE FROM notifications WHERE task_id=?').run(taskId);
  },
  listNotifications(username) { return db.prepare('SELECT * FROM notifications WHERE username=? ORDER BY created_at DESC LIMIT 100').all(username); },
  markNotificationRead(id, username) { db.prepare('UPDATE notifications SET read=1 WHERE id=? AND username=?').run(id, username); },
  markAllNotificationsRead(username) { db.prepare('UPDATE notifications SET read=1 WHERE username=?').run(username); },
  countUnreadNotifications(username) { return db.prepare('SELECT COUNT(*) c FROM notifications WHERE username=? AND read=0').get(username).c; },
};
