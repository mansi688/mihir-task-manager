/* MIHIR Task Manager — Employee location tracking (web UI).
   Loaded after app.js and uses its helpers (api, esc, render, session, ui, icon, setBanner…).
   Everything here stays hidden unless the server has location tracking switched on.
   Pages: "My Location" (everyone: consent, start/stop, own timeline, who viewed me, export) and
   "Locations" (Admin / Directors / team leads: live map, history & replay, places, reports, alerts,
   indoor floors, policy). The server enforces every permission; this file only mirrors it. */
(function () {
  'use strict';

  const S = {
    me: null, meAt: 0, meLoading: false,
    tab: 'live',
    live: null, liveV: null, liveAt: 0, liveLoading: false, liveFilter: '',
    hist: { username: '', day: '', data: null, loading: false, idx: 0, playing: null },
    places: null, placesAt: 0, placeDraft: null, placeEditId: null,
    report: { from: '', to: '', data: null, loading: false },
    rules: null, alerts: null, ruleDraft: null,
    settings: null, accessLog: null, keys: null, newKey: null, tags: null,
    indoor: { floors: null, floorId: null, floor: null, plans: {}, live: [], mode: null, draft: [], liveAt: 0 },
    tasks: new Map(),
    myHist: null, myHistAt: 0, myAccess: null, myBusy: false, myDay: '',
    map: null, mapEl: null, layer: null, sig: '', fitNext: true, replayMarker: null,
    msearch: { q: '', results: null, loading: false, error: null, pin: null, seq: 0 }, pinLayer: null,
  };
  const DAY = 86400000;

  // ---------- small helpers ----------
  const isOn = () => !!(typeof appFeatures !== 'undefined' && appFeatures.locationTracking && S.me && S.me.enabled);
  const canManage = () => isOn() && !!S.me.canViewOthers;
  const pad = (n) => String(n).padStart(2, '0');
  const fmtT = (iso) => { if (!iso) return '—'; const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const fmtDT = (iso) => { if (!iso) return '—'; const d = new Date(iso); return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${fmtT(iso)}`; };
  const ago = (iso) => {
    if (!iso) return 'no fix yet';
    const s = Math.max(0, (Date.now() - new Date(iso)) / 1000);
    if (s < 60) return 'just now'; if (s < 3600) return `${Math.round(s / 60)} min ago`; if (s < 86400) return `${Math.round(s / 3600)} h ago`; return fmtDT(iso);
  };
  const mins = (m) => { m = Math.round(m || 0); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${pad(m % 60)} min`; };
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const nameList = (v) => (v || []).map(x => (x && x.name) || x).filter(Boolean);
  const KIND_LABEL = { office: '🏢 Office', site: '🏗️ Site', warehouse: '📦 Warehouse', supplier: '🚚 Supplier', client: '🤝 Client', other: '📍 Other' };
  const STATUS = {
    at_place: { label: 'At a place', color: '#1f9d55' }, moving: { label: 'Moving', color: '#2d5fa8' }, stationary: { label: 'Stopped', color: '#7c5cff' },
    stale: { label: 'No recent fix', color: '#d68c14' }, lost: { label: 'Signal lost', color: '#d64545' }, waiting: { label: 'Waiting for GPS', color: '#888' },
  };
  const RULE_LABEL = { arrive: 'Arrives at a place', depart: 'Leaves a place', restricted_entry: 'Enters a restricted place / zone', signal_lost: 'Signal lost (no location for N min)', speeding: 'Speeding (km/h)', overtime: 'Session longer than N hours' };
  async function load(fn) { try { return await fn(); } catch (e) { setBanner(e.message); render(); return null; } }

  // ---------- server status for this person ----------
  async function refreshMe(force) {
    if (!token || !session || S.meLoading) return;
    if (!force && S.me && Date.now() - S.meAt < 30000) return;
    if (typeof appFeatures === 'undefined' || !appFeatures.locationTracking) { S.me = null; return; }
    S.meLoading = true; S.meAt = Date.now();
    try { S.me = await api('/api/location/me'); S.meAt = Date.now(); }
    catch (e) { /* offline: keep the last state */ }
    finally { S.meLoading = false; }
    syncTrackers();
    render();
  }

  // ---------- trackers: native app (background) or this browser (foreground only) ----------
  const Native = {
    android() { return !!(window.AndroidBridge && typeof window.AndroidBridge.locationStart === 'function'); },
    ios() { return !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.mihirNative); },
    available() { return this.android() || this.ios(); },
    platform() { return this.android() ? 'android' : this.ios() ? 'ios' : 'web'; },
    start(cfg) {
      if (this.android()) return String(window.AndroidBridge.locationStart(JSON.stringify(cfg)) || 'ok');
      if (this.ios()) { window.webkit.messageHandlers.mihirNative.postMessage({ cmd: 'locationStart', config: cfg }); return 'ok'; }
      return 'unavailable';
    },
    stop() {
      if (this.android()) window.AndroidBridge.locationStop();
      else if (this.ios()) window.webkit.messageHandlers.mihirNative.postMessage({ cmd: 'locationStop' });
    },
    status() {
      try {
        if (this.android()) return JSON.parse(window.AndroidBridge.locationStatus() || '{}');
        if (this.ios()) { window.webkit.messageHandlers.mihirNative.postMessage({ cmd: 'locationStatus' }); return window.__mihirNativeStatus || {}; }
      } catch (e) { /* older app */ }
      return {};
    },
  };
  // iOS app pushes its status here.
  window.__mihirNativeStatusUpdate = function (st) { window.__mihirNativeStatus = st; if (ui.adminTab === 'mytracking') render(); };
  // Outcome of the phone's permission dialog (Android/iOS apps call this).
  window.__mihirLocationResult = async function (result) {
    if (result === 'denied') {
      try { await api('/api/location/sessions/stop', { method: 'POST' }); } catch (e) { /* ignore */ }
      setBanner('Location permission was refused, so the work session was stopped. Allow "Location" for the MIHIR app in the phone settings and try again.');
    } else if (result === 'started') setBanner('Work session started — your phone shows a notification while location is shared.', 'ok');
    refreshMe(true);
  };

  const QKEY = 'loc_web_queue';
  const Web = {
    watchId: null, sessionId: null, timer: null, queue: [], last: null, error: null, uploading: false, sent: 0,
    running() { return this.watchId != null; },
    load() { try { this.queue = JSON.parse(safeStorage.getItem(QKEY) || '[]') || []; } catch (e) { this.queue = []; } },
    save() { try { safeStorage.setItem(QKEY, JSON.stringify(this.queue.slice(-2000))); } catch (e) { /* storage full / blocked */ } },
    start(sessionId, cfg) {
      if (!('geolocation' in navigator)) { this.error = 'This browser cannot share location.'; return false; }
      if (this.running() && this.sessionId === sessionId) return true;
      this.stop(true);
      this.sessionId = sessionId; this.error = null; this.load();
      try { safeStorage.setItem('loc_web_session', String(sessionId)); } catch (e) { /* ignore */ }
      this.watchId = navigator.geolocation.watchPosition((pos) => {
        const c = pos.coords;
        // A fix arrived, so any earlier "unavailable / waiting" message is out of date.
        if (this.error) { this.error = null; if (ui.adminTab === 'mytracking') render(); }
        const p = { id: `w${sessionId}-${pos.timestamp}`, t: pos.timestamp, lat: c.latitude, lng: c.longitude, acc: c.accuracy, alt: c.altitude, spd: c.speed, hdg: c.heading, moving: c.speed != null ? c.speed > 1 : null, src: 'browser' };
        // Battery-friendly: drop fixes that barely moved and came too soon.
        const L = this.last;
        const minGap = (cfg.movingIntervalSec || 15) * 1000;
        if (L && p.t - L.t < minGap && Math.hypot((p.lat - L.lat) * 111000, (p.lng - L.lng) * 111000 * Math.cos(p.lat * Math.PI / 180)) < (cfg.distanceFilterM || 20)) return;
        this.last = p; this.queue.push(p); this.save();
        if (this.queue.length >= 20) this.flush();
        if (ui.adminTab === 'mytracking') render();
      }, (err) => {
        this.error = err.code === 1 ? 'Location permission was refused in this browser.' : err.code === 2 ? 'Location is unavailable (GPS off or no signal).' : 'Waiting for location…';
        render();
      }, { enableHighAccuracy: true, maximumAge: 10000, timeout: 60000 });
      this.timer = setInterval(() => this.flush(), Math.max(15, cfg.uploadEverySec || 60) * 1000);
      return true;
    },
    async flush() {
      if (this.uploading || !this.queue.length || !token) return;
      this.uploading = true;
      const batch = this.queue.slice(0, 200);
      try {
        const res = await fetch('/api/location/points', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ sessionId: this.sessionId, points: batch }) });
        const data = await res.json().catch(() => ({}));
        if (res.ok || res.status === 409) {
          // Accepted, duplicate or rejected — either way the server has decided; drop them.
          const ids = new Set(batch.map(p => p.id));
          this.queue = this.queue.filter(p => !ids.has(p.id)); this.save();
          this.sent += data.accepted || 0;
          // Show the new route/visits in "Your day" straight away when looking at today.
          if (data.accepted && ui.adminTab === 'mytracking' && (!S.myDay || S.myDay === today())) loadMine(true);
          if (data.sessionActive === false) { this.stop(); refreshMe(true); }
        }
      } catch (e) { /* offline: kept in the queue, retried next time */ }
      finally { this.uploading = false; }
    },
    stop(keepQueue) {
      if (this.watchId != null) { try { navigator.geolocation.clearWatch(this.watchId); } catch (e) { /* ignore */ } }
      this.watchId = null;
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      if (!keepQueue) { this.flush(); try { safeStorage.removeItem('loc_web_session'); } catch (e) { /* ignore */ } }
    },
  };

  // Make what's running on this device match the server's session.
  function syncTrackers() {
    const active = S.me && S.me.activeSession;
    if (!active) { if (Web.running()) Web.stop(); return; }
    let mine = null;
    try { mine = safeStorage.getItem('loc_web_session'); } catch (e) { /* ignore */ }
    if (active.platform === 'web' && mine === String(active.id) && !Web.running()) Web.start(active.id, S.me.config || {});
  }

  async function startWork() {
    if (S.myBusy) return;
    S.myBusy = true; render();
    try {
      const platform = Native.platform();
      const label = (navigator.userAgentData && navigator.userAgentData.platform) || (navigator.userAgent.match(/\(([^)]+)\)/) || [])[1] || '';
      const r = await api('/api/location/sessions/start', { method: 'POST', body: JSON.stringify({ platform, deviceLabel: String(label).slice(0, 100), appVersion: 'web' }) });
      if (Native.available()) {
        const out = Native.start({ uploadUrl: location.origin + '/api/location/points', sightingsUrl: location.origin + '/api/location/indoor/sightings', token: r.uploadToken, sessionId: r.session.id, config: r.config, name: session.name });
        if (out === 'asking') setBanner('Tap "Allow" when the phone asks for location — the session starts as soon as you do.', 'ok');
        else if (out === 'denied') {
          await api('/api/location/sessions/stop', { method: 'POST' });
          setBanner('Location permission was refused, so the work session was not started. Allow "Location" for the MIHIR app in phone settings and try again.');
        } else setBanner('Work session started — your phone shows a notification while location is shared.', 'ok');
      } else {
        if (!Web.start(r.session.id, r.config)) { await api('/api/location/sessions/stop', { method: 'POST' }); setBanner(Web.error || 'This browser cannot share location.'); }
        else setBanner('Work session started. Keep this page open — browsers stop sharing location when the page is closed.', 'ok');
      }
    } catch (e) { setBanner(e.message); }
    S.myBusy = false;
    await refreshMe(true);
  }
  async function stopWork() {
    if (S.myBusy) return;
    S.myBusy = true; render();
    try {
      if (Native.available()) Native.stop();
      await Web.flush(); Web.stop();
      await api('/api/location/sessions/stop', { method: 'POST' });
      setBanner('Work session stopped — location is no longer recorded.', 'ok');
    } catch (e) { setBanner(e.message); }
    S.myBusy = false;
    await refreshMe(true);
  }
  // A native app that was restarted (phone reboot, app update) needs a fresh upload token.
  async function resumeNativeIfNeeded() {
    const active = S.me && S.me.activeSession;
    if (!active || !Native.available() || active.platform !== Native.platform()) return;
    const st = Native.status();
    if (st && st.running) return;
    const r = await load(() => api('/api/location/sessions/start', { method: 'POST', body: JSON.stringify({ platform: Native.platform() }) }));
    if (r) Native.start({ uploadUrl: location.origin + '/api/location/points', sightingsUrl: location.origin + '/api/location/indoor/sightings', token: r.uploadToken, sessionId: r.session.id, config: r.config, name: session.name, resumed: true });
  }

  // ---------- sidebar / top bar ----------
  function navGroups(groups) {
    if (!isOn()) return;
    const you = groups.find(g => g.group === 'You');
    const mine = { key: 'mytracking', label: 'My Location', icon: 'mapPin', badge: () => (S.me && S.me.activeSession ? '●' : 0) };
    if (you) you.items = [mine, ...you.items.filter(i => i.key !== 'mytracking')]; else groups.push({ group: 'You', items: [mine] });
    if (canManage() && !groups.some(g => g.items.some(i => i.key === 'locations'))) {
      const at = groups.findIndex(g => g.group === 'Communicate');
      groups.splice(at >= 0 ? at + 1 : 2, 0, { group: 'Field', items: [{ key: 'locations', label: 'Locations', icon: 'mapPin', badge: () => (S.alerts || []).filter(a => !a.acknowledged_at).length }] });
    }
  }
  function statusPill() {
    if (!isOn() || !S.me.activeSession) return '';
    const s = S.me.activeSession;
    return `<button class="loc-pill" data-tab="mytracking" title="Your location is being recorded for this work session. Tap to see or stop it.">📍 Tracking on<span class="loc-pill-sub"> · since ${fmtT(s.started_at)}</span></button>`;
  }

  // =========================================================================================
  // MY LOCATION (everyone)
  // =========================================================================================
  function renderMine() {
    const me = S.me;
    if (!me) return '<div class="card"><div class="empty">Loading…</div></div>';
    if (!me.eligible.ok && !me.activeSession) return `<div class="card"><h3 style="margin-top:0;">📍 Location</h3><div class="muted">${esc(me.eligible.reason)}</div></div>`;
    if (!me.consent.accepted) return consentHTML(me);
    const a = me.activeSession;
    const native = Native.available();
    const nst = native ? Native.status() : {};
    const web = !native && a && a.platform === 'web' && Web.running();
    const elsewhere = a && !web && !(native && a.platform === Native.platform());
    return `
    <div class="card loc-hero ${a ? 'on' : 'off'}">
      <div class="loc-hero-dot"></div>
      <div style="flex:1;min-width:0;">
        <div class="loc-hero-title">${a ? 'Work session ON — your location is being recorded' : 'Work session OFF — no location is recorded'}</div>
        <div class="small muted">${a ? `Since ${fmtDT(a.started_at)} on ${esc(a.platform === 'web' ? 'a browser' : a.platform === 'ios' ? 'the iPhone app' : 'the Android app')}${a.device_label ? ` (${esc(a.device_label)})` : ''} · last position ${esc(ago(a.last_point_at))}${a.last_accuracy_m ? ` (±${Math.round(a.last_accuracy_m)} m)` : ''} · ${(a.distance_m / 1000).toFixed(1)} km`
          : `Start a work session when you begin field work. ${native ? 'The app keeps sharing location in the background (you will see a notification) until you stop.' : 'In a browser this only works while this page stays open — install the MIHIR phone app for background tracking.'}`}</div>
        ${web ? `<div class="small" style="margin-top:4px;">This browser: ${Web.error ? `<b style="color:var(--danger)">${esc(Web.error)}</b>` : Web.last ? `last fix ${fmtT(Web.last.t)} (±${Math.round(Web.last.acc)} m)` : 'waiting for the first fix…'} · ${Web.queue.length ? `${Web.queue.length} waiting to upload` : 'all uploaded'}</div>` : ''}
        ${native && a ? `<div class="small" style="margin-top:4px;">Phone app: ${nst.running ? `running${nst.queued ? ` · ${nst.queued} waiting to upload` : ''}${nst.permission && nst.permission !== 'granted' ? ' · <b style="color:var(--danger)">location permission missing</b>' : ''}${nst.gpsEnabled === false ? ' · <b style="color:var(--danger)">GPS is off</b>' : ''}` : '<b style="color:var(--danger)">not running on this phone</b>'}</div>` : ''}
        ${elsewhere ? '<div class="small" style="margin-top:4px;">This session is running on another device.</div>' : ''}
        ${a && Native.android() && nst.gpsEnabled === false ? '<button class="btn btn-sm" data-loc="gps" style="margin-top:6px;">Turn on GPS</button>' : ''}
        ${a && Native.android() && nst.permission === 'missing' ? '<button class="btn btn-sm" data-loc="appsettings" style="margin-top:6px;">Open app permissions</button>' : ''}
        ${Native.android() && window.AndroidBridge.isIgnoringBatteryOptimizations && !window.AndroidBridge.isIgnoringBatteryOptimizations() ? '<div class="small" style="margin-top:6px;">⚠ Some phones (Xiaomi, Vivo, Oppo, Realme) stop background apps to save battery. <a href="#" data-loc="battery">Allow MIHIR to run in the background</a>.</div>' : ''}
      </div>
      <div>${a ? `<button class="btn" data-loc="stop" ${S.myBusy ? 'disabled' : ''}>Stop work session</button>` : `<button class="btn btn-primary" data-loc="start" ${S.myBusy ? 'disabled' : ''}>▶ Start work session</button>`}</div>
    </div>
    ${myTimelineHTML()}
    <div class="card">
      <h3 style="margin-top:0;">Your privacy</h3>
      <div class="small muted" style="margin-bottom:8px;">Who can see your location: you; Admin${me.policy.viewers.directors ? '; Directors of your department' : ''}${me.policy.viewers.teamLeads ? '; your team lead' : ''}. Route points are deleted after ${me.policy.retentionDays} days.${me.policy.allowedHours ? ` Sessions can run ${esc(me.policy.allowedHours.start)}–${esc(me.policy.allowedHours.end)} and stop automatically after ${me.policy.maxSessionHours} h.` : ''}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;">
        <button class="btn btn-sm" data-loc="export">⬇ Download my location data</button>
        <button class="btn btn-sm" data-loc="policy">Read the notice again</button>
        <button class="btn btn-sm" data-loc="withdraw" style="color:var(--danger);">Withdraw consent</button>
      </div>
      ${S.showPolicy ? `<div class="loc-policy">${esc(me.policy.text)}</div>` : ''}
      <div class="small" style="font-weight:700;margin:10px 0 4px;">Who looked at your location</div>
      ${!S.myAccess ? '<div class="small muted">Loading…</div>' : !S.myAccess.length ? '<div class="small muted">Nobody else has viewed your location.</div>' : `
      <div class="table-wrap"><table class="loc-table"><thead><tr><th>When</th><th>Who</th><th>What</th></tr></thead><tbody>
        ${S.myAccess.slice(0, 50).map(l => `<tr><td>${fmtDT(l.created_at)}</td><td>${esc(l.viewer_name || l.viewer_username)} <span class="muted small">${esc(ROLE_LABEL[l.viewer_role] || l.viewer_role || '')}</span></td><td>${esc(l.detail || l.action)}</td></tr>`).join('')}
      </tbody></table></div>`}
    </div>`;
  }
  function consentHTML(me) {
    const again = me.consent.acceptedVersion != null || me.consent.acceptedAt;
    return `
    <div class="card loc-consent">
      <h3 style="margin-top:0;">📍 Location tracking — please read</h3>
      ${me.consent.acceptedVersion != null && me.consent.acceptedVersion !== me.consent.currentVersion ? '<div class="notice">The notice has changed since you last accepted it.</div>' : ''}
      <div class="loc-policy">${esc(me.policy.text)}</div>
      <ul class="small" style="margin:10px 0;">
        <li>Recorded <b>only</b> during work sessions you start yourself${me.policy.allowedHours ? `, between ${esc(me.policy.allowedHours.start)} and ${esc(me.policy.allowedHours.end)}` : ''}; sessions stop automatically after ${me.policy.maxSessionHours} hours.</li>
        <li>Visible to: you, Admin${me.policy.viewers.directors ? ', Directors of your department' : ''}${me.policy.viewers.teamLeads ? ', your team lead' : ''}. Every view is logged and shown to you.</li>
        <li>Route points are deleted after <b>${me.policy.retentionDays} days</b>.</li>
      </ul>
      <label style="display:flex;gap:8px;align-items:flex-start;font-weight:500;"><input type="checkbox" id="loc-consent-check" style="width:auto;margin-top:3px;"> I have read this and agree to share my location during the work sessions I start.</label>
      <div style="margin-top:10px;"><button class="btn btn-primary" data-loc="accept" data-version="${me.policy.version}">${again ? 'Accept the updated notice' : 'Accept'}</button></div>
    </div>`;
  }
  function myTimelineHTML() {
    const h = S.myHist;
    return `
    <div class="card">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px;">
        <h3 style="margin:0;flex:1;">Your day</h3>
        <input type="date" id="loc-my-day" value="${esc(S.myDay || today())}" style="width:auto;">
      </div>
      ${!h ? '<div class="small muted">Loading…</div>' : `
      <div class="loc-stats">
        <div><b>${(h.stats.distanceM / 1000).toFixed(1)} km</b><span>travelled</span></div>
        <div><b>${mins(h.stats.trackedMinutes)}</b><span>in sessions</span></div>
        <div><b>${mins(h.stats.movingMinutes)}</b><span>moving</span></div>
        <div><b>${h.stats.placesVisited}</b><span>places</span></div>
      </div>
      ${h.points.length ? mapSearchHTML() + '<div id="loc-map-mine" class="loc-map loc-map-small" data-morph-skip></div>' : '<div class="small muted" style="margin:8px 0;">No route recorded on this day.</div>'}
      ${visitsListHTML(h.visits, false)}`}
    </div>`;
  }
  function visitsListHTML(visits, withName) {
    if (!visits || !visits.length) return '<div class="small muted">No place visits.</div>';
    return `<div class="loc-timeline">${visits.map(v => `
      <div class="loc-tl-item"><div class="loc-tl-time">${fmtT(v.arrived_at)}<br><span class="muted">${v.departed_at ? fmtT(v.departed_at) : 'now'}</span></div>
      <div><b>${esc(v.place_name)}</b> <span class="small muted">${esc(KIND_LABEL[v.place_kind] || '')}${v.project ? ` · ${esc(v.project)}` : ''}</span>
      ${withName ? `<div class="small">${esc(v.name || v.username)}</div>` : ''}
      <div class="small muted">${v.departed_at ? mins((v.duration_s || 0) / 60) : 'still there'}</div></div></div>`).join('')}</div>`;
  }
  function bindMine() {
    const on = (sel, fn) => document.querySelectorAll(sel).forEach(b => { b.onclick = fn; });
    on('[data-loc="start"]', startWork);
    on('[data-loc="stop"]', () => { if (confirm('Stop the work session? Location recording stops now.')) stopWork(); });
    on('[data-loc="accept"]', async (e) => {
      const c = document.getElementById('loc-consent-check');
      if (!c || !c.checked) { setBanner('Tick the box to confirm you have read the notice.'); render(); return; }
      await load(() => api('/api/location/consent', { method: 'POST', body: JSON.stringify({ policyVersion: Number(e.currentTarget.dataset.version) }) }));
      refreshMe(true);
    });
    on('[data-loc="withdraw"]', async () => {
      if (!confirm('Withdraw consent? Any running work session stops and no location will be recorded until you accept the notice again.')) return;
      if (Native.available()) Native.stop();
      Web.stop();
      await load(() => api('/api/location/consent/withdraw', { method: 'POST' }));
      refreshMe(true);
    });
    on('[data-loc="policy"]', () => { S.showPolicy = !S.showPolicy; render(); });
    on('[data-loc="gps"]', () => { try { window.AndroidBridge.openLocationSettings(); } catch (e) { /* old app */ } });
    on('[data-loc="appsettings"]', () => { try { window.AndroidBridge.openAppSettings(); } catch (e) { /* old app */ } });
    on('[data-loc="battery"]', (e) => { e.preventDefault(); try { window.AndroidBridge.requestBackgroundPermission(); } catch (x) { /* old app */ } setTimeout(render, 1500); });
    on('[data-loc="export"]', async () => {
      const data = await load(() => api('/api/location/me/export', { timeoutMs: 180000 }));
      if (data) downloadDataUrl('data:application/json;base64,' + btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2)))), `my-location-data-${today()}.json`);
    });
    const day = document.getElementById('loc-my-day');
    if (day) day.onchange = () => { S.myDay = day.value; S.myHist = null; S.fitNext = true; loadMine(true); render(); };
  }
  async function loadMine(force) {
    if (!S.me || !S.me.consent || !S.me.consent.accepted) return;
    if (force || !S.myHist || Date.now() - S.myHistAt > 60000) {
      S.myHistAt = Date.now();
      try { S.myHist = await api(`/api/location/me/history?day=${S.myDay || today()}`); } catch (e) { S.myHist = { points: [], visits: [], stats: { distanceM: 0, trackedMinutes: 0, movingMinutes: 0, placesVisited: 0 } }; }
      render();
    }
    if (!S.myAccess || force) { try { S.myAccess = await api('/api/location/me/access-log'); render(); } catch (e) { /* ignore */ } }
  }

  // =========================================================================================
  // LOCATIONS (Admin / Directors / team leads)
  // =========================================================================================
  function tabsHTML() {
    const tabs = [['live', 'Live map'], ['history', 'History & replay'], ['places', 'Places'], ['reports', 'Reports'], ['alerts', 'Alerts']];
    if (S.me.isAdmin || S.me.indoorEnabled) tabs.push(['indoor', 'Indoor']);
    if (S.me.isAdmin) tabs.push(['settings', 'Privacy & policy']);
    return `<div class="loc-tabs">${tabs.map(([k, l]) => `<button class="loc-tab ${S.tab === k ? 'active' : ''}" data-loc-tab="${k}">${l}</button>`).join('')}</div>`;
  }
  function renderManager() {
    if (!S.me) return '<div class="card"><div class="empty">Loading…</div></div>';
    let body = '';
    if (S.tab === 'history') body = historyHTML();
    else if (S.tab === 'places') body = placesHTML();
    else if (S.tab === 'reports') body = reportsHTML();
    else if (S.tab === 'alerts') body = alertsHTML();
    else if (S.tab === 'indoor') body = indoorHTML();
    else if (S.tab === 'settings' && S.me.isAdmin) body = settingsHTML();
    else body = liveHTML();
    return tabsHTML() + body;
  }

  // ---------- live ----------
  function liveHTML() {
    const L = S.live;
    const people = L ? L.people.filter(p => !S.liveFilter || (p.name + ' ' + (p.team || '') + ' ' + (p.place ? p.place.name : '')).toLowerCase().includes(S.liveFilter.toLowerCase())) : [];
    const counts = {};
    if (L) L.people.forEach(p => { counts[p.status] = (counts[p.status] || 0) + 1; });
    return `
    <div class="loc-split">
      <div class="card loc-side">
        <div class="small muted" style="margin-bottom:6px;">${L ? `${L.people.length} in a work session now` : 'Loading…'} · updates every 15 s</div>
        <div class="loc-legend">${Object.entries(STATUS).filter(([k]) => counts[k]).map(([k, v]) => `<span><i style="background:${v.color}"></i>${v.label} ${counts[k]}</span>`).join('')}</div>
        <input type="search" id="loc-live-filter" placeholder="Search name, department, place…" value="${esc(S.liveFilter)}">
        <div class="loc-people">
          ${L && !L.people.length ? '<div class="small muted" style="padding:10px 0;">Nobody is in a work session right now. People appear here only while they have tracking switched on.</div>' : ''}
          ${people.map(p => `
          <button class="loc-person" data-loc-person="${esc(p.username)}">
            <i class="loc-dot" style="background:${STATUS[p.status].color}"></i>
            <span style="flex:1;min-width:0;text-align:left;"><b>${esc(p.name)}</b> <span class="muted small">${esc(p.team || '')}</span>
              <span class="small" style="display:block;">${p.place ? `${p.status === 'at_place' ? '' : `${STATUS[p.status].label} · last at `}${esc(p.place.name)}` : STATUS[p.status].label}${p.indoor ? ` · ${esc(p.indoor.floor)}${p.indoor.zone ? ` / ${esc(p.indoor.zone)}` : ''}` : ''}${p.speedKmh && p.status === 'moving' ? ` · ${Math.round(p.speedKmh)} km/h` : ''}</span>
              <span class="small muted" style="display:block;">${esc(ago(p.lastPointAt))}${p.accuracyM ? ` · ±${Math.round(p.accuracyM)} m` : ''}${p.battery != null ? ` · 🔋${Math.round(p.battery * 100)}%` : ''} · ${p.distanceKm} km</span></span>
          </button>`).join('')}
        </div>
      </div>
      <div class="card loc-map-card">${mapSearchHTML()}<div id="loc-map-live" class="loc-map" data-morph-skip></div></div>
    </div>`;
  }
  async function loadLive(force) {
    if (S.liveLoading) return;
    if (!force && S.live && Date.now() - S.liveAt < 15000) return;
    S.liveLoading = true;
    try {
      const r = await api('/api/location/live' + (S.liveV && !force ? `?v=${encodeURIComponent(S.liveV)}` : ''));
      S.liveAt = Date.now();
      if (!r.unchanged) { S.live = r; S.liveV = r.v; S.places = r.places; render(); }
    } catch (e) { /* keep last */ }
    finally { S.liveLoading = false; }
  }

  // ---------- history ----------
  function peopleOptions(selected) {
    const list = (userDirectory || []).slice().sort((a, b) => a.name.localeCompare(b.name));
    return `<option value="">— pick a person —</option>` + list.map(u => `<option value="${esc(u.username)}" ${u.username === selected ? 'selected' : ''}>${esc(u.name)}${u.team ? ` (${esc(u.team)})` : ''}</option>`).join('');
  }
  function historyHTML() {
    const H = S.hist;
    const d = H.data;
    const p = d && d.points[H.idx];
    return `
    <div class="card">
      <div class="row" style="align-items:flex-end;">
        <div class="col"><label>Person</label><select id="loc-h-user">${peopleOptions(H.username)}</select></div>
        <div class="col" style="max-width:190px;"><label>Day</label><input type="date" id="loc-h-day" value="${esc(H.day || today())}"></div>
      </div>
      ${H.loading ? '<div class="small muted" style="margin-top:8px;">Loading…</div>' : !H.username ? '<div class="small muted" style="margin-top:8px;">Pick a person to see their route. Viewing is logged and visible to them.</div>' : !d ? '' : `
      <div class="loc-stats" style="margin-top:10px;">
        <div><b>${(d.stats.distanceM / 1000).toFixed(1)} km</b><span>travelled</span></div>
        <div><b>${mins(d.stats.trackedMinutes)}</b><span>in sessions</span></div>
        <div><b>${mins(d.stats.movingMinutes)}</b><span>moving</span></div>
        <div><b>${d.stats.placesVisited}</b><span>places</span></div>
        <div><b>${d.totalPoints}</b><span>fixes</span></div>
      </div>`}
    </div>
    ${d && H.username ? `
    <div class="loc-split">
      <div class="card loc-side">
        <div class="small" style="font-weight:700;margin-bottom:6px;">Timeline</div>
        ${d.sessions.map(s => `<div class="small muted">▶ Session ${fmtT(s.started_at)} – ${s.ended_at ? fmtT(s.ended_at) : 'running'} · ${esc(s.platform || '')}${s.end_reason && s.end_reason !== 'user' ? ` · ${esc(s.end_reason.replace(/_/g, ' '))}` : ''}</div>`).join('') || '<div class="small muted">No work session this day.</div>'}
        <div style="margin-top:8px;">${visitsListHTML(d.visits, false)}</div>
        ${d.indoor && d.indoor.length ? `<div class="small" style="font-weight:700;margin:10px 0 4px;">Indoor</div>${indoorRunsHTML(d.indoor)}` : ''}
      </div>
      <div class="card loc-map-card">
        ${mapSearchHTML()}
        <div id="loc-map-history" class="loc-map" data-morph-skip></div>
        ${d.points.length > 1 ? `
        <div class="loc-replay">
          <button class="btn btn-sm" data-loc="play">${H.playing ? '⏸ Pause' : '▶ Replay'}</button>
          <input type="range" id="loc-h-slider" min="0" max="${d.points.length - 1}" value="${H.idx}">
          <span class="small" id="loc-h-at">${p ? `${fmtT(p.t)}${p.spd != null ? ` · ${Math.round(p.spd * 3.6)} km/h` : ''}` : ''}</span>
        </div>` : ''}
      </div>
    </div>` : ''}`;
  }
  function indoorRunsHTML(rows) {
    // Collapse consecutive positions in the same zone into "10:02–10:40 Design studio".
    const runs = [];
    for (const r of rows) {
      const key = `${r.floor_name}|${r.zone_name || ''}`;
      const last = runs[runs.length - 1];
      if (last && last.key === key) last.to = r.recorded_at; else runs.push({ key, from: r.recorded_at, to: r.recorded_at, floor: r.floor_name, zone: r.zone_name, method: r.method });
    }
    return runs.slice(-30).map(r => `<div class="small">${fmtT(r.from)}–${fmtT(r.to)} · ${esc(r.floor)}${r.zone ? ` / <b>${esc(r.zone)}</b>` : ''} <span class="muted">(${r.method === 'uwb' ? 'UWB' : 'BLE'})</span></div>`).join('');
  }
  async function loadHistory() {
    const H = S.hist;
    if (!H.username) return;
    H.loading = true; H.data = null; H.idx = 0; stopReplay(); render();
    try { H.data = await api(`/api/location/history?username=${encodeURIComponent(H.username)}&day=${H.day || today()}`); } catch (e) { setBanner(e.message); }
    H.loading = false; S.fitNext = true; render();
  }
  function stopReplay() { if (S.hist.playing) { clearInterval(S.hist.playing); S.hist.playing = null; } }
  function setReplay(i) {
    const d = S.hist.data; if (!d || !d.points.length) return;
    S.hist.idx = Math.max(0, Math.min(d.points.length - 1, i));
    const p = d.points[S.hist.idx];
    if (S.replayMarker) S.replayMarker.setLatLng([p.lat, p.lng]);
    const at = document.getElementById('loc-h-at'); if (at) at.textContent = `${fmtT(p.t)}${p.spd != null ? ` · ${Math.round(p.spd * 3.6)} km/h` : ''}`;
    const sl = document.getElementById('loc-h-slider'); if (sl && Number(sl.value) !== S.hist.idx) sl.value = S.hist.idx;
  }

  // ---------- places ----------
  function placesHTML() {
    const D = S.placeDraft;
    const editing = S.placeEditId != null;
    const canEdit = S.me.canManagePlaces;
    const projects = nameList(typeof projectsList !== 'undefined' ? projectsList : []);
    return `
    <div class="loc-split">
      <div class="card loc-side">
        ${canEdit ? (D ? `
        <div class="small" style="font-weight:700;">${editing ? 'Edit place' : 'New place'}</div>
        <div class="small muted" style="margin-bottom:6px;">${D.lat != null ? 'Click the map to move it; drag the slider for the size.' : '👉 Search for it above the map, or click on the map where the place is.'}</div>
        <label>Name</label><input type="text" id="loc-p-name" value="${esc(D.name || '')}" placeholder="e.g. Mihir Amara — Tower B">
        <div class="row"><div class="col"><label>Type</label><select id="loc-p-kind">${Object.entries(KIND_LABEL).map(([k, l]) => `<option value="${k}" ${D.kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="col"><label>Project</label><select id="loc-p-project"><option value="">—</option>${projects.map(p => `<option ${D.project === p ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select></div></div>
        <label>Radius: <b id="loc-p-r-label">${D.radiusM} m</b></label><input type="range" id="loc-p-radius" min="20" max="2000" step="10" value="${D.radiusM}">
        <div class="row"><div class="col"><label>Min. stay to count (min)</label><input type="number" id="loc-p-dwell" min="0" max="60" value="${Math.round((D.minDwellSeconds == null ? 120 : D.minDwellSeconds) / 60)}"></div>
        <div class="col"><label>&nbsp;</label><label style="display:flex;gap:6px;font-weight:500;"><input type="checkbox" id="loc-p-restricted" style="width:auto;" ${D.restricted ? 'checked' : ''}> Restricted</label></div></div>
        <label>Address / notes</label><input type="text" id="loc-p-address" value="${esc(D.address || '')}">
        <div style="display:flex;gap:8px;margin-top:8px;"><button class="btn btn-primary" data-loc="place-save">${editing ? 'Save' : 'Add place'}</button><button class="btn" data-loc="place-cancel">Cancel</button>
        ${editing ? '<button class="btn" data-loc="place-delete" style="color:var(--danger);margin-left:auto;">Delete</button>' : ''}</div>`
        : '<button class="btn btn-primary" data-loc="place-new" style="width:100%;">＋ Add a place</button>') : '<div class="small muted">Only Admin and Directors can add or change places.</div>'}
        <div class="small muted" style="margin:10px 0 4px;">Arrivals count after the minimum stay (drive-bys are ignored). Visits to a place tied to a project are linked to the person's open tasks in that project.</div>
        <div class="loc-people">
          ${(S.places || []).map(g => `<button class="loc-person" data-loc-place="${g.id}"><span style="flex:1;text-align:left;"><b>${esc(g.name)}</b> <span class="small muted">${esc(KIND_LABEL[g.kind] || g.kind)}${g.restricted ? ' · 🔒 restricted' : ''}</span>
            <span class="small muted" style="display:block;">${g.shape === 'polygon' ? 'outline' : `${Math.round(g.radius_m)} m`}${g.project ? ` · ${esc(g.project)}` : ''}</span></span></button>`).join('') || '<div class="small muted">No places yet.</div>'}
        </div>
      </div>
      <div class="card loc-map-card">${mapSearchHTML()}<div id="loc-map-places" class="loc-map" data-morph-skip></div></div>
    </div>`;
  }
  async function loadPlaces(force) {
    if (!force && S.places && Date.now() - S.placesAt < 60000) return;
    S.placesAt = Date.now();
    try { S.places = await api('/api/location/places'); render(); } catch (e) { /* ignore */ }
  }
  function readPlaceForm() {
    const D = S.placeDraft; if (!D) return;
    const v = (id) => { const el = document.getElementById(id); return el ? el.value : undefined; };
    D.name = v('loc-p-name'); D.kind = v('loc-p-kind'); D.project = v('loc-p-project'); D.address = v('loc-p-address');
    D.radiusM = Number(v('loc-p-radius')) || D.radiusM; D.minDwellSeconds = Math.round(Number(v('loc-p-dwell') || 0) * 60);
    const r = document.getElementById('loc-p-restricted'); D.restricted = r ? r.checked : false;
  }

  // ---------- reports ----------
  function reportsHTML() {
    const R = S.report; const d = R.data;
    const from = R.from || today(), to = R.to || today();
    return `
    <div class="card">
      <div class="row" style="align-items:flex-end;">
        <div class="col"><label>From</label><input type="date" id="loc-r-from" value="${esc(from)}"></div>
        <div class="col"><label>To</label><input type="date" id="loc-r-to" value="${esc(to)}"></div>
        <div class="col" style="flex:0;display:flex;gap:6px;"><button class="btn btn-primary" data-loc="report">Show</button><button class="btn" data-loc="report-csv">⬇ CSV</button></div>
      </div>
    </div>
    ${R.loading ? '<div class="card"><div class="small muted">Loading…</div></div>' : !d ? '' : `
    <div class="card"><h3 style="margin-top:0;">People</h3>
      <div class="table-wrap"><table class="loc-table"><thead><tr><th>Employee</th><th>Department</th><th>Sessions</th><th>Tracked</th><th>Distance</th><th>Place visits</th><th>At places</th><th>Places</th></tr></thead><tbody>
      ${d.byPerson.map(p => `<tr><td><a href="#" data-loc-hist="${esc(p.username)}">${esc(p.name)}</a></td><td>${esc(p.team)}</td><td>${p.sessions}</td><td>${mins(p.trackedMin)}</td><td>${p.distanceKm} km</td><td>${p.visits}</td><td>${mins(p.placeMin)}</td><td class="small">${esc(p.places.join(', '))}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">No tracked sessions in this period.</td></tr>'}
      </tbody></table></div></div>
    <div class="card"><h3 style="margin-top:0;">Places</h3>
      <div class="table-wrap"><table class="loc-table"><thead><tr><th>Place</th><th>Type</th><th>Project</th><th>Visits</th><th>People</th><th>Total time</th></tr></thead><tbody>
      ${d.byPlace.map(p => `<tr><td>${esc(p.name)}</td><td>${esc(KIND_LABEL[p.kind] || p.kind)}</td><td>${esc(p.project || '')}</td><td>${p.visits}</td><td>${p.people}</td><td>${mins(p.minutes)}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No visits in this period.</td></tr>'}
      </tbody></table></div></div>`}`;
  }
  function reportRange() {
    const f = document.getElementById('loc-r-from'), t = document.getElementById('loc-r-to');
    S.report.from = f ? f.value : today(); S.report.to = t ? t.value : today();
    const from = new Date(`${S.report.from}T00:00:00`), to = new Date(new Date(`${S.report.to}T00:00:00`).getTime() + DAY);
    return `from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`;
  }

  // ---------- alerts ----------
  function alertsHTML() {
    const D = S.ruleDraft;
    const teams = nameList(typeof teamsList !== 'undefined' ? teamsList : []);
    const users = (userDirectory || []).slice().sort((a, b) => a.name.localeCompare(b.name));
    return `
    ${S.me.isAdmin ? `
    <div class="card">
      <div style="display:flex;align-items:center;gap:8px;"><h3 style="margin:0;flex:1;">Alert rules</h3>${D ? '' : '<button class="btn btn-sm btn-primary" data-loc="rule-new">＋ New alert</button>'}</div>
      ${D ? `
      <div class="row" style="margin-top:8px;">
        <div class="col"><label>When someone…</label><select id="loc-a-kind">${Object.entries(RULE_LABEL).map(([k, l]) => `<option value="${k}" ${D.kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="col"><label>Name</label><input type="text" id="loc-a-name" value="${esc(D.name || '')}" placeholder="e.g. Site B arrivals"></div>
      </div>
      <div class="row">
        <div class="col"><label>Place (for arrive/leave)</label><select id="loc-a-place"><option value="">Any place</option>${(S.places || []).map(g => `<option value="${g.id}" ${String(D.placeId) === String(g.id) ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select></div>
        <div class="col"><label>Limit (km/h, minutes or hours)</label><input type="number" id="loc-a-threshold" value="${esc(D.threshold == null ? '' : D.threshold)}" placeholder="speeding / signal lost / overtime"></div>
      </div>
      <div class="row">
        <div class="col"><label>Only for departments <span class="muted small">(none = everyone)</span></label><select id="loc-a-deps" multiple size="4">${teams.map(t => `<option ${(D.departments || []).includes(t) ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></div>
        <div class="col"><label>Notify <span class="muted small">(none = all Admins)</span></label><select id="loc-a-recip" multiple size="4">${users.map(u => `<option value="${esc(u.username)}" ${(D.recipients || []).includes(u.username) ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></div>
      </div>
      <label style="display:flex;gap:6px;font-weight:500;"><input type="checkbox" id="loc-a-emp" style="width:auto;" ${D.notifyEmployee ? 'checked' : ''}> Also tell the employee (recommended for transparency)</label>
      <div style="display:flex;gap:8px;margin-top:8px;"><button class="btn btn-primary" data-loc="rule-save">Save alert</button><button class="btn" data-loc="rule-cancel">Cancel</button></div>` : ''}
      <div class="table-wrap" style="margin-top:10px;"><table class="loc-table"><thead><tr><th>Alert</th><th>When</th><th>Place / limit</th><th>Scope</th><th></th></tr></thead><tbody>
      ${(S.rules || []).map(r => `<tr><td>${esc(r.name)}</td><td>${esc(RULE_LABEL[r.kind] || r.kind)}</td><td>${esc(r.place_name || '')}${r.threshold != null ? ` ${r.threshold}` : ''}</td><td class="small">${esc((r.departments || []).join(', ') || 'everyone')} → ${esc((r.recipients || []).map(personName).join(', ') || 'Admins')}${r.notify_employee ? ' + employee' : ''}</td>
        <td><button class="btn btn-sm" data-loc-rule-del="${r.id}">Delete</button></td></tr>`).join('') || '<tr><td colspan="5" class="muted">No alert rules yet.</td></tr>'}
      </tbody></table></div>
    </div>` : ''}
    <div class="card"><h3 style="margin-top:0;">Recent alerts</h3>
      ${!S.alerts ? '<div class="small muted">Loading…</div>' : !S.alerts.length ? '<div class="small muted">No alerts.</div>' : `
      <div class="table-wrap"><table class="loc-table"><thead><tr><th>When</th><th>Alert</th><th></th></tr></thead><tbody>
      ${S.alerts.slice(0, 200).map(a => `<tr class="${a.acknowledged_at ? 'muted' : ''}"><td>${fmtDT(a.created_at)}</td><td>${esc(a.message)}</td><td>${a.acknowledged_at ? `✓ ${esc(personName(a.acknowledged_by))}` : `<button class="btn btn-sm" data-loc-ack="${a.id}">Seen</button>`}</td></tr>`).join('')}
      </tbody></table></div>`}
    </div>`;
  }
  async function loadAlerts() {
    try { S.alerts = await api('/api/location/alerts'); } catch (e) { /* ignore */ }
    if (S.me.isAdmin) { try { S.rules = await api('/api/location/alert-rules'); } catch (e) { /* ignore */ } }
    loadPlaces(); render();
  }

  // ---------- indoor ----------
  function indoorHTML() {
    const I = S.indoor;
    const f = I.floor;
    const plan = f && I.plans[f.id];
    return `
    <div class="card">
      <div class="small muted" style="margin-bottom:8px;">GPS cannot tell floors or rooms apart. Indoor positions come from <b>BLE beacons</b> (room/zone level, via the phone app) or a <b>UWB system</b> (desk level, pushed by the vendor's engine with an integration key). See docs/LOCATION_TRACKING.md → Indoor.</div>
      ${!S.me.indoorEnabled ? `<div class="notice">Indoor positioning is switched off${S.me.isAdmin ? ' — turn it on under Privacy & policy once beacons are installed.' : '.'}</div>` : ''}
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;">
        <div style="flex:1;min-width:200px;"><label>Floor</label><select id="loc-i-floor"><option value="">— pick a floor —</option>${(I.floors || []).map(x => `<option value="${x.id}" ${String(I.floorId) === String(x.id) ? 'selected' : ''}>${esc(x.place_name ? `${x.place_name} · ` : '')}${esc(x.name)} (${x.zones} zones, ${x.anchors} beacons)</option>`).join('')}</select></div>
        ${S.me.isAdmin ? '<button class="btn" data-loc="floor-new">＋ Add floor</button>' : ''}
      </div>
      ${S.me.isAdmin && I.newFloor ? `
      <div class="row" style="margin-top:8px;align-items:flex-end;">
        <div class="col"><label>Floor name</label><input type="text" id="loc-f-name" placeholder="e.g. Head office — 2nd floor"></div>
        <div class="col" style="max-width:90px;"><label>Level</label><input type="number" id="loc-f-level" value="0"></div>
        <div class="col"><label>Building (place)</label><select id="loc-f-place"><option value="">—</option>${(S.places || []).map(g => `<option value="${g.id}">${esc(g.name)}</option>`).join('')}</select></div>
      </div>
      <div class="row" style="align-items:flex-end;">
        <div class="col"><label>Floor plan image (PNG/JPG/SVG)</label><input type="file" id="loc-f-plan" accept="image/png,image/jpeg,image/webp,image/svg+xml"></div>
        <div class="col" style="max-width:220px;"><label>Scale: metres per pixel</label><input type="number" step="0.001" id="loc-f-scale" placeholder="e.g. 0.05"></div>
        <div class="col" style="flex:0;"><button class="btn btn-primary" data-loc="floor-save">Save floor</button></div>
      </div>` : ''}
    </div>
    ${f ? `
    <div class="card">
      ${S.me.isAdmin ? `
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;align-items:center;">
        <button class="btn btn-sm ${I.mode === 'zone' ? 'btn-primary' : ''}" data-loc="mode-zone">✏️ Draw zone</button>
        <button class="btn btn-sm ${I.mode === 'beacon' ? 'btn-primary' : ''}" data-loc="mode-beacon">📡 Place beacon</button>
        ${I.mode === 'zone' ? `<span class="small muted">Click the corners (${I.draft.length} so far), then</span>
          <input type="text" id="loc-z-name" placeholder="Zone name" style="width:150px;margin:0;">
          <select id="loc-z-kind" style="width:auto;margin:0;"><option value="room">Room</option><option value="desk">Desk</option><option value="area">Area</option><option value="corridor">Corridor</option><option value="restricted">Restricted</option></select>
          <button class="btn btn-sm btn-primary" data-loc="zone-save" ${I.draft.length < 3 ? 'disabled' : ''}>Save zone</button><button class="btn btn-sm" data-loc="zone-undo">Undo</button>` : ''}
        ${I.mode === 'beacon' ? '<span class="small muted">Click where the beacon is mounted.</span>' : ''}
        <button class="btn btn-sm" data-loc="floor-delete" style="margin-left:auto;color:var(--danger);">Delete floor</button>
      </div>` : ''}
      <div class="loc-floor-wrap">
        ${plan ? `<div class="loc-floor" id="loc-floor" style="aspect-ratio:${f.width_px || 1000}/${f.height_px || 600};">
          <img src="${plan}" alt="Floor plan" draggable="false">
          <svg viewBox="0 0 ${f.width_px || 1000} ${f.height_px || 600}" preserveAspectRatio="none">
            ${f.zones.map(z => `<polygon points="${z.polygon.map(p => p.join(',')).join(' ')}" class="loc-zone ${z.restricted ? 'restricted' : ''} ${z.kind}"><title>${esc(z.name)}</title></polygon>
              <text x="${z.polygon.reduce((s, p) => s + p[0], 0) / z.polygon.length}" y="${z.polygon.reduce((s, p) => s + p[1], 0) / z.polygon.length}" class="loc-zone-label">${esc(z.name)}</text>`).join('')}
            ${f.anchors.map(a => `<circle cx="${a.x}" cy="${a.y}" r="${(f.width_px || 1000) / 140}" class="loc-anchor"><title>${esc(a.label || a.identifier)}${a.last_seen_at ? ` · seen ${ago(a.last_seen_at)}` : ' · never seen'}</title></circle>`).join('')}
            ${I.draft.length ? `<polyline points="${I.draft.map(p => p.join(',')).join(' ')}" class="loc-draft"/>${I.draft.map(p => `<circle cx="${p[0]}" cy="${p[1]}" r="${(f.width_px || 1000) / 200}" class="loc-draft-pt"/>`).join('')}` : ''}
            ${I.live.map(p => `<g><circle cx="${p.x}" cy="${p.y}" r="${(f.width_px || 1000) / 90}" class="loc-person-dot ${p.method}"/><text x="${p.x}" y="${p.y - (f.width_px || 1000) / 60}" class="loc-person-label">${esc(p.name.split(' ')[0])}</text></g>`).join('')}
          </svg>
        </div>` : '<div class="small muted">Loading floor plan…</div>'}
      </div>
      <div class="small muted" style="margin-top:6px;">${I.live.length ? `${I.live.length} people on this floor now (last 5 min).` : 'Nobody positioned on this floor in the last 5 minutes.'} ${f.meters_per_px ? `Scale ${f.meters_per_px} m/px.` : 'No scale set — accuracy in metres can\'t be shown.'}</div>
      ${S.me.isAdmin ? `
      <details style="margin-top:10px;"><summary class="small">Zones (${f.zones.length}) and beacons (${f.anchors.length})</summary>
        <div class="table-wrap"><table class="loc-table"><tbody>
        ${f.zones.map(z => `<tr><td>Zone</td><td>${esc(z.name)}</td><td>${esc(z.kind)}${z.restricted ? ' · restricted' : ''}</td><td><button class="btn btn-sm" data-loc-zone-del="${z.id}">Delete</button></td></tr>`).join('')}
        ${f.anchors.map(a => `<tr><td>Beacon</td><td>${esc(a.label || '')}<div class="small muted">${esc(a.identifier)}</div></td><td>${a.last_seen_at ? `seen ${esc(ago(a.last_seen_at))}` : '<span style="color:var(--danger)">never seen</span>'}</td><td><button class="btn btn-sm" data-loc-anchor-del="${a.id}">Delete</button></td></tr>`).join('')}
        </tbody></table></div>
      </details>` : ''}
    </div>` : ''}
    ${S.me.isAdmin ? `
    <div class="card">
      <h3 style="margin-top:0;">UWB / RTLS badges & integration</h3>
      <div class="small muted">Desk-level positioning needs a UWB system (e.g. Pozyx, Sewio, Quuppa, Kontakt.io). Assign each badge to a person, then let the vendor's engine POST positions to <code>/api/location/indoor/rtls</code> with an integration key. Positions are kept only while that person has a work session on.</div>
      <div class="row" style="align-items:flex-end;margin-top:8px;">
        <div class="col"><label>Badge / tag id</label><input type="text" id="loc-t-id" placeholder="as shown by the vendor"></div>
        <div class="col"><label>Person</label><select id="loc-t-user">${peopleOptions('')}</select></div>
        <div class="col" style="flex:0;"><button class="btn" data-loc="tag-save">Assign</button></div>
      </div>
      ${(S.tags || []).length ? `<div class="small">${S.tags.map(t => `${esc(t.tag_id)} → ${esc(personName(t.username))} <a href="#" data-loc-tag-del="${esc(t.tag_id)}">remove</a>`).join(' · ')}</div>` : ''}
      <div style="display:flex;gap:8px;align-items:flex-end;margin-top:10px;">
        <div style="flex:1;"><label>New integration key name</label><input type="text" id="loc-k-name" placeholder="e.g. Pozyx — head office"></div>
        <button class="btn" data-loc="key-new">Create key</button>
      </div>
      ${S.newKey ? `<div class="notice" style="word-break:break-all;">Copy this key now — it is shown only once:<br><code>${esc(S.newKey)}</code></div>` : ''}
      ${(S.keys || []).map(k => `<div class="small">${esc(k.name)} <code>${esc(k.key_prefix)}…</code> · ${k.revoked_at ? 'revoked' : `last used ${k.last_used_at ? esc(ago(k.last_used_at)) : 'never'} · <a href="#" data-loc-key-del="${k.id}">revoke</a>`}</div>`).join('')}
    </div>` : ''}`;
  }
  async function loadIndoor(force) {
    const I = S.indoor;
    if (!I.floors || force) { try { I.floors = await api('/api/location/indoor/floors'); } catch (e) { I.floors = []; } }
    if (S.me.isAdmin && (!S.tags || force)) { try { S.tags = await api('/api/location/indoor/tags'); S.keys = await api('/api/location/integration-keys'); } catch (e) { /* ignore */ } }
    loadPlaces();
    if (I.floorId && (!I.floor || String(I.floor.id) !== String(I.floorId) || force)) {
      try {
        I.floor = await api(`/api/location/indoor/floors/${I.floorId}`);
        if (!I.plans[I.floorId]) { const pl = await api(`/api/location/indoor/floors/${I.floorId}/plan`).catch(() => null); I.plans[I.floorId] = pl ? pl.data : 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="600"><rect width="1000" height="600" fill="#eee"/><text x="500" y="300" text-anchor="middle" font-size="30" fill="#999">No floor plan uploaded</text></svg>'); }
      } catch (e) { setBanner(e.message); }
    }
    if (I.floorId && S.me.indoorEnabled) { try { I.live = await api(`/api/location/indoor/live?floorId=${I.floorId}`); I.liveAt = Date.now(); } catch (e) { I.live = []; } }
    render();
  }
  function floorClick(ev) {
    const I = S.indoor, f = I.floor;
    if (!f || !I.mode) return;
    const box = document.getElementById('loc-floor');
    const r = box.getBoundingClientRect();
    const x = Math.round(((ev.clientX - r.left) / r.width) * (f.width_px || 1000));
    const y = Math.round(((ev.clientY - r.top) / r.height) * (f.height_px || 600));
    if (I.mode === 'zone') { I.draft.push([x, y]); render(); return; }
    if (I.mode === 'beacon') {
      const id = prompt('iBeacon id as UUID:major:minor (printed on the beacon or in its app):');
      if (!id) return;
      const label = prompt('Label (e.g. "Meeting room door")') || '';
      load(() => api(`/api/location/indoor/floors/${f.id}/anchors`, { method: 'POST', body: JSON.stringify({ identifier: id.trim(), label, x, y }) })).then(() => loadIndoor(true));
    }
  }
  function readFile(file) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); }); }
  function imageSize(dataUrl) { return new Promise((res) => { const im = new Image(); im.onload = () => res({ w: im.naturalWidth || 1000, h: im.naturalHeight || 600 }); im.onerror = () => res({ w: 1000, h: 600 }); im.src = dataUrl; }); }

  // ---------- settings / privacy (Admin) ----------
  function settingsHTML() {
    const s = S.settings;
    if (!s) return '<div class="card"><div class="small muted">Loading…</div></div>';
    const teams = nameList(typeof teamsList !== 'undefined' ? teamsList : []);
    const num = (id, val, label, min, max) => `<div class="col"><label>${label}</label><input type="number" id="${id}" min="${min}" max="${max}" value="${val}"></div>`;
    return `
    <div class="card">
      <h3 style="margin-top:0;">Notice shown to employees (version ${s.policyVersion})</h3>
      <div class="small muted">Changing the text creates a new version — everyone must accept it again before their next session.</div>
      <textarea id="loc-s-policy" rows="9">${esc(s.policyText)}</textarea>
    </div>
    <div class="card">
      <h3 style="margin-top:0;">When and who</h3>
      <div class="row">
        <div class="col"><label>Sessions allowed from</label><input type="time" id="loc-s-start" value="${esc(s.allowedHours ? s.allowedHours.start : '')}"></div>
        <div class="col"><label>until (IST)</label><input type="time" id="loc-s-end" value="${esc(s.allowedHours ? s.allowedHours.end : '')}"></div>
        ${num('loc-s-maxh', s.maxSessionHours, 'Auto-stop after (hours)', 1, 24)}
      </div>
      <label>Departments that use tracking <span class="muted small">(none selected = all)</span></label>
      <select id="loc-s-deps" multiple size="5">${teams.map(t => `<option ${s.trackedDepartments.includes(t) ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
      <label style="display:flex;gap:6px;font-weight:500;"><input type="checkbox" id="loc-s-dir" style="width:auto;" ${s.directorsCanView ? 'checked' : ''}> Directors can see their departments</label>
      <label style="display:flex;gap:6px;font-weight:500;"><input type="checkbox" id="loc-s-tl" style="width:auto;" ${s.teamLeadsCanView ? 'checked' : ''}> Team leads can see their department</label>
      <label style="display:flex;gap:6px;font-weight:500;"><input type="checkbox" id="loc-s-indoor" style="width:auto;" ${s.indoorEnabled ? 'checked' : ''}> Indoor positioning (beacons / UWB) is installed and switched on</label>
    </div>
    <div class="card">
      <h3 style="margin-top:0;">Accuracy & battery</h3>
      <div class="row">${num('loc-s-mov', s.movingIntervalSec, 'Fix every (s) when moving', 5, 300)}${num('loc-s-stat', s.stationaryIntervalSec, 'Fix every (s) when still', 30, 1800)}${num('loc-s-dist', s.distanceFilterM, 'Min. movement (m)', 5, 500)}</div>
      <div class="row">${num('loc-s-up', s.uploadEverySec, 'Upload every (s)', 15, 900)}${num('loc-s-acc', s.maxAccuracyM, 'Ignore fixes worse than (m)', 10, 500)}${num('loc-s-lost', s.signalLostMin, '"Signal lost" after (min)', 5, 240)}</div>
    </div>
    <div class="card">
      <h3 style="margin-top:0;">Retention (deleted automatically every night)</h3>
      <div class="row">${num('loc-s-rp', s.retention.pointsDays, 'Route points (days)', 1, 3650)}${num('loc-s-rv', s.retention.visitsDays, 'Visits & sessions (days)', 1, 3650)}${num('loc-s-ri', s.retention.indoorDays, 'Indoor positions (days)', 1, 3650)}${num('loc-s-ra', s.retention.accessLogDays, 'Access log (days)', 90, 3650)}</div>
      <button class="btn btn-primary" data-loc="settings-save">Save policy</button>
    </div>
    <div class="card">
      <h3 style="margin-top:0;">Map search</h3>
      <div class="small muted" style="margin-bottom:8px;">Services used, in order: <b>${esc(((S.me.map && S.me.map.searchLabels) || []).join(' → ') || 'none (only coordinates and links)')}</b>. Saved places, coordinates and Google Maps links always work. Settings are on the server (GEOCODER, GOOGLE_MAPS_API_KEY, MAPTILER_KEY) — see the Maps Guide.</div>
      <div class="row" style="align-items:flex-end;"><div class="col"><label>Test search</label><input id="loc-gt-q" value="${esc(S.geoTestQ || 'Shivajinagar, Pune')}"></div><div class="col" style="flex:0;"><button class="btn" data-loc="geo-test">${S.geoTest === 'loading' ? 'Testing…' : 'Test map search'}</button></div></div>
      ${S.geoTest && S.geoTest !== 'loading' ? `<table class="loc-table" style="margin-top:8px;"><thead><tr><th>Service</th><th>Result</th><th>Time</th></tr></thead><tbody>
        ${(S.geoTest.providers || []).map(r => `<tr><td>${esc(r.label || r.provider)}</td><td>${r.ok ? (r.results ? `✅ ${r.results} found — ${esc(r.first || '')}` : '⚠️ answered, nothing found') : `❌ ${esc(r.error || 'failed')}`}</td><td>${r.ms} ms</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No street-search service is set up.</td></tr>'}
      </tbody></table>` : ''}
      ${S.geoTestErr ? `<div class="small" style="color:var(--danger);margin-top:6px;">${esc(S.geoTestErr)}</div>` : ''}
    </div>
    <div class="card">
      <h3 style="margin-top:0;">A person's data</h3>
      <div class="row" style="align-items:flex-end;">
        <div class="col"><label>Person</label><select id="loc-d-user">${peopleOptions('')}</select></div>
        <div class="col" style="flex:0;display:flex;gap:6px;"><button class="btn" data-loc="data-export">⬇ Export</button><button class="btn" data-loc="data-delete" style="color:var(--danger);">Delete all location data</button></div>
      </div>
    </div>
    <div class="card">
      <h3 style="margin-top:0;">Access log — who viewed whose location</h3>
      ${!S.accessLog ? '<div class="small muted">Loading…</div>' : `<div class="table-wrap"><table class="loc-table"><thead><tr><th>When</th><th>Viewer</th><th>Person</th><th>What</th></tr></thead><tbody>
        ${S.accessLog.slice(0, 300).map(l => `<tr><td>${fmtDT(l.created_at)}</td><td>${esc(personName(l.viewer_username))}</td><td>${esc(personName(l.subject_username))}</td><td>${esc(l.detail || l.action)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Nothing yet.</td></tr>'}
      </tbody></table></div>`}
    </div>`;
  }

  // ---------- task block (Places & visits on a task) ----------
  function taskBlock(t) {
    if (!isOn() || !t || !t.id) return '';
    const c = S.tasks.get(t.id);
    if (!c) { S.tasks.set(t.id, { loading: true }); api(`/api/location/tasks/${encodeURIComponent(t.id)}`).then(d => { S.tasks.set(t.id, { data: d, at: Date.now() }); render(); }).catch(() => S.tasks.set(t.id, { data: null, at: Date.now() })); return ''; }
    if (!c.data) return '';
    const d = c.data;
    const canTie = session.role === 'admin' || session.role === 'director' || t.created_by_username === session.username;
    if (!d.places.length && !d.visits.length && !canTie) return '';
    const avail = (S.places || []).filter(g => !d.places.some(p => p.id === g.id));
    return `
    <div class="loc-taskblock">
      <div class="small muted" style="font-weight:700;">📍 Places & site visits</div>
      ${d.places.map(p => `<div class="small">${esc(KIND_LABEL[p.kind] || '')} <b>${esc(p.name)}</b>${p.purpose ? ` — ${esc(p.purpose)}` : ''}${canTie ? ` <a href="#" data-loc-untie="${esc(t.id)}" data-place="${p.id}">remove</a>` : ''}</div>`).join('')}
      ${d.visits.map(v => `<div class="small">✓ ${esc(v.name)} at ${esc(v.place_name)} · ${fmtDT(v.arrived_at)}${v.departed_at ? `–${fmtT(v.departed_at)} (${mins((v.duration_s || 0) / 60)})` : ' · still there'} <span class="muted">${v.how === 'manual' ? 'checked in' : v.how === 'project' ? 'project site' : ''}</span></div>`).join('')}
      ${canTie && t.status === 'open' ? `<div style="display:flex;gap:6px;margin-top:4px;"><select id="loc-tie-${esc(t.id)}" style="margin:0;" data-loc-load-places><option value="">Tie this task to a place…</option>${avail.map(g => `<option value="${g.id}">${esc(g.name)}</option>`).join('')}</select><button class="btn btn-sm" data-loc-tie="${esc(t.id)}">Add</button></div>` : ''}
    </div>`;
  }

  // ---------- map ----------
  let leafletLoading = null;
  function ensureLeaflet() {
    if (window.L && window.L.map) return Promise.resolve();
    if (leafletLoading) return leafletLoading;
    leafletLoading = new Promise((resolve, reject) => {
      const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = '/vendor/leaflet/leaflet.css'; document.head.appendChild(css);
      const js = document.createElement('script'); js.src = '/vendor/leaflet/leaflet.js'; js.onload = resolve; js.onerror = () => { leafletLoading = null; reject(new Error('Map library failed to load')); };
      document.head.appendChild(js);
    });
    return leafletLoading;
  }
  function mapEl() { return document.querySelector('[id^="loc-map-"]'); }
  function syncMap() {
    const el = mapEl();
    const drop = () => { try { S.map.remove(); } catch (e) { /* container already emptied */ } if (S.mapEl) delete S.mapEl._leaflet_id; S.map = null; S.sig = ''; S.replayMarker = null; S.pinLayer = null; };
    if (!el) { if (S.map) { drop(); S.mapEl = null; S.mapId = null; } return; }
    // The page redraw can reuse the same <div> for a different map (Live → Places): it changes the id
    // and empties Leaflet's contents. Treat that as a new map, not the old one.
    if (S.map && (S.mapEl !== el || S.mapId !== el.id || !el.classList.contains('leaflet-container'))) drop();
    if (!S.map) {
      ensureLeaflet().then(() => {
        if (mapEl() !== el || S.map) return;
        const m = S.me.map || {};
        S.map = L.map(el, { zoomControl: true, attributionControl: true }).setView([18.52, 73.86], 11);
        L.tileLayer(m.tileUrl || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: m.attribution || '&copy; OpenStreetMap contributors' }).addTo(S.map);
        S.layer = L.layerGroup().addTo(S.map);
        S.pinLayer = L.layerGroup().addTo(S.map);
        S.mapEl = el; S.mapId = el.id; S.fitNext = !S.msearch.pin; S.sig = '';
        drawSearchPin(true);
        S.map.on('click', (e) => {
          if (el.id === 'loc-map-places' && S.placeDraft) { readPlaceForm(); S.placeDraft.lat = e.latlng.lat; S.placeDraft.lng = e.latlng.lng; render(); }
        });
        setTimeout(() => { if (S.map) S.map.invalidateSize(); }, 50);
        drawMap();
      }).catch(e => { el.innerHTML = `<div class="small muted" style="padding:20px;">${esc(e.message)}</div>`; });
      return;
    }
    drawMap();
  }
  function placeShape(g, opts) {
    if (g.shape === 'polygon' && Array.isArray(g.polygon) && g.polygon.length >= 3) return L.polygon(g.polygon, opts);
    return L.circle([g.center_lat, g.center_lng], { radius: g.radius_m, ...opts });
  }
  function drawMap() {
    if (!S.map || !window.L) return;
    const id = S.mapEl.id;
    const places = S.places || (S.live && S.live.places) || [];
    let sig = id + '|' + places.map(g => `${g.id}:${g.center_lat}:${g.center_lng}:${g.radius_m}`).join(',');
    if (id === 'loc-map-live') sig += '|' + (S.live ? S.live.people.map(p => `${p.username}:${p.lat}:${p.lng}:${p.status}`).join(',') : '');
    if (id === 'loc-map-history') sig += '|' + (S.hist.data ? `${S.hist.username}:${S.hist.day}:${S.hist.data.points.length}` : '');
    if (id === 'loc-map-places') sig += '|' + JSON.stringify(S.placeDraft || {});
    if (id === 'loc-map-mine') sig += '|' + (S.myHist ? `${S.myDay}:${S.myHist.points.length}` : '');
    if (sig === S.sig) return;
    S.sig = sig;
    S.layer.clearLayers();
    S.replayMarker = null;
    const bounds = [];
    for (const g of places) {
      const shape = placeShape(g, { color: g.restricted ? '#d64545' : '#1f9d55', weight: 1.5, fillOpacity: 0.08 }).bindTooltip(`${g.name}`, { sticky: true });
      shape.addTo(S.layer);
      if (id === 'loc-map-places') { shape.on('click', (e) => { L.DomEvent.stopPropagation(e); editPlace(g.id); }); bounds.push([g.center_lat, g.center_lng]); }
    }
    if (id === 'loc-map-live' && S.live) {
      for (const p of S.live.people) {
        if (p.lat == null) continue;
        const col = STATUS[p.status].color;
        if (p.accuracyM && p.accuracyM > 15) L.circle([p.lat, p.lng], { radius: p.accuracyM, color: col, weight: 0, fillOpacity: 0.12 }).addTo(S.layer);
        L.circleMarker([p.lat, p.lng], { radius: 8, color: '#fff', weight: 2, fillColor: col, fillOpacity: 1 })
          .bindTooltip(`<b>${esc(p.name)}</b><br>${esc(p.place ? p.place.name : STATUS[p.status].label)}<br>${esc(ago(p.lastPointAt))}`, { direction: 'top' })
          .on('click', () => { S.tab = 'history'; S.hist.username = p.username; S.hist.day = today(); loadHistory(); })
          .addTo(S.layer);
        bounds.push([p.lat, p.lng]);
      }
    }
    const route = (pts) => {
      if (!pts || !pts.length) return;
      const ll = pts.map(p => [p.lat, p.lng]);
      L.polyline(ll, { color: '#2d5fa8', weight: 4, opacity: 0.85 }).addTo(S.layer);
      L.circleMarker(ll[0], { radius: 6, color: '#fff', weight: 2, fillColor: '#1f9d55', fillOpacity: 1 }).bindTooltip(`Start ${fmtT(pts[0].t)}`).addTo(S.layer);
      L.circleMarker(ll[ll.length - 1], { radius: 6, color: '#fff', weight: 2, fillColor: '#d64545', fillOpacity: 1 }).bindTooltip(`Last ${fmtT(pts[pts.length - 1].t)}`).addTo(S.layer);
      ll.forEach(x => bounds.push(x));
    };
    if (id === 'loc-map-history' && S.hist.data) {
      route(S.hist.data.points);
      const p = S.hist.data.points[S.hist.idx];
      if (p) S.replayMarker = L.circleMarker([p.lat, p.lng], { radius: 9, color: '#fff', weight: 3, fillColor: '#ff8a00', fillOpacity: 1 }).addTo(S.layer);
    }
    if (id === 'loc-map-mine' && S.myHist) route(S.myHist.points);
    if (id === 'loc-map-places' && S.placeDraft && S.placeDraft.lat != null) {
      L.circle([S.placeDraft.lat, S.placeDraft.lng], { radius: S.placeDraft.radiusM, color: '#ff8a00', weight: 2, dashArray: '6 4', fillOpacity: 0.15 }).addTo(S.layer);
    }
    if (S.fitNext && bounds.length) {
      S.fitNext = false;
      if (bounds.length === 1) S.map.setView(bounds[0], 15); else S.map.fitBounds(bounds, { padding: [30, 30], maxZoom: 17 });
    }
  }
  // ---------- place search on the maps ----------
  // Searches saved places instantly in the browser, then asks the server (/api/location/geocode),
  // which reads typed coordinates and Google Maps links itself and looks up addresses with the
  // configured search provider. Picking a result centres the map and drops an orange pin; on the
  // Places tab it also positions the place being added or edited.
  function mapSearchHTML() {
    const M = S.msearch;
    const list = M.results;
    const src = list ? [...new Set(list.filter(r => !r.saved && r.source && r.source !== 'typed').map(r => r.source))] : [];
    const open = M.loading || list || M.error || M.note;
    return `<div class="loc-msearch">
      <input type="search" id="loc-msearch-q" autocomplete="off" spellcheck="false" placeholder="Search a place, project, landmark or address — or paste coordinates / a Google Maps link" value="${esc(M.q)}" aria-label="Search the map">
      ${open ? `<div class="loc-msearch-list" role="listbox">
        ${M.query ? `<div class="small muted" style="padding:6px 12px 0;">No exact match — showing results for “${esc(M.query)}”.</div>` : ''}
        ${(list || []).map((r, i) => `<button type="button" class="loc-msearch-item${r.saved ? ' saved' : ''}" data-msearch-i="${i}" role="option">
          <b>${r.saved ? '📍 ' : r.type === 'coordinates' ? '🎯 ' : ''}${esc(r.name)}</b><span class="small muted">${esc(r.saved ? `Saved place · ${KIND_LABEL[r.kind] || ''}${r.address ? ` · ${r.address}` : ''}` : (r.address || ''))}</span></button>`).join('')}
        ${M.loading ? `<div class="small muted" style="padding:8px 12px;">${list && list.length ? 'Searching streets and landmarks…' : 'Searching…'}</div>` : ''}
        ${!M.loading && list && !list.length && !M.error && !M.note ? '<div class="small muted" style="padding:8px 12px;">Nothing found. Add the area or city (e.g. “Baner Pune”), check the spelling, or paste coordinates / a Google Maps link.</div>' : ''}
        ${M.note ? `<div class="small" style="padding:8px 12px;color:var(--muted);">ℹ️ ${esc(M.note)}</div>` : ''}
        ${M.error ? `<div class="small" style="padding:8px 12px;color:var(--danger);">${esc(M.error)}</div>` : ''}
        ${src.length ? `<div class="small muted" style="padding:4px 12px 6px;">Search results © ${esc(src.join(', '))}</div>` : ''}
      </div>` : ''}
    </div>`;
  }
  let msearchTimer = null;
  function localSaved(q) {
    const words = q.toLowerCase().split(/[^a-z0-9\u0900-\u097f]+/).filter(Boolean);
    return (S.places || (S.live && S.live.places) || []).filter(g => { const hay = `${g.name || ''} ${g.project || ''} ${g.address || ''}`.toLowerCase(); return words.every(w => hay.includes(w)); }).slice(0, 5)
      .map(g => ({ name: g.name, address: [g.project ? `Project: ${g.project}` : '', g.address || ''].filter(Boolean).join(' · '), lat: g.center_lat, lng: g.center_lng, saved: true, kind: g.kind, placeId: g.id, type: 'saved' }));
  }
  async function runMapSearch() {
    const M = S.msearch;
    const q = M.q.trim();
    if (q.length < 2) { M.results = null; M.error = null; M.note = null; M.query = null; M.loading = false; render(); return; }
    const seq = ++M.seq;
    // Saved places show at once; the server's answer (saved + streets) replaces them when it arrives.
    M.results = localSaved(q); M.loading = true; M.error = null; M.note = null; M.query = null; render();
    try {
      const c = S.map ? S.map.getCenter() : null;
      const r = await api(`/api/location/geocode?q=${encodeURIComponent(q)}${c ? `&lat=${c.lat.toFixed(4)}&lng=${c.lng.toFixed(4)}` : ''}`);
      if (seq !== M.seq) return; // a newer search has started
      M.results = r.results || []; M.note = r.note || null; M.query = r.query || null;
    } catch (e) {
      if (seq !== M.seq) return;
      M.error = e.message;
    }
    M.loading = false; render();
  }
  function pickSearchResult(r) {
    const M = S.msearch;
    M.results = null; M.error = null; M.note = null; M.query = null; M.q = r.name;
    M.pin = { lat: r.lat, lng: r.lng, name: r.name, address: r.address || '', saved: !!r.saved, placeId: r.placeId };
    if (r.saved && S.mapEl && S.mapEl.id === 'loc-map-places' && S.me.canManagePlaces && !S.placeDraft) { M.pin = null; editPlace(r.placeId); return; }
    if (S.placeDraft && S.mapEl && S.mapEl.id === 'loc-map-places') {
      readPlaceForm();
      S.placeDraft.lat = r.lat; S.placeDraft.lng = r.lng;
      if (!S.placeDraft.name && !/^-?\d+(\.\d+)?, -?\d/.test(r.name)) S.placeDraft.name = r.name;
      if (!S.placeDraft.address && r.address && r.type !== 'coordinates') S.placeDraft.address = r.address.slice(0, 300);
    }
    S.fitNext = false;
    render();
    if (S.map) S.map.setView([r.lat, r.lng], r.type === 'coordinates' ? 18 : 16);
    drawSearchPin(false);
  }
  function drawSearchPin(quiet) {
    if (!S.map || !S.pinLayer || !window.L) return;
    S.pinLayer.clearLayers();
    const pin = S.msearch.pin; if (!pin) return;
    const onPlaces = S.mapEl && S.mapEl.id === 'loc-map-places';
    const canAdd = onPlaces && S.me.canManagePlaces && !S.placeDraft && !pin.saved;
    const html = `<b>${esc(pin.name)}</b>${pin.address ? `<br><span style="font-size:11px;">${esc(pin.address)}</span>` : ''}<br><span style="font-size:11px;">${pin.lat.toFixed(5)}, ${pin.lng.toFixed(5)}</span>
      <div style="margin-top:6px;display:flex;gap:6px;">${canAdd ? '<button type="button" class="btn btn-sm btn-primary" data-msearch-add>Add as a place</button>' : ''}<button type="button" class="btn btn-sm" data-msearch-clear>Clear pin</button></div>`;
    const mk = L.circleMarker([pin.lat, pin.lng], { radius: 9, color: '#fff', weight: 3, fillColor: '#ff8a00', fillOpacity: 1 }).bindPopup(html).addTo(S.pinLayer);
    mk.on('popupopen', (e) => {
      const root = e.popup.getElement(); if (!root) return;
      const add = root.querySelector('[data-msearch-add]');
      if (add) add.onclick = () => { const p = S.msearch.pin; S.placeEditId = null; S.placeDraft = { name: p.name, kind: 'site', project: '', address: (p.address || '').slice(0, 300), radiusM: 150, minDwellSeconds: 120, restricted: false, lat: p.lat, lng: p.lng }; S.msearch.pin = null; S.map.closePopup(); drawSearchPin(true); render(); };
      const clr = root.querySelector('[data-msearch-clear]');
      if (clr) clr.onclick = () => { S.msearch.pin = null; S.msearch.q = ''; S.map.closePopup(); drawSearchPin(true); render(); };
    });
    if (!quiet) mk.openPopup();
    else if (S.fitNext === false && !S.sig) S.map.setView([pin.lat, pin.lng], 16);
  }
  function bindMapSearch() {
    const inp = document.getElementById('loc-msearch-q');
    if (!inp) return;
    const M = S.msearch;
    const close = () => { M.results = null; M.error = null; M.note = null; M.query = null; M.loading = false; M.seq++; render(); };
    inp.oninput = () => { M.q = inp.value; clearTimeout(msearchTimer); if (M.q.trim().length < 2) { close(); return; } msearchTimer = setTimeout(runMapSearch, 500); };
    inp.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); clearTimeout(msearchTimer); const first = M.results && M.results[0]; if (first && !M.loading && M.q === inp.value) pickSearchResult(first); else { M.q = inp.value; runMapSearch(); } }
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowDown') { const b = document.querySelector('[data-msearch-i]'); if (b) { e.preventDefault(); b.focus(); } }
    };
    document.querySelectorAll('[data-msearch-i]').forEach(b => {
      b.onclick = () => { const r = (M.results || [])[Number(b.dataset.msearchI)]; if (r) pickSearchResult(r); };
      b.onkeydown = (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const to = e.key === 'ArrowDown' ? b.nextElementSibling : b.previousElementSibling; if (to && to.matches('[data-msearch-i]')) to.focus(); else if (e.key === 'ArrowUp') inp.focus(); }
        if (e.key === 'Escape') { inp.focus(); close(); }
      };
    });
  }
  function editPlace(id) {
    const g = (S.places || []).find(x => String(x.id) === String(id));
    if (!g || !S.me.canManagePlaces) return;
    S.placeEditId = g.id;
    S.placeDraft = { name: g.name, kind: g.kind, project: g.project || '', address: g.address || '', radiusM: Math.round(g.radius_m), minDwellSeconds: g.min_dwell_seconds, restricted: g.restricted, lat: g.center_lat, lng: g.center_lng };
    S.fitNext = false; render();
    if (S.map) S.map.setView([g.center_lat, g.center_lng], 16);
  }

  // ---------- binding for the manager pages ----------
  function bindManager() {
    const on = (sel, fn) => document.querySelectorAll(sel).forEach(b => { b.onclick = fn; });
    on('[data-loc-tab]', (e) => { S.tab = e.currentTarget.dataset.locTab; S.fitNext = true; try { safeStorage.setItem('loc_tab', S.tab); } catch (x) { /* ignore */ } stopReplay(); render(); loadForTab(true); });
    const f = document.getElementById('loc-live-filter');
    if (f) f.oninput = () => { S.liveFilter = f.value; render(); };
    on('[data-loc-person]', (e) => { const u = e.currentTarget.dataset.locPerson; const p = S.live && S.live.people.find(x => x.username === u); if (p && p.lat != null && S.map) S.map.setView([p.lat, p.lng], 16); });
    document.querySelectorAll('[data-loc-person]').forEach(b => { b.ondblclick = () => { S.tab = 'history'; S.hist.username = b.dataset.locPerson; S.hist.day = today(); loadHistory(); }; });
    // history
    const hu = document.getElementById('loc-h-user'), hd = document.getElementById('loc-h-day');
    if (hu) hu.onchange = () => { S.hist.username = hu.value; loadHistory(); };
    if (hd) hd.onchange = () => { S.hist.day = hd.value; loadHistory(); };
    const sl = document.getElementById('loc-h-slider');
    if (sl) sl.oninput = () => { stopReplay(); setReplay(Number(sl.value)); };
    on('[data-loc="play"]', () => {
      if (S.hist.playing) { stopReplay(); render(); return; }
      const d = S.hist.data; if (!d) return;
      if (S.hist.idx >= d.points.length - 1) S.hist.idx = 0;
      S.hist.playing = setInterval(() => { if (!S.hist.data || S.hist.idx >= S.hist.data.points.length - 1 || S.tab !== 'history' || ui.adminTab !== 'locations') { stopReplay(); render(); return; } setReplay(S.hist.idx + 1); }, 120);
      render();
    });
    on('[data-loc-hist]', (e) => { e.preventDefault(); S.tab = 'history'; S.hist.username = e.currentTarget.dataset.locHist; S.hist.day = S.report.to || today(); loadHistory(); });
    // places
    on('[data-loc="place-new"]', () => { S.placeEditId = null; S.placeDraft = { kind: 'site', radiusM: 150, minDwellSeconds: 120, lat: null, lng: null }; render(); });
    on('[data-loc="place-cancel"]', () => { S.placeDraft = null; S.placeEditId = null; render(); });
    on('[data-loc-place]', (e) => editPlace(e.currentTarget.dataset.locPlace));
    on('[data-loc="geo-test"]', () => {
      const qi = document.getElementById('loc-gt-q'); S.geoTestQ = qi ? qi.value : ''; S.geoTest = 'loading'; S.geoTestErr = null; render();
      api(`/api/location/geocode/test?q=${encodeURIComponent(S.geoTestQ)}`).then(r => { S.geoTest = r; render(); }).catch(e => { S.geoTest = null; S.geoTestErr = e.message; render(); });
    });
    const rad = document.getElementById('loc-p-radius');
    if (rad) rad.oninput = () => { if (!S.placeDraft) return; S.placeDraft.radiusM = Number(rad.value); const lb = document.getElementById('loc-p-r-label'); if (lb) lb.textContent = `${rad.value} m`; S.sig = ''; drawMap(); };
    on('[data-loc="place-save"]', async () => {
      readPlaceForm();
      const D = S.placeDraft;
      if (D.lat == null) { setBanner('Click on the map to set where the place is.'); render(); return; }
      const body = { name: D.name, kind: D.kind, project: D.project || null, address: D.address || null, radiusM: D.radiusM, minDwellSeconds: D.minDwellSeconds, restricted: D.restricted, lat: D.lat, lng: D.lng };
      const r = await load(() => api(S.placeEditId != null ? `/api/location/places/${S.placeEditId}` : '/api/location/places', { method: S.placeEditId != null ? 'PUT' : 'POST', body: JSON.stringify(body) }));
      if (r) { S.placeDraft = null; S.placeEditId = null; setBanner('Place saved.', 'ok'); await loadPlaces(true); }
    });
    on('[data-loc="place-delete"]', async () => {
      if (!confirm('Delete this place? Its visit history is deleted too.')) return;
      const r = await load(() => api(`/api/location/places/${S.placeEditId}`, { method: 'DELETE' }));
      if (r) { S.placeDraft = null; S.placeEditId = null; await loadPlaces(true); }
    });
    // reports
    on('[data-loc="report"]', async () => {
      const qs = reportRange(); S.report.loading = true; render();
      try { S.report.data = await api(`/api/location/reports/summary?${qs}`); } catch (e) { setBanner(e.message); }
      S.report.loading = false; render();
    });
    on('[data-loc="report-csv"]', async () => {
      const qs = reportRange();
      try {
        const res = await fetch(`/api/location/reports/summary?${qs}&format=csv`, { headers: { Authorization: 'Bearer ' + token } });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not build the report.');
        const text = await res.text();
        downloadDataUrl('data:text/csv;charset=utf-8;base64,' + btoa(unescape(encodeURIComponent(text))), `location-report-${S.report.from}-to-${S.report.to}.csv`);
      } catch (e) { setBanner(e.message); render(); }
    });
    // alerts
    on('[data-loc="rule-new"]', () => { S.ruleDraft = { kind: 'arrive', notifyEmployee: true }; loadPlaces(); render(); });
    on('[data-loc="rule-cancel"]', () => { S.ruleDraft = null; render(); });
    on('[data-loc="rule-save"]', async () => {
      const v = (id) => (document.getElementById(id) || {}).value;
      const multi = (id) => Array.from((document.getElementById(id) || { selectedOptions: [] }).selectedOptions).map(o => o.value);
      const body = { kind: v('loc-a-kind'), name: v('loc-a-name'), placeId: v('loc-a-place') || null, threshold: v('loc-a-threshold'), departments: multi('loc-a-deps'), recipients: multi('loc-a-recip'), notifyEmployee: !!(document.getElementById('loc-a-emp') || {}).checked };
      const r = await load(() => api('/api/location/alert-rules', { method: 'POST', body: JSON.stringify(body) }));
      if (r) { S.ruleDraft = null; loadAlerts(); }
    });
    on('[data-loc-rule-del]', async (e) => { if (confirm('Delete this alert rule?')) { await load(() => api(`/api/location/alert-rules/${e.currentTarget.dataset.locRuleDel}`, { method: 'DELETE' })); loadAlerts(); } });
    on('[data-loc-ack]', async (e) => { await load(() => api(`/api/location/alerts/${e.currentTarget.dataset.locAck}/ack`, { method: 'POST' })); loadAlerts(); });
    // indoor
    const fl = document.getElementById('loc-i-floor');
    if (fl) fl.onchange = () => { S.indoor.floorId = fl.value || null; S.indoor.floor = null; S.indoor.draft = []; S.indoor.mode = null; S.indoor.live = []; loadIndoor(); };
    on('[data-loc="floor-new"]', () => { S.indoor.newFloor = !S.indoor.newFloor; loadPlaces(); render(); });
    on('[data-loc="floor-save"]', async () => {
      const name = (document.getElementById('loc-f-name') || {}).value;
      const file = (document.getElementById('loc-f-plan') || {}).files;
      const body = { name, level: Number((document.getElementById('loc-f-level') || {}).value || 0), placeId: (document.getElementById('loc-f-place') || {}).value || null, metersPerPx: (document.getElementById('loc-f-scale') || {}).value || null };
      if (file && file[0]) { body.planImage = await readFile(file[0]); const sz = await imageSize(body.planImage); body.widthPx = sz.w; body.heightPx = sz.h; }
      const r = await load(() => api('/api/location/indoor/floors', { method: 'POST', body: JSON.stringify(body), timeoutMs: 180000 }));
      if (r) { S.indoor.newFloor = false; S.indoor.floorId = r.id; S.indoor.floor = null; loadIndoor(true); }
    });
    on('[data-loc="floor-delete"]', async () => { if (confirm('Delete this floor with all its zones, beacons and positions?')) { await load(() => api(`/api/location/indoor/floors/${S.indoor.floorId}`, { method: 'DELETE' })); S.indoor.floorId = null; S.indoor.floor = null; loadIndoor(true); } });
    on('[data-loc="mode-zone"]', () => { S.indoor.mode = S.indoor.mode === 'zone' ? null : 'zone'; S.indoor.draft = []; render(); });
    on('[data-loc="mode-beacon"]', () => { S.indoor.mode = S.indoor.mode === 'beacon' ? null : 'beacon'; render(); });
    on('[data-loc="zone-undo"]', () => { S.indoor.draft.pop(); render(); });
    on('[data-loc="zone-save"]', async () => {
      const body = { name: (document.getElementById('loc-z-name') || {}).value || 'Zone', kind: (document.getElementById('loc-z-kind') || {}).value, polygon: S.indoor.draft };
      const r = await load(() => api(`/api/location/indoor/floors/${S.indoor.floorId}/zones`, { method: 'POST', body: JSON.stringify(body) }));
      if (r) { S.indoor.draft = []; loadIndoor(true); }
    });
    const fb = document.getElementById('loc-floor'); if (fb) fb.onclick = floorClick;
    on('[data-loc-zone-del]', async (e) => { await load(() => api(`/api/location/indoor/zones/${e.currentTarget.dataset.locZoneDel}`, { method: 'DELETE' })); loadIndoor(true); });
    on('[data-loc-anchor-del]', async (e) => { await load(() => api(`/api/location/indoor/anchors/${e.currentTarget.dataset.locAnchorDel}`, { method: 'DELETE' })); loadIndoor(true); });
    on('[data-loc="tag-save"]', async () => {
      const r = await load(() => api('/api/location/indoor/tags', { method: 'POST', body: JSON.stringify({ tagId: (document.getElementById('loc-t-id') || {}).value, username: (document.getElementById('loc-t-user') || {}).value }) }));
      if (r) loadIndoor(true);
    });
    on('[data-loc-tag-del]', async (e) => { e.preventDefault(); await load(() => api(`/api/location/indoor/tags/${encodeURIComponent(e.currentTarget.dataset.locTagDel)}`, { method: 'DELETE' })); loadIndoor(true); });
    on('[data-loc="key-new"]', async () => {
      const r = await load(() => api('/api/location/integration-keys', { method: 'POST', body: JSON.stringify({ name: (document.getElementById('loc-k-name') || {}).value }) }));
      if (r) { S.newKey = r.key; loadIndoor(true); }
    });
    on('[data-loc-key-del]', async (e) => { e.preventDefault(); if (confirm('Revoke this key? The vendor system stops being able to send positions.')) { await load(() => api(`/api/location/integration-keys/${e.currentTarget.dataset.locKeyDel}`, { method: 'DELETE' })); loadIndoor(true); } });
    // settings
    on('[data-loc="settings-save"]', async () => {
      const v = (id) => (document.getElementById(id) || {}).value;
      const n = (id) => Number(v(id));
      const st = v('loc-s-start'), en = v('loc-s-end');
      const body = {
        policyText: v('loc-s-policy'), allowedHours: st && en ? { start: st, end: en } : null, maxSessionHours: n('loc-s-maxh'),
        trackedDepartments: Array.from((document.getElementById('loc-s-deps') || { selectedOptions: [] }).selectedOptions).map(o => o.value),
        directorsCanView: !!(document.getElementById('loc-s-dir') || {}).checked, teamLeadsCanView: !!(document.getElementById('loc-s-tl') || {}).checked, indoorEnabled: !!(document.getElementById('loc-s-indoor') || {}).checked,
        movingIntervalSec: n('loc-s-mov'), stationaryIntervalSec: n('loc-s-stat'), distanceFilterM: n('loc-s-dist'), uploadEverySec: n('loc-s-up'), maxAccuracyM: n('loc-s-acc'), signalLostMin: n('loc-s-lost'),
        retention: { pointsDays: n('loc-s-rp'), visitsDays: n('loc-s-rv'), indoorDays: n('loc-s-ri'), accessLogDays: n('loc-s-ra') },
      };
      const r = await load(() => api('/api/location/settings', { method: 'PUT', body: JSON.stringify(body) }));
      if (r) { S.settings = r; setBanner('Policy saved.', 'ok'); refreshMe(true); render(); }
    });
    on('[data-loc="data-export"]', async () => {
      const u = (document.getElementById('loc-d-user') || {}).value; if (!u) return;
      const data = await load(() => api(`/api/location/export?username=${encodeURIComponent(u)}`, { timeoutMs: 180000 }));
      if (data) downloadDataUrl('data:application/json;base64,' + btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2)))), `location-data-${u}.json`);
    });
    on('[data-loc="data-delete"]', async () => {
      const u = (document.getElementById('loc-d-user') || {}).value; if (!u) return;
      if (prompt(`This permanently deletes ALL location data of ${personName(u)} (sessions, routes, visits, indoor positions). Type DELETE to confirm.`) !== 'DELETE') return;
      const r = await load(() => api(`/api/location/data/${encodeURIComponent(u)}`, { method: 'DELETE' }));
      if (r) { setBanner('Deleted.', 'ok'); render(); }
    });
  }
  function bindTaskBlocks() {
    document.querySelectorAll('[data-loc-tie]').forEach(b => { b.onclick = async () => {
      const id = b.dataset.locTie; const sel = document.getElementById(`loc-tie-${id}`);
      if (!sel || !sel.value) return;
      const r = await load(() => api(`/api/location/tasks/${encodeURIComponent(id)}/places`, { method: 'POST', body: JSON.stringify({ placeId: Number(sel.value) }) }));
      if (r) { S.tasks.delete(id); render(); }
    }; });
    document.querySelectorAll('[data-loc-untie]').forEach(a => { a.onclick = async (e) => {
      e.preventDefault();
      const id = a.dataset.locUntie;
      await load(() => api(`/api/location/tasks/${encodeURIComponent(id)}/places/${a.dataset.place}`, { method: 'DELETE' }));
      S.tasks.delete(id); render();
    }; });
    if (document.querySelector('[data-loc-load-places]') && !S.places) loadPlaces();
  }

  // ---------- page data ----------
  function loadForTab(force) {
    if (ui.adminTab === 'mytracking') { loadMine(force); return; }
    if (ui.adminTab !== 'locations' || !canManage()) return;
    if (S.tab === 'live') loadLive(force);
    else if (S.tab === 'places') loadPlaces(force);
    else if (S.tab === 'alerts') loadAlerts();
    else if (S.tab === 'indoor') loadIndoor(force);
    else if (S.tab === 'settings' && S.me.isAdmin) {
      if (!S.settings || force) api('/api/location/settings').then(s => { S.settings = s; render(); }).catch(() => {});
      if (!S.accessLog || force) api('/api/location/access-log').then(l => { S.accessLog = l; render(); }).catch(() => {});
    } else if (S.tab === 'history') { if (!S.hist.day) S.hist.day = today(); loadPlaces(); }
  }

  let lastTab = null;
  function afterRender() {
    if (typeof appFeatures === 'undefined' || !appFeatures.locationTracking || !token || !session) {
      if (S.map) { S.map.remove(); S.map = null; }
      if (Web.running()) Web.stop(true);
      return;
    }
    if (!S.me || Date.now() - S.meAt > 60000) refreshMe();
    if (ui.adminTab === 'mytracking') bindMine();
    if (ui.adminTab === 'locations') bindManager();
    bindTaskBlocks();
    bindMapSearch();
    if (ui.adminTab !== lastTab) { lastTab = ui.adminTab; S.fitNext = true; if (S.me) loadForTab(true); }
    syncMap();
  }

  // Background refresh: live map every 15 s, indoor every 20 s, own status every 30 s.
  setInterval(() => {
    if (!token || !session || typeof appFeatures === 'undefined' || !appFeatures.locationTracking || document.hidden) return;
    if (ui.adminTab === 'locations' && S.tab === 'live') loadLive();
    if (ui.adminTab === 'mytracking' && Date.now() - S.myHistAt > 60000) loadMine();
    if (ui.adminTab === 'locations' && S.tab === 'indoor' && S.indoor.floorId && Date.now() - S.indoor.liveAt > 20000) loadIndoor();
    if (Date.now() - S.meAt > 30000) refreshMe();
  }, 5000);
  // Flush queued browser fixes when the connection comes back / the page is being hidden.
  window.addEventListener('online', () => Web.flush());
  document.addEventListener('visibilitychange', () => { if (document.hidden) Web.flush(); else { refreshMe(true).then(resumeNativeIfNeeded); } });
  try { S.tab = safeStorage.getItem('loc_tab') || 'live'; } catch (e) { /* ignore */ }
  setTimeout(() => { refreshMe(true).then(resumeNativeIfNeeded); }, 1500);

  window.LocationUI = { navGroups, statusPill, renderMine, renderManager, afterRender, taskBlock, isOn, canManage, _state: S, _web: Web };
})();
