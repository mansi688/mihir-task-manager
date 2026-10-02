// Bulk task import from a CSV or Excel (.xlsx) file.
//
// Everything in this file is pure (no database access, no Express) so it can be tested on its
// own: server.js hands it the uploaded file plus a snapshot of users/teams/open tasks, and gets
// back one validated "plan" per spreadsheet row. server.js then turns every valid plan into a
// real task using the exact same creation code the "+ New Task" form uses.
//
// Column headers are matched loosely (case, spacing and punctuation don't matter, and common
// alternatives like "Due Date" / "Assigned To" / "Sr No" are all recognised) so a sheet people
// already keep in Excel usually imports without renaming anything.

const ExcelJS = require('exceljs');

const MAX_IMPORT_ROWS = 5000;
const MAX_IMPORT_FILE_CHARS = 14_000_000; // ~10MB after base64 overhead — far beyond any real task sheet

// ---------- column mapping ----------
// Canonical field -> accepted header spellings (already normalised: lowercase, alphanumerics
// separated by single spaces). "Level 2", "Level 3 Assignees", "Stage 4" etc. are handled
// separately by LEVEL_HEADER below.
const FIELD_ALIASES = {
  include: ['import', 'include', 'import this', 'import row', 'to import', 'import yes no'],
  taskKey: ['task key', 'schedule key', 'activity id', 'activity key', 'unique id', 'unique key', 'import key', 'permanent id'],
  ref: ['ref', 'reference', 'row id', 'row ref', 'key', 'sr no', 'sr', 'srno', 's no', 'sno', 'serial no', 'serial number', 'no', 'task no', 'task number'],
  title: ['title', 'task', 'task title', 'task name', 'subject', 'work', 'activity'],
  description: ['description', 'details', 'desc', 'task description', 'remarks', 'notes', 'comments'],
  priority: ['priority', 'importance', 'urgency'],
  deadline: ['deadline', 'due date', 'due', 'due on', 'target date', 'end date', 'completion date', 'deadline date', 'date'],
  deadlineTime: ['deadline time', 'due time', 'time', 'target time'],
  assignees: ['assignees', 'assignee', 'assign to', 'assigned to', 'tag', 'tags', 'tagged', 'tag people', 'tagged people', 'people',
    'responsible', 'responsible person', 'owner', 'owners', 'person', 'persons', 'employee', 'employees', 'level 1', 'level 1 assignees', 'stage 1'],
  followups: ['follow up', 'followup', 'follow ups', 'followups', 'follow up people', 'cc', 'watchers', 'observers', 'notify'],
  project: ['project', 'project name', 'site', 'site name'],
  phase: ['phase', 'stage name', 'task phase', 'work phase'],
  checklist: ['checklist', 'checklist items', 'check list', 'steps', 'sub items', 'todo', 'to do'],
  dependsOn: ['depends on', 'dependency', 'depends', 'blocked by', 'after', 'predecessor', 'waits for'],
  parent: ['parent', 'parent task', 'subtask of', 'sub task of', 'under task', 'main task'],
  autoRelease: ['auto release', 'auto release levels', 'auto release stages', 'autorelease'],
  individualDeadlines: ['individual deadlines', 'individual deadline', 'person deadlines', 'per person deadlines', 'personal deadlines'],
};
const LEVEL_HEADER = /^(?:level|stage|lvl)\s*(\d{1,2})(?:\s+(?:assignees?|people|tags?|tagged))?$/;

function normHeader(h) {
  return String(h == null ? '' : h).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Returns { map: { columnIndex: { field, level? } }, unknown: [original header, ...], duplicates: [...] }
function mapColumns(headers) {
  const lookup = {};
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) for (const a of aliases) lookup[a] = field;
  const map = {};
  const unknown = [];
  const seen = new Set();
  const duplicates = [];
  headers.forEach((raw, idx) => {
    const h = normHeader(raw);
    if (!h) return;
    // "Info: Construction Start" etc. — reference columns kept in the sheet for people, never imported.
    if (/^info\b/.test(h)) return;
    let target = null;
    const lvl = h.match(LEVEL_HEADER);
    if (lvl) {
      const n = parseInt(lvl[1], 10);
      target = n <= 1 ? { field: 'assignees' } : { field: 'level', level: n };
    } else if (lookup[h]) {
      target = { field: lookup[h] };
    }
    if (!target) { unknown.push(String(raw).trim()); return; }
    const key = target.field === 'level' ? `level${target.level}` : target.field;
    if (seen.has(key)) { duplicates.push(String(raw).trim()); return; }
    seen.add(key);
    map[idx] = target;
  });
  return { map, unknown, duplicates };
}

