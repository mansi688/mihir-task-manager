// Seeds a full, realistic demo dataset so you can see nearly every feature working with real
// data: overdue reminders/warnings already "sent" (3/5/7/12-day), a multi-level task with one
// level on hold, a slow-completing task and a fast one (for Performance/response-time numbers),
// a cancelled task, a blocked task, a pending Send-for-Approval request, and a Design Team
// member's drawings spread across multiple projects and sections.
//
// Run once from the project folder:   node scripts/seed-demo-data.js
// Clean it all back out any time:     node scripts/remove-demo-data.js
//
// Everything added is clearly labeled "(DEMO)" and/or uses a demo_ prefixed username, so
// remove-demo-data.js can find and remove exactly this and nothing else.
const path = require('path');
const bcrypt = require('bcrypt');
const Database = require('better-sqlite3');
const db = require('../backend/db');
const raw = new Database(process.env.DB_PATH || path.join(__dirname, '..', 'taskmanager.db'));

// Safety guard: this creates fake demo tasks/accounts and is meant for a fresh, empty, or
// already-demo database — never for initializing a real production database. If the roster
// already looks like a real company (more accounts than the handful of legacy placeholders),
// refuse to run unless explicitly overridden, so this can never be run by mistake against real
// employee data.
const existingUserCount = db.listUsers().length;
const REAL_DATA_THRESHOLD = 10;
if (existingUserCount > REAL_DATA_THRESHOLD && !process.argv.includes('--i-understand-this-adds-fake-demo-data')) {
  console.error(`Refusing to run: this database already has ${existingUserCount} accounts, which looks like real company data, not a fresh/demo setup.`);
  console.error('This script adds FAKE demo tasks, a fake pending approval, and demo drawings — never intended to run against a real production database.');
  console.error('If you genuinely want to add demo data anyway (e.g. a staging copy), re-run with: node scripts/seed-demo-data.js --i-understand-this-adds-fake-demo-data');
  process.exit(1);
}

const users = db.listUsers();
const admin = users.find(u => u.role === 'admin') || users[0];
const now = Date.now();
const daysAgo = n => new Date(now - n * 86400000).toISOString();
const daysFromNow = n => new Date(now + n * 86400000).toISOString().slice(0, 10);

function ensureDemoUser(username, name, team) {
  if (db.getUser(username)) return;
  db.createUser({ username, password_hash: bcrypt.hashSync('MHR123456', 10), role: 'member', name, team, must_change_password: false });
  console.log(`Created demo helper account: ${username} (${name}, ${team})`);
}
ensureDemoUser('demo_designer', 'Priya Deshmukh (DEMO)', 'Design Team');

// Pick real people if they exist (from add-team-accounts.js / db.js auto-seed), else fall back
// to the demo designer so this script works even on a totally fresh install with only admin.
const person = username => db.getUser(username) ? username : 'demo_designer';
const rohit = person('rohit.k');
const suraj = person('suraj_kathale');
const tanishq = person('tanishq.m');
const tejas = person('tejas.l');
const yuvraj = person('yuvraj.p');

