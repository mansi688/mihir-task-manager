/* Deliveries tab — material that still has to reach a site and be unloaded.
   - Admin, the Purchase Department and people Admin gives delivery access add deliveries (from a task with "Add to delivery", which copies only
     its title, or from here) and can fill in transport details now or later.
   - The site people tagged on it upload photo proof of delivery, then of unloading; every photo is stamped
     with the date, time and delivery number before it is sent.
   Loaded before app.js; everything runs at call time, driven by ui.* state so a background refresh never
   resets an open form. */

let deliveriesData = { canManage: false, items: [] };

const DLV_STATUS = {
  scheduled: { label: 'Scheduled', cls: 'dlv-scheduled', icon: '🗓️' },
  dispatched: { label: 'On the way', cls: 'dlv-dispatched', icon: '🚚' },
  delivered: { label: 'Delivered — unloading pending', cls: 'dlv-delivered', icon: '📦' },
  unloaded: { label: 'Unloaded ✓', cls: 'dlv-unloaded', icon: '✅' },
  cancelled: { label: 'Cancelled', cls: 'dlv-cancelled', icon: '✖' },
};
const DLV_TABS = [
  { key: 'pending', label: 'To receive', match: d => d.status === 'scheduled' || d.status === 'dispatched' },
  { key: 'delivered', label: 'Unloading pending', match: d => d.status === 'delivered' },
  { key: 'done', label: 'Unloaded', match: d => d.status === 'unloaded' },
  { key: 'cancelled', label: 'Cancelled', match: d => d.status === 'cancelled' },
];
const DLV_TRANSPORT = ['Porter', 'Vendor vehicle', 'Own vehicle', 'Courier', 'Other'];

