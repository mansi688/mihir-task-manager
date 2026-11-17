/* Updates page — every change to the app, version by version (newest first), for everyone.
   Data: GET /api/updates (read from CHANGELOG.md on the server). The menu badge counts versions released since the
   person last opened this page (kept per user on this device). Loaded before app.js. */

let updData = null;
let updLoading = false;
const UPD_KIND = { Added: { icon: '✨', cls: 'upd-added' }, Changed: { icon: '🔄', cls: 'upd-changed' }, Fixed: { icon: '🛠', cls: 'upd-fixed' },
  Removed: { icon: '🗑', cls: 'upd-removed' }, Restored: { icon: '↩️', cls: 'upd-changed' }, Security: { icon: '🔒', cls: 'upd-fixed' } };
function updEsc(s) { return typeof esc === 'function' ? esc(s) : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function updMd(s) {
  return updEsc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
}
function updState() { if (!ui.upd) ui.upd = { q: '', kind: 'all', onlyNew: false, open: {}, all: false }; return ui.upd; }
function updSeenKey() { return `upd_seen_${session && session.username}`; }
function updSeenVersion() { try { return safeStorage.getItem(updSeenKey()) || ''; } catch (e) { return ''; } }
function updSetSeen(v) { try { safeStorage.setItem(updSeenKey(), v); } catch (e) {} }
function updDate(ymd) { try { return new Date(`${ymd}T12:00:00+05:30`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }); } catch (e) { return ymd || ''; } }
function updMonth(ymd) { try { return new Date(`${ymd}T12:00:00+05:30`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' }); } catch (e) { return ''; } }
async function updLoad(force) {
  if (updLoading || (updData && !force)) return;
  updLoading = true;
  try {
    const d = await api('/api/updates');
    updData = d;
    // First time on this device: start counting from now, so the badge isn't every version ever made.
    if (!updSeenVersion() && d.current) updSetSeen(d.current);
  } catch (e) { updData = { error: e.message, versions: [] }; }
  updLoading = false;
  render();
}
// Versions newer than the one the person last saw (list is newest first).
function updNewCount(seen) {
  if (!updData || !updData.versions) { if (session && !updLoading && !updData) setTimeout(() => updLoad(), 0); return 0; }
  const s = seen != null ? seen : updSeenVersion();
  if (!s) return 0;
  const i = updData.versions.findIndex(v => v.version === s);
  return i < 0 ? 0 : i;
}
function updMarkSeen() {
  if (!updData || !updData.current) return;
  if (ui.updSeenBefore == null) ui.updSeenBefore = updSeenVersion();
  if (updSeenVersion() !== updData.current) updSetSeen(updData.current);
}

function renderUpdatesView() {
  const s = updState();
  if (!updData) { setTimeout(() => updLoad(), 0); return '<div class="empty">Loading updates…</div>'; }
  if (updData.error) return `<div class="err">${updEsc(updData.error)}</div>`;
  updMarkSeen();
  const all = updData.versions || [];
  const newN = updNewCount(ui.updSeenBefore || '');
  const words = String(s.q || '').toLowerCase().split(/\s+/).filter(Boolean);
  const hit = (txt) => !words.length || words.every(w => txt.toLowerCase().includes(w));
  const list = [];
  all.forEach((v, i) => {
    if (s.onlyNew && i >= newN) return;
    const head = `${v.version} ${v.title} ${v.date}`;
    const sections = v.sections.filter(x => s.kind === 'all' || x.name === s.kind).map(x => ({
      ...x, items: x.items.filter(it => hit(head) || hit(`${x.name} ${it.text} ${(it.sub || []).join(' ')}`)),
    })).filter(x => x.items.length);
    if (sections.length) list.push({ v, i, sections, isNew: i < newN });
  });
  const kinds = ['all', 'Added', 'Changed', 'Fixed', 'Removed'];
  const counts = { Added: 0, Changed: 0, Fixed: 0, Removed: 0 };
  all.forEach(v => v.sections.forEach(x => { if (counts[x.name] != null) counts[x.name] += x.items.length; }));
  const first = all[all.length - 1];
  const searching = words.length > 0 || s.kind !== 'all' || s.onlyNew;
  let month = '';
  const cards = list.map(({ v, i, sections, isNew }) => {
    const open = s.all || searching || (s.open[v.version] != null ? s.open[v.version] : i < 3);
    const n = sections.reduce((a, x) => a + x.items.length, 0);
    const m = updMonth(v.date);
    const sep = m && m !== month ? `<div class="upd-month">${updEsc(m)}</div>` : '';
    month = m || month;
    return `${sep}<div class="card upd-card ${i === 0 ? 'upd-current' : ''}">
      <button type="button" class="upd-head" data-upd-toggle="${updEsc(v.version)}" aria-expanded="${open}">
        <span class="upd-ver">${updEsc(v.version)}</span>
        <span class="upd-title"><b>${updMd(v.title)}</b><span class="small muted">${updDate(v.date)} · ${n} change${n === 1 ? '' : 's'}</span></span>
        ${i === 0 ? '<span class="upd-pill-cur">Current</span>' : ''}${isNew ? '<span class="upd-pill-new">New</span>' : ''}
        <span class="upd-chev">${open ? '▾' : '▸'}</span>
      </button>
      ${open ? `<div class="upd-body">${sections.map(x => {
        const k = UPD_KIND[x.name] || { icon: x.tech ? '⚙️' : '•', cls: x.tech ? 'upd-tech' : 'upd-changed' };
        return `<div class="upd-sec ${k.cls}"><div class="upd-sec-name">${k.icon} ${updEsc(x.name)}${x.tech ? ' <span class="small muted">(Admin only)</span>' : ''}</div>
          <ul>${x.items.map(it => `<li>${updMd(it.text)}${it.sub && it.sub.length ? `<ul>${it.sub.map(t => `<li>${updMd(t)}</li>`).join('')}</ul>` : ''}</li>`).join('')}</ul></div>`;
      }).join('')}</div>` : ''}
    </div>`;
  }).join('');
  return `
  <div class="card upd-hero">
    <div class="upd-hero-row">
      <div><div class="small muted">You are on</div><div class="upd-hero-ver">${updEsc(updData.current || '')}</div>
        <div class="small muted">${all.length} versions${first ? ` since ${updDate(first.date)}` : ''} · ${counts.Added} added · ${counts.Changed} changed · ${counts.Fixed} fixed</div></div>
      ${newN ? `<div class="upd-hero-new">🎉 <b>${newN}</b> new version${newN === 1 ? '' : 's'} since your last visit</div>` : '<div class="small muted">You have seen every update.</div>'}
    </div>
    <div class="upd-tools">
      <input type="search" id="upd-q" placeholder="Search updates (e.g. payslip, location, DPR)…" value="${updEsc(s.q)}" autocomplete="off">
      <div class="upd-chips">${kinds.map(k => `<button type="button" class="btn btn-sm ${s.kind === k ? 'btn-primary' : ''}" data-upd-kind="${k}">${k === 'all' ? 'All' : `${UPD_KIND[k].icon} ${k}`}</button>`).join('')}
        ${newN ? `<button type="button" class="btn btn-sm ${s.onlyNew ? 'btn-primary' : ''}" data-upd-new>🆕 New only</button>` : ''}
        <button type="button" class="btn btn-sm" data-upd-all>${s.all ? 'Collapse' : 'Expand all'}</button></div>
    </div>
  </div>
  ${cards || '<div class="empty">No update matches your search.</div>'}`;
}

function bindUpdatesView() {
  const s = updState();
  const q = document.getElementById('upd-q');
  if (q && !q.dataset.bound) {
    q.dataset.bound = '1';
    let t = null;
    q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { s.q = q.value; render(); }, 180); });
  }
  document.querySelectorAll('[data-upd-toggle]').forEach(b => { b.onclick = () => {
    const v = b.dataset.updToggle; const cur = b.getAttribute('aria-expanded') === 'true';
    s.open[v] = !cur; if (s.all && cur) s.all = false; render();
  }; });
  document.querySelectorAll('[data-upd-kind]').forEach(b => { b.onclick = () => { s.kind = b.dataset.updKind; render(); }; });
  document.querySelectorAll('[data-upd-new]').forEach(b => { b.onclick = () => { s.onlyNew = !s.onlyNew; render(); }; });
  document.querySelectorAll('[data-upd-all]').forEach(b => { b.onclick = () => { s.all = !s.all; if (!s.all) s.open = {}; render(); }; });
}
