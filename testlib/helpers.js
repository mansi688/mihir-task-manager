// Shared setup for every test file: a fresh, isolated SQLite file per test file (never your
// real data) and the real Express app started on an ephemeral port, so tests hit the exact same
// code paths a real request would — not a mocked-out version of the app.
const path = require('path');
const fs = require('fs');
const os = require('os');

function startTestServer() {
  const dbPath = path.join(os.tmpdir(), `tm-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  process.env.DB_PATH = dbPath;
  process.env.JWT_SECRET = 'test-secret-not-for-real-use-' + Math.random().toString(36);
  delete require.cache[require.resolve('../backend/db')];
  delete require.cache[require.resolve('../backend/server')];
  const app = require('../backend/server');
  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;
  return {
    baseUrl,
    dbPath,
    async stop() {
      await new Promise(resolve => server.close(resolve));
      [dbPath, dbPath + '-wal', dbPath + '-shm'].forEach(f => { try { fs.unlinkSync(f); } catch (e) { /* fine if it never existed */ } });
    },
  };
}

async function api(baseUrl, path, { method, token, body } = {}) {
  const res = await fetch(baseUrl + path, {
    method: method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* some responses may have no body */ }
  return { status: res.status, data };
}

async function login(baseUrl, username, password) {
  const { data } = await api(baseUrl, '/api/auth/login', { method: 'POST', body: { username, password } });
  return data.token;
}

async function createMember(baseUrl, adminToken, username, name, team) {
  await api(baseUrl, '/api/users', { method: 'POST', token: adminToken, body: { username, password: 'TestPass123', name, role: 'member', team: team || 'Test Team' } });
  return login(baseUrl, username, 'TestPass123');
}

function futureDate(daysFromNow) {
  return new Date(Date.now() + (daysFromNow ?? 5) * 86400000).toISOString().slice(0, 10);
}

module.exports = { startTestServer, api, login, createMember, futureDate };