// ---------- file parsing ----------
function decodeDataUrl(dataUrl) {
  const s = String(dataUrl || '');
  const comma = s.indexOf(',');
  if (!s.startsWith('data:') || comma < 0) throw importError('The file could not be read — please choose it again.');
  const meta = s.slice(5, comma);
  const body = s.slice(comma + 1);
  return meta.includes(';base64') ? Buffer.from(body, 'base64') : Buffer.from(decodeURIComponent(body), 'utf8');
}
function importError(message) { const e = new Error(message); e.isImportError = true; return e; }

// RFC 4180 CSV parser: quoted fields, escaped quotes (""), embedded commas/newlines, CRLF/LF,
// UTF-8 BOM. The delimiter is auto-detected from the header line — Excel in many locales
// (including some Indian regional settings) saves "CSV" with semicolons, and a tab-separated
// paste is common too.
function parseCSV(text) {
  text = text.replace(/^\uFEFF/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let inQ = false;
  for (const ch of firstLine) { if (ch === '"') inQ = !inQ; else if (!inQ && ch in counts) counts[ch]++; }
  const delim = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] > 0 ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] : ',';
  const rows = [];
  let row = [], field = '', i = 0, quoted = false;
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"' && field === '') { quoted = true; i++; continue; }
    if (ch === delim) { row.push(field); field = ''; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += ch; i++;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// Converts one ExcelJS cell value into a plain string or Date — handling formulas (their cached
// result), rich text, hyperlinks, booleans, and errors — so the rest of the pipeline only ever
// deals with strings and Dates regardless of which file type was uploaded.
function excelCellValue(v) {
  if (v == null) return '';
  if (v instanceof Date) return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map(r => r.text).join('');
    if ('result' in v) return excelCellValue(v.result);
    if (v.text != null) return excelCellValue(v.text);
    if (v.error) return '';
  }
  return String(v);
}

async function parseXLSX(buffer) {
  let wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buffer); } catch (e) {
    // ExcelJS chokes on cell comments/notes written by some tools (a known library bug). Comments
    // don't matter for importing, so strip them and try once more before giving up.
    try { wb = new ExcelJS.Workbook(); await wb.xlsx.load(await stripXlsxComments(buffer)); }
    catch (e2) { throw importError("This Excel file couldn't be opened. Save it as .xlsx (Excel Workbook) or .csv and try again."); }
  }
  // First sheet that actually has a recognisable Title column — so a template with an
  // "Instructions" or "People" sheet in front of the data still works.
  const sheets = wb.worksheets.filter(ws => ws.state !== 'hidden' && ws.state !== 'veryHidden');
  let chosen = null;
  for (const ws of sheets) {
    const rows = sheetToRows(ws);
    const headerIdx = findHeaderRow(rows);
    if (headerIdx >= 0) { chosen = rows; break; }
  }
  if (!chosen) chosen = sheets.length ? sheetToRows(sheets[0]) : [];
  return chosen;
}
async function stripXlsxComments(buffer) {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(buffer);
  for (const name of Object.keys(zip.files)) {
    if (/^xl\/(comments\d*\.xml|threadedComments\/.*|persons\/.*|drawings\/vmlDrawing\d*\.vml)$/i.test(name)) zip.remove(name);
  }
  for (const name of Object.keys(zip.files)) {
    if (/^xl\/worksheets\/_rels\/.*\.rels$/i.test(name)) {
      const xml = await zip.file(name).async('string');
      zip.file(name, xml.replace(/<Relationship\b[^>]*(comments|vmlDrawing|threadedComment)[^>]*\/>/gi, ''));
    }
    if (/^xl\/worksheets\/sheet\d*\.xml$/i.test(name)) {
      const xml = await zip.file(name).async('string');
      zip.file(name, xml.replace(/<legacyDrawing\b[^>]*\/>/gi, ''));
    }
    if (name === '[Content_Types].xml') {
      const xml = await zip.file(name).async('string');
      zip.file(name, xml.replace(/<Override\b[^>]*(comments|threadedComment|person)[^>]*\/>/gi, ''));
    }
  }
  return zip.generateAsync({ type: 'nodebuffer' });
}
function sheetToRows(ws) {
  const out = [];
  const colCount = ws.actualColumnCount || ws.columnCount || 0;
  ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const vals = [];
    for (let c = 1; c <= Math.max(colCount, row.cellCount); c++) vals.push(excelCellValue(row.getCell(c).value));
    out[rowNumber - 1] = vals;
  });
  for (let i = 0; i < out.length; i++) if (!out[i]) out[i] = [];
  return out;
}
// The header row is the first row (within the first 10) containing a Title-like column. This
// lets people keep a heading or a note above the table, which real office sheets often have.
function findHeaderRow(rows) {
  const titleAliases = new Set(FIELD_ALIASES.title);
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    if ((rows[i] || []).some(h => typeof h === 'string' && titleAliases.has(normHeader(h)))) return i;
  }
  return -1;
}

