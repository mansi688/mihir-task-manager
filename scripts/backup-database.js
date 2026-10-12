#!/usr/bin/env node
// Logical backup of the PostgreSQL database — every table in the app's schema — into ONE gzip
// file. Pure Node + pg (no pg_dump needed), so it runs on a laptop, on Render, or in a scheduled
// GitHub Action. Read-only: it never changes the database.
//
//   DATABASE_URL=postgres://… node scripts/backup-database.js [output-dir]
//
// Output: backups/mihir-backup-YYYY-MM-DDTHH-MM-SS.json.gz plus a printed summary
// (row counts per table + SHA-256 of the file). Keep copies OFF the database provider
// (e.g. Google Drive) — see docs/DISASTER_RECOVERY.md. A backup only counts once a test
// restore of it has succeeded (scripts/restore-database.js into an EMPTY database).
require('dotenv').config();
const { Pool } = require('pg');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

(async () => {
  if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL first.'); process.exit(1); }
  const outDir = process.argv[2] || process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups');
  fs.mkdirSync(outDir, { recursive: true });
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false } });
  const client = await pool.connect();
  try {
    // A consistent snapshot: every table read in one REPEATABLE READ, read-only transaction.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const tables = (await client.query("SELECT tablename FROM pg_tables WHERE schemaname = current_schema() ORDER BY tablename")).rows.map(r => r.tablename);
    let version = null;
    const hasMigrations = (await client.query("SELECT to_regclass('schema_migrations') IS NOT NULL AS ok")).rows[0].ok;
    if (hasMigrations) version = (await client.query('SELECT max(version) v FROM schema_migrations')).rows[0].v;
    const dump = { format: 'mihir-backup/1', createdAt: new Date().toISOString(), schemaVersion: version, tables: {} };
    for (const t of tables) {
      const r = await client.query(`SELECT * FROM "${t}"`);
      dump.tables[t] = { columns: r.fields.map(f => f.name), rows: r.rows.map(row => r.fields.map(f => row[f.name])) };
    }
    await client.query('COMMIT');
    const stamp = dump.createdAt.replace(/[:.]/g, '-').slice(0, 19);
    const file = path.join(outDir, `mihir-backup-${stamp}.json.gz`);
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(dump)), { level: 9 });
    fs.writeFileSync(file, gz);
    const sha = crypto.createHash('sha256').update(gz).digest('hex');
    fs.writeFileSync(file + '.sha256', `${sha}  ${path.basename(file)}\n`);
    console.log(`Backup written: ${file} (${(gz.length / 1048576).toFixed(2)} MB, schema ${version || 'n/a'})`);
    console.log(`SHA-256: ${sha}`);
    for (const [t, v] of Object.entries(dump.tables)) console.log(`  ${t.padEnd(28)} ${v.rows.length} rows`);
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('Backup FAILED:', e.message); process.exitCode = 1;
  } finally { client.release(); await pool.end(); }
})();
