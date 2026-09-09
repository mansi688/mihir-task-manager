/* ==================== STATE ==================== */
let token = localStorage.getItem('ls_token') || null;
let session = JSON.parse(localStorage.getItem('ls_session') || 'null');
let myTasks = [];
let allTasks = [];       // Admin only
let userDirectory = [];
let teamsList = [];
let projectsList = [];
let sectionsList = [];
let phasesList = [];
let currentProjectDrawings = []; // results of the last "Fetch Drawings" click
let openTaskTitles = []; // {id,title} for every open task company-wide — powers the Depends On picker
let completionStats = []; // admin-only: weekly/monthly/yearly/all-time approved-task counts per employee
let ratingsData = []; // admin/director: transparent quarterly rating per employee
let approvalDecisionsDetail = []; // admin/director: every individual approve/reject decision made
let auditLogEntries = []; // admin-only
let myApprovalRequests = [];
let allApprovalRequests = []; // admin-only
let approvalStats = []; // admin-only
let monthlyLeaderboard = { leaderboard: [], periodLabel: '' };
let weeklyLeaderboard = { leaderboard: [], periodLabel: '' };
let quarterAwards = []; let yearAwards = [];
let peakHoursData = []; // admin-only
let myDashboardData = null;
let hrDashboardData = null;
let hrRosterData = [];
let hrTotalTasksCompleted = 0;
let reportsTaskList = []; // admin-only
let currentTaskReport = null;
let myNotifications = [];
let unreadNotifCount = 0;
let theme = localStorage.getItem('ks_theme') || 'light';
document.documentElement.setAttribute('data-theme', theme);
function setTheme(t) { theme = t; localStorage.setItem('ks_theme', t); document.documentElement.setAttribute('data-theme', t); render(); }

function defaultUiState() {
  return {
    adminTab: 'today', sidebarOpen: false, notifDrawerOpen: false, banner: null,
    loginErr: '', pwChangeErr: '', showForgotPassword: false, forgotPasswordStage: 'request', forgotPasswordErr: '', forgotPasswordUsername: '', showPasswordChangeModal: true,
    pendingTaskFile: null, pendingTaskFileName: null,
    pendingReplyFiles: {},
    taskArchiveTab: 'open',
    taskFormOpen: false, taskFormIsDrawing: false, taskFormTags: [],
    taskFormStages: [{ usernames: [] }], taskFormAutoRelease: false,
    followupFormTaskId: null, followupFormTags: [],
    subtaskFormTaskId: null, subtaskFormTags: [],
    cancelFormTaskId: null,
    addAssigneeFormTaskId: null, addAssigneeTags: [],
    taskSearchQuery: '', taskFilterProject: '', taskFilterPhase: '',
    myHistoryShown: 20, allHistoryShown: 20,
    calendarYear: new Date().getFullYear(), calendarMonth: new Date().getMonth(),
    calendarSelectedDate: null, calendarScope: 'mine',
    calendarViewMode: 'month', calendarWeekStart: null, calendarWeekSelectedTaskId: null,
    approvalFormOpen: false, approvalFormReviewers: [],
    peakHoursUser: 'all', peakHoursSelectedHour: null,
    reportsSelectedTaskId: null,
    dashboardViewUser: null, accountsDeptFilter: '', hrDashboardSelectedUser: null, hrDashboardDeptFilter: '', performanceDeptFilter: '',
    auditLogFilterAction: null,
    auditLogExpandedRow: null, auditLogSearchQuery: '',
    reopenFormTaskId: null,
    pendingApprovalFile: null, pendingApprovalFileName: null,
    pendingRevisionFiles: {}, approvalsScope: 'mine',
    drawingsProjectQuery: '', drawingsSearchedProject: '', drawingsSectionFilter: '',
    pendingDrawingFile: null, pendingDrawingFileName: null,
  };
}
let ui = defaultUiState();
// Restore the tab the person was actually on before a browser refresh — a plain in-memory `ui`
// variable resets to its default ('today') on every page reload, which is exactly why refreshing
// used to silently bounce everyone back to the main page instead of staying where they were.
// Deliberately only restores when a session already exists (token is set) — a genuine fresh
// login should still always land on 'today', matching the existing intentional reset at login.
if (token) {
  const savedTab = localStorage.getItem('ls_last_tab');
  if (savedTab) ui.adminTab = savedTab;
  // Same idea as the tab restore above: once someone has dismissed the temporary-password
  // reminder, it should stay dismissed across refreshes too, not reappear and feel like the old
  // hard block all over again — it should only come back if they explicitly click "Set a real
  // password now" from the banner.
  if (localStorage.getItem('ls_pw_reminder_dismissed') === 'true') ui.showPasswordChangeModal = false;
}
function resetAllAppState() {
  myTasks = []; allTasks = []; userDirectory = []; teamsList = []; projectsList = []; sectionsList = []; phasesList = []; currentProjectDrawings = []; openTaskTitles = []; completionStats = []; ratingsData = []; approvalDecisionsDetail = []; auditLogEntries = []; myApprovalRequests = []; allApprovalRequests = []; approvalStats = []; monthlyLeaderboard = { leaderboard: [], periodLabel: '' }; weeklyLeaderboard = { leaderboard: [], periodLabel: '' }; peakHoursData = []; myDashboardData = null; hrDashboardData = null; hrRosterData = []; reportsTaskList = []; currentTaskReport = null; myNotifications = []; unreadNotifCount = 0;
  ui = defaultUiState();
}

/* ==================== DAILY QUOTE ====================
   Picked deterministically by day-of-year, so everyone sees the SAME quote on a given day (not
   a random one per page load), and it changes automatically every day with no scheduler needed. */
const DAILY_QUOTES = [
  'A building is only as strong as the foundation it stands on.',
  'Measure twice, cut once.',
  'Great things are never done alone — they\'re done by a team.',
  'Every big project started as a single step.',
  'Quality is never an accident; it is the result of careful planning.',
  'Well begun is half done.',
  'Discipline today builds tomorrow.',
  'Small delays compound — momentum matters as much as effort.',
  'Plans get you started; people get you finished.',
  'What gets measured gets managed.',
  'The way to get started is to quit talking and begin doing.',
  'Quality means doing it right when no one is looking.',
  'A good plan violently executed now is better than a perfect plan next week.',
  'Discipline is choosing between what you want now and what you want most.',
  'Well done is better than well said.',
  'Success is the sum of small efforts, repeated day in and day out.',
  'It always seems impossible until it\'s done.',
  'Details create the big picture.',
  'Do not wait for the perfect moment — take the moment and make it perfect.',
  'The best time to plant a tree was 20 years ago. The second best time is now.',
  'Great things are done by a series of small things brought together.',
  'Every accomplishment starts with the decision to try.',
  'Excellence is not an act but a habit.',
  'Small daily improvements are the key to staggering long-term results.',
  'A goal without a plan is just a wish.',
  'What is not started today is never finished tomorrow.',
  'The secret of getting ahead is getting started.',
  'Hard work beats talent when talent doesn\'t work hard.',
  'You don\'t have to be great to start, but you have to start to be great.',
  'Every day is a chance to build something better than yesterday.',
  'Precision today prevents rework tomorrow.',
  'A strong foundation forgives no shortcuts.',
  'Coordination beats speed when everyone is building the same thing.',
  'The site remembers every corner that was cut.',
  'Clear communication moves faster than any crane.',
  'Ownership is doing it right even when no one signed off yet.',
  'A problem flagged early is half a problem solved.',
  'Every handoff is a promise — keep it clean.',
  'Consistency is what turns a plan into a building.',
  'The best schedules leave room for the unexpected.',
  'Trust is built the same way a wall is — one verified layer at a time.',
  'What you inspect, you can improve.',
  'Good documentation today saves a difficult conversation later.',
  'Momentum is a team effort, not a solo sprint.',
  'The strongest structures are the ones nobody worries about.',
  'A task well-handed-off is a task half-finished, well done.',
  'Attention to detail is invisible until it\'s missing.',
  'Every deadline met is trust earned for the next one.',
  'Progress hides in the boring, repeated work.',
  'Ask the question now — it\'s cheaper than the fix later.',
  'The team that communicates early rarely firefights late.',
  'Reliable is rarer than fast, and worth more.',
  'A tidy site reflects a tidy plan.',
  'Nothing is finished until it\'s verified.',
  'Good work is quiet — it just gets done, on time.',
  'The fastest path through a blocker is naming it out loud.',
  'Every checklist item is a promise to your future self.',
  'Craftsmanship shows in what nobody was told to check.',
];
function dayOfYear(d) { const start = new Date(d.getFullYear(), 0, 0); return Math.floor((d - start) / 86400000); }
// A small, stable hash of the username so different people see different quotes at the exact
// same hour — otherwise everyone in the company would see the identical line simultaneously.
// A real bug found and fixed against actual company data: this used to check only for the
// substring "hr", which misses a department genuinely named "Human Resource(s)" — a very
// plausible real-world department name that contains no "hr" substring at all. Checks both.
function isHRTeamName(team) {
  const t = (team || '').toLowerCase();
  return t.includes('hr') || t.includes('human resource');
}
function stringHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; }
  return Math.abs(h);
}
function currentQuote() {
  const now = new Date();
  const hourIndex = dayOfYear(now) * 24 + now.getHours();
  const userOffset = session && session.username ? stringHash(session.username) : 0;
  return DAILY_QUOTES[(hourIndex + userOffset) % DAILY_QUOTES.length];
}

