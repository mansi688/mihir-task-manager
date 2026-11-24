// Import user accounts from an Excel (.xlsx) or CSV file (Accounts page, Admin only).
// Columns are recognised by their heading (any order, case and spacing ignored):
//   Name* · Username · Password · Role · Department / Team · Designation · Phone · Email · Date of birth · Joining date
// A missing username is made from the name (first name + "." + first letter of the surname); a missing password is
// generated. Everyone must change the password at the first login. Rows with a problem are listed and skipped.
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const { decodeDataUrl, parseCSV, excelCellValue, stripXlsxComments, normHeader } = require('./task-import');

const MAX_ROWS = 500;
const MAX_CHARS = 8 * 1024 * 1024;
const FIELDS = {
  name: ['name', 'full name', 'employee name', 'person', 'employee'],
  username: ['username', 'user name', 'user id', 'userid', 'login', 'login id'],
  password: ['password', 'temporary password', 'temp password'],
  role: ['role', 'access', 'access level'],
  team: ['department', 'dept', 'team', 'team department', 'department team'],
  designation: ['designation', 'title', 'job title', 'position', 'post'],
  phone: ['phone', 'mobile', 'mobile number', 'phone number', 'contact', 'contact number'],
  email: ['email', 'e mail', 'email id', 'mail'],
  dob: ['date of birth', 'dob', 'birth date', 'birthday'],
  join_date: ['joining date', 'date of joining', 'doj', 'join date', 'joined'],
};
const ROLE_ALIASES = { member: 'member', 'team member': 'member', employee: 'member', staff: 'member', user: 'member', director: 'director', 'senior management': 'director', admin: 'admin', administrator: 'admin' };

function err(message) { const e = new Error(message); e.isImportError = true; return e; }

async function readGrid(dataUrl, fileName) {
  if (!dataUrl) throw err('Choose an Excel or CSV file first.');
  if (String(dataUrl).length > MAX_CHARS) throw err('That file is too large (max ~6 MB).');
  const buf = decodeDataUrl(dataUrl);
  const name = String(fileName || '').toLowerCase();
  const zip = buf.length > 3 && buf[0] === 0x50 && buf[1] === 0x4b;
  if (name.endsWith('.xls') && !zip) throw err('Old .xls files are not supported — in Excel use File → Save As → "Excel Workbook (.xlsx)".');
  if (zip) {
    let wb = new ExcelJS.Workbook();
    try { await wb.xlsx.load(buf); } catch (e) {
      try { wb = new ExcelJS.Workbook(); await wb.xlsx.load(await stripXlsxComments(buf)); } catch (e2) { throw err("This Excel file couldn't be opened. Save it as .xlsx or .csv and try again."); }
    }
    for (const ws of wb.worksheets.filter(w => w.state !== 'hidden' && w.state !== 'veryHidden')) {
      const rows = [];
      ws.eachRow({ includeEmpty: true }, (row, n) => { const v = []; for (let c = 1; c <= Math.max(ws.actualColumnCount || 0, row.cellCount); c++) v.push(excelCellValue(row.getCell(c).value)); rows[n - 1] = v; });
      for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
      if (headerRow(rows) >= 0) return rows;
    }
    throw err('No sheet has a "Name" column. Use the template.');
  }
  if (!name || /\.(csv|txt|tsv)$/.test(name)) return parseCSV(buf.toString('utf8'));
  throw err('Upload a .xlsx or .csv file.');
}
const lookup = {}; for (const [f, list] of Object.entries(FIELDS)) for (const a of list) lookup[a] = f;
function headerRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 10); i++) if ((rows[i] || []).some(h => lookup[normHeader(h)] === 'name')) return i;
  return -1;
}
const cellText = (v) => v instanceof Date ? v.toISOString().slice(0, 10) : String(v == null ? '' : v).trim();
function toDay(v) {
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
  const s = String(v || '').trim(); if (!s) return null;
  let y, mo, d, m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) [y, mo, d] = [m[1], m[2], m[3]];
  else if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s))) [y, mo, d] = [m[3], m[2], m[1]];
  else return 'bad';
  const iso = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  const dt = new Date(`${iso}T00:00:00Z`);
  return !isNaN(dt) && dt.toISOString().slice(0, 10) === iso && +y >= 1900 && +y <= 2100 ? iso : 'bad';
}
function slug(name) {
  const parts = String(name).toLowerCase().normalize('NFKD').replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  return (parts.length > 1 ? `${parts[0]}.${parts[parts.length - 1][0]}` : parts[0]).slice(0, 30);
}
function tempPassword() {
  const letters = 'abcdefghjkmnpqrstuvwxyz', digits = '23456789';
  const pick = (set, n) => Array.from(crypto.randomBytes(n), b => set[b % set.length]).join('');
  return `${pick(letters, 1).toUpperCase()}${pick(letters, 4)}@${pick(digits, 4)}`;
}

