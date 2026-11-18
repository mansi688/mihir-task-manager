const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember } = require('../testlib/helpers');
const { parseChangelog } = require('../backend/updates');

test('changelog parses into numbered versions; unreleased entries get the next number', () => {
  const v = parseChangelog([
    '# Changelog', 'intro',
    '## [Unreleased] — Newest thing', '### Added', '- **Bold** item', '  continues here', '  - sub point',
    '## [v1.4] — 2026-11-01 — Older', '### Fixed', '- a fix', '### Database: new column `x`.',
    '## [v1.3] — 2026-10-01 — Oldest', '- loose line',
  ].join('\n'), '2026-11-18');
  assert.deepEqual(v.map(x => x.version), ['v1.5', 'v1.4', 'v1.3']);
  assert.equal(v[0].date, '2026-11-18');
  assert.equal(v[0].title, 'Newest thing');
  assert.deepEqual(v[0].sections[0].items[0], { text: '**Bold** item continues here', sub: ['sub point'] });
  assert.equal(v[1].sections[1].name, 'Database');
  assert.equal(v[1].sections[1].tech, true);
  assert.equal(v[2].sections[0].items[0].text, 'loose line');
});

test('the real CHANGELOG has a version and date on every entry', () => {
  const v = parseChangelog(require('fs').readFileSync(require('path').join(__dirname, '..', 'CHANGELOG.md'), 'utf8'), '2026-11-18');
  assert.ok(v.length > 50);
  for (const x of v) { assert.match(x.version, /^v\d+\.\d+$/); assert.match(x.date, /^\d{4}-\d{2}-\d{2}$/); assert.ok(x.title); }
  assert.equal(new Set(v.map(x => x.version)).size, v.length, 'versions are unique');
  assert.equal(v[v.length - 1].version, 'v1.0');
});

test('/api/updates: Admin only, with technical notes', async (t) => {
  const { baseUrl, stop } = await startTestServer();
  t.after(stop);
  const admin = await login(baseUrl, 'admin', 'admin123');
  const m = await createMember(baseUrl, admin, 'upd.user', 'Upd User', 'Store Department');
  const a = await api(baseUrl, '/api/updates', { token: admin });
  assert.equal(a.status, 200);
  assert.equal(a.data.current, a.data.versions[0].version);
  assert.ok(a.data.versions.some(v => v.sections.some(s => s.tech)), 'admin sees Database notes');
  assert.equal((await api(baseUrl, '/api/updates', { token: m })).status, 403);
  assert.equal((await api(baseUrl, '/api/updates', {})).status, 401);
});
