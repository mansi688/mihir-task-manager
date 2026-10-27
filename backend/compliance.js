/* Compliance due dates — monthly statutory work for the Accounts Department.

   Each item has a day of the month it is due by (TDS deposit 7th, GST deposit 20th, Sales invoices 5th, Electricity
   bill 10th or the date on the bill, PT 15th, PF 15th — seeded on first start; Accounts / Admin can add, edit or
   remove items). For any month a different due date can be set (e.g. the date printed on the electricity bill).

   Reminders go to the Accounts Department and Admin at the 9 AM / 3 PM / 6 PM reminder slots, once a day per item:
   10 days before the due date, 2 days before, on the due date, and every day after it until someone marks that
   month done. Marking it done stops the reminders and tells the others.
   The bill / challan for a month can be uploaded on the item (any time, or with "Done"). */

const REMIND_BEFORE = [10, 2];

function mountCompliance(app, deps) {
  const { db, auth, ALL_ROLES, auditFromReq, str, localDateStr, collectUploads, MAX_FILE_CHARS } = deps;
  const q = (sql, params = []) => db.pool.query(sql, params);
  const rows = async (sql, params) => (await q(sql, params)).rows;
  const one = async (sql, params) => (await q(sql, params)).rows[0] || null;
  const now = () => new Date().toISOString();
  const pad = (n) => String(n).padStart(2, '0');
  const dayNum = (ymd) => { const [y, m, d] = String(ymd).slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d) / 864e5; };
  const fmtDay = (ymd) => { try { return new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }); } catch (e) { return ymd; } };
  const fmtMonth = (p) => { try { return new Date(`${p}-15T12:00:00Z`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }); } catch (e) { return p; } };
  const shiftMonth = (p, n) => { const [y, m] = p.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`; };
  const lastDay = (p) => { const [y, m] = p.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
  const validDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null;
  const validPeriod = (v) => /^\d{4}-\d{2}$/.test(String(v || '')) ? String(v) : null;

  async function me(user) {
    const u = await db.getUserFresh(user.username);
    const admin = user.role === 'admin';
    const canEdit = admin || /account/i.test(String((u && u.team) || ''));
    return { username: user.username, name: (u && u.name) || user.name, admin, canEdit, canView: canEdit };
  }
  // Accounts Department + Admin
  async function recipients() {
    const users = await db.listUsers();
    return [...new Set(users.filter(u => u.role === 'admin' || /account/i.test(u.team || '')).filter(u => u.active !== false && u.active !== 0).map(u => u.username))];
  }

  // Which month's due date is the live one: last month's if it was missed, otherwise this month's, or next month's once done.
  function dueFor(item, period, per) { const o = per && per.due_override; return o || `${period}-${pad(Math.min(item.due_day, lastDay(period)))}`; }
  function current(item, periods, today) {
    const P = today.slice(0, 7);
    const get = (p) => periods.find(x => x.period === p) || null;
    const since = String(item.created_at || '').slice(0, 10);
    const prev = shiftMonth(P, -1);
    for (const p of [prev, P, shiftMonth(P, 1)]) {
      const per = get(p); const due = dueFor(item, p, per);
      if (due < since) continue; // months before the item was added don't count
      if (p === prev && dayNum(due) >= dayNum(today)) continue;
      if (per && per.done_at) continue;
      return { period: p, due, days_left: dayNum(due) - dayNum(today), override: !!(per && per.due_override) };
    }
    const p = shiftMonth(P, 2); const per = get(p); const due = dueFor(item, p, per);
    return { period: p, due, days_left: dayNum(due) - dayNum(today), override: !!(per && per.due_override) };
  }
  async function loadItems() {
    const items = await rows('SELECT * FROM compliance_items WHERE active ORDER BY due_day, id');
    if (!items.length) return [];
    const per = await rows('SELECT * FROM compliance_periods WHERE item_id = ANY($1::int[]) ORDER BY period DESC', [items.map(i => i.id)]);
    const files = await rows('SELECT id, item_id, period, name, uploaded_by, uploaded_by_name, created_at FROM compliance_files WHERE item_id = ANY($1::int[]) ORDER BY id', [items.map(i => i.id)]);
    const filesOf = (id, p) => files.filter(f => f.item_id === id && f.period === p);
    const today = localDateStr(new Date());
    return items.map(i => {
      const mine = per.filter(p => p.item_id === i.id);
      const c = current(i, mine, today);
      return { ...i, ...c, period_label: fmtMonth(c.period), files: filesOf(i.id, c.period),
        history: mine.filter(p => p.done_at).slice(0, 6).map(p => ({ period: p.period, period_label: fmtMonth(p.period), done_at: p.done_at, done_by: p.done_by, done_by_name: p.done_by_name, note: p.note, files: filesOf(i.id, p.period) })) };
    }).sort((a, b) => a.days_left - b.days_left || a.name.localeCompare(b.name));
  }
  const notify = async (users, except, type, message, itemId) => {
    for (const u of new Set(users)) if (u && u !== except) await db.createNotification({ username: u, type, message, task_id: null, ref_type: 'compliance', ref_id: itemId });
  };
  function readItem(b) {
    const name = str((b || {}).name).trim().slice(0, 120);
    const due_day = Number((b || {}).due_day);
    const notes = str((b || {}).notes).trim().slice(0, 500) || null;
    if (!name) return { error: 'Write what is due (e.g. GST deposit).' };
    if (!Number.isInteger(due_day) || due_day < 1 || due_day > 31) return { error: 'Due day must be a day of the month (1 to 31).' };
    return { f: { name, due_day, notes } };
  }
  async function saveFiles(item, period, body, m) {
    const up = collectUploads({ attachments: (body || {}).attachments }, MAX_FILE_CHARS);
    if (up.error) return up;
    for (const f of up.files) await q('INSERT INTO compliance_files(item_id, period, name, data, uploaded_by, uploaded_by_name, created_at) VALUES($1,$2,$3,$4,$5,$6,$7)', [item.id, period, f.name, f.data, m.username, m.name, now()]);
    return { count: up.files.length };
  }
  const getItem = async (id, res) => { const x = await one('SELECT * FROM compliance_items WHERE id=$1 AND active', [Number(id) || 0]); if (!x) res.status(404).json({ error: 'Not found.' }); return x; };
  const guard = async (req, res) => { const m = await me(req.user); if (!m.canEdit) { res.status(403).json({ error: 'Only the Accounts Department and Admin can change compliance dates.' }); return null; } return m; };

  app.get('/api/compliance', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user);
    if (!m.canView) return res.status(403).json({ error: 'Compliance dates are for the Accounts Department and Admin.' });
    res.json({ me: { canEdit: m.canEdit }, remindBefore: REMIND_BEFORE, items: await loadItems() });
  });
  app.post('/api/compliance', auth(ALL_ROLES), async (req, res) => {
    const m = await guard(req, res); if (!m) return;
    const r = readItem(req.body); if (r.error) return res.status(400).json({ error: r.error });
    const x = await one('INSERT INTO compliance_items(name, due_day, notes, created_by, created_at) VALUES($1,$2,$3,$4,$5) RETURNING id', [r.f.name, r.f.due_day, r.f.notes, m.username, now()]);
    await auditFromReq(req, 'compliance_added', `Added compliance date: ${r.f.name}, by the ${r.f.due_day} of every month.`);
    res.json({ ok: true, id: x.id });
  });
  app.post('/api/compliance/:id/update', auth(ALL_ROLES), async (req, res) => {
    const m = await guard(req, res); if (!m) return;
    const x = await getItem(req.params.id, res); if (!x) return;
    const r = readItem(req.body); if (r.error) return res.status(400).json({ error: r.error });
    await q('UPDATE compliance_items SET name=$1, due_day=$2, notes=$3, updated_at=$4 WHERE id=$5', [r.f.name, r.f.due_day, r.f.notes, now(), x.id]);
    await auditFromReq(req, 'compliance_updated', `Compliance date ${x.name} (${x.due_day}) → ${r.f.name} (${r.f.due_day}).`);
    res.json({ ok: true });
  });
  app.post('/api/compliance/:id/delete', auth(ALL_ROLES), async (req, res) => {
    const m = await guard(req, res); if (!m) return;
    const x = await getItem(req.params.id, res); if (!x) return;
    await q('UPDATE compliance_items SET active=FALSE, updated_at=$1 WHERE id=$2', [now(), x.id]);
    await q("DELETE FROM notifications WHERE type='compliance_due' AND ref_type='compliance' AND ref_id=$1", [x.id]);
    await auditFromReq(req, 'compliance_removed', `Removed compliance date: ${x.name}.`);
    res.json({ ok: true });
  });
  // A different due date for one month (e.g. the date on this month's electricity bill); empty = back to the usual day.
  app.post('/api/compliance/:id/due-date', auth(ALL_ROLES), async (req, res) => {
    const m = await guard(req, res); if (!m) return;
    const x = await getItem(req.params.id, res); if (!x) return;
    const period = validPeriod((req.body || {}).period); if (!period) return res.status(400).json({ error: 'Pick the month.' });
    const raw = (req.body || {}).due_date; const due = raw ? validDay(raw) : null;
    if (raw && !due) return res.status(400).json({ error: 'Pick a valid date.' });
    await q(`INSERT INTO compliance_periods(item_id, period, due_override) VALUES($1,$2,$3)
      ON CONFLICT(item_id, period) DO UPDATE SET due_override=EXCLUDED.due_override`, [x.id, period, due]);
    await auditFromReq(req, 'compliance_due_set', `${x.name} for ${fmtMonth(period)}: due ${due ? fmtDay(due) : `back to the ${x.due_day}`}.`);
    res.json({ ok: true });
  });
  app.post('/api/compliance/:id/done', auth(ALL_ROLES), async (req, res) => {
    const m = await guard(req, res); if (!m) return;
    const x = await getItem(req.params.id, res); if (!x) return;
    const period = validPeriod((req.body || {}).period); if (!period) return res.status(400).json({ error: 'Pick the month.' });
    const note = str((req.body || {}).note).trim().slice(0, 500) || null;
    const up = await saveFiles(x, period, req.body, m); if (up.error) return res.status(400).json({ error: up.error });
    await q(`INSERT INTO compliance_periods(item_id, period, done_at, done_by, done_by_name, note) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(item_id, period) DO UPDATE SET done_at=EXCLUDED.done_at, done_by=EXCLUDED.done_by, done_by_name=EXCLUDED.done_by_name, note=EXCLUDED.note`,
    [x.id, period, now(), m.username, m.name, note]);
    await q("DELETE FROM notifications WHERE type='compliance_due' AND ref_type='compliance' AND ref_id=$1", [x.id]);
    await notify(await recipients(), m.username, 'compliance_done', `✅ ${m.name} marked ${x.name} for ${fmtMonth(period)} as done.${note ? ` ${note}` : ''}${up.count ? ` (${up.count} file${up.count > 1 ? 's' : ''} attached)` : ''}`, x.id);
    await auditFromReq(req, 'compliance_done', `${x.name} for ${fmtMonth(period)} marked done.`);
    res.json({ ok: true });
  });
  app.post('/api/compliance/:id/undone', auth(ALL_ROLES), async (req, res) => {
    const m = await guard(req, res); if (!m) return;
    const x = await getItem(req.params.id, res); if (!x) return;
    const period = validPeriod((req.body || {}).period); if (!period) return res.status(400).json({ error: 'Pick the month.' });
    await q('UPDATE compliance_periods SET done_at=NULL, done_by=NULL, done_by_name=NULL, note=NULL WHERE item_id=$1 AND period=$2', [x.id, period]);
    await auditFromReq(req, 'compliance_undone', `${x.name} for ${fmtMonth(period)} marked not done.`);
    res.json({ ok: true });
  });

  // Upload the bill / challan for a month.
  app.post('/api/compliance/:id/files', auth(ALL_ROLES), async (req, res) => {
    const m = await guard(req, res); if (!m) return;
    const x = await getItem(req.params.id, res); if (!x) return;
    const period = validPeriod((req.body || {}).period); if (!period) return res.status(400).json({ error: 'Pick the month.' });
    if (!Array.isArray((req.body || {}).attachments) || !req.body.attachments.length) return res.status(400).json({ error: 'Choose the bill / document to upload.' });
    const up = await saveFiles(x, period, req.body, m); if (up.error) return res.status(400).json({ error: up.error });
    await auditFromReq(req, 'compliance_file', `${up.count} file(s) uploaded for ${x.name}, ${fmtMonth(period)}.`);
    res.json({ ok: true, count: up.count });
  });
  app.get('/api/compliance/files/:fid', auth(ALL_ROLES), async (req, res) => {
    const m = await me(req.user); if (!m.canView) return res.status(403).json({ error: 'Not allowed.' });
    const f = await one('SELECT name, data FROM compliance_files WHERE id=$1', [Number(req.params.fid) || 0]);
    if (!f) return res.status(404).json({ error: 'File not found.' });
    res.json(f);
  });
  app.post('/api/compliance/files/:fid/delete', auth(ALL_ROLES), async (req, res) => {
    const m = await guard(req, res); if (!m) return;
    const f = await one('SELECT id, uploaded_by FROM compliance_files WHERE id=$1', [Number(req.params.fid) || 0]);
    if (!f) return res.status(404).json({ error: 'File not found.' });
    if (!(m.admin || f.uploaded_by === m.username)) return res.status(403).json({ error: 'Only whoever uploaded it (or Admin) can remove it.' });
    await q('DELETE FROM compliance_files WHERE id=$1', [f.id]);
    res.json({ ok: true });
  });

  // ---- Reminders (called from the reminder engine at each slot; once a day per item per person)
  async function runComplianceReminders(nowDate) {
    const today = localDateStr(nowDate);
    const items = await rows('SELECT * FROM compliance_items WHERE active');
    if (!items.length) return 0;
    const per = await rows('SELECT * FROM compliance_periods WHERE item_id = ANY($1::int[])', [items.map(i => i.id)]);
    const to = await recipients();
    let sent = 0;
    for (const it of items) {
      const c = current(it, per.filter(p => p.item_id === it.id), today);
      const d = c.days_left;
      const what = `${it.name} for ${fmtMonth(c.period)}`;
      let message = null;
      if (d === 10) message = `📅 Compliance: ${what} is due by ${fmtDay(c.due)} — 10 days left.${it.notes ? ` ${it.notes}` : ''}`;
      else if (d === 2) message = `⚠️ Compliance: ${what} is due in 2 days (${fmtDay(c.due)}). Please complete it and mark it done.`;
      else if (d === 0) message = `⏰ Compliance due TODAY: ${what} (${fmtDay(c.due)}). Mark it done once it is filed / paid.`;
      else if (d < 0) message = `🔴 Compliance overdue by ${-d} day${d === -1 ? '' : 's'}: ${what} was due ${fmtDay(c.due)}. Mark it done on the Accounts Dept page once completed.`;
      if (!message) continue;
      for (const u of to) {
        const id = await db.claimDelivery({ key: `comp:${it.id}:${c.period}:${u}:${today}`, recipient: u, taskId: null, type: 'compliance_due' });
        if (!id) continue;
        try {
          await q("DELETE FROM notifications WHERE username=$1 AND type='compliance_due' AND ref_type='compliance' AND ref_id=$2", [u, it.id]);
          const nid = await db.createNotification({ username: u, type: 'compliance_due', message, task_id: null, ref_type: 'compliance', ref_id: it.id });
          await db.finishDelivery(id, { status: 'sent', notificationId: nid, sentAt: nowDate.toISOString() });
          sent++;
        } catch (e) { await db.finishDelivery(id, { status: 'failed', reason: e.message.slice(0, 300) }); }
      }
    }
    return sent;
  }
  return { runComplianceReminders };
}

module.exports = { mountCompliance, REMIND_BEFORE };