/* ==================== ICONS ==================== */
const ICONS = {
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  eye: '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a18.6 18.6 0 0 1 5.06-5.94M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a18.6 18.6 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><path d="M1 1l22 22"/>',
  grid: '<path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z"/>',
  clipboard: '<path d="M9 3h6v3H9z"/><path d="M6 5h12v16H6z"/><path d="M9 11h6M9 15h6"/>',
  users: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="18" cy="9" r="2.6"/><path d="M15.5 13.2c2.4.4 4.5 2.5 4.5 5.3"/>',
  bell: '<path d="M6 10a6 6 0 0112 0c0 4 1.5 5.5 2 6.5H4c.5-1 2-2.5 2-6.5z"/><path d="M10 20a2 2 0 004 0"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V7a4 4 0 018 0v4"/>',
  logout: '<path d="M14 4h4a1 1 0 011 1v14a1 1 0 01-1 1h-4"/><path d="M3 12h13M12 8l4 4-4 4"/>',
  sun: '<circle cx="12" cy="12" r="4.5"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 019.5 4a8.5 8.5 0 1010.5 10.5z"/>',
  alertTriangle: '<path d="M12 3l10 18H2z"/><path d="M12 10v4M12 17.5v0"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9"/>',
  pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/>',
};
function icon(name, size) {
  return `<svg viewBox="0 0 24 24" width="${size || 17}" height="${size || 17}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
}
function falconMark() { return `<img src="/logo.png" alt="Logo" style="width:100%;height:100%;object-fit:contain;padding:4px;" onerror="this.style.display='none'">`; }
function themeToggleHTML() {
  return `
  <div class="theme-toggle">
    <button data-theme-btn="light" class="${theme === 'light' ? 'active' : ''}" title="Light mode">${icon('sun', 14)}</button>
    <button data-theme-btn="dark" class="${theme === 'dark' ? 'active' : ''}" title="Dark mode">${icon('moon', 14)}</button>
    <div class="thumb"></div>
  </div>`;
}
function bindThemeToggle() { document.querySelectorAll('[data-theme-btn]').forEach(b => b.onclick = () => setTheme(b.dataset.themeBtn)); }
function passwordFieldHTML(id, placeholder, extraAttrs) {
  return `<div style="position:relative;">
    <input type="password" id="${id}" placeholder="${esc(placeholder || '')}" style="padding-right:38px;" ${extraAttrs || ''}>
    <button type="button" data-pw-toggle="${id}" tabindex="-1" style="position:absolute;right:4px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;padding:6px;color:var(--muted);display:flex;" title="Show password">${icon('eye', 16)}</button>
  </div>`;
}
function bindPasswordToggles() {
  document.querySelectorAll('[data-pw-toggle]').forEach(btn => btn.onclick = (e) => {
    e.preventDefault();
    const input = document.getElementById(btn.dataset.pwToggle);
    if (!input) return;
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    btn.innerHTML = icon(showing ? 'eye' : 'eyeOff', 16);
  });
}

/* ==================== UTILITIES ==================== */
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(path, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
  let data = {};
  try { data = await res.json(); } catch (e) { /* no body */ }
  if (res.status === 401 && token) {
    token = null; session = null;
    localStorage.removeItem('ls_token'); localStorage.removeItem('ls_session');
    resetAllAppState();
    const msg = data.error || 'Your session expired. Please log in again.';
    setTimeout(() => { setBanner(msg, 'err'); render(); }, 0);
    throw new Error(msg);
  }
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
  return data;
}
let bannerTimer = null;
function setBanner(msg, kind) {
  if (bannerTimer) { clearTimeout(bannerTimer); bannerTimer = null; }
  ui.banner = msg ? { msg, kind: kind || 'err' } : null;
  if (msg) bannerTimer = setTimeout(() => { ui.banner = null; bannerTimer = null; render(); }, kind === 'ok' ? 4000 : 8000);
}
// Separate wording pools per action, so the popup always matches what actually just happened —
// raising a new task reads differently from finishing your part, which reads differently from
// the task being fully closed out.
// Wording kept clean and professional rather than casual/celebratory — a construction-company
// tool should confirm completion clearly, not throw a party. Still distinct per action (raising
// vs. completing your part vs. closing the whole task) so the confirmation always matches what
// actually just happened.
const RAISE_MESSAGES = ['Task created.', 'New task logged.', 'Task added to the board.', 'Task submitted.', 'Ready to go.'];
const COMPLETION_MESSAGES = ['Your part is complete.', 'Submitted successfully.', 'Logged and complete.', 'Task step completed.', 'Nicely done.'];
const CLOSE_MESSAGES = ['Task closed.', 'Task fully complete.', 'Closed out.', 'All parts approved — task closed.', 'Task wrapped up.'];
function celebrate(customMessage, pool) {
  const messages = pool || COMPLETION_MESSAGES;
  const message = customMessage || messages[Math.floor(Math.random() * messages.length)];
  // A restrained, professional confirmation — a few subtle accent marks, not a colorful
  // confetti burst. Distinct enough to notice, calm enough for a serious business tool.
  const particleEmojis = ['✓', '•'];
  let particlesHTML = '';
  for (let i = 0; i < 14; i++) {
    const angle = (Math.PI * 2 * i) / 24 + (Math.random() * 0.5 - 0.25);
    const distance = 160 + Math.random() * 220;
    const px = Math.round(Math.cos(angle) * distance), py = Math.round(Math.sin(angle) * distance);
    const rotation = Math.round(Math.random() * 720 - 360);
    const emoji = particleEmojis[Math.floor(Math.random() * particleEmojis.length)];
    particlesHTML += `<span class="celebration-particle" style="--px:${px}px;--py:${py}px;--pr:${rotation}deg;animation-delay:${Math.random() * 0.15}s;">${emoji}</span>`;
  }
  const el = document.createElement('div');
  el.className = 'celebration-overlay';
  el.innerHTML = `${particlesHTML}<div class="celebration-message-wrap"><div class="celebration-message">${esc(message)}</div></div>`;
  document.body.appendChild(el);
  setTimeout(() => el.classList.add('celebration-out'), 2600);
  setTimeout(() => el.remove(), 3100);
}
function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: '2-digit' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
// Deadlines can now be a plain date ("2026-01-15") or a date+time ("2026-01-15T14:30") — the
// time part is optional. hasDeadlineTime distinguishes the two so the UI can show "Jan 15" vs
// "Jan 15, 2:30 PM" and the calendar can tell an all-day deadline from a timed one.
function hasDeadlineTime(isoDeadline) { return typeof isoDeadline === 'string' && isoDeadline.includes('T'); }
function fmtDate(isoDeadline) {
  if (!isoDeadline) return '—';
  const d = deadlineDate(isoDeadline);
  if (!d || isNaN(d)) return esc(isoDeadline);
  return hasDeadlineTime(isoDeadline)
    ? d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) + ', ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
// A plain "YYYY-MM-DD" string is parsed by JS as UTC midnight, not local midnight — in a
// timezone behind UTC, that can silently shift a deadline back a day once compared against
// local "now" (e.g. reading as overdue/due-today a day early or late). Appending a local
// midnight time avoids that when there's no time component already; a full date+time string is
// used as-is, since it's unambiguous.
function deadlineDate(isoDeadline) {
  if (!isoDeadline) return null;
  return new Date(hasDeadlineTime(isoDeadline) ? isoDeadline : isoDeadline + 'T00:00:00');
}
function esc(s) { return (s == null ? '' : String(s)).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function resizeImage(file, cb) {
  const reader = new FileReader();
  reader.onload = e => {
    const img = new Image();
    img.onload = () => {
      const maxW = 900;
      const scale = Math.min(1, maxW / img.width);
      const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      cb(canvas.toDataURL('image/jpeg', 0.65));
    };
    img.onerror = () => cb(null);
    img.src = e.target.result;
  };
  reader.onerror = () => cb(null);
  reader.readAsDataURL(file);
}
// For CAD/drawing and other non-image files — kept as-is (base64), only images get downscaled.
function readAnyFile(file, cb) {
  if (file.type && file.type.startsWith('image/')) { resizeImage(file, cb); return; }
  const MAX = 150 * 1024 * 1024;
  if (file.size > MAX) { cb(null); return; }
  const reader = new FileReader();
  reader.onload = e => cb(e.target.result);
  reader.onerror = () => cb(null);
  reader.readAsDataURL(file);
}
function filePreview(dataUrl, label) {
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return '';
  if (dataUrl.startsWith('data:image')) return `<div class="photo-frame"><img src="${dataUrl}"></div>`;
  return `<div style="margin-top:8px;"><a href="${dataUrl}" download="${esc(label || 'document')}" target="_blank">📎 View ${esc(label || 'attachment')} →</a></div>`;
}
// Attachments (task or reply) are no longer embedded in the task list data at all — only a
// has_attachment flag and filename are. Actual bytes (which can be up to ~100MB for a drawing)
// are fetched on demand, only when someone actually clicks to view one, and cached in memory
// for the rest of the session so clicking the same attachment twice doesn't re-fetch it.
const attachmentCache = {};
function lazyAttachmentHTML(hasAttachment, label, fetchUrl, elId) {
  if (!hasAttachment) return '';
  if (attachmentCache[fetchUrl]) return `<div id="${esc(elId)}">${filePreview(attachmentCache[fetchUrl].data, attachmentCache[fetchUrl].name || label)}</div>`;
  return `<div id="${esc(elId)}"><a href="#" data-lazy-attachment="${esc(fetchUrl)}" data-lazy-target="${esc(elId)}">📎 View ${esc(label || 'attachment')} →</a></div>`;
}
document.addEventListener('click', async (e) => {
  const link = e.target.closest('[data-lazy-attachment]');
  if (!link) return;
  e.preventDefault();
  const url = link.dataset.lazyAttachment;
  const targetId = link.dataset.lazyTarget;
  const container = document.getElementById(targetId);
  if (container) container.innerHTML = '<span class="small muted">Loading attachment…</span>';
  try {
    const result = await api(url);
    attachmentCache[url] = result;
    if (container) container.innerHTML = filePreview(result.data, result.name);
  } catch (err) {
    if (container) container.innerHTML = `<span class="err">Could not load attachment.</span>`;
  }
});
function priorityBadgeHTML(t) { const p = t.priority || 'medium'; return `<span class="badge priority-${p}">${p}</span>`; }
function taskSourceBadge(t) { return `<span class="badge received" title="Manually tagged by ${esc(t.created_by || 'someone')}">🏷️ Tagged by ${esc(t.created_by || 'someone')}</span>`; }
// Looked up live from userDirectory (refreshed on every action) rather than cached at login,
// so a lead flag flipped by Admin mid-session is reflected immediately without re-login.

// Preserves unsaved typed input (a reply draft, a search box) across the full-DOM re-renders
// this app does after every action — without this, typing into task A, then completing an
// action on task B (which triggers a refresh), would silently wipe out what you'd typed in A.
// Genuine FLIP-style reorder animation for leaderboard rows: since morphChildren already
// reuses the same DOM node across renders when its `id` matches (rather than tearing it down
// and rebuilding it), a row whose rank changes keeps the SAME element — it just moves to a new
// position in the list. That means the classic FLIP trick works cleanly here: record where each
// row was (First), let the render happen (Last), then immediately counter-transform each row
// back to its old spot with no transition (Invert) and release the transform with a transition
// applied (Play) — the browser animates the release, which reads as the row sliding smoothly
// into its new position rather than jumping there instantly.
function captureLeaderboardRowPositions() {
  const rows = document.querySelectorAll('[id^="lb-row-"]');
  const positions = {};
  rows.forEach(el => { positions[el.id] = el.getBoundingClientRect().top; });
  return positions;
}
function animateLeaderboardRowPositions(oldPositions) {
  if (!oldPositions) return;
  const rows = document.querySelectorAll('[id^="lb-row-"]');
  rows.forEach(el => {
    const oldTop = oldPositions[el.id];
    if (oldTop === undefined) return; // a row that's new to the board this render — nothing to animate from
    const newTop = el.getBoundingClientRect().top;
    const delta = oldTop - newTop;
    if (Math.abs(delta) < 1) return; // didn't actually move — skip the animation entirely
    el.style.transition = 'none';
    el.style.transform = `translateY(${delta}px)`;
    // Forces the browser to apply the above before the transition kicks in, otherwise it would
    // just animate from the final position to itself (no visible movement at all).
    el.getBoundingClientRect();
    el.style.transition = 'transform .4s cubic-bezier(.2,.7,.3,1)';
    el.style.transform = '';
  });
}
function snapshotFieldValues() {
  const app = document.getElementById('app');
  if (!app) return null;
  const values = {};
  app.querySelectorAll('textarea[id], input[id]:not([type="file"]):not([type="checkbox"])').forEach(el => { if (el.value) values[el.id] = el.value; });
  // Select elements were previously excluded entirely here — meaning a background re-render
  // (the 30-second poll, clicking "Check Deadline Against History", etc.) while a form was open
  // would silently reset any <select> back to whatever its HTML template hardcodes as default
  // (e.g. Priority always reverting to "Medium"), without the person noticing until after they'd
  // already submitted. Selects need their own check: unlike a text input, a <select> always has
  // *some* value (never empty), so "only restore if truthy" isn't the right guard here — instead
  // only snapshot ones that differ from their own first (default) option, so a genuinely
  // untouched select doesn't force a spurious restore.
  app.querySelectorAll('select[id]').forEach(el => {
    const firstOptionValue = el.options && el.options.length > 0 ? el.options[0].value : undefined;
    if (el.value !== firstOptionValue) values[el.id] = el.value;
  });
  const active = document.activeElement;
  const focusedId = (active && app.contains(active) && active.id) ? active.id : null;
  return { values, focusedId };
}
function restoreFieldValues(snapshot) {
  if (!snapshot) return;
  Object.entries(snapshot.values).forEach(([id, val]) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.tagName === 'SELECT') { if (el.value !== val) el.value = val; }
    else if (!el.value) el.value = val;
  });
  if (snapshot.focusedId) {
    const el = document.getElementById(snapshot.focusedId);
    if (el && document.activeElement !== el) { el.focus(); if (el.setSelectionRange && typeof el.value === 'string') { try { el.setSelectionRange(el.value.length, el.value.length); } catch (e) {} } }
  }
}

/* ==================== CAD / DRAWING SUPPORT ==================== */
const CAD_DRAWING_EXTENSIONS = ['.dwg', '.dxf', '.rvt', '.rfa', '.skp', '.dgn', '.step', '.stp', '.iges', '.igs', '.3dm', '.pln', '.ifc', '.plt', '.pdf'];

/* ==================== ROLES / NAV ==================== */
const ROLE_LABEL = { admin: 'Admin', member: 'Team Member', director: 'Director' };
const PAGE_TITLES = { today: 'Today', tasks: 'My Tasks', alltasks: 'All Tasks', accounts: 'Accounts', profile: 'My Profile', myteam: 'My Team', performance: 'Performance', auditlog: 'Audit Log', calendar: 'Calendar', peakhours: 'Peak Hours', mydashboard: 'My Dashboard', reports: 'Reports', hrdashboard: 'HR Dashboard' };
function currentTabKey() { return ui.adminTab || 'today'; }
function myOpenTaskBadgeCount() {
  // Only counts tasks that actually still need YOUR action — a task where your part is already
  // approved but the whole thing is waiting on someone else shouldn't nag you in the sidebar.
  return (myTasks || []).filter(t => {
    if (t.status !== 'open') return false;
    const myRow = (t.assignees || []).find(a => a.username === session.username);
    return !(myRow && myRow.decision === 'approve' && myRow.completed_at);
  }).length;
}
function adminOpenTaskBadgeCount() { return (allTasks || []).filter(t => t.status === 'open').length; }
const NAV_CONFIG = {
  admin: [
    { group: 'Overview', items: [
      { key: 'today', label: 'Today', icon: 'clock' },
    ]},
    { group: 'Tasks', items: [
      { key: 'tasks', label: 'My Tasks', icon: 'checkCircle', badge: () => myOpenTaskBadgeCount() },
      { key: 'alltasks', label: 'All Tasks', icon: 'clipboard', badge: () => adminOpenTaskBadgeCount() },
      { key: 'calendar', label: 'Calendar', icon: 'clock' },
    ]},
    { group: 'Admin', items: [
      { key: 'accounts', label: 'Accounts', icon: 'users' },
      { key: 'performance', label: 'Performance', icon: 'checkCircle' },
      { key: 'auditlog', label: 'Audit Log', icon: 'clipboard' },
      { key: 'peakhours', label: 'Peak Hours', icon: 'clock' },
      { key: 'reports', label: 'Reports', icon: 'clipboard' },
      { key: 'hrdashboard', label: 'HR Dashboard', icon: 'users' },
    ]},
    { group: 'You', items: [
      { key: 'mydashboard', label: 'My Dashboard', icon: 'checkCircle' },
      { key: 'profile', label: 'My Profile', icon: 'pencil' },
    ]},
  ],
  member: [
    { group: 'Overview', items: [
      { key: 'today', label: 'Today', icon: 'clock' },
    ]},
    { group: 'Tasks', items: [
      { key: 'tasks', label: 'My Tasks', icon: 'checkCircle', badge: () => myOpenTaskBadgeCount() },
      { key: 'calendar', label: 'Calendar', icon: 'clock' },
    ]},
    { group: 'You', items: [
      { key: 'mydashboard', label: 'My Dashboard', icon: 'checkCircle' },
      { key: 'profile', label: 'My Profile', icon: 'pencil' },
    ]},
  ],
  // A real gap found while building the Performance rating feature: Directors had NO nav
  // config entry at all, silently falling back to an empty array — meaning Directors could
  // reach almost nothing in the app even though the server has always granted them proper,
  // department-scoped access to Performance and Peak Hours. Fixed to mirror a normal member's
  // everyday task capability, plus the reporting access their role actually has.
  director: [
    { group: 'Overview', items: [
      { key: 'today', label: 'Today', icon: 'clock' },
    ]},
    { group: 'Tasks', items: [
      { key: 'tasks', label: 'My Tasks', icon: 'checkCircle', badge: () => myOpenTaskBadgeCount() },
      { key: 'calendar', label: 'Calendar', icon: 'clock' },
    ]},
    { group: 'Reporting', items: [
      { key: 'performance', label: 'Performance', icon: 'checkCircle' },
      { key: 'peakhours', label: 'Peak Hours', icon: 'clock' },
    ]},
    { group: 'You', items: [
      { key: 'mydashboard', label: 'My Dashboard', icon: 'checkCircle' },
      { key: 'profile', label: 'My Profile', icon: 'pencil' },
    ]},
  ],
};

/* ==================== SHELL: SIDEBAR / TOPBAR / NOTIFICATIONS ==================== */
function renderSidebar() {
  const groups = [...(NAV_CONFIG[session.role] || [])];
  // Team leads get a "My Team" tab injected dynamically (not baked into NAV_CONFIG) since it
  // depends on the is_team_lead flag, which can change at runtime — Admin already has full
  // account control via "Accounts", so this is only added for non-admin leads.
  if (session.role !== 'admin' && session.isTeamLead) {
    groups.push({ group: 'Team', items: [{ key: 'myteam', label: 'My Team', icon: 'users' }] });
  }
  // Same team-substring pattern already used for Design-team drawing uploads — HR Department
  // members (and Admin, already covered by NAV_CONFIG) get an HR Dashboard tab.
  if (session.role !== 'admin' && isHRTeamName(session.team)) {
    groups.push({ group: 'HR', items: [{ key: 'hrdashboard', label: 'HR Dashboard', icon: 'users' }] });
  }
  const active = currentTabKey();
  return `
  ${ui.sidebarOpen ? `<div class="sidebar-backdrop" data-act="close-sidebar"></div>` : ''}
  <aside class="sidebar ${ui.sidebarOpen ? 'open' : ''}" id="sidebar">
    <div class="sidebar-header">
      <div class="brand-plate">
        <div class="brand-mark">${falconMark()}</div>
        <div><div class="brand-name">MIHIR</div><div class="brand-sub">Task Manager</div></div>
      </div>
      <button class="close-x sidebar-close-btn" data-act="close-sidebar" title="Close menu">✕</button>
      <div class="sidebar-role">
        <b>${esc(session.name)}</b>
        <span>${esc(session.designation || ROLE_LABEL[session.role] || session.role)}${session.team ? ` · ${esc(session.team)}` : ''}</span>
      </div>
    </div>
    <nav class="sidebar-nav">
      ${groups.map(g => `
        <div class="nav-group">
          <div class="nav-group-label">${g.group}</div>
          ${g.items.map(it => {
            const count = it.badge ? it.badge() : 0;
            return `<button class="nav-link ${active === it.key ? 'active' : ''}" data-tab="${it.key}">${icon(it.icon)}<span>${it.label}</span>${count ? `<span class="nav-badge">${count}</span>` : ''}</button>`;
          }).join('')}
        </div>`).join('')}
    </nav>
    <div class="sidebar-quote">"${esc(currentQuote())}"</div>
    <div class="sidebar-footer">
      <div class="sidebar-footer-row">${themeToggleHTML()}</div>
      <button class="nav-link" data-act="logout">${icon('logout')}<span>Log out</span></button>
    </div>
  </aside>`;
}
const NOTIF_TYPE_ICON = { task_assigned: 'checkCircle', task_reply: 'bell', task_closed: 'checkCircle', task_reminder: 'clock', task_reminder_3day: 'clock', task_warning: 'alertTriangle', task_warning_creator: 'alertTriangle', weekly_warning_digest: 'alertTriangle', followup_tagged: 'eye', task_submitted: 'checkCircle', mentioned_in_comment: 'bell', approval_requested: 'checkCircle', approval_rejected: 'alertTriangle', approval_approved: 'checkCircle', deadline_soon: 'clock', deadline_passed: 'alertTriangle', admin_late_flag: 'alertTriangle', task_reopened: 'alertTriangle' };
const NOTIF_TYPE_LABEL = { task_assigned: 'Task Assigned', task_reply: 'Task Update', task_closed: 'Task Closed', task_reminder: 'Task Reminder', task_reminder_3day: '3-Day Reminder', task_warning: '7-Day Warning', task_warning_creator: 'Task Overdue Warning', weekly_warning_digest: 'Weekly Warning Summary', followup_tagged: 'Follow-up Requested', task_submitted: 'Awaiting Your Approval', mentioned_in_comment: 'Mentioned You', approval_requested: 'Approval Requested', approval_rejected: 'Approval Rejected', approval_approved: 'Fully Approved', deadline_soon: 'Deadline Soon', deadline_passed: 'Deadline Passed', admin_late_flag: 'Late User Flagged', task_reopened: 'Task Reopened' };
function renderNotifDrawer() {
  const sorted = [...myNotifications].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return `
  <div class="notif-drawer-bg" data-act="close-notifications">
    <div class="notif-drawer glass" onclick="event.stopPropagation()">
      <div class="flex-between" style="padding:18px 20px;border-bottom:1px solid var(--line);">
        <b>Notifications</b>
        <button class="close-x" data-act="close-notifications">✕</button>
      </div>
      <div style="padding:8px 12px;max-height:calc(100vh - 60px);overflow-y:auto;">
        ${sorted.length === 0 ? `<div class="empty">Nothing to show — all quiet.</div>` : sorted.map(n => `
          <div class="notif-item" ${n.task_id ? `data-notif-goto-task="${esc(n.task_id)}"` : ''} style="${n.task_id ? 'cursor:pointer;' : ''}" data-mark-notif-read="${n.id}">
            <div class="notif-icon">${icon(NOTIF_TYPE_ICON[n.type] || 'alertTriangle', 16)}</div>
            <div style="flex:1;min-width:0;">
              <div class="flex-between"><span class="small" style="font-weight:700;">${esc(NOTIF_TYPE_LABEL[n.type] || 'Alert')}</span>${n.read ? `<span class="badge received">Read</span>` : `<span class="badge flag">New</span>`}</div>
              <div class="small" style="margin-top:2px;">${esc(n.message)}</div>
              <div class="muted small" style="margin-top:4px;">${fmtTime(n.created_at)}</div>
            </div>
          </div>`).join('')}
      </div>
    </div>
  </div>`;
}
function renderTopbarSlim() {
  const title = PAGE_TITLES[ui.adminTab] || 'Task Manager';
  const eyebrow = (ROLE_LABEL[session.role] || session.role || 'Team Member').toUpperCase();
  return `
  <header class="topbar-slim">
    <div style="display:flex;align-items:center;gap:12px;">
      <button class="icon-btn menu-toggle" data-act="toggle-sidebar" title="Menu">${icon('grid')}</button>
      <div><div class="page-eyebrow">${eyebrow}</div><h1 class="page-title">${esc(title)}</h1></div>
    </div>
    <div></div>
    <div class="topbar-actions">
      <button class="icon-btn" data-act="open-notifications" title="Notifications">${icon('bell')}${unreadNotifCount ? `<span class="dot">${unreadNotifCount}</span>` : ''}</button>
    </div>
  </header>
  ${session.mustChangePassword ? `
  <div class="card" style="border-color:var(--danger);margin-bottom:12px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
    <span class="small">⚠ You're still using a temporary password.</span>
    <button class="btn btn-sm" data-act="reopen-password-change">Set a real password now</button>
  </div>` : ''}
  ${ui.notifDrawerOpen ? renderNotifDrawer() : ''}`;
}
function bannerHTML() {
  if (!ui.banner) return '';
  const color = ui.banner.kind === 'ok' ? 'var(--success)' : 'var(--danger)';
  return `<div class="card" style="border-color:${color};color:${color};">${esc(ui.banner.msg)}</div>`;
}

/* ==================== LOGIN ==================== */
function renderLoginPage() {
  return `
  <div class="login-modal-bg" style="position:fixed;">
    <div class="login-modal">
      <div class="login-modal-head">
        <div class="brand-plate" style="margin-bottom:0;">
          <div class="brand-mark">${falconMark()}</div>
          <div><div class="brand-name">MIHIR</div><div class="brand-sub">Task Manager — Sign in to continue</div></div>
        </div>
      </div>
      <div class="login-modal-body">
        <label>Username</label>
        <input type="text" id="lg-user" placeholder="e.g. admin">
        <label>Password</label>
        ${passwordFieldHTML('lg-pass', '••••••••')}
        <button class="btn btn-primary btn-block" style="margin-top:18px;" data-act="login">Log in</button>
        ${ui.loginErr ? `<div class="err">${esc(ui.loginErr)}</div>` : ''}
        <p class="hint"><a href="#" data-act="toggle-forgot-password">Forgot password?</a></p>
        ${ui.showForgotPassword ? `
        <div class="notice" style="margin-top:4px;">
          ${ui.forgotPasswordStage === 'otp-sent' ? `
            <p style="margin:0 0 8px;">If that account has an email on file, a 6-digit code was sent to it. Enter it below along with your new password.</p>
            <label>Reset Code</label>
            <input type="text" id="fp-otp" placeholder="123456" maxlength="6">
            <label>New Password</label>
            ${passwordFieldHTML('fp-new-password', 'At least 6 characters')}
            <button class="btn btn-primary btn-sm" style="margin-top:8px;" data-act="submit-otp-reset">Reset Password</button>
            ${ui.forgotPasswordErr ? `<div class="err" style="margin-top:6px;">${esc(ui.forgotPasswordErr)}</div>` : ''}
          ` : `
            <label>Username</label>
            <input type="text" id="fp-username" placeholder="Your username">
            <button class="btn btn-primary btn-sm" style="margin-top:8px;" data-act="request-otp">Email Me a Reset Code</button>
            ${ui.forgotPasswordErr ? `<div class="err" style="margin-top:6px;">${esc(ui.forgotPasswordErr)}</div>` : ''}
            <p class="small muted" style="margin-top:10px;">If email isn't set up on this server, or your account has none on file, ask an <b>Admin</b> to reset it from <b>Accounts</b> instead — or, if nobody can log in at all, whoever has server access can run <code>node reset-password.js &lt;username&gt; &lt;newpassword&gt;</code> from the project folder.</p>
          `}
        </div>` : ''}
      </div>
    </div>
  </div>`;
}
function bindLogin() {
  bindPasswordToggles();
  const submit = async () => {
    const username = document.getElementById('lg-user').value.trim();
    const password = document.getElementById('lg-pass').value;
    try {
      const data = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
      token = data.token;
      session = { username: data.user.username, role: data.user.role, name: data.user.name, mustChangePassword: data.user.mustChangePassword };
      localStorage.setItem('ls_token', token); localStorage.setItem('ls_session', JSON.stringify(session));
      ui.loginErr = ''; ui.adminTab = 'today'; localStorage.setItem('ls_last_tab', 'today');
      await afterLogin();
    } catch (e) { ui.loginErr = e.message; render(); }
  };
  const loginBtn = document.querySelector('[data-act="login"]');
  if (loginBtn) loginBtn.onclick = submit;
  const passField = document.getElementById('lg-pass');
  if (passField) passField.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  const forgotLink = document.querySelector('[data-act="toggle-forgot-password"]');
  if (forgotLink) forgotLink.onclick = (e) => { e.preventDefault(); ui.showForgotPassword = !ui.showForgotPassword; ui.forgotPasswordStage = 'request'; ui.forgotPasswordErr = ''; render(); };
  const requestOtpBtn = document.querySelector('[data-act="request-otp"]');
  if (requestOtpBtn) requestOtpBtn.onclick = async () => {
    const username = document.getElementById('fp-username').value.trim();
    if (!username) { ui.forgotPasswordErr = 'Enter your username first.'; render(); return; }
    try {
      const result = await api('/api/auth/forgot-password', { method: 'POST', body: JSON.stringify({ username }) });
      ui.forgotPasswordUsername = username;
      ui.forgotPasswordStage = 'otp-sent';
      ui.forgotPasswordErr = '';
      render();
    } catch (e) { ui.forgotPasswordErr = e.message; render(); }
  };
  const submitOtpBtn = document.querySelector('[data-act="submit-otp-reset"]');
  if (submitOtpBtn) submitOtpBtn.onclick = async () => {
    const otp = document.getElementById('fp-otp').value.trim();
    const newPassword = document.getElementById('fp-new-password').value;
    if (!otp || !newPassword) { ui.forgotPasswordErr = 'Enter both the code and your new password.'; render(); return; }
    try {
      await api('/api/auth/reset-with-otp', { method: 'POST', body: JSON.stringify({ username: ui.forgotPasswordUsername, otp, newPassword }) });
      ui.showForgotPassword = false;
      ui.forgotPasswordStage = 'request';
      setBanner('Password reset — log in with your new password.', 'ok');
      render();
    } catch (e) { ui.forgotPasswordErr = e.message; render(); }
  };
}
function renderForcedPasswordChange() {
  return `
  <div class="login-modal-bg">
    <div class="login-modal" style="max-width:400px;width:100%;">
      <div class="login-modal-head">
        <div class="brand-plate" style="margin-bottom:0;">
          <div class="brand-mark">${falconMark()}</div>
          <div><div class="brand-name">MIHIR</div><div class="brand-sub">Task Manager — Set your password</div></div>
        </div>
      </div>
      <div class="login-modal-body">
        <div class="card-title">Welcome, ${esc(session.name)}</div>
        <p class="small muted">You're signing in with a temporary password. Set your own real password to continue.</p>
        <label>New Password (min 6 characters)</label>
        ${passwordFieldHTML('pw-new', 'Choose a real password')}
        <label>Confirm New Password</label>
        ${passwordFieldHTML('pw-confirm', 'Type it again')}
        <button class="btn btn-primary btn-block" style="margin-top:18px;" data-act="submit-password-change">Set Password & Continue</button>
        ${ui.pwChangeErr ? `<div class="err">${esc(ui.pwChangeErr)}</div>` : ''}
        <div class="hint"><a href="#" data-act="dismiss-password-change">Not now — remind me later →</a> &nbsp;|&nbsp; <a href="#" data-act="logout">Log out instead</a></div>
      </div>
    </div>
  </div>`;
}
function bindForcedPasswordChange() {
  bindPasswordToggles();
  const submitBtn = document.querySelector('[data-act="submit-password-change"]');
  if (submitBtn) submitBtn.onclick = async () => {
    const newPassword = document.getElementById('pw-new').value;
    const confirmPassword = document.getElementById('pw-confirm').value;
    if (!newPassword || !confirmPassword) { ui.pwChangeErr = 'Both fields are required.'; render(); return; }
    if (newPassword !== confirmPassword) { ui.pwChangeErr = "Passwords don't match."; render(); return; }
    if (newPassword.length < 6) { ui.pwChangeErr = 'Password must be at least 6 characters.'; render(); return; }
    try {
      const data = await api('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ newPassword }) });
      token = data.token;
      session = { ...session, mustChangePassword: false };
      localStorage.removeItem('ls_pw_reminder_dismissed');
      localStorage.setItem('ls_token', token); localStorage.setItem('ls_session', JSON.stringify(session));
      ui.pwChangeErr = '';
      setBanner('Password set — welcome in.', 'ok');
      await afterLogin();
    } catch (e) { ui.pwChangeErr = e.message; render(); }
  };
  const logoutLink = document.querySelector('[data-act="logout"]');
  if (logoutLink) logoutLink.onclick = (e) => { e.preventDefault(); logout(); };
  const dismissLink = document.querySelector('[data-act="dismiss-password-change"]');
  if (dismissLink) dismissLink.onclick = (e) => { e.preventDefault(); ui.showPasswordChangeModal = false; localStorage.setItem('ls_pw_reminder_dismissed', 'true'); render(); };
}
function logout() {
  token = null; session = null;
  localStorage.removeItem('ls_token'); localStorage.removeItem('ls_session'); localStorage.removeItem('ls_last_tab'); localStorage.removeItem('ls_pw_reminder_dismissed');
  resetAllAppState();
  render();
}

/* ==================== DATA LOADING ==================== */
async function afterLogin() { await refreshData(); }

// ---- Push notifications (PWA) ----
// Registering the service worker is harmless and done unconditionally (needed for the app to be
// installable at all) — but actually subscribing to push, which triggers a real browser
// permission prompt, only ever happens when the person explicitly clicks "Enable" in My Profile.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/service-worker.js').catch(() => { /* fine on browsers without support */ });
}
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}
async function updatePushStatusUI() {
  const statusEl = document.getElementById('push-status-text');
  const enableBtn = document.getElementById('enable-push-btn');
  const disableBtn = document.getElementById('disable-push-btn');
  if (!statusEl) return;
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    statusEl.textContent = "This browser doesn't support push notifications.";
    return;
  }
  try {
    const { publicKey } = await api('/api/push/vapid-public-key');
    if (!publicKey) {
      statusEl.textContent = "Push notifications aren't set up on this server yet — ask your Admin.";
      return;
    }
    const reg = await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    if (existing) {
      statusEl.textContent = 'Push notifications are ON for this device.';
      if (disableBtn) disableBtn.style.display = 'inline-block';
    } else {
      statusEl.textContent = 'Push notifications are OFF for this device.';
      if (enableBtn) enableBtn.style.display = 'inline-block';
    }
  } catch (e) { statusEl.textContent = 'Could not check push notification status.'; }
}
async function enablePushNotifications() {
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') { setBanner('Notification permission was not granted.'); render(); return; }
    const { publicKey } = await api('/api/push/vapid-public-key');
    if (!publicKey) { setBanner("Push notifications aren't configured on this server yet."); render(); return; }
    const reg = await navigator.serviceWorker.ready;
    const subscription = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
    await api('/api/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: subscription.toJSON() }) });
    setBanner('Push notifications enabled on this device.', 'ok');
    render();
  } catch (e) { setBanner('Could not enable push notifications: ' + e.message); render(); }
}
async function disablePushNotifications() {
  try {
    const reg = await navigator.serviceWorker.ready;
    const subscription = await reg.pushManager.getSubscription();
    if (subscription) {
      await api('/api/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: subscription.endpoint }) });
      await subscription.unsubscribe();
    }
    setBanner('Push notifications turned off on this device.', 'ok');
    render();
  } catch (e) { setBanner('Could not turn off push notifications: ' + e.message); render(); }
}
let lastDataFingerprint = null;
// opts.background=true marks a silent 30s poll rather than a response to something the person
// just did. For a background poll, if the fetched data is byte-for-byte identical to last time,
// we skip render() entirely — no full-page rebuild, no flash, nothing to "blink". A real change
// (new assignment, a reply, a status flip) always renders, same as before.
async function refreshData(opts) {
  if (!token || !session) return;
  const background = !!(opts && opts.background);
  try {
    myTasks = await api('/api/tasks/mine');
    userDirectory = await api('/api/users/directory');
    teamsList = await api('/api/teams');
    projectsList = await api('/api/projects');
    sectionsList = await api('/api/drawing-sections');
    phasesList = await api('/api/task-phases');
    openTaskTitles = await api('/api/tasks/open-titles');
    const me = await api('/api/auth/me');
    session = { ...session, email: me.email, phone: me.phone, team: me.team, designation: me.designation, isTeamLead: !!me.isTeamLead };
    localStorage.setItem('ls_session', JSON.stringify(session));
    const notif = await api('/api/notifications');
    if (session.role === 'admin') {
      monthlyLeaderboard = await api('/api/reports/monthly-leaderboard');
      weeklyLeaderboard = await api('/api/reports/weekly-leaderboard');
      quarterAwards = (await api('/api/reports/period-awards?type=quarter')).awards;
      yearAwards = (await api('/api/reports/period-awards?type=year')).awards;
    }
    myNotifications = notif.items; unreadNotifCount = notif.unread;
    if (session.role === 'admin') allTasks = await api('/api/tasks');
    if (session.role === 'admin' || session.role === 'director') {
      completionStats = await api('/api/reports/completion');
      approvalStats = await api('/api/reports/approvals');
      peakHoursData = await api(`/api/reports/peak-hours?username=${encodeURIComponent(ui.peakHoursUser || 'all')}`);
      ratingsData = (await api('/api/reports/ratings')).ratings;
      approvalDecisionsDetail = await api('/api/reports/approval-decisions');
    }
    if (session.role === 'admin') { allApprovalRequests = await api('/api/approvals'); reportsTaskList = await api('/api/reports/tasks-list'); }
    if (session.role === 'admin') auditLogEntries = await api('/api/audit-log');
    myApprovalRequests = await api('/api/approvals/mine');
    myDashboardData = await api(`/api/reports/my-dashboard${session.role === 'admin' && ui.dashboardViewUser && ui.dashboardViewUser !== session.username ? `?username=${encodeURIComponent(ui.dashboardViewUser)}` : ''}`);
    if (session.role === 'admin' || isHRTeamName(session.team)) { const hrRosterResp = await api('/api/reports/hr-roster'); hrRosterData = hrRosterResp.roster; hrTotalTasksCompleted = hrRosterResp.totalTasksCompleted; }
    if (background) {
      // Every field a currently-visible page could actually display must be included here —
      // otherwise a background poll could silently fetch fresh data for, say, Performance
      // ratings or the HR roster, and then skip re-rendering because the ORIGINAL fields
      // (myTasks, notifications, etc.) happened not to change, leaving that page showing stale
      // numbers until something else eventually forced a render. Found this gap directly: these
      // newer fields (added well after this fingerprint check was first written) were never
      // added to it.
      const fingerprint = JSON.stringify({ myTasks, allTasks, userDirectory, teamsList, myNotifications, unreadNotifCount, completionStats, ratingsData, approvalStats, approvalDecisionsDetail, peakHoursData, hrRosterData, myDashboardData, hrDashboardData, auditLogEntries });
      if (fingerprint === lastDataFingerprint) return; // nothing changed — skip the render, no flicker
      lastDataFingerprint = fingerprint;
    }
  } catch (e) { /* api() already handles session expiry */ }
  render();
}

/* ==================== TASKS ==================== */
function sortTasksForDisplay(tasks) {
  const now = Date.now();
  const priorityRank = { high: 0, medium: 1, low: 2 };
  return [...tasks].sort((a, b) => {
    const aPri = priorityRank[a.priority || 'medium'] ?? 1;
    const bPri = priorityRank[b.priority || 'medium'] ?? 1;
    if (aPri !== bPri) return aPri - bPri;
    const aOverdue = !!(a.status === 'open' && a.deadline && new Date(a.deadline).getTime() < now);
    const bOverdue = !!(b.status === 'open' && b.deadline && new Date(b.deadline).getTime() < now);
    if (aOverdue !== bOverdue) return aOverdue ? -1 : 1;
    if (a.deadline && b.deadline) return new Date(a.deadline) - new Date(b.deadline);
    return new Date(b.created_at) - new Date(a.created_at);
  });
}
function renderTaskActivityFeed(t) {
  const events = [];
  events.push({ at: t.created_at, actor: t.created_by, text: `Task created — tagged by ${esc(t.created_by || 'someone')}` });
  (t.assignees || []).forEach(a => {
    if (a.submitted_at) events.push({ at: a.submitted_at, actor: a.username, team: a.team, text: `${esc(a.username)} submitted their part for approval` });
    if (a.completed_at && a.decision === 'approve') events.push({ at: a.completed_at, actor: a.completed_by || 'Creator', team: a.team, text: `${esc(a.completed_by || 'The creator')} approved ${esc(a.username)}'s part`, decision: 'approve' });
  });
  (t.replies || []).forEach(r => {
    events.push({ at: r.created_at, actor: r.by_name || r.by_username, text: r.message, hasAttachment: r.has_attachment, attachmentName: r.attachment_name, replyId: r.id, taskId: t.id });
  });
  if (t.status === 'closed' && t.closed_at) events.push({ at: t.closed_at, actor: t.closed_by, text: `Task fully closed${t.closed_by ? ' — ' + esc(t.closed_by) : ''}`, isClose: true });
  if (t.status === 'cancelled' && t.cancelled_at) events.push({ at: t.cancelled_at, actor: t.cancelled_by, text: `Task cancelled${t.cancelled_by ? ' — ' + esc(t.cancelled_by) : ''}${t.cancel_reason ? ': ' + esc(t.cancel_reason) : ''}`, isCancel: true });
  events.sort((a, b) => new Date(a.at) - new Date(b.at));
  return `
  <div class="timeline" style="margin-top:12px;">
    ${events.map((e, i) => `
      <div class="tl-item">
        <div class="tl-role">${e.actor ? esc(e.actor) : '—'}${e.team ? ' · ' + esc(e.team) : ''}${e.decision ? ` · <span style="color:var(--success);font-weight:700;">✓ Approved</span>` : ''}${e.isClose ? ' · <span style="color:var(--success);font-weight:700;">✓ Closed</span>' : ''}${e.isCancel ? ' · <span style="color:var(--danger);font-weight:700;">✗ Cancelled</span>' : ''}</div>
        <div class="tl-time">${fmtTime(e.at)}</div>
        <div class="tl-note">${highlightMentions(e.text || '')}</div>${e.hasAttachment ? lazyAttachmentHTML(true, e.attachmentName, `/api/tasks/${e.taskId}/replies/${e.replyId}/attachment`, `reply-attach-${e.taskId}-${e.replyId}`) : ''}
      </div>`).join('')}
  </div>`;
}
function renderTaskItem(t) {
  const assignees = t.assignees || [];
  const repliedUsernames = new Set((t.replies || []).map(r => r.by_username));
  const iAmTagged = assignees.some(a => a.username === session.username);
  const myRow = assignees.find(a => a.username === session.username);
  const isApproved = a => a.decision === 'approve' && !!a.completed_at;
  const iAmDone = !!(myRow && isApproved(myRow));
  const iAmSubmitted = !!(myRow && myRow.submitted_at && !iAmDone);
  const doneCount = assignees.filter(isApproved).length;
  // A blocked task never shows as OVERDUE, however late its deadline is — the person waiting
  // on a prerequisite has no way to act, so flagging them as overdue would mark them unfairly
  // for someone else's delay.
  const overdue = t.status === 'open' && !t.blocked && t.deadline && deadlineDate(t.deadline) < new Date();
  const checklist = t.checklist || [];
  const checklistDone = checklist.filter(c => c.is_checked).length;
  const isCreator = t.created_by_username === session.username;
  const canApproveHere = isCreator || session.role === 'admin';
  const followups = t.followups || [];
  const iAmFollowup = followups.some(f => f.username === session.username);
  const canCommentHere = iAmTagged || iAmFollowup || isCreator || session.role === 'admin';
  // Force-close authority: only whoever created this task, or Admin — the whole authority to
  // close a task belongs to its creator, exercised either by approving each person's part
  // (auto-closes once everyone is approved) or by force-closing outright at any time.
  const canForceClose = session.role === 'admin' || isCreator;
  const followupBadge = f => `<span class="badge po_pending" title="Tagged for follow-up by ${esc(f.tagged_by || 'someone')} · ${fmtTime(f.created_at)}">👀 ${esc(f.username)}</span>`;
  const assigneeBadge = a => {
    let cls = 'created', label = esc(a.username), title = 'Awaiting submission';
    if (!a.is_released) { cls = 'flag'; label = esc(a.username) + ' 🔒 On Hold'; title = `On hold — Level ${a.stage}, waiting on the level before it`; }
    else if (isApproved(a)) { cls = 'received'; label = esc(a.username) + ' ✓ Approved'; title = `Approved by ${esc(a.completed_by || 'the creator')} · ${fmtTime(a.completed_at)}`; }
    else if (a.submitted_at) { cls = 'po_pending'; label = esc(a.username) + ' • Submitted'; title = `Submitted ${fmtTime(a.submitted_at)} — awaiting creator approval`; }
    else if (repliedUsernames.has(a.username)) { cls = 'po_pending'; title = 'Commented, not yet submitted'; }
    const canRemove = t.status === 'open' && canApproveHere && !a.submitted_at && !a.completed_at && assignees.length > 1;
    const removeControl = canRemove ? `<span data-remove-assignee="${t.id}" data-username="${esc(a.username)}" title="Remove — they haven't submitted or been approved yet" style="cursor:pointer;font-weight:700;margin-left:4px;">✕</span>` : '';
    return `<span class="badge ${cls}" title="${title}">${label}${removeControl}</span>`;
  };
  // Tagged people shown grouped by Level, not as one flat mixed list — a "|" divider marks
  // where one level ends and the next begins, so it's visually clear who has to finish before
  // who else even starts, instead of everyone looking like peers on equal footing.
  const groupedAssigneeBadgesHTML = () => {
    const maxStage = assignees.reduce((m, a) => Math.max(m, a.stage || 1), 1);
    const groups = [];
    for (let s = 1; s <= maxStage; s++) {
      const group = assignees.filter(a => (a.stage || 1) === s);
      if (group.length > 0) groups.push(group);
    }
    return groups.map(g => `<span style="display:inline-flex;flex-wrap:wrap;gap:6px;">${g.map(assigneeBadge).join('')}</span>`)
      .join('<span class="level-separator">|</span>');
  };
  // Stages with 2+ people involved show a "Release Stage N" control for the creator/admin, once
  // the stage before it is fully approved and it isn't already released.
  const maxStage = assignees.reduce((m, a) => Math.max(m, a.stage || 1), 1);
  const releasableStages = [];
  if (maxStage > 1 && canApproveHere) {
    for (let s = 2; s <= maxStage; s++) {
      const stageAssignees = assignees.filter(a => a.stage === s);
      if (stageAssignees.length === 0 || stageAssignees.every(a => a.is_released)) continue;
      const prevFullyApproved = assignees.filter(a => a.stage === s - 1).every(a => isApproved(a));
      if (prevFullyApproved) releasableStages.push(s);
    }
  }
  if (t.status !== 'open') {
    const isCancelled = t.status === 'cancelled';
    return `
    <details class="card" id="task-card-${esc(t.id)}" style="background:var(--panel-2);padding:10px 16px;">
      <summary style="cursor:pointer;display:flex;justify-content:space-between;align-items:center;list-style:none;">
        <span><b>${esc(t.title)}</b><span class="mono small muted">${esc(t.id)}</span> <span class="small muted">— ${isCancelled ? `cancelled by ${esc(t.cancelled_by || '—')} · ${fmtTime(t.cancelled_at)}` : `closed by ${esc(t.closed_by || '—')} · ${fmtTime(t.closed_at)}`}</span></span>
        <span class="badge ${isCancelled ? 'flag' : 'received'}">${isCancelled ? 'CANCELLED' : 'CLOSED'}</span>
      </summary>
      <div style="margin-top:10px;">
        <div style="margin-bottom:8px;">${taskSourceBadge(t)}</div>
        ${isCancelled && t.cancel_reason ? `<div class="notice" style="border-color:var(--danger);">Cancelled: ${esc(t.cancel_reason)}</div>` : ''}
        ${t.description ? `<div class="doc-note">${esc(t.description)}</div>` : ''}
        ${lazyAttachmentHTML(t.has_attachment, t.attachment_name, `/api/tasks/${t.id}/attachment`, `task-attach-${t.id}`)}
        <div style="margin-top:8px;display:flex;flex-wrap:wrap;align-items:center;gap:6px;">${groupedAssigneeBadgesHTML()}</div>
        ${checklist.length > 0 ? `
        <div style="margin-top:10px;">
          <div class="small muted">Checklist — ${checklistDone}/${checklist.length} done</div>
          ${checklist.map(c => `<div style="font-size:13px;padding:3px 0;${c.is_checked ? 'opacity:0.6;text-decoration:line-through;' : ''}">${c.is_checked ? '✓' : '○'} ${esc(c.text)}</div>`).join('')}
        </div>` : ''}
        <div class="small muted" style="margin-top:12px;">Full history</div>
        ${renderTaskActivityFeed(t)}
        ${(session.role === 'admin' || isCreator) ? `
        <button class="btn btn-sm" style="margin-top:10px;" data-act="toggle-reopen-form" data-task-id="${t.id}" title="Only whoever created this task, or Admin, can reopen it">Reopen — more work needed</button>
        ${ui.reopenFormTaskId === t.id ? `
        <div class="row" style="margin-top:8px;align-items:flex-end;">
          <div class="col"><label>Reason for reopening (required)</label><input type="text" id="reopen-reason-${t.id}" placeholder="e.g. Missing site photos, needs redoing" required></div>
          <div class="col" style="flex:0;"><button class="btn btn-sm btn-danger" data-act="submit-reopen" data-task-id="${t.id}">Confirm Reopen</button></div>
        </div>` : ''}` : ''}
      </div>
    </details>`;
  }
  const pendingApproval = assignees.filter(a => a.submitted_at && !isApproved(a));
  return `
  <div class="card" id="task-card-${esc(t.id)}" style="background:var(--panel-2);">
    <div class="flex-between">
      <div><b>${esc(t.title)}</b><span class="mono small muted">${esc(t.id)}</span> ${priorityBadgeHTML(t)}${t.project ? `<span class="badge" style="margin-left:4px;" title="Project">📁 ${esc(t.project)}</span>` : ''}${t.phase ? `<span class="badge" style="margin-left:4px;" title="Phase">${esc(t.phase)}</span>` : ''}</div>
      <span class="badge po_pending">OPEN</span>
    </div>
    ${t.description ? `<div class="doc-note">${esc(t.description)}</div>` : ''}
    <div class="muted small" style="margin-top:6px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;">${taskSourceBadge(t)}<span>${fmtTime(t.created_at)}${t.deadline ? ` · Due ${fmtDate(t.deadline)}${overdue ? ' <span class="badge flag">OVERDUE</span>' : ''}` : ''}</span></div>
    ${t.blocked ? `<div class="notice" style="border-color:var(--amber);margin-top:8px;">${icon('alertTriangle', 13)} Blocked — waiting on a prerequisite task to close first.</div>` : ''}
    ${lazyAttachmentHTML(t.has_attachment, t.attachment_name, `/api/tasks/${t.id}/attachment`, `task-attach-${t.id}`)}
    <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:6px;align-items:center;">
      ${groupedAssigneeBadgesHTML()}
      ${assignees.length > 1 ? `<span class="small muted">${doneCount}/${assignees.length} approved</span>` : ''}
      ${t.status === 'open' && canApproveHere ? `<button class="btn btn-sm" style="padding:2px 8px;font-size:11px;" data-act="toggle-add-assignee-form" data-task-id="${t.id}">+ Add Person</button>` : ''}
    </div>
    ${ui.addAssigneeFormTaskId === t.id ? `
    <div class="card" style="background:var(--panel-2);margin-top:6px;">
      <label>Tag someone else onto this task</label>
      <div class="tagpicker" id="add-assignee-tagpicker-${t.id}">
        <div data-tagpicker-chips style="margin-bottom:6px;"></div>
        <div style="position:relative;">
          <input type="text" data-tagpicker-input placeholder="Type a name, username, or team — try @ to search">
          <div data-tagpicker-suggestions class="tag-suggestions-dropdown" style="display:none;"></div>
        </div>
      </div>
      <button class="btn btn-primary btn-sm" data-act="submit-add-assignee" data-task-id="${t.id}">Add to Task</button>
    </div>` : ''}
    ${followups.length > 0 ? `
    <div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px;align-items:center;">
      <span class="small muted">Follow-up:</span>${followups.map(followupBadge).join('')}
    </div>` : ''}
    ${checklist.length > 0 ? `
    <div style="margin-top:10px;">
      <div class="small muted">Checklist — ${checklistDone}/${checklist.length} done</div>
      ${checklist.map(c => `
        <div style="display:flex;align-items:center;gap:8px;">
          <label style="display:flex;align-items:center;gap:8px;font-weight:400;font-size:13px;padding:3px 0;flex:1;${c.is_checked ? 'opacity:0.6;text-decoration:line-through;' : ''}">
            <input type="checkbox" data-toggle-checklist="${c.id}" data-task-id="${esc(t.id)}" ${c.is_checked ? 'checked' : ''} style="width:auto;" ${(!iAmTagged && session.role !== 'admin') ? 'disabled' : ''}>
            ${esc(c.text)}
          </label>
          ${session.role === 'admin' ? `<button class="btn btn-sm btn-danger" style="padding:2px 8px;font-size:11px;" data-delete-checklist="${c.id}" data-task-id="${esc(t.id)}">✕</button>` : ''}
        </div>`).join('')}
    </div>` : ''}
    ${(session.role === 'admin' || isCreator) && t.status === 'open' ? `
    <div class="row" style="margin-top:8px;">
      <input type="text" id="checklist-new-${t.id}" placeholder="Add a checklist item..." style="flex:1;">
      <button class="btn btn-sm" data-add-checklist="${t.id}">Add</button>
    </div>` : ''}
    <div class="small muted" style="margin-top:12px;">History</div>
    ${renderTaskActivityFeed(t)}
    ${t.status === 'open' && canCommentHere ? `
      <label style="margin-top:8px;">Reply <span class="muted small">(type @ to tag someone)</span></label>
      <div style="position:relative;">
        <textarea id="task-reply-${t.id}" data-mention-input placeholder="Update or question... use @name to tag someone"></textarea>
        <div id="task-reply-mentions-${t.id}" class="tag-suggestions-dropdown" style="display:none;"></div>
      </div>
      <label style="margin-top:8px;">Attachment (optional)</label>
      <input type="file" id="task-reply-file-${t.id}">
      <div id="task-reply-file-preview-${t.id}"></div>
      <button class="btn btn-sm" id="task-comment-btn-${t.id}" style="margin-top:8px;" data-reply-task="${t.id}">Reply</button>
    ` : ''}
    ${t.status === 'open' && !t.blocked && iAmTagged && myRow && !myRow.is_released ? `
      <div class="notice" style="margin-top:10px;">🔒 You're on hold for now (Level ${myRow.stage}) — you'll be notified the moment you're released.</div>
    ` : ''}
    ${t.status === 'open' && !t.blocked && iAmTagged && myRow && myRow.is_released && !iAmDone ? (
      iAmSubmitted
        ? `<div class="notice" style="margin-top:10px;">Submitted — waiting on ${esc(t.created_by || 'the creator')} to approve. <span class="muted">Your note: "${esc(myRow.submission_note || '')}"</span></div>`
        : (checklist.length > 0 && checklistDone < checklist.length)
          ? `<div class="notice" style="margin-top:10px;border-color:var(--amber);">Check off every checklist item above (${checklistDone}/${checklist.length} done) before you can submit your part.</div>`
          : `<div class="card" style="background:var(--panel);margin-top:10px;padding:10px 14px;">
               <label>Briefly describe what you completed (required — this is what ${esc(t.created_by || 'the creator')} will review)</label>
               <textarea id="submit-note-${t.id}" placeholder="e.g. Poured and leveled slab section B, photos attached"></textarea>
               <button class="btn btn-primary btn-sm" style="margin-top:6px;" data-submit-mine="${t.id}">Submit My Part for Approval</button>
             </div>${assignees.length > 1 ? `<div class="small muted" style="margin-top:6px;">${doneCount}/${assignees.length} approved so far — the task closes once everyone's part is approved.</div>` : ''}`
    ) : ''}
    ${releasableStages.length > 0 ? releasableStages.map(s => `
      <button class="btn btn-sm btn-teal" style="margin-top:8px;margin-right:6px;" data-release-stage="${t.id}" data-stage="${s}">Release Level ${s}</button>
    `).join('') : ''}
    ${canApproveHere && pendingApproval.length > 0 ? `
    <div class="card" style="background:var(--panel);margin-top:10px;padding:10px 14px;">
      <div class="small muted" style="margin-bottom:6px;">Pending Your Approval</div>
      ${pendingApproval.map(a => `
        <div style="padding:8px 0;border-bottom:1px solid var(--line);">
          <div class="flex-between">
            <span>${esc(a.username)} <span class="muted small">submitted ${fmtTime(a.submitted_at)}</span></span>
            <span><button class="btn btn-sm btn-primary" style="padding:3px 10px;" data-approve-assignee="${t.id}" data-username="${esc(a.username)}">Approve</button></span>
          </div>
          <div class="doc-note" style="margin:6px 0;">${esc(a.submission_note || '(no note provided)')}</div>
          <div class="row" style="align-items:flex-end;">
            <div class="col"><input type="text" id="reject-reason-${t.id}-${esc(a.username)}" placeholder="Reason for rejecting (required)"></div>
            <div class="col" style="flex:0;"><button class="btn btn-sm btn-danger" data-reject-assignee="${t.id}" data-username="${esc(a.username)}">Reject</button></div>
          </div>
        </div>`).join('')}
    </div>` : ''}
    ${t.status === 'open' && !t.blocked && canForceClose ? `
      <button class="btn btn-sm" style="margin-top:8px;" data-close-task="${t.id}" data-fully-approved="${doneCount === assignees.length}" title="Only whoever created this task, or Admin, can close it">Close Task</button>
      <button class="btn btn-sm btn-danger" style="margin-top:8px;margin-left:6px;" data-act="toggle-cancel-form" data-task-id="${t.id}" title="For a task that was a mistake or is being abandoned, not completed">Cancel Task</button>
      ${doneCount < assignees.length ? `<span class="small muted" style="margin-left:8px;">Waiting on ${assignees.filter(a => !isApproved(a)).map(a => esc(a.username)).join(', ')}</span>` : ''}
      ${ui.cancelFormTaskId === t.id ? `
        <div class="row" style="margin-top:8px;align-items:flex-end;">
          <div class="col"><label>Reason for cancelling (required)</label><input type="text" id="cancel-reason-${t.id}" placeholder="e.g. Duplicate of another task, project scope changed"></div>
          <div class="col" style="flex:0;"><button class="btn btn-sm btn-danger" data-act="submit-cancel" data-task-id="${t.id}">Confirm Cancel</button></div>
        </div>` : ''}
    ` : ''}
    ${(() => {
      const subtasksList = t.subtasks || [];
      const subCount = t.subtaskCount !== undefined ? t.subtaskCount : subtasksList.length;
      const openSubCount = t.openSubtaskCount !== undefined ? t.openSubtaskCount : subtasksList.filter(s => s.status === 'open').length;
      if (subCount === 0) return '';
      const summaryLine = openSubCount > 0
        ? `⚠ ${subCount - openSubCount}/${subCount} subtasks closed — this task can't close until the rest are`
        : `✓ All ${subCount} subtask${subCount === 1 ? '' : 's'} closed`;
      return `
      <div class="subtask-list-box" style="margin-top:8px;">
        <div class="small ${openSubCount > 0 ? 'muted' : ''}">${summaryLine}</div>
        ${subtasksList.length > 0 ? `
        <div class="subtask-rows">
          ${subtasksList.map(s => `
            <div class="subtask-row">
              <span class="subtask-row-status ${s.status === 'open' ? 'open' : (s.status === 'closed' ? 'closed' : 'cancelled')}"></span>
              <span class="subtask-row-title">${esc(s.title)}</span>
              <span class="mono small muted">${esc(s.id)}</span>
              <span class="badge ${s.status === 'open' ? '' : (s.status === 'closed' ? 'received' : 'flag')}" style="margin-left:auto;">${esc(s.status)}</span>
            </div>`).join('')}
        </div>` : ''}
      </div>`;
    })()}
    ${t.status === 'open' && canCommentHere ? `
    <div class="row" style="margin-top:10px;">
      <button class="btn btn-sm" data-act="toggle-followup-form" data-task-id="${t.id}">👀 Ask for Follow-up</button>
      <button class="btn btn-sm" data-act="toggle-subtask-form" data-task-id="${t.id}">➕ Add Subtask</button>
    </div>
    <div id="followup-form-box-${t.id}">${ui.followupFormTaskId === t.id ? followupFormHTML(t.id) : ''}</div>
    <div id="subtask-form-box-${t.id}">${ui.subtaskFormTaskId === t.id ? subtaskFormHTML(t.id) : ''}</div>
    ` : ''}
  </div>`;
}
// Filters a task list by title/description substring match (case-insensitive) against
// ui.taskSearchQuery — shared by both My Tasks and All Tasks so search behaves identically
// in both places.
function applyTaskSearch(tasks) {
  const q = (ui.taskSearchQuery || '').trim().toLowerCase();
  let filtered = tasks;
  if (q) {
    filtered = filtered.filter(t =>
      (t.title || '').toLowerCase().includes(q) ||
      (t.description || '').toLowerCase().includes(q) ||
      (t.id || '').toLowerCase().includes(q) ||
      (t.assignees || []).some(a => (a.username || '').toLowerCase().includes(q))
    );
  }
  if (ui.taskFilterProject) filtered = filtered.filter(t => t.project === ui.taskFilterProject);
  if (ui.taskFilterPhase) filtered = filtered.filter(t => t.phase === ui.taskFilterPhase);
  return filtered;
}
function searchBoxHTML() {
  // Project/Phase filters list only the values genuinely used by the tasks currently in view
  // (not the full company-wide list) — picking "Foundation" should never show as an option if
  // nothing in this list is actually tagged with it.
  const usedProjects = Array.from(new Set(myTasks.concat(session.role === 'admin' ? allTasks : []).map(t => t.project).filter(Boolean))).sort();
  const usedPhases = Array.from(new Set(myTasks.concat(session.role === 'admin' ? allTasks : []).map(t => t.phase).filter(Boolean))).sort();
  return `
    <input type="text" id="task-search-input" placeholder="Search by title, description, task ID, or tagged person..." value="${esc(ui.taskSearchQuery)}" style="margin-bottom:8px;">
    ${(usedProjects.length > 0 || usedPhases.length > 0) ? `
    <div class="row" style="margin-bottom:12px;">
      ${usedProjects.length > 0 ? `
      <div class="col">
        <select id="task-filter-project">
          <option value="">All Projects</option>
          ${usedProjects.map(p => `<option value="${esc(p)}" ${ui.taskFilterProject === p ? 'selected' : ''}>${esc(p)}</option>`).join('')}
        </select>
      </div>` : ''}
      ${usedPhases.length > 0 ? `
      <div class="col">
        <select id="task-filter-phase">
          <option value="">All Phases</option>
          ${usedPhases.map(p => `<option value="${esc(p)}" ${ui.taskFilterPhase === p ? 'selected' : ''}>${esc(p)}</option>`).join('')}
        </select>
      </div>` : ''}
    </div>` : ''}
  `;
}
// History (closed/cancelled) lists are shown a page at a time — with hundreds of tasks
// accumulating over months, rendering every single one always would slow the page down for no
// benefit, since almost nobody scrolls back through all of it at once.
const HISTORY_PAGE_SIZE = 20;
function historyPaginationControls(totalCount, shownCount, moreActionAttr) {
  if (totalCount <= shownCount) return '';
  return `<button class="btn btn-sm" style="margin-top:8px;" ${moreActionAttr}>Show ${Math.min(HISTORY_PAGE_SIZE, totalCount - shownCount)} more (${totalCount - shownCount} remaining)</button>`;
}
function renderMyTasksCard() {
  const openAll = sortTasksForDisplay(applyTaskSearch(myTasks.filter(t => t.status === 'open')));
  // "My part is done, task is still waiting on someone else" reads very differently from "I still
  // have something to do" — splitting these means your own responsibility being finished actually
  // FEELS finished to you, instead of the task lingering in your open list until everyone else
  // catches up too.
  const myPartDone = t => {
    const myRow = (t.assignees || []).find(a => a.username === session.username);
    return !!(myRow && myRow.decision === 'approve' && myRow.completed_at);
  };
  const needsMe = openAll.filter(t => !myPartDone(t));
  const waitingOnOthers = openAll.filter(t => myPartDone(t));
  const closedAll = applyTaskSearch(myTasks.filter(t => t.status !== 'open'));
  const closedShown = closedAll.slice(0, ui.myHistoryShown || HISTORY_PAGE_SIZE);
  return `
  <div class="card">
    <div class="flex-between">
      <div class="card-title" style="margin:0;">My Tasks</div>
      ${needsMe.length > 0 ? `<span class="badge flag">${needsMe.length} open</span>` : ''}
    </div>
    ${searchBoxHTML()}
    ${myTasks.length === 0 ? `<div class="empty">No tasks yet.</div>` : (needsMe.length === 0 ? `<div class="empty">${ui.taskSearchQuery ? 'No open tasks match your search.' : 'Nothing open right now.'}</div>` : '')}
    ${needsMe.map(t => renderTaskItem(t)).join('')}
  </div>
  ${waitingOnOthers.length > 0 ? `
  <div class="card">
    <div class="card-title">Your Part Done <span class="mono small muted">(${waitingOnOthers.length} waiting on others)</span></div>
    <p class="small muted">Your responsibility here is finished — these just haven't fully closed yet because someone else still has their part left.</p>
    ${waitingOnOthers.map(t => renderTaskItem(t)).join('')}
  </div>` : ''}
  ${closedAll.length > 0 ? `
  <div class="card">
    <div class="card-title">Task History <span class="mono small muted">(${closedAll.length} closed/cancelled)</span></div>
    ${closedShown.map(t => renderTaskItem(t)).join('')}
    ${historyPaginationControls(closedAll.length, closedShown.length, 'data-act="show-more-my-history"')}
  </div>` : ''}`;
}
function renderAllTasksCard() {
  const open = sortTasksForDisplay(applyTaskSearch(allTasks.filter(t => t.status === 'open')));
  const closedAll = applyTaskSearch(allTasks.filter(t => t.status !== 'open'));
  const closedShown = closedAll.slice(0, ui.allHistoryShown || HISTORY_PAGE_SIZE);
  return `
  <div class="notice">Every task in the company — tagged people submit their part for approval; only whoever created the task (or Admin) can approve, reject, cancel, or force-close it.</div>
  <div class="card">
    <div class="card-title">Open (${open.length})</div>
    ${searchBoxHTML()}
    ${open.length === 0 ? `<div class="empty">${ui.taskSearchQuery ? 'No open tasks match your search.' : 'Nothing open.'}</div>` : open.map(t => renderTaskItem(t)).join('')}
  </div>
  ${closedAll.length > 0 ? `
  <div class="card">
    <div class="card-title">Closed / Cancelled (${closedAll.length})</div>
    ${closedShown.map(t => renderTaskItem(t)).join('')}
    ${historyPaginationControls(closedAll.length, closedShown.length, 'data-act="show-more-all-history"')}
  </div>` : ''}`;
}
// Inline @mention autocomplete for a plain <textarea> — finds the "@fragment" currently being
// typed at the cursor, shows matching people below, and on selection replaces just that
// fragment with "@username " in place, keeping the rest of the message and cursor position
// sane. Submitted messages are parsed server-side for valid @mentions and those people get
// notified, even if they weren't already tagged on the task.
function bindMentionTextarea(textareaEl, sugEl) {
  function currentFragment() {
    const pos = textareaEl.selectionStart;
    const upToCursor = textareaEl.value.slice(0, pos);
    const match = upToCursor.match(/@([a-zA-Z0-9._-]*)$/);
    return match ? { query: match[1], start: pos - match[0].length, end: pos } : null;
  }
  function renderSuggestions() {
    const frag = currentFragment();
    if (!frag) { sugEl.style.display = 'none'; sugEl.innerHTML = ''; return; }
    const q = frag.query.toLowerCase();
    const matches = userDirectory.filter(u =>
      u.username.toLowerCase().includes(q) || u.name.toLowerCase().includes(q)
    ).slice(0, 8);
    if (matches.length === 0) { sugEl.style.display = 'none'; sugEl.innerHTML = ''; return; }
    sugEl.style.display = 'block';
    sugEl.innerHTML = matches.map(u => `<div class="tag-suggestion-item" data-mention-pick="${esc(u.username)}">${esc(u.name)} <span class="muted small">(${esc(u.username)}${u.team ? ' · ' + esc(u.team) : ''})</span></div>`).join('');
    sugEl.querySelectorAll('[data-mention-pick]').forEach(el => el.onclick = () => {
      const uname = el.dataset.mentionPick;
      const f = currentFragment();
      if (f) {
        const before = textareaEl.value.slice(0, f.start);
        const after = textareaEl.value.slice(f.end);
        textareaEl.value = `${before}@${uname} ${after}`;
        const newPos = before.length + uname.length + 2;
        textareaEl.focus();
        textareaEl.setSelectionRange(newPos, newPos);
      }
      sugEl.style.display = 'none'; sugEl.innerHTML = '';
    });
  }
  textareaEl.addEventListener('input', renderSuggestions);
  textareaEl.addEventListener('keyup', e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') renderSuggestions(); });
  textareaEl.addEventListener('blur', () => { setTimeout(() => { sugEl.style.display = 'none'; }, 150); });
}
// Turns valid @username mentions in already-escaped text into styled tags — invalid/unknown
// mentions are left as plain text so a stray "@" in normal writing isn't mistaken for a tag.
function highlightMentions(text) {
  return esc(text).replace(/@([a-zA-Z0-9._-]{3,40})/g, (match, uname) => {
    const u = userDirectory.find(x => x.username === uname);
    return u ? `<span class="mention-tag">@${esc(uname)}</span>` : match;
  });
}
// onChange(currentSelectionArray) is called after every add/remove so the caller can persist the
// selection into `ui` — required now that forms are declarative and can be re-rendered (e.g. by
// a background poll) at any moment without losing what was picked so far.
function bindTagPicker(rootEl, initialUsernames, onChange) {
  const selected = new Set(initialUsernames || []);
  const chipsEl = rootEl.querySelector('[data-tagpicker-chips]');
  const inputEl = rootEl.querySelector('[data-tagpicker-input]');
  const sugEl = rootEl.querySelector('[data-tagpicker-suggestions]');
  function personLabel(uname) {
    const u = userDirectory.find(x => x.username === uname);
    if (!u) return esc(uname);
    return `${esc(u.name)} <span class="muted small">(${esc(u.username)}${u.team ? ' · ' + esc(u.team) : ''})</span>`;
  }
  function notifyChange() { if (onChange) onChange(Array.from(selected)); }
  function renderChips() {
    chipsEl.innerHTML = selected.size === 0 ? '<span class="small muted">No one tagged yet — search below.</span>' :
      Array.from(selected).map(uname => `<span class="badge received" style="margin:2px 5px 2px 0;display:inline-flex;align-items:center;gap:5px;">${personLabel(uname)}<span data-untag="${esc(uname)}" style="cursor:pointer;font-weight:700;">✕</span></span>`).join('');
    chipsEl.querySelectorAll('[data-untag]').forEach(x => x.onclick = () => { selected.delete(x.dataset.untag); renderChips(); renderSuggestions(); notifyChange(); });
  }
  function renderSuggestions() {
    const q = inputEl.value.trim().toLowerCase().replace(/^@/, '');
    if (!q) { sugEl.style.display = 'none'; sugEl.innerHTML = ''; return; }
    const matches = userDirectory.filter(u => !selected.has(u.username) &&
      (u.name.toLowerCase().includes(q) || u.username.toLowerCase().includes(q) || (u.team || '').toLowerCase().includes(q))
    ).slice(0, 8);
    sugEl.style.display = matches.length ? 'block' : 'none';
    sugEl.innerHTML = matches.map(u => `<div class="tag-suggestion-item" data-suggest="${esc(u.username)}">${esc(u.name)} <span class="muted small">(${esc(u.username)}${u.team ? ' · ' + esc(u.team) : ''})</span></div>`).join('');
    sugEl.querySelectorAll('[data-suggest]').forEach(el => el.onclick = () => {
      selected.add(el.dataset.suggest); inputEl.value = ''; renderChips(); sugEl.style.display = 'none'; sugEl.innerHTML = ''; inputEl.focus(); notifyChange();
    });
  }
  inputEl.oninput = renderSuggestions;
  inputEl.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); const first = sugEl.querySelector('[data-suggest]'); if (first) first.click(); }
    if (e.key === 'Escape') { sugEl.style.display = 'none'; sugEl.innerHTML = ''; }
  });
  document.addEventListener('click', e => { if (!rootEl.contains(e.target)) { sugEl.style.display = 'none'; } });
  renderChips();
  return { getSelected: () => Array.from(selected) };
}
// The "+ New Task" / "Ask for Drawing" form is now fully declarative: its open/closed state,
// mode, and current tag selection all live in `ui`, and its HTML is embedded directly in
// renderTasksView() rather than injected into an empty placeholder div. Previously, that
// placeholder was regenerated empty by the template on every render — meaning any background
// refresh (or any other action) silently wiped out a form you were in the middle of filling in.
// Now the template always faithfully reproduces whatever the form's current state actually is.
function designAndAdminDefaults() {
  const designTeamUsernames = userDirectory.filter(u => (u.team || '').toLowerCase().includes('design')).map(u => u.username);
  const adminUsername = (userDirectory.find(u => u.role === 'admin') || {}).username;
  return Array.from(new Set([...designTeamUsernames, ...(adminUsername ? [adminUsername] : [])]));
}
function taskFormHTML() {
  if (!ui.taskFormOpen) return '';
  const isDrawingRequest = !!ui.taskFormIsDrawing;
  const designTeamUsernames = isDrawingRequest ? userDirectory.filter(u => (u.team || '').toLowerCase().includes('design')).map(u => u.username) : [];
  const stages = ui.taskFormStages && ui.taskFormStages.length > 0 ? ui.taskFormStages : [{ usernames: [] }];
  return `
    <div class="card" id="task-form-inner" style="background:var(--panel-2);margin-top:10px;">
      ${isDrawingRequest ? `<div class="notice">Design Team${designTeamUsernames.length === 0 ? ' (no one is on a "Design" team yet — add one under Accounts)' : ''} and Admin are tagged automatically. Attach CAD/drawing files up to ~100MB — ${CAD_DRAWING_EXTENSIONS.join(', ')} and similar are all accepted.</div>` : ''}
      <label>Title</label>
      <input type="text" id="new-task-title" placeholder="e.g. Confirm delivery timeline" value="${isDrawingRequest ? 'Drawing Request' : ''}" required>
      <label>Description</label>
      <textarea id="new-task-desc" placeholder="${isDrawingRequest ? 'Which drawing, which project, and by when' : 'Details, context, what\'s needed'}"></textarea>
      <div class="row">
        <div class="col">
          <label>Project (optional)</label>
          <input type="text" id="new-task-project" list="task-projects-datalist" placeholder="Type or pick a project">
          <datalist id="task-projects-datalist">${projectsList.map(p => `<option value="${esc(p)}">`).join('')}</datalist>
        </div>
        <div class="col">
          <label>Phase (optional)</label>
          <input type="text" id="new-task-phase" list="task-phases-datalist" placeholder="e.g. Foundation, Structure, Finishing">
          <datalist id="task-phases-datalist">${phasesList.map(p => `<option value="${esc(p)}">`).join('')}</datalist>
        </div>
      </div>
      <div class="row">
        <div class="col"><label>Priority</label><select id="new-task-priority"><option value="medium" selected>Medium</option><option value="high">High</option><option value="low">Low</option></select></div>
        <div class="col"><label>Deadline</label><input type="date" id="new-task-deadline" required></div>
        <div class="col"><label>Time (optional)</label><input type="time" id="new-task-deadline-time"></div>
      </div>
      ${!isDrawingRequest ? `
      <button class="btn btn-sm" data-act="ai-check-deadline" style="margin-bottom:10px;">Check Deadline Against History</button>
      <div id="ai-deadline-warning"></div>` : ''}
      ${isDrawingRequest ? `
      <label>Tag People (task closes only once everyone tagged has completed their part)</label>
      <div class="tagpicker" id="new-task-tagpicker">
        <div data-tagpicker-chips style="margin-bottom:6px;"></div>
        <div style="position:relative;">
          <input type="text" data-tagpicker-input placeholder="Type a name, username, or team — try @ to search">
          <div data-tagpicker-suggestions class="tag-suggestions-dropdown" style="display:none;"></div>
        </div>
      </div>` : `
      <label>Tag People — split into Levels if some people should wait on others (like Level 1's material tag, then Level 2 gets released)</label>
      <div id="task-stages-container">
        ${stages.map((s, idx) => `
          <div class="level-box" data-stage-block="${idx}">
            <div class="flex-between" style="margin-bottom:6px;">
              <b class="small">Level ${idx + 1}${idx === 0 ? ' — starts released' : ' — starts on hold'}</b>
              ${stages.length > 1 && idx > 0 ? `<span data-remove-stage="${idx}" style="cursor:pointer;font-weight:700;font-size:12px;" title="Remove this level">✕ remove level</span>` : ''}
            </div>
            <div class="tagpicker" id="stage-tagpicker-${idx}">
              <div data-tagpicker-chips style="margin-bottom:6px;"></div>
              <div style="position:relative;">
                <input type="text" data-tagpicker-input placeholder="Type a name, username, or team — try @ to search">
                <div data-tagpicker-suggestions class="tag-suggestions-dropdown" style="display:none;"></div>
              </div>
            </div>
          </div>`).join('')}
      </div>
      <button class="btn btn-sm" data-act="add-task-stage" style="margin-bottom:10px;">+ Add Level (hold people until the level before them is approved)</button>
      ${stages.length > 1 ? `
      <label style="display:flex;align-items:center;gap:8px;font-weight:400;margin-bottom:10px;">
        <input type="checkbox" id="task-form-auto-release" style="width:auto;" ${ui.taskFormAutoRelease ? 'checked' : ''}>
        Auto-release the next stage the moment the stage before it is fully approved (otherwise you release each stage manually, whenever you're ready)
      </label>` : ''}
      `}
      <label>Depends On (optional) — this task stays "Blocked" and can't close until the one you pick here closes first. Nobody is notified just by picking one here except the task it depends on getting flagged as a prerequisite.</label>
      <select id="new-task-depends">
        <option value="">— None, this task doesn't wait on anything —</option>
        ${openTaskTitles.map(t => `<option value="${esc(t.id)}">${esc(t.title)}${t.deadline ? ` — due ${fmtDate(t.deadline)}` : ''} (${esc(t.id)})</option>`).join('')}
      </select>
      <label>${isDrawingRequest ? 'Drawing File (CAD/drawing formats, up to ~100MB)' : 'Attachment (optional)'}</label>
      <input type="file" id="new-task-file">
      <div id="new-task-file-preview">${ui.pendingTaskFileName ? `<div class="small muted">Attached: ${esc(ui.pendingTaskFileName)}</div>` : ''}</div>
      <div style="margin-top:6px;">
        <button class="btn btn-primary btn-sm" data-act="submit-task">${isDrawingRequest ? 'Send Drawing Request' : 'Create Task'}</button>
        <button class="btn btn-sm" data-act="cancel-task-form" style="margin-left:6px;">Cancel</button>
      </div>
    </div>`;
}
function bindTaskForm() {
  if (!ui.taskFormOpen) return;
  const isDrawingRequest = !!ui.taskFormIsDrawing;
  let flatTagPicker = null;
  const stagePickers = [];
  if (isDrawingRequest) {
    flatTagPicker = bindTagPicker(document.getElementById('new-task-tagpicker'), ui.taskFormTags || [], (sel) => { ui.taskFormTags = sel; });
  } else {
    const stages = ui.taskFormStages && ui.taskFormStages.length > 0 ? ui.taskFormStages : [{ usernames: [] }];
    stages.forEach((s, idx) => {
      const el = document.getElementById(`stage-tagpicker-${idx}`);
      if (el) stagePickers[idx] = bindTagPicker(el, s.usernames || [], (sel) => { ui.taskFormStages[idx].usernames = sel; });
    });
    document.querySelectorAll('[data-remove-stage]').forEach(el => el.onclick = () => {
      ui.taskFormStages.splice(parseInt(el.dataset.removeStage, 10), 1);
      render();
    });
    const addStageBtn = document.querySelector('[data-act="add-task-stage"]');
    if (addStageBtn) addStageBtn.onclick = () => { ui.taskFormStages = ui.taskFormStages || [{ usernames: [] }]; ui.taskFormStages.push({ usernames: [] }); render(); };
    const autoReleaseBox = document.getElementById('task-form-auto-release');
    if (autoReleaseBox) autoReleaseBox.onchange = () => { ui.taskFormAutoRelease = autoReleaseBox.checked; };
  }
  const deadlineCheckBtn = document.querySelector('[data-act="ai-check-deadline"]');
  if (deadlineCheckBtn) deadlineCheckBtn.onclick = async () => {
    const priority = document.getElementById('new-task-priority').value;
    const dateVal = document.getElementById('new-task-deadline').value;
    const timeVal = document.getElementById('new-task-deadline-time').value;
    if (!dateVal) { alert('Pick a deadline first.'); return; }
    const deadline = timeVal ? `${dateVal}T${timeVal}` : dateVal;
    const warnEl = document.getElementById('ai-deadline-warning');
    if (warnEl) warnEl.innerHTML = '<span class="small muted">Checking…</span>';
    try {
      const result = await api('/api/ai/deadline-check', { method: 'POST', body: JSON.stringify({ priority, deadline }) });
      if (warnEl) warnEl.innerHTML = result.warning ? `<div class="notice" style="border-color:var(--amber);">⚠️ ${esc(result.warning)}</div>` : `<div class="small muted">No historical concern found for this deadline.</div>`;
    } catch (e) { if (warnEl) warnEl.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  };
  document.querySelector('[data-act="submit-task"]').onclick = async () => {
    const titleEl = document.getElementById('new-task-title');
    const deadlineEl = document.getElementById('new-task-deadline');
    const title = titleEl.value.trim();
    const description = document.getElementById('new-task-desc').value.trim();
    const project = document.getElementById('new-task-project').value.trim();
    const phase = document.getElementById('new-task-phase').value.trim();
    const priority = document.getElementById('new-task-priority').value;
    const deadline = deadlineEl.value.trim();
    const deadlineTime = document.getElementById('new-task-deadline-time').value.trim();
    const fullDeadline = deadline && deadlineTime ? `${deadline}T${deadlineTime}` : deadline;
    const dependsOnTaskId = document.getElementById('new-task-depends').value;
    // Native browser validation UI (red outline + tooltip) via reportValidity() — this app has
    // no <form> elements anywhere, so a bare `required` attribute alone never actually triggers;
    // it only does anything when explicitly checked like this.
    if (!titleEl.reportValidity()) return;
    if (!deadlineEl.reportValidity()) return;
    let assignedToList = [];
    let stagesPayload = null;
    if (isDrawingRequest) {
      assignedToList = flatTagPicker.getSelected();
    } else {
      const groups = stagePickers.map(p => p.getSelected()).filter(g => g.length > 0);
      const allNames = groups.flat();
      if (new Set(allNames).size !== allNames.length) { alert("The same person is tagged in more than one stage — remove them from all but one."); return; }
      stagesPayload = groups;
      assignedToList = allNames;
    }
    if (assignedToList.length === 0) { alert('At least one tagged person is required.'); return; }
    try {
      await api('/api/tasks', { method: 'POST', body: JSON.stringify({
        title, description, priority, deadline: fullDeadline, assignedToList,
        project: project || null, phase: phase || null,
        stages: stagesPayload ? stagesPayload.map(usernames => ({ usernames })) : null,
        autoReleaseStages: !!ui.taskFormAutoRelease,
        dependsOnTaskId, attachment: ui.pendingTaskFile, attachmentName: ui.pendingTaskFileName, isDrawingRequest,
      }) });
      ui.pendingTaskFile = null; ui.pendingTaskFileName = null; ui.taskFormOpen = false; ui.taskFormTags = [];
      ui.taskFormStages = [{ usernames: [] }]; ui.taskFormAutoRelease = false;
      celebrate(isDrawingRequest ? 'Drawing request sent! 📐' : undefined, RAISE_MESSAGES);
      setBanner(isDrawingRequest ? 'Drawing request sent.' : 'Task created.', 'ok');
      await refreshData();
    } catch (e) { setBanner(e.message); render(); }
  };
  document.querySelector('[data-act="cancel-task-form"]').onclick = () => {
    ui.taskFormOpen = false; ui.taskFormTags = []; ui.taskFormStages = [{ usernames: [] }]; ui.taskFormAutoRelease = false;
    ui.pendingTaskFile = null; ui.pendingTaskFileName = null; render();
  };
  document.getElementById('new-task-file').onchange = (ev) => {
    const f = ev.target.files[0]; if (!f) return;
    readAnyFile(f, dataUrl => {
      ui.pendingTaskFile = dataUrl; ui.pendingTaskFileName = f.name;
      document.getElementById('new-task-file-preview').innerHTML = dataUrl ? `<div class="small muted">Attached: ${esc(f.name)}</div>` : '<div class="err">Could not read file (too large?).</div>';
    });
  };
}
function renderTasksView() {
  return `
  <div class="card">
    <div class="flex-between">
      <div class="card-title" style="margin:0;">Create Task</div>
      <div>
        <button class="btn btn-sm" data-act="toggle-task-form">+ New Task</button>
      </div>
    </div>
    <div id="task-form-box">${taskFormHTML()}</div>
  </div>
  <div class="card">
    <div class="flex-between">
      <div class="card-title" style="margin:0;">Send for Approval</div>
      <button class="btn btn-sm" data-act="toggle-approval-form">📄 Send for Approval</button>
    </div>
    <p class="small muted" style="margin-top:4px;">For documents that need a direct yes/no from specific people — they approve or reject the document itself, no work to submit.</p>
    <div id="approval-form-box">${approvalFormHTML()}</div>
  </div>
  ${renderApprovalsSection()}
  ${renderMyTasksCard()}`;
}
/* ==================== SEND FOR APPROVAL ==================== */
function approvalFormHTML() {
  if (!ui.approvalFormOpen) return '';
  return `
    <div class="card" id="approval-form-inner" style="background:var(--panel-2);margin-top:10px;">
      <label>Title</label>
      <input type="text" id="new-approval-title" placeholder="e.g. Vendor Contract — Cement Supply" required>
      <label>Description (optional)</label>
      <textarea id="new-approval-desc" placeholder="Context for the approvers"></textarea>
      <label>Tag Approvers (one rejection sends it back for revision)</label>
      <div class="tagpicker" id="new-approval-tagpicker">
        <div data-tagpicker-chips style="margin-bottom:6px;"></div>
        <div style="position:relative;">
          <input type="text" data-tagpicker-input placeholder="Type a name, username, or team — try @ to search">
          <div data-tagpicker-suggestions class="tag-suggestions-dropdown" style="display:none;"></div>
        </div>
      </div>
      <label>Document</label>
      <input type="file" id="new-approval-file">
      <div id="new-approval-file-preview">${ui.pendingApprovalFileName ? `<div class="small muted">Attached: ${esc(ui.pendingApprovalFileName)}</div>` : ''}</div>
      <div style="margin-top:6px;">
        <button class="btn btn-primary btn-sm" data-act="submit-approval">Send for Approval</button>
        <button class="btn btn-sm" data-act="cancel-approval-form" style="margin-left:6px;">Cancel</button>
      </div>
    </div>`;
}
function bindApprovalForm() {
  if (!ui.approvalFormOpen) return;
  const tagPicker = bindTagPicker(document.getElementById('new-approval-tagpicker'), ui.approvalFormReviewers || [], (sel) => { ui.approvalFormReviewers = sel; });
  const fileInput = document.getElementById('new-approval-file');
  if (fileInput) fileInput.onchange = (ev) => {
    const f = ev.target.files[0]; if (!f) return;
    readAnyFile(f, dataUrl => {
      ui.pendingApprovalFile = dataUrl; ui.pendingApprovalFileName = f.name;
      const preview = document.getElementById('new-approval-file-preview');
      if (preview) preview.innerHTML = dataUrl ? `<div class="small muted">Attached: ${esc(f.name)}</div>` : '<div class="err">Could not read file (too large?).</div>';
    });
  };
  const submitBtn = document.querySelector('[data-act="submit-approval"]');
  if (submitBtn) submitBtn.onclick = async () => {
    const titleEl = document.getElementById('new-approval-title');
    const title = titleEl.value.trim();
    const description = document.getElementById('new-approval-desc').value.trim();
    const reviewers = tagPicker.getSelected();
    if (!titleEl.reportValidity()) return;
    if (reviewers.length === 0) { alert('Tag at least one approver.'); return; }
    if (!ui.pendingApprovalFile) { alert('Select a document first.'); return; }
    try {
      await api('/api/approvals', { method: 'POST', body: JSON.stringify({ title, description, reviewers, fileData: ui.pendingApprovalFile, fileName: ui.pendingApprovalFileName }) });
      ui.approvalFormOpen = false; ui.approvalFormReviewers = []; ui.pendingApprovalFile = null; ui.pendingApprovalFileName = null;
      celebrate('Sent for approval! 📄', RAISE_MESSAGES);
      setBanner('Sent for approval.', 'ok');
      await refreshData();
    } catch (e) { setBanner(e.message); render(); }
  };
  const cancelBtn = document.querySelector('[data-act="cancel-approval-form"]');
  if (cancelBtn) cancelBtn.onclick = () => { ui.approvalFormOpen = false; ui.approvalFormReviewers = []; ui.pendingApprovalFile = null; ui.pendingApprovalFileName = null; render(); };
}
const APPROVAL_STATUS_BADGE = { pending: '<span class="badge po_pending">PENDING</span>', approved: '<span class="badge received">APPROVED</span>', needs_revision: '<span class="badge flag">NEEDS REVISION</span>' };
function renderApprovalRequestCard(r) {
  const isCreator = r.created_by_username === session.username;
  const myReview = (r.reviewers || []).find(rv => rv.username === session.username);
  const canDecide = r.status === 'pending' && myReview && !myReview.decision;
  return `
  <div class="card" id="approval-card-${esc(r.id)}" style="background:var(--panel-2);">
    <div class="flex-between">
      <div><b>${esc(r.title)}</b></div>
      ${APPROVAL_STATUS_BADGE[r.status] || ''}
    </div>
    ${r.description ? `<div class="doc-note">${esc(r.description)}</div>` : ''}
    <div class="muted small" style="margin-top:6px;">Sent by ${esc(r.created_by_name)} · ${fmtTime(r.created_at)}</div>
    ${lazyAttachmentHTML(r.has_file, r.file_name, `/api/approvals/${r.id}/attachment`, `approval-file-${r.id}`)}
    <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:6px;">
      ${(r.reviewers || []).map(rv => {
        let cls = 'created', label = esc(rv.username);
        if (rv.decision === 'approved') { cls = 'received'; label += ' ✓ Approved'; }
        else if (rv.decision === 'rejected') { cls = 'flag'; label += ' ✗ Rejected'; }
        return `<span class="badge ${cls}">${label}</span>`;
      }).join('')}
    </div>
    <div class="small muted" style="margin-top:10px;">History</div>
    <div class="timeline">
      ${(r.history || []).map(h => `<div class="tl-item"><div class="tl-role">${esc(h.actor_name || 'System')}</div><div class="tl-time">${fmtTime(h.created_at)}</div><div class="tl-note">${esc(h.event_text)}</div></div>`).join('')}
    </div>
    ${canDecide ? `
    <div class="row" style="margin-top:10px;align-items:flex-end;">
      <div class="col"><input type="text" id="approval-reason-${r.id}" placeholder="Reason (required only if rejecting)"></div>
      <div class="col" style="flex:0;">
        <button class="btn btn-sm btn-primary" data-approve-request="${r.id}">Approve</button>
        <button class="btn btn-sm btn-danger" data-reject-request="${r.id}">Reject</button>
      </div>
    </div>` : ''}
    ${isCreator && r.status === 'needs_revision' ? `
    <div class="card" style="background:var(--panel);margin-top:10px;padding:10px 14px;">
      <label>Upload revised document</label>
      <input type="file" id="approval-revise-file-${r.id}">
      <div id="approval-revise-preview-${r.id}"></div>
      <button class="btn btn-primary btn-sm" style="margin-top:6px;" data-revise-request="${r.id}">Send Revision</button>
    </div>` : ''}
  </div>`;
}
function renderApprovalsSection() {
  const scope = (session.role === 'admin' && ui.approvalsScope === 'all') ? allApprovalRequests : myApprovalRequests;
  return `
  <div class="card">
    <div class="flex-between">
      <div class="card-title" style="margin:0;">Approval Requests</div>
      ${session.role === 'admin' ? `
      <select id="approvals-scope" style="width:auto;padding:4px 8px;">
        <option value="mine" ${ui.approvalsScope !== 'all' ? 'selected' : ''}>Mine</option>
        <option value="all" ${ui.approvalsScope === 'all' ? 'selected' : ''}>All</option>
      </select>` : ''}
    </div>
    ${scope.length === 0 ? `<div class="empty">Nothing here yet.</div>` : scope.map(renderApprovalRequestCard).join('')}
  </div>`;
}
function bindApprovalsSection() {
  const scopeSelect = document.getElementById('approvals-scope');
  if (scopeSelect) scopeSelect.onchange = () => { ui.approvalsScope = scopeSelect.value; render(); };
  document.querySelectorAll('[data-approve-request]').forEach(btn => btn.onclick = async () => {
    const id = btn.dataset.approveRequest;
    try {
      const result = await api(`/api/approvals/${id}/decide`, { method: 'POST', body: JSON.stringify({ decision: 'approved' }) });
      celebrate(undefined, result.status === 'approved' ? CLOSE_MESSAGES : COMPLETION_MESSAGES);
      setBanner('Approved.', 'ok'); await refreshData();
    } catch (e) { setBanner(e.message); render(); }
  });
  document.querySelectorAll('[data-reject-request]').forEach(btn => btn.onclick = async () => {
    const id = btn.dataset.rejectRequest;
    const reasonEl = document.getElementById(`approval-reason-${id}`);
    const reason = reasonEl ? reasonEl.value.trim() : '';
    if (reason.length < 5) { alert('A reason (at least 5 characters) is required to reject.'); return; }
    try {
      await api(`/api/approvals/${id}/decide`, { method: 'POST', body: JSON.stringify({ decision: 'rejected', reason }) });
      setBanner('Rejected — sent back for revision.', 'ok'); await refreshData();
    } catch (e) { setBanner(e.message); render(); }
  });
  document.querySelectorAll('[id^="approval-revise-file-"]').forEach(inp => inp.onchange = () => {
    const id = inp.id.replace('approval-revise-file-', '');
    const f = inp.files[0]; if (!f) return;
    readAnyFile(f, dataUrl => {
      ui.pendingRevisionFiles = ui.pendingRevisionFiles || {};
      ui.pendingRevisionFiles[id] = dataUrl ? { data: dataUrl, name: f.name } : null;
      const preview = document.getElementById(`approval-revise-preview-${id}`);
      if (preview) preview.innerHTML = dataUrl ? `<div class="small muted">Selected: ${esc(f.name)}</div>` : '<div class="err">Could not read file.</div>';
    });
  });
  document.querySelectorAll('[data-revise-request]').forEach(btn => btn.onclick = async () => {
    const id = btn.dataset.reviseRequest;
    const pending = (ui.pendingRevisionFiles || {})[id];
    if (!pending) { alert('Select a revised document first.'); return; }
    try {
      await api(`/api/approvals/${id}/revise`, { method: 'POST', body: JSON.stringify({ fileData: pending.data, fileName: pending.name }) });
      if (ui.pendingRevisionFiles) delete ui.pendingRevisionFiles[id];
      setBanner('Revision sent.', 'ok'); await refreshData();
    } catch (e) { setBanner(e.message); render(); }
  });
}

/* ==================== CALENDAR ====================
   A month grid showing each day's tasks color-coded by priority (matching the same colors used
   for priority badges everywhere else), with a click-through to a full, interactive task list
   for whichever date is selected — reusing renderTaskItem so you can actually act on a task
   (submit, approve, comment) right from the calendar, not just look at it. */
const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };
const PRIORITY_DOT_COLOR = { high: 'var(--rust)', medium: 'var(--amber-dim)', low: 'var(--muted)' };
function toISODateLocal(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function buildCalendarCells(year, month) {
  const firstOfMonth = new Date(year, month, 1);
  const cursor = new Date(firstOfMonth);
  cursor.setDate(cursor.getDate() - cursor.getDay()); // back up to the Sunday on/before the 1st
  const cells = [];
  for (let i = 0; i < 42; i++) {
    cells.push({ date: new Date(cursor), inMonth: cursor.getMonth() === month, iso: toISODateLocal(cursor) });
    cursor.setDate(cursor.getDate() + 1);
  }
  return cells;
}
const WEEK_VIEW_START_HOUR = 6, WEEK_VIEW_END_HOUR = 21, WEEK_ROW_HEIGHT = 46;
function startOfWeekIso(dateIso) {
  const d = new Date(dateIso + 'T00:00:00');
  d.setDate(d.getDate() - d.getDay());
  return toISODateLocal(d);
}
function fmtHour12(h) { const period = h < 12 ? 'AM' : 'PM'; const h12 = h % 12 === 0 ? 12 : h % 12; return `${h12} ${period}`; }
function renderCalendarView() {
  return `
  <div class="card">
    <div class="flex-between" style="margin-bottom:10px;">
      <div style="display:flex;align-items:center;gap:6px;">
        <button class="btn btn-sm ${ui.calendarViewMode !== 'week' ? 'btn-primary' : ''}" data-act="cal-view-month">Month</button>
        <button class="btn btn-sm ${ui.calendarViewMode === 'week' ? 'btn-primary' : ''}" data-act="cal-view-week">Week</button>
      </div>
      ${session.role === 'admin' ? `
      <select id="cal-scope" style="width:auto;padding:4px 8px;">
        <option value="mine" ${ui.calendarScope === 'mine' ? 'selected' : ''}>My Tasks</option>
        <option value="all" ${ui.calendarScope === 'all' ? 'selected' : ''}>All Tasks</option>
      </select>` : ''}
    </div>
  </div>
  ${ui.calendarViewMode === 'week' ? renderCalendarWeekView() : renderCalendarMonthView()}`;
}
function renderCalendarMonthView() {
  const year = ui.calendarYear, month = ui.calendarMonth;
  const cells = buildCalendarCells(year, month);
  const monthLabel = new Date(year, month, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const todayIso = toISODateLocal(new Date());
  const scopeTasks = (session.role === 'admin' && ui.calendarScope === 'all' ? allTasks : myTasks);
  const withDeadlines = scopeTasks.filter(t => t.status === 'open' && t.deadline);
  const noDeadlineCount = scopeTasks.filter(t => t.status === 'open' && !t.deadline).length;
  const sourceTasks = withDeadlines;
  const tasksByDate = new Map();
  sourceTasks.forEach(t => {
    const dateKey = t.deadline.slice(0, 10); // strip time-of-day, if any — bucketing is by day here
    if (!tasksByDate.has(dateKey)) tasksByDate.set(dateKey, []);
    tasksByDate.get(dateKey).push(t);
  });
  tasksByDate.forEach(list => list.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]));
  const selectedIso = ui.calendarSelectedDate;
  const selectedTasks = selectedIso ? (tasksByDate.get(selectedIso) || []) : [];
  const weekdayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return `
  <div class="card">
    ${withDeadlines.length === 0 ? `<div class="notice">No open tasks with a deadline yet — the calendar only shows tasks that have one.${noDeadlineCount > 0 ? ` (${noDeadlineCount} open task${noDeadlineCount === 1 ? '' : 's'} without a deadline ${noDeadlineCount === 1 ? "isn't" : "aren't"} shown here.)` : ''}</div>` : ''}
    <div class="flex-between" style="margin-bottom:10px;">
      <div style="display:flex;align-items:center;gap:10px;">
        <button class="btn btn-sm" data-act="cal-prev">‹</button>
        <div class="card-title" style="margin:0;min-width:150px;text-align:center;">${esc(monthLabel)}</div>
        <button class="btn btn-sm" data-act="cal-next">›</button>
      </div>
      <button class="btn btn-sm" data-act="cal-today">Today</button>
    </div>
    <div class="cal-grid cal-weekdays">${weekdayLabels.map(w => `<div class="cal-weekday">${w}</div>`).join('')}</div>
    <div class="cal-grid">
      ${cells.map(c => {
        const dayTasks = tasksByDate.get(c.iso) || [];
        const isToday = c.iso === todayIso;
        const isSelected = c.iso === selectedIso;
        const shown = dayTasks.slice(0, 3);
        const extra = dayTasks.length - shown.length;
        return `
        <div class="cal-cell ${c.inMonth ? '' : 'cal-cell-outmonth'} ${isToday ? 'cal-cell-today' : ''} ${isSelected ? 'cal-cell-selected' : ''}" data-cal-date="${c.iso}">
          <div class="cal-daynum">${c.date.getDate()}</div>
          <div class="cal-dots">
            ${shown.map(t => `<span class="cal-dot" style="background:${PRIORITY_DOT_COLOR[t.priority] || PRIORITY_DOT_COLOR.medium};" title="${esc(t.title)} (${t.priority})"></span>`).join('')}
            ${extra > 0 ? `<span class="cal-dot-more">+${extra}</span>` : ''}
          </div>
        </div>`;
      }).join('')}
    </div>
  </div>
  ${selectedIso ? `
  <div class="card">
    <div class="card-title">${fmtDate(selectedIso)} <span class="mono small muted">(${selectedTasks.length} task${selectedTasks.length === 1 ? '' : 's'}, priority-sorted)</span></div>
    ${selectedTasks.length === 0 ? `<div class="empty">Nothing due this day.</div>` : selectedTasks.map(t => renderTaskItem(t)).join('')}
  </div>` : ''}`;
}
// Week view: tasks with a deadline TIME are positioned like calendar events at that hour;
// tasks with only a date (no time) show in an "all-day" strip at the top of that day's column —
// same distinction Google Calendar makes between timed events and all-day events.
function renderCalendarWeekView() {
  const weekStart = ui.calendarWeekStart || startOfWeekIso(toISODateLocal(new Date()));
  const startDate = new Date(weekStart + 'T00:00:00');
  const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(startDate); d.setDate(d.getDate() + i); return d; });
  const todayIso = toISODateLocal(new Date());
  const now = new Date();
  const nowHourFloat = now.getHours() + now.getMinutes() / 60;
  const sourceTasks = (session.role === 'admin' && ui.calendarScope === 'all' ? allTasks : myTasks).filter(t => t.status === 'open' && t.deadline);
  const hourRows = []; for (let h = WEEK_VIEW_START_HOUR; h <= WEEK_VIEW_END_HOUR; h++) hourRows.push(h);
  const dayData = days.map(d => {
    const iso = toISODateLocal(d);
    const dayTasks = sourceTasks.filter(t => t.deadline.slice(0, 10) === iso);
    return { date: d, iso, allDay: dayTasks.filter(t => !hasDeadlineTime(t.deadline)), timed: dayTasks.filter(t => hasDeadlineTime(t.deadline)) };
  });
  const selectedTask = ui.calendarWeekSelectedTaskId ? sourceTasks.find(t => t.id === ui.calendarWeekSelectedTaskId) : null;
  return `
  <div class="card">
    <div class="flex-between" style="margin-bottom:10px;">
      <div style="display:flex;align-items:center;gap:10px;">
        <button class="btn btn-sm" data-act="week-prev">‹</button>
        <div class="card-title" style="margin:0;min-width:210px;text-align:center;">${esc(days[0].toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))} – ${esc(days[6].toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }))}</div>
        <button class="btn btn-sm" data-act="week-next">›</button>
      </div>
      <button class="btn btn-sm" data-act="week-today">Today</button>
    </div>
    <div class="week-grid">
      <div class="week-gutter">
        <div class="week-head-spacer"></div>
        <div class="week-allday-spacer"></div>
        ${hourRows.map(h => `<div class="week-hour-label" style="height:${WEEK_ROW_HEIGHT}px;">${fmtHour12(h)}</div>`).join('')}
      </div>
      ${dayData.map(dd => `
        <div class="week-day-col">
          <div class="week-day-head ${dd.iso === todayIso ? 'week-day-head-today' : ''}">
            <div class="week-day-name">${dd.date.toLocaleDateString(undefined, { weekday: 'short' })}</div>
            <div class="week-day-num ${dd.iso === todayIso ? 'week-day-num-today' : ''}">${dd.date.getDate()}</div>
          </div>
          <div class="week-allday">
            ${dd.allDay.map(t => `<div class="week-allday-chip" style="background:${PRIORITY_DOT_COLOR[t.priority] || PRIORITY_DOT_COLOR.medium};" data-cal-week-task="${t.id}" title="${esc(t.title)}">${esc(t.title)}</div>`).join('')}
          </div>
          <div class="week-hours" style="height:${hourRows.length * WEEK_ROW_HEIGHT}px;">
            ${hourRows.map((h, i) => `<div class="week-hour-line" style="top:${i * WEEK_ROW_HEIGHT}px;"></div>`).join('')}
            ${dd.timed.map(t => {
              const d2 = deadlineDate(t.deadline);
              const hourFloat = d2.getHours() + d2.getMinutes() / 60;
              if (hourFloat < WEEK_VIEW_START_HOUR || hourFloat > WEEK_VIEW_END_HOUR + 1) return '';
              const top = (hourFloat - WEEK_VIEW_START_HOUR) * WEEK_ROW_HEIGHT;
              return `<div class="week-task-block" style="top:${top}px;background:${PRIORITY_DOT_COLOR[t.priority] || PRIORITY_DOT_COLOR.medium};" data-cal-week-task="${t.id}" title="${esc(t.title)}"><b>${d2.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</b> ${esc(t.title)}</div>`;
            }).join('')}
            ${dd.iso === todayIso && nowHourFloat >= WEEK_VIEW_START_HOUR && nowHourFloat <= WEEK_VIEW_END_HOUR + 1 ? `<div class="week-now-line" style="top:${(nowHourFloat - WEEK_VIEW_START_HOUR) * WEEK_ROW_HEIGHT}px;"></div>` : ''}
          </div>
        </div>`).join('')}
    </div>
  </div>
  ${selectedTask ? `<div class="card">${renderTaskItem(selectedTask)}</div>` : ''}`;
}
function bindCalendarView() {
  const viewMonthBtn = document.querySelector('[data-act="cal-view-month"]'); if (viewMonthBtn) viewMonthBtn.onclick = () => { ui.calendarViewMode = 'month'; render(); };
  const viewWeekBtn = document.querySelector('[data-act="cal-view-week"]'); if (viewWeekBtn) viewWeekBtn.onclick = () => { ui.calendarViewMode = 'week'; if (!ui.calendarWeekStart) ui.calendarWeekStart = startOfWeekIso(toISODateLocal(new Date())); render(); };
  const weekPrev = document.querySelector('[data-act="week-prev"]');
  if (weekPrev) weekPrev.onclick = () => {
    const d = new Date((ui.calendarWeekStart || startOfWeekIso(toISODateLocal(new Date()))) + 'T00:00:00');
    d.setDate(d.getDate() - 7); ui.calendarWeekStart = toISODateLocal(d); render();
  };
  const weekNext = document.querySelector('[data-act="week-next"]');
  if (weekNext) weekNext.onclick = () => {
    const d = new Date((ui.calendarWeekStart || startOfWeekIso(toISODateLocal(new Date()))) + 'T00:00:00');
    d.setDate(d.getDate() + 7); ui.calendarWeekStart = toISODateLocal(d); render();
  };
  const weekToday = document.querySelector('[data-act="week-today"]'); if (weekToday) weekToday.onclick = () => { ui.calendarWeekStart = startOfWeekIso(toISODateLocal(new Date())); ui.calendarWeekSelectedTaskId = null; render(); };
  document.querySelectorAll('[data-cal-week-task]').forEach(el => el.onclick = () => { ui.calendarWeekSelectedTaskId = (ui.calendarWeekSelectedTaskId === el.dataset.calWeekTask) ? null : el.dataset.calWeekTask; render(); });
  const prev = document.querySelector('[data-act="cal-prev"]');
  if (prev) prev.onclick = () => {
    ui.calendarMonth--; if (ui.calendarMonth < 0) { ui.calendarMonth = 11; ui.calendarYear--; }
    render();
  };
  const next = document.querySelector('[data-act="cal-next"]');
  if (next) next.onclick = () => {
    ui.calendarMonth++; if (ui.calendarMonth > 11) { ui.calendarMonth = 0; ui.calendarYear++; }
    render();
  };
  const todayBtn = document.querySelector('[data-act="cal-today"]');
  if (todayBtn) todayBtn.onclick = () => {
    const now = new Date();
    ui.calendarYear = now.getFullYear(); ui.calendarMonth = now.getMonth(); ui.calendarSelectedDate = toISODateLocal(now);
    render();
  };
  const scopeSelect = document.getElementById('cal-scope');
  if (scopeSelect) scopeSelect.onchange = () => { ui.calendarScope = scopeSelect.value; render(); };
  document.querySelectorAll('[data-cal-date]').forEach(cell => cell.onclick = () => {
    ui.calendarSelectedDate = (ui.calendarSelectedDate === cell.dataset.calDate) ? null : cell.dataset.calDate;
    render();
  });
}

/* ==================== TODAY FEED ==================== */
function isSameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
function renderTodayFeed() {
  const todayStr = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  const now = new Date();
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const closedToday = myTasks.filter(t => t.status === 'closed' && t.closed_at && new Date(t.closed_at) >= todayStart);
  const openTasks = myTasks.filter(t => t.status === 'open');
  // Blocked tasks never count as overdue here either — same fairness reasoning as the per-task
  // OVERDUE badge: someone waiting on a prerequisite hasn't been given a fair chance yet.
  const overdue = openTasks.filter(t => !t.blocked && t.deadline && deadlineDate(t.deadline) < now);
  const dueToday = openTasks.filter(t => t.deadline && !isNaN(deadlineDate(t.deadline)) && isSameDay(deadlineDate(t.deadline), now));
  // "Today's relevant tasks" = anything due today OR finished today, deduped by id, so a task
  // that was due today and got closed today only counts once toward the progress bar.
  const relevantMap = new Map();
  dueToday.forEach(t => relevantMap.set(t.id, t));
  closedToday.forEach(t => relevantMap.set(t.id, t));
  const relevant = Array.from(relevantMap.values());
  const doneCount = relevant.filter(t => t.status === 'closed').length;
  const totalCount = relevant.length;
  const pct = totalCount === 0 ? 0 : Math.round((doneCount / totalCount) * 100);
  return `
  <div class="card">
    <div class="card-title">Today — ${esc(todayStr)}</div>
    <p class="small muted">A running summary of what's happened today and what's expected — not a substitute for My Tasks, just a quick daily glance.</p>
  </div>
  <div class="card">
    <div class="flex-between">
      <div class="card-title" style="margin:0;">Today's Progress</div>
      <span class="small muted">${totalCount === 0 ? 'Nothing scheduled for today' : `${doneCount} of ${totalCount} done`}</span>
    </div>
    <div class="progress-track" style="margin-top:10px;">
      <div class="progress-fill" style="width:${totalCount === 0 ? 0 : pct}%;"></div>
    </div>
    <div class="hero-stat-grid" style="margin-top:16px;">
      <div class="hero-stat-card ${overdue.length > 0 ? 'hero-rose needs-attention' : 'hero-violet'}">
        <div class="hero-stat-label">Overdue<span class="hero-stat-icon">${icon('alertTriangle', 15)}</span></div>
        <div class="hero-stat-number">${overdue.length}</div>
      </div>
      <div class="hero-stat-card hero-coral">
        <div class="hero-stat-label">Due Today<span class="hero-stat-icon">${icon('clock', 15)}</span></div>
        <div class="hero-stat-number">${dueToday.length}</div>
      </div>
      <div class="hero-stat-card hero-teal">
        <div class="hero-stat-label">Completed Today<span class="hero-stat-icon">${icon('checkCircle', 15)}</span></div>
        <div class="hero-stat-number">${closedToday.length}</div>
      </div>
      <div class="hero-stat-card hero-violet">
        <div class="hero-stat-label">Open Total<span class="hero-stat-icon">${icon('grid', 15)}</span></div>
        <div class="hero-stat-number">${openTasks.length}</div>
      </div>
    </div>
  </div>
  ${session.role === 'admin' ? renderLeaderboardCard(monthlyLeaderboard, '🏆 Monthly Leaderboard', "Nobody has completed approved work yet this month.", 'today-monthly') : ''}
  ${renderLeaderboardCard(weeklyLeaderboard, '📅 This Week', "Nobody has completed approved work yet this week.", 'today-weekly')}
  <div class="card">
    <div class="card-title">Ongoing Tasks Progress</div>
    <p class="small muted">Green shows the share of tagged people whose part is approved. Click a bar to see exactly who's done and who's remaining.</p>
    ${openTasks.length === 0 ? `<div class="empty">Nothing ongoing right now.</div>` : openTasks.map(t => {
      const assignees = t.assignees || [];
      const approved = assignees.filter(a => a.decision === 'approve' && a.completed_at);
      const remaining = assignees.filter(a => !(a.decision === 'approve' && a.completed_at));
      const taskPct = assignees.length === 0 ? 0 : Math.round((approved.length / assignees.length) * 100);
      return `
      <div style="margin-bottom:14px;">
        <div class="flex-between">
          <b class="small">${esc(t.title)}</b>
          <span class="small muted">${approved.length}/${assignees.length} done · ${taskPct}%</span>
        </div>
        <div class="task-progress-track" data-toggle-task-progress="${t.id}" title="Click to see who's done and who's remaining">
          <div class="task-progress-fill" style="width:${taskPct}%;"></div>
          <div class="task-progress-pct-label">${taskPct}%</div>
        </div>
        <div class="task-progress-detail" id="task-progress-detail-${t.id}" style="display:none;">
          <div class="small" style="margin-bottom:4px;"><b style="color:var(--success);">✓ Completed:</b> ${approved.length === 0 ? 'no one yet' : approved.map(a => esc(a.username)).join(', ')}</div>
          <div class="small"><b style="color:var(--muted);">○ Remaining:</b> ${remaining.length === 0 ? 'no one — fully approved' : remaining.map(a => esc(a.username) + (a.is_released ? '' : ' (on hold)')).join(', ')}</div>
        </div>
      </div>`;
    }).join('')}
  </div>
  <div class="card">
    <div class="card-title">Completed Today</div>
    ${closedToday.length === 0 ? `<div class="empty">Nothing closed yet today.</div>` : closedToday.map(t => `
      <div class="doc-row" style="display:block;padding:8px 0;border-bottom:1px solid var(--line);">
        <b>${esc(t.title)}</b>
        <div class="small muted">Closed ${fmtTime(t.closed_at)}</div>
      </div>`).join('')}
  </div>
  <div class="card">
    <div class="card-title">Due Today</div>
    ${dueToday.length === 0 ? `<div class="empty">Nothing due today.</div>` : dueToday.map(t => `
      <div class="doc-row" style="display:block;padding:8px 0;border-bottom:1px solid var(--line);">
        <b>${esc(t.title)}</b>
        <div class="small muted">Due ${fmtDate(t.deadline)}</div>
      </div>`).join('')}
  </div>`;
}
function bindTodayFeed() {
  document.querySelectorAll('[data-toggle-task-progress]').forEach(track => track.onclick = () => {
    const detail = document.getElementById(`task-progress-detail-${track.dataset.toggleTaskProgress}`);
    if (detail) detail.style.display = detail.style.display === 'none' ? 'block' : 'none';
  });
}

/* ==================== MY PROFILE (everyone) ==================== */
function renderProfileView() {
  return `
  <div class="card">
    <div class="card-title">Display Name</div>
    <p class="small muted">Shown everywhere in the app — tasks, badges, notifications. Your login username doesn't change.</p>
    <label>Name</label><input type="text" id="profile-name" value="${esc(session.name)}">
    <button class="btn btn-primary btn-sm" style="margin-top:8px;" data-act="save-profile-name">Save Name</button>
  </div>
  <div class="card">
    <div class="card-title">Email</div>
    <p class="small muted">Used for account recovery ("Forgot Password") if your Admin has set up email on this server.</p>
    <label>Email</label><input type="email" id="profile-email" value="${esc(session.email || '')}" placeholder="you@example.com">
    <button class="btn btn-primary btn-sm" style="margin-top:8px;" data-act="save-profile-email">Save Email</button>
  </div>
  <div class="card">
    <div class="card-title">Phone (WhatsApp Notifications)</div>
    <p class="small muted">Optional — if your Admin has WhatsApp notifications set up on this server, task notifications will also be sent here. Include your country code, e.g. +919876543210.</p>
    <label>Phone Number</label><input type="text" id="profile-phone" value="${esc(session.phone || '')}" placeholder="+919876543210">
    <button class="btn btn-primary btn-sm" style="margin-top:8px;" data-act="save-profile-phone">Save Phone</button>
  </div>
  <div class="card">
    <div class="card-title">Push Notifications</div>
    <p class="small muted" id="push-status-text">Checking this device's notification status…</p>
    <button class="btn btn-primary btn-sm" data-act="enable-push" id="enable-push-btn" style="display:none;">Enable Push Notifications On This Device</button>
    <button class="btn btn-sm" data-act="disable-push" id="disable-push-btn" style="display:none;">Turn Off Push Notifications On This Device</button>
  </div>
  <div class="card">
    <div class="card-title">Change Password</div>
    <label>New Password (min 6 characters)</label>
    ${passwordFieldHTML('profile-pw-new', 'Choose a new password')}
    <label style="margin-top:8px;">Confirm New Password</label>
    ${passwordFieldHTML('profile-pw-confirm', 'Type it again')}
    <button class="btn btn-primary btn-sm" style="margin-top:8px;" data-act="save-profile-password">Change Password</button>
  </div>
  <div class="card">
    <div class="card-title">Security</div>
    <p class="small muted">If you think someone else might be logged into your account on another device or browser, you can sign every one of them out at once. This device stays logged in.</p>
    <button class="btn btn-sm btn-danger" data-act="logout-everywhere">Log Out Everywhere Else</button>
  </div>`;
}
function bindProfile() {
  bindPasswordToggles();
  const saveName = document.querySelector('[data-act="save-profile-name"]');
  if (saveName) saveName.onclick = async () => {
    const name = document.getElementById('profile-name').value.trim();
    if (!name) { setBanner('Name cannot be empty.'); render(); return; }
    try {
      const data = await api('/api/auth/update-name', { method: 'POST', body: JSON.stringify({ name }) });
      token = data.token; session = { ...session, name: data.name };
      localStorage.setItem('ls_token', token); localStorage.setItem('ls_session', JSON.stringify(session));
      setBanner('Name updated.', 'ok'); await refreshData();
    } catch (e) { setBanner(e.message); render(); }
  };
  const saveEmail = document.querySelector('[data-act="save-profile-email"]');
  if (saveEmail) saveEmail.onclick = async () => {
    const email = document.getElementById('profile-email').value.trim();
    try {
      const data = await api('/api/auth/update-email', { method: 'POST', body: JSON.stringify({ email }) });
      session = { ...session, email: data.email };
      localStorage.setItem('ls_session', JSON.stringify(session));
      setBanner('Email updated.', 'ok'); render();
    } catch (e) { setBanner(e.message); render(); }
  };
  const savePhone = document.querySelector('[data-act="save-profile-phone"]');
  if (savePhone) savePhone.onclick = async () => {
    const phone = document.getElementById('profile-phone').value.trim();
    try {
      const data = await api('/api/auth/update-phone', { method: 'POST', body: JSON.stringify({ phone }) });
      session = { ...session, phone: data.phone };
      localStorage.setItem('ls_session', JSON.stringify(session));
      setBanner('Phone number updated.', 'ok'); render();
    } catch (e) { setBanner(e.message); render(); }
  };
  updatePushStatusUI();
  const enablePushBtn = document.getElementById('enable-push-btn');
  if (enablePushBtn) enablePushBtn.onclick = enablePushNotifications;
  const disablePushBtn = document.getElementById('disable-push-btn');
  if (disablePushBtn) disablePushBtn.onclick = disablePushNotifications;
  const savePassword = document.querySelector('[data-act="save-profile-password"]');
  if (savePassword) savePassword.onclick = async () => {
    const newPassword = document.getElementById('profile-pw-new').value;
    const confirmPassword = document.getElementById('profile-pw-confirm').value;
    if (!newPassword || !confirmPassword) { setBanner('Both password fields are required.'); render(); return; }
    if (newPassword !== confirmPassword) { setBanner("Passwords don't match."); render(); return; }
    if (newPassword.length < 6) { setBanner('Password must be at least 6 characters.'); render(); return; }
    try {
      const data = await api('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ newPassword }) });
      token = data.token;
      localStorage.setItem('ls_token', token);
      document.getElementById('profile-pw-new').value = ''; document.getElementById('profile-pw-confirm').value = '';
      setBanner('Password changed.', 'ok'); render();
    } catch (e) { setBanner(e.message); render(); }
  };
  const logoutEverywhere = document.querySelector('[data-act="logout-everywhere"]');
  if (logoutEverywhere) logoutEverywhere.onclick = async () => {
    if (!confirm('Log out every other device/browser signed into your account? This device will stay logged in.')) return;
    try {
      const data = await api('/api/auth/logout-everywhere', { method: 'POST' });
      token = data.token; localStorage.setItem('ls_token', token);
      setBanner('Every other session has been logged out.', 'ok'); render();
    } catch (e) { setBanner(e.message); render(); }
  };
}

/* ==================== MY TEAM (team leads only, delegated member management) ==================== */
function renderMyTeamView() {
  const myTeammates = userDirectory.filter(u => u.team === session.team && u.username !== session.username);
  return `
  <div class="notice">You can add new members to your own team (<b>${esc(session.team || '—')}</b>) without needing Admin. New accounts are created as Team Member and are asked to set their own password on first login.</div>
  <div class="card">
    <div class="card-title">Add Team Member</div>
    <div class="row">
      <div class="col"><label>Username</label><input type="text" id="new-team-username"></div>
      <div class="col"><label>Name</label><input type="text" id="new-team-name"></div>
    </div>
    <label>Password (min 6 chars)</label>${passwordFieldHTML('new-team-password', 'Temporary password')}
    <button class="btn btn-primary btn-sm" style="margin-top:8px;" data-act="submit-new-team-member">Add to ${esc(session.team || 'My Team')}</button>
  </div>
  <div class="card">
    <div class="card-title">Teammates in ${esc(session.team || '—')}</div>
    ${myTeammates.length === 0 ? `<div class="empty">No one else in your team yet.</div>` : `
    <table><tr><th>Name</th><th>Username</th><th>Team Lead</th></tr>
    ${myTeammates.map(u => `<tr><td>${esc(u.name)}</td><td class="mono">${esc(u.username)}</td><td>${u.is_team_lead ? '★ Lead' : '—'}</td></tr>`).join('')}
    </table>`}
  </div>`;
}
function bindMyTeam() {
  bindPasswordToggles();
  const submit = document.querySelector('[data-act="submit-new-team-member"]');
  if (submit) submit.onclick = async () => {
    const username = document.getElementById('new-team-username').value.trim();
    const name = document.getElementById('new-team-name').value.trim();
    const password = document.getElementById('new-team-password').value;
    try {
      await api('/api/team/members', { method: 'POST', body: JSON.stringify({ username, name, password }) });
      setBanner('Team member added.', 'ok'); await refreshData();
    } catch (e) { setBanner(e.message); render(); }
  };
}

/* ==================== DRAWINGS LIBRARY (project-wise, grouped by section) ==================== */
function renderDrawingsView() {
  // Section names available WITHIN the fetched project, for the narrow-down filter — distinct
  // from the global sectionsList (which is every section name ever used, for the upload
  // datalist).
  const sectionsInResults = Array.from(new Set(currentProjectDrawings.map(d => d.section).filter(Boolean))).sort();
  const filtered = ui.drawingsSectionFilter ? currentProjectDrawings.filter(d => d.section === ui.drawingsSectionFilter) : currentProjectDrawings;
  return `
  <div class="notice">A builder can have several projects, and each project has drawings organized by section (Playing Area, Club House, etc). Fetch a project to browse all its sections, or narrow to one.</div>
  <div class="card">
    <div class="card-title">Fetch Drawing</div>
    <div class="row" style="align-items:flex-end;">
      <div class="col">
        <label>Project name</label>
        <input type="text" id="drawings-project-query" list="projects-datalist" placeholder="Type or pick a project" value="${esc(ui.drawingsProjectQuery)}">
        <datalist id="projects-datalist">${projectsList.map(p => `<option value="${esc(p)}">`).join('')}</datalist>
      </div>
      <div class="col" style="flex:0;"><button class="btn btn-primary btn-sm" data-act="fetch-drawings">Fetch Drawing</button></div>
    </div>
    ${ui.drawingsSearchedProject ? `
    <div style="margin-top:14px;">
      <div class="flex-between" style="margin-bottom:8px;">
        <span class="small muted">${currentProjectDrawings.length} drawing${currentProjectDrawings.length === 1 ? '' : 's'} for "${esc(ui.drawingsSearchedProject)}"</span>
        ${sectionsInResults.length > 1 ? `
        <select id="drawings-section-filter" style="width:auto;padding:4px 8px;">
          <option value="">All sections</option>
          ${sectionsInResults.map(s => `<option value="${esc(s)}" ${ui.drawingsSectionFilter === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
        </select>` : ''}
      </div>
      ${filtered.length === 0 ? `<div class="empty">No drawings on file${ui.drawingsSectionFilter ? ` for "${esc(ui.drawingsSectionFilter)}"` : ''} yet.</div>` : `
      <table>
        <tr><th>Section</th><th>Title / File</th><th>Uploaded By</th><th>Date</th><th>Download</th><th></th></tr>
        ${filtered.map(d => `
          <tr>
            <td>${esc(d.section || '—')}</td>
            <td>${esc(d.title || d.file_name || 'Untitled drawing')}</td>
            <td>${esc(d.uploaded_by_name || d.uploaded_by_username || 'someone')}</td>
            <td class="small">${fmtTime(d.created_at)}</td>
            <td>${lazyAttachmentHTML(d.has_file, d.file_name, `/api/drawings/${d.id}/download`, `drawing-file-${d.id}`)}</td>
            <td>${(session.role === 'admin' || d.uploaded_by_username === session.username) ? `<button class="btn btn-sm btn-danger" style="padding:2px 8px;font-size:11px;" data-delete-drawing="${d.id}">Remove</button>` : ''}</td>
          </tr>`).join('')}
      </table>`}
    </div>` : ''}
  </div>
  ${(session.role === 'admin' || (session.team || '').toLowerCase().includes('design')) ? `
  <div class="card">
    <div class="card-title">Upload Drawing</div>
    <div class="row">
      <div class="col">
        <label>Project name</label>
        <input type="text" id="new-drawing-project" list="projects-datalist" placeholder="Type or pick a project" required>
      </div>
      <div class="col">
        <label>Section</label>
        <input type="text" id="new-drawing-section" list="sections-datalist" placeholder="e.g. Playing Area, Club House">
        <datalist id="sections-datalist">${sectionsList.map(s => `<option value="${esc(s)}">`).join('')}</datalist>
      </div>
    </div>
    <label>Title (optional)</label>
    <input type="text" id="new-drawing-title" placeholder="e.g. Ground Floor Slab Layout Rev 3">
    <label>Drawing file (CAD/drawing formats, up to ~100MB)</label>
    <input type="file" id="new-drawing-file">
    <div id="new-drawing-file-preview"></div>
    <button class="btn btn-primary btn-sm" style="margin-top:8px;" data-act="submit-drawing">Upload Drawing</button>
  </div>` : `<div class="notice">Only Admin or Design team members can upload drawings — you can still fetch and download from any project above.</div>`}`;
}
function bindDrawingsView() {
  const fetchBtn = document.querySelector('[data-act="fetch-drawings"]');
  if (fetchBtn) fetchBtn.onclick = async () => {
    const project = document.getElementById('drawings-project-query').value.trim();
    ui.drawingsProjectQuery = project;
    if (!project) { alert('Enter a project name first.'); return; }
    try {
      currentProjectDrawings = await api(`/api/drawings?project=${encodeURIComponent(project)}`);
      ui.drawingsSearchedProject = project;
      ui.drawingsSectionFilter = '';
      render();
    } catch (e) { setBanner(e.message); render(); }
  };
  const sectionFilter = document.getElementById('drawings-section-filter');
  if (sectionFilter) sectionFilter.onchange = () => { ui.drawingsSectionFilter = sectionFilter.value; render(); };
  document.querySelectorAll('[data-delete-drawing]').forEach(btn => btn.onclick = async () => {
    if (!confirm('Remove this drawing from the library?')) return;
    try {
      await api(`/api/drawings/${btn.dataset.deleteDrawing}`, { method: 'DELETE' });
      currentProjectDrawings = await api(`/api/drawings?project=${encodeURIComponent(ui.drawingsSearchedProject)}`);
      setBanner('Drawing removed.', 'ok'); render();
    } catch (e) { setBanner(e.message); render(); }
  });
  const fileInput = document.getElementById('new-drawing-file');
  if (fileInput) fileInput.onchange = (ev) => {
    const f = ev.target.files[0]; if (!f) return;
    readAnyFile(f, dataUrl => {
      ui.pendingDrawingFile = dataUrl; ui.pendingDrawingFileName = f.name;
      const preview = document.getElementById('new-drawing-file-preview');
      if (preview) preview.innerHTML = dataUrl ? `<div class="small muted">Selected: ${esc(f.name)}</div>` : '<div class="err">Could not read file (too large?).</div>';
    });
  };
  const submitBtn = document.querySelector('[data-act="submit-drawing"]');
  if (submitBtn) submitBtn.onclick = async () => {
    const projectEl = document.getElementById('new-drawing-project');
    const project = projectEl.value.trim();
    const section = document.getElementById('new-drawing-section').value.trim();
    const title = document.getElementById('new-drawing-title').value.trim();
    if (!projectEl.reportValidity()) return;
    if (!ui.pendingDrawingFile) { alert('Select a file first.'); return; }
    try {
      await api('/api/drawings', { method: 'POST', body: JSON.stringify({ project, section, title, fileData: ui.pendingDrawingFile, fileName: ui.pendingDrawingFileName }) });
      ui.pendingDrawingFile = null; ui.pendingDrawingFileName = null;
      setBanner('Drawing uploaded.', 'ok');
      await refreshData();
      if (ui.drawingsSearchedProject === project) { currentProjectDrawings = await api(`/api/drawings?project=${encodeURIComponent(project)}`); render(); }
    } catch (e) { setBanner(e.message); render(); }
  };
}

/* ==================== PEAK HOURS (Admin) ==================== */
// Smooth SVG line/area chart, hand-rolled like the pie chart — no charting library available.
// Each hour gets an invisible wide click-target rect layered under the curve, since a thin SVG
// path can't itself be "clicked per hour" the way discrete bars could.
function fmtHourLabel12(h) { const period = h < 12 ? 'AM' : 'PM'; const h12 = h % 12 === 0 ? 12 : h % 12; return `${h12}${period}`; }
// Scopes any 24-hour activity array down to the working window this company actually cares
// about — 9am through midnight — rather than showing the full 24 hours including the very
// early morning stretch (1am-8am) when nobody is working and the line just sits flat at zero,
// wasting chart space. Preserves each entry's real `hour` value (needed for click-to-select and
// axis labels), just reorders/filters which ones are shown, left (9am) to right (midnight).
const WORKING_HOURS_ORDER = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 0];
function filterToWorkingHours(hours) {
  return WORKING_HOURS_ORDER.map(h => hours.find(x => x.hour === h)).filter(Boolean);
}
function renderHourlyCurveChart(hours, opts) {
  opts = opts || {};
  const width = 720, height = 190, padTop = 10, padBottom = 24, padX = 14;
  const maxTotal = Math.max(1, ...hours.map(h => h.total));
  const stepX = (width - 2 * padX) / (hours.length - 1);
  const points = hours.map((h, i) => ({
    x: padX + i * stepX,
    y: height - padBottom - (h.total / maxTotal) * (height - padTop - padBottom),
    hour: h.hour, total: h.total,
  }));
  let lineD = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i], p1 = points[i + 1];
    const midX = (p0.x + p1.x) / 2, midY = (p0.y + p1.y) / 2;
    lineD += ` Q ${p0.x.toFixed(1)} ${p0.y.toFixed(1)} ${midX.toFixed(1)} ${midY.toFixed(1)}`;
  }
  lineD += ` T ${points[points.length - 1].x.toFixed(1)} ${points[points.length - 1].y.toFixed(1)}`;
  const areaD = `${lineD} L ${points[points.length - 1].x.toFixed(1)} ${height - padBottom} L ${points[0].x.toFixed(1)} ${height - padBottom} Z`;
  const selected = opts.selectedHour;
  const gradId = opts.gradId || 'curveGrad';
  return `
  <svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" style="display:block;">
    <defs>
      <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--steel)" stop-opacity="0.35"></stop>
        <stop offset="100%" stop-color="var(--steel)" stop-opacity="0"></stop>
      </linearGradient>
    </defs>
    <path d="${areaD}" fill="url(#${gradId})" stroke="none"></path>
    <path d="${lineD}" fill="none" stroke="var(--steel)" stroke-width="2.5"></path>
    ${points.map(p => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${p.hour === selected ? 5 : 3.5}" fill="${p.hour === selected ? 'var(--rust)' : 'var(--steel)'}"></circle>`).join('')}
    ${points.map(p => `<rect x="${(p.x - stepX / 2).toFixed(1)}" y="0" width="${stepX.toFixed(1)}" height="${height - padBottom}" fill="transparent" data-hour-click="${p.hour}" style="cursor:pointer;"><title>${fmtHourLabel12(p.hour)}: ${p.total}</title></rect>`).join('')}
    ${points.filter(p => p.hour % 3 === 0).map(p => `<text x="${p.x.toFixed(1)}" y="${height - 8}" font-size="9" fill="var(--muted)" text-anchor="middle" font-family="monospace">${fmtHourLabel12(p.hour)}</text>`).join('')}
  </svg>`;
}
function renderPeakHoursView() {
  // Scoped to the same 9am-midnight working window as the chart itself, so "Busiest Hour" can
  // never point at an hour that isn't even visible on the graph below it.
  const workingHoursData = filterToWorkingHours(peakHoursData);
  const maxTotal = Math.max(1, ...workingHoursData.map(h => h.total));
  const peakHour = workingHoursData.reduce((best, h) => (h.total > (best ? best.total : -1) ? h : best), null);
  const fmtHourLabel = fmtHourLabel12;
  const selectedName = ui.peakHoursUser === 'all' ? 'the whole company' : (userDirectory.find(u => u.username === ui.peakHoursUser) || {}).name || ui.peakHoursUser;
  const selectedHourData = (ui.peakHoursSelectedHour !== null && ui.peakHoursSelectedHour !== undefined) ? peakHoursData[ui.peakHoursSelectedHour] : null;
  return `
  <div class="notice">Which hours of the day see the most real work — task creation, comments, submissions, and approvals. Logging in isn't counted as activity, so it's shown separately in the breakdown but never affects the busiest hour. Pick a person to see their individual pattern, or view the whole company. Click anywhere on the graph to see that hour's breakdown.</div>
  <div class="card">
    <label>View</label>
    <select id="peak-hours-user">
      <option value="all" ${ui.peakHoursUser === 'all' ? 'selected' : ''}>Whole Company</option>
      ${(() => {
        const byDept = {};
        userDirectory.forEach(u => { const d = u.team || 'Unassigned'; (byDept[d] = byDept[d] || []).push(u); });
        return Object.keys(byDept).sort().map(dept => `
          <optgroup label="${esc(dept)}">
            ${byDept[dept].map(u => `<option value="${esc(u.username)}" ${ui.peakHoursUser === u.username ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}
          </optgroup>`).join('');
      })()}
    </select>
  </div>
  ${peakHour && peakHour.total > 0 ? `
  <div class="card">
    <div class="card-title" style="margin-bottom:8px;">${esc(selectedName)}</div>
    <div class="stat-row">
      <div class="stat"><div class="n">${fmtHourLabel(peakHour.hour)}–${fmtHourLabel((peakHour.hour + 1) % 24)}</div><div class="l">Busiest Hour</div></div>
      <div class="stat"><div class="n">${peakHour.total}</div><div class="l">Work Activities</div></div>
    </div>
  </div>` : `<div class="card"><div class="empty">No activity recorded yet for ${esc(selectedName)}.</div></div>`}
  <div class="card">
    <div class="card-title">Activity Throughout the Day</div>
    ${renderHourlyCurveChart(filterToWorkingHours(peakHoursData), { selectedHour: ui.peakHoursSelectedHour, gradId: 'peakCurveGrad' })}
    ${selectedHourData ? `
    <div class="peak-hour-detail">
      <b>${fmtHourLabel(selectedHourData.hour)}–${fmtHourLabel((selectedHourData.hour + 1) % 24)}</b> — ${selectedHourData.total} work ${selectedHourData.total === 1 ? 'activity' : 'activities'}
      <div class="small muted" style="margin-top:4px;">${selectedHourData.taskCreated} task${selectedHourData.taskCreated === 1 ? '' : 's'} created · ${selectedHourData.submissions} submission${selectedHourData.submissions === 1 ? '' : 's'} · ${selectedHourData.approvals} approval${selectedHourData.approvals === 1 ? '' : 's'} · ${selectedHourData.replies} comment${selectedHourData.replies === 1 ? '' : 's'}</div>
      <div class="small muted" style="margin-top:2px;">${selectedHourData.logins} login${selectedHourData.logins === 1 ? '' : 's'} <span style="opacity:0.7;">(shown for context, not counted as activity)</span></div>
    </div>` : `<div class="small muted" style="margin-top:8px;">Click a point on the graph above to see that hour's breakdown.</div>`}
  </div>`;
}
function bindPeakHoursView() {
  const sel = document.getElementById('peak-hours-user');
  if (sel) sel.onchange = async () => { ui.peakHoursUser = sel.value; ui.peakHoursSelectedHour = null; await refreshData(); };
  document.querySelectorAll('[data-hour-click]').forEach(el => el.onclick = () => {
    const h = parseInt(el.dataset.hourClick, 10);
    ui.peakHoursSelectedHour = (ui.peakHoursSelectedHour === h) ? null : h;
    render();
  });
}

/* ==================== REPORTS (Admin) ==================== */
const PIE_COLORS = ['var(--steel)', 'var(--rust)', 'var(--amber-dim)', 'var(--success)', 'var(--danger)', 'var(--muted)'];
// No charting library in this app — a small hand-rolled SVG pie chart, consistent with the
// CSS-only bar charts already used for Peak Hours/Performance.
function renderPieChartSVG(slices, size) {
  size = size || 160;
  const cx = size / 2, cy = size / 2, r = size / 2 - 4;
  if (slices.length === 0) return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"></svg>`;
  if (slices.length === 1) {
    return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"><circle cx="${cx}" cy="${cy}" r="${r}" fill="${PIE_COLORS[0]}"><title>${esc(slices[0].username)}: 100%</title></circle></svg>`;
  }
  let cumulative = 0;
  const paths = slices.map((s, i) => {
    const startAngle = (cumulative / 100) * 2 * Math.PI - Math.PI / 2;
    cumulative += s.percent;
    const endAngle = (cumulative / 100) * 2 * Math.PI - Math.PI / 2;
    const x1 = cx + r * Math.cos(startAngle), y1 = cy + r * Math.sin(startAngle);
    const x2 = cx + r * Math.cos(endAngle), y2 = cy + r * Math.sin(endAngle);
    const largeArc = (endAngle - startAngle) > Math.PI ? 1 : 0;
    return `<path d="M ${cx} ${cy} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${largeArc} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z" fill="${PIE_COLORS[i % PIE_COLORS.length]}"><title>${esc(s.username)}: ${s.percent}%</title></path>`;
  }).join('');
  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${paths}</svg>`;
}
function renderReportsView() {
  return `
  <div class="notice">Generate a report for any closed or cancelled task — a contribution breakdown, response times, delays, and flags, all computed from real records, with optional AI-written suggestions built on top of those same real numbers.</div>
  <div class="card">
    ${reportsTaskList.length === 0 ? `<div class="empty">No closed or cancelled tasks yet.</div>` : reportsTaskList.map(t => `
      <div class="level-box" style="cursor:pointer;${ui.reportsSelectedTaskId === t.id ? 'border-left-color:var(--rust);' : ''}" data-select-report-task="${t.id}">
        <div class="flex-between">
          <div><b>${esc(t.title)}</b> <span class="badge ${t.status === 'cancelled' ? 'flag' : 'received'}">${(t.status || 'closed').toUpperCase()}</span></div>
          <span class="small muted">${fmtTime(t.closed_at || t.cancelled_at)}</span>
        </div>
        <div class="small muted" style="margin-top:4px;">${t.report_generated_at ? `Report generated ${fmtTime(t.report_generated_at)}` : 'No report generated yet'}</div>
      </div>`).join('')}
  </div>
  ${ui.reportsSelectedTaskId ? renderReportDetail() : ''}`;
}
function renderReportDetail() {
  const taskMeta = reportsTaskList.find(t => t.id === ui.reportsSelectedTaskId);
  if (!currentTaskReport) {
    return `
    <div class="card">
      <div class="empty">${taskMeta && taskMeta.report_generated_at ? 'Loading report…' : 'No report generated yet for this task.'}</div>
      <button class="btn btn-primary btn-sm" data-act="generate-report" data-task-id="${ui.reportsSelectedTaskId}">Generate Report</button>
    </div>`;
  }
  const r = currentTaskReport;
  const maxBarDays = Math.max(1, ...r.responseBars.map(b => b.days || 0));
  return `
  <div class="card">
    <div class="flex-between">
      <div class="card-title" style="margin:0;">${esc(r.title)}</div>
      <button class="btn btn-sm" data-act="generate-report" data-task-id="${r.taskId}">Regenerate</button>
    </div>
    ${r.delayFlag ? `<div class="notice" style="border-color:var(--danger);margin-top:8px;">⚠️ Closed ${r.delayFlag.lateDays} day(s) after its deadline.</div>` : ''}
    ${r.flags.length > 0 ? `<div style="margin-top:8px;">${r.flags.map(f => `<div class="small" style="padding:3px 0;">🚩 ${esc(f)}</div>`).join('')}</div>` : `<div class="small muted" style="margin-top:8px;">No flags — this one went smoothly.</div>`}
    <div class="row" style="margin-top:14px;">
      <div class="col">
        <div class="small muted" style="margin-bottom:6px;font-weight:700;">Contribution Share <span style="font-weight:400;">(participation proxy — replies + submitting + being approved — not an exact work measurement)</span></div>
        ${renderPieChartSVG(r.contributionPie)}
        <div style="margin-top:8px;">${r.contributionPie.map((c, i) => `<div class="small" style="display:flex;align-items:center;gap:6px;padding:2px 0;"><span style="width:10px;height:10px;border-radius:50%;background:${PIE_COLORS[i % PIE_COLORS.length]};display:inline-block;"></span>${esc(c.username)} — ${c.percent}%</div>`).join('')}</div>
      </div>
      <div class="col">
        <div class="small muted" style="margin-bottom:6px;font-weight:700;">Response Time <span style="font-weight:400;">(days from release to submission)</span></div>
        <div class="peak-chart" style="height:140px;">
          ${r.responseBars.map(b => `
            <div class="peak-bar-col" title="${esc(b.username)}: ${b.days === null ? 'no data' : b.days + ' days'}">
              <div class="peak-bar" style="height:${b.days === null ? 0 : Math.round((b.days / maxBarDays) * 100)}%;"></div>
              <div class="peak-bar-label" style="font-size:9px;">${esc(b.username.slice(0, 6))}</div>
            </div>`).join('')}
        </div>
      </div>
    </div>
    <div class="card" style="background:var(--panel);margin-top:14px;">
      <div class="card-title" style="font-size:13px;">Suggestions</div>
      <p class="small">${esc(r.suggestions)}</p>
    </div>
  </div>`;
}
function bindReportsView() {
  document.querySelectorAll('[data-select-report-task]').forEach(el => el.onclick = async () => {
    const id = el.dataset.selectReportTask;
    ui.reportsSelectedTaskId = id;
    currentTaskReport = null;
    render();
    try {
      const result = await api(`/api/reports/task/${id}`);
      currentTaskReport = result.generated ? result : null;
    } catch (e) { currentTaskReport = null; }
    render();
  });
  document.querySelectorAll('[data-act="generate-report"]').forEach(btn => btn.onclick = async () => {
    const id = btn.dataset.taskId;
    btn.disabled = true; btn.textContent = 'Generating…';
    try {
      currentTaskReport = await api(`/api/reports/task/${id}/generate`, { method: 'POST' });
      await refreshData();
    } catch (e) { setBanner(e.message); }
    render();
  });
}

/* ==================== MY DASHBOARD (everyone, self-scoped only) ==================== */
function renderMyDashboardView() {
  const viewingSelf = !myDashboardData || myDashboardData.username === session.username;
  const viewingWholeCompany = myDashboardData && myDashboardData.username === 'all';
  const viewedName = myDashboardData ? (userDirectory.find(u => u.username === myDashboardData.username) || {}).name || myDashboardData.username : '';
  const pronounCaps = viewingWholeCompany ? 'The Whole Company\'s' : (viewingSelf ? 'Your' : `${esc(viewedName)}'s`);
  const adminSelector = session.role === 'admin' ? `
  <div class="card">
    <label>View Dashboard For</label>
    <select id="dashboard-view-user">
      <option value="${esc(session.username)}" ${ui.dashboardViewUser === session.username ? 'selected' : ''}>Me (${esc(session.name)})</option>
      <option value="all" ${ui.dashboardViewUser === 'all' ? 'selected' : ''}>Whole Company</option>
      ${(() => {
        const others = userDirectory.filter(u => u.username !== session.username);
        const byDept = {};
        others.forEach(u => { const d = u.team || 'Unassigned'; (byDept[d] = byDept[d] || []).push(u); });
        return Object.keys(byDept).sort().map(dept => `
          <optgroup label="${esc(dept)}">
            ${byDept[dept].map(u => `<option value="${esc(u.username)}" ${ui.dashboardViewUser === u.username ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}
          </optgroup>`).join('');
      })()}
    </select>
  </div>` : '';
  if (!myDashboardData) return `${adminSelector}<div class="empty">Loading…</div>`;
  const d = myDashboardData;
  const fmtHourLabel = h => { const period = h < 12 ? 'AM' : 'PM'; const h12 = h % 12 === 0 ? 12 : h % 12; return `${h12}${period}`; };
  const myPeakHour = d.peakHours.reduce((best, h) => (h.total > (best ? best.total : -1) ? h : best), null);
  return `
  ${adminSelector}
  <div class="notice">${viewingWholeCompany ? 'Aggregated across every employee — totals and averages, not any one person\'s individual numbers.' : (viewingSelf ? "Your own stats only — nobody else can see this page, and it doesn't show anyone else's numbers either." : `Viewing ${esc(viewedName)}'s individual dashboard as Admin — they can see this same view themselves too; it's not hidden from them.`)} Real computed statistics${viewingWholeCompany ? '' : ` from ${viewingSelf ? 'your own' : 'their'} history`}, not a trained model — just the honest numbers.</div>
  <div class="card">
    <div class="card-title">${pronounCaps} Right Now</div>
    <div class="hero-stat-grid">
      <div class="hero-stat-card ${d.needsActionCount > 0 ? 'hero-rose needs-attention' : 'hero-teal'}">
        <div class="hero-stat-label">Need${viewingSelf ? '' : 's'} Action<span class="hero-stat-icon">${icon('alertTriangle', 15)}</span></div>
        <div class="hero-stat-number">${d.needsActionCount}</div>
      </div>
      <div class="hero-stat-card hero-coral">
        <div class="hero-stat-label">On Hold<span class="hero-stat-icon">${icon('clock', 15)}</span></div>
        <div class="hero-stat-number">${d.onHoldCount}</div>
      </div>
      <div class="hero-stat-card hero-violet">
        <div class="hero-stat-label">Waiting On Others<span class="hero-stat-icon">${icon('users', 15)}</span></div>
        <div class="hero-stat-number">${d.waitingOnOthersCount}</div>
      </div>
    </div>
  </div>
  <div class="card">
    <div class="card-title">${pronounCaps} Tasks Completed</div>
    <div class="hero-stat-grid">
      <div class="hero-stat-card hero-teal">
        <div class="hero-stat-label">This Week<span class="hero-stat-icon">${icon('checkCircle', 15)}</span></div>
        <div class="hero-stat-number">${d.completion.week}</div>
      </div>
      <div class="hero-stat-card hero-violet">
        <div class="hero-stat-label">This Month<span class="hero-stat-icon">${icon('checkCircle', 15)}</span></div>
        <div class="hero-stat-number">${d.completion.month}</div>
      </div>
      <div class="hero-stat-card hero-coral">
        <div class="hero-stat-label">This Year<span class="hero-stat-icon">${icon('checkCircle', 15)}</span></div>
        <div class="hero-stat-number">${d.completion.year}</div>
      </div>
      <div class="hero-stat-card hero-rose">
        <div class="hero-stat-label">All Time<span class="hero-stat-icon">${icon('checkCircle', 15)}</span></div>
        <div class="hero-stat-number">${d.completion.allTime}</div>
      </div>
    </div>
  </div>
  ${d.approval.allTime > 0 ? `
  <div class="card">
    <div class="card-title">${pronounCaps} Documents Approved (Send for Approval)</div>
    <div class="stat-row">
      <div class="stat"><div class="n">${d.approval.week}</div><div class="l">This Week</div></div>
      <div class="stat"><div class="n">${d.approval.month}</div><div class="l">This Month</div></div>
      <div class="stat"><div class="n">${d.approval.year}</div><div class="l">This Year</div></div>
      <div class="stat"><div class="n">${d.approval.allTime}</div><div class="l">All Time</div></div>
    </div>
  </div>` : ''}
  <div class="card">
    <div class="card-title">${pronounCaps} Typical Response Time</div>
    ${d.avgResponseDays === null ? `<div class="empty">Not enough completed work yet to compute this.</div>` : `
    <p class="small muted">From the moment ${viewingSelf ? 'you were' : 'they were'} released to actually submit ${viewingSelf ? 'your' : 'their'} part, averaged across ${d.sampleSize} completed submissions. Time spent on hold or blocked never counts toward this.</p>
    <div class="stat-row"><div class="stat"><div class="n">${d.avgResponseDays.toFixed(1)}</div><div class="l">Avg. Days to Submit</div></div></div>`}
  </div>
  <div class="card">
    <div class="card-title">${pronounCaps} Activity Throughout the Day</div>
    ${myPeakHour && myPeakHour.total > 0 ? `<p class="small muted">${viewingSelf ? 'Your' : 'Their'} busiest hour: ${fmtHourLabel(myPeakHour.hour)}–${fmtHourLabel((myPeakHour.hour + 1) % 24)}.</p>` : `<div class="empty">No activity recorded yet.</div>`}
    ${renderHourlyCurveChart(filterToWorkingHours(d.peakHours), { selectedHour: null, gradId: 'myDashCurveGrad' })}
  </div>`;
}
function bindMyDashboardView() {
  const sel = document.getElementById('dashboard-view-user');
  if (sel) sel.onchange = async () => { ui.dashboardViewUser = sel.value; await refreshData(); };
}

/* ==================== HR DASHBOARD (HR Department + Admin) ====================
   Deliberately built to be a DIFFERENT SHAPE from My Dashboard, not a duplicate of it: the
   landing view is a company-wide roster GRID — every employee side by side with their real
   completion count and real warning count — something no other page in this app shows at a
   glance. Clicking a card drills into that person's full individual detail (the same real,
   fair numbers My Dashboard already computes), so nothing is duplicated logic-wise, only the
   entry point and bird's-eye overview are new. Colorful "hero" stat cards and rounded roster
   cards take inspiration from the energy of the reference images shared (gradient stat cards,
   rounded pill badges) — an original layout for this app, not a copy of either design. */
function initials(name) { return (name || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase(); }
function avatarColorFor(username) { const grads = ['hero-violet', 'hero-teal', 'hero-coral', 'hero-rose']; return grads[stringHash(username || '') % grads.length]; }
function renderHRDashboardView() {
  if (ui.hrDashboardSelectedUser) return renderHRDashboardDetail();
  const allRoster = hrRosterData || [];
  const deptNames = Array.from(new Set(allRoster.map(r => r.team).filter(Boolean))).sort();
  const roster = ui.hrDashboardDeptFilter ? allRoster.filter(r => r.team === ui.hrDashboardDeptFilter) : allRoster;
  const totalWarnings = roster.reduce((s, r) => s + r.warningCount, 0);
  // FIXED: this used to sum every person's own individual completion credit, which double(or
  // more)-counted any task with multiple assignees — a task 2 people were tagged on, once
  // approved for both, was showing as "2 completed tasks" instead of 1. The unfiltered ("All
  // Departments") view now uses the backend's correct distinct-task count. The
  // department-filtered view still uses the per-person sum as a reasonable approximation — a
  // task split across two different departments is a rare edge case, and doing this precisely
  // per-department would need a materially more complex query; flagged here rather than quietly
  // left as if it were already exactly right.
  const totalCompleted = ui.hrDashboardDeptFilter ? roster.reduce((s, r) => s + r.tasksCompleted, 0) : hrTotalTasksCompleted;
  const flaggedCount = roster.filter(r => r.warningCount > 0).length;
  return `
  <div class="notice">Visible to HR Department and Admin only. A company-wide overview, in real organizational order (each department's Team Lead listed first) — click anyone to see their full individual detail.</div>
  <div class="card">
    <label>Filter by Department</label>
    <select id="hr-dashboard-dept-filter">
      <option value="">All Departments</option>
      ${deptNames.map(d => `<option value="${esc(d)}" ${ui.hrDashboardDeptFilter === d ? 'selected' : ''}>${esc(d)}</option>`).join('')}
    </select>
  </div>
  <div class="hero-stat-grid" style="margin-bottom:14px;">
    <div class="hero-stat-card hero-violet">
      <div class="hero-stat-label">Employees<span class="hero-stat-icon">${icon('users', 15)}</span></div>
      <div class="hero-stat-number">${roster.length}</div>
    </div>
    <div class="hero-stat-card hero-teal">
      <div class="hero-stat-label">Tasks Completed (All-Time)<span class="hero-stat-icon">${icon('checkCircle', 15)}</span></div>
      <div class="hero-stat-number">${totalCompleted}</div>
    </div>
    <div class="hero-stat-card ${flaggedCount > 0 ? 'hero-rose needs-attention' : 'hero-coral'}">
      <div class="hero-stat-label">People With Warnings<span class="hero-stat-icon">${icon('alertTriangle', 15)}</span></div>
      <div class="hero-stat-number">${flaggedCount}</div>
      <div class="hero-stat-sub">${totalWarnings} total warning${totalWarnings === 1 ? '' : 's'} across everyone</div>
    </div>
  </div>
  <div class="hr-roster-grid">
    ${roster.length === 0 ? `<div class="empty">No employees${ui.hrDashboardDeptFilter ? ' in this department' : ''} yet.</div>` : roster.map(r => `
      <div class="hr-roster-card" data-select-roster-employee="${esc(r.username)}">
        <div class="hr-roster-avatar ${avatarColorFor(r.username)}">${esc(initials(r.name))}</div>
        <div class="hr-roster-name">${esc(r.name)}</div>
        <div class="hr-roster-position">${esc(r.designation || ROLE_LABEL[r.role] || 'Team Member')}${r.team ? ` · ${esc(r.team)}` : ''}${r.isTeamLead ? ' · Lead' : ''}</div>
        <div class="hr-roster-stats">
          <div><div class="n">${r.tasksCompleted}</div><div class="l">Completed</div></div>
        </div>
        ${r.warningCount > 0 ? `<span class="hr-roster-warning-badge">⚠ ${r.warningCount} warning${r.warningCount === 1 ? '' : 's'}</span>` : ''}
        ${r.isPendingRedFlag ? `<span class="hr-roster-warning-badge" style="background:rgba(217,60,60,0.18);color:var(--danger);font-weight:800;" title="${r.pendingTaskCount} tasks currently pending">🚩 ${r.pendingTaskCount} pending tasks</span>` : ''}
      </div>`).join('')}
  </div>`;
}
function renderHRDashboardDetail() {
  const selectedUsername = ui.hrDashboardSelectedUser;
  const selectedUser = userDirectory.find(u => u.username === selectedUsername);
  const d = hrDashboardData;
  const fmtHourLabel = h => { const period = h < 12 ? 'AM' : 'PM'; const h12 = h % 12 === 0 ? 12 : h % 12; return `${h12}${period}`; };
  return `
  <button class="btn btn-sm" data-act="hr-back-to-roster" style="margin-bottom:12px;">← Back to Roster</button>
  ${!selectedUser ? `<div class="empty">Employee not found.</div>` : `
  <div class="card hr-nameplate">
    <div class="hr-nameplate-name">${esc(selectedUser.name)}</div>
    <div class="hr-nameplate-position">${esc(selectedUser.designation || ROLE_LABEL[selectedUser.role] || 'Team Member')}${selectedUser.team ? ` · ${esc(selectedUser.team)}` : ''}</div>
    <div class="small muted" style="margin-top:6px;">
      ${selectedUser.email ? `${esc(selectedUser.email)} · ` : ''}${selectedUser.username}${selectedUser.is_team_lead ? ' · Team Lead' : ''}
    </div>
  </div>
  ${!d || d.username !== selectedUsername ? `<div class="empty">Loading…</div>` : `
  <div class="card">
    <div class="card-title">Right Now</div>
    <div class="stat-row">
      <div class="stat"><div class="n">${d.needsActionCount}</div><div class="l">Needs Action</div></div>
      <div class="stat"><div class="n">${d.onHoldCount}</div><div class="l">On Hold</div></div>
      <div class="stat"><div class="n">${d.waitingOnOthersCount}</div><div class="l">Waiting On Others</div></div>
    </div>
  </div>
  <div class="card">
    <div class="card-title">Tasks Completed</div>
    <div class="stat-row">
      <div class="stat"><div class="n">${d.completion.week}</div><div class="l">This Week</div></div>
      <div class="stat"><div class="n">${d.completion.month}</div><div class="l">This Month</div></div>
      <div class="stat"><div class="n">${d.completion.year}</div><div class="l">This Year</div></div>
      <div class="stat"><div class="n">${d.completion.allTime}</div><div class="l">All Time</div></div>
    </div>
  </div>
  <div class="card">
    <div class="card-title">Typical Response Time</div>
    ${d.avgResponseDays === null ? `<div class="empty">Not enough completed work yet to compute this.</div>` : `
    <p class="small muted">From release to submission, averaged across ${d.sampleSize} completed submissions. Hold/blocked time never counts.</p>
    <div class="stat-row"><div class="stat"><div class="n">${d.avgResponseDays.toFixed(1)}</div><div class="l">Avg. Days to Submit</div></div></div>`}
  </div>
  <div class="card">
    <div class="card-title">Activity Throughout the Day</div>
    ${renderHourlyCurveChart(filterToWorkingHours(d.peakHours), { selectedHour: null, gradId: 'hrDashCurveGrad' })}
  </div>`}`}`;
}
function bindHRDashboardView() {
  const deptFilter = document.getElementById('hr-dashboard-dept-filter');
  if (deptFilter) deptFilter.onchange = () => { ui.hrDashboardDeptFilter = deptFilter.value; render(); };
  document.querySelectorAll('[data-select-roster-employee]').forEach(card => card.onclick = async () => {
    ui.hrDashboardSelectedUser = card.dataset.selectRosterEmployee;
    hrDashboardData = null;
    render();
    try { hrDashboardData = await api(`/api/reports/my-dashboard?username=${encodeURIComponent(ui.hrDashboardSelectedUser)}`); } catch (e) { hrDashboardData = null; }
    render();
  });
  const backBtn = document.querySelector('[data-act="hr-back-to-roster"]');
  if (backBtn) backBtn.onclick = () => { ui.hrDashboardSelectedUser = null; hrDashboardData = null; render(); };
}

/* ==================== AUDIT LOG (Admin) ==================== */
const AUDIT_ACTION_LABEL = { account_created: 'Account Created', account_removed: 'Account Removed', password_reset: 'Password Reset', team_lead_changed: 'Team Lead Changed', task_cancelled: 'Task Cancelled', drawing_removed: 'Drawing Removed', account_locked: 'Account Locked', task_force_closed: 'Task Force-Closed', approval_rejected: 'Approval Rejected', username_changed: 'Username Changed', task_reopened: 'Task Reopened', department_removed: 'Department Removed' };
const AUDIT_ACTION_IS_WARNING = new Set(['account_removed', 'drawing_removed', 'account_locked', 'task_force_closed', 'approval_rejected', 'task_cancelled', 'task_reopened', 'department_removed']);
// A stable "EST-2" style code per department member — first 3 letters of their department plus
// a number based on alphabetical position within that department (by username). Computed live
// from the current directory, not stored, so it always reflects the current team roster.
function departmentCode(team, username) {
  if (!team) return null;
  const abbrev = team.trim().split(/\s+/)[0].slice(0, 3).toUpperCase();
  const sameTeam = (userDirectory || []).filter(u => u.team === team).sort((a, b) => a.username.localeCompare(b.username));
  const idx = sameTeam.findIndex(u => u.username === username);
  return idx >= 0 ? `${abbrev}-${idx + 1}` : abbrev;
}
function renderAuditLogView() {
  // Shows every entry directly, always — a per-action-type count strip stays at the top as a
  // quick-glance summary, but the full table below is never gated behind clicking a filter.
  const counts = {};
  auditLogEntries.forEach(e => { counts[e.action] = (counts[e.action] || 0) + 1; });
  const actionTypes = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  const filtered = (ui.auditLogFilterAction ? auditLogEntries.filter(e => e.action === ui.auditLogFilterAction) : auditLogEntries)
    .filter(e => {
      const q = (ui.auditLogSearchQuery || '').trim().toLowerCase();
      if (!q) return true;
      return (e.actor_name || '').toLowerCase().includes(q) || (e.actor_username || '').toLowerCase().includes(q) ||
        (e.actor_team || '').toLowerCase().includes(q) || (e.details || '').toLowerCase().includes(q);
    });
  return `
  <div class="notice">A permanent record of sensitive admin actions — account changes, password resets, task cancellations/reopens, drawing removals — with the actor's department, IP address, and device. Click any row for IP/device. Most recent 200 entries tracked.</div>
  <div class="card">
    ${auditLogEntries.length === 0 ? `<div class="empty">Nothing logged yet.</div>` : `
    <input type="text" id="audit-log-search" placeholder="Search by name, username, department, or details..." value="${esc(ui.auditLogSearchQuery || '')}" style="margin-bottom:10px;">
    <div style="display:flex;flex-wrap:wrap;gap:8px;">
      ${actionTypes.map(a => `
        <span class="badge ${AUDIT_ACTION_IS_WARNING.has(a) ? 'flag' : 'received'} ${ui.auditLogFilterAction === a ? 'audit-count-active' : ''}" data-audit-filter="${esc(a)}" style="cursor:pointer;">
          ${esc(AUDIT_ACTION_LABEL[a] || a)} · ${counts[a]}
        </span>`).join('')}
      <span class="badge ${!ui.auditLogFilterAction ? 'audit-count-active' : ''}" data-audit-filter="" style="cursor:pointer;background:var(--panel-2);">Show All · ${auditLogEntries.length}</span>
    </div>
    <table style="margin-top:14px;"><tr><th>When</th><th>Action</th><th>Department</th><th>Details</th><th></th></tr>
    ${filtered.map((e, i) => `
      <tr style="cursor:pointer;" data-audit-row-toggle="${i}">
        <td class="small">${fmtTime(e.created_at)}</td>
        <td><span class="badge ${AUDIT_ACTION_IS_WARNING.has(e.action) ? 'flag' : 'received'}">${esc(AUDIT_ACTION_LABEL[e.action] || e.action)}</span></td>
        <td class="small"><b>${esc(departmentCode(e.actor_team, e.actor_username) || '—')}</b><br><span class="muted">${esc(e.actor_name || e.actor_username || '—')}</span></td>
        <td class="small">${esc(e.details || '')}</td>
        <td class="small muted">${ui.auditLogExpandedRow === i ? '▾' : '▸'}</td>
      </tr>
      ${ui.auditLogExpandedRow === i ? `
      <tr><td colspan="6" style="background:var(--panel);"><div class="small muted" style="padding:8px 4px;">IP address: ${esc(e.ip_address || 'not recorded')} · Device: ${esc(e.device || 'not recorded')}</div></td></tr>` : ''}`).join('')}
    </table>`}
  </div>`;
}
function bindAuditLogView() {
  const searchInput = document.getElementById('audit-log-search');
  if (searchInput) searchInput.oninput = () => { ui.auditLogSearchQuery = searchInput.value; render(); };
  document.querySelectorAll('[data-audit-filter]').forEach(el => el.onclick = () => {
    const val = el.dataset.auditFilter;
    ui.auditLogFilterAction = val || null;
    render();
  });
  document.querySelectorAll('[data-audit-row-toggle]').forEach(el => el.onclick = () => {
    const idx = Number(el.dataset.auditRowToggle);
    ui.auditLogExpandedRow = (ui.auditLogExpandedRow === idx) ? null : idx;
    render();
  });
}

/* ==================== PERFORMANCE (Admin) ==================== */
function renderLeaderboardCard(data, title, emptyMessage, boardKey) {
  const { leaderboard, periodLabel } = data || { leaderboard: [], periodLabel: '' };
  const MEDAL = { 1: { emoji: '🥇', color: '#D4AF37' }, 2: { emoji: '🥈', color: '#A8A9AD' }, 3: { emoji: '🥉', color: '#CD7F32' } };
  return `
  <div class="card" style="border:1px solid var(--line);">
    <div class="flex-between">
      <div class="card-title" style="margin:0;">${title}${periodLabel ? ` — ${esc(periodLabel)}` : ''}</div>
    </div>
    ${leaderboard.length === 0 ? `<div class="empty">${esc(emptyMessage)}</div>` : `
    <div class="leaderboard-list" data-leaderboard-key="${esc(boardKey)}">
      ${leaderboard.slice(0, 10).map(r => {
        const medal = MEDAL[r.rank];
        return `
        <div class="leaderboard-row" id="lb-row-${esc(boardKey)}-${esc(r.username)}" style="${medal ? `border-color:${medal.color};` : ''}">
          <span class="leaderboard-rank" style="${medal ? `color:${medal.color};font-size:22px;` : ''}">${medal ? medal.emoji : `#${r.rank}`}</span>
          <span class="leaderboard-avatar ${avatarColorFor(r.username)}">${esc(initials(r.name))}</span>
          <div style="flex:1;min-width:0;">
            <div style="font-weight:700;">${esc(r.name)}</div>
            <div class="small muted">${esc(r.team || '')}${r.team ? ' · ' : ''}${r.completions} completed</div>
          </div>
          <span class="badge" style="font-weight:800;">${r.rating.toFixed(1)}/5</span>
        </div>`;
      }).join('')}
    </div>`}
  </div>`;
}
function renderPeriodAwardsCard(awards, title) {
  if (!awards || awards.length === 0) return '';
  // Group by period label so each past quarter/year gets its own small "podium" — most recent
  // period first, since that's the one people actually want to see right after it ends.
  const byPeriod = {};
  awards.forEach(a => { (byPeriod[a.period_label] = byPeriod[a.period_label] || []).push(a); });
  const MEDAL = { 1: '🥇', 2: '🥈', 3: '🥉' };
  return `
  <div class="card" style="border:1px solid var(--line);">
    <div class="card-title">${title}</div>
    ${Object.entries(byPeriod).map(([label, winners]) => `
      <div style="margin-bottom:14px;">
        <div class="small muted" style="font-weight:700;margin-bottom:6px;">${esc(label)}</div>
        <div class="leaderboard-list">
          ${winners.sort((a, b) => a.rank - b.rank).map(w => `
            <div class="leaderboard-row">
              <span class="leaderboard-rank" style="font-size:20px;">${MEDAL[w.rank] || `#${w.rank}`}</span>
              <span class="leaderboard-avatar ${avatarColorFor(w.username)}">${esc(initials(w.name))}</span>
              <div style="flex:1;min-width:0;">
                <div style="font-weight:700;">${esc(w.name)}</div>
                <div class="small muted">${esc(w.team || '')}${w.team ? ' · ' : ''}${w.completions} completed that period</div>
              </div>
            </div>`).join('')}
        </div>
      </div>`).join('')}
  </div>`;
}
function renderMonthlyLeaderboard() {
  return `
  <div class="small muted" style="margin:-4px 0 10px;">Ranked by this month's completed work — volume and how quickly you turn things around, same scoring as the quarterly rating below, just re-checked every month instead of waiting for quarter-end.</div>
  ${renderLeaderboardCard(monthlyLeaderboard, '🏆 Monthly Leaderboard', "Nobody has completed approved work yet this month.", 'perf-monthly')}`;
}
function renderWeeklyLeaderboard() {
  return renderLeaderboardCard(weeklyLeaderboard, '📅 This Week', "Nobody has completed approved work yet this week.", 'perf-weekly');
}
function renderPerformanceView() {
  const deptNames = Array.from(new Set(userDirectory.map(u => u.team).filter(Boolean))).sort();
  const filterDept = ui.performanceDeptFilter;
  const filteredCompletion = filterDept ? completionStats.filter(s => s.team === filterDept) : completionStats;
  const filteredRatings = filterDept ? (ratingsData || []).filter(r => r.team === filterDept) : (ratingsData || []);
  const filteredApprovalStats = filterDept ? approvalStats.filter(s => s.team === filterDept) : approvalStats;
  const teamByUsername = {};
  userDirectory.forEach(u => { teamByUsername[u.username] = u.team; });
  const filteredApprovalDetail = filterDept ? (approvalDecisionsDetail || []).filter(d => teamByUsername[d.reviewer_username] === filterDept) : (approvalDecisionsDetail || []);
  return `
  <div class="notice">Objective counts of approved (creator-signed-off) work per employee, credited to the day each person actually submitted it — not the day it happened to get approved. A slow approval never counts against (or for) the employee.</div>
  ${renderMonthlyLeaderboard()}
  ${renderWeeklyLeaderboard()}
  ${renderPeriodAwardsCard(quarterAwards, '🏅 Employee of the Quarter — Past Winners')}
  ${renderPeriodAwardsCard(yearAwards, '🏅 Employee of the Year — Past Winners')}
  <div class="card">
    <label>Filter by Department</label>
    <select id="performance-dept-filter">
      <option value="">All Departments</option>
      ${deptNames.map(d => `<option value="${esc(d)}" ${filterDept === d ? 'selected' : ''}>${esc(d)}</option>`).join('')}
    </select>
  </div>
  <div class="card">
    <div class="flex-between">
      <div class="card-title" style="margin:0;">Task Completion</div>
      <button class="btn btn-sm" data-act="export-performance-csv">Export CSV</button>
    </div>
    <table><tr><th>Name</th><th>Username</th><th>Team</th><th>This Week</th><th>This Month</th><th>This Quarter</th><th>This Year</th><th>All-Time</th></tr>
    ${filteredCompletion.length === 0 ? `<tr><td colspan="8"><div class="empty">No approved work recorded yet.</div></td></tr>` : filteredCompletion.map(s => `
      <tr>
        <td>${esc(s.name)}</td>
        <td class="mono">${esc(s.username)}</td>
        <td>${esc(s.team || '—')}</td>
        <td class="mono">${s.week}</td>
        <td class="mono">${s.month}</td>
        <td class="mono">${s.quarter ?? 0}</td>
        <td class="mono">${s.year}</td>
        <td class="mono">${s.allTime}</td>
      </tr>`).join('')}
    </table>
  </div>
  <div class="card">
    <div class="card-title">Individual Ratings</div>
    <p class="small muted">A transparent rating out of 5 for this quarter — never a black-box number. Half comes from completion volume compared to the company's own quarterly average (not an arbitrary fixed target), half from response-time reliability compared to the company's own average. Anyone with no completed work this quarter shows "not enough data," never a punitive 0. Warnings shown are real, all-time escalation flags received.</p>
    <table><tr><th>Name</th><th>Team</th><th>Rating</th><th>Volume</th><th>Timeliness</th><th>Quarter Completions</th><th>Warnings</th></tr>
    ${filteredRatings.length === 0 ? `<tr><td colspan="7"><div class="empty">No rating data yet.</div></td></tr>` : filteredRatings.map(r => `
      <tr>
        <td>${esc(r.name)}</td>
        <td>${esc(r.team || '—')}</td>
        <td class="mono">${r.rating === null ? '—' : `${r.rating.toFixed(1)}/5`}</td>
        <td class="mono">${r.volumeScore === null ? '—' : `${r.volumeScore.toFixed(1)}/2.5`}</td>
        <td class="mono">${r.timelinessScore === null ? '—' : `${r.timelinessScore.toFixed(1)}/2.5`}</td>
        <td class="mono">${r.quarterCompletions}</td>
        <td>${r.warningCount > 0 ? `<span class="badge flag">⚠ ${r.warningCount}</span>` : '<span class="small muted">—</span>'}</td>
      </tr>`).join('')}
    </table>
  </div>
  <div class="card">
    <div class="card-title">Documents Approved (Send for Approval)</div>
    <p class="small muted">Per-person approval-decision counts — dated to when each reviewer made their own decision, since nobody else's speed affects that timestamp.</p>
    <table><tr><th>Name</th><th>Username</th><th>Team</th><th>This Week</th><th>This Month</th><th>This Year</th><th>All-Time</th></tr>
    ${filteredApprovalStats.length === 0 ? `<tr><td colspan="7"><div class="empty">No approvals recorded yet.</div></td></tr>` : filteredApprovalStats.map(s => `
      <tr>
        <td>${esc(s.name)}</td>
        <td class="mono">${esc(s.username)}</td>
        <td>${esc(s.team || '—')}</td>
        <td class="mono">${s.week}</td>
        <td class="mono">${s.month}</td>
        <td class="mono">${s.year}</td>
        <td class="mono">${s.allTime}</td>
      </tr>`).join('')}
    </table>
  </div>
  <div class="card">
    <div class="card-title">Documents Approved — Full Detail</div>
    <p class="small muted">Every individual decision anyone has actually made via the Approve/Reject button — who decided, on what, who originally asked, and exactly when. Not just a count.</p>
    <table><tr><th>When</th><th>Reviewer</th><th>Document</th><th>Asked By</th><th>Decision</th><th>Reason</th></tr>
    ${filteredApprovalDetail.length === 0 ? `<tr><td colspan="6"><div class="empty">No decisions recorded yet.</div></td></tr>` : filteredApprovalDetail.map(d => `
      <tr>
        <td class="small">${fmtTime(d.decided_at)}</td>
        <td class="mono">${esc(d.reviewer_username)}</td>
        <td>${esc(d.request_title)}</td>
        <td>${esc(d.created_by_name || d.created_by_username)}</td>
        <td><span class="badge ${d.decision === 'approved' ? 'received' : 'flag'}">${esc(d.decision)}</span></td>
        <td class="small">${esc(d.reason || '—')}</td>
      </tr>`).join('')}
    </table>
  </div>`;
}
function bindPerformanceView() {
  const deptFilter = document.getElementById('performance-dept-filter');
  if (deptFilter) deptFilter.onchange = () => { ui.performanceDeptFilter = deptFilter.value; render(); };
  const exportBtn = document.querySelector('[data-act="export-performance-csv"]');
  if (exportBtn) exportBtn.onclick = () => {
    const exportRows = ui.performanceDeptFilter ? completionStats.filter(s => s.team === ui.performanceDeptFilter) : completionStats;
    const rows = [['Name', 'Username', 'Team', 'This Week', 'This Month', 'This Quarter', 'This Year', 'All-Time', 'Rating (/5)', 'Volume Score (/2.5)', 'Timeliness Score (/2.5)', 'Warnings']];
    exportRows.forEach(s => {
      const r = (ratingsData || []).find(x => x.username === s.username) || {};
      rows.push([
        s.name, s.username, s.team || '', s.week, s.month, s.quarter ?? 0, s.year, s.allTime,
        r.rating !== undefined && r.rating !== null ? r.rating.toFixed(1) : '',
        r.volumeScore !== undefined && r.volumeScore !== null ? r.volumeScore.toFixed(1) : '',
        r.timelinessScore !== undefined && r.timelinessScore !== null ? r.timelinessScore.toFixed(1) : '',
        r.warningCount || 0,
      ]);
    });
    const csv = rows.map(row => row.map(cell => {
      const s = String(cell ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `performance-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };
}

/* ==================== ACCOUNTS (Admin) ==================== */
function renderAccountsView() {
  return `
  <div class="card">
    <div class="card-title">Departments</div>
    <p class="small muted">The list everyone picks a department from when adding or editing an account. Typing a brand-new department name into any Team field also adds it here automatically.</p>
    <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;">
      ${teamsList.length === 0 ? `<span class="small muted">No departments yet.</span>` : teamsList.map(t => `
        <span class="badge received" style="display:inline-flex;align-items:center;gap:6px;">${esc(t)}
          <span data-remove-department="${esc(t)}" style="cursor:pointer;font-weight:700;" title="Remove this department">✕</span>
        </span>`).join('')}
    </div>
    <div class="row" style="align-items:flex-end;">
      <div class="col"><label>New department name</label><input type="text" id="new-dept-name" placeholder="e.g. Billing, Legal, HR"></div>
      <div class="col" style="flex:0;"><button class="btn btn-sm" data-act="submit-new-department">Add Department</button></div>
    </div>
  </div>
  <div class="card">
    <div class="card-title">Add Account</div>
    <div class="row">
      <div class="col"><label>Username</label><input type="text" id="new-acc-username"></div>
      <div class="col"><label>Name</label><input type="text" id="new-acc-name"></div>
    </div>
    <div class="row">
      <div class="col"><label>Password (min 6 chars)</label>${passwordFieldHTML('new-acc-password', 'Temporary password')}</div>
      <div class="col"><label>Role</label><select id="new-acc-role"><option value="member">Team Member</option><option value="director">Director</option><option value="admin">Admin</option></select></div>
    </div>
    <div class="row">
      <div class="col">
        <label>Team / Department (optional)</label>
        <input type="text" id="new-acc-team" list="teams-datalist" placeholder="Pick existing or type a new one">
        <datalist id="teams-datalist">${teamsList.map(t => `<option value="${esc(t)}">`).join('')}</datalist>
      </div>
      <div class="col"><label>Designation (optional — e.g. "Site Engineer", "Purchase Manager")</label><input type="text" id="new-acc-designation"></div>
    </div>
    <button class="btn btn-primary btn-sm" style="margin-top:8px;" data-act="submit-new-account">Create Account</button>
  </div>
  <div class="card">
    <div class="flex-between">
      <div class="card-title" style="margin:0;">Existing Accounts</div>
      <select id="accounts-dept-filter" style="width:auto;">
        <option value="">All Departments</option>
        ${teamsList.map(t => `<option value="${esc(t)}" ${ui.accountsDeptFilter === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}
      </select>
    </div>
    <p class="small muted">Click a name or username to edit it. Team Lead grants no special power over closing tasks — it currently only lets someone add new members to their own team from "My Team". Director accounts see only their own department's Performance/Peak-Hours by default — grant additional departments below their row.</p>
    <table><tr><th>Name</th><th>Username</th><th>Role</th><th>Team</th><th>Designation</th><th>Team Lead</th><th></th></tr>
    ${userDirectory.filter(u => !ui.accountsDeptFilter || u.team === ui.accountsDeptFilter).map(u => `
      <tr>
        <td><input type="text" value="${esc(u.name)}" data-name-for="${esc(u.username)}" style="padding:5px 8px;font-size:12px;width:120px;"></td>
        <td><input type="text" class="mono" value="${esc(u.username)}" data-username-for="${esc(u.username)}" style="padding:5px 8px;font-size:12px;width:100px;"></td>
        <td>${ROLE_LABEL[u.role] || esc(u.role)}</td>
        <td><input type="text" value="${esc(u.team || '')}" list="teams-datalist" data-team-for="${esc(u.username)}" style="padding:5px 8px;font-size:12px;width:100px;"></td>
        <td><input type="text" value="${esc(u.designation || '')}" data-designation-for="${esc(u.username)}" style="padding:5px 8px;font-size:12px;width:120px;" placeholder="e.g. Site Engineer"></td>
        <td><input type="checkbox" data-team-lead-for="${esc(u.username)}" ${u.is_team_lead ? 'checked' : ''}></td>
        <td style="white-space:nowrap;">
          <button class="btn btn-sm" data-reset-password-for="${esc(u.username)}">Reset Password</button>
          ${u.username === session.username ? '' : `<button class="btn btn-sm btn-danger" data-remove-user="${esc(u.username)}">Remove</button>`}
        </td>
      </tr>
      ${u.role === 'director' ? `
      <tr><td colspan="7" style="background:var(--panel);padding:8px 10px;">
        <span class="small muted">Also grant ${esc(u.name)} visibility into:</span>
        <select data-director-visibility-for="${esc(u.username)}" multiple style="height:auto;min-height:32px;width:auto;min-width:220px;display:inline-block;vertical-align:middle;margin-left:6px;">
          ${teamsList.filter(t => t !== u.team).map(t => `<option value="${esc(t)}" ${(u.visible_departments || '').split(',').includes(t) ? 'selected' : ''}>${esc(t)}</option>`).join('')}
        </select>
        <button class="btn btn-sm" data-save-director-visibility="${esc(u.username)}" style="margin-left:6px;">Save</button>
      </td></tr>` : ''}
      <tr id="reset-pw-row-${esc(u.username)}" style="display:none;"><td colspan="7">
        <div class="row" style="align-items:flex-end;">
          <div class="col"><label>New password for ${esc(u.name)}</label>${passwordFieldHTML(`reset-pw-input-${u.username}`, 'their new password')}</div>
          <div class="col" style="flex:0;"><button class="btn btn-primary btn-sm" data-do-reset-password="${esc(u.username)}">Set</button></div>
        </div>
      </td></tr>
    `).join('')}
    </table>
  </div>`;
}

/* ==================== TOP-LEVEL RENDER ==================== */
/* ==================== DOM MORPHING ====================
   Replaces wholesale innerHTML replacement with an in-place DOM diff/patch. This is the real
   fix for the page "blinking": destroying and recreating the entire tree every render caused a
   visible flash, reset scroll position, collapsed open <details> (closed-task history), and — as
   a side effect elsewhere — wiped out open forms that lived in a placeholder emptied by the
   template. Morphing only touches nodes that actually changed, so unrelated parts of the page
   never flicker, and stateful things like scroll position and <details openness survive by
   simply never being touched. */
function morphAttributes(fromEl, toEl) {
  const toAttrs = toEl.attributes;
  for (let i = 0; i < toAttrs.length; i++) {
    const attr = toAttrs[i];
    if (fromEl.getAttribute(attr.name) !== attr.value) fromEl.setAttribute(attr.name, attr.value);
  }
  const fromAttrs = fromEl.attributes;
  for (let i = fromAttrs.length - 1; i >= 0; i--) {
    const name = fromAttrs[i].name;
    if (!toEl.hasAttribute(name)) fromEl.removeAttribute(name);
  }
}
function morphNode(fromNode, toNode) {
  if (toNode.nodeType === 3 || toNode.nodeType === 8) { // text / comment
    if (fromNode.nodeValue !== toNode.nodeValue) fromNode.nodeValue = toNode.nodeValue;
    return;
  }
  morphAttributes(fromNode, toNode);
  const tag = fromNode.tagName;
  const isFocused = document.activeElement === fromNode;
  // Live form fields: never clobber what the person is actively doing. Skip syncing value/
  // checked while focused, so typing, a selection in progress, or a checkbox mid-click survives
  // a render that happens to land at the same moment (a background poll, another action, etc).
  if (tag === 'INPUT' && fromNode.type !== 'file') {
    if (fromNode.type === 'checkbox' || fromNode.type === 'radio') {
      if (!isFocused && fromNode.checked !== toNode.checked) fromNode.checked = toNode.checked;
    } else if (!isFocused && fromNode.value !== toNode.value) {
      fromNode.value = toNode.value;
    }
  } else if (tag === 'TEXTAREA') {
    if (!isFocused && fromNode.value !== toNode.value) fromNode.value = toNode.value;
  } else if (tag === 'SELECT') {
    if (!isFocused && fromNode.value !== toNode.value) fromNode.value = toNode.value;
  }
  // <details> openness is user-driven UI state, not template state — never let a re-render
  // snap an expanded closed-task entry shut again.
  if (tag !== 'DETAILS') morphChildren(fromNode, toNode);
}
function morphChildren(fromParent, toParent) {
  const toChildren = Array.from(toParent.childNodes);
  // Key matching by id lets a node that moved position (e.g. task list reordering) get reused
  // in place rather than torn down and rebuilt — preserves any live state (focus, open dropdown)
  // that node might be holding.
  const fromKeyed = {};
  Array.from(fromParent.childNodes).forEach(c => { if (c.nodeType === 1 && c.id) fromKeyed[c.id] = c; });
  let cursor = fromParent.firstChild;
  for (let i = 0; i < toChildren.length; i++) {
    const toChild = toChildren[i];
    const toKey = toChild.nodeType === 1 ? toChild.id : null;
    let matched = (toKey && fromKeyed[toKey]) ? fromKeyed[toKey] : null;
    if (matched && matched !== cursor) fromParent.insertBefore(matched, cursor);
    const working = matched || cursor;
    if (!working) { fromParent.appendChild(toChild.cloneNode(true)); continue; }
    if (working.nodeType !== toChild.nodeType || working.nodeName !== toChild.nodeName) {
      const clone = toChild.cloneNode(true);
      fromParent.replaceChild(clone, working);
      cursor = clone.nextSibling;
      continue;
    }
    morphNode(working, toChild);
    cursor = working.nextSibling;
  }
  while (fromParent.childNodes.length > toChildren.length) fromParent.removeChild(fromParent.lastChild);
}
function morphHTML(container, html) {
  const temp = document.createElement('div');
  temp.innerHTML = html;
  morphChildren(container, temp);
}

function render() {
  const snapshot = snapshotFieldValues();
  const leaderboardPositions = captureLeaderboardRowPositions();
  try {
    renderInner();
    restoreFieldValues(snapshot);
    animateLeaderboardRowPositions(leaderboardPositions);
  } catch (e) {
    console.error('Render failed:', e);
    const app = document.getElementById('app');
    if (app) app.innerHTML = `<div style="max-width:480px;margin:80px auto;text-align:center;"><div style="font-weight:700;margin-bottom:8px;">Something went wrong displaying this page.</div><div class="small muted" style="margin-bottom:16px;">${esc(e.message || 'Unknown error')}</div><button class="btn btn-primary" onclick="location.reload()">Reload</button></div>`;
  }
}
function renderInner() {
  const app = document.getElementById('app');
  if (!session || !token) { morphHTML(app, renderLoginPage()); bindLogin(); return; }
  // Changed from a hard block to a dismissible reminder, at explicit request: forcing this
  // screen every single time became a genuine dead end on a hosting tier where the database can
  // reset and wipe out an already-set password — the person would be stuck re-doing this
  // forever with no way to just get back into their own data. The password-change form itself
  // still exists and still works exactly as before; it's just no longer the only thing visible.
  // Security tradeoff, stated plainly rather than hidden: a temporary/default password now
  // grants full access, not just access to the one change-password screen — reasonable for this
  // deployment's current situation, but worth reconsidering once on persistent, reliable storage.
  if (session.mustChangePassword && ui.showPasswordChangeModal) {
    morphHTML(app, renderForcedPasswordChange());
    bindForcedPasswordChange();
    return;
  }
  let body = '';
  if (ui.adminTab === 'tasks') body = renderTasksView();
  else if (ui.adminTab === 'alltasks' && session.role === 'admin') body = renderAllTasksCard();
  else if (ui.adminTab === 'accounts' && session.role === 'admin') body = renderAccountsView();
  else if (ui.adminTab === 'performance' && session.role === 'admin') body = renderPerformanceView();
  else if (ui.adminTab === 'auditlog' && session.role === 'admin') body = renderAuditLogView();
  else if (ui.adminTab === 'peakhours' && session.role === 'admin') body = renderPeakHoursView();
  else if (ui.adminTab === 'mydashboard') body = renderMyDashboardView();
  else if (ui.adminTab === 'hrdashboard' && (session.role === 'admin' || isHRTeamName(session.team))) body = renderHRDashboardView();
  else if (ui.adminTab === 'reports' && session.role === 'admin') body = renderReportsView();
  else if (ui.adminTab === 'calendar') body = renderCalendarView();
  else if (ui.adminTab === 'profile') body = renderProfileView();
  else if (ui.adminTab === 'myteam' && session.role !== 'admin' && session.isTeamLead) body = renderMyTeamView();
  else body = renderTodayFeed();
  morphHTML(app, `
    <div class="app-shell">
      ${renderSidebar()}
      <div class="main-col">
        ${renderTopbarSlim()}
        <main class="content">
          ${bannerHTML()}
          ${body}
        </main>
      </div>
    </div>`);
  bindGlobal();
  if (ui.adminTab === 'tasks' || ui.adminTab === 'alltasks' || ui.adminTab === 'calendar') { bindMyTasks(); bindFollowupForm(); bindSubtaskForm(); bindAddAssigneeForm(); }
  if (ui.adminTab === 'tasks') { bindApprovalForm(); bindApprovalsSection(); }
  if (ui.adminTab === 'calendar') bindCalendarView();
  if (ui.adminTab === 'tasks') bindTaskForm();
  if (ui.adminTab === 'accounts') bindAccounts();
  if (ui.adminTab === 'profile') bindProfile();
  if (ui.adminTab === 'myteam') bindMyTeam();
  if (ui.adminTab === 'peakhours') bindPeakHoursView();
  if (ui.adminTab === 'performance') bindPerformanceView();
  if (ui.adminTab === 'mydashboard') bindMyDashboardView();
  if (ui.adminTab === 'hrdashboard') bindHRDashboardView();
  if (ui.adminTab === 'auditlog') bindAuditLogView();
  if (ui.adminTab === 'reports') bindReportsView();
  if (ui.adminTab === 'today') bindTodayFeed();
}
function bindGlobal() {
  bindThemeToggle();
  document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { ui.adminTab = b.dataset.tab; ui.sidebarOpen = false; localStorage.setItem('ls_last_tab', ui.adminTab); render(); });
  const menuToggle = document.querySelector('[data-act="toggle-sidebar"]'); if (menuToggle) menuToggle.onclick = () => { ui.sidebarOpen = !ui.sidebarOpen; render(); };
  document.querySelectorAll('[data-act="close-sidebar"]').forEach(b => b.onclick = () => { ui.sidebarOpen = false; render(); });
  const logoutBtn = document.querySelector('[data-act="logout"]'); if (logoutBtn) logoutBtn.onclick = () => logout();
  const reopenPwChange = document.querySelector('[data-act="reopen-password-change"]'); if (reopenPwChange) reopenPwChange.onclick = () => { ui.showPasswordChangeModal = true; localStorage.removeItem('ls_pw_reminder_dismissed'); render(); };
  const openNotif = document.querySelector('[data-act="open-notifications"]');
  if (openNotif) openNotif.onclick = () => {
    ui.notifDrawerOpen = true; render();
    // Opening the panel IS "looking at" the notifications — matches how Gmail/Slack/LinkedIn
    // handle it, and how Mihir Store Management's own notification panel already works. No need
    // to make someone click each item individually just to clear the unread badge.
    if (unreadNotifCount > 0) {
      api('/api/notifications/read-all', { method: 'POST' }).then(() => refreshData()).catch(() => {});
    }
  };
  document.querySelectorAll('[data-act="close-notifications"]').forEach(el => el.onclick = () => { ui.notifDrawerOpen = false; render(); });
  document.querySelectorAll('[data-mark-notif-read]').forEach(el => el.onclick = async () => {
    const id = el.dataset.markNotifRead;
    try { await api(`/api/notifications/${id}/read`, { method: 'POST' }); } catch (e) { /* ignore */ }
    if (el.dataset.notifGotoTask) { ui.notifDrawerOpen = false; ui.adminTab = 'tasks'; }
    await refreshData();
  });
  const toggleForm = document.querySelector('[data-act="toggle-task-form"]'); if (toggleForm) toggleForm.onclick = () => { ui.taskFormOpen = true; ui.taskFormIsDrawing = false; ui.taskFormTags = []; ui.taskFormStages = [{ usernames: [] }]; ui.taskFormAutoRelease = false; render(); };
  const toggleApproval = document.querySelector('[data-act="toggle-approval-form"]'); if (toggleApproval) toggleApproval.onclick = () => { ui.approvalFormOpen = true; ui.approvalFormReviewers = []; render(); };
}
// A subtask is created through the normal task-creation endpoint with parentTaskId set — same
// title/deadline/assignee inputs as any task, just simplified to the essentials here since this
// is a quick inline add, not the full task form. Full features (levels, individual deadlines,
// attachments) can still be added afterward by opening the subtask itself once created.
function subtaskFormHTML(parentTaskId) {
  return `
    <div class="card" style="background:var(--panel-2);margin-top:8px;">
      <label>Subtask title</label>
      <input type="text" id="subtask-title-${parentTaskId}" placeholder="e.g. Get material samples approved">
      <label>Deadline</label>
      <input type="date" id="subtask-deadline-${parentTaskId}">
      <label>Assign to</label>
      <div class="tagpicker" id="subtask-tagpicker-${parentTaskId}">
        <div data-tagpicker-chips style="margin-bottom:6px;"></div>
        <div style="position:relative;">
          <input type="text" data-tagpicker-input placeholder="Type a name, username, or team — try @ to search">
          <div data-tagpicker-suggestions class="tag-suggestions-dropdown" style="display:none;"></div>
        </div>
      </div>
      <p class="small muted" style="margin-top:6px;">The main task can't be closed until this subtask (and every other open one) is closed too.</p>
      <button class="btn btn-primary btn-sm" data-act="submit-subtask" data-task-id="${parentTaskId}">Create Subtask</button>
    </div>`;
}
function followupFormHTML(taskId) {
  return `
    <div class="card" style="background:var(--panel-2);margin-top:8px;">
      <label>Tag people to follow up on this task — they'll be notified of activity and can comment/attach, but won't get a close button.</label>
      <div class="tagpicker" id="followup-tagpicker-${taskId}">
        <div data-tagpicker-chips style="margin-bottom:6px;"></div>
        <div style="position:relative;">
          <input type="text" data-tagpicker-input placeholder="Type a name, username, or team — try @ to search">
          <div data-tagpicker-suggestions class="tag-suggestions-dropdown" style="display:none;"></div>
        </div>
      </div>
      <button class="btn btn-primary btn-sm" data-act="submit-followup" data-task-id="${taskId}">Tag for Follow-up</button>
    </div>`;
}
function bindAddAssigneeForm() {
  if (!ui.addAssigneeFormTaskId) return;
  const id = ui.addAssigneeFormTaskId;
  const picker = document.getElementById(`add-assignee-tagpicker-${id}`);
  if (!picker) return;
  bindTagPicker(picker, ui.addAssigneeTags || [], (sel) => { ui.addAssigneeTags = sel; });
  const submitBtn = document.querySelector(`[data-act="submit-add-assignee"][data-task-id="${id}"]`);
  if (submitBtn) submitBtn.onclick = async () => {
    const usernames = ui.addAssigneeTags || [];
    if (usernames.length === 0) { alert('Select at least one person.'); return; }
    try {
      await api(`/api/tasks/${id}/assignees`, { method: 'POST', body: JSON.stringify({ usernames }) });
      ui.addAssigneeFormTaskId = null; ui.addAssigneeTags = [];
      setBanner('Added to task.', 'ok'); await refreshData();
    } catch (e) { setBanner(e.message); render(); }
  };
}
function bindFollowupForm() {
  if (!ui.followupFormTaskId) return;
  const id = ui.followupFormTaskId;
  const picker = document.getElementById(`followup-tagpicker-${id}`);
  if (!picker) return;
  bindTagPicker(picker, ui.followupFormTags || [], (sel) => { ui.followupFormTags = sel; });
  const submitBtn = document.querySelector(`[data-act="submit-followup"][data-task-id="${id}"]`);
  if (submitBtn) submitBtn.onclick = async () => {
    const usernames = ui.followupFormTags || [];
    if (usernames.length === 0) { alert('Select at least one person.'); return; }
    try {
      await api(`/api/tasks/${id}/followup`, { method: 'POST', body: JSON.stringify({ usernames }) });
      ui.followupFormTaskId = null; ui.followupFormTags = [];
      setBanner('Tagged for follow-up.', 'ok'); await refreshData();
    } catch (e) { setBanner(e.message); render(); }
  };
}
function bindSubtaskForm() {
  if (!ui.subtaskFormTaskId) return;
  const parentId = ui.subtaskFormTaskId;
  const picker = document.getElementById(`subtask-tagpicker-${parentId}`);
  if (!picker) return;
  bindTagPicker(picker, ui.subtaskFormTags || [], (sel) => { ui.subtaskFormTags = sel; });
  const submitBtn = document.querySelector(`[data-act="submit-subtask"][data-task-id="${parentId}"]`);
  if (submitBtn) submitBtn.onclick = async () => {
    const title = document.getElementById(`subtask-title-${parentId}`).value.trim();
    const deadline = document.getElementById(`subtask-deadline-${parentId}`).value;
    const usernames = ui.subtaskFormTags || [];
    if (!title) { alert('Enter a title for the subtask.'); return; }
    if (!deadline) { alert('Pick a deadline for the subtask.'); return; }
    if (usernames.length === 0) { alert('Select at least one person to assign the subtask to.'); return; }
    try {
      await api('/api/tasks', { method: 'POST', body: JSON.stringify({ title, priority: 'medium', deadline, assignedToList: usernames, parentTaskId: parentId }) });
      ui.subtaskFormTaskId = null; ui.subtaskFormTags = [];
      setBanner('Subtask created.', 'ok'); await refreshData();
    } catch (e) { setBanner(e.message); render(); }
  };
}
function bindMyTasks() {
  document.querySelectorAll('[data-release-stage]').forEach(btn => btn.onclick = async () => {
    const id = btn.dataset.releaseStage; const stage = btn.dataset.stage;
    try { await api(`/api/tasks/${id}/release-stage/${stage}`, { method: 'POST' }); setBanner(`Level ${stage} released.`, 'ok'); await refreshData(); }
    catch (e) { setBanner(e.message); render(); }
  });
  const searchInput = document.getElementById('task-search-input');
  if (searchInput) searchInput.oninput = () => { ui.taskSearchQuery = searchInput.value; ui.myHistoryShown = 20; ui.allHistoryShown = 20; render(); };
  const filterProjectSelect = document.getElementById('task-filter-project');
  if (filterProjectSelect) filterProjectSelect.onchange = () => { ui.taskFilterProject = filterProjectSelect.value; ui.myHistoryShown = 20; ui.allHistoryShown = 20; render(); };
  const filterPhaseSelect = document.getElementById('task-filter-phase');
  if (filterPhaseSelect) filterPhaseSelect.onchange = () => { ui.taskFilterPhase = filterPhaseSelect.value; ui.myHistoryShown = 20; ui.allHistoryShown = 20; render(); };
  const showMoreMy = document.querySelector('[data-act="show-more-my-history"]');
  if (showMoreMy) showMoreMy.onclick = () => { ui.myHistoryShown = (ui.myHistoryShown || 20) + HISTORY_PAGE_SIZE; render(); };
  const showMoreAll = document.querySelector('[data-act="show-more-all-history"]');
  if (showMoreAll) showMoreAll.onclick = () => { ui.allHistoryShown = (ui.allHistoryShown || 20) + HISTORY_PAGE_SIZE; render(); };
  document.querySelectorAll('[data-act="toggle-add-assignee-form"]').forEach(btn => btn.onclick = () => {
    const id = btn.dataset.taskId;
    ui.addAssigneeFormTaskId = (ui.addAssigneeFormTaskId === id) ? null : id;
    ui.addAssigneeTags = [];
    render();
  });
  document.querySelectorAll('[data-remove-assignee]').forEach(el => el.onclick = async () => {
    const id = el.dataset.removeAssignee; const username = el.dataset.username;
    if (!confirm(`Remove ${username} from this task? They haven't submitted or been approved yet, so this is fully undoable.`)) return;
    try { await api(`/api/tasks/${id}/assignees/${username}`, { method: 'DELETE' }); setBanner('Removed.', 'ok'); await refreshData(); }
    catch (e) { setBanner(e.message); render(); }
  });
  document.querySelectorAll('[data-act="toggle-cancel-form"]').forEach(btn => btn.onclick = () => {
    const id = btn.dataset.taskId;
    ui.cancelFormTaskId = (ui.cancelFormTaskId === id) ? null : id;
    render();
  });
  document.querySelectorAll('[data-act="submit-cancel"]').forEach(btn => btn.onclick = async () => {
    const id = btn.dataset.taskId;
    const reasonEl = document.getElementById(`cancel-reason-${id}`);
    const reason = reasonEl ? reasonEl.value.trim() : '';
    if (reason.length < 5) { alert('A reason (at least 5 characters) is required to cancel a task.'); return; }
    if (!confirm('Cancel this task? This is for a mistake or abandoned work, not completed work — it will not count toward anyone\'s completion stats.')) return;
    try {
      await api(`/api/tasks/${id}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) });
      ui.cancelFormTaskId = null;
      setBanner('Task cancelled.', 'ok'); await refreshData();
    } catch (e) { setBanner(e.message); render(); }
  });
  document.querySelectorAll('[data-mention-input]').forEach(ta => {
    const sugEl = document.getElementById(`task-reply-mentions-${ta.id.replace('task-reply-', '')}`);
    if (sugEl) bindMentionTextarea(ta, sugEl);
  });
  document.querySelectorAll('[data-act="toggle-followup-form"]').forEach(btn => btn.onclick = () => {
    const id = btn.dataset.taskId;
    // Toggle: clicking the same task's button again closes it; clicking a different task's
    // button switches to that one (only one follow-up form open at a time).
    ui.followupFormTaskId = (ui.followupFormTaskId === id) ? null : id;
    ui.followupFormTags = [];
    render();
  });
  document.querySelectorAll('[data-act="toggle-subtask-form"]').forEach(btn => btn.onclick = () => {
    const id = btn.dataset.taskId;
    ui.subtaskFormTaskId = (ui.subtaskFormTaskId === id) ? null : id;
    ui.subtaskFormTags = [];
    render();
  });
  document.querySelectorAll('[id^="task-reply-file-"]').forEach(inp => inp.onchange = () => {
    const id = inp.id.replace('task-reply-file-', '');
    const f = inp.files[0]; if (!f) return;
    readAnyFile(f, dataUrl => {
      ui.pendingReplyFiles = ui.pendingReplyFiles || {};
      ui.pendingReplyFiles[id] = dataUrl ? { data: dataUrl, name: f.name } : null;
      const preview = document.getElementById(`task-reply-file-preview-${id}`);
      if (preview) preview.innerHTML = dataUrl ? `<div class="small muted">Attached: ${esc(f.name)}</div>` : '<div class="err">Could not read file.</div>';
    });
  });
  document.querySelectorAll('[data-reply-task]').forEach(btn => btn.onclick = async () => {
    if (btn.disabled) return;
    const id = btn.dataset.replyTask;
    const field = document.getElementById(`task-reply-${id}`);
    const message = field.value.trim();
    const pending = (ui.pendingReplyFiles || {})[id];
    if (!message && !pending) { alert('Write a message or attach a file.'); return; }
    btn.disabled = true;
    try {
      await api(`/api/tasks/${id}/reply`, { method: 'POST', body: JSON.stringify({ message, attachment: pending ? pending.data : null, attachmentName: pending ? pending.name : '' }) });
      if (ui.pendingReplyFiles) delete ui.pendingReplyFiles[id];
      if (field) field.value = '';
      setBanner('Reply sent.', 'ok'); await refreshData();
    } catch (e) { btn.disabled = false; setBanner(e.message); render(); }
  });
  document.querySelectorAll('[data-submit-mine]').forEach(btn => btn.onclick = async () => {
    if (btn.disabled) return;
    const id = btn.dataset.submitMine;
    const noteEl = document.getElementById(`submit-note-${id}`);
    const note = noteEl ? noteEl.value.trim() : '';
    if (note.length < 5) { alert('Briefly describe what you completed (at least 5 characters) before submitting.'); return; }
    document.querySelectorAll(`[data-submit-mine="${id}"]`).forEach(b => b.disabled = true);
    try {
      await api(`/api/tasks/${id}/submit-mine`, { method: 'POST', body: JSON.stringify({ note }) });
      setBanner('Submitted — waiting on the task creator to approve.', 'ok');
      await refreshData();
    } catch (e) { document.querySelectorAll(`[data-submit-mine="${id}"]`).forEach(b => b.disabled = false); setBanner(e.message); render(); }
  });
  document.querySelectorAll('[data-approve-assignee]').forEach(btn => btn.onclick = async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    const id = btn.dataset.approveAssignee; const username = btn.dataset.username;
    try {
      const result = await api(`/api/tasks/${id}/approve/${username}`, { method: 'POST' });
      celebrate(undefined, result.taskClosed ? CLOSE_MESSAGES : COMPLETION_MESSAGES);
      setBanner(result.taskClosed ? `${username}'s part approved — everyone is now approved, so the task is fully closed.` : `${username}'s part approved.`, 'ok');
      await refreshData();
    } catch (e) { btn.disabled = false; setBanner(e.message); render(); }
  });
  document.querySelectorAll('[data-reject-assignee]').forEach(btn => btn.onclick = async () => {
    if (btn.disabled) return;
    const id = btn.dataset.rejectAssignee; const username = btn.dataset.username;
    const reasonEl = document.getElementById(`reject-reason-${id}-${username}`);
    const reason = reasonEl ? reasonEl.value.trim() : '';
    if (reason.length < 5) { alert('A reason (at least 5 characters) is required so they know what to fix.'); return; }
    btn.disabled = true;
    try {
      await api(`/api/tasks/${id}/reject/${username}`, { method: 'POST', body: JSON.stringify({ reason }) });
      setBanner(`${username}'s submission rejected — they've been notified to redo and resubmit.`, 'ok');
      await refreshData();
    } catch (e) { btn.disabled = false; setBanner(e.message); render(); }
  });
  document.querySelectorAll('[data-act="toggle-reopen-form"]').forEach(btn => btn.onclick = () => {
    const id = btn.dataset.taskId;
    ui.reopenFormTaskId = (ui.reopenFormTaskId === id) ? null : id;
    render();
  });
  document.querySelectorAll('[data-act="submit-reopen"]').forEach(btn => btn.onclick = async () => {
    const id = btn.dataset.taskId;
    const reasonEl = document.getElementById(`reopen-reason-${id}`);
    const reason = reasonEl ? reasonEl.value.trim() : '';
    if (!reasonEl.reportValidity()) return;
    if (reason.length < 5) { alert('A reason (at least 5 characters) is required to reopen a task.'); return; }
    try {
      await api(`/api/tasks/${id}/reopen`, { method: 'POST', body: JSON.stringify({ reason }) });
      ui.reopenFormTaskId = null;
      setBanner('Task reopened.', 'ok'); await refreshData();
    } catch (e) { setBanner(e.message); render(); }
  });
  document.querySelectorAll('[data-close-task]').forEach(btn => btn.onclick = async () => {
    const fullyApproved = btn.dataset.fullyApproved === 'true';
    if (!fullyApproved && !confirm('Not everyone tagged has completed their part yet — close this task now anyway?')) return;
    try { await api(`/api/tasks/${btn.dataset.closeTask}/close`, { method: 'POST' }); celebrate(undefined, CLOSE_MESSAGES); setBanner('Task closed.', 'ok'); await refreshData(); }
    catch (e) { setBanner(e.message); render(); }
  });
  document.querySelectorAll('[data-toggle-checklist]').forEach(cb => cb.onchange = async () => {
    try { await api(`/api/tasks/${cb.dataset.taskId}/checklist/${cb.dataset.toggleChecklist}/toggle`, { method: 'POST' }); await refreshData(); }
    catch (e) { setBanner(e.message); render(); }
  });
  document.querySelectorAll('[data-add-checklist]').forEach(btn => btn.onclick = async () => {
    const id = btn.dataset.addChecklist;
    const inp = document.getElementById(`checklist-new-${id}`);
    const text = inp.value.trim();
    if (!text) return;
    try { await api(`/api/tasks/${id}/checklist`, { method: 'POST', body: JSON.stringify({ text }) }); setBanner('Added.', 'ok'); await refreshData(); }
    catch (e) { setBanner(e.message); render(); }
  });
  document.querySelectorAll('[data-delete-checklist]').forEach(btn => btn.onclick = async () => {
    try { await api(`/api/tasks/${btn.dataset.taskId}/checklist/${btn.dataset.deleteChecklist}`, { method: 'DELETE' }); await refreshData(); }
    catch (e) { setBanner(e.message); render(); }
  });
}
function bindAccounts() {
  bindPasswordToggles();
  const submitDept = document.querySelector('[data-act="submit-new-department"]');
  if (submitDept) submitDept.onclick = async () => {
    const inp = document.getElementById('new-dept-name');
    const name = inp.value.trim();
    if (!name) { setBanner('Enter a department name.'); render(); return; }
    try { await api('/api/teams', { method: 'POST', body: JSON.stringify({ name }) }); setBanner('Department added.', 'ok'); await refreshData(); }
    catch (e) { setBanner(e.message); render(); }
  };
  const deptFilter = document.getElementById('accounts-dept-filter');
  if (deptFilter) deptFilter.onchange = () => { ui.accountsDeptFilter = deptFilter.value; render(); };
  document.querySelectorAll('[data-remove-department]').forEach(el => el.onclick = async () => {
    const dept = el.dataset.removeDepartment;
    const memberCount = userDirectory.filter(u => u.team === dept).length;
    const confirmMsg = memberCount > 0
      ? `${memberCount} account${memberCount === 1 ? ' is' : 's are'} currently in "${dept}". Removing this department will clear their Team field (their accounts stay, just unassigned from a team) — continue?`
      : `Remove the "${dept}" department?`;
    if (!confirm(confirmMsg)) return;
    try { await api(`/api/teams/${encodeURIComponent(dept)}`, { method: 'DELETE' }); setBanner('Department removed.', 'ok'); await refreshData(); }
    catch (e) { setBanner(e.message); render(); }
  });
  const submitAcc = document.querySelector('[data-act="submit-new-account"]');
  if (submitAcc) submitAcc.onclick = async () => {
    const username = document.getElementById('new-acc-username').value.trim();
    const name = document.getElementById('new-acc-name').value.trim();
    const password = document.getElementById('new-acc-password').value;
    const role = document.getElementById('new-acc-role').value;
    const team = document.getElementById('new-acc-team').value.trim();
    const designation = document.getElementById('new-acc-designation').value.trim();
    try {
      await api('/api/users', { method: 'POST', body: JSON.stringify({ username, name, password, role, team, designation }) });
      setBanner('Account created.', 'ok'); await refreshData();
    } catch (e) { setBanner(e.message); render(); }
  };
  document.querySelectorAll('[data-name-for]').forEach(inp => inp.onblur = async () => {
    const name = inp.value.trim(); if (!name) { setBanner('Name cannot be empty.'); render(); return; }
    try { await api(`/api/users/${inp.dataset.nameFor}/name`, { method: 'POST', body: JSON.stringify({ name }) }); setBanner('Name updated.', 'ok'); await refreshData(); }
    catch (e) { setBanner(e.message); render(); }
  });
  document.querySelectorAll('[data-username-for]').forEach(inp => inp.onblur = async () => {
    const oldUsername = inp.dataset.usernameFor; const newUsername = inp.value.trim();
    if (newUsername === oldUsername) return;
    if (!newUsername) { inp.value = oldUsername; return; }
    if (!confirm(`Change username from "${oldUsername}" to "${newUsername}"? They'll need to log in again with the new username.`)) { inp.value = oldUsername; return; }
    try { await api(`/api/users/${oldUsername}/rename`, { method: 'POST', body: JSON.stringify({ newUsername }) }); setBanner('Username updated.', 'ok'); await refreshData(); }
    catch (e) { inp.value = oldUsername; setBanner(e.message); render(); }
  });
  document.querySelectorAll('[data-team-for]').forEach(inp => inp.onblur = async () => {
    try { await api(`/api/users/${inp.dataset.teamFor}/team`, { method: 'POST', body: JSON.stringify({ team: inp.value.trim() }) }); setBanner('Team updated.', 'ok'); await refreshData(); }
    catch (e) { setBanner(e.message); render(); }
  });
  document.querySelectorAll('[data-designation-for]').forEach(inp => inp.onblur = async () => {
    try { await api(`/api/users/${inp.dataset.designationFor}/designation`, { method: 'POST', body: JSON.stringify({ designation: inp.value.trim() }) }); setBanner('Designation updated.', 'ok'); await refreshData(); }
    catch (e) { setBanner(e.message); render(); }
  });
  document.querySelectorAll('[data-team-lead-for]').forEach(cb => cb.onchange = async () => {
    try { await api(`/api/users/${cb.dataset.teamLeadFor}/team-lead`, { method: 'POST', body: JSON.stringify({ isTeamLead: cb.checked }) }); await refreshData(); }
    catch (e) { setBanner(e.message); render(); }
  });
  document.querySelectorAll('[data-save-director-visibility]').forEach(btn => btn.onclick = async () => {
    const username = btn.dataset.saveDirectorVisibility;
    const select = document.querySelector(`[data-director-visibility-for="${username}"]`);
    const departments = Array.from(select.selectedOptions).map(o => o.value);
    try { await api(`/api/users/${username}/visible-departments`, { method: 'POST', body: JSON.stringify({ departments }) }); setBanner('Visibility updated.', 'ok'); await refreshData(); }
    catch (e) { setBanner(e.message); render(); }
  });
  document.querySelectorAll('[data-remove-user]').forEach(btn => btn.onclick = async () => {
    if (!confirm(`Remove account "${btn.dataset.removeUser}"?`)) return;
    try { await api(`/api/users/${btn.dataset.removeUser}`, { method: 'DELETE' }); setBanner('Account removed.', 'ok'); await refreshData(); }
    catch (e) { setBanner(e.message); render(); }
  });
  document.querySelectorAll('[data-reset-password-for]').forEach(btn => btn.onclick = () => {
    const row = document.getElementById(`reset-pw-row-${btn.dataset.resetPasswordFor}`);
    row.style.display = row.style.display === 'none' ? 'table-row' : 'none';
    bindPasswordToggles();
  });
  document.querySelectorAll('[data-do-reset-password]').forEach(btn => btn.onclick = async () => {
    const username = btn.dataset.doResetPassword;
    const newPassword = document.getElementById(`reset-pw-input-${username}`).value;
    if (newPassword.length < 6) { alert('Password must be at least 6 characters.'); return; }
    try { await api(`/api/users/${username}/reset-password`, { method: 'POST', body: JSON.stringify({ newPassword }) }); setBanner('Password reset.', 'ok'); await refreshData(); }
    catch (e) { setBanner(e.message); render(); }
  });
}

/* ==================== BOOT ==================== */
render();
if (session && token) refreshData();
// Guard against interrupting active typing: a full-DOM rebuild every 30s (see refreshData)
// causes a visible flash and can even make a cursor mid-sentence jump or feel like it "vanished"
// for a moment. If the person currently has focus in a text field WITH something typed into it,
// skip this cycle's refresh entirely rather than rebuild the page out from under them — the next
// 30s tick will simply try again, so nothing is lost, just delayed until they're not mid-type.
function userIsActivelyTyping() {
  const active = document.activeElement;
  if (!active) return false;
  const tag = (active.tagName || '').toLowerCase();
  const isTextField = (tag === 'textarea') || (tag === 'input' && !['checkbox', 'file', 'radio', 'button', 'submit'].includes(active.type));
  return isTextField && !!active.value;
}
setInterval(() => { if (session && token && !session.mustChangePassword && !userIsActivelyTyping()) refreshData({ background: true }); }, 30000);
