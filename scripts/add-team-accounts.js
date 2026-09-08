// Creates (or updates, if they already exist) the specific accounts below, all with password
// MHR123456 set PERMANENTLY — no forced password change, they log in with it directly and
// stay logged in with it until someone changes it deliberately.
//
// Run once from the project folder:   node add-team-accounts.js
const bcrypt = require('bcrypt');
const db = require('../backend/db');

const PASSWORD = 'MHR123456';
const hash = bcrypt.hashSync(PASSWORD, 10);

const accounts = [
  { name: 'Rohit Kamble', username: 'rohit.k', team: 'Estimation Department', designation: 'Estimate', teamLead: false },
  { name: 'Suraj Kathale', username: 'suraj_kathale', team: 'Estimation Department', designation: 'Estimate Head', teamLead: true },
  { name: 'Tanishq Mutha', username: 'tanishq.m', team: 'Purchase Department', designation: 'Purchase Lead', teamLead: true },
  { name: 'Tejas', username: 'tejas.l', team: 'Estimation Department', designation: '', teamLead: false },
  { name: 'Yuvraj Patil', username: 'yuvraj.p', team: 'Purchase Department', designation: 'Purchase', teamLead: false },
];

accounts.forEach(acc => {
  const existing = db.getUser(acc.username);
  if (existing) {
    // Already exists — update it to match this spec exactly, rather than creating a duplicate
    // or failing. Safe to re-run this script any time.
    db.setPassword(acc.username, hash);
    db.setUserTeam(acc.username, acc.team);
    db.updateUserDesignation(acc.username, acc.designation);
    db.updateUserDisplayName(acc.username, acc.name);
    db.setUserTeamLead(acc.username, acc.teamLead);
    console.log(`Updated: ${acc.username} (${acc.name}) — team: ${acc.team}, designation: ${acc.designation || '(none)'}, team lead: ${acc.teamLead}`);
  } else {
    db.createUser({
      username: acc.username, password_hash: hash, role: 'member', name: acc.name,
      team: acc.team, designation: acc.designation, must_change_password: false,
    });
    if (acc.teamLead) db.setUserTeamLead(acc.username, true);
    console.log(`Created: ${acc.username} (${acc.name}) — team: ${acc.team}, designation: ${acc.designation || '(none)'}, team lead: ${acc.teamLead}`);
  }
});

console.log(`\nDone. All 5 accounts can log in immediately with password: ${PASSWORD}`);
console.log('No one will be prompted to change it — this is permanent, same as node reset-all-passwords.js.');
