# DISASTER_RECOVERY.md

## Database corruption or accidental deletion
1. Stop the server.
2. `node scripts/restore-database.js backups/<most-recent-backup>.db` — automatically saves a safety
   copy of whatever's currently there first, refuses to run if the server looks still active.
3. Start the server, verify data looks right before telling anyone it's back up.
**Verified this session**: a real backup → total deletion → restore round trip, confirmed both
a real task and a real imported employee's data survived intact.

## Server failure (hardware/hosting failure)
1. Provision a new server following `DEPLOY.md`.
2. Restore the most recent backup (see above) onto it before starting the app for the first time.
3. Point DNS/whatever routes traffic at the new server.
**Gap, honestly**: backups are currently local to the server they're taken on
(`backups/` folder) — if the server itself is destroyed (not just its database corrupted), the
backup goes with it unless it's also been copied off-server. Recommend: a cron job that also
copies each backup to separate storage (another machine, cloud storage) — not built this
session; `backup-database.js` produces the file, but off-server replication of it is a real
follow-up, not yet automated.

## Deployment rollback
1. Before every deploy: `node scripts/backup-database.js`.
2. If a deploy introduces a bug: revert the code (git) to the previous known-good commit,
   restart the server. The database schema in this app is additive (new columns via
   `ensureColumn`, never destructive), so an old code version reading a newer database is
   generally safe — but this has not been exhaustively tested across every possible version
   pairing.
3. Only restore the database from backup if the bad deploy actually corrupted data, not merely
   introduced a bug — restoring loses everything written since that backup, so it's the more
   drastic option, not the default one.

## Credential compromise (JWT_SECRET or a real account leaked)
1. Generate a fresh `JWT_SECRET`, update `.env`, restart the server — this immediately
   invalidates every existing login token for everyone (a real, if blunt, mitigation).
2. For a specific compromised account: `node scripts/reset-password.js <username> <newpassword>`, or use
   Admin's own Accounts page — either way forces that account through a real password change.
3. Review `Audit Log` for anything the compromised account did while compromised.

## What has NOT been tested as a disaster scenario this session
- Actual hardware/hosting-provider failure (can't simulate real infrastructure loss in a sandbox).
- Backup restoration onto a genuinely different machine/OS than where the backup was taken.
- Recovery timing (how long a real restore takes at real production data volume, not this
  sandbox's small test dataset).
