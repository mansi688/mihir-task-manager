// Deliveries: material that still has to reach a site and be unloaded. A material task whose work is
// done (vendor decided etc.) but which is only waiting for delivery is put on the Deliveries tab with
// "Add to delivery": only its title is copied; the site team is tagged, the date given (time optional),
// and transport details (Porter order ID, delivery ID, driver name and number, vehicle…) can be added
// now or later. The tagged site people upload photo proof of delivery and then of unloading, each with
// its time. Only Admin and the Purchase Department create or edit deliveries; anyone can be tagged, and
// everyone tagged is added to "Keep informed" on the linked task so they can open it.
const STATUSES = ['scheduled', 'dispatched', 'delivered', 'unloaded', 'cancelled'];
// Documents for a delivery, in two groups. Which ones are required is set per delivery (default: the
// delivery challan going to site, and the signed challan coming back); the rest are optional.
const DOC_TYPES = [
  { key: 'challan', label: 'Delivery challan', dir: 'to_site' },
  { key: 'po', label: 'Purchase order', dir: 'to_site' },
  { key: 'invoice', label: 'Vendor invoice / bill', dir: 'to_site' },
  { key: 'eway', label: 'E-way bill', dir: 'to_site' },
  { key: 'transport_booking', label: 'Porter / transport booking', dir: 'to_site' },
  { key: 'other_to_site', label: 'Other document', dir: 'to_site' },
  { key: 'signed_challan', label: 'Signed / stamped challan', dir: 'from_site' },
  { key: 'grn', label: 'Material inward / GRN', dir: 'from_site' },
  { key: 'received_invoice', label: 'Invoice received with material', dir: 'from_site' },
  { key: 'weighbridge', label: 'Weighbridge slip', dir: 'from_site' },
  { key: 'damage_report', label: 'Shortage / damage report', dir: 'from_site' },
  { key: 'other_from_site', label: 'Other document', dir: 'from_site' },
];
const DOC = Object.fromEntries(DOC_TYPES.map(d => [d.key, d]));
const DEFAULT_REQUIRED = ['challan', 'signed_challan'];
const PAY_PURPOSES = ['Porter / transport fare', 'Unloading labour', 'Loading labour', 'Toll / parking', 'Other'];
const PAY_MODES = ['Cash', 'UPI', 'Bank transfer', 'Other'];
const TEXT_FIELDS = { title: 200, quantity: 120, description: 2000, vendor: 160, project: 160, site_location: 200, transport: 60,
  porter_order_id: 80, delivery_ref: 80, driver_name: 120, driver_phone: 30, vehicle_no: 30 };

