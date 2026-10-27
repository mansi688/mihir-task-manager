/* Reading JMRs from an Excel (.xlsx / .xlsm) or CSV file the Estimation team already has.

   Each visible sheet is read. Recognised:
   - details above the table, as "Label: value" in one cell or a label cell followed by its value:
     Project / Site, Location / Tower / Floor, Work item / Name of work, Contractor / Agency, Unit, Rate, BOQ item,
     RA bill, Date / Measured on;
   - the measurement table: a heading row with Description (Particulars / Item / Details) and at least one of
     Nos, L, B, H (Depth / Thickness), Qty — plus optional Unit, Work item and Remarks columns;
   - rows with text but no numbers are section headings: they start a new JMR named after the heading (typical
     "Block work 150 mm" → its lines). A "Work item" column does the same per row;
   - "Total" / "Sub total" rows are skipped; "Less …" / "Deduct …" rows or negative numbers are deductions;
   - a row's quantity is Nos × L × B × H when those are given; if the sheet's own Qty differs, the sheet's Qty is kept
     (typed) so nothing changes silently. */
const ExcelJS = require('exceljs');
const { decodeDataUrl, excelCellValue, stripXlsxComments, parseCSV } = require('./task-import');

const MAX_FILE_CHARS = 14 * 1024 * 1024;
const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[\s._:()\[\]\-\/]+/g, ' ').trim();
const COLS = {
  description: ['description', 'particulars', 'particular', 'item', 'details', 'detail', 'item description', 'description of item', 'description of work', 'location', 'location of work', 'measurement details'],
  nos: ['nos', 'no', 'number', 'numbers', 'qty nos', 'count', 'n'],
  length: ['l', 'length', 'len', 'l m', 'length m', 'length mtr'],
  breadth: ['b', 'breadth', 'width', 'w', 'b m', 'breadth m', 'width m'],
  height: ['h', 'height', 'depth', 'd', 'h d', 'thk', 'thickness', 'height m', 'depth m', 'h m', 'd m'],
  qty: ['qty', 'quantity', 'quantities', 'total qty', 'qty total', 'measured qty', 'quantity sqm', 'quantity cum', 'qty sqm', 'qty cum', 'qty rmt', 'quantity rmt'],
  unit: ['unit', 'uom', 'units'],
  work_item: ['work item', 'item of work', 'name of work', 'activity', 'boq description', 'work'],
  remarks: ['remarks', 'remark', 'notes', 'note', 'comments'],
};
const META = {
  project: ['project', 'site', 'project name', 'name of project'],
  location: ['location', 'tower', 'floor', 'building', 'wing', 'area'],
  work_item: ['work item', 'name of work', 'item of work', 'work', 'activity', 'description of work'],
  contractor: ['contractor', 'agency', 'name of contractor', 'sub contractor', 'subcontractor', 'vendor'],
  unit: ['unit', 'uom'],
  rate: ['rate', 'rate rs', 'rate inr'],
  boq_item: ['boq item', 'boq no', 'boq item no', 'item no', 'boq'],
  ra_bill_no: ['ra bill', 'ra bill no', 'ra no', 'bill no', 'running bill no'],
  measured_on: ['date', 'measured on', 'date of measurement', 'jmr date'],
};
const UNITS = { cum: 'cum', 'cu m': 'cum', m3: 'cum', 'cubic meter': 'cum', sqm: 'sqm', 'sq m': 'sqm', m2: 'sqm', 'square meter': 'sqm', rmt: 'rmt', rm: 'rmt', 'running meter': 'rmt', nos: 'nos', no: 'nos', kg: 'kg', mt: 'MT', ton: 'MT', tonne: 'MT', bags: 'bags', bag: 'bags', sqft: 'sqft', 'sq ft': 'sqft', cft: 'cft', rft: 'rft', ls: 'LS', litre: 'litre', ltr: 'litre' };
function unitOf(v) { const k = norm(v); return UNITS[k] || (k ? String(v).trim().slice(0, 20) : ''); }
function numOf(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return null;
  const s = String(v).replace(/,/g, '').replace(/[₹]|rs\.?/gi, '').trim();
  if (!s || !/^-?\d*\.?\d+(e-?\d+)?$/i.test(s)) return null;
  const n = Number(s); return isFinite(n) ? n : null;
}
const text = (v) => v instanceof Date ? v.toISOString().slice(0, 10) : String(v == null ? '' : v).trim();
const ymd = (v) => {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = text(v); let m;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/.exec(s))) { const y = m[3].length === 2 ? `20${m[3]}` : m[3]; return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; }
  return null;
};

function findHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const cells = (rows[i] || []).map(norm);
    const map = {};
    cells.forEach((c, idx) => { for (const [k, al] of Object.entries(COLS)) if (map[k] == null && al.includes(c)) { map[k] = idx; break; } });
    if (map.description != null && (map.qty != null || map.nos != null || map.length != null)) return { index: i, map };
  }
  return null;
}
function readMeta(rows, upto) {
  const meta = {};
  for (let i = 0; i < upto; i++) {
    const r = rows[i] || [];
    for (let c = 0; c < r.length; c++) {
      const raw = r[c]; if (raw == null || raw === '') continue;
      let label = null, value = null;
      const s = text(raw);
      const colon = s.indexOf(':');
      if (colon > 0 && colon < 40) { label = norm(s.slice(0, colon)); value = s.slice(colon + 1).trim(); if (!value) value = r[c + 1]; }
      else { label = norm(s); value = r[c + 1]; }
      for (const [k, al] of Object.entries(META)) {
        if (meta[k] != null || !al.includes(label)) continue;
        if (value == null || text(value) === '') continue;
        meta[k] = k === 'rate' ? numOf(value) : k === 'measured_on' ? ymd(value) : k === 'unit' ? unitOf(value) : text(value).slice(0, 300);
      }
    }
  }
  return meta;
}
function sheetToJmrs(rows, sheetName) {
  const h = findHeader(rows); if (!h) return { jmrs: [], skipped: true };
  const meta = readMeta(rows, h.index);
  const M = h.map;
  const groups = [];
  let cur = null;
  const start = (name, unit) => { cur = { work_item: name || meta.work_item || sheetName, unit: unit || meta.unit || '', lines: [] }; groups.push(cur); };
  const warnings = [];
  for (let i = h.index + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const get = k => (M[k] == null ? null : r[M[k]]);
    const desc = text(get('description'));
    const vals = { nos: numOf(get('nos')), length: numOf(get('length')), breadth: numOf(get('breadth')), height: numOf(get('height')), qty: numOf(get('qty')) };
    const anyNum = Object.values(vals).some(v => v != null);
    const wi = text(get('work_item')); const un = unitOf(get('unit'));
    if (!desc && !anyNum) continue;
    if (/^(sub[\s-]*)?total\b|^grand total|^net total|^total qty/i.test(desc)) continue;
    if (wi && (!cur || cur.work_item !== wi)) start(wi, un);
    if (!anyNum) { if (desc) start(desc.slice(0, 300), un); continue; } // section heading
    if (!cur) start(null, un);
    if (un && !cur.unit) cur.unit = un;
    let deduct = /^(less|deduct|deduction|minus)\b/i.test(desc) || [vals.nos, vals.length, vals.breadth, vals.height, vals.qty].some(v => v != null && v < 0);
    const dims = [vals.nos, vals.length, vals.breadth, vals.height].filter(v => v != null).map(Math.abs);
    const product = dims.length ? dims.reduce((a, b) => a * b, 1) : null;
    const line = { description: desc.replace(/^(less|deduct(ion)?|minus)\s*[:\-–]?\s*/i, '').slice(0, 300), nos: vals.nos != null ? Math.abs(vals.nos) : '', length: vals.length != null ? Math.abs(vals.length) : '',
      breadth: vals.breadth != null ? Math.abs(vals.breadth) : '', height: vals.height != null ? Math.abs(vals.height) : '', qty: '', manual: false, deduct, remarks: text(get('remarks')).slice(0, 300) };
    if (product == null) { line.manual = true; line.qty = Math.abs(vals.qty); }
    else if (vals.qty != null && Math.abs(Math.abs(vals.qty) - product) > Math.max(0.01, product * 0.005)) {
      line.manual = true; line.qty = Math.abs(vals.qty);
      if (!line.remarks) line.remarks = `Qty as in sheet (Nos×L×B×H = ${Math.round(product * 1000) / 1000})`;
      warnings.push(`${sheetName} row ${i + 1}: the sheet's Qty (${vals.qty}) differs from Nos × L × B × H (${Math.round(product * 1000) / 1000}) — kept the sheet's Qty.`);
    }
    cur.lines.push(line);
  }
  const jmrs = groups.filter(g => g.lines.length).map(g => {
    const total = Math.round(g.lines.reduce((a, l) => a + (l.deduct ? -1 : 1) * (l.manual ? Number(l.qty) : [l.nos, l.length, l.breadth, l.height].filter(v => v !== '').reduce((x, y) => x * y, 1)), 0) * 1000) / 1000;
    return { sheet: sheetName, ...meta, work_item: g.work_item, unit: g.unit || meta.unit || '', lines: g.lines, total };
  });
  return { jmrs, warnings };
}

