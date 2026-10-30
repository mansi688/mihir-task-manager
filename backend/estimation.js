/* Estimation & Billing department — the work-package flow of a construction firm:

   1. ESTIMATE (EST-…): project, work item / package, contractor, description, plus two REQUIRED files attached
      separately — the HighRise document (kind 'highrise') and the estimate Excel (kind 'excel').
      Sent for approval to the PROJECT HEADS (PROJECT_HEADS in server.js: Amara → Suraj Kathale & Rahul Paigude,
      Equinox → Anil Wagh & Siddheshwar Puri, Tathawade → Dnyaneshwar Kolekar; a project without heads → Admin).
      ALL heads of the project must approve; Admin can approve on behalf of all. Anyone of them can reject (reason
      required) → returned to the estimator, who corrects and sends again (a new approval round).
   2. On approval the estimate is OPEN FOR JMR (notification to the estimator and the Estimation team).
   3. JMR (Joint Measurement Record, one RA bill) — only against an estimate open for JMR; each JMR goes through the
      same approval. The estimator ticks "Final JMR" on the last one; when that is approved, the JMR stage closes and
      the RECONCILIATION REPORT is requested (notification).
   4. RECONCILIATION — material issued vs work done (below); same approval. When every reconciliation of the estimate
      is approved, the estimate is COMPLETED.

   Reconciliation maths:
     actual consumption   = issued − returned − balance still at site
     theoretical          = work done × consumption norm
     allowed              = theoretical × (1 + wastage %)
     excess (recoverable) = actual − allowed (if more)       → recovery = excess × rate
     saving               = theoretical − actual (if less)

   Who: the Estimation & Billing Department (and Admin) create and edit. Approve: the project's heads and Admin.
   View: Estimation & Billing, Purchase, the project heads and Admin. Remarks any time; files: HighRise downloadable,
   the rest view-only. */
const STATUS = ['draft', 'submitted', 'approved', 'returned'];

const ExcelJS = require('exceljs');
const { decodeDataUrl, excelCellValue, stripXlsxComments, parseCSV } = require('./task-import');
// First sheets of an Excel / CSV file as rows of text, for showing on screen.
async function sheetPreview(dataUrl, name, maxRows = 300, maxCols = 30) {
  const buf = decodeDataUrl(dataUrl);
  const isZip = buf.length > 3 && buf[0] === 0x50 && buf[1] === 0x4b;
  const fmt = v => v instanceof Date ? v.toISOString().slice(0, 10) : String(v == null ? '' : v);
  if (!isZip) return [{ name: String(name || 'Sheet'), rows: parseCSV(buf.toString('utf8')).slice(0, maxRows).map(r => r.slice(0, maxCols)), more: false }];
  let wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buf); } catch (e) { wb = new ExcelJS.Workbook(); await wb.xlsx.load(await stripXlsxComments(buf)); }
  const out = [];
  for (const ws of wb.worksheets.slice(0, 8)) {
    if (ws.state === 'hidden' || ws.state === 'veryHidden') continue;
    const rows = []; let more = false;
    ws.eachRow({ includeEmpty: true }, (row, n) => {
      if (n > maxRows) { more = true; return; }
      const v = []; for (let c = 1; c <= Math.min(maxCols, Math.max(ws.actualColumnCount || 0, row.cellCount)); c++) v.push(fmt(excelCellValue(row.getCell(c).value)));
      rows[n - 1] = v;
    });
    for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
    out.push({ name: ws.name, rows, more });
  }
  return out;
}

