// Imports your real company roster from employees-data.json — creates every real employee
// account with a TEMPORARY password (MHR123456) that must be changed on first login, matching
// this app's production security policy: default/setup credentials are never treated as real
// production credentials. Correct department, designation, and team-lead status are inferred
// from each person's real job title.
//
// IMPORTANT: Mihir Sabadra is already your existing Admin account (created on first server
// start) — this script does NOT create a duplicate for him. It only updates his email,
// department, and designation from the real data, and leaves his admin role and password
// completely untouched. Vedant Sabadra (the other real Director) gets the "director" role.
//
// Safe to re-run any time. For an account that already exists: if that person has NOT yet
// completed their own mandatory first-login password change, their temporary password is
// (re-)applied — otherwise (they've already set their own real password) this script never
// touches their password at all, only refreshing their department/designation/name/email from
// the spreadsheet. Re-running this after people have started using the app will never silently
// reset anyone's real, already-chosen password back to the temporary one.
// Run from the project folder:   node scripts/import-real-employees.js
const bcrypt = require('bcrypt');
const db = require('../backend/db');
const fs = require('fs');
const path = require('path');

const TEMP_PASSWORD = 'MHR123456';
const employees = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'employees-data.json'), 'utf8'));
const hash = bcrypt.hashSync(TEMP_PASSWORD, 10);

let created = 0, updatedProfileOnly = 0, updatedWithPassword = 0, adminSkipped = 0;

// A real problem found and fixed while testing this script: an earlier version of this matching
// logic compared only first+last name, which correctly reconciled "Suraj Kathale" (old account)
// with "Suraj M Kathale" (real data) — but WRONGLY treated two entirely different real
// employees who happen to share a first+last name ("Rajendra Kushwaha," a Tower Crane Operator,
// and "Rajendra Kumar mungu kushwaha Kushwaha," a Signalman — different employee numbers,
// different emails, different jobs) as the same person, which would have silently overwritten
// one real employee's account with another's information. That's a much worse failure than a
// duplicate account, so this is deliberately narrow instead: only the handful of accounts that
// existed in this app BEFORE any real company data was available get reconciled by name — a
// short, explicit, manually-confirmed list, not a broad automatic heuristic that could
// mis-match two different real people anywhere else in the roster.
const KNOWN_PRE_EXISTING_ACCOUNTS = {
  'rohit.k': 'rohit machindra kamble',
  'suraj_kathale': 'suraj m kathale',
  'yuvraj.p': 'yuvraj dattatray patil',
};

employees.forEach(emp => {
  const isMihirSabadra = emp.isDirector && /mihir/i.test(emp.name) && /sabdra|sabadra/i.test(emp.name);
  if (isMihirSabadra) {
    const admin = db.listUsers().find(u => u.role === 'admin');
    if (admin) {
      db.setUserTeam(admin.username, emp.team);
      db.updateUserDesignation(admin.username, emp.designation);
      if (emp.email) db.updateOwnEmail(admin.username, emp.email);
      adminSkipped++;
      console.log(`Skipped creating a duplicate for ${emp.name} — already your Admin account (${admin.username}); updated their profile details instead. Password left completely untouched.`);
    }
    return;
  }

  const role = emp.isDirector ? 'director' : 'member';
  const empNameNormalized = String(emp.name).toLowerCase().replace(/[^a-z ]/g, '').trim();
  const reconciledUsername = Object.keys(KNOWN_PRE_EXISTING_ACCOUNTS).find(u => KNOWN_PRE_EXISTING_ACCOUNTS[u] === empNameNormalized);
  const existing = (reconciledUsername && db.getUser(reconciledUsername)) || db.getUser(emp.username);
  if (existing) {
    db.setUserTeam(existing.username, emp.team);
    db.updateUserDesignation(existing.username, emp.designation);
    db.updateUserDisplayName(existing.username, emp.name);
    db.setUserTeamLead(existing.username, emp.isTeamLead);
    if (emp.email) db.updateOwnEmail(existing.username, emp.email);
    if (existing.must_change_password) {
      db.forcePasswordReset(existing.username, hash);
      updatedWithPassword++;
    } else {
      updatedProfileOnly++;
    }
    if (reconciledUsername && existing.username !== emp.username) {
      console.log(`Matched "${emp.name}" to their existing account "${existing.username}" (kept their existing login, just refreshed department/designation/email from the real data) — did not create a second "${emp.username}" account for the same person.`);
    }
  } else {
    db.createUser({
      username: emp.username, password_hash: hash, role, name: emp.name,
      team: emp.team, designation: emp.designation, must_change_password: true,
    });
    if (emp.isTeamLead) db.setUserTeamLead(emp.username, true);
    if (emp.email) db.updateOwnEmail(emp.username, emp.email);
    created++;
  }
});

console.log(`\nDone.`);
console.log(`  ${created} new account(s) created — temporary password ${TEMP_PASSWORD}, must be changed on first login.`);
console.log(`  ${updatedWithPassword} existing account(s) hadn't logged in yet — temporary password (re-)applied, still must be changed on first login.`);
console.log(`  ${updatedProfileOnly} existing account(s) had ALREADY set their own real password — left completely untouched, only their department/designation/name/email were refreshed.`);
console.log(`  ${adminSkipped} matched to your existing Admin account — no duplicate created, password untouched.`);
console.log('Run node list-accounts.js to see the full roster.');
console.log('\nNote: "Tejas" (an original placeholder account, team "Estimation Department") does not appear anywhere in this spreadsheet under that name — left completely untouched. If Tejas is a real current employee, check whether they\'re listed under a different/fuller name in the spreadsheet, or add them manually via Accounts.');