async function parseImportFile(dataUrl, fileName) {
  if (!dataUrl) throw importError('Choose a CSV or Excel file first.');
  if (String(dataUrl).length > MAX_IMPORT_FILE_CHARS) throw importError('That file is too large to import (max ~10MB).');
  const name = String(fileName || '').toLowerCase();
  const buf = decodeDataUrl(dataUrl);
  let grid;
  const looksLikeZip = buf.length > 3 && buf[0] === 0x50 && buf[1] === 0x4b;
  if (name.endsWith('.xls') && !looksLikeZip) {
    throw importError('Old-style .xls files aren\'t supported — in Excel use File → Save As → "Excel Workbook (.xlsx)" or "CSV", then upload that.');
  }
  if (name.endsWith('.xlsx') || name.endsWith('.xlsm') || looksLikeZip) grid = await parseXLSX(buf);
  else if (name.endsWith('.csv') || name.endsWith('.txt') || name.endsWith('.tsv') || !name) grid = parseCSV(buf.toString('utf8'));
  else throw importError('Upload a .csv or .xlsx file.');

  const headerIdx = findHeaderRow(grid);
  if (headerIdx < 0) throw importError('Couldn\'t find a "Title" column. The first row of your sheet should be column headings — download the template to see the expected layout.');
  const headers = grid[headerIdx].map(h => (h instanceof Date ? '' : String(h)));
  const { map, unknown, duplicates } = mapColumns(headers);
  const rows = [];
  let skippedByImportColumn = 0;
  for (let r = headerIdx + 1; r < grid.length; r++) {
    const cells = grid[r] || [];
    const isBlank = cells.every(c => c == null || (typeof c === 'string' && c.trim() === ''));
    if (isBlank) continue;
    const record = { rowNumber: r + 1, levels: {} };
    for (const [idx, target] of Object.entries(map)) {
      const v = cells[idx];
      if (target.field === 'level') record.levels[target.level] = v == null ? '' : v;
      else record[target.field] = v == null ? '' : v;
    }
    // "Import" column = No → leave this row out entirely (not an error). Lets one master schedule
    // hold every row while only the ones up to a cutoff date are imported for now.
    if (record.include !== undefined && /^(no|n|false|0|skip|later)$/i.test(cellText(record.include))) { skippedByImportColumn++; continue; }
    rows.push(record);
  }
  if (rows.length === 0) throw importError(skippedByImportColumn ? `All ${skippedByImportColumn} rows have Import = No — set Import to Yes for the rows you want (or move the cutoff date on the Settings sheet).` : 'The file has headings but no task rows underneath them.');
  if (rows.length > MAX_IMPORT_ROWS) throw importError(`That's ${rows.length} rows — import at most ${MAX_IMPORT_ROWS} tasks at a time (split the file into parts).`);
  return {
    rows,
    columns: headers.map((h, idx) => ({ header: String(h).trim(), field: map[idx] ? (map[idx].field === 'level' ? `level ${map[idx].level}` : map[idx].field) : null })).filter(c => c.header),
    unknownColumns: unknown,
    duplicateColumns: duplicates,
    skippedByImportColumn,
  };
}