function mountEstimation(app, deps) {
  const { db, auth, ALL_ROLES, auditFromReq, collectUploads, MAX_FILE_CHARS, str, PROJECT_OPTIONS, PROJECT_HEADS } = deps;
  const q = (sql, params = []) => db.pool.query(sql, params);
  const rows = async (sql, params) => (await q(sql, params)).rows;
  const one = async (sql, params) => (await q(sql, params)).rows[0] || null;
  const now = () => new Date().toISOString();
  const num = (v) => { if (v === '' || v == null) return null; const n = Number(v); return isFinite(n) ? n : NaN; };
  const r3 = (n) => Math.round(n * 1000) / 1000;
  const r2 = (n) => Math.round(n * 100) / 100;
  const genRef = (p) => `${p}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

  // ---- who may do what
  const HEADS = PROJECT_HEADS || {};
  async function me(user) {
    const u = await db.getUserFresh(user.username);
    const team = String((u && u.team) || '');
    const isEst = /estimat|billing/i.test(team);
    const admin = user.role === 'admin';
    const headOf = Object.keys(HEADS).filter(p => (HEADS[p] || []).includes(user.username));
    return {
      username: user.username, name: (u && u.name) || user.name, team, admin,
      canEdit: admin || isEst,
      approveAll: admin, headOf,
      isAccounts: /account/i.test(team),
      canView: admin || isEst || headOf.length > 0 || /purchase/i.test(team),
    };
  }
  // The heads who must approve for a project (existing accounts); a project without heads is approved by Admin.
  async function headsFor(project) {
    const users = await db.listUsers();
    return (HEADS[project] || []).filter(h => users.some(u => u.username === h));
  }
  const canApprove = (m, project) => m.admin || (HEADS[project] || []).includes(m.username);
  async function approversFor(project) {
    const users = await db.listUsers();
    return [...new Set([...(await headsFor(project)), ...users.filter(u => u.role === 'admin').map(u => u.username)])];
  }
  async function estimationTeam() { return (await db.listUsers()).filter(u => /estimat|billing/i.test(u.team || '')).map(u => u.username); }
  const notify = async (users, except, type, message) => { for (const u of new Set(users)) if (u && u !== except) await db.createNotification({ username: u, type, message, task_id: null }); };

  const readSource = (b) => collectUploads({ attachments: Array.isArray(b.source_files) ? b.source_files : [] }, MAX_FILE_CHARS);
  const hasSource = async (type, id) => !!(await one("SELECT 1 FROM est_files WHERE parent_type=$1 AND parent_id=$2 AND kind='source' LIMIT 1", [type, id]));
  const NEED_SOURCE = 'Attach the HighRise / estimation document (Excel, PDF or any format) before sending it for approval.';
  // ---- JMR maths
  function lineQty(l) {
    if (l.manual) return r3((l.deduct ? -1 : 1) * Math.abs(Number(l.qty) || 0));
    const f = [l.nos, l.length, l.breadth, l.height].filter(v => v != null && v !== '' && isFinite(Number(v))).map(Number);
    if (!f.length) return 0;
    return r3((l.deduct ? -1 : 1) * f.reduce((a, b) => a * b, 1));
  }
  function readLines(list) {
    if (!Array.isArray(list)) return { error: 'Add the measurements.' };
    if (list.length > 300) return { error: 'Too many measurement lines (max 300).' };
    const out = [];
    for (const [i, x] of list.entries()) {
      const l = { description: str(x.description).trim().slice(0, 300), nos: num(x.nos), length: num(x.length), breadth: num(x.breadth), height: num(x.height),
        qty: num(x.qty), manual: !!x.manual, deduct: !!x.deduct, remarks: str(x.remarks).trim().slice(0, 300), sort: i };
      if ([l.nos, l.length, l.breadth, l.height, l.qty].some(v => Number.isNaN(v))) return { error: `Line ${i + 1}: numbers only in Nos / L / B / H / Qty.` };
      if (!l.description && l.nos == null && l.length == null && l.breadth == null && l.height == null && l.qty == null) continue; // blank row
      l.qty = lineQty(l);
      out.push(l);
    }
    if (!out.length) return { error: 'Add at least one measurement line.' };
    return { lines: out, total: r3(out.reduce((a, l) => a + l.qty, 0)) };
  }
  function readJmrFields(b) {
    const f = {
      project: str(b.project).trim(), location: str(b.location).trim().slice(0, 200) || null, work_item: str(b.work_item).trim().slice(0, 300),
      material: str(b.material).trim().slice(0, 200) || null, contractor: str(b.contractor).trim().slice(0, 200) || null, unit: str(b.unit).trim().slice(0, 20), measured_on: str(b.measured_on).slice(0, 10) || null, period_from: str(b.period_from).slice(0, 10) || null, period_to: str(b.period_to).slice(0, 10) || null,
      ra_bill_no: str(b.ra_bill_no).trim().slice(0, 40) || null, client_rep: str(b.client_rep).trim().slice(0, 120) || null, contractor_rep: str(b.contractor_rep).trim().slice(0, 120) || null,
      notes: str(b.notes).trim().slice(0, 2000) || null,
    };
    if (!PROJECT_OPTIONS.includes(f.project)) return { error: `Pick the project: ${PROJECT_OPTIONS.join(', ')}.` };
    if (!f.work_item) return { error: 'Write the work item (e.g. "RCC M25 — slab").' };
    if (!f.unit) return { error: 'Pick the unit.' };
    return { f };
  }
  function readReconFields(b) {
    const f = {
      project: str(b.project).trim(), material: str(b.material).trim().slice(0, 200), unit: str(b.unit).trim().slice(0, 20), contractor: str(b.contractor).trim().slice(0, 200) || null,
      work_item: str(b.work_item).trim().slice(0, 300) || null, period_from: str(b.period_from).slice(0, 10) || null, period_to: str(b.period_to).slice(0, 10) || null,
      issued: num(b.issued), returned: num(b.returned), balance_at_site: num(b.balance_at_site), work_qty: num(b.work_qty), work_unit: str(b.work_unit).trim().slice(0, 20) || null,
      norm: num(b.norm), wastage_pct: num(b.wastage_pct), rate: num(b.rate), notes: str(b.notes).trim().slice(0, 2000) || null,
    };
    if (!PROJECT_OPTIONS.includes(f.project)) return { error: `Pick the project: ${PROJECT_OPTIONS.join(', ')}.` };
    if (!f.material) return { error: 'Write the material (e.g. "Cement OPC 53").' };
    if (!f.unit) return { error: 'Pick the unit of the material.' };
    for (const k of ['issued', 'returned', 'balance_at_site', 'work_qty', 'norm', 'wastage_pct', 'rate']) if (Number.isNaN(f[k]) || (f[k] != null && f[k] < 0)) return { error: `${k.replace(/_/g, ' ')} must be a number (0 or more).` };
    for (const k of ['issued', 'returned', 'balance_at_site', 'work_qty', 'norm', 'wastage_pct']) if (f[k] == null) f[k] = 0;
    if (f.returned + f.balance_at_site > f.issued + 1e-9) return { error: 'Returned + balance at site cannot be more than issued.' };
    if (f.wastage_pct > 100) return { error: 'Wastage % looks wrong (more than 100).' };
    return { f };
  }
  function reconCalc(r) {
    const issued = Number(r.issued) || 0, returned = Number(r.returned) || 0, bal = Number(r.balance_at_site) || 0;
    const actual = r3(issued - returned - bal);
    const theoretical = r3((Number(r.work_qty) || 0) * (Number(r.norm) || 0));
    const allowed = r3(theoretical * (1 + (Number(r.wastage_pct) || 0) / 100));
    const excess = r3(Math.max(0, actual - allowed));
    const saving = r3(Math.max(0, theoretical - actual));
    const variancePct = theoretical ? r2((actual - theoretical) / theoretical * 100) : null;
    const recovery = r.rate != null ? r2(excess * Number(r.rate)) : null;
    return { actual, theoretical, allowed, excess, saving, variancePct, recovery };
  }

  // ---- loading
  async function loadAll() {
    const jmr = await rows('SELECT * FROM est_jmr ORDER BY created_at DESC LIMIT 3000');
    const ids = jmr.map(j => j.id);
    const lines = ids.length ? await rows('SELECT * FROM est_jmr_lines WHERE jmr_id = ANY($1::int[]) ORDER BY jmr_id, sort, id', [ids]) : [];
    const recon = await rows('SELECT * FROM est_recon ORDER BY created_at DESC LIMIT 3000');
    const files = await rows('SELECT id, parent_type, parent_id, name, kind, uploaded_by, created_at FROM est_files ORDER BY id');
    const comments = await rows('SELECT * FROM est_comments ORDER BY id');
    const approvals = await rows('SELECT * FROM est_approvals ORDER BY id');
    const estimates = await rows('SELECT * FROM est_estimates ORDER BY created_at DESC LIMIT 2000');
    const users = await db.listUsers();
    const nameOf = (u) => (users.find(x => x.username === u) || {}).name || u;
    // The heads' decisions for the current round: who approved, who is still to approve.
    const approvalState = (type, x) => {
      const heads = (HEADS[x.project] || []).filter(h => users.some(u => u.username === h));
      const mine = approvals.filter(a => a.parent_type === type && a.parent_id === x.id && a.round === (Number(x.round) || 1));
      return { heads: heads.map(h => ({ username: h, name: nameOf(h), decision: (mine.find(a => a.username === h) || {}).decision || null })),
        decisions: mine.map(a => ({ username: a.username, name: a.name, decision: a.decision, note: a.note, onBehalf: !!a.on_behalf, at: a.created_at })) };
    };
    const N = v => v == null ? null : Number(v);
    const jmrOut = jmr.map(j => ({ ...j, rate: N(j.rate), total_qty: N(j.total_qty), amount: N(j.amount),
      lines: lines.filter(l => l.jmr_id === j.id).map(l => ({ ...l, nos: N(l.nos), length: N(l.length), breadth: N(l.breadth), height: N(l.height), qty: N(l.qty), manual: !!l.manual, deduct: !!l.deduct })),
      is_final: !!j.is_final, approval: approvalState('jmr', j),
      files: files.filter(f => f.parent_type === 'jmr' && f.parent_id === j.id), comments: comments.filter(c => c.parent_type === 'jmr' && c.parent_id === j.id) }));
    // Quantity approved before this JMR for the same project + work item + contractor (RA billing: previous / this / cumulative).
    const approved = jmrOut.filter(j => j.status === 'approved').sort((a, b) => String(a.decided_at).localeCompare(String(b.decided_at)) || a.id - b.id);
    for (const j of jmrOut) {
      const key = `${j.project}|${String(j.work_item).toLowerCase()}|${String(j.contractor || '').toLowerCase()}`;
      const prior = approved.filter(a => a.id !== j.id && `${a.project}|${String(a.work_item).toLowerCase()}|${String(a.contractor || '').toLowerCase()}` === key
        && (j.status !== 'approved' || String(a.decided_at).localeCompare(String(j.decided_at)) < 0 || (a.decided_at === j.decided_at && a.id < j.id)));
      j.prev_qty = r3(prior.reduce((s, a) => s + a.total_qty, 0));
      j.cum_qty = r3(j.prev_qty + j.total_qty);
    }
    const reconOut = recon.map(r => {
      const x = { ...r };
      for (const k of ['issued', 'returned', 'balance_at_site', 'work_qty', 'norm', 'wastage_pct', 'rate']) x[k] = N(r[k]);
      return { ...x, calc: reconCalc(x), approval: approvalState('recon', r), files: files.filter(f => f.parent_type === 'recon' && f.parent_id === r.id), comments: comments.filter(c => c.parent_type === 'recon' && c.parent_id === r.id) };
    });
    const estOut = estimates.map(e => {
      const js = jmrOut.filter(j => j.estimate_id === e.id), rs = reconOut.filter(r => r.estimate_id === e.id);
      return { ...e, approval: approvalState('estimate', e), files: files.filter(f => f.parent_type === 'estimate' && f.parent_id === e.id),
        comments: comments.filter(c => c.parent_type === 'estimate' && c.parent_id === e.id),
        jmrCount: js.length, jmrApproved: js.filter(j => j.status === 'approved').length, jmrQty: r3(js.filter(j => j.status === 'approved').reduce((a, j) => a + j.total_qty, 0)),
        reconCount: rs.length, reconApproved: rs.filter(r => r.status === 'approved').length };
    });
    return { estimates: estOut, jmr: jmrOut, recon: reconOut };
  }

  // ---- routes
  app.get('/api/estimation/summary', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user);
    if (!m.canView) return res.json({ canView: false });
    // Waiting for MY approval: submitted, in a project I approve for, and I have not approved it in this round.
    const sub = await rows(`SELECT 'estimate' AS t, id, project, round FROM est_estimates WHERE status='submitted'
      UNION ALL SELECT 'jmr', id, project, round FROM est_jmr WHERE status='submitted' UNION ALL SELECT 'recon', id, project, round FROM est_recon WHERE status='submitted'`);
    const done = sub.length ? await rows("SELECT parent_type, parent_id, round FROM est_approvals WHERE username=$1 AND decision='approve'", [m.username]) : [];
    const toApprove = sub.filter(x => canApprove(m, x.project) && !done.some(d => d.parent_type === x.t && d.parent_id === x.id && d.round === x.round)).length;
    const returned = m.canEdit ? Number((await one(`SELECT (SELECT COUNT(*) FROM est_jmr WHERE status='returned' AND created_by=$1) + (SELECT COUNT(*) FROM est_recon WHERE status='returned' AND created_by=$1)
      + (SELECT COUNT(*) FROM est_estimates WHERE status='returned' AND created_by=$1) AS n`, [m.username])).n) : 0;
    res.json({ canView: true, canEdit: m.canEdit, isAccounts: m.isAccounts, approveAll: m.approveAll, headOf: m.headOf, toApprove, returned });
  });
  app.get('/api/estimation', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user);
    if (!m.canView) return res.status(403).json({ error: 'The Estimation page is for the Estimation & Billing and Purchase departments, the approvers and Admin.' });
    const data = await loadAll();
    const users = await db.listUsers();
    const heads = Object.fromEntries(PROJECT_OPTIONS.map(p => [p, (HEADS[p] || []).filter(h => users.some(u => u.username === h)).map(h => ({ username: h, name: (users.find(u => u.username === h) || {}).name || h }))]));
    res.json({ me: { username: m.username, canEdit: m.canEdit, approveAll: m.approveAll, admin: m.admin, headOf: m.headOf, isAccounts: m.isAccounts }, projects: PROJECT_OPTIONS, heads, ...data });
  });

  const TABLE = { estimate: 'est_estimates', jmr: 'est_jmr', recon: 'est_recon' };
  const NAME = { estimate: 'estimate', jmr: 'JMR', recon: 'reconciliation' };
  const label = (type, x) => type === 'estimate' ? `Estimate ${x.ref} — ${x.title}${x.contractor ? ` (${x.contractor})` : ''}, ${x.project}`
    : type === 'jmr' ? `JMR ${x.ref} — ${x.work_item}${x.material ? ` / ${x.material}` : ''}${x.contractor ? ` (${x.contractor})` : ''}, ${x.project}${x.is_final ? ' [FINAL]' : ''}`
    : `Reconciliation ${x.ref} — ${x.material}${x.contractor ? ` (${x.contractor})` : ''}, ${x.project}`;
  const getEstimate = (id) => one('SELECT * FROM est_estimates WHERE id=$1', [Number(id) || 0]);
  const insertFiles = async (exec, type, id, files, kind, by, t) => { for (const file of files) await exec('INSERT INTO est_files(parent_type, parent_id, name, data, uploaded_by, created_at, kind) VALUES($1,$2,$3,$4,$5,$6,$7)', [type, id, file.name, file.data, by, t, kind]); };
  const readKind = (b, key) => collectUploads({ attachments: Array.isArray(b[key]) ? b[key] : [] }, MAX_FILE_CHARS);
  const hasKind = async (type, id, kinds) => !!(await one('SELECT 1 FROM est_files WHERE parent_type=$1 AND parent_id=$2 AND kind = ANY($3::text[]) LIMIT 1', [type, id, kinds]));
  const NEED_HIGHRISE = 'Attach the HighRise document before sending the estimate for approval.';
  const NEED_EXCEL = 'Attach the estimate Excel sheet (.xlsx / .xls / .csv) — separately from the HighRise document.';

  // ---- Estimate (work package)
  async function saveEstimate(req, res, existing) {
    const m = await me(req.user);
    if (!m.canEdit) return res.status(403).json({ error: 'Only the Estimation & Billing team (or Admin) can write estimates.' });
    const b = req.body || {};
    const f = { project: str(b.project).trim(), title: str(b.title).trim().slice(0, 300), contractor: str(b.contractor).trim().slice(0, 200) || null, description: str(b.description).trim().slice(0, 3000) || null };
    if (!PROJECT_OPTIONS.includes(f.project)) return res.status(400).json({ error: `Pick the project: ${PROJECT_OPTIONS.join(', ')}.` });
    if (!f.title) return res.status(400).json({ error: 'Write the work item / package (e.g. "Block work — Tower B").' });
    const hr = readKind(b, 'highrise_files'); if (hr.error) return res.status(400).json({ error: hr.error });
    const xl = readKind(b, 'excel_files'); if (xl.error) return res.status(400).json({ error: xl.error });
    if (xl.files.some(x => !/\.(xlsx|xlsm|xls|csv)$/i.test(x.name))) return res.status(400).json({ error: 'The estimate sheet must be an Excel file (.xlsx / .xls) or .csv.' });
    const up = collectUploads(b, MAX_FILE_CHARS); if (up.error) return res.status(400).json({ error: up.error });
    if (b.submit) {
      if (!hr.files.length && !(existing && await hasKind('estimate', existing.id, ['highrise']))) return res.status(400).json({ error: NEED_HIGHRISE });
      if (!xl.files.length && !(existing && await hasKind('estimate', existing.id, ['excel']))) return res.status(400).json({ error: NEED_EXCEL });
    }
    const t = now();
    let id;
    if (existing) {
      id = existing.id;
      await q('UPDATE est_estimates SET project=$1, title=$2, contractor=$3, description=$4, updated_at=$5 WHERE id=$6', [f.project, f.title, f.contractor, f.description, t, id]);
    } else {
      let ref; do { ref = genRef('EST'); } while (await one('SELECT 1 FROM est_estimates WHERE ref=$1', [ref]));
      id = (await one(`INSERT INTO est_estimates(ref, project, title, contractor, description, status, created_by, created_by_name, created_at, updated_at)
        VALUES($1,$2,$3,$4,$5,'draft',$6,$7,$8,$8) RETURNING id`, [ref, f.project, f.title, f.contractor, f.description, req.user.username, m.name, t])).id;
    }
    await insertFiles(q, 'estimate', id, hr.files, 'highrise', req.user.username, t);
    await insertFiles(q, 'estimate', id, xl.files, 'excel', req.user.username, t);
    await insertFiles(q, 'estimate', id, up.files, 'attachment', req.user.username, t);
    const e = await getEstimate(id);
    if (b.submit) return submit(req, res, 'estimate', e, m);
    await auditFromReq(req, existing ? 'estimate_updated' : 'estimate_created', `${existing ? 'Updated' : 'Created'} ${label('estimate', e)}.`);
    res.json({ ok: true, id, ref: e.ref });
  }

  // ---- JMR — only against an estimate that is open for JMR
  async function saveJmr(req, res, existing) {
    const m = await me(req.user);
    if (!m.canEdit) return res.status(403).json({ error: 'Only the Estimation & Billing team (or Admin) can write JMRs.' });
    const b = req.body || {};
    const est = await getEstimate(existing ? existing.estimate_id : b.estimate_id);
    if (!est) return res.status(400).json({ error: 'Pick the approved estimate this JMR is for.' });
    if (est.status !== 'approved' || est.stage !== 'jmr') return res.status(400).json({ error: est.status !== 'approved' ? `Estimate ${est.ref} is not approved yet — JMR opens after the project heads approve it.` : `JMR for estimate ${est.ref} is closed (the final JMR was approved).` });
    const { f, error } = readJmrFields({ ...b, project: est.project, contractor: b.contractor || est.contractor }); if (error) return res.status(400).json({ error });
    const L = readLines(b.lines); if (L.error) return res.status(400).json({ error: L.error });
    const up = collectUploads(b, MAX_FILE_CHARS); if (up.error) return res.status(400).json({ error: up.error });
    const src = readSource(b); if (src.error) return res.status(400).json({ error: src.error });
    const isFinal = b.is_final ? 1 : 0;
    const t = now();
    const client = await db.pool.connect();
    let id;
    try {
      await client.query('BEGIN');
      if (existing) {
        id = existing.id;
        await client.query(`UPDATE est_jmr SET project=$1, location=$2, work_item=$3, material=$4, contractor=$5, unit=$6, measured_on=$7, period_from=$8, period_to=$9,
          ra_bill_no=$10, client_rep=$11, contractor_rep=$12, notes=$13, total_qty=$14, updated_at=$15, is_final=$16 WHERE id=$17`,
          [f.project, f.location, f.work_item, f.material, f.contractor, f.unit, f.measured_on, f.period_from, f.period_to, f.ra_bill_no, f.client_rep, f.contractor_rep, f.notes, L.total, t, isFinal, id]);
        await client.query('DELETE FROM est_jmr_lines WHERE jmr_id=$1', [id]);
      } else {
        let ref; do { ref = genRef('JMR'); } while ((await client.query('SELECT 1 FROM est_jmr WHERE ref=$1', [ref])).rows.length);
        id = (await client.query(`INSERT INTO est_jmr(ref, project, location, work_item, material, contractor, unit, measured_on, period_from, period_to, ra_bill_no, client_rep, contractor_rep, notes,
          total_qty, status, created_by, created_by_name, created_at, updated_at, estimate_id, is_final) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'draft',$16,$17,$18,$18,$19,$20) RETURNING id`,
          [ref, f.project, f.location, f.work_item, f.material, f.contractor, f.unit, f.measured_on, f.period_from, f.period_to, f.ra_bill_no, f.client_rep, f.contractor_rep, f.notes, L.total, req.user.username, m.name, t, est.id, isFinal])).rows[0].id;
      }
      for (const l of L.lines) await client.query('INSERT INTO est_jmr_lines(jmr_id, sort, description, nos, length, breadth, height, qty, manual, deduct, remarks) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [id, l.sort, l.description || null, l.nos, l.length, l.breadth, l.height, l.qty, l.manual ? 1 : 0, l.deduct ? 1 : 0, l.remarks || null]);
      const ex = (sql, params) => client.query(sql, params);
      await insertFiles(ex, 'jmr', id, up.files, 'attachment', req.user.username, t);
      await insertFiles(ex, 'jmr', id, src.files, 'source', req.user.username, t);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    const j = await one('SELECT * FROM est_jmr WHERE id=$1', [id]);
    if (b.submit) return submit(req, res, 'jmr', j, m);
    await auditFromReq(req, existing ? 'jmr_updated' : 'jmr_created', `${existing ? 'Updated' : 'Created'} ${label('jmr', j)}.`);
    res.json({ ok: true, id, ref: j.ref, total_qty: L.total });
  }

  // ---- Reconciliation — after the final JMR of the estimate is approved
  async function saveRecon(req, res, existing) {
    const m = await me(req.user);
    if (!m.canEdit) return res.status(403).json({ error: 'Only the Estimation & Billing team (or Admin) can write reconciliations.' });
    const b = req.body || {};
    const est = await getEstimate(existing ? existing.estimate_id : b.estimate_id);
    if (!est) return res.status(400).json({ error: 'Pick the estimate this reconciliation is for.' });
    if (!['reconciliation', 'completed'].includes(est.stage)) return res.status(400).json({ error: `The reconciliation report opens after the final JMR of ${est.ref} is approved.` });
    const { f, error } = readReconFields({ ...b, project: est.project, contractor: b.contractor || est.contractor }); if (error) return res.status(400).json({ error });
    const up = collectUploads(b, MAX_FILE_CHARS); if (up.error) return res.status(400).json({ error: up.error });
    const src = readSource(b); if (src.error) return res.status(400).json({ error: src.error });
    const t = now();
    const cols = ['project', 'material', 'unit', 'contractor', 'work_item', 'period_from', 'period_to', 'issued', 'returned', 'balance_at_site', 'work_qty', 'work_unit', 'norm', 'wastage_pct', 'rate', 'notes'];
    let id;
    if (existing) {
      id = existing.id;
      await q(`UPDATE est_recon SET ${cols.map((c, i) => `${c}=$${i + 1}`).join(', ')}, updated_at=$${cols.length + 1} WHERE id=$${cols.length + 2}`, [...cols.map(c => f[c]), t, id]);
    } else {
      let ref; do { ref = genRef('REC'); } while (await one('SELECT 1 FROM est_recon WHERE ref=$1', [ref]));
      id = (await one(`INSERT INTO est_recon(ref, ${cols.join(', ')}, status, created_by, created_by_name, created_at, updated_at, estimate_id)
        VALUES($1, ${cols.map((c, i) => `$${i + 2}`).join(', ')}, 'draft', $${cols.length + 2}, $${cols.length + 3}, $${cols.length + 4}, $${cols.length + 4}, $${cols.length + 5}) RETURNING id`,
        [ref, ...cols.map(c => f[c]), req.user.username, m.name, t, est.id])).id;
    }
    await insertFiles(q, 'recon', id, up.files, 'attachment', req.user.username, t);
    await insertFiles(q, 'recon', id, src.files, 'source', req.user.username, t);
    const r = await one('SELECT * FROM est_recon WHERE id=$1', [id]);
    if (est.stage === 'completed') await q("UPDATE est_estimates SET stage='reconciliation', completed_at=NULL WHERE id=$1", [est.id]); // a new report reopens it
    if (b.submit) return submit(req, res, 'recon', r, m);
    await auditFromReq(req, existing ? 'recon_updated' : 'recon_created', `${existing ? 'Updated' : 'Created'} ${label('recon', r)}.`);
    res.json({ ok: true, id, ref: r.ref, calc: reconCalc(r) });
  }

  // ---- Send for approval (a resubmission after rejection starts a new approval round)
  async function submit(req, res, type, x, m) {
    if (!['draft', 'returned'].includes(x.status)) return res.status(400).json({ error: 'It has already been sent for approval.' });
    if (type === 'estimate') {
      if (!(await hasKind('estimate', x.id, ['highrise']))) return res.status(400).json({ error: NEED_HIGHRISE });
      if (!(await hasKind('estimate', x.id, ['excel']))) return res.status(400).json({ error: NEED_EXCEL });
    } else {
      const est = await getEstimate(x.estimate_id);
      if (!est) return res.status(400).json({ error: 'This entry is not linked to an estimate.' });
      if (type === 'jmr' && est.stage !== 'jmr') return res.status(400).json({ error: `JMR for estimate ${est.ref} is closed.` });
    }
    const round = x.status === 'returned' ? (Number(x.round) || 1) + 1 : (Number(x.round) || 1);
    const remarks = str((req.body || {}).remarks).trim().slice(0, 1000);
    await q(`UPDATE ${TABLE[type]} SET status='submitted', submitted_at=$1, round=$2 WHERE id=$3`, [now(), round, x.id]);
    if (remarks) await addComment(type, x.id, m, remarks, 'submit');
    const heads = await headsFor(x.project);
    const to = await approversFor(x.project);
    const extra = type === 'jmr' ? ` Qty ${Number(x.total_qty)} ${x.unit}.` : '';
    const who = heads.length > 1 ? ' Both project heads approve (or Admin).' : '';
    await notify(to, req.user.username, 'est_submitted', `${m.name} sent ${label(type, x)} for your approval.${extra}${who}${remarks ? ` Remarks: ${remarks.slice(0, 200)}` : ''}`);
    await auditFromReq(req, `${type}_submitted`, `Sent ${label(type, x)} for approval (round ${round}).`);
    res.json({ ok: true, id: x.id, ref: x.ref, status: 'submitted', sentTo: to });
  }
  async function addComment(type, id, m, text, kind = 'remark') {
    await q('INSERT INTO est_comments(parent_type, parent_id, kind, text, by_username, by_name, created_at) VALUES($1,$2,$3,$4,$5,$6,$7)', [type, id, kind, text, m.username, m.name, now()]);
  }
  async function getOr404(type, id, res) {
    const x = await one(`SELECT * FROM ${TABLE[type]} WHERE id=$1`, [Number(id) || 0]);
    if (!x) { res.status(404).json({ error: 'Not found.' }); return null; }
    return x;
  }
  const userName = async (u) => ((await db.listUsers()).find(x => x.username === u) || {}).name || u;

  // ---- Approve / reject. All heads must approve (Admin approves for all); any of them can reject.
  async function decide(req, res, type) {
    const m = await me(req.user);
    const x = await getOr404(type, req.params.id, res); if (!x) return;
    const heads = await headsFor(x.project);
    if (!canApprove(m, x.project)) return res.status(403).json({ error: `Only the project heads${heads.length ? ` (${(await Promise.all(heads.map(userName))).join(', ')})` : ''} or Admin can approve this.` });
    if (x.status !== 'submitted') return res.status(400).json({ error: 'It is not waiting for approval.' });
    const decision = str((req.body || {}).decision);
    const note = str((req.body || {}).note).trim().slice(0, 1000);
    if (!['approve', 'return'].includes(decision)) return res.status(400).json({ error: 'Approve or reject it.' });
    if (decision === 'return' && note.length < 5) return res.status(400).json({ error: 'Write why it is rejected / what to correct (at least 5 characters).' });
    if (x.created_by === req.user.username && decision === 'approve' && !m.admin) return res.status(400).json({ error: 'You cannot approve your own entry.' });
    const round = Number(x.round) || 1;
    const prior = await rows("SELECT username FROM est_approvals WHERE parent_type=$1 AND parent_id=$2 AND round=$3 AND decision='approve'", [type, x.id, round]);
    if (decision === 'approve' && prior.some(p => p.username === m.username)) return res.status(400).json({ error: 'You have already approved it — waiting for the other head.' });
    const onBehalf = m.admin && !heads.includes(m.username) ? 1 : 0;
    await q('INSERT INTO est_approvals(parent_type, parent_id, round, username, name, decision, note, on_behalf, created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [type, x.id, round, m.username, m.name, decision === 'approve' ? 'approve' : 'reject', note || null, onBehalf, now()]);
    const others = (await approversFor(x.project)).filter(u => u !== m.username);

    if (decision === 'return') {
      await q(`UPDATE ${TABLE[type]} SET status='returned', decided_by=$1, decided_by_name=$2, decided_at=$3, decision_note=$4 WHERE id=$5`, [m.username, m.name, now(), note, x.id]);
      await addComment(type, x.id, m, `Rejected: ${note}`, 'returned');
      await notify([x.created_by], req.user.username, 'est_decided', `✗ ${m.name} rejected ${label(type, x)}: "${note}". Correct it and send it again.`);
      await notify(others.filter(u => u !== x.created_by), req.user.username, 'est_decided', `✗ ${m.name} rejected ${label(type, x)}: "${note}".`);
      await auditFromReq(req, `${type}_rejected`, `Rejected ${label(type, x)}: ${note}`);
      return res.json({ ok: true, status: 'returned' });
    }
    const approvedBy = [...prior.map(p => p.username), m.username];
    const waiting = heads.filter(h => !approvedBy.includes(h));
    if (!m.admin && waiting.length) {
      const wNames = (await Promise.all(waiting.map(userName))).join(', ');
      await addComment(type, x.id, m, `Approved${note ? `: ${note}` : '.'} Waiting for ${wNames}.`, 'approved');
      await notify([x.created_by], req.user.username, 'est_decided', `✓ ${m.name} approved ${label(type, x)} — waiting for ${wNames}.`);
      await notify(waiting, req.user.username, 'est_submitted', `${m.name} approved ${label(type, x)} — your approval is still needed.`);
      await auditFromReq(req, `${type}_approved_partly`, `${m.name} approved ${label(type, x)}; waiting for ${wNames}.`);
      return res.json({ ok: true, status: 'submitted', waitingFor: waiting });
    }
    // Fully approved
    const t = now();
    await q(`UPDATE ${TABLE[type]} SET status='approved', decided_by=$1, decided_by_name=$2, decided_at=$3, decision_note=$4 WHERE id=$5`, [m.username, m.name, t, note || null, x.id]);
    await addComment(type, x.id, m, `Approved${onBehalf && heads.length ? ' (Admin, on behalf of the project heads)' : ''}${note ? `: ${note}` : '.'}`, 'approved');
    const team = await estimationTeam();
    if (type === 'estimate') {
      await q("UPDATE est_estimates SET stage='jmr', approved_at=$1 WHERE id=$2", [t, x.id]);
      await notify([x.created_by, ...team], req.user.username, 'est_jmr_open', `✅ ${label(type, x)} is approved — JMR is now open. Record the JMRs against ${x.ref}.`);
    } else {
      await notify([x.created_by], req.user.username, 'est_decided', `✓ ${m.name} approved ${label(type, x)}.${note ? ` Note: ${note}` : ''}`);
      const est = await getEstimate(x.estimate_id);
      if (est && type === 'jmr' && x.is_final) {
        await q("UPDATE est_estimates SET stage='reconciliation', jmr_closed_at=$1 WHERE id=$2", [t, est.id]);
        await notify([est.created_by, x.created_by, ...team], req.user.username, 'est_recon_due', `📋 Final JMR ${x.ref} approved — JMR for ${est.ref} (${est.title}, ${est.project}) is complete. Prepare and send the reconciliation report.`);
      }
      if (est && type === 'recon') {
        const pending = await one("SELECT COUNT(*) AS n FROM est_recon WHERE estimate_id=$1 AND status <> 'approved'", [est.id]);
        if (!Number(pending.n)) {
          await q("UPDATE est_estimates SET stage='completed', completed_at=$1 WHERE id=$2", [t, est.id]);
          await notify([est.created_by, ...team, ...heads], req.user.username, 'est_completed', `🏁 ${est.ref} (${est.title}, ${est.project}) is completed — estimate, JMRs and reconciliation all approved.`);
        }
      }
    }
    await auditFromReq(req, `${type}_approved`, `Approved ${label(type, x)}${onBehalf ? ' (Admin)' : ''}.`);
    res.json({ ok: true, status: 'approved' });
  }

  const SAVE = { estimate: saveEstimate, jmr: saveJmr, recon: saveRecon };
  for (const type of ['estimate', 'jmr', 'recon']) {
    const save = SAVE[type];
    app.post(`/api/estimation/${type}`, auth(ALL_ROLES), (req, res) => save(req, res, null));
    app.post(`/api/estimation/${type}/:id/update`, auth(ALL_ROLES), async (req, res) => {
      const x = await getOr404(type, req.params.id, res); if (!x) return;
      if (!['draft', 'returned'].includes(x.status)) return res.status(400).json({ error: x.status === 'approved' ? 'It is approved and locked.' : 'It is waiting for approval — it can be changed only if it is rejected.' });
      return save(req, res, x);
    });
    app.post(`/api/estimation/${type}/:id/submit`, auth(ALL_ROLES), async (req, res) => {
      const m = await me(req.user); if (!m.canEdit) return res.status(403).json({ error: 'Only the Estimation & Billing team (or Admin) can send it for approval.' });
      const x = await getOr404(type, req.params.id, res); if (!x) return;
      return submit(req, res, type, x, m);
    });
    app.post(`/api/estimation/${type}/:id/decide`, auth(ALL_ROLES), (req, res) => decide(req, res, type));
    app.post(`/api/estimation/${type}/:id/delete`, auth(ALL_ROLES), async (req, res) => {
      const m = await me(req.user);
      const x = await getOr404(type, req.params.id, res); if (!x) return;
      const ok = m.admin || (m.canEdit && x.created_by === req.user.username && x.status !== 'approved');
      if (!ok) return res.status(403).json({ error: x.status === 'approved' ? 'An approved entry can be removed only by Admin.' : 'Only whoever wrote it (or Admin) can remove it.' });
      if (type === 'estimate' && Number((await one('SELECT (SELECT COUNT(*) FROM est_jmr WHERE estimate_id=$1) + (SELECT COUNT(*) FROM est_recon WHERE estimate_id=$1) AS n', [x.id])).n)) return res.status(400).json({ error: 'This estimate has JMRs / reconciliations — remove those first.' });
      await q(`DELETE FROM ${TABLE[type]} WHERE id=$1`, [x.id]);
      await q('DELETE FROM est_files WHERE parent_type=$1 AND parent_id=$2', [type, x.id]);
      await q('DELETE FROM est_approvals WHERE parent_type=$1 AND parent_id=$2', [type, x.id]);
      await auditFromReq(req, `${type}_deleted`, `Removed ${label(type, x)} (${x.status}).`);
      res.json({ ok: true });
    });
    // Remarks on an entry, any time — the writer and the approvers are told.
    app.post(`/api/estimation/${type}/:id/remark`, auth(ALL_ROLES), async (req, res) => {
      const m = await me(req.user); if (!m.canView) return res.status(403).json({ error: 'Not allowed.' });
      const x = await getOr404(type, req.params.id, res); if (!x) return;
      const text = str((req.body || {}).text).trim().slice(0, 1000);
      if (text.length < 2) return res.status(400).json({ error: 'Write the remark.' });
      await addComment(type, x.id, m, text);
      await notify([x.created_by, ...(await approversFor(x.project))], req.user.username, 'est_remark', `💬 ${m.name} on ${label(type, x)}: ${text.slice(0, 200)}`);
      res.json({ ok: true });
    });
    // Add files any time (e.g. the signed JMR copy after approval, a revised HighRise / Excel before resubmitting).
    app.post(`/api/estimation/${type}/:id/files`, auth(ALL_ROLES), async (req, res) => {
      const m = await me(req.user);
      const x = await getOr404(type, req.params.id, res); if (!x) return;
      if (!(m.canEdit || canApprove(m, x.project))) return res.status(403).json({ error: 'Only the Estimation & Billing team, the project heads or Admin can add files.' });
      const up = collectUploads(req.body || {}, MAX_FILE_CHARS); if (up.error) return res.status(400).json({ error: up.error });
      if (!up.files.length) return res.status(400).json({ error: 'Attach a file.' });
      const k = str((req.body || {}).kind);
      const kind = ['source', 'highrise', 'excel'].includes(k) ? k : 'attachment';
      if (kind === 'excel' && up.files.some(f => !/\.(xlsx|xlsm|xls|csv)$/i.test(f.name))) return res.status(400).json({ error: 'The estimate sheet must be an Excel file (.xlsx / .xls) or .csv.' });
      await insertFiles(q, type, x.id, up.files, kind, req.user.username, now());
      res.json({ ok: true });
    });
  }
  // ---- Import JMRs from Excel / CSV: read the file and return what was found (nothing is saved here — the
  // screen shows it, the person picks the project etc., then each JMR is created as a draft the normal way).
  const { readJmrFile, buildJmrTemplate } = require('./jmr-import');
  app.post('/api/estimation/jmr/import/preview', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user);
    if (!m.canEdit) return res.status(403).json({ error: 'Only the Estimation & Billing team (or Admin) can import JMRs.' });
    try {
      const r = await readJmrFile((req.body || {}).fileData, (req.body || {}).fileName);
      for (const j of r.jmrs) if (j.project && !PROJECT_OPTIONS.includes(j.project)) {
        const hit = PROJECT_OPTIONS.find(p => p.toLowerCase().includes(String(j.project).toLowerCase()) || String(j.project).toLowerCase().includes(p.toLowerCase().split(' (')[0]));
        j.projectInSheet = j.project; j.project = hit || '';
      }
      res.json(r);
    } catch (e) {
      if (e.isImportError) return res.status(400).json({ error: e.message });
      throw e;
    }
  });
  app.get('/api/estimation/jmr/template', auth(ALL_ROLES), async (req, res) => {
    const buf = await buildJmrTemplate();
    res.json({ name: 'JMR-template.xlsx', data: 'data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,' + Buffer.from(buf).toString('base64') });
  });
  app.get('/api/estimation/files/:id', auth(ALL_ROLES), async (req, res) => {
    // Download: the HighRise / estimation document (kind 'source') for anyone who can see Estimation; other
    // attachments are view-only (on screen through /view) — only Admin can download those.
    const m = await me(req.user); if (!m.canView) return res.status(403).json({ error: 'Not allowed.' });
    const f = await one('SELECT name, data, kind FROM est_files WHERE id=$1', [Number(req.params.id) || 0]);
    if (!f) return res.status(404).json({ error: 'File not found.' });
    if (!['source', 'highrise'].includes(f.kind) && req.user.role !== 'admin') return res.status(403).json({ error: 'This attachment can only be viewed on screen.' });
    res.json({ name: f.name, data: f.data });
  });
  // View only: images and PDFs come back as data for the on-screen viewer; Excel / CSV as rows (no file to save).
  app.get('/api/estimation/files/:id/view', auth(ALL_ROLES), async (req, res) => {
    // (HighRise documents can also be downloaded — canDownload.)
    const m = await me(req.user); if (!m.canView) return res.status(403).json({ error: 'Not allowed.' });
    const f = await one('SELECT name, data, kind FROM est_files WHERE id=$1', [Number(req.params.id) || 0]);
    if (!f) return res.status(404).json({ error: 'File not found.' });
    const extra = { canDownload: ['source', 'highrise'].includes(f.kind) || req.user.role === 'admin' };
    const mime = (/^data:([^;,]+)/.exec(f.data || '') || [])[1] || '';
    if (/^image\//.test(mime)) return res.json({ kind: 'image', name: f.name, data: f.data, ...extra });
    if (mime === 'application/pdf' || /\.pdf$/i.test(f.name)) return res.json({ kind: 'pdf', name: f.name, data: f.data, ...extra });
    if (/sheet|excel|csv/.test(mime) || /\.(xlsx|xlsm|csv)$/i.test(f.name)) {
      try { return res.json({ kind: 'sheet', name: f.name, sheets: await sheetPreview(f.data, f.name), ...extra }); }
      catch (e) { return res.json({ kind: 'none', name: f.name, error: "This spreadsheet can't be shown here (save it as .xlsx).", ...extra }); }
    }
    return res.json({ kind: 'none', name: f.name, error: 'This kind of file cannot be shown here.', ...extra });
  });
  app.post('/api/estimation/files/:id/delete', auth(ALL_ROLES), async (req, res) => {
    const f = await one('SELECT * FROM est_files WHERE id=$1', [Number(req.params.id) || 0]);
    if (!f) return res.status(404).json({ error: 'File not found.' });
    if (!(req.user.role === 'admin' || f.uploaded_by === req.user.username)) return res.status(403).json({ error: 'Only whoever uploaded it (or Admin) can remove it.' });
    await q('DELETE FROM est_files WHERE id=$1', [f.id]);
    res.json({ ok: true });
  });
}

module.exports = { mountEstimation, STATUS };
