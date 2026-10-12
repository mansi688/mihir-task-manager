#!/usr/bin/env node
// Restores a backup made by scripts/backup-database.js into an EMPTY database.
//
//   DATABASE_URL=<NEW, EMPTY database> node scripts/restore-database.js backups/mihir-backup-….json.gz
//
// Safety: refuses to run if the target already has any users or tasks — it can never overwrite
// live data. Creates the schema with the app's own startup code (same version as this code),
// inserts every row in ONE transaction (all-or-nothing), resets ID sequences, then verifies
// row counts against the backup. Point the app at the restored database only after it says OK.
require('dotenv').config();
const fs = require('fs');
const zlib = require('zlib');

(async () => {
  const file = process.argv[2];
  if (!file || !fs.existsSync(file)) { console.error('Usage: node scripts/restore-database.js <backup .json.gz>'); process.exit(1); }
  if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL to the EMPTY target database first.'); process.exit(1); }
  const dump = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
  if (dump.format !== 'mihir-backup/1') { console.error('Not a MIHIR backup file.'); process.exit(1); }
  const db = require('../backend/db');
  const pool = db.pool;
  // Refuse non-empty targets BEFORE touching anything.
  try {
    const r = await pool.query("SELECT (SELECT COUNT(*) FROM users) u, (SELECT COUNT(*) FROM tasks) t");
    if (Number(r.rows[0].u) > 0 || Number(r.rows[0].t) > 0) { console.error('REFUSED: the target database already has users or tasks. Restore only into a new, empty database.'); process.exit(2); }
  } catch (e) { /* tables don't exist yet — empty database, fine */ }
  await db.init(); // creates the full schema (and a first-run admin, removed below)
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const target = new Set((await client.query("SELECT tablename FROM pg_tables WHERE schemaname = current_schema()")).rows.map(r => r.tablename));
    // Task history is append-only: allow the restore's own cleanup of the fresh schema.
    await client.query("SET LOCAL mihir.allow_history_delete = 'on'");
    for (const t of ['task_activity_events', 'task_assignees', 'task_replies', 'task_checklist_items', 'task_followups', 'approval_reviewers', 'approval_history', 'automation_job_runs'])
      if (target.has(t)) await client.query(`DELETE FROM "${t}"`);
    for (const t of Object.keys(dump.tables)) if (target.has(t) && t !== 'schema_migrations') await client.query(`DELETE FROM "${t}"`);
    // Parents before children (foreign keys since migration 003).
    // (chat_messages before chat_files; location parents before their children.)
    const FIRST = ['users', 'teams', 'projects', 'task_phases', 'tasks', 'approval_requests', 'automation_jobs', 'chat_messages', 'chat_private',
      'geofences', 'location_sessions', 'location_alert_rules', 'indoor_floors', 'indoor_zones', 'geofence_visits'];
    const ordered = Object.entries(dump.tables).sort(([a], [b]) => {
      const ia = FIRST.indexOf(a), ib = FIRST.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
    });
    for (const [t, { columns, rows }] of ordered) {
      if (!target.has(t) || t === 'schema_migrations' || rows.length === 0) continue;
      const cols = columns.map(c => `"${c}"`).join(',');
      const per = Math.max(1, Math.floor(30000 / columns.length));
      for (let i = 0; i < rows.length; i += per) {
        const chunk = rows.slice(i, i + per);
        let n = 0;
        const values = chunk.map(() => `(${columns.map(() => `$${++n}`).join(',')})`).join(',');
        await client.query(`INSERT INTO "${t}" (${cols}) VALUES ${values}`, chunk.flat().map(v => (v && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v)));
      }
    }
    // Make new rows continue after the restored IDs.
    const seqs = (await client.query(`SELECT c.relname AS tbl, a.attname AS col, pg_get_serial_sequence(c.relname, a.attname) AS seq
      FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid JOIN pg_namespace ns ON ns.oid = c.relnamespace
      WHERE ns.nspname = current_schema() AND c.relkind = 'r' AND a.attnum > 0 AND pg_get_serial_sequence(c.relname, a.attname) IS NOT NULL`)).rows;
    for (const s of seqs) await client.query(`SELECT setval('${s.seq}', COALESCE((SELECT MAX("${s.col}") FROM "${s.tbl}"), 0) + 1, false)`);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK'); client.release();
    console.error('Restore FAILED and was rolled back — the target is unchanged:', e.message); process.exit(1);
  }
  client.release();
  let ok = true;
  for (const [t, { rows }] of Object.entries(dump.tables)) {
    if (t === 'schema_migrations') continue;
    const n = Number((await pool.query(`SELECT COUNT(*) c FROM "${t}"`)).rows[0].c);
    const good = n === rows.length; if (!good) ok = false;
    console.log(`  ${good ? 'OK ' : 'BAD'} ${t.padEnd(28)} ${n}/${rows.length}`);
  }
  console.log(ok ? `Restore OK — ${file} (backup taken ${dump.createdAt}).` : 'Restore finished with MISMATCHES — do not use this database.');
  await pool.end();
  process.exit(ok ? 0 : 1);
})();
