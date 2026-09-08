// Lists every account's username, name, and role — useful when locked out and you need to
// confirm the exact username before running reset-password.js.
// Usage: node list-accounts.js
const db = require('../backend/db');

const users = db.listUsers();
if (users.length === 0) {
  console.log('No accounts exist yet.');
  process.exit(0);
}

console.log('Username'.padEnd(20) + 'Name'.padEnd(25) + 'Role');
console.log('-'.repeat(55));
users.forEach(u => {
  console.log(u.username.padEnd(20) + u.name.padEnd(25) + u.role);
});
