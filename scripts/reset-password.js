// Command-line password recovery — for when someone (including Admin) is locked out and
// there's no other logged-in Admin to reset it for them from the Accounts page.
//
// Usage (run from the project folder, on the machine/server running the app):
//   node reset-password.js <username> <newpassword>
//
// Example:
//   node reset-password.js admin TempPass123
//
// The account is flagged to set its own real password on next login — same safety net the
// very first default admin account uses — so this temporary value isn't left in place long-term.
const bcrypt = require('bcrypt');
const db = require('../backend/db');

const [, , username, newPassword] = process.argv;

if (!username || !newPassword) {
  console.log('Usage: node reset-password.js <username> <newpassword>');
  console.log('Example: node reset-password.js admin TempPass123');
  process.exit(1);
}

if (newPassword.length < 6) {
  console.log('Password must be at least 6 characters.');
  process.exit(1);
}

const user = db.getUser(username);
if (!user) {
  console.log(`No account found with username "${username}".`);
  console.log('Run `node list-accounts.js` (if present) or check the Accounts page for the correct username.');
  process.exit(1);
}

const hash = bcrypt.hashSync(newPassword, 10);
db.forcePasswordReset(user.username, hash);

console.log(`Password for "${user.username}" (${user.name}) has been reset.`);
console.log(`They can now log in with the temporary password: ${newPassword}`);
console.log('They will be asked to set their own real password immediately after logging in.');
