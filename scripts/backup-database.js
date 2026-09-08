// Creates a timestamped backup of the database — safe to run while the server is live, since
// better-sqlite3's WAL mode allows reading a consistent snapshot without locking out real users.
// Run manually any time, or schedule it (e.g. a nightly cron job / Windows Task Scheduler entry)
// calling: node scripts/backup-database.js
//
// Keeps the most recent 14 backups by default and deletes older ones automatically, so backups
// don't silently fill up the disk forever. Change KEEP_COUNT below if you want more/fewer.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// Resolved relative to the PROJECT ROOT (this script's own folder, one level up), not
// process.cwd() — so this always finds the same database file regardless of which directory
// you happen to run this script from.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'taskmanager.db');
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups');
const KEEP_COUNT = 14;

if (!fs.existsSync(DB_PATH)) {
  console.error(`No database found at "${DB_PATH}" — nothing to back up yet. Has the server been started at least once?`);
  process.exit(1);
}

if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = path.join(BACKUP_DIR, `taskmanager-${timestamp}.db`);

// Uses SQLite's own online backup API (via better-sqlite3's .backup()) rather than a plain file
// copy — this produces a genuinely consistent snapshot even if the server is actively writing
// to the database at the exact same moment, which a raw filesystem copy cannot safely guarantee.
const db = new Database(DB_PATH, { readonly: true });
db.backup(backupPath)
  .then(() => {
    db.close();
    const sizeKb = (fs.statSync(backupPath).size / 1024).toFixed(1);
    console.log(`Backup created: ${backupPath} (${sizeKb} KB)`);

    // Prune old backups beyond KEEP_COUNT, oldest first.
    const existing = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('taskmanager-') && f.endsWith('.db'))
      .map(f => ({ name: f, time: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
      .sort((a, b) => b.time - a.time);
    const toDelete = existing.slice(KEEP_COUNT);
    toDelete.forEach(f => {
      fs.unlinkSync(path.join(BACKUP_DIR, f.name));
      console.log(`Removed old backup: ${f.name}`);
    });
    console.log(`\nKeeping the most recent ${Math.min(existing.length, KEEP_COUNT)} backup(s) in "${BACKUP_DIR}/".`);
    console.log('Reminder: a backup only counts as reliable once you\'ve actually tested restoring from it — see RESTORE instructions in the guide.');
  })
  .catch(err => {
    console.error('Backup failed:', err.message);
    process.exit(1);
  });