// ---------- value parsing ----------
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
function pad(n) { return String(n).padStart(2, '0'); }
function validYMD(y, m, d) {
  if (!(y >= 2000 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
function parseTimePart(s) {
  if (!s) return { ok: true, time: null };
  const m = String(s).trim().match(/^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(am|pm|a\.m\.|p\.m\.)?$/i);
  if (!m) return { ok: false };
  let h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const ap = m[3] ? m[3].toLowerCase()[0] : null;
  if (!m[2] && !ap) return { ok: false }; // a bare number isn't a time
  if (ap) { if (h < 1 || h > 12) return { ok: false }; if (ap === 'p' && h !== 12) h += 12; if (ap === 'a' && h === 12) h = 0; }
  if (h > 23 || min > 59) return { ok: false };
  return { ok: true, time: `${pad(h)}:${pad(min)}` };
}
// Returns "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM" (the app's own deadline format), or null if the
// value can't be understood. Numeric dates are read DAY-FIRST (15/10/2026 = 15 Oct), the Indian
// convention; ISO 2026-10-15 and written months ("15 Oct 2026", "Oct 15, 2026") are unambiguous.
function parseDateValue(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) {
    if (isNaN(v)) return null;
    // ExcelJS returns spreadsheet dates as UTC instants that represent the wall-clock value
    // typed into the cell — read the UTC fields so no timezone shift creeps in.
    const date = `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`;
    const hasTime = v.getUTCHours() || v.getUTCMinutes();
    return hasTime ? `${date}T${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}` : date;
  }
  let s = String(v).trim().replace(/\s+/g, ' ');
  if (!s) return null;
  // Excel serial number (e.g. a date cell exported to CSV as 46310)
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const serial = parseFloat(s);
    if (serial > 30000 && serial < 80000) {
      const ms = Math.round((serial - 25569) * 86400000);
      return parseDateValue(new Date(ms));
    }
  }
  let y, m, d, rest = '';
  let mt;
  if ((mt = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ](.+))?$/))) {
    [y, m, d] = [+mt[1], +mt[2], +mt[3]]; rest = mt[4] || '';
  } else if ((mt = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})(?:[ T,]+(.+))?$/))) {
    [d, m, y] = [+mt[1], +mt[2], +mt[3]]; rest = mt[4] || '';
  } else if ((mt = s.match(/^(\d{1,2})(?:st|nd|rd|th)?[- /.]?([a-z]{3,9})\.?[- /.,]*(\d{2}|\d{4})(?:[ T,]+(.+))?$/i))) {
    const mon = MONTHS[mt[2].toLowerCase().slice(0, mt[2].toLowerCase().startsWith('sept') ? 4 : 3)];
    if (!mon) return null;
    [d, m, y] = [+mt[1], mon, +mt[3]]; rest = mt[4] || '';
  } else if ((mt = s.match(/^([a-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})(?:[ T,]+(.+))?$/i))) {
    const mon = MONTHS[mt[1].toLowerCase().slice(0, 3)];
    if (!mon) return null;
    [d, m, y] = [+mt[2], mon, +mt[3]]; rest = mt[4] || '';
  } else return null;
  if (y < 100) y += 2000;
  if (!validYMD(y, m, d)) return null;
  const t = parseTimePart(rest);
  if (!t.ok) return null;
  const date = `${y}-${pad(m)}-${pad(d)}`;
  return t.time ? `${date}T${t.time}` : date;
}