function insertTask({ id, title, description, priority, deadline, dependsOn, createdAt, closedAt, cancelledAt, cancelReason }) {
  raw.prepare(`INSERT INTO tasks(id,title,description,priority,deadline,status,created_by,created_by_username,depends_on_task_id,is_drawing_request,created_at,closed_at,closed_by,cancelled_at,cancelled_by,cancel_reason)
    VALUES(?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?)`).run(
    id, title, description || null, priority, deadline, cancelledAt ? 'cancelled' : (closedAt ? 'closed' : 'open'),
    admin.name, admin.username, dependsOn || null, createdAt,
    closedAt || null, closedAt ? admin.name : null,
    cancelledAt || null, cancelledAt ? admin.name : null, cancelReason || null
  );
}
function insertAssignee({ taskId, username, stage, isReleased, baseline, submittedAt, submissionNote, approvedAt, escalations }) {
  raw.prepare(`INSERT INTO task_assignees(task_id,username,stage,is_released,escalation_baseline_at,submitted_at,submission_note,completed_at,completed_by,decision,reminder_3day_sent_at,warning_5day_sent_at,warning_7day_sent_at,warning_12day_sent_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    taskId, username, stage, isReleased ? 1 : 0, baseline,
    submittedAt || null, submissionNote || null,
    approvedAt || null, approvedAt ? admin.name : null, approvedAt ? 'approve' : null,
    (escalations || []).includes(3) ? daysAgo(12) : null,
    (escalations || []).includes(5) ? daysAgo(10) : null,
    (escalations || []).includes(7) ? daysAgo(8) : null,
    (escalations || []).includes(12) ? daysAgo(3) : null,
  );
}
function insertReply({ taskId, username, name, message, at }) {
  raw.prepare('INSERT INTO task_replies(task_id,by_username,by_name,message,created_at) VALUES(?,?,?,?,?)').run(taskId, username, name, message, at);
}
function insertNotification({ username, type, message, taskId, at }) {
  raw.prepare('INSERT INTO notifications(username,type,message,task_id,read,created_at) VALUES(?,?,?,?,0,?)').run(username, type, message, taskId || null, at);
}

// ---- 1. Overdue task with a full escalation history already "sent" (3/5/7/12-day) ----
insertTask({ id: 'TASK-DEMO-OVERDUE', title: 'Cement Delivery Confirmation — Section B (DEMO)', description: 'Confirm 450 bags delivered and stored dry before pour begins. This one is deliberately overdue to show the escalation system.', priority: 'high', deadline: daysAgo(10).slice(0, 10), createdAt: daysAgo(15) });
insertAssignee({ taskId: 'TASK-DEMO-OVERDUE', username: rohit, stage: 1, isReleased: true, baseline: daysAgo(15), escalations: [3, 5, 7, 12] });
insertNotification({ username: rohit, type: 'task_reminder_3day', message: 'Still open after 3 days — your part of "Cement Delivery Confirmation — Section B (DEMO)" needs finishing.', taskId: 'TASK-DEMO-OVERDUE', at: daysAgo(12) });
insertNotification({ username: admin.username, type: 'admin_late_flag', message: `${rohit} has not completed their part of "Cement Delivery Confirmation — Section B (DEMO)" in 5 days.`, taskId: 'TASK-DEMO-OVERDUE', at: daysAgo(10) });
insertNotification({ username: rohit, type: 'task_warning', message: 'Warning — "Cement Delivery Confirmation — Section B (DEMO)" has been open 7 days with your part not done.', taskId: 'TASK-DEMO-OVERDUE', at: daysAgo(8) });
insertNotification({ username: admin.username, type: 'admin_late_flag', message: `Still flagged — ${rohit} has not completed their part of "Cement Delivery Confirmation — Section B (DEMO)" in 7 days.`, taskId: 'TASK-DEMO-OVERDUE', at: daysAgo(8) });
insertNotification({ username: admin.username, type: 'admin_late_flag', message: `Still flagged — ${rohit} has not completed their part of "Cement Delivery Confirmation — Section B (DEMO)" in 12 days.`, taskId: 'TASK-DEMO-OVERDUE', at: daysAgo(3) });
insertNotification({ username: rohit, type: 'deadline_passed', message: '"Cement Delivery Confirmation — Section B (DEMO)" has passed its deadline and is still open.', taskId: 'TASK-DEMO-OVERDUE', at: daysAgo(10) });
insertNotification({ username: admin.username, type: 'deadline_passed', message: '"Cement Delivery Confirmation — Section B (DEMO)" has passed its deadline and is still open.', taskId: 'TASK-DEMO-OVERDUE', at: daysAgo(10) });
raw.prepare('UPDATE tasks SET deadline_overdue_notified=1 WHERE id=?').run('TASK-DEMO-OVERDUE');
console.log('1/8 Created: an overdue task with full 3/5/7/12-day escalation history already sent.');

// ---- 2. Multi-level task — Level 1 approved, Level 2 on hold ----
insertTask({ id: 'TASK-DEMO-LEVELS', title: 'Estimation Sign-off, Then Purchase Order (DEMO)', description: 'Estimation confirms quantities first (Level 1); Purchase can only proceed once that\'s approved (Level 2).', priority: 'medium', deadline: daysFromNow(3), createdAt: daysAgo(4) });
insertAssignee({ taskId: 'TASK-DEMO-LEVELS', username: suraj, stage: 1, isReleased: true, baseline: daysAgo(4), submittedAt: daysAgo(3), submissionNote: 'Quantities confirmed against the BOQ — 450 bags cement, 12 tons steel.', approvedAt: daysAgo(2) });
insertAssignee({ taskId: 'TASK-DEMO-LEVELS', username: tanishq, stage: 2, isReleased: false, baseline: daysAgo(2) });
insertReply({ taskId: 'TASK-DEMO-LEVELS', username: suraj, name: db.getUser(suraj).name, message: 'Confirmed with site — quantities match, no discrepancies.', at: daysAgo(3) });
insertReply({ taskId: 'TASK-DEMO-LEVELS', username: admin.username, name: admin.name, message: 'Approved — Purchase, go ahead whenever you\'re released.', at: daysAgo(2) });
console.log('2/8 Created: a 2-level task — Level 1 approved, Level 2 on hold (try the Release Level 2 button).');

// ---- 3. Long-running task (for meaningful response-time / Performance numbers) ----
insertTask({ id: 'TASK-DEMO-LONGRUN', title: 'Vendor Comparison — Steel Suppliers (DEMO)', description: 'Compare 3 vendor quotes and recommend one.', priority: 'medium', deadline: daysAgo(2).slice(0, 10), createdAt: daysAgo(12), closedAt: daysAgo(3) });
insertAssignee({ taskId: 'TASK-DEMO-LONGRUN', username: yuvraj, stage: 1, isReleased: true, baseline: daysAgo(12), submittedAt: daysAgo(4), submissionNote: 'Compared 3 quotes — recommending Vendor B for best price/quality balance.', approvedAt: daysAgo(3) });
insertReply({ taskId: 'TASK-DEMO-LONGRUN', username: yuvraj, name: db.getUser(yuvraj).name, message: 'Still waiting on the third vendor\'s quote.', at: daysAgo(8) });
insertReply({ taskId: 'TASK-DEMO-LONGRUN', username: yuvraj, name: db.getUser(yuvraj).name, message: 'All 3 quotes in, comparing now.', at: daysAgo(5) });
console.log('3/8 Created: a task that took 8 days to submit (real response-time data for Performance).');

// ---- 4. Fast-completed task (contrast for response-time distribution) ----
insertTask({ id: 'TASK-DEMO-FAST', title: 'Site Photo Upload — Weekly Progress (DEMO)', priority: 'low', deadline: daysAgo(1).slice(0, 10), createdAt: daysAgo(2), closedAt: daysAgo(1) });
insertAssignee({ taskId: 'TASK-DEMO-FAST', username: tejas, stage: 1, isReleased: true, baseline: daysAgo(2), submittedAt: daysAgo(2), submissionNote: 'Photos uploaded — all sections covered.', approvedAt: daysAgo(1) });
console.log('4/8 Created: a same-day-turnaround task for contrast.');

// ---- 5. Cancelled task ----
insertTask({ id: 'TASK-DEMO-CANCELLED', title: 'Duplicate Material Request (DEMO)', priority: 'low', deadline: daysFromNow(5), createdAt: daysAgo(3), cancelledAt: daysAgo(2), cancelReason: 'Duplicate of an existing request — same material already ordered.' });
insertAssignee({ taskId: 'TASK-DEMO-CANCELLED', username: rohit, stage: 1, isReleased: true, baseline: daysAgo(3) });
console.log('5/8 Created: a cancelled task, with reason (shows in Reports and Audit Log).');

// ---- 6. Blocked task (depends on the still-open Levels task above) ----
insertTask({ id: 'TASK-DEMO-BLOCKED', title: 'Material Delivery Scheduling (DEMO)', description: 'Can\'t schedule delivery until the Purchase Order task above is fully done.', priority: 'medium', deadline: daysFromNow(6), dependsOn: 'TASK-DEMO-LEVELS', createdAt: daysAgo(1) });
insertAssignee({ taskId: 'TASK-DEMO-BLOCKED', username: yuvraj, stage: 1, isReleased: true, baseline: daysAgo(1) });
console.log('6/8 Created: a task blocked on the multi-level task above (shows the "Blocked" banner).');

// ---- 7. A pending Send for Approval request ----
const approvalId = 'APR-DEMO-' + Math.random().toString(36).slice(2, 8).toUpperCase();
const demoDoc = 'data:text/plain;base64,' + Buffer.from('Placeholder vendor contract for demo purposes — not a real document.', 'utf8').toString('base64');
db.createApprovalRequest({ id: approvalId, title: 'Vendor Contract — Cement Supply (DEMO)', description: 'Standard supply agreement, needs sign-off before we proceed.', file_data: demoDoc, file_name: 'demo-vendor-contract.txt', created_by_username: admin.username, created_by_name: admin.name, reviewers: [suraj, tanishq].filter((v, i, a) => a.indexOf(v) === i) });
console.log('7/8 Created: a pending Send-for-Approval request (Tasks tab → Approval Requests).');

// ---- 8. Design Team drawings across multiple projects and sections ----
const drawingText = 'Placeholder drawing file for demo purposes — replace with a real CAD/drawing file. Not an actual drawing.';
const drawingDataUrl = 'data:text/plain;base64,' + Buffer.from(drawingText, 'utf8').toString('base64');
const demoDrawings = [
  { project: 'Sunrise Residency', section: 'Clubhouse', title: 'Clubhouse Ground Floor Plan (DEMO)', fileName: 'sunrise-clubhouse-ground-floor.txt' },
  { project: 'Sunrise Residency', section: 'Tower A', title: 'Tower A Typical Floor Layout (DEMO)', fileName: 'sunrise-towerA-typical-floor.txt' },
  { project: 'Greenfield Commercial', section: 'Parking', title: 'Basement Parking Layout (DEMO)', fileName: 'greenfield-parking-layout.txt' },
  { project: 'Greenfield Commercial', section: 'Facade', title: 'Main Facade Elevation (DEMO)', fileName: 'greenfield-facade-elevation.txt' },
];
demoDrawings.forEach(d => {
  db.addDrawing({ project: d.project, section: d.section, title: d.title, file_name: d.fileName, file_data: drawingDataUrl, uploaded_by_username: 'demo_designer', uploaded_by_name: 'Priya Deshmukh (DEMO)' });
});
console.log(`8/8 Created: ${demoDrawings.length} drawings across 2 projects (Sunrise Residency, Greenfield Commercial), each with 2 sections — uploaded by the Design Team.`);

raw.close();
console.log('\nDone. Log in and check: My Tasks / Task History, Calendar, Admin → Performance, Peak Hours,');
console.log('Reports, Audit Log, and Drawings ("Sunrise Residency" / "Greenfield Commercial").');
console.log('Remove all of this any time with: node remove-demo-data.js');