function mountDeliveries(app, deps) {
  const { db, auth, ALL_ROLES, auditFromReq, taskEvent, collectUploads, MAX_FILE_CHARS, displayName, str, releaseDependentsOf } = deps;
  const isPurchase = (team) => /purchase/i.test(String(team || ''));
  // Admin, the Purchase Department, and anyone Admin has given delivery access (Accounts → "Can manage
  // deliveries" — e.g. the purchase head's assistant who sits in another department).
  async function canManage(user) {
    if (user.role === 'admin') return true;
    const me = await db.getUserFresh(user.username);
    return !!(me && (isPurchase(me.team) || me.manage_deliveries));
  }
  // Accounts Department: sees every delivery's budget, payments and bills (read-only) to match receipts.
  async function isAccounts(user) {
    const me = await db.getUserFresh(user.username);
    return !!(me && /account/i.test(me.team || ''));
  }
  const receiversOf = (d) => (Array.isArray(d.receivers) ? d.receivers : String(d.receivers || '').split(',')).filter(Boolean);
  async function canSee(user, d) {
    if (user.role === 'admin' || user.role === 'director' || d.created_by === user.username || receiversOf(d).includes(user.username)) return true;
    if (await canManage(user)) return true;
    if (await isAccounts(user)) return true;
    if (d.task_id) {
      const t = await db.getTask(d.task_id);
      if (t && (t.created_by_username === user.username || (await db.listAssignees(t.id)).some(a => a.username === user.username))) return true;
    }
    return false;
  }
  const canProve = async (user, d) => receiversOf(d).includes(user.username) || await canManage(user);
  // "2026-10-28" or "2026-10-28T15:30"
  const cleanWhen = (v) => { const s = str(v).trim(); return /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(s) ? s : null; };
  const cleanPhone = (v) => str(v).replace(/[^\d+ -]/g, '').trim().slice(0, 30);
  function readFields(body, { partial }) {
    const out = {}; const errors = [];
    for (const [k, max] of Object.entries(TEXT_FIELDS)) {
      if (!(k in body)) continue;
      const v = k === 'driver_phone' ? cleanPhone(body[k]) : str(body[k]).trim();
      if (v.length > max) errors.push(`${k.replace(/_/g, ' ')} is too long`);
      out[k] = v || null;
    }
    if ('expected_at' in body) { const w = cleanWhen(body.expected_at); if (!w) errors.push('Pick the delivery date (time is optional).'); out.expected_at = w; }
    if ('budget_amount' in body) {
      const raw = body.budget_amount;
      if (raw === null || raw === '' || raw === undefined) out.budget_amount = null;
      else { const n = Math.round(Number(raw) * 100) / 100; if (!isFinite(n) || n < 0 || n > 10000000) errors.push('Enter the budget as an amount in rupees.'); else out.budget_amount = n; }
    }
    if ('budget_note' in body) { const v = str(body.budget_note).trim(); if (v.length > 300) errors.push('Budget note is too long'); out.budget_note = v || null; }
    if ('required_docs' in body) {
      const list = Array.isArray(body.required_docs) ? body.required_docs.map(x => str(x)) : [];
      if (list.some(k => !DOC[k])) errors.push('Unknown document type.');
      out.required_docs = Array.from(new Set(list.filter(k => DOC[k]))).join(',');
    }
    if (!partial) {
      if (!out.title) errors.push('Write what is being delivered.');
      if (!out.expected_at) errors.push('Pick the delivery date (time is optional).');
    } else if ('title' in out && !out.title) errors.push('Write what is being delivered.');
    return { out, error: errors[0] || null };
  }
  async function readReceivers(list) {
    const names = Array.from(new Set((Array.isArray(list) ? list : []).map(u => str(u).trim()).filter(Boolean))).slice(0, 50);
    for (const u of names) if (!(await db.getUser(u))) return { error: `Unknown user: ${u}` };
    return { names };
  }
  const label = (d) => `"${d.title}" (${d.ref})`;
  const whenText = (w) => { if (!w) return ''; const [d, t] = w.split('T'); const dt = new Date(d + 'T12:00:00+05:30'); return dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) + (t ? ` ${t}` : ''); };
  const notifyMany = async (users, except, type, message, taskId) => { for (const u of new Set(users)) if (u && u !== except) await db.createNotification({ username: u, type, message, task_id: taskId || null }); };
  // Everyone tagged on a delivery can open its task: they are put on the task's "Keep informed" list.
  async function keepInformedOnTask(d, users, by) {
    if (!d.task_id) return;
    const t = await db.getTask(d.task_id); if (!t) return;
    const assignees = new Set((await db.listAssignees(t.id)).map(a => a.username));
    for (const u of users) if (u !== t.created_by_username && !assignees.has(u)) await db.addFollowup(t.id, u, by);
  }

  app.get('/api/deliveries', auth(ALL_ROLES), async (req, res) => {
    const manage = await canManage(req.user);
    const accounts = !manage && await isAccounts(req.user);
    const everything = manage || accounts || req.user.role === 'director';
    res.json({ canManage: manage, seesAll: everything, docTypes: DOC_TYPES, defaultRequired: DEFAULT_REQUIRED, payPurposes: PAY_PURPOSES, payModes: PAY_MODES,
      items: await db.listDeliveriesFor(req.user.username, everything) });
  });

  app.post('/api/deliveries', auth(ALL_ROLES), async (req, res) => {
    if (!(await canManage(req.user))) return res.status(403).json({ error: 'Only Admin, the Purchase Department and people given delivery access can add deliveries.' });
    const b = req.body || {};
    const { out, error } = readFields(b, { partial: false }); if (error) return res.status(400).json({ error });
    const rec = await readReceivers(b.receivers); if (rec.error) return res.status(400).json({ error: rec.error });
    if (!rec.names.length) return res.status(400).json({ error: 'Tag at least one person on site who will receive it.' });
    let task = null;
    if (b.task_id) {
      task = await db.getTask(str(b.task_id));
      if (!task) return res.status(400).json({ error: 'That task was not found.' });
    }
    const up = collectUploads(b, MAX_FILE_CHARS); if (up.error) return res.status(400).json({ error: up.error });
    const d = await db.createDelivery({ ...out, receivers: rec.names, task_id: task ? task.id : null, created_by: req.user.username, created_by_name: req.user.name }, up.files);
    const extra = {};
    if ('budget_amount' in out) extra.budget_amount = out.budget_amount;
    if ('budget_note' in out) extra.budget_note = out.budget_note;
    extra.required_docs = 'required_docs' in out ? out.required_docs : DEFAULT_REQUIRED.join(',');
    await db.updateDelivery(d.id, extra);
    // The task's own work is finished — only delivery is pending — so the task is closed here and from
    // now on only the delivery (the site team) is tracked. Nobody on the task is marked late for the wait.
    let closedTask = false, keptOpenWhy = null;
    if (task && task.status === 'open' && b.closeTask !== false) {
      const openSubs = await db.listOpenSubtasks(task.id);
      if (await db.isTaskBlocked(task.id)) keptOpenWhy = 'it depends on another task that is not closed yet';
      else if (openSubs.length) keptOpenWhy = `it has ${openSubs.length} open subtask${openSubs.length > 1 ? 's' : ''}`;
      else if (await db.closeTask(task.id, req.user.name)) {
        closedTask = true;
        await db.updateDelivery(d.id, { closed_task: 1 });
        if (releaseDependentsOf) await releaseDependentsOf(task);
        await taskEvent(req, task.id, 'COMPLETED', `Task closed — work done, moved to Deliveries as ${d.ref}`, { old: 'open', new: 'closed' });
        await db.settleClosureRequests(task.id, req.user.username);
        await auditFromReq(req, 'task_closed', `Closed "${task.title}" (${task.id}) — moved to Deliveries as ${d.ref}.`);
      }
    }
    await keepInformedOnTask(d, rec.names, req.user.username);
    await notifyMany(rec.names, req.user.username, 'delivery_scheduled',
      `Delivery coming: ${label(d)} — ${whenText(d.expected_at)}${d.project ? ` · ${d.project}` : ''}. Please receive it and upload proof of delivery and unloading.`, d.task_id);
    if (task) await taskEvent(req, task.id, 'DELIVERY_ADDED', `Added to Deliveries as ${d.ref} — expected ${whenText(d.expected_at)}; site team: ${(await Promise.all(rec.names.map(displayName))).join(', ')}`, { meta: { delivery: d.ref } });
    await auditFromReq(req, 'delivery_created', `Created delivery ${label(d)}${task ? ` from task ${task.id}` : ''}.`);
    res.json({ ok: true, id: d.id, ref: d.ref, closedTask, keptOpenWhy });
  });

  // Edit details (add the driver, vehicle, Porter order… later), re-tag the site team, change the date.
  app.post('/api/deliveries/:id/update', auth(ALL_ROLES), async (req, res) => {
    const d = await db.getDelivery(req.params.id); if (!d) return res.status(404).json({ error: 'Delivery not found.' });
    if (!(await canManage(req.user))) return res.status(403).json({ error: 'Only Admin, the Purchase Department and people given delivery access can edit deliveries.' });
    if (d.status === 'cancelled') return res.status(400).json({ error: 'This delivery was cancelled and can no longer be edited.' });
    const b = req.body || {};
    const { out, error } = readFields(b, { partial: true }); if (error) return res.status(400).json({ error });
    // After unloading only the budget and the document list can still change (bills and papers come later).
    if (d.status === 'unloaded') {
      const allowed = ['budget_amount', 'budget_note', 'required_docs'];
      if (Object.keys(out).some(k => !allowed.includes(k)) || (Array.isArray(b.attachments) && b.attachments.length) || 'receivers' in b)
        return res.status(400).json({ error: 'This delivery is finished — only its budget and documents list can still be changed.' });
    }
    let added = [];
    if ('receivers' in b) {
      const rec = await readReceivers(b.receivers); if (rec.error) return res.status(400).json({ error: rec.error });
      if (!rec.names.length) return res.status(400).json({ error: 'Tag at least one person on site who will receive it.' });
      added = rec.names.filter(u => !receiversOf(d).includes(u));
      out.receivers = rec.names;
    }
    const up = collectUploads(b, MAX_FILE_CHARS); if (up.error) return res.status(400).json({ error: up.error });
    const nd = Object.keys(out).length ? await db.updateDelivery(d.id, out) : d;
    if (up.files.length) await db.addDeliveryFiles(d.id, 'attachment', up.files, req.user.username);
    if (added.length) {
      await keepInformedOnTask(nd, added, req.user.username);
      await notifyMany(added, req.user.username, 'delivery_scheduled', `Delivery coming: ${label(nd)} — ${whenText(nd.expected_at)}. Please receive it and upload proof of delivery and unloading.`, nd.task_id);
    }
    const driverAdded = (out.driver_name && out.driver_name !== d.driver_name) || (out.driver_phone && out.driver_phone !== d.driver_phone) || (out.vehicle_no && out.vehicle_no !== d.vehicle_no);
    if (driverAdded) {
      const who = [nd.driver_name, nd.driver_phone, nd.vehicle_no].filter(Boolean).join(' · ');
      await notifyMany(receiversOf(nd).filter(u => !added.includes(u)), req.user.username, 'delivery_update', `Delivery ${label(nd)}: driver details — ${who}.`, nd.task_id);
    }
    const oldBudget = d.budget_amount == null ? null : Number(d.budget_amount);
    if ('budget_amount' in out && out.budget_amount !== oldBudget && out.budget_amount != null) {
      const paid = await db.deliveryPaidTotal(d.id);
      await notifyMany(receiversOf(nd).filter(u => !added.includes(u)), req.user.username, 'delivery_update',
        `Delivery ${label(nd)}: budget for porter / transport ${oldBudget == null ? 'set to' : 'changed to'} ₹${Number(out.budget_amount).toLocaleString('en-IN')}${paid ? ` (₹${paid.toLocaleString('en-IN')} paid so far)` : ''}. Record every payment with the bill.`, nd.task_id);
    }
    res.json({ ok: true });
  });

  // On the way / cancelled (Admin, Purchase).
  app.post('/api/deliveries/:id/status', auth(ALL_ROLES), async (req, res) => {
    const d = await db.getDelivery(req.params.id); if (!d) return res.status(404).json({ error: 'Delivery not found.' });
    if (!(await canManage(req.user))) return res.status(403).json({ error: 'Only Admin, the Purchase Department and people given delivery access can change this.' });
    const status = str((req.body || {}).status);
    const now = new Date().toISOString();
    if (status === 'dispatched') {
      if (d.status !== 'scheduled') return res.status(400).json({ error: 'Only a scheduled delivery can be marked as on the way.' });
      await db.updateDelivery(d.id, { status, dispatched_at: now, dispatched_by: req.user.username });
      await notifyMany(receiversOf(d), req.user.username, 'delivery_update', `On the way: ${label(d)}${d.driver_name ? ` — ${d.driver_name}${d.driver_phone ? ` (${d.driver_phone})` : ''}` : ''}${d.vehicle_no ? `, ${d.vehicle_no}` : ''}.`, d.task_id);
    } else if (status === 'cancelled') {
      const reason = str((req.body || {}).reason).trim();
      if (reason.length < 3) return res.status(400).json({ error: 'Write why it is cancelled.' });
      if (['unloaded', 'cancelled'].includes(d.status)) return res.status(400).json({ error: 'This delivery is already finished.' });
      await db.updateDelivery(d.id, { status, cancelled_at: now, cancelled_by: req.user.username, cancel_reason: reason.slice(0, 500) });
      await notifyMany(receiversOf(d), req.user.username, 'delivery_update', `Cancelled: ${label(d)} — ${reason.slice(0, 200)}`, d.task_id);
    } else return res.status(400).json({ error: 'Unknown status.' });
    if (d.task_id) await taskEvent(req, d.task_id, 'DELIVERY_UPDATED', `Delivery ${d.ref}: ${status === 'dispatched' ? 'on the way' : 'cancelled'}`, { meta: { delivery: d.ref } });
    res.json({ ok: true });
  });

  // Proof from the site: photos (required) + note. Stage 'delivered' first, then 'unloaded'.
  app.post('/api/deliveries/:id/proof', auth(ALL_ROLES), async (req, res) => {
    const d = await db.getDelivery(req.params.id); if (!d) return res.status(404).json({ error: 'Delivery not found.' });
    if (!(await canProve(req.user, d))) return res.status(403).json({ error: 'Only the people tagged to receive it (or the purchase team) can upload proof.' });
    const b = req.body || {};
    const stage = str(b.stage);
    if (!['delivered', 'unloaded'].includes(stage)) return res.status(400).json({ error: 'Unknown step.' });
    if (d.status === 'cancelled') return res.status(400).json({ error: 'This delivery was cancelled.' });
    if (stage === 'delivered' && !['scheduled', 'dispatched'].includes(d.status)) return res.status(400).json({ error: 'Delivery is already confirmed.' });
    if (stage === 'unloaded' && d.status !== 'delivered') return res.status(400).json({ error: d.status === 'unloaded' ? 'Unloading is already confirmed.' : 'Confirm the delivery first, then the unloading.' });
    const up = collectUploads(b, MAX_FILE_CHARS); if (up.error) return res.status(400).json({ error: up.error });
    const photos = up.files.filter(f => /^data:image\//i.test(f.data));
    if (!photos.length) return res.status(400).json({ error: 'Add at least one photo as proof.' });
    const takenAt = Array.isArray(b.takenAt) ? b.takenAt : [];
    const files = up.files.map((f, i) => ({ ...f, taken_at: str(takenAt[i]).slice(0, 40) || null }));
    const note = str(b.note).trim().slice(0, 1000) || null;
    const now = new Date().toISOString();
    await db.addDeliveryFiles(d.id, stage === 'delivered' ? 'delivery_proof' : 'unloading_proof', files, req.user.username);
    if (stage === 'delivered') await db.updateDelivery(d.id, { status: 'delivered', delivered_at: now, delivered_by: req.user.username, delivered_note: note });
    else await db.updateDelivery(d.id, { status: 'unloaded', unloaded_at: now, unloaded_by: req.user.username, unloaded_note: note });
    const t = d.task_id ? await db.getTask(d.task_id) : null;
    const tell = new Set([d.created_by, ...receiversOf(d), t && t.created_by_username].filter(Boolean));
    const time = new Date(now).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' });
    await notifyMany(tell, req.user.username, stage === 'delivered' ? 'delivery_delivered' : 'delivery_unloaded',
      `${stage === 'delivered' ? 'Delivered' : 'Unloaded'}: ${label(d)} — ${req.user.name} uploaded ${photos.length} photo${photos.length > 1 ? 's' : ''} at ${time}${note ? `: ${note.slice(0, 120)}` : ''}.${stage === 'unloaded' && t && t.status === 'open' ? ' The task can now be closed.' : ''}`, d.task_id);
    if (d.task_id) await taskEvent(req, d.task_id, stage === 'delivered' ? 'DELIVERY_DELIVERED' : 'DELIVERY_UNLOADED', `Delivery ${d.ref}: ${stage === 'delivered' ? 'delivered' : 'unloaded'} — ${photos.length} photo proof${note ? ` · ${note}` : ''}`, { meta: { delivery: d.ref } });
    res.json({ ok: true });
  });

  // ---- Documents: "Sent to site" by the purchase side, "From site" by the site team (or the purchase side).
  const requiredOf = (d) => String(d.required_docs == null ? DEFAULT_REQUIRED.join(',') : d.required_docs).split(',').filter(Boolean);
  app.post('/api/deliveries/:id/documents', auth(ALL_ROLES), async (req, res) => {
    const d = await db.getDelivery(req.params.id); if (!d) return res.status(404).json({ error: 'Delivery not found.' });
    const b = req.body || {};
    const type = DOC[str(b.type)]; if (!type) return res.status(400).json({ error: 'Pick which document this is.' });
    const manage = await canManage(req.user);
    if (type.dir === 'to_site' && !manage) return res.status(403).json({ error: 'Documents for site are sent by the purchase team.' });
    if (type.dir === 'from_site' && !(manage || receiversOf(d).includes(req.user.username))) return res.status(403).json({ error: 'Only the site team on this delivery (or the purchase team) can upload documents from site.' });
    if (d.status === 'cancelled') return res.status(400).json({ error: 'This delivery was cancelled.' });
    const up = collectUploads(b, MAX_FILE_CHARS); if (up.error) return res.status(400).json({ error: up.error });
    if (!up.files.length) return res.status(400).json({ error: 'Attach the document (photo or PDF).' });
    const note = str(b.note).trim().slice(0, 500) || null;
    const before = await db.deliveryDocTypesPresent(d.id);
    await db.addDeliveryDocument(d.id, type.key, up.files, note, req.user.username);
    const after = new Set([...before, type.key]);
    const t = d.task_id ? await db.getTask(d.task_id) : null;
    if (type.dir === 'to_site') {
      await notifyMany(receiversOf(d), req.user.username, 'delivery_document', `${type.label} sent to site for ${label(d)} — open the delivery to view or print it.`, d.task_id);
    } else {
      const office = new Set([d.created_by, t && t.created_by_username].filter(Boolean));
      const req2 = requiredOf(d).filter(k => DOC[k] && DOC[k].dir === 'from_site');
      const allIn = req2.length && req2.every(k => after.has(k)) && !req2.every(k => before.includes(k));
      await notifyMany([...office], req.user.username, 'delivery_document', `${type.label} received from site for ${label(d)} — uploaded by ${req.user.name}.${allIn ? ' All required documents from site are in.' : ''}`, d.task_id);
    }
    if (d.task_id) await taskEvent(req, d.task_id, 'DELIVERY_UPDATED', `Delivery ${d.ref}: ${type.label} uploaded (${type.dir === 'to_site' ? 'sent to site' : 'from site'})`, { meta: { delivery: d.ref, doc: type.key } });
    res.json({ ok: true });
  });
  // Remove a document or attachment uploaded by mistake (whoever uploaded it, or the purchase team).
  // Photo proof of delivery / unloading and payment bills cannot be removed this way.
  app.post('/api/deliveries/:id/files/:fileId/delete', auth(ALL_ROLES), async (req, res) => {
    const d = await db.getDelivery(req.params.id); if (!d) return res.status(404).json({ error: 'Delivery not found.' });
    const f = await db.getDeliveryFile(req.params.fileId);
    if (!f || f.delivery_id !== d.id) return res.status(404).json({ error: 'File not found.' });
    if (!['document', 'attachment'].includes(f.kind)) return res.status(400).json({ error: 'Photo proof and payment bills cannot be removed.' });
    if (!(f.uploaded_by === req.user.username || await canManage(req.user))) return res.status(403).json({ error: 'Only whoever uploaded it (or the purchase team) can remove it.' });
    await db.deleteDeliveryFile(f.id);
    await auditFromReq(req, 'delivery_file_removed', `Removed "${f.name}" from delivery ${label(d)}.`);
    res.json({ ok: true });
  });

  // ---- Budget & payments: the site team records what it paid (with the bill); paid and balance are worked out.
  app.post('/api/deliveries/:id/payments', auth(ALL_ROLES), async (req, res) => {
    const d = await db.getDelivery(req.params.id); if (!d) return res.status(404).json({ error: 'Delivery not found.' });
    const manage = await canManage(req.user);
    if (!(manage || receiversOf(d).includes(req.user.username))) return res.status(403).json({ error: 'Only the site team on this delivery (or the purchase team) can record payments.' });
    if (d.status === 'cancelled') return res.status(400).json({ error: 'This delivery was cancelled.' });
    const b = req.body || {};
    const amount = Math.round(Number(b.amount) * 100) / 100;
    if (!isFinite(amount) || amount <= 0 || amount > 1000000) return res.status(400).json({ error: 'Enter the amount paid in rupees.' });
    const purpose = PAY_PURPOSES.includes(str(b.purpose)) ? str(b.purpose) : null;
    if (!purpose) return res.status(400).json({ error: 'Pick what the payment was for.' });
    const mode = PAY_MODES.includes(str(b.mode)) ? str(b.mode) : null;
    const paidAt = cleanWhen(b.paid_at) || new Date().toISOString().slice(0, 16);
    const up = collectUploads(b, MAX_FILE_CHARS); if (up.error) return res.status(400).json({ error: up.error });
    const noBill = str(b.no_bill_reason).trim();
    if (!up.files.length && noBill.length < 5) return res.status(400).json({ error: 'Attach a photo of the bill / receipt, or write why there is no bill.' });
    const p = await db.addDeliveryPayment(d.id, { amount, purpose, mode, paid_at: paidAt, paid_to: str(b.paid_to).trim().slice(0, 120) || null,
      note: str(b.note).trim().slice(0, 500) || null, no_bill_reason: up.files.length ? null : noBill.slice(0, 300), paid_by: req.user.username, paid_by_name: req.user.name }, up.files);
    const paid = await db.deliveryPaidTotal(d.id);
    const budget = d.budget_amount == null ? null : Number(d.budget_amount);
    const inr = (n) => '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
    const over = budget != null && paid > budget;
    await notifyMany([d.created_by], req.user.username, 'delivery_payment',
      `${req.user.name} paid ${inr(amount)} (${purpose}) for ${label(d)}${up.files.length ? '' : ' — no bill'}. Paid so far ${inr(paid)}${budget != null ? ` of ${inr(budget)} budget — ${over ? `over budget by ${inr(paid - budget)}` : `${inr(budget - paid)} left`}` : ''}.`, d.task_id);
    await auditFromReq(req, 'delivery_payment', `Recorded ${inr(amount)} (${purpose}) on delivery ${label(d)}.`);
    res.json({ ok: true, id: p.id, paid, balance: budget == null ? null : Math.round((budget - paid) * 100) / 100, overBudget: over });
  });
  app.post('/api/deliveries/:id/payments/:pid/delete', auth(ALL_ROLES), async (req, res) => {
    const d = await db.getDelivery(req.params.id); if (!d) return res.status(404).json({ error: 'Delivery not found.' });
    const p = await db.getDeliveryPayment(req.params.pid);
    if (!p || p.delivery_id !== d.id) return res.status(404).json({ error: 'Payment not found.' });
    const own = p.paid_by === req.user.username && Date.now() - new Date(p.created_at).getTime() < 48 * 3600000;
    if (!(own || await canManage(req.user))) return res.status(403).json({ error: 'Only whoever recorded it (within 48 hours) or the purchase team can remove a payment.' });
    await db.deleteDeliveryPayment(p.id);
    await auditFromReq(req, 'delivery_payment_removed', `Removed payment of ₹${Number(p.amount)} (${p.purpose}) from delivery ${label(d)}.`);
    res.json({ ok: true });
  });

  // Follow up: remind the tagged site team about this delivery. They see who followed up and when.
  app.post('/api/deliveries/:id/followup', auth(ALL_ROLES), async (req, res) => {
    const d = await db.getDelivery(req.params.id); if (!d) return res.status(404).json({ error: 'Delivery not found.' });
    if (!(await canManage(req.user))) return res.status(403).json({ error: 'Only the purchase team (and Admin) can follow up on deliveries.' });
    if (['unloaded', 'cancelled'].includes(d.status)) return res.status(400).json({ error: 'This delivery is already finished.' });
    if (d.last_followup_at && Date.now() - new Date(d.last_followup_at).getTime() < 10 * 60000) {
      return res.status(429).json({ error: 'You followed up less than 10 minutes ago — give the site team a moment.' });
    }
    const step = d.status === 'delivered' ? 'please upload the unloading photos' : 'please confirm the delivery with photos when it arrives';
    await notifyMany(receiversOf(d), req.user.username, 'delivery_followup', `Follow-up from ${req.user.name}: ${label(d)} — ${step}.`, d.task_id);
    const nd = await db.markDeliveryFollowUp(d.id, req.user.username);
    if (d.task_id) await taskEvent(req, d.task_id, 'FOLLOW_UP_SENT', `Delivery ${d.ref}: follow-up sent to the site team`, { meta: { delivery: d.ref } });
    res.json({ ok: true, sent: receiversOf(d), followup_count: nd.followup_count });
  });

  // Delete a delivery (Admin / purchase team). If adding it to Deliveries closed its task, the task can be
  // re-opened at the same time (e.g. it was added by mistake).
  app.post('/api/deliveries/:id/delete', auth(ALL_ROLES), async (req, res) => {
    const d = await db.getDelivery(req.params.id); if (!d) return res.status(404).json({ error: 'Delivery not found.' });
    if (!(await canManage(req.user))) return res.status(403).json({ error: 'Only Admin, the Purchase Department and people given delivery access can delete deliveries.' });
    const reopen = !!(req.body || {}).reopenTask;
    let reopened = false;
    if (reopen && d.task_id && d.closed_task) {
      const t = await db.getTask(d.task_id);
      if (t && t.status === 'closed' && await db.reopenTask(t.id)) {
        reopened = true;
        await taskEvent(req, t.id, 'REOPENED', `Re-opened — delivery ${d.ref} was deleted`, { old: 'closed', new: 'open' });
      }
    }
    await db.deleteDelivery(d.id);
    await notifyMany(receiversOf(d), req.user.username, 'delivery_update', `Removed: delivery ${label(d)} was deleted by ${req.user.name} — nothing to receive.`, null);
    if (d.task_id && !reopened) await taskEvent(req, d.task_id, 'DELIVERY_UPDATED', `Delivery ${d.ref} deleted`, { meta: { delivery: d.ref } });
    await auditFromReq(req, 'delivery_deleted', `Deleted delivery ${label(d)}${reopened ? ` and re-opened task ${d.task_id}` : ''}.`);
    res.json({ ok: true, reopened });
  });

  // Admin: let a specific person manage deliveries even though they are not in the Purchase Department.
  app.post('/api/users/:username/delivery-access', auth(['admin']), async (req, res) => {
    const u = await db.getUserFresh(req.params.username);
    if (!u) return res.status(404).json({ error: 'User not found.' });
    const allowed = !!(req.body || {}).allowed;
    await db.setDeliveryAccess(u.username, allowed);
    await auditFromReq(req, 'delivery_access', `${allowed ? 'Gave' : 'Removed'} delivery access ${allowed ? 'to' : 'from'} ${u.name} (${u.username}).`);
    res.json({ ok: true });
  });

  app.get('/api/deliveries/:id/files/:fileId', auth(ALL_ROLES), async (req, res) => {
    const d = await db.getDelivery(req.params.id); if (!d) return res.status(404).json({ error: 'Delivery not found.' });
    if (!(await canSee(req.user, d))) return res.status(403).json({ error: 'You are not on this delivery.' });
    const f = await db.getDeliveryFile(req.params.fileId);
    if (!f || f.delivery_id !== d.id) return res.status(404).json({ error: 'File not found.' });
    res.json({ data: f.data, name: f.name });
  });
}
module.exports = { mountDeliveries, STATUSES, DOC_TYPES, DEFAULT_REQUIRED };