function parsePriority(v) {
  const s = normHeader(v);
  if (!s) return { value: 'medium', warning: null };
  if (['high', 'h', 'urgent', 'critical', 'p1', '1', 'top', 'immediate', 'asap'].includes(s)) return { value: 'high' };
  if (['medium', 'med', 'm', 'normal', 'p2', '2', 'moderate', 'mid'].includes(s)) return { value: 'medium' };
  if (['low', 'l', 'p3', '3', 'minor'].includes(s)) return { value: 'low' };
  return { value: 'medium', warning: `Priority "${String(v).trim()}" not recognised — using Medium.` };
}
function parseYesNo(v) {
  const s = normHeader(v);
  return ['yes', 'y', 'true', '1', 'on', 'auto'].includes(s);
}
function cellText(v) {
  if (v == null) return '';
  if (v instanceof Date) return parseDateValue(v) || '';
  return String(v).trim();
}
function splitList(v) {
  return cellText(v).split(/[,;\n|&]+|\s+and\s+/i).map(s => s.trim()).filter(Boolean);
}
function splitChecklist(v) {
  const s = cellText(v);
  if (!s) return [];
  // Newlines / pipes first (item text may legitimately contain commas); semicolons only if the
  // cell has neither.
  const parts = /[\n|]/.test(s) ? s.split(/[\n|]+/) : s.split(/;+/);
  return parts.map(p => p.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter(Boolean);
}

// ---------- people resolution ----------
// A person can be written as their username (with or without @), email, full name, or a unique
// first name. A department name (exact) tags everyone in that department. Anything ambiguous
// is reported rather than guessed.
function buildPeopleResolver(users, teams) {
  const byUsername = new Map(), byEmail = new Map(), byName = new Map(), byFirst = new Map(), byPhone = new Map();
  const add = (map, key, u) => { if (!key) return; const k = key.toLowerCase(); if (!map.has(k)) map.set(k, []); map.get(k).push(u); };
  for (const u of users) {
    add(byUsername, u.username, u);
    add(byEmail, u.email, u);
    add(byName, (u.name || '').replace(/\s+/g, ' ').trim(), u);
    add(byFirst, (u.name || '').trim().split(/\s+/)[0], u);
    if (u.phone) add(byPhone, String(u.phone).replace(/\D/g, '').slice(-10), u);
  }
  const teamNames = new Map((teams || []).map(t => [t.toLowerCase(), t]));
  return function resolve(token) {
    let t = String(token || '').trim().replace(/^@/, '');
    // "Rohit Kamble (rohit.k)" — the format the app itself shows, and the template's People sheet
    const paren = t.match(/\(([^()]+)\)\s*$/);
    if (paren && byUsername.has(paren[1].trim().toLowerCase())) t = paren[1].trim();
    const k = t.toLowerCase().replace(/\s+/g, ' ');
    if (!k) return { users: [] };
    for (const map of [byUsername, byEmail, byName]) {
      const hit = map.get(k);
      if (hit && hit.length === 1) return { users: hit };
      if (hit && hit.length > 1) return { error: `"${t}" matches more than one person (${hit.map(u => u.username).join(', ')}) — use the username instead.` };
    }
    const digits = k.replace(/\D/g, '');
    if (digits.length >= 10 && byPhone.has(digits.slice(-10))) {
      const hit = byPhone.get(digits.slice(-10));
      if (hit.length === 1) return { users: hit };
    }
    const teamKey = k.replace(/^(?:team|dept|department)\s*:\s*/, '');
    if (teamNames.has(teamKey)) {
      const team = teamNames.get(teamKey);
      const members = users.filter(u => u.team === team);
      if (members.length === 0) return { error: `Department "${team}" has no one in it yet.` };
      return { users: members, team };
    }
    const first = byFirst.get(k);
    if (first && first.length === 1) return { users: first, guessed: true };
    if (first && first.length > 1) return { error: `"${t}" matches more than one person (${first.map(u => `${u.name} = ${u.username}`).join(', ')}) — use the username instead.` };
    return { error: `No account found for "${t}".` };
  };
}

// ---------- row validation ----------
// context: { users, teams, openTasks: [{id,title}], tasksById: Map(id -> {id,title,status}), actorUsername }
// Returns { plans: [...], validCount, errorCount }. Each plan has everything needed to create the
// task, or an errors[] list explaining why it can't be.
function planImport(rows, context) {
  const resolve = buildPeopleResolver(context.users, context.teams);
  const userMap = new Map(context.users.map(u => [u.username, u]));
  const today = new Date().toISOString().slice(0, 10);

  const plans = rows.map(r => {
    const errors = [], warnings = [];
    const title = cellText(r.title);
    const description = cellText(r.description);
    if (!title) errors.push('Title is empty.');
    if (title.length > 200) errors.push('Title is too long (max 200 characters).');
    if (description.length > 5000) errors.push('Description is too long (max 5000 characters).');

    let deadline = null;
    const rawDeadline = r.deadline;
    if (rawDeadline === undefined || cellText(rawDeadline) === '') errors.push('Deadline is empty.');
    else {
      deadline = parseDateValue(rawDeadline);
      if (!deadline) errors.push(`Deadline "${cellText(rawDeadline)}" isn't a date I can read — use DD/MM/YYYY or YYYY-MM-DD.`);
    }
    if (deadline && cellText(r.deadlineTime) && !deadline.includes('T')) {
      const t = parseTimePart(cellText(r.deadlineTime));
      if (t.ok && t.time) deadline = `${deadline}T${t.time}`;
      else warnings.push(`Time "${cellText(r.deadlineTime)}" not understood — ignored.`);
    }
    if (deadline && deadline.slice(0, 10) < today) warnings.push('Deadline is already in the past.');

    const pr = parsePriority(r.priority);
    if (pr.warning) warnings.push(pr.warning);

    // Levels: column "Assignees" (or "Level 1") is level 1; "Level 2", "Level 3"... follow. Empty
    // intermediate levels are dropped so "Level 1 + Level 3" becomes two consecutive levels.
    const levelInputs = [[1, r.assignees], ...Object.entries(r.levels || {}).map(([n, v]) => [parseInt(n, 10), v])]
      .sort((a, b) => a[0] - b[0]);
    const stageGroups = [];
    const placed = new Map();
    for (const [lvl, raw] of levelInputs) {
      const group = [];
      for (const token of splitList(raw)) {
        const res = resolve(token);
        if (res.error) { errors.push(res.error); continue; }
        if (res.guessed) warnings.push(`"${token}" matched ${res.users[0].name} (${res.users[0].username}) by first name.`);
        for (const u of res.users) {
          if (placed.has(u.username)) {
            if (placed.get(u.username) !== lvl) errors.push(`${u.name} (${u.username}) is tagged in more than one level.`);
            continue;
          }
          placed.set(u.username, lvl);
          group.push(u.username);
        }
      }
      if (group.length) stageGroups.push(group);
    }
    // Tagging people is optional — a task can be created untagged and people added later from
    // the task itself (e.g. importing a whole schedule before deciding who does what).
    if (stageGroups.length === 0 && !errors.some(e => e.startsWith('No account') || e.includes('more than one person'))) {
      warnings.push('No one tagged yet — add people later from the task.');
    }

    const followups = [];
    for (const token of splitList(r.followups)) {
      const res = resolve(token);
      if (res.error) { errors.push(`Follow-up: ${res.error}`); continue; }
      for (const u of res.users) if (!followups.includes(u.username)) followups.push(u.username);
    }

    const individualDeadlines = {};
    const indivText = cellText(r.individualDeadlines);
    if (indivText) {
      for (const part of indivText.split(/[;\n]+/).map(s => s.trim()).filter(Boolean)) {
        const m = part.match(/^([^:=]+?)\s*[:=]\s*(.+)$/);
        if (!m) { errors.push(`Individual deadline "${part}" should look like "username: 15/10/2026".`); continue; }
        const res = resolve(m[1]);
        if (res.error || !res.users || res.users.length !== 1) { errors.push(`Individual deadline: ${res.error || `"${m[1]}" must be one person.`}`); continue; }
        const uname = res.users[0].username;
        if (!placed.has(uname)) { errors.push(`Individual deadline given for ${uname}, who isn't tagged on this task.`); continue; }
        const d = parseDateValue(m[2]);
        if (!d) { errors.push(`Individual deadline "${m[2]}" for ${uname} isn't a readable date.`); continue; }
        individualDeadlines[uname] = d;
      }
    }

    const checklist = splitChecklist(r.checklist);
    if (checklist.some(c => c.length > 500)) errors.push('A checklist item is too long (max 500 characters).');

    const project = cellText(r.project);
    const phase = cellText(r.phase);
    if (project.length > 200 || phase.length > 200) errors.push('Project/Phase name is too long.');

    const taskKey = cellText(r.taskKey);
    if (taskKey.length > 100) errors.push('Task Key is too long (max 100 characters).');

    return {
      rowNumber: r.rowNumber,
      ref: cellText(r.ref),
      taskKey,
      title, description, priority: pr.value, deadline,
      stageGroups,
      assigneeCount: placed.size,
      autoReleaseStages: parseYesNo(r.autoRelease),
      followups, individualDeadlines, checklist,
      project: project || null, phase: phase || null,
      dependsOnRaw: cellText(r.dependsOn), parentRaw: cellText(r.parent),
      dependsOn: null, parent: null, // { kind: 'row', rowNumber } | { kind: 'task', id, title }
      errors, warnings,
    };
  });

  // Cross-row references: "Depends On" / "Parent Task" can point at another row in this file (by
  // its Ref / Sr No, its row number as "row 5", or its exact title) or at an existing task (by
  // TASK-ID, or the exact title of an open task).
  const byRef = new Map(), byTitle = new Map(), byKey = new Map();
  for (const p of plans) {
    if (p.taskKey) { const k = p.taskKey.toLowerCase(); if (byKey.has(k)) p.errors.push(`Task Key "${p.taskKey}" is used by more than one row (also row ${byKey.get(k).rowNumber}).`); else byKey.set(k, p); }
    if (p.ref) { const k = p.ref.toLowerCase(); if (byRef.has(k)) p.errors.push(`Ref "${p.ref}" is used by more than one row.`); else byRef.set(k, p); }
    if (p.title) { const k = p.title.toLowerCase(); if (!byTitle.has(k)) byTitle.set(k, []); byTitle.get(k).push(p); }
  }
  const openByTitle = new Map();
  for (const t of context.openTasks || []) { const k = String(t.title).toLowerCase(); if (!openByTitle.has(k)) openByTitle.set(k, []); openByTitle.get(k).push(t); }
  function resolveRef(raw, self, label) {
    if (!raw) return null;
    const k = raw.toLowerCase();
    const rowMatch = k.match(/^row\s*#?\s*(\d+)$/);
    if (rowMatch) {
      const p = plans.find(x => x.rowNumber === parseInt(rowMatch[1], 10));
      if (p) return p === self ? { error: `${label} can't point at its own row.` } : { kind: 'row', plan: p };
    }
    if (byRef.has(k)) { const p = byRef.get(k); return p === self ? { error: `${label} can't point at its own row.` } : { kind: 'row', plan: p }; }
    const existing = context.tasksById && context.tasksById.get(raw.toUpperCase());
    if (existing) return { kind: 'task', task: existing };
    const sameTitle = (byTitle.get(k) || []).filter(p => p !== self);
    if (sameTitle.length === 1) return { kind: 'row', plan: sameTitle[0] };
    if (sameTitle.length > 1) return { error: `${label} "${raw}" matches several rows with that title — give rows a Ref / Sr No and use that.` };
    const openHits = openByTitle.get(k) || [];
    if (openHits.length === 1) return { kind: 'task', task: openHits[0] };
    if (openHits.length > 1) return { error: `${label} "${raw}" matches several open tasks — use the task ID (e.g. ${openHits[0].id}).` };
    return { error: `${label} "${raw}" not found in this file or among open tasks.` };
  }
  for (const p of plans) {
    for (const [rawKey, key, label] of [['dependsOnRaw', 'dependsOn', 'Depends On'], ['parentRaw', 'parent', 'Parent Task']]) {
      const r = resolveRef(p[rawKey], p, label);
      if (!r) continue;
      if (r.error) { p.errors.push(r.error); continue; }
      if (r.kind === 'task' && key === 'parent' && r.task.status && r.task.status !== 'open') { p.errors.push(`Parent task "${r.task.title}" is already closed or cancelled.`); continue; }
      p[key] = r.kind === 'row' ? { kind: 'row', rowNumber: r.plan.rowNumber, title: r.plan.title } : { kind: 'task', id: r.task.id, title: r.task.title };
    }
  }

  // Order rows so anything referenced is created first, and detect cycles (A depends on B, B on A).
  const byRow = new Map(plans.map(p => [p.rowNumber, p]));
  const order = [];
  const state = new Map(); // 1 = visiting, 2 = done
  function visit(p, stack) {
    if (state.get(p.rowNumber) === 2) return;
    if (state.get(p.rowNumber) === 1) {
      const cycle = stack.slice(stack.indexOf(p.rowNumber));
      for (const rn of cycle) byRow.get(rn).errors.push(`Circular reference between rows ${cycle.join(' → ')}.`);
      return;
    }
    state.set(p.rowNumber, 1);
    for (const ref of [p.parent, p.dependsOn]) if (ref && ref.kind === 'row') visit(byRow.get(ref.rowNumber), [...stack, p.rowNumber]);
    state.set(p.rowNumber, 2);
    order.push(p);
  }
  for (const p of plans) visit(p, []);

  // A row that relies on a row with errors can't be created either (its prerequisite won't exist).
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of plans) {
      if (p.errors.length) continue;
      for (const ref of [p.parent, p.dependsOn]) {
        if (ref && ref.kind === 'row' && byRow.get(ref.rowNumber).errors.length) {
          p.errors.push(`Row ${ref.rowNumber} it relies on has errors, so this row can't be created either.`);
          changed = true;
          break;
        }
      }
    }
  }

  const validCount = plans.filter(p => p.errors.length === 0).length;
  return { plans, order, validCount, errorCount: plans.length - validCount, userMap };
}

