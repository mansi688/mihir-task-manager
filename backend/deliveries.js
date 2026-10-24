// Deliveries: material that still has to reach a site and be unloaded. A material task whose work is
// done (vendor decided etc.) but which is only waiting for delivery is put on the Deliveries tab with
// "Add to delivery": only its title is copied; the site team is tagged, the date given (time optional),
// and transport details (Porter order ID, delivery ID, driver name and number, vehicle…) can be added
// now or later. The tagged site people upload photo proof of delivery and then of unloading, each with
// its time. Only Admin and the Purchase Department create or edit deliveries; anyone can be tagged, and
// everyone tagged is added to "Keep informed" on the linked task so they can open it.
const STATUSES = ['scheduled', 'dispatched', 'delivered', 'unloaded', 'cancelled'];
const TEXT_FIELDS = { title: 200, quantity: 120, description: 2000, vendor: 160, project: 160, site_location: 200, transport: 60,
  porter_order_id: 80, delivery_ref: 80, driver_name: 120, driver_phone: 30, vehicle_no: 30 };

function mountDeliveries(app, deps) {
  const { db, auth, ALL_ROLES, auditFromReq, taskEvent, collectUploads, MAX_FILE_CHARS, displayName, str } = deps;
  const isPurchase = (team) => /purchase/i.test(String(team || ''));
  // Admin, the Purchase Department, and anyone Admin has given delivery access (Accounts → "Can manage
  // deliveries" — e.g. the purchase head's assistant who sits in another department).
  async function canManage(user) {
    if (user.role === 'admin') return true;
    const me = await db.getUserFresh(user.username);
    return !!(me && (isPurchase(me.team) || me.manage_deliveries));
  }
  const receiversOf = (d) => (Array.isArray(d.receivers) ? d.receivers : String(d.receivers || '').split(',')).filter(Boolean);
  async function canSee(user, d) {
    if (user.role === 'admin' || user.role === 'director' || d.created_by === user.username || receiversOf(d).includes(user.username)) return true;
    if (await canManage(user)) return true;
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
    const everything = manage || req.user.role === 'director';
    res.json({ canManage: manage, items: await db.listDeliveriesFor(req.user.username, everything) });
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
    await keepInformedOnTask(d, rec.names, req.user.username);
    await notifyMany(rec.names, req.user.username, 'delivery_scheduled',
      `Delivery coming: ${label(d)} — ${whenText(d.expected_at)}${d.project ? ` · ${d.project}` : ''}. Please receive it and upload proof of delivery and unloading.`, d.task_id);
    if (task) await taskEvent(req, task.id, 'DELIVERY_ADDED', `Added to Deliveries as ${d.ref} — expected ${whenText(d.expected_at)}; site team: ${(await Promise.all(rec.names.map(displayName))).join(', ')}`, { meta: { delivery: d.ref } });
    await auditFromReq(req, 'delivery_created', `Created delivery ${label(d)}${task ? ` from task ${task.id}` : ''}.`);
    res.json({ ok: true, id: d.id, ref: d.ref });
  });

  // Edit details (add the driver, vehicle, Porter order… later), re-tag the site team, change the date.
  app.post('/api/deliveries/:id/update', auth(ALL_ROLES), async (req, res) => {
    const d = await db.getDelivery(req.params.id); if (!d) return res.status(404).json({ error: 'Delivery not found.' });
    if (!(await canManage(req.user))) return res.status(403).json({ error: 'Only Admin, the Purchase Department and people given delivery access can edit deliveries.' });
    if (['unloaded', 'cancelled'].includes(d.status)) return res.status(400).json({ error: 'This delivery is finished and can no longer be edited.' });
    const b = req.body || {};
    const { out, error } = readFields(b, { partial: true }); if (error) return res.status(400).json({ error });
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
module.exports = { mountDeliveries, STATUSES };
