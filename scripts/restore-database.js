// Restores the database from a backup file created by backup-database.js.
// Run from the project folder:   node scripts/restore-database.js backups/taskmanager-2026-09-01T....db
//
// STOP THE SERVER FIRST — restoring while it's running would restore into a file the live
// server has open, which is not safe. This script refuses to run if it looks like something is
// actively holding the current database open, but stopping the server yourself is still the
// right first step.
const fs = require('fs');
const path = require('path');

// Resolved relative to the PROJECT ROOT, matching backup-database.js and backend/db.js exactly
// — all three must agree on this path, or a restore could silently target the wrong file.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'taskmanager.db');
const backupFile = process.argv[2];

if (!backupFile) {
  console.error('Usage: node scripts/restore-database.js <path-to-backup-file>');
  console.error('Example: node scripts/restore-database.js backups/taskmanager-2026-09-01T12-00-00-000Z.db');
  process.exit(1);
}
if (!fs.existsSync(backupFile)) {
  console.error(`Backup file not found: ${backupFile}`);
  process.exit(1);
}

// A quick, honest safety check — not foolproof, but catches the most common mistake (forgetting
// to stop the server) by refusing if the current DB's WAL file is unusually large/recent,
// which usually means something is actively writing to it right now.
const walPath = DB_PATH + '-wal';
if (fs.existsSync(walPath)) {
  const walAgeMs = Date.now() - fs.statSync(walPath).mtimeMs;
  if (walAgeMs < 5000) {
    console.error('The database\'s WAL file was just modified — it looks like the server may still be running.');
    console.error('Stop the server first (Ctrl+C in its terminal, or however you normally stop it), then run this again.');
    process.exit(1);
  }
}

if (fs.existsSync(DB_PATH)) {
  const safetyCopy = `${DB_PATH}.before-restore-${Date.now()}`;
  fs.copyFileSync(DB_PATH, safetyCopy);
  console.log(`Your current database was saved to "${safetyCopy}" first, just in case — delete it once you've confirmed the restore worked.`);
}

fs.copyFileSync(backupFile, DB_PATH);
// A restored file may carry stale WAL/SHM files from its own backup moment — remove any leftover
// ones from the CURRENT location so the server starts clean against the restored file.
[DB_PATH + '-wal', DB_PATH + '-shm'].forEach(f => { try { fs.unlinkSync(f); } catch (e) { /* fine if none existed */ } });

console.log(`Restored "${DB_PATH}" from "${backupFile}".`);
console.log('Start the server normally now (npm start) and confirm your data looks right.');
