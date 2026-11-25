// Nightly backup through GitHub's signed token: only this repo's backup workflow on main gets the (encrypted) file.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const zlib = require('zlib');
const jwt = require('jsonwebtoken');
const { startTestServer } = require('../testlib/helpers');

test('nightly backup: GitHub token checked, file encrypted, restorable with BACKUP_KEY only', async (t) => {
  process.env.BACKUP_KEY = 'test-backup-key-0123456789abcdef-xyz';
  const bk = require('../backend/backup');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  bk._keyForTests = async (kid) => { if (kid !== 'k1') throw new Error('unknown key'); return publicKey; };
  const { baseUrl, stop } = await startTestServer();
  t.after(async () => { bk._keyForTests = null; delete process.env.BACKUP_KEY; await stop(); });
  const tok = (claims, opts = {}) => jwt.sign({ repository: 'mansi688/mihir-task-manager', ref: 'refs/heads/main', workflow_ref: 'mansi688/mihir-task-manager/.github/workflows/backup.yml@refs/heads/main', run_id: '42', ...claims },
    opts.key || privateKey, { algorithm: 'RS256', keyid: 'k1', issuer: bk.ISSUER, audience: opts.aud || bk.AUDIENCE, expiresIn: '5m' });
  const call = (token) => fetch(`${baseUrl}/api/backup/nightly`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {} });

  assert.equal((await call(null)).status, 401);
  assert.equal((await call(tok({ repository: 'someone/else' }))).status, 401, 'other repositories refused');
  assert.equal((await call(tok({ ref: 'refs/heads/evil' }))).status, 401, 'other branches refused');
  assert.equal((await call(tok({ workflow_ref: 'mansi688/mihir-task-manager/.github/workflows/other.yml@refs/heads/main' }))).status, 401, 'other workflows refused');
  assert.equal((await call(tok({}, { aud: 'something-else' }))).status, 401, 'wrong audience refused');
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  assert.equal((await call(tok({}, { key: other }))).status, 401, 'a token not signed by GitHub refused');
  const hs = jwt.sign({ repository: 'mansi688/mihir-task-manager' }, 'x', { algorithm: 'HS256', keyid: 'k1' });
  assert.equal((await call(hs)).status, 401, 'HS256 refused');

  const r = await call(tok({}));
  assert.equal(r.status, 200);
  const buf = Buffer.from(await r.arrayBuffer());
  assert.ok(bk.isEncrypted(buf), 'encrypted');
  assert.ok(!buf.includes(Buffer.from('password_hash')), 'nothing readable in the file');
  assert.equal(crypto.createHash('sha256').update(buf).digest('hex'), r.headers.get('x-backup-sha256'));
  assert.throws(() => bk.decrypt(buf, 'wrong-key'));
  const dump = JSON.parse(zlib.gunzipSync(bk.decrypt(buf, process.env.BACKUP_KEY)).toString());
  assert.equal(dump.format, 'mihir-backup/1');
  assert.ok(dump.tables.users.rows.length >= 1 && dump.tables.tasks);
  assert.equal((await call(tok({}))).status, 429, 'not twice within minutes');
});