// → { rows: [{ row, name, username, role, team, designation, phone, email, dob, join_date, password, generatedPassword, generatedUsername, errors: [] }], columns, unknown }
async function planAccountImport(body, { existingUsernames, validatePassword, roles }) {
  const grid = await readGrid(body.file, body.fileName);
  const h = headerRow(grid);
  if (h < 0) throw err('The file needs a "Name" column (and optionally Username, Password, Role, Department, Designation, Phone, Email, Date of birth, Joining date). Download the template.');
  const map = {}, unknown = [];
  grid[h].forEach((raw, i) => { const f = lookup[normHeader(raw)]; if (f && !Object.values(map).includes(f)) map[i] = f; else if (String(raw || '').trim()) unknown.push(String(raw).trim()); });
  const data = grid.slice(h + 1).filter(r => (r || []).some(v => cellText(v)));
  if (!data.length) throw err('The file has no rows under the headings.');
  if (data.length > MAX_ROWS) throw err(`At most ${MAX_ROWS} accounts per file.`);
  const taken = new Set([...existingUsernames].map(u => String(u).toLowerCase()));
  const inFile = new Set();
  const rows = data.map((r, idx) => {
    const o = { row: h + idx + 2, errors: [] };
    for (const [i, f] of Object.entries(map)) o[f] = r[i];
    const x = { row: o.row, errors: [] };
    x.name = cellText(o.name).replace(/\s+/g, ' ').slice(0, 80);
    if (!x.name) x.errors.push('Name is missing.');
    let u = cellText(o.username).toLowerCase();
    if (!u && x.name) {
      const base = slug(x.name); u = base; let n = 2;
      while (u && (taken.has(u) || inFile.has(u))) u = `${base}${n++}`;
      x.generatedUsername = true;
    }
    x.username = u;
    if (!/^[a-z0-9._-]{3,40}$/.test(u)) x.errors.push('Username must be 3-40 characters: letters, numbers, dots, underscores or hyphens.');
    else if (taken.has(u)) x.errors.push(`Username "${u}" already exists.`);
    else if (inFile.has(u)) x.errors.push(`Username "${u}" is twice in the file.`);
    if (u) inFile.add(u);
    const roleRaw = normHeader(cellText(o.role));
    x.role = roleRaw ? ROLE_ALIASES[roleRaw] : 'member';
    if (!x.role || !roles.includes(x.role)) { x.errors.push(`Unknown role "${cellText(o.role)}" — use Member, Director or Admin.`); x.role = 'member'; }
    x.team = cellText(o.team).slice(0, 60) || null;
    x.designation = cellText(o.designation).slice(0, 80) || null;
    x.phone = cellText(o.phone).replace(/[^\d+]/g, '').slice(0, 15) || null;
    if (x.phone && x.phone.replace(/\D/g, '').length < 10) x.errors.push('Phone number looks too short.');
    x.email = cellText(o.email).toLowerCase().slice(0, 120) || null;
    if (x.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x.email)) x.errors.push('Email is not valid.');
    for (const f of ['dob', 'join_date']) { const d = toDay(o[f]); if (d === 'bad') x.errors.push(`${f === 'dob' ? 'Date of birth' : 'Joining date'} must be dd-mm-yyyy or yyyy-mm-dd.`); x[f] = d === 'bad' ? null : d; }
    const pw = cellText(o.password);
    if (pw) { const pe = validatePassword(pw); if (pe) x.errors.push(`Password: ${pe}`); x.password = pw; }
    else { x.password = tempPassword(); x.generatedPassword = true; }
    return x;
  });
  return { rows, columns: Object.values(map), unknown };
}