function dlvEsc(s) { return typeof esc === 'function' ? esc(s) : String(s == null ? '' : s); }
function dlvWhen(w) {
  if (!w) return '';
  const [d, t] = String(w).split('T');
  try {
    const dt = new Date(d + 'T12:00:00+05:30');
    const day = dt.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
    if (!t) return day;
    const [h, m] = t.split(':').map(Number);
    return `${day}, ${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  } catch (e) { return w; }
}
function dlvTime(iso) { try { return new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }); } catch (e) { return iso || ''; } }
function dlvMine(d) { return (d.receivers || []).includes(session.username); }
function dlvCanManage() { return !!deliveriesData.canManage; }
// Menu badge: deliveries waiting for my proof.
function deliveriesNeedingMeCount() { return (deliveriesData.items || []).filter(d => dlvMine(d) && ['scheduled', 'dispatched', 'delivered'].includes(d.status)).length; }
function deliveriesForTask(taskId) { return (deliveriesData.items || []).filter(d => d.task_id === taskId); }

// From a task: open the form with only the title copied (and the project, and the task link).
function openDeliveryFromTask(t) {
  ui.deliveryForm = { mode: 'new', task_id: t.id, task_title: t.title, title: t.title, project: t.project || '', expected_date: '', expected_time: '', receivers: [], files: [], transport: '', search: '' };
  ui.deliveryTab = 'pending';
  if (typeof collapseTaskCards === 'function') collapseTaskCards();
  ui.adminTab = 'deliveries'; try { safeStorage.setItem('ls_last_tab', 'deliveries'); } catch (e) {}
  render(); window.scrollTo(0, 0);
}
function openDeliveryOnPage(id) {
  ui.adminTab = 'deliveries';
  const d = (deliveriesData.items || []).find(x => x.id === id);
  if (d) ui.deliveryTab = (DLV_TABS.find(t => t.match(d)) || DLV_TABS[0]).key;
  openDetails.add(`delivery-card-${id}`);
  render();
  requestAnimationFrame(() => { const el = document.getElementById(`delivery-card-${id}`); if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' }); });
}

function deliveryFormHTML() {
  const f = ui.deliveryForm; if (!f) return '';
  const people = (userDirectory || []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const q = (f.search || '').trim().toLowerCase();
  const field = (id, label, val, ph, extra = '') => `<div class="col"><label for="${id}">${label}</label><input type="text" id="${id}" value="${dlvEsc(val || '')}" placeholder="${dlvEsc(ph || '')}" ${extra}></div>`;
  return `
  <div class="card dlv-form" id="delivery-form">
    <div class="flex-between" style="gap:8px;flex-wrap:wrap;">
      <div class="card-title" style="margin:0;">${f.mode === 'edit' ? `Edit delivery ${dlvEsc(f.ref)}` : 'New delivery'}</div>
      <button class="btn btn-sm" data-dlv-act="cancel-form">Cancel</button>
    </div>
    ${f.task_id ? `<div class="notice" style="margin-top:10px;">From task <b>${dlvEsc(f.task_title || '')}</b> <span class="mono small">${dlvEsc(f.task_id)}</span> — only the title is copied. The site team you tag can open the task too.</div>` : ''}
    <div class="dlv-section">What and when</div>
    <div class="row">${field('dlv-title', 'What is being delivered *', f.title, 'e.g. Tiles — 400 boxes')}${field('dlv-quantity', 'Quantity', f.quantity, 'e.g. 400 boxes / 50 bags')}</div>
    <div class="row">
      <div class="col"><label for="dlv-date">Delivery date *</label><input type="date" id="dlv-date" value="${dlvEsc(f.expected_date || '')}"></div>
      <div class="col"><label for="dlv-time">Time <span class="muted small">(optional)</span></label><input type="time" id="dlv-time" value="${dlvEsc(f.expected_time || '')}"></div>
    </div>
    <div class="row">${field('dlv-project', 'Project / site', f.project, 'e.g. Mihir Amara', 'list="dlv-projects"')}${field('dlv-site', 'Where on site', f.site_location, 'e.g. Tower B store, gate 2')}</div>
    <datalist id="dlv-projects">${(projectsList || []).map(p => `<option value="${dlvEsc(p.name || p)}">`).join('')}</datalist>
    <div class="row">${field('dlv-vendor', 'Vendor / supplier', f.vendor, 'e.g. Shah Sales')}</div>

    <div class="dlv-section">Site team to receive it * <span class="muted small">— they get a notification and upload the proof</span></div>
    <div class="dlv-picked">${(f.receivers || []).length ? f.receivers.map(u => `<span class="dlv-chip">${dlvEsc(personName(u))}<button type="button" data-dlv-unpick="${dlvEsc(u)}" aria-label="Remove">✕</button></span>`).join('') : '<span class="muted small">Nobody tagged yet.</span>'}</div>
    <input type="text" id="dlv-people-search" placeholder="Search by name or department…" value="${dlvEsc(f.search || '')}" autocomplete="off">
    <div class="dlv-people">${people.filter(u => !q || `${u.name} ${u.username} ${u.team || ''}`.toLowerCase().includes(q)).slice(0, 40).map(u => `
      <label class="dlv-person"><input type="checkbox" data-dlv-pick="${dlvEsc(u.username)}" ${(f.receivers || []).includes(u.username) ? 'checked' : ''}><span><b>${dlvEsc(u.name)}</b> <span class="muted small">${dlvEsc(u.designation || '')}${u.team ? ' · ' + dlvEsc(u.team) : ''}</span></span></label>`).join('')}</div>

    <div class="dlv-section">Transport <span class="muted small">— can be filled in later. The driver does not use this app: type in their details here.</span></div>
    <div class="row">
      <div class="col"><label for="dlv-transport">Transport</label><select id="dlv-transport"><option value="">—</option>${DLV_TRANSPORT.map(t => `<option ${f.transport === t ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
      ${field('dlv-porter', 'Porter order ID', f.porter_order_id, 'e.g. CRN1234567')}
    </div>
    <div class="row">${field('dlv-ref', 'Delivery ID / challan / invoice no.', f.delivery_ref, 'e.g. DC-2291')}${field('dlv-vehicle', 'Vehicle number', f.vehicle_no, 'e.g. MH12 AB 1234')}</div>
    <div class="row">${field('dlv-driver', 'Delivery person / driver name', f.driver_name, 'e.g. Ramesh')}${field('dlv-phone', 'Driver phone number', f.driver_phone, 'e.g. 98765 43210', 'inputmode="tel"')}</div>
    <div class="row"><div class="col"><label for="dlv-desc">Notes</label><textarea id="dlv-desc" placeholder="Anything the site team should know — unloading help needed, call before arrival…">${dlvEsc(f.description || '')}</textarea></div></div>
    <div class="row"><div class="col"><label>Attachments <span class="muted small">(challan, invoice, Porter screenshot…)</span></label><input type="file" id="dlv-files" multiple>
      ${(f.files || []).length ? `<div class="small muted" style="margin-top:4px;">${f.files.map(x => dlvEsc(x.name)).join(', ')}</div>` : ''}</div></div>
    ${ui.deliveryErr ? `<div class="err">${dlvEsc(ui.deliveryErr)}</div>` : ''}
    <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;">
      <button class="btn btn-primary" data-dlv-act="save-form" ${ui.deliverySaving ? 'disabled' : ''}>${ui.deliverySaving ? 'Saving…' : (f.mode === 'edit' ? 'Save changes' : '🚚 Add to deliveries')}</button>
    </div>
  </div>`;
}

function deliveryProofHTML(d) {
  const p = ui.deliveryProof;
  if (!p || p.id !== d.id) return '';
  const stage = p.stage;
  return `<div class="dlv-proof">
    <div class="dlv-proof-title">${stage === 'delivered' ? '📦 Confirm delivery — take photos of the material at site' : '🏗️ Confirm unloading — take photos after unloading'}</div>
    <label class="btn dlv-camera">📷 Take / add photos<input type="file" id="dlv-proof-files-${d.id}" accept="image/*" capture="environment" multiple hidden></label>
    <div class="dlv-thumbs">${(p.files || []).map((f, i) => `<div class="dlv-thumb"><img src="${f.data}" alt=""><button type="button" data-dlv-proof-remove="${i}" aria-label="Remove">✕</button></div>`).join('')}</div>
    ${p.busy ? '<div class="small muted">Preparing photo…</div>' : ''}
    <label for="dlv-proof-note-${d.id}">Note <span class="muted small">(optional — e.g. quantity counted, damage)</span></label>
    <textarea id="dlv-proof-note-${d.id}" placeholder="${stage === 'delivered' ? 'e.g. 400 boxes received, 2 broken' : 'e.g. stacked in Tower B store'}">${dlvEsc(p.note || '')}</textarea>
    <div class="small muted">Each photo is stamped with the date, time and ${dlvEsc(d.ref)}.</div>
    ${p.err ? `<div class="err">${dlvEsc(p.err)}</div>` : ''}
    <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;">
      <button class="btn btn-primary" data-dlv-proof-send="${d.id}" ${p.saving || p.busy ? 'disabled' : ''}>${p.saving ? 'Uploading…' : (stage === 'delivered' ? '✓ Delivery done' : '✓ Unloading done')}</button>
      <button class="btn" data-dlv-act="proof-cancel">Cancel</button>
    </div>
  </div>`;
}

function deliveryCardHTML(d) {
  const st = DLV_STATUS[d.status] || DLV_STATUS.scheduled;
  const manage = dlvCanManage();
  const mine = dlvMine(d) || manage;
  const files = d.files || [];
  const fileBtn = (f, label) => `<button type="button" class="dlv-file" data-dlv-file="${d.id}:${f.id}" title="${dlvEsc(f.name)}">${label}</button>`;
  const proofs = (kind) => files.filter(f => f.kind === kind);
  const overdue = ['scheduled', 'dispatched'].includes(d.status) && d.expected_at && String(d.expected_at).slice(0, 10) < (typeof istDayKey === 'function' ? istDayKey(new Date().toISOString()) : '');
  const row = (k, v) => v ? `<div class="dlv-kv"><span>${k}</span><b>${v}</b></div>` : '';
  const step = (done, title, when, who, note, kind) => `<div class="dlv-step ${done ? 'done' : ''}"><div class="dlv-dot">${done ? '✓' : ''}</div><div>
      <div class="dlv-step-title">${title}</div>
      ${done ? `<div class="small muted">${dlvEsc(dlvTime(when))}${who ? ` · ${dlvEsc(personName(who))}` : ''}</div>` : ''}
      ${note ? `<div class="small">"${dlvEsc(note)}"</div>` : ''}
      ${kind && proofs(kind).length ? `<div class="dlv-files">${proofs(kind).map((f, i) => fileBtn(f, `📷 Photo ${i + 1}${f.taken_at ? ` · ${dlvEsc(dlvTime(f.taken_at))}` : ''}`)).join('')}</div>` : ''}
    </div></div>`;
  return `
  <details class="card task-row dlv-card ${st.cls}" id="delivery-card-${d.id}">
    <summary class="task-row-summary">
      <span class="task-row-chevron" aria-hidden="true"></span>
      <span class="task-row-text">
        <span class="task-row-title"><b>${dlvEsc(d.title)}</b> <span class="mono small muted">${dlvEsc(d.ref)}</span></span>
        <span class="task-row-meta">
          <span>${st.icon} ${dlvEsc(dlvWhen(d.expected_at))}</span>
          ${d.project ? `<span>📁 ${dlvEsc(d.project)}</span>` : ''}
          ${d.quantity ? `<span>${dlvEsc(d.quantity)}</span>` : ''}
          ${d.driver_name ? `<span>🧑‍✈️ ${dlvEsc(d.driver_name)}</span>` : ''}
          ${overdue ? '<span class="row-flag row-flag-bad">Late</span>' : ''}
          ${dlvMine(d) && ['scheduled', 'dispatched', 'delivered'].includes(d.status) ? '<span class="row-flag row-flag-me">Your proof needed</span>' : ''}
        </span>
      </span>
      <span class="badge dlv-badge">${dlvEsc(st.label)}</span>
    </summary>
    <div class="task-row-body">
      <div class="dlv-grid">
        ${row('Delivery date', dlvEsc(dlvWhen(d.expected_at)))}
        ${row('Vendor', dlvEsc(d.vendor || ''))}
        ${row('Where on site', dlvEsc(d.site_location || ''))}
        ${row('Transport', dlvEsc(d.transport || ''))}
        ${row('Porter order ID', d.porter_order_id ? `<span class="mono">${dlvEsc(d.porter_order_id)}</span>` : '')}
        ${row('Delivery ID / challan', d.delivery_ref ? `<span class="mono">${dlvEsc(d.delivery_ref)}</span>` : '')}
        ${row('Driver', dlvEsc(d.driver_name || ''))}
        ${row('Driver phone', d.driver_phone ? `<a href="tel:${dlvEsc(d.driver_phone.replace(/\s/g, ''))}">📞 ${dlvEsc(d.driver_phone)}</a>` : '')}
        ${row('Vehicle', d.vehicle_no ? `<span class="mono">${dlvEsc(d.vehicle_no)}</span>` : '')}
        ${row('Site team', dlvEsc((d.receivers || []).map(personName).join(', ')))}
        ${row('Added by', `${dlvEsc(d.created_by_name || personName(d.created_by))} · ${dlvEsc(dlvTime(d.created_at))}`)}
      </div>
      ${!d.driver_name && !d.vehicle_no && ['scheduled', 'dispatched'].includes(d.status) ? `<div class="small muted" style="margin-top:6px;">Driver and vehicle details not added yet${manage ? ' — tap Edit details to add them.' : '.'}</div>` : ''}
      ${d.description ? `<div class="doc-note" style="margin-top:8px;">${dlvEsc(d.description)}</div>` : ''}
      ${proofs('attachment').length ? `<div class="dlv-files" style="margin-top:8px;">${proofs('attachment').map(f => fileBtn(f, `📎 ${dlvEsc(f.name)}`)).join('')}</div>` : ''}
      ${d.task_id ? `<div style="margin-top:8px;"><button type="button" class="btn btn-sm" data-dlv-open-task="${dlvEsc(d.task_id)}">Open task ${dlvEsc(d.task_id)} ›</button></div>` : ''}
      <div class="dlv-timeline">
        ${step(true, 'Added to deliveries', d.created_at, d.created_by)}
        ${d.status === 'cancelled' ? step(true, `Cancelled — ${dlvEsc(d.cancel_reason || '')}`, d.cancelled_at, d.cancelled_by) : `
        ${step(!!d.dispatched_at || ['delivered', 'unloaded'].includes(d.status), 'On the way', d.dispatched_at, d.dispatched_by)}
        ${step(!!d.delivered_at, 'Delivered at site', d.delivered_at, d.delivered_by, d.delivered_note, 'delivery_proof')}
        ${step(!!d.unloaded_at, 'Unloaded', d.unloaded_at, d.unloaded_by, d.unloaded_note, 'unloading_proof')}`}
      </div>
      ${deliveryProofHTML(d)}
      ${ui.deliveryCancel === d.id ? `<div class="dlv-proof"><label for="dlv-cancel-reason">Why is it cancelled?</label><input type="text" id="dlv-cancel-reason" placeholder="e.g. Vendor changed, order merged"><div style="margin-top:8px;display:flex;gap:8px;"><button class="btn btn-danger btn-sm" data-dlv-cancel-confirm="${d.id}">Cancel delivery</button><button class="btn btn-sm" data-dlv-act="cancel-cancel">Keep it</button></div></div>` : ''}
      <div class="dlv-actions">
        ${mine && ['scheduled', 'dispatched'].includes(d.status) && !(ui.deliveryProof && ui.deliveryProof.id === d.id) ? `<button class="btn btn-primary btn-sm" data-dlv-proof="${d.id}:delivered">📦 Confirm delivery (photos)</button>` : ''}
        ${mine && d.status === 'delivered' && !(ui.deliveryProof && ui.deliveryProof.id === d.id) ? `<button class="btn btn-primary btn-sm" data-dlv-proof="${d.id}:unloaded">🏗️ Confirm unloading (photos)</button>` : ''}
        ${manage && d.status === 'scheduled' ? `<button class="btn btn-sm" data-dlv-dispatch="${d.id}">🚚 Mark on the way</button>` : ''}
        ${manage && !['unloaded', 'cancelled'].includes(d.status) ? `<button class="btn btn-sm" data-dlv-edit="${d.id}">✏️ Edit details</button><button class="btn btn-sm btn-danger" data-dlv-cancel="${d.id}">Cancel</button>` : ''}
      </div>
    </div>
  </details>`;
}

function renderDeliveriesView() {
  const items = deliveriesData.items || [];
  const q = (ui.deliverySearch || '').trim().toLowerCase();
  const tab = DLV_TABS.some(t => t.key === ui.deliveryTab) ? ui.deliveryTab : 'pending';
  const tabInfo = DLV_TABS.find(t => t.key === tab);
  const matchQ = d => !q || [d.title, d.ref, d.project, d.vendor, d.driver_name, d.driver_phone, d.vehicle_no, d.porter_order_id, d.delivery_ref, d.task_id].filter(Boolean).join(' ').toLowerCase().includes(q);
  const list = items.filter(d => tabInfo.match(d) && matchQ(d));
  return `
  <div class="card">
    <div class="flex-between" style="flex-wrap:wrap;gap:10px;">
      <div><div class="card-title" style="margin:0;">Deliveries</div>
        <div class="small muted">Material on its way to site. The site team tagged on a delivery confirms it with photos — first the delivery, then the unloading.${dlvCanManage() ? ' Driver details are filled in here by the purchase team — the driver does not use this app.' : ' The purchase team adds deliveries and their driver details.'}</div></div>
      ${dlvCanManage() && !ui.deliveryForm ? `<button class="btn btn-primary btn-sm" data-dlv-act="new">+ New delivery</button>` : ''}
    </div>
  </div>
  ${deliveryFormHTML()}
  <div class="card">
    <div class="task-tabs" role="tablist">${DLV_TABS.map(t => `<button class="task-tab${tab === t.key ? ' active' : ''}" data-dlv-tab="${t.key}">${t.label} <span class="task-tab-count">${items.filter(t.match).length}</span></button>`).join('')}</div>
    <input type="text" id="delivery-search" placeholder="Search by material, DLV number, driver, vehicle, Porter order ID…" value="${dlvEsc(ui.deliverySearch || '')}" style="margin:10px 0;">
    ${list.length ? list.map(deliveryCardHTML).join('') : `<div class="empty">${q ? 'No delivery matches your search.' : tab === 'pending' ? (dlvCanManage() ? 'No deliveries to receive. Open a material task and tap "🚚 Add to delivery", or add one here.' : 'Nothing to receive right now.') : 'Nothing here yet.'}</div>`}
  </div>
  ${ui.deliveryPhoto ? `<div class="dlv-viewer" data-dlv-act="close-photo"><img src="${ui.deliveryPhoto.data}" alt="${dlvEsc(ui.deliveryPhoto.name)}"><div class="dlv-viewer-bar"><span>${dlvEsc(ui.deliveryPhoto.name)}</span><button class="btn btn-sm" data-dlv-act="download-photo">Download</button><button class="btn btn-sm" data-dlv-act="close-photo">Close</button></div></div>` : ''}`;
}

// Writes the date/time, delivery number and person onto the photo itself — proof that survives a download.
function dlvStampPhoto(dataUrl, text) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
        const g = c.getContext('2d'); g.drawImage(img, 0, 0);
        const fs = Math.max(14, Math.round(img.width / 34)); const pad = Math.round(fs * 0.6);
        g.font = `700 ${fs}px sans-serif`;
        const bandH = fs + pad * 2;
        g.fillStyle = 'rgba(0,0,0,0.6)'; g.fillRect(0, img.height - bandH, img.width, bandH);
        g.fillStyle = '#fff'; g.textBaseline = 'middle'; g.fillText(text, pad, img.height - bandH / 2, img.width - pad * 2);
        resolve(c.toDataURL('image/jpeg', 0.8));
      } catch (e) { resolve(dataUrl); }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

function bindDeliveriesView() {
  const act = (name, fn) => document.querySelectorAll(`[data-dlv-act="${name}"]`).forEach(el => el.onclick = (e) => { e.preventDefault(); e.stopPropagation(); fn(el); });
  act('new', () => { ui.deliveryForm = { mode: 'new', title: '', receivers: [], files: [], search: '' }; ui.deliveryErr = ''; render(); });
  act('cancel-form', () => { ui.deliveryForm = null; ui.deliveryErr = ''; render(); });
  act('proof-cancel', () => { ui.deliveryProof = null; render(); });
  act('cancel-cancel', () => { ui.deliveryCancel = null; render(); });
  act('close-photo', () => { ui.deliveryPhoto = null; render(); });
  act('download-photo', () => { const p = ui.deliveryPhoto; if (p) downloadDataUrl(p.data, p.name); });
  document.querySelectorAll('[data-dlv-tab]').forEach(b => b.onclick = () => { ui.deliveryTab = b.dataset.dlvTab; render(); });
  const search = document.getElementById('delivery-search');
  if (search) search.oninput = () => { ui.deliverySearch = search.value; clearTimeout(window.__dlvSearchT); window.__dlvSearchT = setTimeout(render, 250); };
  document.querySelectorAll('[data-dlv-open-task]').forEach(b => b.onclick = () => openTaskOnMyTasks(b.dataset.dlvOpenTask));

  // ---- form
  const f = ui.deliveryForm;
  if (f) {
    const keep = () => {
      const v = id => { const el = document.getElementById(id); return el ? el.value : undefined; };
      const map = { title: 'dlv-title', quantity: 'dlv-quantity', expected_date: 'dlv-date', expected_time: 'dlv-time', project: 'dlv-project', site_location: 'dlv-site',
        vendor: 'dlv-vendor', transport: 'dlv-transport', porter_order_id: 'dlv-porter', delivery_ref: 'dlv-ref', vehicle_no: 'dlv-vehicle', driver_name: 'dlv-driver', driver_phone: 'dlv-phone', description: 'dlv-desc' };
      for (const [k, id] of Object.entries(map)) { const x = v(id); if (x !== undefined) f[k] = x; }
    };
    document.querySelectorAll('#delivery-form input[type="text"], #delivery-form input[type="date"], #delivery-form input[type="time"], #delivery-form textarea, #delivery-form select').forEach(el => {
      if (el.id === 'dlv-people-search') return;
      el.addEventListener('input', keep); el.addEventListener('change', keep);
    });
    const ps = document.getElementById('dlv-people-search');
    if (ps) ps.oninput = () => { keep(); f.search = ps.value; render(); const n = document.getElementById('dlv-people-search'); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } };
    document.querySelectorAll('[data-dlv-pick]').forEach(cb => cb.onchange = () => { keep(); const u = cb.dataset.dlvPick; const s = new Set(f.receivers || []); if (cb.checked) s.add(u); else s.delete(u); f.receivers = [...s]; render(); });
    document.querySelectorAll('[data-dlv-unpick]').forEach(b => b.onclick = () => { keep(); f.receivers = (f.receivers || []).filter(u => u !== b.dataset.dlvUnpick); render(); });
    const fileIn = document.getElementById('dlv-files');
    if (fileIn) fileIn.onchange = () => {
      keep(); const list = Array.from(fileIn.files || []).slice(0, 10); f.files = []; let left = list.length; if (!left) { render(); return; }
      list.forEach(file => readAnyFile(file, data => { if (data) f.files.push({ name: file.name, data }); if (--left === 0) render(); }));
    };
    act('save-form', async (btn) => {
      keep();
      if (ui.deliverySaving) return;
      if (!String(f.title || '').trim()) { ui.deliveryErr = 'Write what is being delivered.'; render(); return; }
      if (!f.expected_date) { ui.deliveryErr = 'Pick the delivery date (time is optional).'; render(); return; }
      if (!(f.receivers || []).length) { ui.deliveryErr = 'Tag at least one person on site who will receive it.'; render(); return; }
      const body = { title: f.title, quantity: f.quantity, project: f.project, site_location: f.site_location, vendor: f.vendor, transport: f.transport,
        porter_order_id: f.porter_order_id, delivery_ref: f.delivery_ref, vehicle_no: f.vehicle_no, driver_name: f.driver_name, driver_phone: f.driver_phone,
        description: f.description, expected_at: f.expected_date + (f.expected_time ? `T${f.expected_time}` : ''), receivers: f.receivers,
        attachments: (f.files || []).map(x => ({ name: x.name, data: x.data })) };
      if (f.mode === 'new' && f.task_id) body.task_id = f.task_id;
      ui.deliverySaving = true; ui.deliveryErr = ''; render();
      try {
        const r = f.mode === 'edit'
          ? await api(`/api/deliveries/${f.id}/update`, { method: 'POST', body: JSON.stringify(body) })
          : await api('/api/deliveries', { method: 'POST', body: JSON.stringify(body) });
        const id = f.mode === 'edit' ? f.id : r.id;
        ui.deliveryForm = null; ui.deliverySaving = false;
        setBanner(f.mode === 'edit' ? 'Delivery updated — the site team has been told about any new details.' : `Added to deliveries as ${r.ref}. The site team has been notified.`, 'ok');
        await refreshData();
        openDeliveryOnPage(id);
      } catch (e) { ui.deliverySaving = false; ui.deliveryErr = e.message; render(); }
    });
  }

  // ---- card actions
  document.querySelectorAll('[data-dlv-edit]').forEach(b => b.onclick = (e) => {
    e.preventDefault();
    const d = (deliveriesData.items || []).find(x => x.id === Number(b.dataset.dlvEdit)); if (!d) return;
    const [date, time] = String(d.expected_at || '').split('T');
    ui.deliveryForm = { mode: 'edit', id: d.id, ref: d.ref, title: d.title, quantity: d.quantity, project: d.project, site_location: d.site_location, vendor: d.vendor, transport: d.transport || '',
      porter_order_id: d.porter_order_id, delivery_ref: d.delivery_ref, vehicle_no: d.vehicle_no, driver_name: d.driver_name, driver_phone: d.driver_phone, description: d.description,
      expected_date: date || '', expected_time: time || '', receivers: (d.receivers || []).slice(), files: [], search: '' };
    ui.deliveryErr = ''; render(); window.scrollTo(0, 0);
  });
  document.querySelectorAll('[data-dlv-dispatch]').forEach(b => b.onclick = async () => {
    if (b.disabled) return; b.disabled = true;
    try { await api(`/api/deliveries/${b.dataset.dlvDispatch}/status`, { method: 'POST', body: JSON.stringify({ status: 'dispatched' }) }); setBanner('Marked as on the way — the site team has been told.', 'ok'); await refreshData(); }
    catch (e) { b.disabled = false; setBanner(e.message); render(); }
  });
  document.querySelectorAll('[data-dlv-cancel]').forEach(b => b.onclick = () => { ui.deliveryCancel = Number(b.dataset.dlvCancel); render(); const el = document.getElementById('dlv-cancel-reason'); if (el) el.focus(); });
  document.querySelectorAll('[data-dlv-cancel-confirm]').forEach(b => b.onclick = async () => {
    const reason = (document.getElementById('dlv-cancel-reason') || {}).value || '';
    if (reason.trim().length < 3) { setBanner('Write why it is cancelled.'); render(); return; }
    if (b.disabled) return; b.disabled = true;
    try { await api(`/api/deliveries/${b.dataset.dlvCancelConfirm}/status`, { method: 'POST', body: JSON.stringify({ status: 'cancelled', reason }) }); ui.deliveryCancel = null; setBanner('Delivery cancelled.', 'ok'); await refreshData(); }
    catch (e) { b.disabled = false; setBanner(e.message); render(); }
  });
  document.querySelectorAll('[data-dlv-file]').forEach(b => b.onclick = async (e) => {
    e.preventDefault(); e.stopPropagation();
    const [did, fid] = b.dataset.dlvFile.split(':');
    try {
      const r = await api(`/api/deliveries/${did}/files/${fid}`);
      if (/^data:image\//i.test(r.data)) { ui.deliveryPhoto = { data: r.data, name: r.name }; render(); } else downloadDataUrl(r.data, r.name);
    } catch (err) { setBanner(err.message); render(); }
  });

  // ---- proof
  document.querySelectorAll('[data-dlv-proof]').forEach(b => b.onclick = () => {
    const [id, stage] = b.dataset.dlvProof.split(':');
    ui.deliveryProof = { id: Number(id), stage, files: [], note: '', err: '' }; render();
  });
  const p = ui.deliveryProof;
  if (p) {
    const d = (deliveriesData.items || []).find(x => x.id === p.id);
    const note = document.getElementById(`dlv-proof-note-${p.id}`);
    if (note) note.oninput = () => { p.note = note.value; };
    const input = document.getElementById(`dlv-proof-files-${p.id}`);
    if (input) input.onchange = () => {
      const list = Array.from(input.files || []).slice(0, 10 - (p.files || []).length); if (!list.length) return;
      p.busy = true; p.err = ''; render(); let left = list.length;
      list.forEach(file => readAnyFile(file, async (data) => {
        if (data && /^data:image\//i.test(data)) {
          const now = new Date();
          const stamp = `${now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })} · ${d ? d.ref : ''} · ${p.stage === 'delivered' ? 'Delivered' : 'Unloaded'} · ${session.name}`;
          const stamped = await dlvStampPhoto(data, stamp);
          p.files.push({ name: `${d ? d.ref : 'delivery'}-${p.stage}-${p.files.length + 1}.jpg`, data: stamped, taken_at: now.toISOString() });
        } else if (data) p.err = 'Only photos can be used as proof.';
        if (--left === 0) { p.busy = false; render(); }
      }));
    };
    document.querySelectorAll('[data-dlv-proof-remove]').forEach(b => b.onclick = () => { p.files.splice(Number(b.dataset.dlvProofRemove), 1); render(); });
    document.querySelectorAll('[data-dlv-proof-send]').forEach(b => b.onclick = async () => {
      if (p.saving) return;
      if (!p.files.length) { p.err = 'Add at least one photo as proof.'; render(); return; }
      p.saving = true; p.err = ''; render();
      try {
        await api(`/api/deliveries/${p.id}/proof`, { method: 'POST', body: JSON.stringify({ stage: p.stage, note: p.note, attachments: p.files.map(x => ({ name: x.name, data: x.data })), takenAt: p.files.map(x => x.taken_at) }) });
        const stage = p.stage; ui.deliveryProof = null;
        setBanner(stage === 'delivered' ? 'Delivery confirmed with photos. Next: confirm the unloading.' : 'Unloading confirmed — everyone has been told.', 'ok');
        await refreshData(); openDeliveryOnPage(p.id);
      } catch (e) { p.saving = false; p.err = e.message; render(); }
    });
  }
}
