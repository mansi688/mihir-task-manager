// Clears every task in the database — and everything tied to a task (assignees, checklist
// items, replies, follow-ups, and task-related notifications) — while leaving your real
// employee accounts, teams/departments, and login history completely untouched. Built for the
// exact situation of a pre-launch mock run: real people already set up, test tasks that now
// need to disappear before real work starts.
//
// Deliberately does NOT touch: user accounts, teams, "Send for Approval" requests, drawings,
// or the audit log — those aren't "tasks" and clearing them wasn't asked for. If you also want
// those cleared, say so explicitly and a separate, equally explicit script should handle it —
// bundling more into one irreversible action than was actually asked for is exactly how someone
// loses something they wanted to keep.
//
// Requires DATABASE_URL to be set (same as the main app) and the literal word CONFIRM as the
// only argument, so this can never run by accident:
//
//   DATABASE_URL="postgres://..." node scripts/clear-all-tasks.js CONFIRM
//
// Safe to run against Supabase directly, or locally against a test database first to see
// exactly what it would do (see the dry-run note at the bottom).

const { Pool } = require('pg');

async function main() {
  const confirmed = process.argv[2] === 'CONFIRM';
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
  });

  try {
    const taskCountRes = await pool.query('SELECT COUNT(*) c FROM tasks');
    const taskCount = Number(taskCountRes.rows[0].c);

    if (taskCount === 0) {
      console.log('No tasks found — nothing to clear.');
      return;
    }

    console.log(`Found ${taskCount} task(s) in the database.`);

    if (!confirmed) {
      console.log('\nThis is a DRY RUN — nothing has been deleted.');
      console.log('This would permanently delete all', taskCount, 'task(s), along with every');
      console.log('assignee, checklist item, reply, follow-up, and task notification tied to them.');
      console.log('User accounts, teams, approval requests, drawings, and the audit log are NOT touched.');
      console.log('\nTo actually run this, re-run with the literal word CONFIRM as the argument:');
      console.log('  node scripts/clear-all-tasks.js CONFIRM');
      return;
    }

    console.log('\nCONFIRM received — deleting now...');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM notifications WHERE task_id IS NOT NULL');
      await client.query('DELETE FROM task_replies');
      await client.query('DELETE FROM task_followups');
      await client.query('DELETE FROM task_checklist_items');
      await client.query('DELETE FROM task_assignees');
      const deleted = await client.query('DELETE FROM tasks');
      await client.query('COMMIT');
      console.log(`\nDone. Deleted ${deleted.rowCount} task(s) and everything tied to them.`);
      console.log('Your accounts, teams, and everything else are untouched — ready for real tasks.');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

main().catch(e => {
  console.error('Failed:', e.message);
  process.exit(1);
});