async function readJmrFile(dataUrl, fileName) {
  if (!dataUrl) throw Object.assign(new Error('Choose the Excel file first.'), { isImportError: true });
  if (String(dataUrl).length > MAX_FILE_CHARS) throw Object.assign(new Error('That file is too large (max ~10 MB).'), { isImportError: true });
  const buf = decodeDataUrl(dataUrl);
  const name = String(fileName || '').toLowerCase();
  const zip = buf.length > 3 && buf[0] === 0x50 && buf[1] === 0x4b;
  const sheets = [];
  if (name.endsWith('.xls') && !zip) throw Object.assign(new Error('Old .xls files are not supported — in Excel use File → Save As → "Excel Workbook (.xlsx)".'), { isImportError: true });
  if (zip) {
    let wb = new ExcelJS.Workbook();
    try { await wb.xlsx.load(buf); } catch (e) {
      try { wb = new ExcelJS.Workbook(); await wb.xlsx.load(await stripXlsxComments(buf)); }
      catch (e2) { throw Object.assign(new Error("This Excel file couldn't be opened. Save it as .xlsx and try again."), { isImportError: true }); }
    }
    for (const ws of wb.worksheets) {
      if (ws.state === 'hidden' || ws.state === 'veryHidden') continue;
      const rows = [];
      ws.eachRow({ includeEmpty: true }, (row, n) => { const v = []; for (let c = 1; c <= Math.max(ws.actualColumnCount || 0, row.cellCount); c++) v.push(excelCellValue(row.getCell(c).value)); rows[n - 1] = v; });
      for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
      sheets.push({ name: ws.name, rows });
    }
  } else sheets.push({ name: (fileName || 'Sheet').replace(/\.[^.]+$/, ''), rows: parseCSV(buf.toString('utf8')) });
  const out = { jmrs: [], warnings: [], sheetsRead: [], sheetsSkipped: [] };
  for (const s of sheets) {
    const r = sheetToJmrs(s.rows, s.name);
    if (r.skipped || !r.jmrs.length) { out.sheetsSkipped.push(s.name); continue; }
    out.sheetsRead.push(s.name); out.jmrs.push(...r.jmrs); out.warnings.push(...(r.warnings || []));
  }
  if (!out.jmrs.length) throw Object.assign(new Error('No measurement table found. The sheet needs a heading row with "Description" and Nos / L / B / H or Qty — download the template to see the layout.'), { isImportError: true });
  if (out.jmrs.length > 100) throw Object.assign(new Error(`That is ${out.jmrs.length} JMRs — import at most 100 at a time.`), { isImportError: true });
  return out;
}

async function buildJmrTemplate() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('JMR');
  const meta = [['Project:', 'Mihir Amara'], ['Location:', 'Tower B, 4th floor'], ['Contractor:', 'Shree Builders'], ['Work item:', 'Block work 150 mm'], ['Unit:', 'sqm'], ['Rate:', 450], ['BOQ item:', '4.2'], ['RA bill:', 'RA-03'], ['Date:', '25-10-2026']];
  meta.forEach(r => ws.addRow(r));
  ws.addRow([]);
  const head = ws.addRow(['Description', 'Nos', 'L', 'B', 'H', 'Qty', 'Remarks']);
  head.font = { bold: true }; head.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF7' } }; });
  ws.addRow(['Wall A (grid 1-2)', 2, 5, '', 3, { formula: 'B12*C12*E12', result: 30 }, '']);
  ws.addRow(['Less: Door opening D1', 1, 1, '', 2.1, { formula: 'B13*C13*E13', result: 2.1 }, 'deduction']);
  ws.addRow(['Lift wall', '', '', '', '', 12.5, 'measured on site']);
  ws.addRow(['Total', '', '', '', '', { formula: 'F12-F13+F14', result: 40.4 }, '']);
  ws.addRow([]);
  ws.addRow(['Plaster 12 mm (another work item: a heading row with no numbers starts a new JMR)']);
  ws.addRow(['Wall A both faces', 2, 5, '', 3, 30, '']);
  ws.columns = [{ width: 46 }, { width: 8 }, { width: 8 }, { width: 8 }, { width: 8 }, { width: 10 }, { width: 22 }];
  const help = wb.addWorksheet('How to fill');
  ['Details at the top (Project, Location, Contractor, Work item, Unit, Rate, BOQ item, RA bill, Date) are optional — you can also pick them on the screen.',
    'The table needs a heading row with "Description" and Nos / L / B / H and/or Qty. Leave a box empty if it does not apply.',
    'Start a line with "Less" (or use a negative number) for deductions such as openings.',
    '"Total" rows are skipped — the app adds the lines up itself.',
    'A row with text and no numbers starts a new work item (one JMR each). Each sheet is read; a "Work item" column also works.',
    'If a row has both dimensions and a Qty that does not match, the Qty from the sheet is kept and the row is flagged.',
  ].forEach(t => help.addRow([t]));
  help.getColumn(1).width = 120;
  return wb.xlsx.writeBuffer();
}

module.exports = { readJmrFile, buildJmrTemplate, sheetToJmrs };
