/* Estimation & Billing department: JMR (Joint Measurement Records) and material Reconciliation.

   JMR — what was measured jointly on site for one work item (and material) of one contractor, as measurement lines
   (Nos × L × B × H, or a quantity typed in, with deductions). Each JMR shows the quantity
   approved up to the previous JMR for the same project + work item + contractor, this JMR, and the cumulative.
   Workflow: draft → submitted → approved, or returned (with a note) → edited → submitted again.

   Reconciliation — material issued to a contractor against the work done:
     actual consumption   = issued − returned − balance still at site
     theoretical          = work done × consumption norm
     allowed              = theoretical × (1 + wastage %)
     excess (recoverable) = actual − allowed (if more)       → recovery = excess × rate
     saving               = theoretical − actual (if less)
   Same workflow as JMR.

   Sending for approval needs the HighRise / estimation document attached (Excel, PDF or any format) — kind 'source'.

   Remarks: added when sending for approval, and any time after on the entry (everyone who can see it).

   Who: the Estimation & Billing Department (and Admin) create and edit. Approval: EST_APPROVERS (Dnyaneshwar Kolekar)
   and Admin. View: the Estimation & Billing Department, the Purchase Department, Admin and the approvers. */
const EST_APPROVERS = ['dnyaneshwar.k'];

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
  async function me(user) {
    const u = await db.getUserFresh(user.username);
    const team = String((u && u.team) || '');
    const isEst = /estimat|billing/i.test(team);
    const approveAll = user.role === 'admin' || EST_APPROVERS.includes(user.username);
    return {
      username: user.username, name: (u && u.name) || user.name, team,
      canEdit: user.role === 'admin' || isEst,
      approveAll, headOf: [],
      isAccounts: /account/i.test(team),
      canView: approveAll || isEst || /purchase/i.test(team),
    };
  }
  const canApprove = (m) => m.approveAll;
  async function approversFor() {
    const users = await db.listUsers();
    return users.filter(u => u.role === 'admin' || EST_APPROVERS.includes(u.username)).map(u => u.username);
  }
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
    const N = v => v == null ? null : Number(v);
    const jmrOut = jmr.map(j => ({ ...j, rate: N(j.rate), total_qty: N(j.total_qty), amount: N(j.amount),
      lines: lines.filter(l => l.jmr_id === j.id).map(l => ({ ...l, nos: N(l.nos), length: N(l.length), breadth: N(l.breadth), height: N(l.height), qty: N(l.qty), manual: !!l.manual, deduct: !!l.deduct })),
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
      return { ...x, calc: reconCalc(x), files: files.filter(f => f.parent_type === 'recon' && f.parent_id === r.id), comments: comments.filter(c => c.parent_type === 'recon' && c.parent_id === r.id) };
    });
    return { jmr: jmrOut, recon: reconOut };
  }

  // ---- routes
  app.get('/api/estimation/summary', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user);
    if (!m.canView) return res.json({ canView: false });
    const sub = await rows("SELECT 'jmr' AS t, project FROM est_jmr WHERE status='submitted' UNION ALL SELECT 'recon', project FROM est_recon WHERE status='submitted'");
    const toApprove = m.approveAll ? sub.length : 0;
    const returned = m.canEdit ? Number((await one("SELECT (SELECT COUNT(*) FROM est_jmr WHERE status='returned' AND created_by=$1) + (SELECT COUNT(*) FROM est_recon WHERE status='returned' AND created_by=$1) AS n", [m.username])).n) : 0;
    res.json({ canView: true, canEdit: m.canEdit, isAccounts: m.isAccounts, approveAll: m.approveAll, headOf: m.headOf, toApprove, returned });
  });
  app.get('/api/estimation', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user);
    if (!m.canView) return res.status(403).json({ error: 'The Estimation page is for the Estimation & Billing and Purchase departments, the approvers and Admin.' });
    const data = await loadAll();
    res.json({ me: { canEdit: m.canEdit, approveAll: m.approveAll, headOf: m.headOf, isAccounts: m.isAccounts }, projects: PROJECT_OPTIONS, ...data });
  });

  async function saveJmr(req, res, existing) {
    const m = await me(req.user);
    if (!m.canEdit) return res.status(403).json({ error: 'Only the Estimation & Billing team (or Admin) can write JMRs.' });
    const b = req.body || {};
    const { f, error } = readJmrFields(b); if (error) return res.status(400).json({ error });
    const L = readLines(b.lines); if (L.error) return res.status(400).json({ error: L.error });
    const up = collectUploads(b, MAX_FILE_CHARS); if (up.error) return res.status(400).json({ error: up.error });
    const src = readSource(b); if (src.error) return res.status(400).json({ error: src.error });
    if (b.submit && !src.files.length && !(existing && await hasSource('jmr', existing.id))) return res.status(400).json({ error: NEED_SOURCE });
    const amount = null; // no rates on JMRs
    const t = now();
    const client = await db.pool.connect();
    let id;
    try {
      await client.query('BEGIN');
      if (existing) {
        id = existing.id;
        await client.query(`UPDATE est_jmr SET project=$1, location=$2, work_item=$3, material=$4, contractor=$5, unit=$6, measured_on=$7, period_from=$8, period_to=$9,
          ra_bill_no=$10, client_rep=$11, contractor_rep=$12, notes=$13, total_qty=$14, updated_at=$15 WHERE id=$16`,
          [f.project, f.location, f.work_item, f.material, f.contractor, f.unit, f.measured_on, f.period_from, f.period_to, f.ra_bill_no, f.client_rep, f.contractor_rep, f.notes, L.total, t, id]);
        await client.query('DELETE FROM est_jmr_lines WHERE jmr_id=$1', [id]);
      } else {
        let ref; do { ref = genRef('JMR'); } while ((await client.query('SELECT 1 FROM est_jmr WHERE ref=$1', [ref])).rows.length);
        id = (await client.query(`INSERT INTO est_jmr(ref, project, location, work_item, material, contractor, unit, measured_on, period_from, period_to, ra_bill_no, client_rep, contractor_rep, notes,
          total_qty, status, created_by, created_by_name, created_at, updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'draft',$16,$17,$18,$18) RETURNING id`,
          [ref, f.project, f.location, f.work_item, f.material, f.contractor, f.unit, f.measured_on, f.period_from, f.period_to, f.ra_bill_no, f.client_rep, f.contractor_rep, f.notes, L.total, req.user.username, m.name, t])).rows[0].id;
      }
      for (const l of L.lines) await client.query('INSERT INTO est_jmr_lines(jmr_id, sort, description, nos, length, breadth, height, qty, manual, deduct, remarks) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [id, l.sort, l.description || null, l.nos, l.length, l.breadth, l.height, l.qty, l.manual ? 1 : 0, l.deduct ? 1 : 0, l.remarks || null]);
      for (const file of up.files) await client.query('INSERT INTO est_files(parent_type, parent_id, name, data, uploaded_by, created_at) VALUES($1,$2,$3,$4,$5,$6)', ['jmr', id, file.name, file.data, req.user.username, t]);
      for (const file of src.files) await client.query("INSERT INTO est_files(parent_type, parent_id, name, data, uploaded_by, created_at, kind) VALUES($1,$2,$3,$4,$5,$6,'source')", ['jmr', id, file.name, file.data, req.user.username, t]);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    const j = await one('SELECT * FROM est_jmr WHERE id=$1', [id]);
    if (b.submit) return submit(req, res, 'jmr', j, m);
    await auditFromReq(req, existing ? 'jmr_updated' : 'jmr_created', `${existing ? 'Updated' : 'Created'} JMR ${j.ref} — ${j.work_item} (${j.project}).`);
    res.json({ ok: true, id, ref: j.ref, total_qty: L.total });
  }
  async function saveRecon(req, res, existing) {
    const m = await me(req.user);
    if (!m.canEdit) return res.status(403).json({ error: 'Only the Estimation & Billing team (or Admin) can write reconciliations.' });
    const b = req.body || {};
    const { f, error } = readReconFields(b); if (error) return res.status(400).json({ error });
    const up = collectUploads(b, MAX_FILE_CHARS); if (up.error) return res.status(400).json({ error: up.error });
    const src = readSource(b); if (src.error) return res.status(400).json({ error: src.error });
    if (b.submit && !src.files.length && !(existing && await hasSource('recon', existing.id))) return res.status(400).json({ error: NEED_SOURCE });
    const t = now();
    const cols = ['project', 'material', 'unit', 'contractor', 'work_item', 'period_from', 'period_to', 'issued', 'returned', 'balance_at_site', 'work_qty', 'work_unit', 'norm', 'wastage_pct', 'rate', 'notes'];
    let id;
    if (existing) {
      id = existing.id;
      await q(`UPDATE est_recon SET ${cols.map((c, i) => `${c}=$${i + 1}`).join(', ')}, updated_at=$${cols.length + 1} WHERE id=$${cols.length + 2}`, [...cols.map(c => f[c]), t, id]);
    } else {
      let ref; do { ref = genRef('REC'); } while (await one('SELECT 1 FROM est_recon WHERE ref=$1', [ref]));
      id = (await one(`INSERT INTO est_recon(ref, ${cols.join(', ')}, status, created_by, created_by_name, created_at, updated_at)
        VALUES($1, ${cols.map((c, i) => `$${i + 2}`).join(', ')}, 'draft', $${cols.length + 2}, $${cols.length + 3}, $${cols.length + 4}, $${cols.length + 4}) RETURNING id`,
        [ref, ...cols.map(c => f[c]), req.user.username, m.name, t])).id;
    }
    for (const file of up.files) await q('INSERT INTO est_files(parent_type, parent_id, name, data, uploaded_by, created_at) VALUES($1,$2,$3,$4,$5,$6)', ['recon', id, file.name, file.data, req.user.username, t]);
    for (const file of src.files) await q("INSERT INTO est_files(parent_type, parent_id, name, data, uploaded_by, created_at, kind) VALUES($1,$2,$3,$4,$5,$6,'source')", ['recon', id, file.name, file.data, req.user.username, t]);
    const r = await one('SELECT * FROM est_recon WHERE id=$1', [id]);
    if (b.submit) return submit(req, res, 'recon', r, m);
    await auditFromReq(req, existing ? 'recon_updated' : 'recon_created', `${existing ? 'Updated' : 'Created'} reconciliation ${r.ref} — ${r.material} (${r.project}).`);
    res.json({ ok: true, id, ref: r.ref, calc: reconCalc(r) });
  }
  const TABLE = { jmr: 'est_jmr', recon: 'est_recon' };
  const label = (type, x) => type === 'jmr' ? `JMR ${x.ref} — ${x.work_item}${x.material ? ` / ${x.material}` : ''}${x.contractor ? ` (${x.contractor})` : ''}, ${x.project}` : `Reconciliation ${x.ref} — ${x.material}${x.contractor ? ` (${x.contractor})` : ''}, ${x.project}`;
  async function submit(req, res, type, x, m) {
    if (!['draft', 'returned'].includes(x.status)) return res.status(400).json({ error: 'It has already been sent for approval.' });
    if (!(await hasSource(type, x.id))) return res.status(400).json({ error: NEED_SOURCE });
    const remarks = str((req.body || {}).remarks).trim().slice(0, 1000);
    await q(`UPDATE ${TABLE[type]} SET status='submitted', submitted_at=$1 WHERE id=$2`, [now(), x.id]);
    if (remarks) await addComment(type, x.id, m, remarks, 'submit');
    const to = await approversFor();
    const extra = type === 'jmr' ? ` Qty ${Number(x.total_qty)} ${x.unit}.` : '';
    await notify(to, req.user.username, 'est_submitted', `${m.name} sent ${label(type, x)} for your approval.${extra}${remarks ? ` Remarks: ${remarks.slice(0, 200)}` : ''}`);
    await auditFromReq(req, `${type}_submitted`, `Sent ${label(type, x)} for approval.`);
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
  for (const type of ['jmr', 'recon']) {
    const save = type === 'jmr' ? saveJmr : saveRecon;
    app.post(`/api/estimation/${type}`, auth(ALL_ROLES), (req, res) => save(req, res, null));
    app.post(`/api/estimation/${type}/:id/update`, auth(ALL_ROLES), async (req, res) => {
      const x = await getOr404(type, req.params.id, res); if (!x) return;
      if (!['draft', 'returned'].includes(x.status)) return res.status(400).json({ error: x.status === 'approved' ? 'It is approved and locked.' : 'It is waiting for approval — it can be changed only if it is returned.' });
      return save(req, res, x);
    });
    app.post(`/api/estimation/${type}/:id/submit`, auth(ALL_ROLES), async (req, res) => {
      const m = await me(req.user); if (!m.canEdit) return res.status(403).json({ error: 'Only the Estimation & Billing team (or Admin) can send it for approval.' });
      const x = await getOr404(type, req.params.id, res); if (!x) return;
      return submit(req, res, type, x, m);
    });
    app.post(`/api/estimation/${type}/:id/decide`, auth(ALL_ROLES), async (req, res) => {
      const m = await me(req.user);
      const x = await getOr404(type, req.params.id, res); if (!x) return;
      if (!canApprove(m)) return res.status(403).json({ error: 'Only Dnyaneshwar Kolekar or Admin can approve this.' });
      if (x.status !== 'submitted') return res.status(400).json({ error: 'It is not waiting for approval.' });
      const decision = str((req.body || {}).decision);
      const note = str((req.body || {}).note).trim().slice(0, 1000);
      if (!['approve', 'return'].includes(decision)) return res.status(400).json({ error: 'Approve or return it.' });
      if (decision === 'return' && note.length < 5) return res.status(400).json({ error: 'Write what needs correcting (at least 5 characters).' });
      if (x.created_by === req.user.username && decision === 'approve' && req.user.role !== 'admin') return res.status(400).json({ error: 'You cannot approve your own entry.' });
      await q(`UPDATE ${TABLE[type]} SET status=$1, decided_by=$2, decided_by_name=$3, decided_at=$4, decision_note=$5 WHERE id=$6`,
        [decision === 'approve' ? 'approved' : 'returned', req.user.username, m.name, now(), note || null, x.id]);
      await addComment(type, x.id, m, `${decision === 'approve' ? 'Approved' : 'Returned for correction'}${note ? `: ${note}` : '.'}`, decision === 'approve' ? 'approved' : 'returned');
      await notify([x.created_by], req.user.username, 'est_decided', decision === 'approve'
        ? `✓ ${m.name} approved ${label(type, x)}.${note ? ` Note: ${note}` : ''}`
        : `↩ ${m.name} returned ${label(type, x)}: "${note}". Correct it and send it again.`);
      await auditFromReq(req, `${type}_${decision === 'approve' ? 'approved' : 'returned'}`, `${decision === 'approve' ? 'Approved' : 'Returned'} ${label(type, x)}.`);
      res.json({ ok: true, status: decision === 'approve' ? 'approved' : 'returned' });
    });
    app.post(`/api/estimation/${type}/:id/delete`, auth(ALL_ROLES), async (req, res) => {
      const m = await me(req.user);
      const x = await getOr404(type, req.params.id, res); if (!x) return;
      const ok = req.user.role === 'admin' || (m.canEdit && x.created_by === req.user.username && x.status !== 'approved');
      if (!ok) return res.status(403).json({ error: x.status === 'approved' ? 'An approved entry can be removed only by Admin.' : 'Only whoever wrote it (or Admin) can remove it.' });
      await q(`DELETE FROM ${TABLE[type]} WHERE id=$1`, [x.id]);
      await q('DELETE FROM est_files WHERE parent_type=$1 AND parent_id=$2', [type, x.id]);
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
      await notify([x.created_by, ...(await approversFor())], req.user.username, 'est_remark', `💬 ${m.name} on ${label(type, x)}: ${text.slice(0, 200)}`);
      res.json({ ok: true });
    });
    // Add files any time (e.g. the signed JMR copy after approval).
    app.post(`/api/estimation/${type}/:id/files`, auth(ALL_ROLES), async (req, res) => {
      const m = await me(req.user);
      const x = await getOr404(type, req.params.id, res); if (!x) return;
      if (!(m.canEdit || canApprove(m))) return res.status(403).json({ error: 'Only the Estimation & Billing team, approvers or Admin can add files.' });
      const up = collectUploads(req.body || {}, MAX_FILE_CHARS); if (up.error) return res.status(400).json({ error: up.error });
      if (!up.files.length) return res.status(400).json({ error: 'Attach a file.' });
      const kind = str((req.body || {}).kind) === 'source' ? 'source' : 'attachment';
      for (const file of up.files) await q('INSERT INTO est_files(parent_type, parent_id, name, data, uploaded_by, created_at, kind) VALUES($1,$2,$3,$4,$5,$6,$7)', [type, x.id, file.name, file.data, req.user.username, now(), kind]);
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
    const m = await me(req.user); if (!m.canView) return res.status(403).json({ error: 'Not allowed.' });
    const f = await one('SELECT name, data FROM est_files WHERE id=$1', [Number(req.params.id) || 0]);
    if (!f) return res.status(404).json({ error: 'File not found.' });
    res.json(f);
  });
  // View only: images and PDFs come back as data for the on-screen viewer; Excel / CSV as rows (no file to save).
  app.get('/api/estimation/files/:id/view', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user); if (!m.canView) return res.status(403).json({ error: 'Not allowed.' });
    const f = await one('SELECT name, data FROM est_files WHERE id=$1', [Number(req.params.id) || 0]);
    if (!f) return res.status(404).json({ error: 'File not found.' });
    const mime = (/^data:([^;,]+)/.exec(f.data || '') || [])[1] || '';
    if (/^image\//.test(mime)) return res.json({ kind: 'image', name: f.name, data: f.data });
    if (mime === 'application/pdf' || /\.pdf$/i.test(f.name)) return res.json({ kind: 'pdf', name: f.name, data: f.data });
    if (/sheet|excel|csv/.test(mime) || /\.(xlsx|xlsm|csv)$/i.test(f.name)) {
      try { return res.json({ kind: 'sheet', name: f.name, sheets: await sheetPreview(f.data, f.name) }); }
      catch (e) { return res.json({ kind: 'none', name: f.name, error: "This spreadsheet can't be shown here (save it as .xlsx)." }); }
    }
    return res.json({ kind: 'none', name: f.name, error: 'This kind of file cannot be shown here.' });
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
