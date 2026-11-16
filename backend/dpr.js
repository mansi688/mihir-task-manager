/* Daily Progress Report (DPR) — what the site did each day, and the material that came in and went out.

   A report is one project on one day. Its entries are of three kinds:
   - work     — work done (activity, quantity, unit, location, contractor / agency)
   - inward   — material received at site (from whom, challan / GRN no., time)
   - outward  — material issued from the store (issued to whom, gate pass / ref, time)
   Each entry keeps its time stamp. Entries are typed on the page or imported from the site's Excel / CSV
   (one sheet per kind, or one sheet with a "Type" column; dates per row or a "Date:" line at the top).
   Importing the same day again only adds rows that are not there already.

   Who: Admin, the site team (Execution), the Store and Purchase departments see it; Admin, site and store add
   and import; Purchase reads. Data: GET /api/dpr (reports + entries + material totals for the filter). */
const ExcelJS = require('exceljs');
const { decodeDataUrl, excelCellValue, stripXlsxComments, parseCSV } = require('./task-import');

const KINDS = ['work', 'inward', 'outward'];
const KIND_LABEL = { work: 'Work progress', inward: 'Material inward', outward: 'Material outward' };
const MAX_IMPORT_CHARS = 14 * 1024 * 1024;
const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[\s._:()\[\]\-\/#&]+/g, ' ').trim();
const text = (v) => v instanceof Date ? v.toISOString() : String(v == null ? '' : v).trim();
const COLS = {
  type: ['type', 'entry type', 'in out', 'inward outward', 'movement', 'kind', 'category'],
  date: ['date', 'dpr date', 'report date', 'day', 'entry date'],
  time: ['time', 'timestamp', 'time stamp', 'in time', 'out time', 'entry time', 'issue time', 'issued at', 'received at', 'receipt time', 'date time', 'date and time', 'datetime', 'gate in time', 'gate out time'],
  item: ['material', 'material name', 'item', 'item name', 'activity', 'work', 'work done', 'work item', 'description of work', 'nature of work', 'particulars', 'material description'],
  description: ['description', 'details', 'specification', 'spec', 'size', 'grade', 'make'],
  qty: ['qty', 'quantity', 'received qty', 'issued qty', 'qty received', 'qty issued', 'work done qty', 'progress qty', 'done qty', 'nos', 'qty nos'],
  unit: ['unit', 'uom', 'units'],
  location: ['location', 'area', 'tower', 'floor', 'block', 'wing', 'building', 'flat', 'level'],
  party: ['issued to', 'issue to', 'given to', 'handed to', 'received by', 'contractor', 'agency', 'sub contractor', 'subcontractor', 'labour contractor', 'supplier', 'vendor', 'received from', 'party', 'person', 'name', 'team'],
  ref: ['challan', 'challan no', 'dc no', 'delivery challan', 'gate pass', 'gate pass no', 'mrn', 'mrn no', 'grn', 'grn no', 'invoice no', 'bill no', 'ref', 'ref no', 'reference', 'vehicle no', 'vehicle number'],
  remarks: ['remarks', 'remark', 'notes', 'note', 'comments', 'comment'],
  project: ['project', 'site', 'project name', 'site name'],
};
const kindOf = (v) => {
  const k = norm(v);
  if (!k) return null;
  if (/^in$|\b(inward|inwards|receipt|receipts|received|grn|incoming|material in)\b/.test(k)) return 'inward';
  if (/^out$|\b(outward|outwards|issue|issued|issues|consumption|outgoing|material out|gate pass)\b/.test(k)) return 'outward';
  if (/\b(work|works|progress|activity|activities|dpr|execution)\b/.test(k)) return 'work';
  return null;
};
function numOf(v) {
  if (v == null || v === '' || v instanceof Date) return null;
  const s = String(v).replace(/,/g, '').trim();
  if (!/^-?\d*\.?\d+(e-?\d+)?$/i.test(s)) return null;
  const n = Number(s); return isFinite(n) ? n : null;
}
const pad = (n) => String(n).padStart(2, '0');
// A date cell or text → YYYY-MM-DD (day first for text like 12/11/2026, as written in India)
function ymdOf(v) {
  if (v instanceof Date) { if (v.getUTCFullYear() < 1905) return null; return `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`; }
  const s = text(v); let m;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/.exec(s))) { const y = m[3].length === 2 ? `20${m[3]}` : m[3]; const d = Number(m[1]), mo = Number(m[2]); if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return `${y}-${pad(mo)}-${pad(d)}`; }
  if ((m = /^(\d{1,2})[\s-]([a-z]{3})[a-z]*[\s,-]+(\d{4})/i.exec(s))) { const mo = 'janfebmaraprmayjunjulaugsepoctnovdec'.indexOf(m[2].toLowerCase()) / 3 + 1; if (mo >= 1) return `${m[3]}-${pad(mo)}-${pad(Number(m[1]))}`; }
  return null;
}
// A time cell or text → HH:MM (24 h). Excel keeps a time-only cell as a date on 30 Dec 1899.
function hmOf(v) {
  if (v instanceof Date) return `${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}`;
  const s = text(v); let m;
  if ((m = /(\d{1,2})[:.](\d{2})\s*(am|pm)?/i.exec(s))) {
    let h = Number(m[1]); const mi = Number(m[2]); const ap = (m[3] || '').toLowerCase();
    if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0;
    if (h <= 23 && mi <= 59) return `${pad(h)}:${pad(mi)}`;
  }
  const n = numOf(v); // Excel fraction of a day
  if (n != null && n >= 0 && n < 1) { const mins = Math.round(n * 1440); return `${pad(Math.floor(mins / 60) % 24)}:${pad(mins % 60)}`; }
  return '';
}

function findHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const cells = (rows[i] || []).map(norm);
    const map = {};
    // exact heading first, then a heading that starts with a known name ("Material / Activity", "Issued to / Received from")
    cells.forEach((c, idx) => { if (!c) return; for (const [k, al] of Object.entries(COLS)) if (map[k] == null && al.includes(c)) { map[k] = idx; return; } });
    const used = new Set(Object.values(map));
    cells.forEach((c, idx) => { if (!c || used.has(idx)) return; for (const [k, al] of Object.entries(COLS)) if (map[k] == null && al.some(a => a.length >= 3 && (c.startsWith(a + ' ') || c === a))) { map[k] = idx; used.add(idx); return; } });
    if (map.item == null && map.description != null) { map.item = map.description; delete map.description; }
    if (map.item != null && (map.qty != null || map.party != null || map.time != null || map.type != null || map.unit != null)) return { index: i, map };
  }
  return null;
}
function readMeta(rows, upto) {
  const meta = {};
  for (let i = 0; i < upto; i++) {
    const r = rows[i] || [];
    for (let c = 0; c < r.length; c++) {
      const raw = r[c]; if (raw == null || raw === '') continue;
      const s = text(raw); const colon = s.indexOf(':');
      let label, value;
      if (colon > 0 && colon < 30) { label = norm(s.slice(0, colon)); value = s.slice(colon + 1).trim() || r[c + 1]; }
      else { label = norm(s); value = r[c + 1]; }
      if (value == null || text(value) === '') continue;
      if (meta.date == null && COLS.date.includes(label)) meta.date = ymdOf(value);
      if (meta.project == null && COLS.project.includes(label)) meta.project = text(value).slice(0, 120);
    }
  }
  return meta;
}
// One sheet → entries [{ kind, date, time, item, ... }]
function sheetToEntries(rows, sheetName) {
  const h = findHeader(rows); if (!h) return { entries: [], skipped: true, warnings: [] };
  const meta = readMeta(rows, h.index);
  const sheetKind = kindOf(sheetName);
  const M = h.map, warnings = [], entries = [];
  for (let i = h.index + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const get = (k) => (M[k] == null ? null : r[M[k]]);
    const item = text(get('item'));
    if (!item) continue;
    if (/^(sub[\s-]*)?total\b|^grand total/i.test(item)) continue;
    const kind = kindOf(get('type')) || sheetKind || (M.type == null ? 'work' : null);
    if (!kind) { warnings.push(`${sheetName} row ${i + 1}: "Type" should be Work, Inward or Outward — row skipped.`); continue; }
    const timeCell = get('time');
    let date = ymdOf(get('date')) || (timeCell instanceof Date && timeCell.getUTCFullYear() > 1905 ? ymdOf(timeCell) : null) || ymdOf(timeCell) || meta.date || null;
    const qtyRaw = get('qty');
    const qty = numOf(qtyRaw);
    if (qtyRaw != null && text(qtyRaw) !== '' && qty == null) warnings.push(`${sheetName} row ${i + 1}: quantity "${text(qtyRaw)}" is not a number — kept without a quantity.`);
    entries.push({
      kind, date, time: hmOf(timeCell), item: item.slice(0, 300), description: text(get('description')).slice(0, 500),
      qty, unit: text(get('unit')).slice(0, 20), location: text(get('location')).slice(0, 200), party: text(get('party')).slice(0, 200),
      ref: text(get('ref')).slice(0, 120), remarks: text(get('remarks')).slice(0, 500), project: text(get('project')).slice(0, 120) || meta.project || '',
      row: i + 1, sheet: sheetName,
    });
  }
  return { entries, warnings };
}
async function readDprFile(dataUrl, fileName) {
  const err = (m) => Object.assign(new Error(m), { isImportError: true });
  if (!dataUrl) throw err('Choose the Excel file first.');
  if (String(dataUrl).length > MAX_IMPORT_CHARS) throw err('That file is too large (max ~10 MB).');
  const buf = decodeDataUrl(dataUrl);
  const name = String(fileName || '').toLowerCase();
  const zip = buf.length > 3 && buf[0] === 0x50 && buf[1] === 0x4b;
  if (name.endsWith('.xls') && !zip) throw err('Old .xls files are not supported — in Excel use File → Save As → "Excel Workbook (.xlsx)".');
  const sheets = [];
  if (zip) {
    let wb = new ExcelJS.Workbook();
    try { await wb.xlsx.load(buf); } catch (e) {
      try { wb = new ExcelJS.Workbook(); await wb.xlsx.load(await stripXlsxComments(buf)); } catch (e2) { throw err("This Excel file couldn't be opened. Save it as .xlsx and try again."); }
    }
    for (const ws of wb.worksheets) {
      if (ws.state === 'hidden' || ws.state === 'veryHidden') continue;
      const rows = [];
      ws.eachRow({ includeEmpty: true }, (row, n) => { const v = []; for (let c = 1; c <= Math.max(ws.actualColumnCount || 0, row.cellCount); c++) v.push(excelCellValue(row.getCell(c).value)); rows[n - 1] = v; });
      for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
      sheets.push({ name: ws.name, rows });
    }
  } else sheets.push({ name: (fileName || 'Sheet').replace(/\.[^.]+$/, ''), rows: parseCSV(buf.toString('utf8')) });
  const out = { entries: [], warnings: [], sheetsRead: [], sheetsSkipped: [] };
  for (const s of sheets) {
    const r = sheetToEntries(s.rows, s.name);
    if (r.skipped || !r.entries.length) { out.sheetsSkipped.push(s.name); out.warnings.push(...(r.warnings || [])); continue; }
    out.sheetsRead.push(s.name); out.entries.push(...r.entries); out.warnings.push(...r.warnings);
  }
  if (!out.entries.length) throw err('No DPR table found. A sheet needs a heading row with Material / Item / Activity and at least one of Qty, Unit, Time, Issued to or Type — download the template to see the layout.');
  if (out.entries.length > 3000) throw err(`That is ${out.entries.length} rows — import at most 3000 at a time.`);
  return out;
}
async function buildDprTemplate() {
  const wb = new ExcelJS.Workbook();
  const head = (ws, cols) => { const r = ws.addRow(cols); r.font = { bold: true }; r.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF7' } }; }); };
  const meta = (ws) => { ws.addRow(['Project:', 'Mihir Amara']); ws.addRow(['Date:', '16-11-2026']); ws.addRow([]); };
  const w = wb.addWorksheet('Work progress'); meta(w);
  head(w, ['Time', 'Activity', 'Location', 'Qty', 'Unit', 'Contractor', 'Remarks']);
  w.addRow(['10:30', 'Block work 150 mm', 'Tower B, 4th floor', 42, 'sqm', 'Shree Builders', '']);
  w.addRow(['16:00', 'Slab casting', 'Tower A, 9th floor', 38, 'cum', 'RMC — Ultratech', 'Pump came late']);
  const i = wb.addWorksheet('Material inward'); meta(i);
  head(i, ['Time', 'Material', 'Qty', 'Unit', 'Received from', 'Challan no', 'Vehicle no', 'Remarks']);
  i.addRow(['09:15', 'Cement OPC 53', 200, 'bags', 'Ganesh Traders', 'GT-4411', 'MH12 AB 1234', '']);
  i.addRow(['11:40', 'TMT 12 mm', 3.2, 'MT', 'Shree Steel', 'SS-208', '', 'Weighbridge slip attached']);
  const o = wb.addWorksheet('Material outward'); meta(o);
  head(o, ['Time', 'Material', 'Qty', 'Unit', 'Issued to', 'Location', 'Gate pass', 'Remarks']);
  o.addRow(['10:05', 'Cement OPC 53', 60, 'bags', 'Shree Builders (block work)', 'Tower B, 4th floor', 'GP-118', '']);
  o.addRow(['14:20', 'Binding wire', 25, 'kg', 'Rahul — steel fixer', 'Tower A, 9th floor', 'GP-119', '']);
  for (const ws of [w, i, o]) ws.columns = [{ width: 10 }, { width: 28 }, { width: 22 }, { width: 10 }, { width: 10 }, { width: 28 }, { width: 16 }, { width: 24 }];
  const one = wb.addWorksheet('One sheet (optional)');
  one.addRow(['Project:', 'Mihir Amara']); one.addRow([]);
  head(one, ['Date', 'Time', 'Type', 'Material / Activity', 'Qty', 'Unit', 'Issued to / Received from / Contractor', 'Ref (challan / gate pass)', 'Location', 'Remarks']);
  one.addRow(['16-11-2026', '09:15', 'Inward', 'Sand (river)', 4, 'brass', 'Patil Suppliers', 'PS-77', '', '']);
  one.addRow(['16-11-2026', '12:30', 'Outward', 'Sand (river)', 1, 'brass', 'Plaster team — Amit', 'GP-120', 'Tower C', '']);
  one.addRow(['16-11-2026', '17:00', 'Work', 'Internal plaster', 120, 'sqm', 'Amit Contractors', '', 'Tower C, 2nd floor', '']);
  one.columns = [{ width: 12 }, { width: 8 }, { width: 10 }, { width: 26 }, { width: 8 }, { width: 8 }, { width: 32 }, { width: 22 }, { width: 18 }, { width: 20 }];
  const help = wb.addWorksheet('How to fill');
  ['Use the three sheets (Work progress, Material inward, Material outward) — or put everything on one sheet with a "Type" column (Work / Inward / Outward).',
    'Project and Date at the top apply to every row of that sheet; a "Date" column overrides it per row. If neither is there, the date and project picked on the screen are used.',
    'Time is the time stamp of the entry (e.g. 14:20 or 2:20 PM).',
    'Columns can be in any order; extra columns are ignored. Only the Material / Activity column is required.',
    'Importing the same day again only adds rows that are not there already.',
  ].forEach(t => help.addRow([t]));
  help.getColumn(1).width = 130;
  return wb.xlsx.writeBuffer();
}

function mountDpr(app, deps) {
  const { db, auth, ALL_ROLES, auditFromReq, str, PROJECT_OPTIONS } = deps;
  const q = (sql, params = []) => db.pool.query(sql, params);
  const rows = async (sql, params) => (await q(sql, params)).rows;
  const one = async (sql, params) => (await q(sql, params)).rows[0] || null;
  const now = () => new Date().toISOString();
  const istToday = () => { const d = new Date(Date.now() + 330 * 60000); return d.toISOString().slice(0, 10); };
  const validDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null;

  async function me(user) {
    const u = await db.getUserFresh(user.username);
    const team = String((u && u.team) || '');
    const admin = user.role === 'admin';
    const site = /execution|site/i.test(team), store = /store/i.test(team), purchase = /purchase/i.test(team);
    return { username: user.username, name: (u && u.name) || user.name, admin, team, canView: admin || site || store || purchase, canEdit: admin || site || store };
  }
  const NOT_ALLOWED = 'The Daily Progress page is for Admin, the site team, Store and Purchase.';
  async function reportFor(project, date, m, sourceFile) {
    const ex = await one('SELECT * FROM dpr_reports WHERE project=$1 AND report_date=$2', [project, date]);
    if (ex) return ex;
    return one(`INSERT INTO dpr_reports(project, report_date, created_by, created_by_name, source_file, created_at, updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$6) ON CONFLICT (project, report_date) DO UPDATE SET updated_at=EXCLUDED.updated_at RETURNING *`, [project, date, m.username, m.name, sourceFile || null, now()]);
  }
  const entryKey = (e) => [e.kind, e.at_time || '', norm(e.item), e.qty == null ? '' : Number(e.qty), norm(e.unit), norm(e.party), norm(e.ref), norm(e.location)].join('|');
  function cleanEntry(b) {
    const kind = KINDS.includes(str(b.kind)) ? str(b.kind) : null;
    const qty = b.qty === '' || b.qty == null ? null : numOf(b.qty);
    return {
      kind, at_time: hmOf(str(b.time || b.at_time)), item: str(b.item).trim().slice(0, 300), description: str(b.description).trim().slice(0, 500), qty,
      unit: str(b.unit).trim().slice(0, 20), location: str(b.location).trim().slice(0, 200), party: str(b.party).trim().slice(0, 200), ref: str(b.ref).trim().slice(0, 120), remarks: str(b.remarks).trim().slice(0, 500),
    };
  }
  async function insertEntries(reportId, list, m, source) {
    const existing = new Set((await rows('SELECT * FROM dpr_entries WHERE report_id=$1', [reportId])).map(entryKey));
    let added = 0, dup = 0;
    for (const e of list) {
      const k = entryKey(e);
      if (existing.has(k)) { dup++; continue; }
      existing.add(k);
      await q(`INSERT INTO dpr_entries(report_id, kind, at_time, item, description, qty, unit, location, party, ref, remarks, source, created_by, created_by_name, created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`, [reportId, e.kind, e.at_time || null, e.item, e.description || null, e.qty, e.unit || null, e.location || null, e.party || null, e.ref || null, e.remarks || null, source, m.username, m.name, now()]);
      added++;
    }
    await q('UPDATE dpr_reports SET updated_at=$1 WHERE id=$2', [now(), reportId]);
    return { added, dup };
  }

  app.get('/api/dpr/summary', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user);
    if (!m.canView) return res.json({ canView: false });
    const t = await one("SELECT COUNT(*)::int AS n FROM dpr_reports WHERE report_date=$1", [istToday()]);
    res.json({ canView: true, canEdit: m.canEdit, today: istToday(), reportsToday: t ? t.n : 0 });
  });
  // Reports in a date range (default the last 7 days), with their entries and the material totals.
  app.get('/api/dpr', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user);
    if (!m.canView) return res.status(403).json({ error: NOT_ALLOWED });
    const to = validDay(req.query.to) || istToday();
    const from = validDay(req.query.from) || new Date(Date.parse(`${to}T12:00:00Z`) - 6 * 864e5).toISOString().slice(0, 10);
    const project = str(req.query.project).trim();
    const params = [from, to]; let where = 'r.report_date BETWEEN $1 AND $2';
    if (project) { params.push(project); where += ` AND r.project=$${params.length}`; }
    const reports = await rows(`SELECT r.* FROM dpr_reports r WHERE ${where} ORDER BY r.report_date DESC, r.project`, params);
    const ids = reports.map(r => r.id);
    const entries = ids.length ? await rows('SELECT * FROM dpr_entries WHERE report_id = ANY($1::int[]) ORDER BY report_id, at_time NULLS LAST, id', [ids]) : [];
    for (const r of reports) r.entries = entries.filter(e => e.report_id === r.id).map(e => ({ ...e, qty: e.qty == null ? null : Number(e.qty) }));
    // Material totals: inward vs outward per material + unit over the range.
    const mat = {};
    for (const e of entries) {
      if (e.kind === 'work') continue;
      const key = `${norm(e.item)}|${norm(e.unit)}`;
      const x = mat[key] || (mat[key] = { item: e.item, unit: e.unit || '', inward: 0, outward: 0, inCount: 0, outCount: 0 });
      if (e.kind === 'inward') { x.inward += Number(e.qty) || 0; x.inCount++; } else { x.outward += Number(e.qty) || 0; x.outCount++; }
    }
    const materials = Object.values(mat).map(x => ({ ...x, inward: Math.round(x.inward * 1000) / 1000, outward: Math.round(x.outward * 1000) / 1000, net: Math.round((x.inward - x.outward) * 1000) / 1000 })).sort((a, b) => a.item.localeCompare(b.item));
    res.json({ me: { canEdit: m.canEdit, admin: m.admin, username: m.username }, from, to, project, projects: PROJECT_OPTIONS, kinds: KIND_LABEL, today: istToday(), reports, materials });
  });
  // Add entries typed on the page (one or more) to the project's report for that day.
  app.post('/api/dpr/entries', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user);
    if (!m.canEdit) return res.status(403).json({ error: 'Only Admin, the site team and Store can add to the DPR.' });
    const b = req.body || {};
    const project = str(b.project).trim(); const date = validDay(b.date);
    if (!PROJECT_OPTIONS.includes(project)) return res.status(400).json({ error: 'Pick the project.' });
    if (!date) return res.status(400).json({ error: 'Pick the date.' });
    if (date > istToday()) return res.status(400).json({ error: 'The date cannot be in the future.' });
    const list = (Array.isArray(b.entries) ? b.entries : [b]).map(cleanEntry);
    for (const e of list) {
      if (!e.kind) return res.status(400).json({ error: 'Pick Work progress, Material inward or Material outward.' });
      if (!e.item) return res.status(400).json({ error: e.kind === 'work' ? 'Write the activity.' : 'Write the material.' });
      if (e.kind === 'outward' && !e.party) return res.status(400).json({ error: 'Write who the material was issued to.' });
    }
    const r = await reportFor(project, date, m, null);
    const out = await insertEntries(r.id, list, m, 'typed');
    await auditFromReq(req, 'dpr_entry_added', `DPR ${project} ${date}: added ${out.added} entr${out.added === 1 ? 'y' : 'ies'} (${[...new Set(list.map(e => KIND_LABEL[e.kind]))].join(', ')}).`);
    res.json({ ok: true, reportId: r.id, ...out });
  });
  app.patch('/api/dpr/entries/:id', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user);
    if (!m.canEdit) return res.status(403).json({ error: 'Only Admin, the site team and Store can change the DPR.' });
    const e = await one('SELECT * FROM dpr_entries WHERE id=$1', [Number(req.params.id) || 0]);
    if (!e) return res.status(404).json({ error: 'Entry not found.' });
    if (!m.admin && e.created_by !== m.username) return res.status(403).json({ error: 'Only the person who added it, or Admin, can change it.' });
    const c = cleanEntry({ ...e, time: e.at_time, ...(req.body || {}) });
    if (!c.item) return res.status(400).json({ error: 'The material / activity cannot be empty.' });
    await q('UPDATE dpr_entries SET at_time=$1, item=$2, description=$3, qty=$4, unit=$5, location=$6, party=$7, ref=$8, remarks=$9, updated_at=$10 WHERE id=$11',
      [c.at_time || null, c.item, c.description || null, c.qty, c.unit || null, c.location || null, c.party || null, c.ref || null, c.remarks || null, now(), e.id]);
    res.json({ ok: true });
  });
  app.delete('/api/dpr/entries/:id', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user);
    const e = await one('SELECT * FROM dpr_entries WHERE id=$1', [Number(req.params.id) || 0]);
    if (!e) return res.status(404).json({ error: 'Entry not found.' });
    if (!m.admin && !(m.canEdit && e.created_by === m.username)) return res.status(403).json({ error: 'Only the person who added it, or Admin, can remove it.' });
    await q('DELETE FROM dpr_entries WHERE id=$1', [e.id]);
    const left = await one('SELECT COUNT(*)::int AS n FROM dpr_entries WHERE report_id=$1', [e.report_id]);
    if (left && left.n === 0) await q('DELETE FROM dpr_reports WHERE id=$1', [e.report_id]);
    await auditFromReq(req, 'dpr_entry_removed', `DPR entry removed: ${KIND_LABEL[e.kind]} — ${e.item}${e.qty != null ? ` ${e.qty} ${e.unit || ''}` : ''}.`);
    res.json({ ok: true });
  });
  app.patch('/api/dpr/reports/:id', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user);
    if (!m.canEdit) return res.status(403).json({ error: 'Only Admin, the site team and Store can change the DPR.' });
    const r = await one('SELECT * FROM dpr_reports WHERE id=$1', [Number(req.params.id) || 0]);
    if (!r) return res.status(404).json({ error: 'Report not found.' });
    const b = req.body || {};
    await q('UPDATE dpr_reports SET manpower=$1, weather=$2, notes=$3, updated_at=$4 WHERE id=$5', [str(b.manpower).trim().slice(0, 300) || null, str(b.weather).trim().slice(0, 100) || null, str(b.notes).trim().slice(0, 2000) || null, now(), r.id]);
    res.json({ ok: true });
  });
  app.delete('/api/dpr/reports/:id', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user);
    const r = await one('SELECT * FROM dpr_reports WHERE id=$1', [Number(req.params.id) || 0]);
    if (!r) return res.status(404).json({ error: 'Report not found.' });
    if (!m.admin) return res.status(403).json({ error: 'Only Admin can delete a whole day\'s report.' });
    await q('DELETE FROM dpr_entries WHERE report_id=$1', [r.id]);
    await q('DELETE FROM dpr_reports WHERE id=$1', [r.id]);
    await auditFromReq(req, 'dpr_report_deleted', `Deleted the DPR of ${r.project} for ${r.report_date}.`);
    res.json({ ok: true });
  });
  app.get('/api/dpr/template', auth(ALL_ROLES), async (req, res) => {
    const buf = await buildDprTemplate();
    res.json({ name: 'DPR-template.xlsx', data: 'data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,' + Buffer.from(buf).toString('base64') });
  });
  // Import: { fileData, fileName, project, date, confirm } — without confirm it only reads the file and shows what
  // would be added; with confirm it saves.
  app.post('/api/dpr/import', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user);
    if (!m.canEdit) return res.status(403).json({ error: 'Only Admin, the site team and Store can import a DPR.' });
    const b = req.body || {};
    const fallbackProject = str(b.project).trim(); const fallbackDate = validDay(b.date) || null;
    let parsed;
    try { parsed = await readDprFile(b.fileData, str(b.fileName)); }
    catch (e) { if (e.isImportError) return res.status(400).json({ error: e.message }); throw e; }
    const warnings = [...parsed.warnings];
    const groups = new Map();
    for (const e of parsed.entries) {
      let project = e.project ? PROJECT_OPTIONS.find(p => norm(p) === norm(e.project) || norm(p).includes(norm(e.project)) || norm(e.project).includes(norm(p))) : null;
      if (e.project && !project) { warnings.push(`${e.sheet} row ${e.row}: project "${e.project}" is not one of ${PROJECT_OPTIONS.join(', ')} — used ${fallbackProject || 'the project picked on the screen'}.`); }
      project = project || fallbackProject;
      const date = e.date || fallbackDate;
      if (!PROJECT_OPTIONS.includes(project)) return res.status(400).json({ error: 'The file does not say the project — pick it on the screen and import again.' });
      if (!date) return res.status(400).json({ error: 'The file does not say the date — pick it on the screen (or add a "Date:" line / Date column) and import again.' });
      if (date > istToday()) { warnings.push(`${e.sheet} row ${e.row}: date ${date} is in the future — row skipped.`); continue; }
      const key = `${project}|${date}`;
      if (!groups.has(key)) groups.set(key, { project, date, entries: [] });
      groups.get(key).entries.push({ ...cleanEntry({ ...e, time: e.time }), kind: e.kind });
    }
    const days = [...groups.values()].sort((a, b) => a.date.localeCompare(b.date));
    const preview = days.map(d => ({ project: d.project, date: d.date, work: d.entries.filter(e => e.kind === 'work').length, inward: d.entries.filter(e => e.kind === 'inward').length, outward: d.entries.filter(e => e.kind === 'outward').length, sample: d.entries.slice(0, 5) }));
    if (!b.confirm) return res.json({ ok: true, preview: true, days: preview, rows: parsed.entries.length, sheetsRead: parsed.sheetsRead, sheetsSkipped: parsed.sheetsSkipped, warnings: warnings.slice(0, 50) });
    let added = 0, dup = 0;
    for (const d of days) {
      const r = await reportFor(d.project, d.date, m, str(b.fileName).slice(0, 200));
      const out = await insertEntries(r.id, d.entries, m, 'import');
      added += out.added; dup += out.dup;
    }
    await auditFromReq(req, 'dpr_imported', `Imported DPR "${str(b.fileName).slice(0, 120)}": ${added} entr${added === 1 ? 'y' : 'ies'} over ${days.length} day(s)${dup ? `, ${dup} already there` : ''}.`);
    res.json({ ok: true, added, duplicates: dup, days: preview, warnings: warnings.slice(0, 50) });
  });
}

module.exports = { mountDpr, readDprFile, buildDprTemplate, sheetToEntries, KIND_LABEL };