// Public summary sent to the browser for the preview table (no internal references).
function planSummary(p, userMap) {
  const label = u => { const x = userMap.get(u); return x ? `${x.name} (${u})` : u; };
  return {
    rowNumber: p.rowNumber, ref: p.ref, taskKey: p.taskKey || null, action: p.action || 'create', existing: p.existing || null, title: p.title, description: p.description, priority: p.priority, deadline: p.deadline,
    levels: p.stageGroups.map(g => g.map(label)),
    followups: p.followups.map(label),
    individualDeadlines: Object.entries(p.individualDeadlines).map(([u, d]) => `${label(u)}: ${d}`),
    checklist: p.checklist, project: p.project, phase: p.phase, autoReleaseStages: p.autoReleaseStages && p.stageGroups.length > 1,
    dependsOn: p.dependsOn ? (p.dependsOn.kind === 'row' ? `Row ${p.dependsOn.rowNumber}: ${p.dependsOn.title}` : `${p.dependsOn.title} (${p.dependsOn.id})`) : null,
    parent: p.parent ? (p.parent.kind === 'row' ? `Row ${p.parent.rowNumber}: ${p.parent.title}` : `${p.parent.title} (${p.parent.id})`) : null,
    errors: p.errors, warnings: p.warnings,
  };
}