async function buildAccountTemplate() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Accounts');
  ws.columns = [['Name', 24], ['Username', 16], ['Password', 16], ['Role', 12], ['Department', 22], ['Designation', 22], ['Phone', 14], ['Email', 26], ['Date of birth', 14], ['Joining date', 14]].map(([header, width]) => ({ header, width }));
  ws.getRow(1).font = { bold: true };
  ws.addRow(['Rahul Patil', 'rahul.p', '', 'Member', 'Execution Department', 'Site Engineer', '9876543210', 'rahul@example.com', '15-08-1995', '01-04-2024']);
  ws.addRow(['Sneha Kulkarni', '', '', 'Member', 'Purchase Department', 'Purchase Executive', '', '', '', '']);
  const help = wb.addWorksheet('How to fill');
  help.columns = [{ width: 110 }];
  for (const line of ['Only Name is required. One person per row; delete the two example rows.',
    'Username — left empty: made from the name (e.g. rahul.p). Letters, numbers, dots only.',
    'Password — left empty: a temporary password is generated and shown after the import. Everyone must change it at the first login.',
    'Role — Member (default), Director or Admin.', 'Department — the department name as used in the app (a new name is added to the list).',
    'Dates — dd-mm-yyyy or yyyy-mm-dd.']) help.addRow([line]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// Export accounts to Excel. The first columns use the same headings as the import template, so the file can be
// edited and imported elsewhere; passwords are never exported (only whether a recovery PIN is set).
async function buildAccountExport(users) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'MIHIR Task Manager'; wb.created = new Date();
  const ws = wb.addWorksheet('Accounts', { views: [{ state: 'frozen', ySplit: 1 }] });
  const dmy = (d) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || '')); return m ? `${m[3]}-${m[2]}-${m[1]}` : ''; };
  const ist = (t) => { const x = Date.parse(t || ''); return isNaN(x) ? '' : new Date(x).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); };
  const ROLE = { member: 'Member', director: 'Director', admin: 'Admin' };
  ws.columns = [['Name', 24], ['Username', 16], ['Role', 10], ['Department', 24], ['Designation', 22], ['Phone', 14], ['Email', 28], ['Date of birth', 13], ['Joining date', 13],
    ['Team lead', 10], ['Recovery PIN set', 15], ['Must change password', 20], ['Account created', 20], ['Last active', 20]].map(([header, width]) => ({ header, width }));
  ws.getRow(1).font = { bold: true }; ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF8' } };
  for (const u of users) {
    ws.addRow([u.name, u.username, ROLE[u.role] || u.role, u.team || '', u.designation || '', u.phone || '', u.email || '', dmy(u.dob), dmy(u.join_date),
      Number(u.is_team_lead) ? 'Yes' : '', u.has_pin ? 'Yes' : 'No', Number(u.must_change_password) ? 'Yes' : '', ist(u.created_at), ist(u.last_active_at)]);
  }
  ws.getColumn(6).numFmt = '@';
  ws.autoFilter = { from: 'A1', to: { row: 1, column: ws.columns.length } };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { planAccountImport, buildAccountTemplate, buildAccountExport, MAX_ROWS };
