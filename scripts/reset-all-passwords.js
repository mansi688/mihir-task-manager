// One-off maintenance script: resets EVERY account's password to a temporary MHR123456 and
// requires each person to set their own real password on next login — matching this app's
// production security policy that default/setup credentials are never treated as real
// production credentials, even for a mass reset.
// Run once from the project folder:   node reset-all-passwords.js
const bcrypt = require('bcrypt');
const db = require('../backend/db');

const NEW_PASSWORD = 'MHR123456';
const hash = bcrypt.hashSync(NEW_PASSWORD, 10);

const users = db.listUsers();
if (users.length === 0) {
  console.log('No accounts found — nothing to reset.');
  process.exit(0);
}

users.forEach(u => {
  db.forcePasswordReset(u.username, hash); // forces must_change_password=1 — never a permanent shared password
  db.logAudit({ actor_username: null, actor_name: 'reset-all-passwords.js (CLI)', action: 'password_reset', details: `Mass reset password for "${u.username}" via CLI script` });
  console.log(`Reset: ${u.username} (${u.name})`);
});

console.log(`\nDone — ${users.length} account(s) reset to a TEMPORARY password: ${NEW_PASSWORD}`);
console.log('Everyone will be required to set their own real password the next time they log in.');
