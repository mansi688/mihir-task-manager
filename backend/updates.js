/* Updates — every change made to the app, version by version, for everyone to read.

   Source: CHANGELOG.md at the repo root (it ships with every upload). Each `## ` heading is one version:
     ## [v1.55] — 2026-11-17 — Live selfie camera; attendance on the payslip
   A heading written as `## [Unreleased] — Title` (or with no version) is numbered automatically as the next
   version and dated the day this server copy started, so a new update shows up without editing anything else.
   Sections are the `### ` lines (Added / Changed / Fixed / Removed …); bullets under them are the items.
   Admin only (the page and this API). Technical sections (Database, API, Tests…) included.

   GET /api/updates → { current, versions: [{ version, date, title, sections: [{ name, items }] }] } (newest first) */
const fs = require('fs');
const path = require('path');

const TECH = /^(database|environment|api|tests?|rollback|deploy|migrations?)\b/i;
const FILE = process.env.CHANGELOG_PATH || path.join(__dirname, '..', 'CHANGELOG.md');

function parseChangelog(text, today) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const out = [];
  let cur = null, sec = null, item = null;
  const pushItem = (t) => { if (!sec) { sec = { name: 'Notes', items: [] }; cur.sections.push(sec); } item = { text: t, sub: [] }; sec.items.push(item); };
  for (const raw of lines) {
    if (/^## /.test(raw)) {
      const h = raw.slice(3).trim();
      let m = h.match(/^\[?\s*(v?\d+(?:\.\d+)*|unreleased)\s*\]?\s*(?:—|-{1,2}|:)?\s*(.*)$/i);
      let version = null, rest = h;
      if (m) { version = /^unreleased$/i.test(m[1]) ? null : (m[1][0].toLowerCase() === 'v' ? m[1] : 'v' + m[1]); rest = m[2]; }
      let date = null;
      const d = rest.match(/^(\d{4}-\d{2}-\d{2})\s*(?:—|-{1,2}|:)?\s*(.*)$/);
      if (d) { date = d[1]; rest = d[2]; }
      cur = { version, date, title: rest.replace(/^[\[\]\s—-]+/, '').trim() || 'Update', sections: [] };
      out.push(cur); sec = null; item = null;
      continue;
    }
    if (!cur) continue;
    if (/^### /.test(raw)) {
      const h = raw.slice(4).trim();
      const c = h.match(/^([^:]+):\s*(.+)$/);
      sec = { name: (c ? c[1] : h).trim(), items: [] };
      cur.sections.push(sec); item = null;
      if (c) pushItem(c[2].trim());
      continue;
    }
    const b = raw.match(/^(\s*)[-*] (.*)$/);
    if (b) {
      if (b[1].length >= 2 && item) { item.sub.push(b[2].trim()); }
      else pushItem(b[2].trim());
      continue;
    }
    if (/^\s+\S/.test(raw) && item) {
      if (item.sub.length) item.sub[item.sub.length - 1] += ' ' + raw.trim();
      else item.text += ' ' + raw.trim();
      continue;
    }
    if (raw.trim() && !/^#/.test(raw) && cur) { pushItem(raw.trim()); }
  }
  // Number the versions that don't carry one: one above the highest number below them (oldest first).
  const num = (v) => (v || '').replace(/^v/, '').split('.').map(Number);
  let last = [1, -1];
  for (let i = out.length - 1; i >= 0; i--) {
    const v = out[i];
    if (v.version) { last = num(v.version); continue; }
    last = [last[0] || 1, (last[1] == null ? 0 : last[1]) + 1];
    v.version = `v${last[0]}.${last[1]}`;
    v.date = v.date || today;
    v.unreleased = true;
  }
  for (const v of out) {
    v.sections = v.sections.filter(s => s.items.length);
    for (const s of v.sections) s.tech = TECH.test(s.name);
  }
  return out;
}

function mountUpdates(app, { auth, ALL_ROLES }) {
  const started = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10); // IST day
  let cache = null, mtime = 0;
  const load = () => {
    try {
      const st = fs.statSync(FILE);
      if (!cache || st.mtimeMs !== mtime) { cache = parseChangelog(fs.readFileSync(FILE, 'utf8'), started); mtime = st.mtimeMs; }
    } catch (e) { cache = cache || []; }
    return cache;
  };
  app.get('/api/updates', auth(['admin']), (req, res) => {
    const admin = req.user.role === 'admin';
    const versions = load().map(v => ({
      version: v.version, date: v.date, title: v.title,
      sections: v.sections.filter(s => admin || !s.tech).map(s => ({ name: s.name, tech: !!s.tech, items: s.items })),
    })).filter(v => v.sections.length || admin);
    res.setHeader('Cache-Control', 'no-cache');
    res.json({ current: versions[0] ? versions[0].version : null, versions });
  });
}

module.exports = { mountUpdates, parseChangelog };
