// Nightly off-site backup WITHOUT any database password in GitHub.
//
// The GitHub Action (".github/workflows/backup.yml") asks GitHub for a short-lived signed identity token (OIDC) and
// calls POST /api/backup/nightly. The server checks that the token really comes from GitHub, from THIS repository's
// backup workflow on main, then makes the backup with its own database connection and answers with the file
// ENCRYPTED (AES-256-GCM) with BACKUP_KEY — the repository is public, so the stored artifact must be unreadable
// to anyone without the key. The key lives only in Render → Environment (keep a copy offline: it is needed to restore).
//
// File format: "MIHIRBK1" (8 bytes) · IV (12) · auth tag (16) · encrypted gzip of the JSON dump (mihir-backup/1).
const crypto = require('crypto');
const zlib = require('zlib');

const MAGIC = Buffer.from('MIHIRBK1');
const ISSUER = 'https://token.actions.githubusercontent.com';
const AUDIENCE = 'mihir-task-manager-backup';

function keyFrom(secret) { return crypto.createHash('sha256').update(String(secret)).digest(); }
function encrypt(buf, secret) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const enc = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), enc]);
}
function decrypt(buf, secret) {
  if (!buf.subarray(0, 8).equals(MAGIC)) throw new Error('Not an encrypted MIHIR backup.');
  const iv = buf.subarray(8, 20), tag = buf.subarray(20, 36);
  const d = crypto.createDecipheriv('aes-256-gcm', keyFrom(secret), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(buf.subarray(36)), d.final()]);
}
const isEncrypted = (buf) => buf.length > 36 && buf.subarray(0, 8).equals(MAGIC);

// One consistent snapshot of every table (same as scripts/backup-database.js) → gzip buffer.
async function makeDump(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const tables = (await client.query('SELECT tablename FROM pg_tables WHERE schemaname = current_schema() ORDER BY tablename')).rows.map(r => r.tablename);
    let version = null;
    if ((await client.query("SELECT to_regclass('schema_migrations') IS NOT NULL AS ok")).rows[0].ok) version = (await client.query('SELECT max(version) v FROM schema_migrations')).rows[0].v;
    const dump = { format: 'mihir-backup/1', createdAt: new Date().toISOString(), schemaVersion: version, tables: {} };
    for (const t of tables) {
      const r = await client.query(`SELECT * FROM "${t}"`);
      dump.tables[t] = { columns: r.fields.map(f => f.name), rows: r.rows.map(row => r.fields.map(f => row[f.name])) };
    }
    await client.query('COMMIT');
    const counts = Object.fromEntries(Object.entries(dump.tables).map(([t, v]) => [t, v.rows.length]));
    return { gz: zlib.gzipSync(Buffer.from(JSON.stringify(dump)), { level: 9 }), createdAt: dump.createdAt, counts };
  } catch (e) { try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ } throw e; } finally { client.release(); }
}

// ---- GitHub OIDC token check (keys fetched from GitHub, cached for an hour) ----
let jwks = null, jwksAt = 0;
async function githubKey(kid, fetchImpl) {
  if (!jwks || Date.now() - jwksAt > 3600000 || !jwks.find(k => k.kid === kid)) {
    const r = await (fetchImpl || fetch)(`${ISSUER}/.well-known/jwks`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`GitHub keys: HTTP ${r.status}`);
    jwks = (await r.json()).keys || []; jwksAt = Date.now();
  }
  const k = jwks.find(x => x.kid === kid);
  if (!k) throw new Error('Unknown GitHub signing key.');
  return crypto.createPublicKey({ key: k, format: 'jwk' });
}
async function verifyGithubToken(token, { jwt, repository, fetchImpl, keyFor }) {
  const head = jwt.decode(token, { complete: true });
  if (!head || !head.header || head.header.alg !== 'RS256') throw new Error('Not a GitHub token.');
  const key = keyFor ? await keyFor(head.header.kid) : await githubKey(head.header.kid, fetchImpl);
  const c = jwt.verify(token, key, { algorithms: ['RS256'], issuer: ISSUER, audience: AUDIENCE });
  if (c.repository !== repository) throw new Error(`Token is for ${c.repository}, not ${repository}.`);
  if (c.ref !== 'refs/heads/main') throw new Error('Only the main branch may take backups.');
  if (!/\/\.github\/workflows\/backup\.yml@/.test(String(c.workflow_ref || c.job_workflow_ref || ''))) throw new Error('Only the nightly backup workflow may take backups.');
  return c;
}

function mountBackup(app, { db, auditLog }) {
  const repository = process.env.BACKUP_GITHUB_REPO || 'mansi688/mihir-task-manager';
  let last = 0;
  app.post('/api/backup/nightly', async (req, res) => {
    const secret = process.env.BACKUP_KEY;
    if (!secret || String(secret).length < 24) return res.status(503).json({ error: 'BACKUP_KEY is not set on the server.' });
    const h = req.headers.authorization || '';
    if (!h.startsWith('Bearer ')) return res.status(401).json({ error: 'Not allowed.' });
    let claims;
    try { claims = await verifyGithubToken(h.slice(7), { jwt: require('jsonwebtoken'), repository, keyFor: module.exports._keyForTests }); }
    catch (e) { return res.status(401).json({ error: 'Not allowed.', detail: String(e.message).slice(0, 120) }); }
    if (Date.now() - last < 5 * 60000) return res.status(429).json({ error: 'A backup was just made — try again in a few minutes.' });
    last = Date.now();
    try {
      const d = await makeDump(db.pool);
      const out = encrypt(d.gz, secret);
      const sha = crypto.createHash('sha256').update(out).digest('hex');
      if (auditLog) await auditLog('backup_taken', `Nightly backup by GitHub run ${claims.run_id || '?'}: ${(out.length / 1048576).toFixed(2)} MB, ${Object.keys(d.counts).length} tables, ${d.counts.tasks || 0} tasks, ${d.counts.users || 0} users. SHA-256 ${sha}.`).catch(() => {});
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="mihir-backup-${d.createdAt.replace(/[:.]/g, '-').slice(0, 19)}.json.gz.enc"`);
      res.setHeader('X-Backup-Sha256', sha);
      res.setHeader('X-Backup-Counts', JSON.stringify({ tasks: d.counts.tasks || 0, users: d.counts.users || 0, tables: Object.keys(d.counts).length }));
      res.setHeader('Cache-Control', 'no-store');
      res.end(out);
    } catch (e) { last = 0; res.status(500).json({ error: 'Backup failed: ' + String(e.message).slice(0, 200) }); }
  });
}

module.exports = { mountBackup, encrypt, decrypt, isEncrypted, makeDump, verifyGithubToken, AUDIENCE, ISSUER, _keyForTests: null };