// ---------- template ----------
const TEMPLATE_HEADERS = ['Sr No', 'Task Key', 'Title', 'Description', 'Priority', 'Deadline', 'Deadline Time', 'Assignees', 'Level 2', 'Auto Release',
  'Follow Up', 'Project', 'Phase', 'Checklist', 'Depends On', 'Parent Task', 'Individual Deadlines'];
function templateExampleRows(users) {
  const sample = users.filter(u => u.role !== 'admin').slice(0, 3);
  const a = sample[0] ? sample[0].username : 'rohit.k';
  const b = sample[1] ? sample[1].username : 'suraj_kathale';
  const c = sample[2] ? sample[2].username : 'tanishq.m';
  const d = new Date(Date.now() + 7 * 86400000);
  const d2 = new Date(Date.now() + 14 * 86400000);
  const fmt = x => `${pad(x.getDate())}/${pad(x.getMonth() + 1)}/${x.getFullYear()}`;
  return [
    ['1', '', 'Prepare BOQ for Tower B', 'Structural + finishing items', 'High', fmt(d), '17:00', a, b, 'Yes', c, 'Tower B', 'Structure', 'Collect drawings | Take off quantities | Rate analysis', '', '', `${a}: ${fmt(new Date(Date.now() + 5 * 86400000))}`],
    ['2', '', 'Float cement purchase enquiry', 'Based on BOQ quantities', 'Medium', fmt(d2), '', c, '', '', '', 'Tower B', 'Structure', '', '1', '', ''],
    ['3', '', 'Get 3 vendor quotes', '', 'Low', fmt(d2), '', c, '', '', '', 'Tower B', '', '', '', '2', ''],
  ];
}
function csvEscape(v) { const s = String(v == null ? '' : v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
function buildTemplateCSV(users) {
  const lines = [TEMPLATE_HEADERS, ...templateExampleRows(users)].map(r => r.map(csvEscape).join(','));
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}
async function buildTemplateXLSX(users) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'MIHIR Task Manager';
  const ws = wb.addWorksheet('Tasks', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.addRow(TEMPLATE_HEADERS);
  templateExampleRows(users).forEach(r => ws.addRow(r));
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3A5F' } };
  const widths = [7, 16, 34, 30, 10, 13, 12, 26, 20, 12, 18, 14, 12, 40, 12, 12, 30];
  widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  ws.getColumn(6).numFmt = '@'; // keep typed dates as text so Excel doesn't flip day/month
    for (let n = 2; n <= 500; n++) ws.getCell(n, 5).dataValidation = { type: 'list', allowBlank: true, formulae: ['"High,Medium,Low"'] };

  const help = wb.addWorksheet('How to fill');
  help.getColumn(1).width = 22; help.getColumn(2).width = 110;
  const guide = [
    ['Column', 'How to fill it'],
    ['Sr No', 'Optional. A short reference for this row, so other rows can point at it in "Depends On" / "Parent Task".'],
    ['Task Key', 'Optional. A permanent ID for this row (e.g. EQX-1A-3F9C21). If you upload the file again later, rows whose Task Key was already imported UPDATE that task\'s deadline instead of creating a duplicate. Leave blank for one-off tasks.'],
    ['Title', 'Required. Max 200 characters.'],
    ['Description', 'Optional.'],
    ['Priority', 'High, Medium or Low. Blank = Medium.'],
    ['Deadline', 'Required. DD/MM/YYYY (e.g. 15/10/2026), YYYY-MM-DD, or "15 Oct 2026". Numbers are always read day-first.'],
    ['Deadline Time', 'Optional, e.g. 17:00 or 5:00 PM.'],
    ['Assignees', 'Optional — leave blank to create the task untagged and add people later. Who is tagged (Level 1). Separate several with commas. Use username (best), full name, email, or a department name to tag everyone in it — see the "People" sheet.'],
    ['Level 2, Level 3…', 'Optional. People who wait until the level before them is approved. Add "Level 3", "Level 4" columns if needed.'],
    ['Auto Release', 'Yes = release the next level automatically once the previous one is approved.'],
    ['Follow Up', 'Optional. People to keep in the loop (they are not assigned work).'],
    ['Project / Phase', 'Optional. New names are added to the lists automatically.'],
    ['Checklist', 'Optional. Items separated by | or on separate lines inside the cell. Assignees must tick every item before submitting.'],
    ['Depends On', 'Optional. This task stays Blocked until that one closes. Use another row\'s Sr No, "row 5", its exact title, or an existing task ID like TASK-AB12CD.'],
    ['Parent Task', 'Optional. Makes this a subtask. Same ways of referring as Depends On.'],
    ['Individual Deadlines', 'Optional. Per-person deadlines, e.g. "rohit.k: 12/10/2026; suraj_kathale: 14/10/2026". Those people must be tagged on the task.'],
    ['', ''],
    ['Info: …', 'Any column whose heading starts with "Info:" (e.g. "Info: Construction Start") is kept for reference only and never imported.'],
    ['Tips', 'Delete the 3 example rows before importing. Nothing is created until you review the preview and press Import. Any extra columns you have are simply ignored.'],
  ];
  guide.forEach(r => help.addRow(r));
  help.getRow(1).font = { bold: true };
  help.getColumn(2).alignment = { wrapText: true, vertical: 'top' };

  const people = wb.addWorksheet('People');
  people.addRow(['Username (use this)', 'Name', 'Department', 'Designation']);
  people.getRow(1).font = { bold: true };
  [...users].sort((x, y) => String(x.team || '').localeCompare(String(y.team || '')) || String(x.name).localeCompare(String(y.name)))
    .forEach(u => people.addRow([u.username, u.name, u.team || '', u.designation || '']));
  [22, 28, 26, 24].forEach((w, i) => { people.getColumn(i + 1).width = w; });

  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = {
  normHeader, findHeaderRow, excelCellValue, stripXlsxComments, decodeDataUrl,
  parseImportFile, planImport, planSummary, mapColumns, parseCSV, parseDateValue, parsePriority, buildPeopleResolver,
  buildTemplateCSV, buildTemplateXLSX, MAX_IMPORT_ROWS,
};
