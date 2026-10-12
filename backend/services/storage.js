// Object storage for large files (voice notes, meeting recordings, WhatsApp media, future documents).
// Large files never go into PostgreSQL: the bytes live in a PRIVATE Supabase Storage bucket, the
// database keeps only metadata (file_objects). Downloads use short-lived signed URLs after the app's
// own permission check. When storage is not configured, put() throws StorageNotConfigured and callers
// fall back to processing without keeping the file.
const crypto = require('crypto');

class StorageNotConfigured extends Error { constructor() { super('File storage is not configured (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, STORAGE_BUCKET).'); this.code = 'STORAGE_NOT_CONFIGURED'; } }

function createStorage({ pool, env = process.env, fetchImpl = fetch }) {
  const base = (env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = env.SUPABASE_SERVICE_ROLE_KEY || '';
  const bucket = env.STORAGE_BUCKET || '';
  const configured = !!(base && key && bucket);
  const headers = (extra = {}) => ({ Authorization: `Bearer ${key}`, apikey: key, ...extra });

  async function put(buffer, { mime = 'application/octet-stream', originalName = null, ownerType, ownerId = null, uploadedBy = null, retention = 'keep' }) {
    if (!configured) throw new StorageNotConfigured();
    const id = crypto.randomUUID();
    const d = new Date();
    const objectKey = `${ownerType || 'misc'}/${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${id}`;
    const res = await fetchImpl(`${base}/storage/v1/object/${encodeURIComponent(bucket)}/${objectKey}`, { method: 'POST', headers: headers({ 'Content-Type': mime, 'x-upsert': 'false' }), body: buffer });
    if (!res.ok) throw new Error(`Storage upload failed (${res.status}): ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const checksum = crypto.createHash('sha256').update(buffer).digest('hex');
    await pool.query(`INSERT INTO file_objects (id, storage_provider, bucket, object_key, mime_type, file_size, checksum_sha256, original_name, uploaded_by, owner_type, owner_id, retention_policy)
      VALUES ($1,'supabase',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [id, bucket, objectKey, mime, buffer.length, checksum, originalName, uploadedBy, ownerType || null, ownerId, retention]);
    return { id, size: buffer.length, checksum };
  }
  async function get(id) { const r = await pool.query('SELECT * FROM file_objects WHERE id=$1 AND deleted_at IS NULL', [id]); return r.rows[0] || null; }
  async function signedUrl(id, expiresInSeconds = 300) {
    if (!configured) throw new StorageNotConfigured();
    const f = await get(id); if (!f) return null;
    const res = await fetchImpl(`${base}/storage/v1/object/sign/${encodeURIComponent(f.bucket)}/${f.object_key}`, { method: 'POST', headers: headers({ 'Content-Type': 'application/json' }), body: JSON.stringify({ expiresIn: expiresInSeconds }) });
    if (!res.ok) throw new Error(`Signing failed (${res.status})`);
    const j = await res.json();
    const path = j.signedURL || j.signedUrl;
    return path.startsWith('http') ? path : `${base}/storage/v1${path}`;
  }
  async function download(id) {
    if (!configured) throw new StorageNotConfigured();
    const f = await get(id); if (!f) return null;
    const res = await fetchImpl(`${base}/storage/v1/object/${encodeURIComponent(f.bucket)}/${f.object_key}`, { headers: headers() });
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    return { buffer: Buffer.from(await res.arrayBuffer()), mime: f.mime_type, name: f.original_name };
  }
  async function remove(id) {
    const f = await get(id); if (!f) return false;
    if (configured) {
      const res = await fetchImpl(`${base}/storage/v1/object/${encodeURIComponent(f.bucket)}`, { method: 'DELETE', headers: headers({ 'Content-Type': 'application/json' }), body: JSON.stringify({ prefixes: [f.object_key] }) });
      if (!res.ok && res.status !== 404) throw new Error(`Delete failed (${res.status})`);
    }
    await pool.query('UPDATE file_objects SET deleted_at = now() WHERE id=$1', [id]);
    return true;
  }
  // Retention: files whose policy is "days:N" are deleted N days after upload.
  async function purgeExpired() {
    const r = await pool.query(`SELECT id FROM file_objects WHERE deleted_at IS NULL AND retention_policy LIKE 'days:%'
      AND created_at < now() - (split_part(retention_policy, ':', 2) || ' days')::interval`);
    let n = 0; for (const row of r.rows) { if (await remove(row.id)) n++; }
    return n;
  }
  return { configured, put, get, signedUrl, download, remove, purgeExpired, StorageNotConfigured };
}
module.exports = { createStorage, StorageNotConfigured };
