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
  { key: 'docs', label: 'Documents pending', match: d => dlvMissingDocs(d).length > 0 },
];
const DLV_TRANSPORT = ['Porter', 'Vendor vehicle', 'Own vehicle', 'Courier', 'Other'];
// Fallbacks — the server sends the same lists with the deliveries.
const DLV_DOC_TYPES_FALLBACK = [
  { key: 'challan', label: 'Delivery challan', dir: 'to_site' }, { key: 'po', label: 'Purchase order', dir: 'to_site' },
  { key: 'invoice', label: 'Vendor invoice / bill', dir: 'to_site' }, { key: 'eway', label: 'E-way bill', dir: 'to_site' },
  { key: 'transport_booking', label: 'Porter / transport booking', dir: 'to_site' }, { key: 'other_to_site', label: 'Other document', dir: 'to_site' },
  { key: 'signed_challan', label: 'Signed / stamped challan', dir: 'from_site' }, { key: 'grn', label: 'Material inward / GRN', dir: 'from_site' },
  { key: 'received_invoice', label: 'Invoice received with material', dir: 'from_site' }, { key: 'weighbridge', label: 'Weighbridge slip', dir: 'from_site' },
  { key: 'damage_report', label: 'Shortage / damage report', dir: 'from_site' }, { key: 'other_from_site', label: 'Other document', dir: 'from_site' },
];
function dlvDocTypes() { return deliveriesData.docTypes && deliveriesData.docTypes.length ? deliveriesData.docTypes : DLV_DOC_TYPES_FALLBACK; }
function dlvDoc(k) { return dlvDocTypes().find(t => t.key === k); }
function dlvDefaultRequired() { return deliveriesData.defaultRequired || ['challan', 'signed_challan']; }
function dlvPayPurposes() { return deliveriesData.payPurposes || ['Porter / transport fare', 'Unloading labour', 'Loading labour', 'Toll / parking', 'Other']; }
function dlvPayModes() { return deliveriesData.payModes || ['Cash', 'UPI', 'Bank transfer', 'Other']; }
function dlvInr(n) { return n == null ? '—' : '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 }); }
// Required documents not uploaded yet, by direction.
function dlvDocsPresent(d) { return new Set((d.files || []).filter(f => f.kind === 'document').map(f => f.doc_type)); }
function dlvMissingDocs(d, dir) {
  if (d.status === 'cancelled') return [];
  const have = dlvDocsPresent(d);
  return (d.required_docs || []).filter(k => dlvDoc(k) && (!dir || dlvDoc(k).dir === dir) && !have.has(k));
}

// ---- Sounds: a ring when a delivery is placed, a "your package is delivered" chime when it arrives.
// Played for the person who does it and for the people notified about it (new notifications only).
// Every other new notification plays a short notification tone; announcements play a cheerful chime.
const DLV_SOUND_FILES = { placed: '/sounds/delivery-placed.mp3', delivered: '/sounds/delivered.mp3', notification: '/sounds/notification.mp3', announcement: '/sounds/announcement.mp3' };
const DLV_SOUND_FOR_TYPE = { delivery_scheduled: 'placed', delivery_delivered: 'delivered', announcement: 'announcement' };
const dlvSoundKind = (n) => DLV_SOUND_FOR_TYPE[n.type] || 'notification';
const dlvSoundCache = {};
let dlvLastNotifId = null;
// Browsers block sounds until the person has clicked on the page once — load and unlock them on the first click / tap,
// so a notification arriving later (even with the tab in the background) can ring.
(function () {
  const unlock = () => {
    document.removeEventListener('pointerdown', unlock, true); document.removeEventListener('keydown', unlock, true);
    for (const k of Object.keys(DLV_SOUND_FILES)) {
      try { const a = dlvSoundCache[k] || (dlvSoundCache[k] = new Audio(DLV_SOUND_FILES[k])); a.muted = true; const p = a.play(); if (p && p.then) p.then(() => { a.pause(); a.currentTime = 0; a.muted = false; }).catch(() => { a.muted = false; }); else a.muted = false; } catch (e) {}
    }
  };
  document.addEventListener('pointerdown', unlock, true); document.addEventListener('keydown', unlock, true);
})();
function dlvSoundOn() { try { return safeStorage.getItem('ls_dlv_sound') !== 'off'; } catch (e) { return true; } }
function dlvPlaySound(kind) {
  if (!dlvSoundOn() || !DLV_SOUND_FILES[kind]) return;
  try {
    const a = dlvSoundCache[kind] || (dlvSoundCache[kind] = new Audio(DLV_SOUND_FILES[kind]));
    a.currentTime = 0; const p = a.play(); if (p && p.catch) p.catch(() => {}); // browsers may block sound before the first tap
  } catch (e) {}
}
// Called whenever the notification list is refreshed: rings once for each new delivery notification.
function dlvSoundsForNotifications(items) {
  const list = Array.isArray(items) ? items : [];
  const maxId = list.reduce((m, n) => Math.max(m, Number(n.id) || 0), 0);
  if (dlvLastNotifId === null) {
    let saved = 0; try { saved = Number(safeStorage.getItem('ls_dlv_sound_last:' + (session && session.username)) || 0); } catch (e) {}
    dlvLastNotifId = saved || maxId; // first load after login: nothing old rings
  }
  const fresh = list.filter(n => Number(n.id) > dlvLastNotifId && !Number(n.read));
  if (maxId > dlvLastNotifId) { dlvLastNotifId = maxId; try { safeStorage.setItem('ls_dlv_sound_last:' + (session && session.username), String(maxId)); } catch (e) {} }
  const kinds = new Set(fresh.map(dlvSoundKind));
  const kind = ['announcement', 'delivered', 'placed', 'notification'].find(k => kinds.has(k)) || null;
  if (kind) dlvPlaySound(kind);
}

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
// Menu badge: for the purchase team, every delivery not yet unloaded; for the site team, the ones waiting for their proof.
function deliveriesNeedingMeCount() {
  const open = d => ['scheduled', 'dispatched', 'delivered'].includes(d.status);
  return (deliveriesData.items || []).filter(d => open(d) && (dlvCanManage() || dlvMine(d))).length;
}
function deliveriesForTask(taskId) { return (deliveriesData.items || []).filter(d => d.task_id === taskId); }

// From a task: open the form with only the title copied (and the project, and the task link).
// Vendor suggestion for the purchase team (the field still accepts any vendor).
function dlvVendorSuggestions() { return ['Kratex Tradetech India']; }
function openDeliveryFromTask(t) {
  // People who submitted their part but were not approved yet — warned about on the form.
  const pendingParts = (t.assignees || []).filter(a => a.submitted_at && !(a.decision === 'approve' && a.completed_at)).map(a => a.username);
  ui.deliveryForm = { mode: 'new', task_id: t.id, task_title: t.title, title: t.title, project: t.project || '', expected_date: '', expected_time: '', receivers: [], files: [], transport: '', search: '', pendingParts };
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
    ${f.task_id ? `<div class="notice" style="margin-top:10px;">From task <b>${dlvEsc(f.task_title || '')}</b> <span class="mono small">${dlvEsc(f.task_id)}</span> — only the title is copied.
      <b>The task will be closed</b> (its work is done) and from now on only this delivery is tracked — the site team you tag, not the people who did the task. The site team can still open the task.</div>
      ${(f.pendingParts || []).length ? `<div class="notice dlv-warn" style="margin-top:8px;">⚠ Still waiting for approval on the task: <b>${f.pendingParts.map(u => dlvEsc(personName(u))).join(', ')}</b>. Closing the task means their part will not count as approved work — approve them on the task first if they should get credit.</div>` : ''}` : ''}
    ${f.limited ? `<div class="notice" style="margin-top:10px;">This delivery is already unloaded — only its documents list can still be changed.</div>` : `
    <div class="dlv-section">What and when</div>
    <div class="row">${field('dlv-title', 'What is being delivered *', f.title, 'e.g. Tiles — 400 boxes')}${field('dlv-quantity', 'Quantity', f.quantity, 'e.g. 400 boxes / 50 bags')}</div>
    <div class="row">
      <div class="col"><label for="dlv-date">Delivery date *</label><input type="date" id="dlv-date" value="${dlvEsc(f.expected_date || '')}"></div>
      <div class="col"><label for="dlv-time">Time <span class="muted small">(optional)</span></label><input type="time" id="dlv-time" value="${dlvEsc(f.expected_time || '')}"></div>
    </div>
    <div class="row">${field('dlv-project', 'Project / site', f.project, 'e.g. Mihir Amara', 'list="dlv-projects"')}${field('dlv-site', 'Where on site', f.site_location, 'e.g. Tower B store, gate 2')}</div>
    <datalist id="dlv-projects">${(typeof PROJECT_OPTIONS !== 'undefined' ? PROJECT_OPTIONS : (projectsList || [])).map(p => `<option value="${dlvEsc(p.name || p)}">`).join('')}</datalist>
    <div class="row">${field('dlv-vendor', 'Vendor / supplier', f.vendor, 'e.g. Kratex Tradetech India', 'list="dlv-vendors"')}</div>
    <datalist id="dlv-vendors">${dlvVendorSuggestions().map(v => `<option value="${dlvEsc(v)}">`).join('')}</datalist>

    <div class="dlv-section">Site team to receive it * <span class="muted small">— they get a notification and upload the proof</span></div>
    <div class="dlv-picked">${(f.receivers || []).length ? f.receivers.map(u => `<span class="dlv-chip">${dlvEsc(personName(u))}<button type="button" data-dlv-unpick="${dlvEsc(u)}" aria-label="Remove">✕</button></span>`).join('') : '<span class="muted small">Nobody tagged yet.</span>'}</div>
    <input type="text" id="dlv-people-search" placeholder="Search by name or department…" value="${dlvEsc(f.search || '')}" autocomplete="off">
    <div class="dlv-people">${people.filter(u => !q || `${u.name} ${u.username} ${u.team || ''}`.toLowerCase().includes(q)).map(u => `
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
      ${(f.files || []).length ? `<div class="small muted" style="margin-top:4px;">${f.files.map(x => dlvEsc(x.name)).join(', ')}</div>` : ''}</div></div>`}
    ${dlvBudgetDocsFormHTML(f)}
    ${ui.deliveryErr ? `<div class="err">${dlvEsc(ui.deliveryErr)}</div>` : ''}
    <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;">
      <button class="btn btn-primary" data-dlv-act="save-form" ${ui.deliverySaving ? 'disabled' : ''}>${ui.deliverySaving ? 'Saving…' : (f.mode === 'edit' ? 'Save changes' : '🚚 Add to deliveries')}</button>
    </div>
  </div>`;
}

function dlvBudgetDocsFormHTML(f) {
  const req = new Set(f.required_docs || dlvDefaultRequired());
  const group = (dir, title) => `<div class="dlv-reqgroup"><div class="small"><b>${title}</b></div>${dlvDocTypes().filter(t => t.dir === dir).map(t => `
    <label class="dlv-reqdoc"><input type="checkbox" data-dlv-reqdoc="${t.key}" ${req.has(t.key) ? 'checked' : ''}> ${dlvEsc(t.label)}</label>`).join('')}</div>`;
  return `
    <div class="dlv-section">Documents <span class="muted small">— tick the ones that must be there. Unticked ones are optional: they can still be uploaded.</span></div>
    <div class="dlv-reqgroups">${group('to_site', '📤 Sent to site (by purchase)')}${group('from_site', '📥 From site to head office')}</div>`;
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
          ${dlvMissingDocs(d).length ? `<span class="row-flag dlv-flag-docs">📄 ${dlvMissingDocs(d).length} document${dlvMissingDocs(d).length > 1 ? 's' : ''} pending</span>` : ''}
          ${d.paid ? `<span>💰 ${dlvInr(d.paid)} paid</span>` : ''}
        </span>
      </span>
      <span class="badge dlv-badge">${dlvEsc(st.label)}</span>
    </summary>
    <div class="task-row-body">
      ${dlvCardTabsHTML(d)}
      ${dlvCardTab(d) === 'docs' ? dlvDocsHTML(d) : dlvCardTab(d) === 'money' ? dlvMoneyHTML(d) : `
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
      ${d.last_followup_at ? `<div class="dlv-fu-note">📣 Followed up by <b>${dlvEsc(personName(d.last_followup_by))}</b> · ${dlvEsc(dlvTime(d.last_followup_at))}${d.followup_count > 1 ? ` · ${d.followup_count} times` : ''}${dlvMine(d) && ['scheduled', 'dispatched', 'delivered'].includes(d.status) ? ' — please update this delivery.' : ''}</div>` : ''}
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
        ${manage && ['delivered', 'unloaded'].includes(d.status) && typeof openBillFromDelivery === 'function' ? `<button class="btn btn-sm" data-dlv-bill="${d.id}" title="Send the vendor bill for this delivery to Accounts, with the credit period">💳 Send bill to Accounts</button>` : ''}
        ${manage && ['scheduled', 'dispatched', 'delivered'].includes(d.status) ? `<button class="btn btn-sm dlv-fu ${d.last_followup_at ? 'done' : ''}" data-dlv-followup="${d.id}" title="Remind the site team to update this delivery">📣 ${d.last_followup_at ? 'Follow up again' : 'Follow up'}</button>` : ''}
        ${manage && d.status === 'scheduled' ? `<button class="btn btn-sm" data-dlv-dispatch="${d.id}">🚚 Mark on the way</button>` : ''}
        ${manage && !['unloaded', 'cancelled'].includes(d.status) ? `<button class="btn btn-sm" data-dlv-edit="${d.id}">✏️ Edit details</button><button class="btn btn-sm btn-danger" data-dlv-cancel="${d.id}">Cancel</button>` : ''}
        ${manage && d.status === 'unloaded' ? `<button class="btn btn-sm" data-dlv-edit="${d.id}">✏️ Edit documents list</button>` : ''}
        ${manage && ui.deliveryDelete !== d.id ? `<button class="btn btn-sm btn-danger" data-dlv-delete="${d.id}">🗑 Delete</button>` : ''}
      </div>
      `}
      ${ui.deliveryDelete === d.id ? `<div class="dlv-proof dlv-delete-box">
        <div><b>Delete ${dlvEsc(d.ref)}?</b> The delivery, its photos and attachments are removed for everyone. This cannot be undone.</div>
        ${d.task_id && d.closed_task && d.task_status === 'closed' ? `<label class="small" style="display:flex;gap:8px;align-items:center;margin-top:8px;"><input type="checkbox" id="dlv-delete-reopen" checked> Re-open task ${dlvEsc(d.task_id)} (it was closed when it was added to Deliveries)</label>` : ''}
        <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;"><button class="btn btn-danger btn-sm" data-dlv-delete-confirm="${d.id}">Yes, delete</button><button class="btn btn-sm" data-dlv-act="delete-cancel">Keep it</button></div>
      </div>` : ''}
    </div>
  </details>`;
}

// ---- In-card tabs: Details · Documents · Budget & payments
function dlvCardTab(d) { const t = (ui.dlvCardTab || {})[d.id]; return ['details', 'docs', 'money'].includes(t) ? t : 'details'; }
function dlvCardTabsHTML(d) {
  const tab = dlvCardTab(d);
  const req = (d.required_docs || []).filter(k => dlvDoc(k));
  const have = dlvDocsPresent(d);
  const docCount = `${req.filter(k => have.has(k)).length}/${req.length}`;
  const b = (k, label, extra = '') => `<button type="button" class="dlv-ctab${tab === k ? ' active' : ''}" data-dlv-ctab="${d.id}:${k}">${label}${extra}</button>`;
  return `<div class="dlv-ctabs" role="tablist">
    ${b('details', '🚚 Details')}
    ${b('docs', '📄 Documents', ` <span class="dlv-ctab-count ${dlvMissingDocs(d).length ? 'warn' : 'ok'}">${docCount}</span>`)}
    ${b('money', '💰 Payments', (d.payments || []).length ? ` <span class="dlv-ctab-count">${dlvInr(d.paid)}</span>` : '')}
  </div>`;
}
function dlvCanUploadDir(d, dir) { return d.status !== 'cancelled' && (dlvCanManage() || (dir === 'from_site' && dlvMine(d))); }
function dlvDocsHTML(d) {
  const docs = (d.files || []).filter(f => f.kind === 'document');
  const req = new Set(d.required_docs || []);
  const sub = ['to_site', 'from_site'].includes((ui.dlvDocDir || {})[d.id]) ? ui.dlvDocDir[d.id] : (dlvMine(d) && !dlvCanManage() ? 'from_site' : 'to_site');
  const types = dlvDocTypes().filter(t => t.dir === sub);
  const shown = types.filter(t => req.has(t.key) || docs.some(f => f.doc_type === t.key));
  const canUp = dlvCanUploadDir(d, sub);
  const canDel = f => f.uploaded_by === session.username || dlvCanManage();
  const form = ui.dlvDoc && ui.dlvDoc.id === d.id && ui.dlvDoc.dir === sub ? ui.dlvDoc : null;
  const missingIn = dir => dlvMissingDocs(d, dir).length;
  const item = t => {
    const fs = docs.filter(f => f.doc_type === t.key);
    return `<div class="dlv-doc ${fs.length ? 'have' : (req.has(t.key) ? 'missing' : '')}">
      <div class="dlv-doc-head"><span class="dlv-doc-state">${fs.length ? '✓' : (req.has(t.key) ? '⏳' : '·')}</span>
        <b>${dlvEsc(t.label)}</b> <span class="dlv-req ${req.has(t.key) ? 'need' : ''}">${req.has(t.key) ? 'Required' : 'Optional'}</span>
        ${!fs.length && req.has(t.key) ? `<span class="small muted">— not uploaded yet</span>` : ''}
        ${!fs.length && canUp && !form ? `<button type="button" class="btn btn-sm" data-dlv-doc-new="${d.id}:${sub}:${t.key}">⬆ Upload</button>` : ''}</div>
      ${fs.map(f => `<div class="dlv-doc-file">${`<button type="button" class="dlv-file" data-dlv-file="${d.id}:${f.id}" title="${dlvEsc(f.name)}">📎 ${dlvEsc(f.name)}</button>`}
        <span class="small muted">${dlvEsc(personName(f.uploaded_by))} · ${dlvEsc(dlvTime(f.created_at))}</span>
        ${f.note ? `<span class="small">"${dlvEsc(f.note)}"</span>` : ''}
        ${canDel(f) ? `<button type="button" class="dlv-x" data-dlv-file-del="${d.id}:${f.id}" title="Remove this file" aria-label="Remove">✕</button>` : ''}</div>`).join('')}
    </div>`;
  };
  return `<div class="dlv-docs">
    <div class="dlv-subtabs">
      <button type="button" class="dlv-subtab${sub === 'to_site' ? ' active' : ''}" data-dlv-docdir="${d.id}:to_site">📤 Sent to site ${missingIn('to_site') ? `<span class="dlv-ctab-count warn">${missingIn('to_site')} pending</span>` : ''}</button>
      <button type="button" class="dlv-subtab${sub === 'from_site' ? ' active' : ''}" data-dlv-docdir="${d.id}:from_site">📥 From site to head office ${missingIn('from_site') ? `<span class="dlv-ctab-count warn">${missingIn('from_site')} pending</span>` : ''}</button>
    </div>
    <div class="small muted" style="margin:6px 0 8px;">${sub === 'to_site' ? 'Papers the purchase team sends with the material — the site team can open, download and print them.' : 'Papers the site team sends back to head office after receiving the material. Take a clear photo or attach the PDF.'}</div>
    ${shown.length ? shown.map(item).join('') : '<div class="empty" style="padding:10px;">No documents needed here. Optional ones can still be uploaded.</div>'}
    ${form ? dlvDocFormHTML(d, form, types) : (canUp ? `<button type="button" class="btn btn-sm" style="margin-top:8px;" data-dlv-doc-new="${d.id}:${sub}:">+ Upload ${shown.length ? 'another' : 'a'} document</button>` : (sub === 'to_site' ? '' : '<div class="small muted" style="margin-top:6px;">Only the site team tagged on this delivery uploads these.</div>'))}
  </div>`;
}
function dlvDocFormHTML(d, f, types) {
  const req = new Set(d.required_docs || []);
  return `<div class="dlv-proof">
    <label for="dlv-doc-type">Which document?</label>
    <select id="dlv-doc-type">${types.map(t => `<option value="${t.key}" ${f.type === t.key ? 'selected' : ''}>${dlvEsc(t.label)}${req.has(t.key) ? ' (required)' : ' (optional)'}</option>`).join('')}</select>
    <label class="btn dlv-camera" style="margin-top:8px;">📷 Photo / 📎 file<input type="file" id="dlv-doc-files" accept="image/*,application/pdf,.pdf,.doc,.docx,.xls,.xlsx" multiple hidden></label>
    <div class="dlv-thumbs">${(f.files || []).map((x, i) => `<div class="dlv-thumb">${/^data:image\//.test(x.data) ? `<img src="${x.data}" alt="">` : `<span class="dlv-thumb-file">📎 ${dlvEsc(x.name)}</span>`}<button type="button" data-dlv-doc-remove="${i}" aria-label="Remove">✕</button></div>`).join('')}</div>
    ${f.busy ? '<div class="small muted">Preparing…</div>' : ''}
    <label for="dlv-doc-note">Note <span class="muted small">(optional)</span></label>
    <input type="text" id="dlv-doc-note" value="${dlvEsc(f.note || '')}" placeholder="e.g. challan no. 2291, signed by store keeper">
    ${f.err ? `<div class="err">${dlvEsc(f.err)}</div>` : ''}
    <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;">
      <button class="btn btn-primary btn-sm" data-dlv-doc-send="${d.id}" ${f.saving || f.busy ? 'disabled' : ''}>${f.saving ? 'Uploading…' : (f.dir === 'to_site' ? '📤 Send to site' : '📥 Send to head office')}</button>
      <button class="btn btn-sm" data-dlv-act="doc-cancel">Cancel</button>
    </div>
  </div>`;
}
function dlvMoneyHTML(d) {
  const manage = dlvCanManage();
  const canPay = d.status !== 'cancelled' && (manage || dlvMine(d));
  const pays = d.payments || [];
  const form = ui.dlvPay && ui.dlvPay.id === d.id ? ui.dlvPay : null;
  const canDel = p => (typeof budgetData !== 'undefined' && budgetData.canAllot) || ((p.verify_status || 'pending') !== 'verified' && (manage || (p.paid_by === session.username && Date.now() - new Date(p.created_at).getTime() < 48 * 3600000)));
  const stChip = p => typeof budChip === 'function' ? budChip(p.verify_status || 'pending') : '';
  return `<div class="dlv-money">
    <div class="small muted">Porter / transport / unloading money paid for this delivery. It comes out of the payer's allotted money in <b>Budget</b>, where the Director verifies each bill. <button type="button" class="linkish" data-dlv-act="open-budget">Open Budget ›</button></div>
    <div class="dlv-section" style="margin-top:12px;">Payments ${pays.length ? `<span class="muted small">(${pays.length})</span>` : ''}</div>
    ${pays.length ? `<div class="dlv-perf-wrap"><table class="dlv-perf dlv-pays"><thead><tr><th>Date</th><th>For</th><th>Paid to</th><th>Mode</th><th>By</th><th style="text-align:right;">Amount</th><th>Bill</th><th>Status</th><th></th></tr></thead><tbody>
      ${pays.map(p => `<tr class="${p.verify_status === 'rejected' ? 'bud-row-rej' : ''}"><td>${dlvEsc(dlvWhen(p.paid_at))}</td><td>${dlvEsc(p.purpose)}${p.note ? `<div class="small muted">${dlvEsc(p.note)}</div>` : ''}</td><td>${dlvEsc(p.paid_to || '—')}</td><td>${dlvEsc(p.mode || '—')}</td>
        <td>${dlvEsc(p.paid_by_name || personName(p.paid_by))}</td><td style="text-align:right;"><b>${dlvInr(p.amount)}</b></td>
        <td>${(p.bills || []).length ? p.bills.map((f, i) => `<button type="button" class="dlv-file" data-dlv-file="${d.id}:${f.id}">🧾 ${p.bills.length > 1 ? i + 1 : 'Bill'}</button>`).join(' ') : `<span class="dlv-nobill" title="${dlvEsc(p.no_bill_reason || '')}">No bill${p.no_bill_reason ? ` — ${dlvEsc(p.no_bill_reason)}` : ''}</span>`}</td>
        <td>${stChip(p)}</td>
        <td>${canDel(p) ? `<button type="button" class="dlv-x" data-dlv-pay-del="${d.id}:${p.id}" title="Remove this payment" aria-label="Remove">✕</button>` : ''}</td></tr>`).join('')}
      <tr class="dlv-total"><td colspan="5">Total paid${pays.some(p => p.verify_status === 'rejected') ? ' (not counting “not accepted”)' : ''}</td><td style="text-align:right;"><b>${dlvInr(d.paid)}</b></td><td colspan="3"></td></tr>
    </tbody></table></div>` : '<div class="empty" style="padding:10px;">No payments recorded yet.</div>'}
    ${form ? dlvPayFormHTML(d, form) : (canPay ? `<button type="button" class="btn btn-primary btn-sm" style="margin-top:8px;" data-dlv-pay-new="${d.id}">+ Record a payment</button>` : '')}
  </div>`;
}
function dlvPayFormHTML(d, f) {
  return `<div class="dlv-proof">
    <div class="dlv-proof-title">💰 Record a payment for ${dlvEsc(d.ref)}</div>
    <div class="row">
      <div class="col"><label for="dlv-pay-amount">Amount paid (₹) *</label><input type="number" id="dlv-pay-amount" min="1" step="1" inputmode="decimal" value="${dlvEsc(f.amount || '')}" placeholder="e.g. 850"></div>
      <div class="col"><label for="dlv-pay-purpose">For *</label><select id="dlv-pay-purpose">${dlvPayPurposes().map(x => `<option ${f.purpose === x ? 'selected' : ''}>${dlvEsc(x)}</option>`).join('')}</select></div>
    </div>
    <div class="row">
      <div class="col"><label for="dlv-pay-to">Paid to</label><input type="text" id="dlv-pay-to" value="${dlvEsc(f.paid_to || '')}" placeholder="e.g. Porter driver Ramesh / 2 labourers"></div>
      <div class="col"><label for="dlv-pay-mode">Mode</label><select id="dlv-pay-mode">${dlvPayModes().map(x => `<option ${f.mode === x ? 'selected' : ''}>${dlvEsc(x)}</option>`).join('')}</select></div>
      <div class="col"><label for="dlv-pay-date">Date</label><input type="date" id="dlv-pay-date" value="${dlvEsc(f.date || '')}"></div>
    </div>
    <label class="btn dlv-camera" style="margin-top:8px;">📷 Photo of the bill / receipt<input type="file" id="dlv-pay-files" accept="image/*,application/pdf,.pdf" multiple hidden></label>
    <div class="dlv-thumbs">${(f.files || []).map((x, i) => `<div class="dlv-thumb">${/^data:image\//.test(x.data) ? `<img src="${x.data}" alt="">` : `<span class="dlv-thumb-file">📎 ${dlvEsc(x.name)}</span>`}<button type="button" data-dlv-pay-remove="${i}" aria-label="Remove">✕</button></div>`).join('')}</div>
    ${f.busy ? '<div class="small muted">Preparing photo…</div>' : ''}
    ${(f.files || []).length ? '' : `<label for="dlv-pay-nobill">No bill? Say why <span class="muted small">(only if there is no bill)</span></label><input type="text" id="dlv-pay-nobill" value="${dlvEsc(f.no_bill_reason || '')}" placeholder="e.g. labourers paid cash, no receipt">`}
    <label for="dlv-pay-note">Note <span class="muted small">(optional)</span></label><input type="text" id="dlv-pay-note" value="${dlvEsc(f.note || '')}">

    ${f.err ? `<div class="err">${dlvEsc(f.err)}</div>` : ''}
    <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;">
      <button class="btn btn-primary btn-sm" data-dlv-pay-send="${d.id}" ${f.saving || f.busy ? 'disabled' : ''}>${f.saving ? 'Saving…' : '✓ Save payment'}</button>
      <button class="btn btn-sm" data-dlv-act="pay-cancel">Cancel</button>
    </div>
  </div>`;
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
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button class="btn btn-sm" data-dlv-act="sound" title="Sounds for new notifications, announcements and deliveries">${dlvSoundOn() ? '🔔 Sounds on' : '🔕 Sounds off'}</button>
        ${dlvCanManage() && !ui.deliveryForm ? `<button class="btn btn-primary btn-sm" data-dlv-act="new">+ New delivery</button>` : ''}
      </div>
    </div>
  </div>
  ${deliveryFormHTML()}
  <div class="card">
    <div class="task-tabs" role="tablist">${DLV_TABS.map(t => `<button class="task-tab${tab === t.key ? ' active' : ''}" data-dlv-tab="${t.key}">${t.label} <span class="task-tab-count">${items.filter(t.match).length}</span></button>`).join('')}</div>
    <input type="text" id="delivery-search" placeholder="Search by material, DLV number, driver, vehicle, Porter order ID…" value="${dlvEsc(ui.deliverySearch || '')}" style="margin:10px 0;">
    ${list.length ? list.map(deliveryCardHTML).join('') : `<div class="empty">${q ? 'No delivery matches your search.' : tab === 'docs' ? 'All required documents are in.' : tab === 'pending' ? (dlvCanManage() ? 'No deliveries to receive. Open a material task and tap "🚚 Add to delivery", or add one here.' : 'Nothing to receive right now.') : 'Nothing here yet.'}</div>`}
  </div>
  ${deliveryPerformanceHTML()}
  ${ui.deliveryPhoto ? `<div class="dlv-viewer" data-dlv-act="close-photo"><img src="${ui.deliveryPhoto.data}" alt="${dlvEsc(ui.deliveryPhoto.name)}"><div class="dlv-viewer-bar"><span>${dlvEsc(ui.deliveryPhoto.name)}</span><button class="btn btn-sm" data-dlv-act="download-photo">Download</button><button class="btn btn-sm" data-dlv-act="close-photo">Close</button></div></div>` : ''}`;
}

// ---- Site team performance (tagged people only — the task's own people are not counted here) ----
function dlvIstDay(iso) { try { return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); } catch (e) { return ''; } }
function deliveryPerformance(period) {
  const today = dlvIstDay(new Date().toISOString());
  const from = period === 'month' ? today.slice(0, 8) + '01' : period === '30d' ? dlvIstDay(new Date(Date.now() - 30 * 864e5).toISOString()) : '';
  const rows = new Map();
  for (const d of deliveriesData.items || []) {
    if (d.status === 'cancelled') continue;
    const due = String(d.expected_at || '').slice(0, 10);
    if (from && due < from) continue;
    const deliveredDay = d.delivered_at ? dlvIstDay(d.delivered_at) : null;
    const onTime = deliveredDay && deliveredDay <= due;
    const late = (deliveredDay && deliveredDay > due) || (!deliveredDay && due && due < today);
    for (const u of d.receivers || []) {
      const r = rows.get(u) || { username: u, tagged: 0, confirmed: 0, onTime: 0, late: 0, pending: 0, unloaded: 0, uploads: 0, unloadHours: [] };
      r.tagged++;
      if (deliveredDay) r.confirmed++;
      if (onTime) r.onTime++;
      if (late) r.late++;
      if (!deliveredDay || d.status === 'delivered') r.pending++;
      if (d.status === 'unloaded') { r.unloaded++; if (d.delivered_at && d.unloaded_at) r.unloadHours.push((new Date(d.unloaded_at) - new Date(d.delivered_at)) / 36e5); }
      if (d.delivered_by === u) r.uploads++;
      if (d.unloaded_by === u) r.uploads++;
      rows.set(u, r);
    }
  }
  return [...rows.values()].map(r => ({ ...r, avgUnload: r.unloadHours.length ? r.unloadHours.reduce((a, b) => a + b, 0) / r.unloadHours.length : null,
    pct: r.onTime + r.late ? Math.round(r.onTime / (r.onTime + r.late) * 100) : null }))
    .filter(r => dlvCanManage() || r.username === session.username)
    .sort((a, b) => b.tagged - a.tagged || personName(a.username).localeCompare(personName(b.username)));
}
function deliveryPerformanceHTML() {
  const period = ['month', '30d', 'all'].includes(ui.dlvPerfPeriod) ? ui.dlvPerfPeriod : 'month';
  const rows = deliveryPerformance(period);
  const hrs = h => h == null ? '—' : h < 1 ? `${Math.round(h * 60)} min` : h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} days`;
  return `
  <div class="card" id="dlv-performance">
    <div class="flex-between" style="flex-wrap:wrap;gap:10px;">
      <div><div class="card-title" style="margin:0;">Site team performance</div>
        <div class="small muted">How the people tagged to receive deliveries are doing — by delivery date. "On time" = delivery confirmed with photos on or before the delivery date. ${dlvCanManage() ? '' : 'You see your own numbers.'}</div></div>
      <select id="dlv-perf-period" style="width:auto;"><option value="month" ${period === 'month' ? 'selected' : ''}>This month</option><option value="30d" ${period === '30d' ? 'selected' : ''}>Last 30 days</option><option value="all" ${period === 'all' ? 'selected' : ''}>All time</option></select>
    </div>
    ${rows.length ? `<div class="dlv-perf-wrap"><table class="dlv-perf">
      <thead><tr><th>Person</th><th>Tagged</th><th>Confirmed</th><th>On time</th><th>Late / overdue</th><th>Still pending</th><th>Photos uploaded</th><th>Avg. delivery → unloading</th></tr></thead>
      <tbody>${rows.map(r => `<tr>
        <td><b>${dlvEsc(personName(r.username))}</b></td><td>${r.tagged}</td><td>${r.confirmed}</td>
        <td>${r.pct == null ? '—' : `<span class="dlv-pct ${r.pct >= 80 ? 'good' : r.pct >= 50 ? 'mid' : 'bad'}">${r.pct}%</span> <span class="muted small">(${r.onTime})</span>`}</td>
        <td>${r.late ? `<span class="dlv-late">${r.late}</span>` : '0'}</td><td>${r.pending}</td><td>${r.uploads}</td><td>${hrs(r.avgUnload)}</td></tr>`).join('')}</tbody>
    </table></div>` : '<div class="empty">No deliveries in this period yet.</div>'}
  </div>`;
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
  act('new', () => { ui.deliveryForm = { mode: 'new', title: '', receivers: [], files: [], search: '', required_docs: dlvDefaultRequired().slice() }; ui.deliveryErr = ''; render(); });
  act('cancel-form', () => { ui.deliveryForm = null; ui.deliveryErr = ''; render(); });
  act('proof-cancel', () => { ui.deliveryProof = null; render(); });
  act('cancel-cancel', () => { ui.deliveryCancel = null; render(); });
  act('delete-cancel', () => { ui.deliveryDelete = null; render(); });
  document.querySelectorAll('[data-dlv-delete]').forEach(b => b.onclick = () => { ui.deliveryDelete = Number(b.dataset.dlvDelete); render(); });
  document.querySelectorAll('[data-dlv-delete-confirm]').forEach(b => b.onclick = async () => {
    if (b.disabled) return; b.disabled = true; b.textContent = 'Deleting…';
    const reopenEl = document.getElementById('dlv-delete-reopen');
    try {
      const r = await api(`/api/deliveries/${b.dataset.dlvDeleteConfirm}/delete`, { method: 'POST', body: JSON.stringify({ reopenTask: !!(reopenEl && reopenEl.checked) }) });
      ui.deliveryDelete = null;
      setBanner(`Delivery deleted${r.reopened ? ' and its task re-opened' : ''}. The site team has been told.`, 'ok');
      await refreshData();
    } catch (e) { b.disabled = false; b.textContent = 'Yes, delete'; setBanner(e.message); render(); }
  });
  act('close-photo', () => { ui.deliveryPhoto = null; render(); });
  act('sound', () => { const on = !dlvSoundOn(); try { safeStorage.setItem('ls_dlv_sound', on ? 'on' : 'off'); } catch (e) {} if (on) dlvPlaySound('placed'); render(); });
  act('open-budget', () => { ui.adminTab = 'budget'; try { safeStorage.setItem('ls_last_tab', 'budget'); } catch (e) {} render(); window.scrollTo(0, 0); });
  act('download-photo', () => { const p = ui.deliveryPhoto; if (p) downloadDataUrl(p.data, p.name); });
  document.querySelectorAll('[data-dlv-tab]').forEach(b => b.onclick = () => { ui.deliveryTab = b.dataset.dlvTab; render(); });
  const perf = document.getElementById('dlv-perf-period'); if (perf) perf.onchange = () => { ui.dlvPerfPeriod = perf.value; render(); };
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
    document.querySelectorAll('#delivery-form input[type="number"]').forEach(el => { el.addEventListener('input', keep); el.addEventListener('change', keep); });
    document.querySelectorAll('[data-dlv-reqdoc]').forEach(cb => cb.onchange = () => {
      keep(); const s = new Set(f.required_docs || dlvDefaultRequired()); if (cb.checked) s.add(cb.dataset.dlvReqdoc); else s.delete(cb.dataset.dlvReqdoc); f.required_docs = [...s];
    });
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
      if (f.limited) {
        ui.deliverySaving = true; ui.deliveryErr = ''; render();
        try {
          await api(`/api/deliveries/${f.id}/update`, { method: 'POST', body: JSON.stringify({ required_docs: f.required_docs || dlvDefaultRequired() }) });
          const id = f.id; ui.deliveryForm = null; ui.deliverySaving = false; setBanner('Documents list updated.', 'ok'); await refreshData(); openDeliveryOnPage(id);
        } catch (e) { ui.deliverySaving = false; ui.deliveryErr = e.message; render(); }
        return;
      }
      if (!String(f.title || '').trim()) { ui.deliveryErr = 'Write what is being delivered.'; render(); return; }
      if (!f.expected_date) { ui.deliveryErr = 'Pick the delivery date (time is optional).'; render(); return; }
      if (!(f.receivers || []).length) { ui.deliveryErr = 'Tag at least one person on site who will receive it.'; render(); return; }
      const body = { title: f.title, quantity: f.quantity, project: f.project, site_location: f.site_location, vendor: f.vendor, transport: f.transport,
        porter_order_id: f.porter_order_id, delivery_ref: f.delivery_ref, vehicle_no: f.vehicle_no, driver_name: f.driver_name, driver_phone: f.driver_phone,
        description: f.description, expected_at: f.expected_date + (f.expected_time ? `T${f.expected_time}` : ''), receivers: f.receivers,
        attachments: (f.files || []).map(x => ({ name: x.name, data: x.data })),
        required_docs: f.required_docs || dlvDefaultRequired() };
      if (f.mode === 'new' && f.task_id) body.task_id = f.task_id;
      ui.deliverySaving = true; ui.deliveryErr = ''; render();
      try {
        const r = f.mode === 'edit'
          ? await api(`/api/deliveries/${f.id}/update`, { method: 'POST', body: JSON.stringify(body) })
          : await api('/api/deliveries', { method: 'POST', body: JSON.stringify(body) });
        const id = f.mode === 'edit' ? f.id : r.id;
        if (f.mode !== 'edit') dlvPlaySound('placed');
        ui.deliveryForm = null; ui.deliverySaving = false;
        setBanner(f.mode === 'edit' ? 'Delivery updated — the site team has been told about any new details.'
          : `Added to deliveries as ${r.ref}. The site team has been notified.${r.closedTask ? ' The task is now closed — only the delivery is tracked.' : (r.keptOpenWhy ? ` The task was kept open because ${r.keptOpenWhy}.` : '')}`, 'ok');
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
      expected_date: date || '', expected_time: time || '', receivers: (d.receivers || []).slice(), files: [], search: '',
      required_docs: (d.required_docs || []).slice(), limited: d.status === 'unloaded' };
    ui.deliveryErr = ''; render(); window.scrollTo(0, 0);
  });
  document.querySelectorAll('[data-dlv-followup]').forEach(b => b.onclick = async () => {
    if (b.disabled) return; b.disabled = true; const label = b.textContent; b.textContent = '📣 Sending…';
    try { const r = await api(`/api/deliveries/${b.dataset.dlvFollowup}/followup`, { method: 'POST' }); setBanner(`Follow-up sent to ${r.sent.map(personName).join(', ')}.`, 'ok'); await refreshData(); }
    catch (e) { b.disabled = false; b.textContent = label; setBanner(e.message); render(); }
  });
  document.querySelectorAll('[data-dlv-bill]').forEach(btn => btn.onclick = (e) => { e.preventDefault(); const d = (deliveriesData.items || []).find(x => x.id === Number(btn.dataset.dlvBill)); if (d) openBillFromDelivery(d); });
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

  // ---- in-card tabs
  document.querySelectorAll('[data-dlv-ctab]').forEach(b => b.onclick = (e) => {
    e.preventDefault(); const [id, k] = b.dataset.dlvCtab.split(':'); ui.dlvCardTab = { ...(ui.dlvCardTab || {}), [id]: k }; render();
  });
  document.querySelectorAll('[data-dlv-docdir]').forEach(b => b.onclick = (e) => {
    e.preventDefault(); const [id, k] = b.dataset.dlvDocdir.split(':'); ui.dlvDocDir = { ...(ui.dlvDocDir || {}), [id]: k };
    if (ui.dlvDoc && ui.dlvDoc.id === Number(id)) ui.dlvDoc = null; render();
  });
  document.querySelectorAll('[data-dlv-goto]').forEach(b => b.onclick = () => { const id = Number(b.dataset.dlvGoto); ui.dlvCardTab = { ...(ui.dlvCardTab || {}), [id]: 'money' }; openDeliveryOnPage(id); });
  // Reads picked files; photos get the date/time + delivery number stamped on them.
  const readFiles = (input, target, stampWord, ref, max = 10) => {
    const list = Array.from(input.files || []).slice(0, max - (target.files || []).length); if (!list.length) return;
    target.busy = true; target.err = ''; render(); let left = list.length;
    list.forEach(file => readAnyFile(file, async (data) => {
      if (data && /^data:image\//i.test(data)) {
        const stamp = `${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })} · ${ref} · ${stampWord} · ${session.name}`;
        target.files.push({ name: file.name.replace(/\.[^.]+$/, '') + '.jpg', data: await dlvStampPhoto(data, stamp) });
      } else if (data) target.files.push({ name: file.name, data });
      if (--left === 0) { target.busy = false; render(); }
    }));
  };
  // documents
  document.querySelectorAll('[data-dlv-doc-new]').forEach(b => b.onclick = (e) => {
    e.preventDefault(); const [id, dir, type] = b.dataset.dlvDocNew.split(':');
    const d = (deliveriesData.items || []).find(x => x.id === Number(id));
    const first = type || (d ? (dlvMissingDocs(d, dir)[0] || dlvDocTypes().find(t => t.dir === dir).key) : '');
    ui.dlvDoc = { id: Number(id), dir, type: first, files: [], note: '', err: '' }; render();
  });
  act('doc-cancel', () => { ui.dlvDoc = null; render(); });
  const df = ui.dlvDoc;
  if (df) {
    const d = (deliveriesData.items || []).find(x => x.id === df.id);
    const ty = document.getElementById('dlv-doc-type'); if (ty) ty.onchange = () => { df.type = ty.value; };
    const nt = document.getElementById('dlv-doc-note'); if (nt) nt.oninput = () => { df.note = nt.value; };
    const fi = document.getElementById('dlv-doc-files'); if (fi) fi.onchange = () => readFiles(fi, df, (dlvDoc(df.type) || {}).label || 'Document', d ? d.ref : '');
    document.querySelectorAll('[data-dlv-doc-remove]').forEach(b => b.onclick = () => { df.files.splice(Number(b.dataset.dlvDocRemove), 1); render(); });
    document.querySelectorAll('[data-dlv-doc-send]').forEach(b => b.onclick = async () => {
      if (df.saving) return;
      if (!df.files.length) { df.err = 'Attach the document — a clear photo or the PDF.'; render(); return; }
      df.saving = true; df.err = ''; render();
      try {
        await api(`/api/deliveries/${df.id}/documents`, { method: 'POST', body: JSON.stringify({ type: df.type, note: df.note, attachments: df.files }) });
        const label = (dlvDoc(df.type) || {}).label || 'Document'; const dir = df.dir; ui.dlvDoc = null;
        setBanner(`${label} uploaded — ${dir === 'to_site' ? 'the site team has been told' : 'head office has been told'}.`, 'ok'); await refreshData();
      } catch (e) { df.saving = false; df.err = e.message; render(); }
    });
  }
  document.querySelectorAll('[data-dlv-file-del]').forEach(b => b.onclick = async (e) => {
    e.preventDefault(); e.stopPropagation();
    if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Remove?'; b.classList.add('armed'); setTimeout(() => { if (b.isConnected) { b.dataset.armed = ''; b.textContent = '✕'; b.classList.remove('armed'); } }, 4000); return; }
    const [did, fid] = b.dataset.dlvFileDel.split(':'); b.disabled = true;
    try { await api(`/api/deliveries/${did}/files/${fid}/delete`, { method: 'POST' }); setBanner('File removed.', 'ok'); await refreshData(); }
    catch (err) { b.disabled = false; setBanner(err.message); render(); }
  });
  // payments
  document.querySelectorAll('[data-dlv-pay-new]').forEach(b => b.onclick = (e) => {
    e.preventDefault();
    ui.dlvPay = { id: Number(b.dataset.dlvPayNew), amount: '', purpose: dlvPayPurposes()[0], mode: dlvPayModes()[0], paid_to: '', date: typeof istDayKey === 'function' ? istDayKey(new Date().toISOString()) : dlvIstDay(new Date().toISOString()), files: [], note: '', no_bill_reason: '', err: '' };
    render(); const el = document.getElementById('dlv-pay-amount'); if (el) el.focus();
  });
  act('pay-cancel', () => { ui.dlvPay = null; render(); });
  const pf = ui.dlvPay;
  if (pf) {
    const d = (deliveriesData.items || []).find(x => x.id === pf.id);
    const bindV = (id, k, rerender) => { const el = document.getElementById(id); if (el) { el.oninput = () => { pf[k] = el.value; }; el.onchange = () => { pf[k] = el.value; if (rerender) { render(); const n = document.getElementById(id); if (n && n.focus) n.focus(); } }; } };
    bindV('dlv-pay-amount', 'amount', true); bindV('dlv-pay-purpose', 'purpose'); bindV('dlv-pay-mode', 'mode'); bindV('dlv-pay-to', 'paid_to'); bindV('dlv-pay-date', 'date'); bindV('dlv-pay-note', 'note'); bindV('dlv-pay-nobill', 'no_bill_reason');
    const fi = document.getElementById('dlv-pay-files'); if (fi) fi.onchange = () => readFiles(fi, pf, 'Bill', d ? d.ref : '', 5);
    document.querySelectorAll('[data-dlv-pay-remove]').forEach(b => b.onclick = () => { pf.files.splice(Number(b.dataset.dlvPayRemove), 1); render(); });
    document.querySelectorAll('[data-dlv-pay-send]').forEach(b => b.onclick = async () => {
      if (pf.saving) return;
      if (!(Number(pf.amount) > 0)) { pf.err = 'Enter the amount paid.'; render(); return; }
      if (!pf.files.length && String(pf.no_bill_reason || '').trim().length < 5) { pf.err = 'Add a photo of the bill / receipt — or, if there is no bill, write why.'; render(); return; }
      pf.saving = true; pf.err = ''; render();
      try {
        const r = await api(`/api/deliveries/${pf.id}/payments`, { method: 'POST', body: JSON.stringify({ amount: Number(pf.amount), purpose: pf.purpose, mode: pf.mode, paid_to: pf.paid_to, paid_at: pf.date, note: pf.note, no_bill_reason: pf.no_bill_reason, attachments: pf.files }) });
        ui.dlvPay = null;
        setBanner(`Payment saved — sent to the Director for verification.${r.wallet != null ? ` Balance with you: ${r.wallet < 0 ? '−' : ''}${dlvInr(Math.abs(r.wallet))}${r.wallet < 0 ? ' (from your own pocket — ask for a top-up in Budget)' : ''}.` : ''}`, r.wallet != null && r.wallet < 0 ? '' : 'ok');
        await refreshData();
      } catch (e) { pf.saving = false; pf.err = e.message; render(); }
    });
  }
  document.querySelectorAll('[data-dlv-pay-del]').forEach(b => b.onclick = async (e) => {
    e.preventDefault(); e.stopPropagation();
    if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Remove?'; b.classList.add('armed'); setTimeout(() => { if (b.isConnected) { b.dataset.armed = ''; b.textContent = '✕'; b.classList.remove('armed'); } }, 4000); return; }
    const [did, pid] = b.dataset.dlvPayDel.split(':'); b.disabled = true;
    try { await api(`/api/deliveries/${did}/payments/${pid}/delete`, { method: 'POST' }); setBanner('Payment removed.', 'ok'); await refreshData(); }
    catch (err) { b.disabled = false; setBanner(err.message); render(); }
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
        if (stage === 'delivered') dlvPlaySound('delivered');
        setBanner(stage === 'delivered' ? 'Delivery confirmed with photos. Next: confirm the unloading.' : 'Unloading confirmed — everyone has been told.', 'ok');
        await refreshData(); openDeliveryOnPage(p.id);
      } catch (e) { p.saving = false; p.err = e.message; render(); }
    });
  }
}
