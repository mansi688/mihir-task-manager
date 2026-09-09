// Shared setup for every test file: a fresh, isolated Postgres SCHEMA per test file (never your
// real data), and the real Express app started on an ephemeral port, so tests hit the exact same
// code paths a real request would — not a mocked-out version of the app.
//
// startTestServer() is now ASYNC (it wasn't when this used synchronous SQLite) — requiring
// server.js as a module no longer runs db.init() automatically (that only happens when
// server.js is executed directly, guarded by `if (require.main === module)`), so this calls
// db.init() itself before starting to listen, same as a real deployment's startup sequence.
const { Client } = require('pg');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres:testpass@localhost:5432/taskmanager_test';

async function startTestServer() {
  const schema = `test_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const url = new URL(TEST_DATABASE_URL);
  url.searchParams.set('options', `-c search_path=${schema},public`);
  process.env.DATABASE_URL = url.toString();
  process.env.PGSSLMODE = 'disable';
  process.env.JWT_SECRET = 'test-secret-not-for-real-use-' + Math.random().toString(36);
  delete require.cache[require.resolve('../backend/db')];
  delete require.cache[require.resolve('../backend/server')];

  const setupClient = new Client({ connectionString: TEST_DATABASE_URL });
  await setupClient.connect();
  await setupClient.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  await setupClient.end();

  const db = require('../backend/db');
  await db.init();
  const app = require('../backend/server');
  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;

  return {
    baseUrl,
    schema,
    // For tests that need to directly manipulate timestamps/rows (backdating a task's
    // escalation clock, etc.) — a raw Postgres client already pointed at this exact test's
    // isolated schema, replacing the old `new Database(dbPath)` pattern from the SQLite days.
    async getRawClient() {
      const client = new Client({ connectionString: TEST_DATABASE_URL });
      await client.connect();
      await client.query(`SET search_path TO "${schema}", public`);
      return client;
    },
    async stop() {
      await new Promise(resolve => server.close(resolve));
      await db.pool.end();
      const client = new Client({ connectionString: TEST_DATABASE_URL });
      await client.connect();
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await client.end();
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
