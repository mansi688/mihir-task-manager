/* Estimation & Billing department: JMR (Joint Measurement Records) and material Reconciliation.

   JMR — what was measured jointly on site for one work item (BOQ item) of one contractor, as measurement lines
   (Nos × L × B × H, or a quantity typed in, with deductions). Quantity × rate = amount. Each JMR shows the quantity
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

   Who: the Estimation & Billing Department (and Admin) create and edit. Approval: Admin, Directors, Senior
   management, and the project heads of that project. View: those, plus Accounts, Store, Contracting and Execution. */

const STATUS = ['draft', 'submitted', 'approved', 'returned'];

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
    const headOf = Object.keys(PROJECT_HEADS).filter(p => (PROJECT_HEADS[p] || []).includes(user.username));
    const isEst = /estimat|billing/i.test(team);
    const senior = /senior management/i.test(team);
    const approveAll = user.role === 'admin' || user.role === 'director' || senior;
    return {
      username: user.username, name: (u && u.name) || user.name, team,
      canEdit: user.role === 'admin' || isEst,
      approveAll, headOf,
      isAccounts: /account/i.test(team),
      canView: user.role === 'admin' || user.role === 'director' || isEst || senior || headOf.length > 0 || /account|store|contracting|execution/i.test(team),
    };
  }
  const canApprove = (m, project) => m.approveAll || m.headOf.includes(project);
  async function approversFor(project) {
    const users = await db.listUsers();
    const set = new Set((PROJECT_HEADS[project] || []).filter(u => users.some(x => x.username === u)));
    for (const u of users) if (u.role === 'director' || /senior management/i.test(u.team || '')) set.add(u.username);
    if (!set.size) for (const u of users) if (u.role === 'admin') set.add(u.username);
    return [...set];
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
      boq_item: str(b.boq_item).trim().slice(0, 60) || null, contractor: str(b.contractor).trim().slice(0, 200) || null, unit: str(b.unit).trim().slice(0, 20),
      rate: num(b.rate), measured_on: str(b.measured_on).slice(0, 10) || null, period_from: str(b.period_from).slice(0, 10) || null, period_to: str(b.period_to).slice(0, 10) || null,
      ra_bill_no: str(b.ra_bill_no).trim().slice(0, 40) || null, client_rep: str(b.client_rep).trim().slice(0, 120) || null, contractor_rep: str(b.contractor_rep).trim().slice(0, 120) || null,
      notes: str(b.notes).trim().slice(0, 2000) || null,
    };
    if (!PROJECT_OPTIONS.includes(f.project)) return { error: `Pick the project: ${PROJECT_OPTIONS.join(', ')}.` };
    if (!f.work_item) return { error: 'Write the work item (e.g. "RCC M25 — slab").' };
    if (!f.unit) return { error: 'Pick the unit.' };
    if (Number.isNaN(f.rate) || (f.rate != null && f.rate < 0)) return { error: 'Rate must be a number.' };
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
    const N = v => v == null ? null : Number(v);
    const jmrOut = jmr.map(j => ({ ...j, rate: N(j.rate), total_qty: N(j.total_qty), amount: N(j.amount),
      lines: lines.filter(l => l.jmr_id === j.id).map(l => ({ ...l, nos: N(l.nos), length: N(l.length), breadth: N(l.breadth), height: N(l.height), qty: N(l.qty), manual: !!l.manual, deduct: !!l.deduct })),
      files: files.filter(f => f.parent_type === 'jmr' && f.parent_id === j.id) }));
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
      return { ...x, calc: reconCalc(x), files: files.filter(f => f.parent_type === 'recon' && f.parent_id === r.id) };
    });
    return { jmr: jmrOut, recon: reconOut };
  }

  // ---- routes
  app.get('/api/estimation/summary', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user);
    if (!m.canView) return res.json({ canView: false });
    const sub = await rows("SELECT 'jmr' AS t, project FROM est_jmr WHERE status='submitted' UNION ALL SELECT 'recon', project FROM est_recon WHERE status='submitted'");
    const toApprove = sub.filter(x => canApprove(m, x.project)).length;
    const returned = m.canEdit ? Number((await one("SELECT (SELECT COUNT(*) FROM est_jmr WHERE status='returned' AND created_by=$1) + (SELECT COUNT(*) FROM est_recon WHERE status='returned' AND created_by=$1) AS n", [m.username])).n) : 0;
    res.json({ canView: true, canEdit: m.canEdit, isAccounts: m.isAccounts, approveAll: m.approveAll, headOf: m.headOf, toApprove, returned });
  });
  app.get('/api/estimation', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user);
    if (!m.canView) return res.status(403).json({ error: 'The Estimation pages are for the Estimation & Billing team, project heads, management, Accounts, Store, Contracting and Execution.' });
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
    const amount = f.rate != null ? r2(L.total * f.rate) : null;
    const t = now();
    const client = await db.pool.connect();
    let id;
    try {
      await client.query('BEGIN');
      if (existing) {
        id = existing.id;
        await client.query(`UPDATE est_jmr SET project=$1, location=$2, work_item=$3, boq_item=$4, contractor=$5, unit=$6, rate=$7, measured_on=$8, period_from=$9, period_to=$10,
          ra_bill_no=$11, client_rep=$12, contractor_rep=$13, notes=$14, total_qty=$15, amount=$16, updated_at=$17 WHERE id=$18`,
          [f.project, f.location, f.work_item, f.boq_item, f.contractor, f.unit, f.rate, f.measured_on, f.period_from, f.period_to, f.ra_bill_no, f.client_rep, f.contractor_rep, f.notes, L.total, amount, t, id]);
        await client.query('DELETE FROM est_jmr_lines WHERE jmr_id=$1', [id]);
      } else {
        let ref; do { ref = genRef('JMR'); } while ((await client.query('SELECT 1 FROM est_jmr WHERE ref=$1', [ref])).rows.length);
        id = (await client.query(`INSERT INTO est_jmr(ref, project, location, work_item, boq_item, contractor, unit, rate, measured_on, period_from, period_to, ra_bill_no, client_rep, contractor_rep, notes,
          total_qty, amount, status, created_by, created_by_name, created_at, updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'draft',$18,$19,$20,$20) RETURNING id`,
          [ref, f.project, f.location, f.work_item, f.boq_item, f.contractor, f.unit, f.rate, f.measured_on, f.period_from, f.period_to, f.ra_bill_no, f.client_rep, f.contractor_rep, f.notes, L.total, amount, req.user.username, m.name, t])).rows[0].id;
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
    res.json({ ok: true, id, ref: j.ref, total_qty: L.total, amount });
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
  const label = (type, x) => type === 'jmr' ? `JMR ${x.ref} — ${x.work_item}${x.contractor ? ` (${x.contractor})` : ''}, ${x.project}` : `Reconciliation ${x.ref} — ${x.material}${x.contractor ? ` (${x.contractor})` : ''}, ${x.project}`;
  async function submit(req, res, type, x, m) {
    if (!['draft', 'returned'].includes(x.status)) return res.status(400).json({ error: 'It has already been sent for approval.' });
    if (!(await hasSource(type, x.id))) return res.status(400).json({ error: NEED_SOURCE });
    await q(`UPDATE ${TABLE[type]} SET status='submitted', submitted_at=$1 WHERE id=$2`, [now(), x.id]);
    const to = await approversFor(x.project);
    const extra = type === 'jmr' ? ` Qty ${Number(x.total_qty)} ${x.unit}${x.amount != null ? `, ₹${Number(x.amount).toLocaleString('en-IN')}` : ''}.` : '';
    await notify(to, req.user.username, 'est_submitted', `${m.name} sent ${label(type, x)} for your approval.${extra}`);
    await auditFromReq(req, `${type}_submitted`, `Sent ${label(type, x)} for approval.`);
    res.json({ ok: true, id: x.id, ref: x.ref, status: 'submitted', sentTo: to });
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
      if (!canApprove(m, x.project)) return res.status(403).json({ error: 'Only Admin, Directors, Senior management or the project heads can approve this.' });
      if (x.status !== 'submitted') return res.status(400).json({ error: 'It is not waiting for approval.' });
      const decision = str((req.body || {}).decision);
      const note = str((req.body || {}).note).trim().slice(0, 1000);
      if (!['approve', 'return'].includes(decision)) return res.status(400).json({ error: 'Approve or return it.' });
      if (decision === 'return' && note.length < 5) return res.status(400).json({ error: 'Write what needs correcting (at least 5 characters).' });
      if (x.created_by === req.user.username && decision === 'approve' && req.user.role !== 'admin') return res.status(400).json({ error: 'You cannot approve your own entry.' });
      await q(`UPDATE ${TABLE[type]} SET status=$1, decided_by=$2, decided_by_name=$3, decided_at=$4, decision_note=$5 WHERE id=$6`,
        [decision === 'approve' ? 'approved' : 'returned', req.user.username, m.name, now(), note || null, x.id]);
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
    // Add files any time (e.g. the signed JMR copy after approval).
    app.post(`/api/estimation/${type}/:id/files`, auth(ALL_ROLES), async (req, res) => {
      const m = await me(req.user);
      const x = await getOr404(type, req.params.id, res); if (!x) return;
      if (!(m.canEdit || canApprove(m, x.project))) return res.status(403).json({ error: 'Only the Estimation & Billing team, approvers or Admin can add files.' });
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
  app.post('/api/estimation/files/:id/delete', auth(ALL_ROLES), async (req, res) => {
    const f = await one('SELECT * FROM est_files WHERE id=$1', [Number(req.params.id) || 0]);
    if (!f) return res.status(404).json({ error: 'File not found.' });
    if (!(req.user.role === 'admin' || f.uploaded_by === req.user.username)) return res.status(403).json({ error: 'Only whoever uploaded it (or Admin) can remove it.' });
    await q('DELETE FROM est_files WHERE id=$1', [f.id]);
    res.json({ ok: true });
  });
}

module.exports = { mountEstimation, STATUS };
