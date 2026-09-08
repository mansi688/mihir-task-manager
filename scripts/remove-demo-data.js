// Removes everything added by seed-demo-data.js — safe to run any time, only touches rows
// clearly marked as demo data.
// Run from the project folder:   node scripts/remove-demo-data.js
const path = require('path');
const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH || path.join(__dirname, '..', 'taskmanager.db'));

const demoTasks = db.prepare("SELECT id FROM tasks WHERE id LIKE 'TASK-DEMO-%'").all();
demoTasks.forEach(t => {
  db.prepare('DELETE FROM task_assignees WHERE task_id=?').run(t.id);
  db.prepare('DELETE FROM task_checklist_items WHERE task_id=?').run(t.id);
  db.prepare('DELETE FROM task_replies WHERE task_id=?').run(t.id);
  db.prepare('DELETE FROM task_followups WHERE task_id=?').run(t.id);
  db.prepare('DELETE FROM notifications WHERE task_id=?').run(t.id);
  db.prepare('DELETE FROM tasks WHERE id=?').run(t.id);
  console.log(`Removed demo task: ${t.id}`);
});

const demoApprovals = db.prepare("SELECT id FROM approval_requests WHERE id LIKE 'APR-DEMO-%'").all();
demoApprovals.forEach(a => {
  db.prepare('DELETE FROM approval_reviewers WHERE request_id=?').run(a.id);
  db.prepare('DELETE FROM approval_history WHERE request_id=?').run(a.id);
  db.prepare('DELETE FROM approval_requests WHERE id=?').run(a.id);
  console.log(`Removed demo approval request: ${a.id}`);
});

const demoDrawings = db.prepare("SELECT id FROM drawings WHERE title LIKE '%(DEMO)%' OR file_name LIKE 'demo-%'").all();
demoDrawings.forEach(d => {
  db.prepare('DELETE FROM drawings WHERE id=?').run(d.id);
  console.log(`Removed demo drawing #${d.id}`);
});

// The demo_designer helper account is only removed if it has no other real involvement left —
// safe even if you kept using it for something in the meantime.
const demoDesigner = db.prepare("SELECT username FROM users WHERE username='demo_designer'").get();
if (demoDesigner) {
  const stillInvolved = db.prepare(`
    SELECT COUNT(*) c FROM task_assignees WHERE username='demo_designer'
    UNION ALL SELECT COUNT(*) FROM drawings WHERE uploaded_by_username='demo_designer'
    UNION ALL SELECT COUNT(*) FROM approval_reviewers WHERE username='demo_designer'
  `).all().reduce((sum, r) => sum + r.c, 0);
  if (stillInvolved === 0) {
    db.prepare("DELETE FROM users WHERE username='demo_designer'").run();
    console.log('Removed demo helper account: demo_designer');
  } else {
    console.log('Kept demo_designer account — it\'s still referenced somewhere (safe to leave, or remove manually from Accounts).');
  }
}

if (demoTasks.length === 0 && demoDrawings.length === 0 && demoApprovals.length === 0) {
  console.log('No demo data found — nothing to remove.');
} else {
  console.log('\nDone. Demo project/section/team names (e.g. "Sunrise Residency") stay in your Projects/Teams lists — harmless to leave, or remove manually if you like.');
}
