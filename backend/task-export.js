// Task history with timestamps: (1) a standalone history spreadsheet for any period, and
// (2) writing each task's status + timestamps back into a schedule spreadsheet (the same file that
// was imported), matched row-by-row on its Task Key.
//
// All times are shown in the company's local time (APP_TIMEZONE, default Asia/Kolkata) as real
// Excel date-times, so they sort and filter properly in Excel.

const ExcelJS = require('exceljs');
const { normHeader, findHeaderRow, excelCellValue, stripXlsxComments } = require('./task-import');

const TZ = process.env.APP_TIMEZONE || 'Asia/Kolkata';
const DATE_TIME_FMT = 'dd/mm/yyyy hh:mm';
const DATE_FMT = 'dd/mm/yyyy';

// ISO instant → a Date whose UTC fields hold the local wall-clock time (what Excel stores).
function toExcelDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d)) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute));
}
// Deadlines are stored as local wall-clock text ("2026-10-15" or "2026-10-15T17:00").
function deadlineToExcelDate(deadline) {
  if (!deadline) return null;
  const m = String(deadline).match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0));
}
// The instant a deadline ends: date-only deadlines run to the end of that local day.
function deadlineEndsAt(deadline) {
  const local = deadlineToExcelDate(deadline);
  if (!local) return null;
  const hasTime = /T\d{2}:\d{2}/.test(String(deadline));
  const localMs = local.getTime() + (hasTime ? 0 : 86400000 - 60000);
  // shift local wall-clock back to a real instant using the zone's offset at that time
  const probe = toExcelDate(new Date(localMs).toISOString());
  const offset = probe.getTime() - localMs;
  return new Date(localMs - offset);
}
const minIso = arr => arr.filter(Boolean).sort()[0] || null;
const maxIso = arr => arr.filter(Boolean).sort().slice(-1)[0] || null;
function fmtLocal(iso) {
  const d = toExcelDate(iso); if (!d) return '';
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

// Everything the history export and the schedule write-back show for one task.
function describeTask(t, now = new Date()) {
  const a = t.assignees || [];
  const approved = a.filter(x => x.decision === 'approve' && x.completed_at);
  const started = minIso(a.filter(x => x.is_released).map(x => x.released_at || x.escalation_baseline_at || t.created_at));
  const submitted = maxIso(a.map(x => x.submitted_at));
  const approvedAt = maxIso(approved.map(x => x.completed_at));
  const finishedAt = t.status === 'closed' ? t.closed_at : t.status === 'cancelled' ? t.cancelled_at : null;
  const finishedBy = t.status === 'closed' ? t.closed_by : t.status === 'cancelled' ? t.cancelled_by : null;
  const status = t.status === 'closed' ? 'Completed' : t.status === 'cancelled' ? 'Cancelled' : (a.length === 0 ? 'Open — not tagged yet' : 'Open');
  const daysFrom = started || t.created_at;
  const daysTaken = finishedAt && daysFrom ? Math.round((new Date(finishedAt) - new Date(daysFrom)) / 864e5 * 10) / 10 : null;
  const due = deadlineEndsAt(t.deadline);
  let result = '';
  if (due) {
    if (t.status === 'closed') {
      const doneAt = new Date(approvedAt || finishedAt);
      const late = Math.ceil((doneAt - due) / 864e5);
      result = doneAt <= due ? 'On time' : `${late} day${late === 1 ? '' : 's'} late`;
    } else if (t.status === 'open' && now > due) {
      const late = Math.ceil((now - due) / 864e5);
      result = `Overdue by ${late} day${late === 1 ? '' : 's'}`;
    } else if (t.status === 'open') result = 'Not due yet';
  }
  const people = a.map(x => x.name ? `${x.name} (${x.username})` : x.username).join(', ');
  const timeline = a.map(x => {
    const bits = [`L${x.stage || 1} ${x.username}`];
    if (x.submitted_at) bits.push(`submitted ${fmtLocal(x.submitted_at)}`);
    if (x.decision === 'approve' && x.completed_at) bits.push(`approved ${fmtLocal(x.completed_at)}${x.completed_by ? ' by ' + x.completed_by : ''}`);
    else if (!x.is_released) bits.push('on hold');
    else if (!x.submitted_at) bits.push('not submitted');
    return bits.join(', ');
  }).join(' | ');
  const comments = (t.replies || []).map(r => `[${fmtLocal(r.created_at)}] ${r.by_name || r.by_username}: ${String(r.message || '').replace(/\s+/g, ' ').trim()}${r.attachment_name ? ` (file: ${r.attachment_name})` : ''}`).join('\n').slice(0, 30000);
  return { status, people, started, submitted, approvedAt, finishedAt, finishedBy, doneBy: approved.map(x => x.name || x.username).join(', '), daysTaken, result, timeline, comments };
}

const HISTORY_COLUMNS = [
  ['Task ID', 14], ['Task Key', 16], ['Title', 50], ['Project', 22], ['Phase', 18], ['Priority', 9], ['Status', 14],
  ['Created', 16], ['Created By', 18], ['Deadline', 16], ['Tagged People', 30], ['Started', 16], ['Submitted', 16], ['Approved', 16],
  ['Completed / Cancelled', 18], ['Closed By', 18], ['Done By', 22], ['Days Taken', 10], ['Result vs Deadline', 16],
  ['Per-Person Timeline', 60], ['Comments', 60], ['Removed From Site', 16],
];
async function buildHistoryWorkbook(tasks, { title, from, to, mode }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'MIHIR Task Manager';
  const ws = wb.addWorksheet('Task history', { views: [{ state: 'frozen', ySplit: 1, xSplit: 3 }] });
  ws.addRow(HISTORY_COLUMNS.map(c => c[0]));
  HISTORY_COLUMNS.forEach(([, w], i) => { ws.getColumn(i + 1).width = w; });
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } }; head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3A5F' } };
  head.alignment = { vertical: 'middle', wrapText: true }; head.height = 30;
  const counts = { total: 0, completed: 0, cancelled: 0, open: 0, onTime: 0, late: 0 };
  const byProject = new Map();
  for (const t of tasks) {
    const d = describeTask(t);
    const row = ws.addRow([t.id, t.import_key || '', t.title, t.project || '', t.phase || '', t.priority || '', d.status,
      toExcelDate(t.created_at), t.created_by || '', deadlineToExcelDate(t.deadline), d.people, toExcelDate(d.started), toExcelDate(d.submitted),
      toExcelDate(d.approvedAt), toExcelDate(d.finishedAt), d.finishedBy || '', d.doneBy, d.daysTaken, d.result, d.timeline, d.comments,
      t.archived_at ? toExcelDate(t.archived_at) : '']);
    [8, 12, 13, 14, 15, 22].forEach(c => { row.getCell(c).numFmt = DATE_TIME_FMT; });
    row.getCell(10).numFmt = /T/.test(String(t.deadline || '')) ? DATE_TIME_FMT : DATE_FMT;
    row.getCell(21).alignment = { wrapText: false };
    if (d.result.endsWith('late') || d.result.startsWith('Overdue')) row.getCell(19).font = { color: { argb: 'FFC0392B' }, bold: true };
    else if (d.result === 'On time') row.getCell(19).font = { color: { argb: 'FF2F9E5B' }, bold: true };
    counts.total++;
    if (t.status === 'closed') { counts.completed++; if (d.result === 'On time') counts.onTime++; else if (d.result.endsWith('late')) counts.late++; }
    else if (t.status === 'cancelled') counts.cancelled++; else counts.open++;
    const pk = t.project || '(no project)';
    if (!byProject.has(pk)) byProject.set(pk, { total: 0, completed: 0, onTime: 0, late: 0, open: 0 });
    const pr = byProject.get(pk); pr.total++;
    if (t.status === 'closed') { pr.completed++; if (d.result === 'On time') pr.onTime++; else if (d.result.endsWith('late')) pr.late++; }
    if (t.status === 'open') pr.open++;
  }
  if (tasks.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: tasks.length + 1, column: HISTORY_COLUMNS.length } };

  const s = wb.addWorksheet('Summary');
  s.getColumn(1).width = 34; for (let c = 2; c <= 6; c++) s.getColumn(c).width = 13;
  s.addRow([title]).font = { bold: true, size: 14 };
  s.addRow([`${mode === 'completed' ? 'Tasks completed or cancelled' : 'Tasks created'} ${from ? 'from ' + fmtLocal(from).slice(0, 10) : 'from the start'} to ${fmtLocal(to || new Date().toISOString()).slice(0, 10)} · generated ${fmtLocal(new Date().toISOString())} (${TZ})`]).font = { italic: true, color: { argb: 'FF7F7F7F' } };
  s.addRow([]);
  [['Tasks in this file', counts.total], ['Completed', counts.completed], ['  – on time', counts.onTime], ['  – late', counts.late], ['Cancelled', counts.cancelled], ['Still open', counts.open],
   ['On-time rate (of completed)', counts.completed ? counts.onTime / counts.completed : null]].forEach(([k, v]) => {
    const r = s.addRow([k, v]); if (k.startsWith('On-time')) r.getCell(2).numFmt = '0%';
  });
  s.addRow([]);
  const ph = s.addRow(['Project', 'Tasks', 'Completed', 'On time', 'Late', 'Open']);
  ph.font = { bold: true, color: { argb: 'FFFFFFFF' } }; ph.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3A5F' } };
  [...byProject.entries()].sort((a, b) => a[0].localeCompare(b[0])).forEach(([k, v]) => s.addRow([k, v.total, v.completed, v.onTime, v.late, v.open]));
  wb.views = [{ activeTab: 0 }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// Columns written into a schedule spreadsheet. "Info:" headings are ignored by the importer, so the
// filled-in file can be uploaded again as-is.
const SCHEDULE_COLUMNS = ['Info: Status', 'Info: Task ID', 'Info: Tagged', 'Info: Started', 'Info: Submitted', 'Info: Approved',
  'Info: Completed At', 'Info: Closed By', 'Info: Done By', 'Info: Days Taken', 'Info: Result', 'Info: Updated'];

async function fillScheduleTimestamps(buffer, lookupTasks) {
  let wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buffer); } catch (e) {
    wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await stripXlsxComments(buffer));
  }
  // The task sheet = first sheet with a Title column, same rule the importer uses.
  let ws = null, headerRowNo = -1;
  for (const sheet of wb.worksheets) {
    const grid = [];
    for (let r = 1; r <= Math.min(sheet.rowCount, 10); r++) {
      const row = sheet.getRow(r); const vals = [];
      for (let c = 1; c <= Math.max(sheet.columnCount, row.cellCount); c++) vals.push(excelCellValue(row.getCell(c).value));
      grid.push(vals);
    }
    const h = findHeaderRow(grid);
    if (h >= 0) { ws = sheet; headerRowNo = h + 1; break; }
  }
  if (!ws) { const e = new Error('Couldn\'t find the task sheet (a sheet with a "Title" column) in this file.'); e.isImportError = true; throw e; }
  const header = ws.getRow(headerRowNo);
  const lastCol = Math.max(ws.columnCount, header.cellCount);
  const colOf = {};
  let keyCol = null, titleCol = null, importCol = null;
  for (let c = 1; c <= lastCol; c++) {
    const h = normHeader(excelCellValue(header.getCell(c).value));
    if (['task key', 'schedule key', 'activity id', 'activity key', 'unique id', 'unique key', 'import key', 'permanent id'].includes(h)) keyCol = c;
    if (['title', 'task', 'task title', 'task name', 'subject', 'work', 'activity'].includes(h)) titleCol = c;
    if (['import', 'include', 'import this', 'import row', 'to import'].includes(h)) importCol = c;
    for (const name of SCHEDULE_COLUMNS) if (normHeader(name) === h) colOf[name] = c;
  }
  if (!keyCol && !titleCol) { const e = new Error('The task sheet needs a Task Key (or Title) column to match rows to tasks.'); e.isImportError = true; throw e; }
  // Add any missing timestamp columns at the end, styled like the existing header row.
  let next = lastCol + 1;
  const style = header.getCell(lastCol);
  for (const name of SCHEDULE_COLUMNS) {
    if (colOf[name]) continue;
    const cell = header.getCell(next);
    cell.value = name;
    cell.font = { ...(style.font || {}), bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F6B4F' } };
    cell.alignment = { wrapText: true, vertical: 'middle' };
    ws.getColumn(next).width = name === 'Info: Tagged' || name === 'Info: Done By' ? 26 : name === 'Info: Status' ? 18 : 16;
    colOf[name] = next++;
  }
  const keys = [], titles = [];
  for (let r = headerRowNo + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    if (keyCol) { const k = String(excelCellValue(row.getCell(keyCol).value) || '').trim(); if (k) keys.push(k); }
    if (titleCol) { const t = String(excelCellValue(row.getCell(titleCol).value) || '').trim(); if (t) titles.push(t); }
  }
  const { byKey, byTitle } = await lookupTasks({ keys, titles });
  const stamp = toExcelDate(new Date().toISOString());
  const stats = { rows: 0, matched: 0, completed: 0, open: 0, cancelled: 0, notImported: 0 };
  for (let r = headerRowNo + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const key = keyCol ? String(excelCellValue(row.getCell(keyCol).value) || '').trim() : '';
    const title = titleCol ? String(excelCellValue(row.getCell(titleCol).value) || '').trim() : '';
    if (!key && !title) continue;
    stats.rows++;
    const t = (key && byKey.get(key)) || (!key && title && byTitle.get(title.toLowerCase())) || null;
    const set = (name, value, fmt) => { const cell = row.getCell(colOf[name]); cell.value = value === undefined ? null : value; if (fmt) cell.numFmt = fmt; };
    if (!t) {
      const skipped = importCol && /^(no|n|false|0|skip|later)$/i.test(String(excelCellValue(row.getCell(importCol).value) || '').trim());
      set('Info: Status', skipped ? 'Not imported (Import = No)' : 'Not imported yet');
      for (const name of SCHEDULE_COLUMNS.slice(1)) if (name !== 'Info: Updated') set(name, null);
      set('Info: Updated', stamp, DATE_TIME_FMT);
      stats.notImported++;
      continue;
    }
    stats.matched++;
    const d = describeTask(t);
    if (t.status === 'closed') stats.completed++; else if (t.status === 'cancelled') stats.cancelled++; else stats.open++;
    set('Info: Status', d.status + (t.archived_at ? ' (removed from site)' : ''));
    set('Info: Task ID', t.id);
    set('Info: Tagged', d.people || null);
    set('Info: Started', toExcelDate(d.started), DATE_TIME_FMT);
    set('Info: Submitted', toExcelDate(d.submitted), DATE_TIME_FMT);
    set('Info: Approved', toExcelDate(d.approvedAt), DATE_TIME_FMT);
    set('Info: Completed At', toExcelDate(d.finishedAt), DATE_TIME_FMT);
    set('Info: Closed By', d.finishedBy || null);
    set('Info: Done By', d.doneBy || null);
    set('Info: Days Taken', d.daysTaken);
    set('Info: Result', d.result || null);
    set('Info: Updated', stamp, DATE_TIME_FMT);
    const statusCell = row.getCell(colOf['Info: Status']);
    statusCell.font = { bold: true, color: { argb: t.status === 'closed' ? 'FF2F9E5B' : t.status === 'cancelled' ? 'FF7F7F7F' : 'FF2D5FA8' } };
  }
  // Excel recalculates every formula (deadlines etc.) when the file is opened.
  wb.calcProperties = { ...(wb.calcProperties || {}), fullCalcOnLoad: true };
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), stats };
}

module.exports = { buildHistoryWorkbook, fillScheduleTimestamps, describeTask, toExcelDate, deadlineEndsAt, SCHEDULE_COLUMNS };
