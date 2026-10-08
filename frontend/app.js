/* ==================== STATE ==================== */
// Browser storage that can never crash the app. Safari with "Block all cookies", some private /
// lockdown modes and strict privacy settings THROW on any localStorage access — and because the
// very first lines of this file read the saved login, that throw used to stop the whole app with
// a blank white page on that one machine. Falls back to in-memory storage (works normally, the
// user just has to log in again after a reload).
const safeStorage = (() => {
  const memory = {};
  let ls = null;
  try { ls = window.localStorage; const k = '__ls_test__'; ls.setItem(k, '1'); ls.removeItem(k); } catch (e) { ls = null; }
  return {
    available: !!ls,
    getItem(k) { try { return ls ? ls.getItem(k) : (k in memory ? memory[k] : null); } catch (e) { return k in memory ? memory[k] : null; } },
    setItem(k, v) { memory[k] = String(v); try { if (ls) ls.setItem(k, String(v)); } catch (e) { /* full or blocked — memory copy still works */ } },
    removeItem(k) { delete memory[k]; try { if (ls) ls.removeItem(k); } catch (e) { /* ignore */ } },
  };
})();
let token = safeStorage.getItem('ls_token') || null;
// A corrupted saved session must not stop the app from starting either.
let session = null;
try { session = JSON.parse(safeStorage.getItem('ls_session') || 'null'); } catch (e) { session = null; token = null; }
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
let theme = safeStorage.getItem('ks_theme') || 'light';
document.documentElement.setAttribute('data-theme', theme);
function setTheme(t) { theme = t; safeStorage.setItem('ks_theme', t); document.documentElement.setAttribute('data-theme', t); render(); }

function defaultUiState() {
  return {
    adminTab: 'today', sidebarOpen: false, sidebarCollapsed: !!safeStorage.getItem('ls_sidebar_collapsed'), notifDrawerOpen: false, banner: null,
    loginErr: '', pwChangeErr: '', showForgotPassword: false, forgotPasswordStage: 'request', forgotPasswordErr: '', forgotPasswordUsername: '', showPasswordChangeModal: true,
    pendingTaskFile: null, pendingTaskFileName: null,
    pendingReplyFiles: {},
    taskArchiveTab: 'open',
    taskFormOpen: false, taskFormIsDrawing: false, taskFormTags: [],
    taskFormStages: [{ usernames: [] }], taskFormAutoRelease: false,
    importOpen: false, importFileName: null, importFileData: null, importPreview: null, importBusy: false, importResult: null, importOnlyProblems: false, importError: null,
    followupFormTaskId: null, followupFormTags: [],
    subtaskFormTaskId: null, subtaskFormTags: [], individualDeadlineFormTaskId: null, reshuffleLevelsFormTaskId: null,
    levelEditKey: null, levelEditConfirmKey: null, levelEditConfirmValue: null, deleteTaskConfirmId: null,
    cancelFormTaskId: null,
    addAssigneeFormTaskId: null, addAssigneeTags: [],
    taskSearchQuery: '', taskFilterProject: '', taskFilterPhase: '', taskFilterTagging: '',
    myOwnerFilter: 'all', myOwnerPerson: '', todayCardOpen: null, todayCardShown: 30, todayScope: 'mine', dashScope: 'mine', dashCardOpen: null, dashCardShown: 30,
    myOpenShown: 30, allOpenShown: 30, deadlineEditTaskId: null,
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
  const savedTab = safeStorage.getItem('ls_last_tab');
  if (savedTab) ui.adminTab = savedTab;
  // Same idea as the tab restore above: once someone has dismissed the temporary-password
  // reminder, it should stay dismissed across refreshes too, not reappear and feel like the old
  // hard block all over again — it should only come back if they explicitly click "Set a real
  // password now" from the banner.
  if (safeStorage.getItem('ls_pw_reminder_dismissed') === 'true') ui.showPasswordChangeModal = false;
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
  upload: '<path d="M12 15V4M7.5 8.5L12 4l4.5 4.5"/><path d="M4 15v4a1 1 0 001 1h14a1 1 0 001-1v-4"/>',
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
  // Never wait forever: a request stuck behind a waking-up server would otherwise hold the whole
  // refresh cycle hostage. Long uploads/exports can pass a bigger opts.timeoutMs.
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), opts.timeoutMs || 90000) : null;
  let res;
  try {
    res = await fetch(path, { ...opts, headers: { ...headers, ...(opts.headers || {}) }, signal: controller ? controller.signal : undefined });
  } catch (e) {
    throw new Error(e && e.name === 'AbortError' ? 'The server is taking too long to answer — please try again in a moment.' : 'Can\'t reach the server — check your internet connection.');
  } finally { if (timer) clearTimeout(timer); }
  let data = {};
  try { data = await res.json(); } catch (e) { /* no body */ }
  if (res.status === 401 && token) {
    token = null; session = null;
    safeStorage.removeItem('ls_token'); safeStorage.removeItem('ls_session');
    dataLoadedOnce = false; lastDataFingerprint = null; clearDataSnapshots();
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
// A genuine bug fix, not a style choice: deadlineDate() parses a date-only deadline ("2026-09-15")
// to MIDNIGHT AT THE START of that day — comparing that directly against "now" would mark a task
// due today as overdue for the entire day, the instant it turns midnight, rather than only once
// that whole day has actually passed. A deadline that includes a specific time is compared
// exactly as given; a date-only deadline is only overdue once its entire day has elapsed (i.e.
// from the start of the NEXT day).
function isOverdue(isoDeadline, now) {
  if (!isoDeadline) return false;
  now = now || new Date();
  if (hasDeadlineTime(isoDeadline)) return deadlineDate(isoDeadline) < now;
  const endOfDeadlineDay = new Date(isoDeadline + 'T00:00:00');
  endOfDeadlineDay.setDate(endOfDeadlineDay.getDate() + 1);
  return endOfDeadlineDay <= now;
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
const PAGE_TITLES = { today: 'Today', tasks: 'My Tasks', alltasks: 'All Tasks', accounts: 'Accounts', profile: 'My Profile', myteam: 'My Team', performance: 'Performance', auditlog: 'Audit Log', calendar: 'Calendar', peakhours: 'Peak Hours', mydashboard: 'My Dashboard', reports: 'Reports', hrdashboard: 'HR Dashboard', exports: 'Export & Archive' };
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
      { key: 'exports', label: 'Export & Archive', icon: 'upload' },
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
    <button class="sidebar-close-bar" data-act="close-sidebar" type="button">✕ Close Menu</button>
    <div class="sidebar-header">
      <div class="brand-plate">
        <div class="brand-mark">${falconMark()}</div>
        <div><div class="brand-name">MIHIR</div><div class="brand-sub">Task Manager</div></div>
      </div>
      <button class="close-x sidebar-close-btn" data-act="close-sidebar" type="button" title="Close menu">✕</button>
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
      <button class="icon-btn menu-toggle" data-act="toggle-sidebar" title="Show / hide menu" aria-label="Show or hide the menu">${icon('grid')}</button>
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
          ` : ui.forgotPasswordStage === 'email-not-configured' ? `
            <p style="margin:0 0 8px;font-weight:700;">Email reset isn't set up on this server yet.</p>
            <p class="small muted" style="margin:0 0 10px;">Nothing was sent — there's no email system connected here yet, so a code was never going to arrive. This isn't specific to your account. Please contact your <b>Admin</b> directly (in person, chat, or however you'd normally reach them) and ask them to reset your password from the <b>Accounts</b> page — it takes them a few seconds, no email required.</p>
            <button class="btn btn-sm" data-act="back-to-forgot-request">← Try a different username</button>
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
      safeStorage.setItem('ls_token', token); safeStorage.setItem('ls_session', JSON.stringify(session));
      ui.loginErr = ''; ui.adminTab = 'today'; safeStorage.setItem('ls_last_tab', 'today');
      await afterLogin();
    } catch (e) { ui.loginErr = e.message; render(); }
  };
  const loginBtn = document.querySelector('[data-act="login"]');
  if (loginBtn) loginBtn.onclick = submit;
  const userField = document.getElementById('lg-user');
  if (userField) userField.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  const passField = document.getElementById('lg-pass');
  if (passField) passField.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  const forgotLink = document.querySelector('[data-act="toggle-forgot-password"]');
  if (forgotLink) forgotLink.onclick = (e) => { e.preventDefault(); ui.showForgotPassword = !ui.showForgotPassword; ui.forgotPasswordStage = 'request'; ui.forgotPasswordErr = ''; render(); };
  const requestOtp = async () => {
    const username = document.getElementById('fp-username').value.trim();
    if (!username) { ui.forgotPasswordErr = 'Enter your username first.'; render(); return; }
    try {
      const result = await api('/api/auth/forgot-password', { method: 'POST', body: JSON.stringify({ username }) });
      ui.forgotPasswordUsername = username;
      // Previously this always moved straight to "check your email for a code" — even when no
      // email was ever actually sent, because SMTP isn't configured on the server yet. That left
      // whoever hit this genuinely stuck: told to wait for a code that would never arrive, with
      // no indication why or what to do instead. Now it tells them plainly and gives them a real
      // next step, instead of a silent dead end.
      ui.forgotPasswordStage = result.emailConfigured ? 'otp-sent' : 'email-not-configured';
      ui.forgotPasswordErr = '';
      render();
    } catch (e) { ui.forgotPasswordErr = e.message; render(); }
  };
  const requestOtpBtn = document.querySelector('[data-act="request-otp"]');
  if (requestOtpBtn) requestOtpBtn.onclick = requestOtp;
  const backToRequestBtn = document.querySelector('[data-act="back-to-forgot-request"]');
  if (backToRequestBtn) backToRequestBtn.onclick = () => { ui.forgotPasswordStage = 'request'; ui.forgotPasswordErr = ''; render(); };
  const fpUsernameField = document.getElementById('fp-username');
  if (fpUsernameField) fpUsernameField.addEventListener('keydown', e => { if (e.key === 'Enter') requestOtp(); });
  const submitOtpReset = async () => {
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
  const submitOtpBtn = document.querySelector('[data-act="submit-otp-reset"]');
  if (submitOtpBtn) submitOtpBtn.onclick = submitOtpReset;
  ['fp-otp', 'fp-new-password'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') submitOtpReset(); });
  });
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
  const submit = async () => {
    const newPassword = document.getElementById('pw-new').value;
    const confirmPassword = document.getElementById('pw-confirm').value;
    if (!newPassword || !confirmPassword) { ui.pwChangeErr = 'Both fields are required.'; render(); return; }
    if (newPassword !== confirmPassword) { ui.pwChangeErr = "Passwords don't match."; render(); return; }
    if (newPassword.length < 6) { ui.pwChangeErr = 'Password must be at least 6 characters.'; render(); return; }
    try {
      const data = await api('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ newPassword }) });
      token = data.token;
      session = { ...session, mustChangePassword: false };
      safeStorage.removeItem('ls_pw_reminder_dismissed');
      safeStorage.setItem('ls_token', token); safeStorage.setItem('ls_session', JSON.stringify(session));
      ui.pwChangeErr = '';
      setBanner('Password set — welcome in.', 'ok');
      await afterLogin();
    } catch (e) { ui.pwChangeErr = e.message; render(); }
  };
  const submitBtn = document.querySelector('[data-act="submit-password-change"]');
  if (submitBtn) submitBtn.onclick = submit;
  ['pw-new', 'pw-confirm'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  });
  const logoutLink = document.querySelector('[data-act="logout"]');
  if (logoutLink) logoutLink.onclick = (e) => { e.preventDefault(); logout(); };
  const dismissLink = document.querySelector('[data-act="dismiss-password-change"]');
  if (dismissLink) dismissLink.onclick = (e) => { e.preventDefault(); ui.showPasswordChangeModal = false; safeStorage.setItem('ls_pw_reminder_dismissed', 'true'); render(); };
}
function logout() {
  dropPushSubscription(token);
  token = null; session = null;
  dataLoadedOnce = false; lastDataFingerprint = null; lastSyncVersion = null;
  clearDataSnapshots(); unregisterAndroidDevice();
  safeStorage.removeItem('ls_token'); safeStorage.removeItem('ls_session'); safeStorage.removeItem('ls_last_tab'); safeStorage.removeItem('ls_pw_reminder_dismissed');
  resetAllAppState();
  render();
}

/* ==================== DEVICE NOTIFICATIONS ====================
   Real, instant, free push: the browser's own push service (Chrome → Google's, Firefox → Mozilla's,
   iPhone home-screen app → Apple's), signed with this server's VAPID keys. Works in Chrome on
   Android (also when the site is installed with "Install app"), desktop browsers, and on iPhone
   once the site is added to the Home Screen (iOS 16.4+). Inside the Android APK (a WebView, which
   has no push) the app's own background check delivers notifications instead. */
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
function pushSupported() { return !window.AndroidBridge && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; }
function urlB64ToUint8Array(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}
let pushPublicKey = null;
// interactive=true only from a button tap (browsers require that for the permission question).
async function ensurePushSubscription(interactive) {
  if (!pushSupported() || !session || !token) return false;
  try {
    if (!pushPublicKey) pushPublicKey = (await api('/api/push/vapid-public-key')).publicKey;
    if (!pushPublicKey) return false; // server not configured
    if (Notification.permission === 'denied') return false;
    if (Notification.permission !== 'granted') {
      if (!interactive) return false;
      if ((await Notification.requestPermission()) !== 'granted') return false;
    }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    const wantKey = urlB64ToUint8Array(pushPublicKey);
    if (sub && sub.options && sub.options.applicationServerKey) {
      const have = new Uint8Array(sub.options.applicationServerKey);
      if (have.length !== wantKey.length || have.some((v, i) => v !== wantKey[i])) { await sub.unsubscribe(); sub = null; } // server keys changed
    }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: wantKey });
    await api('/api/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: sub.toJSON() }) });
    safeStorage.setItem('ls_push_on', session.username);
    return true;
  } catch (e) {
    if (interactive) setBanner('Couldn\'t turn on notifications on this device: ' + (e.message || 'unknown error'));
    return false;
  }
}
// On logout: this device must stop receiving that person's notifications (shared phones/PCs).
function dropPushSubscription(oldToken) {
  if (!pushSupported()) return;
  navigator.serviceWorker.ready.then(reg => reg.pushManager.getSubscription()).then(sub => {
    if (!sub) return;
    if (oldToken) fetch('/api/push/unsubscribe', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + oldToken }, body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => {});
    return sub.unsubscribe();
  }).catch(() => {});
  safeStorage.removeItem('ls_push_on');
}
function notifPromptHTML() {
  if (!session || safeStorage.getItem('ls_notif_prompt_dismissed') === session.username) return '';
  const br = window.AndroidBridge;
  if (br && br.isIgnoringBatteryOptimizations) {
    let ok = true; try { ok = br.isIgnoringBatteryOptimizations(); } catch (e) { ok = true; }
    if (ok) return '';
    return notifCard('Get task notifications on this phone', 'Allow MIHIR Tasks to run in the background so new tasks, approvals and reminders reach you even when the app is closed.', 'Allow', 'allow-background');
  }
  if (pushSupported()) {
    if (Notification.permission !== 'default') return '';
    return notifCard('Turn on notifications for this device', 'Get new tasks, approvals and reminders instantly — even when this page is closed.', 'Turn on', 'enable-push');
  }
  if (isIOS && !isStandalone()) {
    return notifCard('Want notifications on your iPhone?', 'Tap the Share button ⎋ in Safari → "Add to Home Screen", then open MIHIR Tasks from your home screen and turn notifications on.', null, null);
  }
  return '';
}
function notifCard(title, text, actionLabel, action) {
  return `<div class="notif-prompt">
    <div class="notif-prompt-icon">🔔</div>
    <div class="notif-prompt-text"><b>${esc(title)}</b><div class="small muted">${esc(text)}</div></div>
    <div class="notif-prompt-actions">
      ${action ? `<button class="btn btn-primary btn-sm" data-act="${action}">${esc(actionLabel)}</button>` : ''}
      <button class="btn btn-sm" data-act="dismiss-notif-prompt">Not now</button>
    </div>
  </div>`;
}
function bindNotifPrompt() {
  const on = document.querySelector('[data-act="enable-push"]');
  if (on) on.onclick = async () => {
    on.disabled = true;
    const ok = await ensurePushSubscription(true);
    if (ok) setBanner('Notifications are on for this device.', 'ok');
    else if ('Notification' in window && Notification.permission === 'denied') setBanner('Notifications are blocked for this site — allow them in the browser\'s site settings (🔒 next to the address).');
    render();
  };
  const bg = document.querySelector('[data-act="allow-background"]');
  if (bg) bg.onclick = () => { try { window.AndroidBridge.requestBackgroundPermission(); } catch (e) { /* older app */ } setTimeout(render, 1500); };
  const no = document.querySelector('[data-act="dismiss-notif-prompt"]');
  if (no) no.onclick = () => { safeStorage.setItem('ls_notif_prompt_dismissed', session.username); render(); };
}

/* ==================== DATA LOADING ==================== */
async function afterLogin() { await refreshData(); registerAndroidDevice(); ensurePushSubscription(false); }

// ---- Push notifications (PWA) ----
// Registering the service worker is harmless and done unconditionally (needed for the app to be
// installable at all). The subscribe/unsubscribe UI that used to live in My Profile was removed
// on request; the service worker registration itself stays, since it's what makes the app
// installable as a PWA at all, independent of push notifications specifically.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !session) return;
  if (ui.sidebarOpen) { ui.sidebarOpen = false; render(); }
});
// Rotating a tablet / resizing a window across the phone↔desktop width must never leave the
// overlay menu stuck open over a desktop layout.
window.addEventListener('resize', () => {
  if (ui.sidebarOpen && !window.matchMedia('(max-width: 860px)').matches) { ui.sidebarOpen = false; render(); }
});
// ---- Android app support (the APK is a thin shell around this same site) ----
if (window.AndroidBridge) {
  document.documentElement.classList.add('in-android-app');
  // Attachment links ("View file →") are data: links with a download name — save them via the app.
  document.addEventListener('click', (ev) => {
    const a = ev.target && ev.target.closest ? ev.target.closest('a[href^="data:"]') : null;
    if (!a) return;
    ev.preventDefault();
    downloadDataUrl(a.getAttribute('href'), a.getAttribute('download') || 'attachment');
  }, true);
}
// Phone notifications: give the Android app its own notifications-only device token so it can
// check for new notifications in the background (no Firebase / paid push service needed).
async function registerAndroidDevice() {
  const br = window.AndroidBridge;
  if (!br || !br.setDeviceSession || !session || !token) return;
  try { if (br.hasDeviceSession && br.hasDeviceSession(session.username)) return; } catch (e) { /* older app */ }
  try {
    const r = await api('/api/device/register', { method: 'POST' });
    br.setDeviceSession(r.deviceToken, r.username, String(r.latestId || 0));
  } catch (e) { /* offline — tried again next start */ }
}
function unregisterAndroidDevice() {
  try { if (window.AndroidBridge && window.AndroidBridge.clearDeviceSession) window.AndroidBridge.clearDeviceSession(); } catch (e) { /* ignore */ }
}
// The phone's Back button: close whatever is open first, then go back to Today, and only then let
// the app close. Returns true when it handled the press.
window.__androidBack = function () {
  try {
    if (ui.sidebarOpen) { ui.sidebarOpen = false; render(); return true; }
    if (ui.notifDrawerOpen) { ui.notifDrawerOpen = false; render(); return true; }
    if (ui.importOpen) { ui.importOpen = false; resetImportState(); render(); return true; }
    if (ui.taskFormOpen) { ui.taskFormOpen = false; render(); return true; }
    if (ui.deadlineEditTaskId) { ui.deadlineEditTaskId = null; render(); return true; }
    if (session && ui.adminTab && ui.adminTab !== 'today') { ui.adminTab = 'today'; render(); window.scrollTo(0, 0); return true; }
  } catch (e) { /* fall through to the app's own handling */ }
  return false;
};
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/service-worker.js').catch(() => { /* fine on browsers without support */ });
}
let lastDataFingerprint = null;
// opts.background=true marks a silent 30s poll rather than a response to something the person
// just did. For a background poll, if the fetched data is byte-for-byte identical to last time,
// we skip render() entirely — no full-page rebuild, no flash, nothing to "blink". A real change
// (new assignment, a reply, a status flip) always renders, same as before.
/* ==================== DATA LOADING ====================
   Core data (tasks, notifications, people, lists) loads first and appears as soon as it arrives;
   each page's reports are fetched only while that page is open. A failed request keeps the last
   good data instead of blanking the screen, and refreshes never overlap (a slow server used to
   get a new full round of ~22 requests every 8 seconds stacked on top of the unfinished ones). */
const TAB_EXTRAS = {
  today: ['monthlyLeaderboard', 'weeklyLeaderboard'],
  performance: ['completionStats', 'approvalStats', 'ratingsResp', 'approvalDecisionsDetail', 'quarterAwardsResp', 'yearAwardsResp'],
  reports: ['reportsTaskList'],
  auditlog: ['auditLogEntries'],
  peakhours: ['peakHoursData'],
  hrdashboard: ['hrRosterResp'],
  mydashboard: ['myDashboardData'],
};
function dataRequests() {
  const isAdmin = session.role === 'admin';
  const isAdminOrDirector = isAdmin || session.role === 'director';
  const isHR = isHRTeamName(session.team);
  const core = {
    myTasks: '/api/tasks/mine', userDirectory: '/api/users/directory', teamsList: '/api/teams', projectsList: '/api/projects',
    sectionsList: '/api/drawing-sections', phasesList: '/api/task-phases', openTaskTitles: '/api/tasks/open-titles', me: '/api/auth/me',
    notif: '/api/notifications', myApprovalRequests: '/api/approvals/mine',
  };
  if (isAdmin) { core.allTasks = '/api/tasks'; core.allApprovalRequests = '/api/approvals'; }
  const extras = {
    myDashboardData: `/api/reports/my-dashboard${isAdmin && ui.dashboardViewUser && ui.dashboardViewUser !== session.username ? `?username=${encodeURIComponent(ui.dashboardViewUser)}` : ''}`,
  };
  if (isAdmin) Object.assign(extras, {
    monthlyLeaderboard: '/api/reports/monthly-leaderboard', weeklyLeaderboard: '/api/reports/weekly-leaderboard',
    quarterAwardsResp: '/api/reports/period-awards?type=quarter', yearAwardsResp: '/api/reports/period-awards?type=year',
    reportsTaskList: '/api/reports/tasks-list', auditLogEntries: '/api/audit-log',
  });
  if (isAdminOrDirector) Object.assign(extras, {
    completionStats: '/api/reports/completion', approvalStats: '/api/reports/approvals', ratingsResp: '/api/reports/ratings',
    approvalDecisionsDetail: '/api/reports/approval-decisions', peakHoursData: `/api/reports/peak-hours?username=${encodeURIComponent(ui.peakHoursUser || 'all')}`,
  });
  if (isAdmin || isHR) extras.hrRosterResp = '/api/reports/hr-roster';
  // Only the current page's extras.
  const wanted = new Set(TAB_EXTRAS[ui.adminTab || 'today'] || []);
  Object.keys(extras).forEach(k => { if (!wanted.has(k)) delete extras[k]; });
  return { core, extras };
}
function applyData(key, v) {
  switch (key) {
    case 'myTasks': myTasks = v; break;
    case 'allTasks': allTasks = v; break;
    case 'userDirectory': userDirectory = v; break;
    case 'teamsList': teamsList = v; break;
    case 'projectsList': projectsList = v; break;
    case 'sectionsList': sectionsList = v; break;
    case 'phasesList': phasesList = v; break;
    case 'openTaskTitles': openTaskTitles = v; break;
    case 'me':
      session = { ...session, email: v.email, phone: v.phone, team: v.team, designation: v.designation, isTeamLead: !!v.isTeamLead };
      safeStorage.setItem('ls_session', JSON.stringify(session));
      break;
    case 'notif': myNotifications = v.items; unreadNotifCount = v.unread; break;
    case 'myApprovalRequests': myApprovalRequests = v; break;
    case 'allApprovalRequests': allApprovalRequests = v; break;
    case 'myDashboardData': myDashboardData = v; break;
    case 'monthlyLeaderboard': monthlyLeaderboard = v; break;
    case 'weeklyLeaderboard': weeklyLeaderboard = v; break;
    case 'quarterAwardsResp': quarterAwards = v.awards; break;
    case 'yearAwardsResp': yearAwards = v.awards; break;
    case 'reportsTaskList': reportsTaskList = v; break;
    case 'auditLogEntries': auditLogEntries = v; break;
    case 'completionStats': completionStats = v; break;
    case 'approvalStats': approvalStats = v; break;
    case 'ratingsResp': ratingsData = v.ratings; break;
    case 'approvalDecisionsDetail': approvalDecisionsDetail = v; break;
    case 'peakHoursData': peakHoursData = v; break;
    case 'hrRosterResp': hrRosterData = v.roster; hrTotalTasksCompleted = v.totalTasksCompleted; break;
  }
}
let dataLoadedOnce = false;       // true once real data (fresh or from this device's snapshot) is on screen
let refreshInFlight = null, refreshQueued = false;
function refreshData(opts) {
  if (!token || !session) return Promise.resolve();
  if (refreshInFlight) {
    // A refresh is already running. Background ticks just ask for one more round afterwards;
    // a refresh after the person's own action waits for it, then runs again so their change shows.
    if (opts && opts.background) { refreshQueued = true; return refreshInFlight; }
    return refreshInFlight.then(() => refreshData(opts));
  }
  refreshInFlight = doRefresh(opts).finally(() => {
    refreshInFlight = null;
    if (refreshQueued) { refreshQueued = false; refreshData({ background: true }); }
  });
  return refreshInFlight;
}
async function doRefresh(opts) {
  const background = !!(opts && opts.background);
  const { core, extras } = dataRequests();
  const fetchGroup = async (group) => {
    const keys = Object.keys(group);
    const results = await Promise.allSettled(keys.map(k => api(group[k])));
    let ok = 0;
    results.forEach((r, i) => { if (r.status === 'fulfilled' && r.value != null) { try { applyData(keys[i], r.value); ok++; } catch (e) { /* keep old value */ } } });
    return ok;
  };
  const extrasPromise = fetchGroup(extras); // runs alongside core, rendered when it lands
  const coreOk = await fetchGroup(core);
  if (!token || !session) return; // logged out meanwhile (expired session)
  if (coreOk > 0) { dataLoadedOnce = true; saveDataSnapshot(); }
  renderIfChanged(background);
  await extrasPromise;
  if (!token || !session) return;
  renderIfChanged(true);
}

function renderIfChanged(background) {
  if (background) {
    const fingerprint = JSON.stringify({ myTasks, allTasks, userDirectory, teamsList, myNotifications, unreadNotifCount, completionStats, ratingsData, approvalStats, approvalDecisionsDetail, peakHoursData, hrRosterData, myDashboardData, auditLogEntries, monthlyLeaderboard, weeklyLeaderboard, reportsTaskList, myApprovalRequests, allApprovalRequests, quarterAwards, yearAwards });
    if (fingerprint === lastDataFingerprint) return; // nothing changed — skip the render, no flicker
    lastDataFingerprint = fingerprint;
  }
  render();
}
// Fetch just the current page's reports (used when switching pages).
function loadTabExtras() {
  if (!token || !session) return;
  const { extras } = dataRequests();
  const keys = Object.keys(extras);
  if (!keys.length) return;
  Promise.allSettled(keys.map(k => api(extras[k]))).then(results => {
    results.forEach((r, i) => { if (r.status === 'fulfilled' && r.value != null) applyData(keys[i], r.value); });
    if (token && session) renderIfChanged(true);
  });
}

/* ---- Instant start: last data kept on this device (IndexedDB) ----
   After a refresh or reopening the app the screen shows the last known tasks immediately instead
   of an empty page, then updates in place a moment later. Per user; wiped on logout. */
const SNAPSHOT_KEYS = ['myTasks', 'allTasks', 'userDirectory', 'teamsList', 'projectsList', 'sectionsList', 'phasesList', 'openTaskTitles', 'myNotifications', 'unreadNotifCount', 'myApprovalRequests', 'allApprovalRequests'];
function idb() {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open('mihir-tasks', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch (e) { resolve(null); }
  });
}
let snapshotTimer = null;
function saveDataSnapshot() {
  clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(async () => {
    if (!session) return;
    const db = await idb(); if (!db) return;
    const data = { savedAt: Date.now() };
    const vals = { myTasks, allTasks, userDirectory, teamsList, projectsList, sectionsList, phasesList, openTaskTitles, myNotifications, unreadNotifCount, myApprovalRequests, allApprovalRequests };
    SNAPSHOT_KEYS.forEach(k => { data[k] = vals[k]; });
    try { db.transaction('kv', 'readwrite').objectStore('kv').put(data, 'snap:' + session.username); } catch (e) { /* storage full or blocked — fine */ }
  }, 1500);
}
async function loadDataSnapshot() {
  if (!session) return false;
  const db = await idb(); if (!db) return false;
  const data = await new Promise((resolve) => {
    try { const r = db.transaction('kv').objectStore('kv').get('snap:' + session.username); r.onsuccess = () => resolve(r.result || null); r.onerror = () => resolve(null); }
    catch (e) { resolve(null); }
  });
  if (!data || dataLoadedOnce) return false; // real data already arrived — never overwrite it with older
  myTasks = data.myTasks || []; allTasks = data.allTasks || []; userDirectory = data.userDirectory || []; teamsList = data.teamsList || [];
  projectsList = data.projectsList || []; sectionsList = data.sectionsList || []; phasesList = data.phasesList || [];
  openTaskTitles = data.openTaskTitles || []; myNotifications = data.myNotifications || []; unreadNotifCount = data.unreadNotifCount || 0;
  myApprovalRequests = data.myApprovalRequests || []; allApprovalRequests = data.allApprovalRequests || [];
  dataLoadedOnce = true;
  return true;
}
async function clearDataSnapshots() {
  const db = await idb(); if (!db) return;
  try { db.transaction('kv', 'readwrite').objectStore('kv').clear(); } catch (e) { /* ignore */ }
}

/* ---- Live sync: website and phone app stay in step ----
   Every 5 seconds (only while the page is visible) ask the server for its data version — a
   ~4ms request with no database work — and reload only when something changed anywhere. Coming
   back to the tab / app, or the connection returning, checks immediately. */
let lastSyncVersion = null, lastFullRefreshAt = 0, syncBusy = false;
async function syncTick(force) {
  // (Accounts still on a temporary password sync too — they use the app normally until they change it.)
  if (!session || !token || syncBusy) return;
  if (document.hidden && !force) return;
  if (userIsActivelyTyping() && !force) return;
  syncBusy = true;
  try {
    const r = await api('/api/sync');
    if (r && (r.v !== lastSyncVersion || Date.now() - lastFullRefreshAt > 60000)) {
      lastSyncVersion = r.v; lastFullRefreshAt = Date.now();
      await refreshData({ background: true });
    }
  } catch (e) { /* offline or server waking up — next tick retries */ }
  syncBusy = false;
}

// Shown only on the very first load on a device (afterwards the saved snapshot appears instantly):
// grey placeholder cards instead of "No tasks yet", which wrongly looked like the data was gone.
function renderLoadingSkeleton() {
  const bar = (w) => `<div class="sk-bar" style="width:${w}%"></div>`;
  return `<div class="sk-wrap" aria-busy="true" aria-label="Loading">
    <div class="card sk-card">${bar(38)}${bar(70)}</div>
    ${[0, 1, 2, 3].map(() => `<div class="card sk-card">${bar(55)}${bar(85)}${bar(30)}</div>`).join('')}
    <div class="small muted" style="text-align:center;">Loading your tasks… if the server was asleep this can take up to a minute.</div>
  </div>`;
}
/* ==================== TASKS ==================== */
function sortTasksForDisplay(tasks) {
  const now = Date.now();
  const priorityRank = { high: 0, medium: 1, low: 2 };
  return [...tasks].sort((a, b) => {
    const aPri = priorityRank[a.priority || 'medium'] != null ? priorityRank[a.priority || 'medium'] : 1;
    const bPri = priorityRank[b.priority || 'medium'] != null ? priorityRank[b.priority || 'medium'] : 1;
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
  const overdue = t.status === 'open' && !t.blocked && isOverdue(t.deadline);
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
    const canRemove = t.status === 'open' && canApproveHere && !a.submitted_at && !a.completed_at;
    const removeControl = canRemove ? `<span data-remove-assignee="${t.id}" data-username="${esc(a.username)}" title="Remove — they haven't submitted or been approved yet" style="cursor:pointer;font-weight:700;margin-left:4px;">✕</span>` : '';
    const badgeHtml = `<span class="badge ${cls}" title="${title}">${label}${removeControl}</span>`;

    // Hover-to-edit level, right on the badge itself — no need to open the full reshuffle
    // panel for a quick single change. Same authority and same rules as that panel: creator or
    // Admin only, task must be open, and someone already completed+approved can't be touched.
    const canEditLevel = t.status === 'open' && canForceClose && !(a.decision === 'approve' && a.completed_at);
    if (!canEditLevel) return `<span class="level-hover-wrap">${badgeHtml}</span>`;
    const key = `${t.id}::${a.username}`;
    let editUi = `<span class="level-hover-edit" data-act="show-level-edit" data-task-id="${t.id}" data-username="${esc(a.username)}" title="Change ${esc(a.username)}'s level">✎ L${a.stage}</span>`;
    if (ui.levelEditKey === key) {
      editUi = `<span class="level-edit-inline">
        <input type="number" min="1" step="1" id="level-edit-input-${t.id}-${esc(a.username)}" value="${a.stage}">
        <button class="btn btn-sm" data-act="request-level-edit" data-task-id="${t.id}" data-username="${esc(a.username)}">Save</button>
        <button class="btn btn-sm" data-act="cancel-level-edit">✕</button>
      </span>`;
    } else if (ui.levelEditConfirmKey === key) {
      editUi = `<span class="level-edit-confirm">
        <span class="small">Save changes: move ${esc(a.username)} to Level ${ui.levelEditConfirmValue}?</span>
        <button class="btn btn-sm btn-primary" data-act="confirm-level-edit" data-task-id="${t.id}" data-username="${esc(a.username)}">Save Changes</button>
        <button class="btn btn-sm" data-act="cancel-level-edit">Cancel</button>
      </span>`;
    }
    return `<span class="level-hover-wrap">${badgeHtml}${editUi}</span>`;
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
    <details class="card task-row" id="task-card-${esc(t.id)}">
      <summary class="task-row-summary">
        <span class="task-row-chevron" aria-hidden="true"></span>
        <span class="task-row-text">
          <span class="task-row-title"><b>${esc(t.title)}</b> <span class="mono small muted">${esc(t.id)}</span></span>
          <span class="task-row-meta">
            ${t.project ? `<span>📁 ${esc(t.project)}</span>` : ''}
            <span>${isCancelled ? `Cancelled by ${esc(t.cancelled_by || '—')} · ${fmtTime(t.cancelled_at)}` : `Closed by ${esc(t.closed_by || '—')} · ${fmtTime(t.closed_at)}`}</span>
          </span>
        </span>
        <span class="badge ${isCancelled ? 'flag' : 'received'} task-row-status">${isCancelled ? 'CANCELLED' : 'CLOSED'}</span>
      </summary>
      <div class="task-row-body">
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
        </div>` : ''}
        <div style="margin-top:8px;">
          ${ui.deleteTaskConfirmId === t.id ? `
            <span class="small" style="margin-right:8px;">Permanently delete this task${t.subtasks && t.subtasks.length > 0 ? ` and its ${t.subtasks.length} subtask(s)` : ''}? This cannot be undone.</span>
            <button class="btn btn-sm btn-danger" data-act="confirm-delete-task" data-task-id="${t.id}">Yes, Delete Permanently</button>
            <button class="btn btn-sm" data-act="cancel-delete-task">Cancel</button>
          ` : `<button class="btn btn-sm btn-danger" data-act="toggle-delete-task" data-task-id="${t.id}" title="Permanently removes the task — not a status change">Delete Task</button>`}
        </div>` : ''}
      </div>
    </details>`;
  }
  const pendingApproval = assignees.filter(a => a.submitted_at && !isApproved(a));
  const myTurn = !!(myRow && myRow.is_released && !myRow.submitted_at && !iAmDone && !t.blocked);
  const taggedSummary = assignees.length === 0 ? '<span class="row-flag row-flag-warn">Not tagged yet</span>'
    : `<span>${assignees.length} tagged${assignees.length > 1 ? ` · ${doneCount}/${assignees.length} approved` : ''}</span>`;
  return `
  <details class="card task-row" id="task-card-${esc(t.id)}">
    <summary class="task-row-summary">
      <span class="task-row-chevron" aria-hidden="true"></span>
      <span class="task-row-text">
        <span class="task-row-title"><b>${esc(t.title)}</b> <span class="mono small muted">${esc(t.id)}</span></span>
        <span class="task-row-meta">
          ${priorityBadgeHTML(t)}
          ${t.project ? `<span>📁 ${esc(t.project)}</span>` : ''}${t.phase ? `<span>${esc(t.phase)}</span>` : ''}
          ${t.deadline ? `<span>Due ${esc(fmtDate(t.deadline))}</span>` : ''}
          ${overdue ? '<span class="row-flag row-flag-bad">Overdue</span>' : ''}
          ${t.blocked ? '<span class="row-flag row-flag-warn">Blocked</span>' : ''}
          ${myTurn ? '<span class="row-flag row-flag-me">Your turn</span>' : ''}
          ${pendingApproval.length && canApproveHere ? `<span class="row-flag row-flag-me">${pendingApproval.length} to approve</span>` : ''}
          ${taggedSummary}
        </span>
      </span>
      <span class="badge po_pending task-row-status">OPEN</span>
    </summary>
    <div class="task-row-body">
    ${t.description ? `<div class="doc-note">${esc(t.description)}</div>` : ''}
    <div class="muted small" style="margin-top:6px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;">${taskSourceBadge(t)}<span>${fmtTime(t.created_at)}${t.deadline ? ` · Due ${fmtDate(t.deadline)}${overdue ? ' <span class="badge flag">OVERDUE</span>' : ''}` : ''}</span>${canApproveHere && ui.deadlineEditTaskId !== t.id ? `<button class="link-btn" data-act="toggle-deadline-edit" data-task-id="${t.id}" title="Change this task's deadline — everyone on it is told">${icon('pencil', 12)} Change deadline</button>` : ''}</div>
    ${canApproveHere && ui.deadlineEditTaskId === t.id ? `
    <div class="deadline-edit">
      <div class="row" style="align-items:flex-end;">
        <div class="col"><label>New deadline</label><input type="date" id="deadline-edit-date-${t.id}" value="${esc((t.deadline || '').slice(0, 10))}"></div>
        <div class="col"><label>Time (optional)</label><input type="time" id="deadline-edit-time-${t.id}" value="${esc(t.deadline && t.deadline.includes('T') ? t.deadline.slice(11, 16) : '')}"></div>
        <div class="col" style="flex:2;"><label>Reason (optional — shown to everyone on the task)</label><input type="text" id="deadline-edit-reason-${t.id}" placeholder="e.g. Slab cycle moved by 10 days"></div>
      </div>
      <div style="margin-top:6px;">
        <button class="btn btn-primary btn-sm" data-act="save-deadline-edit" data-task-id="${t.id}">Save deadline</button>
        <button class="btn btn-sm" data-act="cancel-deadline-edit" style="margin-left:6px;">Cancel</button>
      </div>
    </div>` : ''}
    ${t.blocked ? `<div class="notice" style="border-color:var(--amber);margin-top:8px;">${icon('alertTriangle', 13)} Blocked — waiting on a prerequisite task to close first.
      ${canForceClose ? (ui.deleteTaskConfirmId === t.id ? `
        <span class="small" style="margin-left:6px;">Permanently delete this task${t.subtasks && t.subtasks.length > 0 ? ` and its ${t.subtasks.length} subtask(s)` : ''}? This cannot be undone.</span>
        <button class="btn btn-sm btn-danger" data-act="confirm-delete-task" data-task-id="${t.id}">Yes, Delete Permanently</button>
        <button class="btn btn-sm" data-act="cancel-delete-task">Cancel</button>
      ` : `<button class="btn btn-sm btn-danger" style="margin-left:8px;" data-act="toggle-delete-task" data-task-id="${t.id}" title="Permanently removes the task — not a status change">Delete Task</button>`) : ''}
    </div>` : ''}
    ${lazyAttachmentHTML(t.has_attachment, t.attachment_name, `/api/tasks/${t.id}/attachment`, `task-attach-${t.id}`)}
    <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:6px;align-items:center;">
      ${assignees.length === 0 ? `<span class="badge flag" title="Nobody is working on this yet — no reminders go out until someone is tagged">Not tagged yet</span>` : groupedAssigneeBadgesHTML()}
      ${assignees.length > 1 ? `<span class="small muted">${doneCount}/${assignees.length} approved</span>` : ''}
      ${t.status === 'open' && canApproveHere ? `<button class="btn btn-sm${assignees.length === 0 ? ' btn-primary' : ''}" style="padding:2px 8px;font-size:11px;" data-act="toggle-add-assignee-form" data-task-id="${t.id}">${assignees.length === 0 ? '+ Tag People' : '+ Add Person'}</button>` : ''}
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
      ${ui.deleteTaskConfirmId === t.id ? `
        <span class="small" style="margin-left:6px;">Permanently delete this task${t.subtasks && t.subtasks.length > 0 ? ` and its ${t.subtasks.length} subtask(s)` : ''}? This cannot be undone.</span>
        <button class="btn btn-sm btn-danger" data-act="confirm-delete-task" data-task-id="${t.id}">Yes, Delete Permanently</button>
        <button class="btn btn-sm" data-act="cancel-delete-task">Cancel</button>
      ` : `<button class="btn btn-sm btn-danger" style="margin-top:8px;margin-left:6px;" data-act="toggle-delete-task" data-task-id="${t.id}" title="Permanently removes the task — not a status change">Delete Task</button>`}
      ${doneCount < assignees.length ? `<span class="small muted" style="margin-left:8px;">Waiting on ${assignees.filter(a => !isApproved(a)).map(a => esc(a.username)).join(', ')}</span>` : ''}
      <div style="margin-top:8px;">
        <a href="#" class="small" data-act="toggle-individual-deadlines" data-task-id="${t.id}">${ui.individualDeadlineFormTaskId === t.id ? 'Hide' : 'Set'} individual deadlines per person</a>
      </div>
      ${ui.individualDeadlineFormTaskId === t.id ? `
      <div class="card" style="background:var(--panel-2);margin-top:8px;padding:10px 14px;">
        <div class="small muted" style="margin-bottom:8px;">Overrides this person's deadline just for their own part — leave blank to use the task's overall deadline instead. Works the same for subtasks.</div>
        ${assignees.map(a => `
          <div class="row" style="align-items:flex-end;margin-bottom:6px;">
            <div class="col small" style="flex:0;min-width:100px;">${esc(a.username)}</div>
            <div class="col"><input type="datetime-local" id="individual-deadline-${t.id}-${esc(a.username)}" value="${a.individual_deadline ? esc(a.individual_deadline.slice(0, 16)) : ''}"></div>
            <div class="col" style="flex:0;"><button class="btn btn-sm" data-save-individual-deadline="${t.id}" data-username="${esc(a.username)}">Save</button></div>
          </div>`).join('')}
      </div>` : ''}
      ${assignees.length > 0 && new Set(assignees.map(a => a.stage)).size >= 1 ? `
      <div style="margin-top:8px;">
        <a href="#" class="small" data-act="toggle-reshuffle-levels" data-task-id="${t.id}">${ui.reshuffleLevelsFormTaskId === t.id ? 'Hide' : 'Reshuffle'} levels per person</a>
      </div>
      ${ui.reshuffleLevelsFormTaskId === t.id ? `
      <div class="card" style="background:var(--panel-2);margin-top:8px;padding:10px 14px;">
        <div class="small muted" style="margin-bottom:8px;">Moves someone to a different level — they're notified immediately, and released right away if the level below theirs is already fully approved (or if you move them to Level 1). Someone already completed and approved at their current level can't be reshuffled.</div>
        ${assignees.map(a => `
          <div class="row" style="align-items:flex-end;margin-bottom:6px;">
            <div class="col small" style="flex:0;min-width:100px;">${esc(a.username)} <span class="small muted">(L${a.stage})</span></div>
            <div class="col"><input type="number" min="1" step="1" id="reshuffle-level-${t.id}-${esc(a.username)}" placeholder="New level" ${a.decision === 'approve' && a.completed_at ? 'disabled title="Already completed and approved — cannot be reshuffled"' : ''}></div>
            <div class="col" style="flex:0;"><button class="btn btn-sm" data-save-reshuffle-level="${t.id}" data-username="${esc(a.username)}" ${a.decision === 'approve' && a.completed_at ? 'disabled' : ''}>Move</button></div>
          </div>`).join('')}
      </div>` : ''}` : ''}
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
    </div>
  </details>`;
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
      (t.assignees || []).some(a => (a.username || '').toLowerCase().includes(q) || personName(a.username).toLowerCase().includes(q))
    );
  }
  if (ui.taskFilterProject) filtered = filtered.filter(t => t.project === ui.taskFilterProject);
  if (ui.taskFilterPhase) filtered = filtered.filter(t => t.phase === ui.taskFilterPhase);
  if (ui.taskFilterTagging === 'untagged') filtered = filtered.filter(t => (t.assignees || []).length === 0);
  if (ui.taskFilterTagging === 'tagged') filtered = filtered.filter(t => (t.assignees || []).length > 0);
  return filtered;
}
// ---- "Person" filter (All Tasks): one person's tasks, user-id wise ----
function personName(username) {
  const u = (userDirectory || []).find(x => x.username === username);
  return u ? u.name : username;
}
function applyPersonFilter(tasks) {
  const who = ui.taskFilterPerson;
  if (!who) return tasks;
  const role = ui.taskFilterPersonRole || 'any';
  if (role === 'self' || role === 'byothers' || role === 'forothers') {
    return tasks.filter(t => taskOwnershipBuckets(t, who)[role]);
  }
  return tasks.filter(t => {
    const tagged = (t.assignees || []).some(a => a.username === who);
    const created = t.created_by_username === who;
    return role === 'tagged' ? tagged : role === 'created' ? created : (tagged || created);
  });
}
// ---- Ownership: who created a task vs. who it's for, from one person's point of view ----
//   self      — they created it and it's for them (they're tagged, or nobody is tagged yet)
//   byothers  — someone else created it and assigned it to them
//   forothers — they created it and assigned it to at least one other person
// A task they created tagging themselves AND others counts in both "self" and "forothers".
function taskOwnershipBuckets(t, who) {
  const tags = (t.assignees || []).map(a => a.username);
  const createdByWho = t.created_by_username === who;
  const whoTagged = tags.includes(who);
  const othersTagged = tags.some(u => u !== who);
  return {
    self: createdByWho && (whoTagged || tags.length === 0),
    byothers: !createdByWho && whoTagged,
    forothers: createdByWho && othersTagged,
  };
}
const OWNER_FILTERS = [
  { key: 'all', label: 'All my tasks' },
  { key: 'self', label: 'Self-assigned' },
  { key: 'byothers', label: 'Assigned to me' },
  { key: 'forothers', label: 'Assigned by me' },
];
function applyMyOwnerFilter(tasks) {
  const f = ui.myOwnerFilter || 'all';
  if (f === 'all') return tasks;
  const me = session.username;
  const p = ui.myOwnerPerson;
  return tasks.filter(t => {
    if (!taskOwnershipBuckets(t, me)[f]) return false;
    if (!p) return true;
    if (f === 'byothers') return t.created_by_username === p;
    if (f === 'forothers') return (t.assignees || []).some(a => a.username === p);
    return true;
  });
}
function myOwnerFilterHTML() {
  const me = session.username;
  const f = ui.myOwnerFilter || 'all';
  const isOpen = t => t.status === 'open';
  const counts = {};
  for (const o of OWNER_FILTERS) counts[o.key] = { open: 0, closed: 0 };
  for (const t of myTasks) {
    const b = taskOwnershipBuckets(t, me);
    const k = isOpen(t) ? 'open' : 'closed';
    counts.all[k]++;
    if (b.self) counts.self[k]++;
    if (b.byothers) counts.byothers[k]++;
    if (b.forothers) counts.forothers[k]++;
  }
  // "Who" picker: for tasks assigned to me → who assigned them; for tasks I assigned → to whom.
  let people = [];
  if (f === 'byothers') {
    people = Array.from(new Set(myTasks.filter(t => taskOwnershipBuckets(t, me).byothers).map(t => t.created_by_username).filter(Boolean)));
  } else if (f === 'forothers') {
    people = Array.from(new Set(myTasks.filter(t => taskOwnershipBuckets(t, me).forothers)
      .flatMap(t => (t.assignees || []).map(a => a.username)).filter(u => u && u !== me)));
  }
  people.sort((a, b) => personName(a).localeCompare(personName(b)));
  return `
    <div class="owner-filter" role="group" aria-label="Filter by who created the task">
      ${OWNER_FILTERS.map(o => `
        <button class="owner-chip${f === o.key ? ' active' : ''}" data-owner-filter="${o.key}" aria-pressed="${f === o.key}">
          <span class="owner-chip-label">${esc(o.label)}</span>
          <span class="owner-chip-counts"><span class="oc-open">${counts[o.key].open} open</span> · <span class="oc-closed">${counts[o.key].closed} closed</span></span>
        </button>`).join('')}
    </div>
    ${people.length > 0 ? `
    <div class="row task-filter-row" style="margin-bottom:10px;">
      <div class="col">
        <select id="my-owner-person-${f}" data-owner-person aria-label="${f === 'byothers' ? 'Assigned by' : 'Assigned to'}">
          <option value="">${f === 'byothers' ? '👤 Assigned by: anyone' : '👤 Assigned to: anyone'}</option>
          ${people.map(u => `<option value="${esc(u)}" ${ui.myOwnerPerson === u ? 'selected' : ''}>${esc(personName(u))} (${esc(u)})</option>`).join('')}
        </select>
      </div>
    </div>` : ''}`;
}
function personFilterHTML() {
  const people = (userDirectory || []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return `
    <div class="row task-filter-row person-filter-row" style="margin-bottom:10px;">
      <div class="col">
        <select id="task-filter-person" aria-label="Show one person's tasks">
          <option value="">👤 Everyone</option>
          ${people.map(u => `<option value="${esc(u.username)}" ${ui.taskFilterPerson === u.username ? 'selected' : ''}>${esc(u.name)} (${esc(u.username)})${u.team ? ' — ' + esc(u.team) : ''}</option>`).join('')}
        </select>
      </div>
      ${ui.taskFilterPerson ? `
      <div class="col">
        <select id="task-filter-person-role" aria-label="Which of their tasks">
          <option value="any" ${(ui.taskFilterPersonRole || 'any') === 'any' ? 'selected' : ''}>Tagged on or created by</option>
          <option value="tagged" ${ui.taskFilterPersonRole === 'tagged' ? 'selected' : ''}>Tagged on (their work)</option>
          <option value="created" ${ui.taskFilterPersonRole === 'created' ? 'selected' : ''}>Created by (they raised)</option>
          <option value="self" ${ui.taskFilterPersonRole === 'self' ? 'selected' : ''}>Self-assigned</option>
          <option value="byothers" ${ui.taskFilterPersonRole === 'byothers' ? 'selected' : ''}>Assigned to them</option>
          <option value="forothers" ${ui.taskFilterPersonRole === 'forothers' ? 'selected' : ''}>Assigned by them</option>
        </select>
      </div>` : ''}
    </div>`;
}
// Summary of the selected person's work, from the tasks they're tagged on.
function personSummaryHTML(tasks) {
  const who = ui.taskFilterPerson;
  if (!who) return '';
  const now = new Date();
  let toDo = 0, submitted = 0, partDone = 0, overdue = 0, closed = 0, cancelled = 0, onTime = 0, judged = 0;
  for (const t of tasks) {
    const row = (t.assignees || []).find(a => a.username === who);
    if (t.status === 'cancelled') { if (row) cancelled++; continue; }
    if (t.status !== 'open') {
      if (row) { closed++; if (t.deadline && row.completed_at) { judged++; if (new Date(row.completed_at) <= deadlineEnd(t.deadline)) onTime++; } }
      continue;
    }
    if (!row) continue;
    if (row.decision === 'approve' && row.completed_at) partDone++;
    else if (row.submitted_at) submitted++;
    else toDo++;
    const due = deadlineEnd(row.individual_deadline || t.deadline);
    if (due && due < now && !(row.decision === 'approve' && row.completed_at)) overdue++;
  }
  const createdOpen = tasks.filter(t => t.created_by_username === who && t.status === 'open').length;
  const chip = (label, n, cls) => `<div class="person-chip ${cls || ''}"><div class="person-chip-n">${n}</div><div class="person-chip-l">${label}</div></div>`;
  return `
    <div class="person-summary">
      <div class="person-summary-head"><b>${esc(personName(who))}</b> <span class="mono small muted">${esc(who)}</span>
        <button class="link-btn" data-act="clear-person-filter" style="margin-left:auto;">✕ Show everyone</button></div>
      <div class="person-chips">
        ${chip('To do', toDo)}${chip('Submitted, awaiting approval', submitted)}${chip('Their part done', partDone)}
        ${chip('Overdue', overdue, overdue ? 'bad' : '')}${chip('Closed', closed)}${cancelled ? chip('Cancelled', cancelled) : ''}
        ${judged ? chip('On time', Math.round(onTime / judged * 100) + '%', onTime / judged >= 0.8 ? 'good' : '') : ''}
        ${chip('Open tasks they raised', createdOpen)}
      </div>
    </div>`;
}
// End of a deadline in local time (date-only deadlines last the whole day).
function deadlineEnd(d) {
  if (!d) return null;
  const s = String(d);
  return new Date(s.includes('T') ? s : s + 'T23:59:59');
}
function searchBoxHTML() {
  // Project/Phase filters list only the values genuinely used by the tasks currently in view
  // (not the full company-wide list) — picking "Foundation" should never show as an option if
  // nothing in this list is actually tagged with it.
  const usedProjects = Array.from(new Set(myTasks.concat(session.role === 'admin' ? allTasks : []).map(t => t.project).filter(Boolean))).sort();
  const usedPhases = Array.from(new Set(myTasks.concat(session.role === 'admin' ? allTasks : []).map(t => t.phase).filter(Boolean))).sort();
  return `
    <input type="text" id="task-search-input" placeholder="Search by title, description, task ID, or tagged person..." value="${esc(ui.taskSearchQuery)}" style="margin-bottom:8px;">
    ${true ? `
    <div class="row task-filter-row" style="margin-bottom:12px;">
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
      <div class="col">
        <select id="task-filter-tagging">
          <option value="">Tagged or not</option>
          <option value="untagged" ${ui.taskFilterTagging === 'untagged' ? 'selected' : ''}>Not tagged yet</option>
          <option value="tagged" ${ui.taskFilterTagging === 'tagged' ? 'selected' : ''}>Tagged</option>
        </select>
      </div>
    </div>` : ''}
  `;
}
// History (closed/cancelled) lists are shown a page at a time — with hundreds of tasks
// accumulating over months, rendering every single one always would slow the page down for no
// benefit, since almost nobody scrolls back through all of it at once.
const HISTORY_PAGE_SIZE = 20;
const OPEN_PAGE_SIZE = 30;
function openPaginationControls(totalCount, shownCount, moreActionAttr) {
  if (shownCount >= totalCount) return '';
  return `<div class="flex-between" style="margin-top:8px;flex-wrap:wrap;gap:6px;"><span class="small muted">Showing ${shownCount} of ${totalCount} open — search or filter above to narrow down.</span><button class="btn btn-sm" ${moreActionAttr}>Show ${Math.min(OPEN_PAGE_SIZE, totalCount - shownCount)} more</button></div>`;
}
function historyPaginationControls(totalCount, shownCount, moreActionAttr) {
  if (totalCount <= shownCount) return '';
  return `<button class="btn btn-sm" style="margin-top:8px;" ${moreActionAttr}>Show ${Math.min(HISTORY_PAGE_SIZE, totalCount - shownCount)} more (${totalCount - shownCount} remaining)</button>`;
}
// One card with tabs instead of separate stacked sections: Open | Your part done | Closed. Every
// task is a compact row (title, status, deadline, flags) that expands on tap — open and closed
// look and behave the same way.
function taskTabsHTML(tabs, active, attr) {
  return `<div class="task-tabs" role="tablist">${tabs.filter(t => t.show !== false).map(t => `
    <button class="task-tab${active === t.key ? ' active' : ''}" role="tab" aria-selected="${active === t.key}" ${attr}="${t.key}">
      ${esc(t.label)} <span class="task-tab-count">${t.count}</span></button>`).join('')}</div>`;
}
function renderMyTasksCard() {
  const ownedTasks = applyMyOwnerFilter(myTasks);
  const openAll = sortTasksForDisplay(applyTaskSearch(ownedTasks.filter(t => t.status === 'open')));
  // "My part is done, task is still waiting on someone else" reads very differently from "I still
  // have something to do" — it gets its own tab so your finished work actually feels finished.
  const myPartDone = t => {
    const myRow = (t.assignees || []).find(a => a.username === session.username);
    return !!(myRow && myRow.decision === 'approve' && myRow.completed_at);
  };
  const needsMe = openAll.filter(t => !myPartDone(t));
  const waitingOnOthers = openAll.filter(t => myPartDone(t));
  const closedAll = applyTaskSearch(ownedTasks.filter(t => t.status !== 'open'));
  let tab = ui.myTasksTab || 'open';
  if (tab === 'waiting' && waitingOnOthers.length === 0) tab = 'open';
  const list = tab === 'closed' ? closedAll : tab === 'waiting' ? waitingOnOthers : needsMe;
  const pageKey = tab === 'closed' ? 'myHistoryShown' : 'myOpenShown';
  const pageSize = tab === 'closed' ? HISTORY_PAGE_SIZE : OPEN_PAGE_SIZE;
  const shown = list.slice(0, ui[pageKey] || pageSize);
  const emptyText = myTasks.length === 0 ? 'No tasks yet.'
    : ui.taskSearchQuery || ui.taskFilterProject || ui.taskFilterPhase || ui.taskFilterTagging || (ui.myOwnerFilter && ui.myOwnerFilter !== 'all') ? 'No tasks here match your search or filters.'
    : tab === 'closed' ? 'Nothing closed yet.' : tab === 'waiting' ? 'Nothing waiting on others.' : 'Nothing open right now. 🎉';
  return `
  <div class="card">
    <div class="flex-between">
      <div class="card-title" style="margin:0;">My Tasks</div>
      ${needsMe.length > 0 ? `<span class="badge flag">${needsMe.length} open</span>` : ''}
    </div>
    ${myOwnerFilterHTML()}
    ${searchBoxHTML()}
    ${taskTabsHTML([
      { key: 'open', label: 'Open', count: needsMe.length },
      { key: 'waiting', label: 'Your part done', count: waitingOnOthers.length, show: waitingOnOthers.length > 0 },
      { key: 'closed', label: 'Closed', count: closedAll.length },
    ], tab, 'data-my-tab')}
    ${tab === 'waiting' ? '<p class="small muted" style="margin:0 0 8px;">Your part is approved — these are only waiting on someone else to finish theirs.</p>' : ''}
    <div class="task-list">
      ${shown.length === 0 ? `<div class="empty">${emptyText}</div>` : shown.map(t => renderTaskItem(t)).join('')}
    </div>
    ${tab === 'closed'
      ? historyPaginationControls(list.length, shown.length, 'data-act="show-more-my-history"')
      : openPaginationControls(list.length, shown.length, 'data-act="show-more-my-open"')}
  </div>`;
}
function renderAllTasksCard() {
  const personTasks = applyPersonFilter(allTasks);
  const open = sortTasksForDisplay(applyTaskSearch(personTasks.filter(t => t.status === 'open')));
  const closedAll = applyTaskSearch(personTasks.filter(t => t.status !== 'open'));
  const tab = ui.allTasksTab || 'open';
  const list = tab === 'closed' ? closedAll : open;
  const pageKey = tab === 'closed' ? 'allHistoryShown' : 'allOpenShown';
  const shown = list.slice(0, ui[pageKey] || (tab === 'closed' ? HISTORY_PAGE_SIZE : OPEN_PAGE_SIZE));
  const filtered = ui.taskSearchQuery || ui.taskFilterProject || ui.taskFilterPhase || ui.taskFilterTagging || ui.taskFilterPerson;
  return `
  <div class="notice">Every task in the company — tagged people submit their part for approval; only whoever created the task (or Admin) can approve, reject, cancel, or force-close it.</div>
  <div class="card">
    <div class="card-title" style="margin-bottom:6px;">All Tasks</div>
    ${personFilterHTML()}
    ${personSummaryHTML(applyPersonFilter(allTasks))}
    ${searchBoxHTML()}
    ${taskTabsHTML([
      { key: 'open', label: 'Open', count: open.length },
      { key: 'closed', label: 'Closed / Cancelled', count: closedAll.length },
    ], tab, 'data-all-tab')}
    <div class="task-list">
      ${shown.length === 0 ? `<div class="empty">${filtered ? 'No tasks here match your search or filters.' : tab === 'closed' ? 'Nothing closed yet.' : 'Nothing open.'}</div>` : shown.map(t => renderTaskItem(t)).join('')}
    </div>
    ${tab === 'closed'
      ? historyPaginationControls(list.length, shown.length, 'data-act="show-more-all-history"')
      : openPaginationControls(list.length, shown.length, 'data-act="show-more-all-open"')}
  </div>`;
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
      <label>Tag People (optional — you can leave this empty and tag people later) — split into Levels if some people should wait on others</label>
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
  const submitTaskBtn = document.querySelector('[data-act="submit-task"]');
  if (submitTaskBtn) submitTaskBtn.onclick = async () => {
    const titleEl = document.getElementById('new-task-title');
    const deadlineEl = document.getElementById('new-task-deadline');
    if (!titleEl || !deadlineEl) { setBanner('Something went wrong finding the form fields — try closing and reopening the New Task form.'); render(); return; }
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
    // Tagging people is optional — the task can be created now and people tagged later.
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
  const cancelTaskFormBtn = document.querySelector('[data-act="cancel-task-form"]');
  if (cancelTaskFormBtn) cancelTaskFormBtn.onclick = () => {
    ui.taskFormOpen = false; ui.taskFormTags = []; ui.taskFormStages = [{ usernames: [] }]; ui.taskFormAutoRelease = false;
    ui.pendingTaskFile = null; ui.pendingTaskFileName = null; render();
  };
  const newTaskFileInput = document.getElementById('new-task-file');
  if (newTaskFileInput) newTaskFileInput.onchange = (ev) => {
    const f = ev.target.files[0]; if (!f) return;
    readAnyFile(f, dataUrl => {
      ui.pendingTaskFile = dataUrl; ui.pendingTaskFileName = f.name;
      document.getElementById('new-task-file-preview').innerHTML = dataUrl ? `<div class="small muted">Attached: ${esc(f.name)}</div>` : '<div class="err">Could not read file (too large?).</div>';
    });
  };
}
/* ==================== BULK IMPORT (CSV / Excel) ====================
   Step 1: pick a file → the server reads it and returns a preview of every row (who got tagged,
   what was understood, what's wrong). Step 2: press Import → all valid rows become real tasks in
   one go. Nothing is created until step 2. */
function importPanelHTML() {
  if (!ui.importOpen) return '';
  const p = ui.importPreview;
  const r = ui.importResult;
  const templateLinks = `<span class="small muted">Need the layout?</span>
    <button class="btn btn-sm" data-import-template="xlsx">Excel template</button>
    <button class="btn btn-sm" data-import-template="csv">CSV template</button>`;
  if (r) {
    return `
    <div class="card import-panel">
      <div class="import-result-head">
        <div class="import-result-count">${r.created.length}</div>
        <div><b>task${r.created.length === 1 ? '' : 's'} created</b> from ${esc(ui.importFileName || 'your file')}
          ${(r.updated || []).length ? `<div class="small"><b>${r.updated.length}</b> deadline${r.updated.length === 1 ? '' : 's'} changed on tasks imported before — everyone on them has been told.</div>` : ''}
          ${r.unchangedCount ? `<div class="small muted">${r.unchangedCount} row${r.unchangedCount === 1 ? ' was' : 's were'} already imported with the same deadline — left as they are.</div>` : ''}
          ${r.skipped.length ? `<div class="small muted">${r.skipped.length} row${r.skipped.length === 1 ? ' was' : 's were'} skipped because of problems — listed below.</div>` : ''}
        </div>
      </div>
      ${(r.updated || []).length ? `<details class="import-skipped" style="margin-top:10px;"><summary class="small">See the deadline changes</summary>${r.updated.slice(0, 300).map(u => `<div><span class="mono small">${esc(u.id)}</span> ${esc(u.title)} — ${esc(fmtDate(u.from))} → <b>${esc(fmtDate(u.to))}</b></div>`).join('')}${r.updated.length > 300 ? `<div class="small muted">…and ${r.updated.length - 300} more (all recorded in the audit log)</div>` : ''}</details>` : ''}
      ${r.skipped.length ? `<div class="import-skipped">${r.skipped.map(x => `<div><span class="mono small">Row ${x.rowNumber}</span> ${esc(x.title || '(no title)')} — <span class="err-inline">${esc(x.errors.join(' '))}</span></div>`).join('')}</div>` : ''}
      <div style="margin-top:12px;">
        <button class="btn btn-primary btn-sm" data-act="import-another">Import another file</button>
        <button class="btn btn-sm" data-act="close-import-panel" style="margin-left:6px;">Done</button>
      </div>
    </div>`;
  }
  const dropzone = `
    <label class="import-drop" for="import-file-input">
      <input type="file" id="import-file-input" accept=".csv,.xlsx,.xlsm,.txt,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" style="display:none;">
      <div class="import-drop-icon">${icon('upload', 22)}</div>
      <div><b>${ui.importBusy && !p ? 'Reading ' + esc(ui.importFileName || 'file') + '…' : ui.importFileName ? 'Choose a different file' : 'Choose a CSV or Excel file'}</b></div>
      <div class="small muted">One task per row. Columns like Title, Deadline and Assigned To are recognised automatically — extra columns are ignored.</div>
    </label>`;
  if (!p) {
    return `
    <div class="card import-panel">
      <div class="flex-between" style="flex-wrap:wrap;gap:8px;margin-bottom:10px;">
        <div class="card-title" style="margin:0;">Import tasks</div>
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">${templateLinks}</div>
      </div>
      ${dropzone}
      ${ui.importError ? `<div class="err">${esc(ui.importError)}</div>` : ''}
      <details class="import-help"><summary class="small">What can the file contain?</summary>
        <div class="small muted" style="margin-top:6px;line-height:1.6;">
          <b>Required:</b> Title and Deadline (DD/MM/YYYY — day first — or YYYY-MM-DD).<br>
          <b>Assignees</b> are optional — leave blank to create tasks untagged and tag people later. They can be usernames, full names, emails, or a department name (tags everyone in it), separated by commas.<br>
          <b>Task Key</b> (optional) is a permanent ID per row. Upload the file again later and rows already imported just get their deadline updated — no duplicates.<br>
          Columns whose heading starts with <b>Info:</b> are kept for reference and ignored.<br>
          <b>Optional:</b> Description, Priority (High/Medium/Low), Deadline Time, Level 2 / Level 3 (people who wait for the level before them), Auto Release (Yes/No), Follow Up, Project, Phase, Checklist (items separated by |), Depends On and Parent Task (another row's Sr No, its title, or an existing task ID), Individual Deadlines ("rohit.k: 12/10/2026").<br>
          The Excel template has a <b>People</b> sheet listing everyone's exact username.
        </div>
      </details>
      <div style="margin-top:10px;"><button class="btn btn-sm" data-act="close-import-panel">Cancel</button></div>
    </div>`;
  }
  // Warnings shared by many rows (e.g. "No one tagged yet" on a whole untagged schedule) are
  // shown once above the table instead of repeated on every row.
  const warnFreq = {};
  p.rows.forEach(x => x.warnings.forEach(w => { warnFreq[w] = (warnFreq[w] || 0) + 1; }));
  const commonWarnings = Object.entries(warnFreq).filter(([, n]) => n > 20).map(([w]) => w);
  const rowWarnings = x => x.warnings.filter(w => !commonWarnings.includes(w));
  const view = ui.importView || 'all';
  const inView = x => view === 'errors' ? x.errors.length > 0
    : view === 'changes' ? (!x.errors.length && x.action === 'update')
    : view === 'new' ? (!x.errors.length && x.action === 'create')
    : view === 'warnings' ? (x.errors.length > 0 || rowWarnings(x).length > 0) : true;
  const filtered = p.rows.filter(inView);
  const MAX_ROWS_SHOWN = 200;
  const rows = filtered.slice(0, MAX_ROWS_SHOWN);
  const warnRowCount = p.rows.filter(x => x.errors.length || rowWarnings(x).length).length;
  const peopleCell = x => x.levels.length === 0 ? '<span class="muted">Not tagged</span>' : x.levels.map((g, i) =>
    `<div>${x.levels.length > 1 ? `<span class="import-level">L${i + 1}</span>` : ''}${g.map(esc).join(', ')}</div>`).join('');
  const extras = x => [
    x.project ? `Project: ${esc(x.project)}${x.phase ? ' · ' + esc(x.phase) : ''}` : (x.phase ? `Phase: ${esc(x.phase)}` : ''),
    x.checklist.length ? `${x.checklist.length} checklist item${x.checklist.length === 1 ? '' : 's'}` : '',
    x.followups.length ? `Follow-up: ${x.followups.map(esc).join(', ')}` : '',
    x.dependsOn ? `Waits for: ${esc(x.dependsOn)}` : '',
    x.parent ? `Subtask of: ${esc(x.parent)}` : '',
    x.individualDeadlines.length ? `Own deadlines: ${x.individualDeadlines.map(esc).join('; ')}` : '',
    x.autoReleaseStages ? 'Auto-release levels' : '',
    x.taskKey ? `<span class="mono">${esc(x.taskKey)}</span>` : '',
  ].filter(Boolean).map(e => `<div>${e}</div>`).join('');
  const statusCell = x => {
    if (x.errors.length) return x.errors.map(e => `<div class="err-inline">✕ ${esc(e)}</div>`).join('');
    const main = x.action === 'update' ? `<div class="change-inline">↻ Deadline change<div class="small">${esc(fmtDate(x.existing.deadline))} → <b>${esc(fmtDate(x.deadline))}</b></div><div class="small muted mono">${esc(x.existing.id)}</div></div>`
      : x.action === 'unchanged' ? (x.existing.keptAppChange ? `<div class="muted">= Row unchanged since last upload</div><div class="small">Deadline was changed in the app to <b>${esc(fmtDate(x.existing.deadline))}</b> — kept</div>` : `<div class="muted">= Already imported, no change</div>`)
      : x.action === 'closed' ? `<div class="muted">Already ${esc(x.existing.status)} — left alone</div>`
      : '<div class="ok-inline">+ New task</div>';
    return main + rowWarnings(x).map(w => `<div class="warn-inline">! ${esc(w)}</div>`).join('');
  };
  const willDo = p.createCount + p.updateCount;
  const canImport = willDo > 0 && !ui.importBusy;
  const actionLabel = [p.createCount ? `create ${p.createCount} task${p.createCount === 1 ? '' : 's'}` : '', p.updateCount ? `change ${p.updateCount} deadline${p.updateCount === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ');
  const viewBtn = (key, label, n) => n === 0 && key !== 'all' ? '' : `<button class="import-view-btn${view === key ? ' active' : ''}" data-import-view="${key}">${label} <span class="mono">${n}</span></button>`;
  return `
    <div class="card import-panel">
      <div class="flex-between" style="flex-wrap:wrap;gap:8px;">
        <div>
          <div class="card-title" style="margin:0;">Review before importing</div>
          <div class="small muted">${esc(ui.importFileName)} · ${p.totalRows} row${p.totalRows === 1 ? '' : 's'}</div>
        </div>
        <div class="import-tally">
          ${p.createCount ? `<span class="import-tally-ok">${p.createCount} new</span>` : ''}
          ${p.updateCount ? `<span class="import-tally-change">${p.updateCount} deadline change${p.updateCount === 1 ? '' : 's'}</span>` : ''}
          ${p.unchangedCount ? `<span class="import-tally-same">${p.unchangedCount} unchanged</span>` : ''}
          ${p.closedCount ? `<span class="import-tally-same">${p.closedCount} already closed</span>` : ''}
          ${p.errorCount ? `<span class="import-tally-bad">${p.errorCount} with problems</span>` : ''}
        </div>
      </div>
      ${p.skippedByImportColumn ? `<div class="notice small" style="margin-top:10px;">${p.skippedByImportColumn} row${p.skippedByImportColumn === 1 ? '' : 's'} with Import = No ${p.skippedByImportColumn === 1 ? 'is' : 'are'} left out for now.</div>` : ''}
      ${commonWarnings.map(w => `<div class="notice small" style="margin-top:10px;">${warnFreq[w]} row${warnFreq[w] === 1 ? '' : 's'}: ${esc(w)}</div>`).join('')}
      ${p.unknownColumns.length ? `<div class="notice small" style="margin-top:10px;">Ignored column${p.unknownColumns.length === 1 ? '' : 's'}: ${p.unknownColumns.map(esc).join(', ')}. Rename a column to match the template if it should be used.</div>` : ''}
      ${p.duplicateColumns.length ? `<div class="notice small" style="margin-top:10px;">These columns repeat one that's already used and were ignored: ${p.duplicateColumns.map(esc).join(', ')}.</div>` : ''}
      <div class="import-views">
        ${viewBtn('all', 'All rows', p.totalRows)}${viewBtn('new', 'New', p.createCount)}${viewBtn('changes', 'Deadline changes', p.updateCount)}${viewBtn('warnings', 'Problems & warnings', warnRowCount)}${viewBtn('errors', 'Can\'t import', p.errorCount)}
      </div>
      <div class="import-table-wrap">
        <table class="import-table">
          <tr><th>Row</th><th>Task</th><th>Deadline</th><th>Tagged</th><th>Also</th><th>What will happen</th></tr>
          ${rows.map(x => `
          <tr class="${x.errors.length ? 'import-row-bad' : x.action === 'update' ? 'import-row-change' : rowWarnings(x).length ? 'import-row-warn' : (x.action === 'unchanged' || x.action === 'closed') ? 'import-row-same' : ''}">
            <td class="mono small">${x.rowNumber}${x.ref ? `<div class="muted">#${esc(x.ref)}</div>` : ''}</td>
            <td><b>${esc(x.title || '(no title)')}</b> <span class="badge priority-${x.priority}">${x.priority}</span>${x.description ? `<div class="small muted import-desc">${esc(x.description)}</div>` : ''}</td>
            <td class="small" style="white-space:nowrap;">${x.deadline ? esc(fmtDate(x.deadline)) : '<span class="muted">—</span>'}</td>
            <td class="small">${peopleCell(x)}</td>
            <td class="small muted">${extras(x) || '—'}</td>
            <td class="small">${statusCell(x)}</td>
          </tr>`).join('')}
        </table>
      </div>
      ${filtered.length > MAX_ROWS_SHOWN ? `<div class="small muted" style="margin-top:6px;">Showing the first ${MAX_ROWS_SHOWN} of ${filtered.length} rows in this view — all ${filtered.length} are included when you import. Use the buttons above to look at just the rows that need attention.</div>` : ''}
      ${ui.importError ? `<div class="err">${esc(ui.importError)}</div>` : ''}
      <div class="import-actions">
        ${willDo === 0 ? `<button class="btn btn-primary btn-sm" disabled>Nothing to change — everything is already imported</button>`
          : `<button class="btn btn-primary btn-sm" data-act="run-import" ${p.errorCount ? 'data-skip-invalid="1"' : ''} ${canImport ? '' : 'disabled'}>${ui.importBusy ? 'Working…' : `${actionLabel.charAt(0).toUpperCase() + actionLabel.slice(1)}${p.errorCount ? `, skip ${p.errorCount} with problems` : ''}`}</button>`}
        <label class="btn btn-sm" for="import-file-input" style="margin:0;">${p.errorCount ? 'Fixed it — re-upload' : 'Choose a different file'}
          <input type="file" id="import-file-input" accept=".csv,.xlsx,.xlsm,.txt" style="display:none;">
        </label>
        <button class="btn btn-sm" data-act="close-import-panel">Cancel</button>
      </div>
    </div>`;
}
function resetImportState() {
  Object.assign(ui, { importFileName: null, importFileData: null, importPreview: null, importBusy: false, importResult: null, importOnlyProblems: false, importError: null, importView: 'all' });
}
function downloadDataUrl(dataUrl, name) {
  // Inside the Android app the WebView can't save files itself — hand them to the app, which saves
  // to the phone's Downloads folder and opens them.
  if (window.AndroidBridge && window.AndroidBridge.saveFile) { window.AndroidBridge.saveFile(dataUrl, name || 'download'); return; }
  const a = document.createElement('a');
  a.href = dataUrl; a.download = name; document.body.appendChild(a); a.click(); a.remove();
}
function bindImportPanel() {
  const toggle = document.querySelector('[data-act="toggle-import-panel"]');
  if (toggle) toggle.onclick = () => { ui.importOpen = !ui.importOpen; if (!ui.importOpen) resetImportState(); render(); };
  if (!ui.importOpen) return;
  document.querySelectorAll('[data-act="close-import-panel"]').forEach(b => b.onclick = () => { ui.importOpen = false; resetImportState(); render(); });
  const again = document.querySelector('[data-act="import-another"]');
  if (again) again.onclick = () => { resetImportState(); render(); };
  document.querySelectorAll('[data-import-template]').forEach(b => b.onclick = async () => {
    try { const t = await api(`/api/tasks/import/template?format=${b.dataset.importTemplate}`); downloadDataUrl(t.data, t.name); }
    catch (e) { setBanner(e.message); render(); }
  });
  document.querySelectorAll('[data-import-view]').forEach(b => b.onclick = () => { ui.importView = b.dataset.importView; render(); });
  const fileInput = document.getElementById('import-file-input');
  if (fileInput) fileInput.onchange = (ev) => {
    const f = ev.target.files[0]; if (!f) return;
    if (f.size > 10 * 1024 * 1024) { ui.importError = 'That file is larger than 10MB — split it into smaller files.'; render(); return; }
    const reader = new FileReader();
    reader.onerror = () => { ui.importError = 'Could not read that file.'; render(); };
    reader.onload = async (e) => {
      Object.assign(ui, { importFileName: f.name, importFileData: e.target.result, importPreview: null, importError: null, importBusy: true, importView: 'all' });
      render();
      try {
        ui.importPreview = await api('/api/tasks/import/preview', { method: 'POST', body: JSON.stringify({ fileData: ui.importFileData, fileName: f.name }) });
      } catch (err) { ui.importError = err.message; ui.importPreview = null; }
      ui.importBusy = false;
      render();
    };
    reader.readAsDataURL(f);
  };
  const run = document.querySelector('[data-act="run-import"]');
  if (run) run.onclick = async () => {
    if (ui.importBusy) return;
    ui.importBusy = true; ui.importError = null; render();
    try {
      const result = await api('/api/tasks/import', { method: 'POST', body: JSON.stringify({ fileData: ui.importFileData, fileName: ui.importFileName, skipInvalid: !!run.dataset.skipInvalid }) });
      ui.importResult = result; ui.importPreview = null; ui.importFileData = null; ui.importBusy = false;
      celebrate(result.created.length ? `${result.created.length} task${result.created.length === 1 ? '' : 's'} imported.` : `${result.updated.length} deadline${result.updated.length === 1 ? '' : 's'} updated.`, RAISE_MESSAGES);
      await refreshData();
    } catch (err) { ui.importBusy = false; ui.importError = err.message; render(); }
  };
}
/* ==================== EXPORT & ARCHIVE (Admin) ==================== */
function localISODate(d) { const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }
function lastMonthRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 1, 1), end = new Date(now.getFullYear(), now.getMonth(), 0);
  return { from: localISODate(start), to: localISODate(end), label: start.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) };
}
function renderExportsView() {
  const lm = lastMonthRange();
  if (!ui.exp) ui.exp = { mode: 'completed', from: '', to: localISODate(new Date()), project: '', archiveBefore: lm.to, archivePreview: null, downloadedHistory: false, busy: null, schedules: null };
  const e = ui.exp;
  const projects = Array.from(new Set((allTasks || []).map(t => t.project).filter(Boolean))).sort();
  const sched = e.schedules;
  return `
  <div class="notice">Download the full history of tasks with every timestamp, get your schedule spreadsheet back with each row's status filled in, and clear finished work off the site. Nothing here changes open tasks.</div>

  <div class="card">
    <div class="card-title">1 · Your schedule spreadsheets, with timestamps</div>
    <p class="small muted">Every file you import is saved here. Download it any time and you get the same spreadsheet back with each row's Status, Task ID, Started, Submitted, Approved, Completed At, Closed By, Days Taken and On time / late filled in — always up to date, including tasks already removed from the site.</p>
    ${sched === null ? '<div class="empty">Loading…</div>' : sched.length === 0 ? '<div class="empty">No schedules yet — import one from My Tasks → Import from CSV / Excel.</div>' : `
    <div class="export-list">
      ${sched.map(f => `
      <div class="export-row">
        <div><b>${esc(f.file_name)}</b><div class="small muted">Last uploaded ${fmtTime(f.uploaded_at)} by ${esc(f.uploaded_by || '—')}</div></div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          <button class="btn btn-primary btn-sm" data-sched-download="${f.id}" ${e.busy ? 'disabled' : ''}>${e.busy === 'sched-' + f.id ? 'Preparing…' : `${icon('upload', 13)} Download with timestamps`}</button>
          <button class="btn btn-sm" data-sched-remove="${f.id}" title="Forget this saved copy (tasks are not affected)">Remove</button>
        </div>
      </div>`).join('')}
    </div>`}
    <div class="small" style="margin-top:12px;">Have a different copy on your computer?
      <label class="link-btn" for="sched-fill-input" style="display:inline-flex;">Fill timestamps into a file I choose
        <input type="file" id="sched-fill-input" accept=".xlsx,.xlsm" style="display:none;"></label>
    </div>
  </div>

  <div class="card">
    <div class="card-title">2 · Task history export</div>
    <div class="export-quick">
      <button class="import-view-btn" data-exp-quick="start">From the start to today</button>
      <button class="import-view-btn" data-exp-quick="lastmonth">${esc(lm.label)}</button>
      <button class="import-view-btn" data-exp-quick="thismonth">This month so far</button>
    </div>
    <div class="row" style="align-items:flex-end;margin-top:10px;">
      <div class="col"><label>Which tasks</label>
        <select id="exp-mode"><option value="completed" ${e.mode === 'completed' ? 'selected' : ''}>Completed or cancelled in this period</option><option value="all" ${e.mode === 'all' ? 'selected' : ''}>Everything created in this period (incl. open)</option></select></div>
      <div class="col"><label>From (blank = the start)</label><input type="date" id="exp-from" value="${esc(e.from)}"></div>
      <div class="col"><label>To</label><input type="date" id="exp-to" value="${esc(e.to)}"></div>
      <div class="col"><label>Project</label><select id="exp-project"><option value="">All projects</option>${projects.map(p => `<option value="${esc(p)}" ${e.project === p ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select></div>
    </div>
    <button class="btn btn-primary btn-sm" style="margin-top:10px;" data-act="exp-download" ${e.busy ? 'disabled' : ''}>${e.busy === 'history' ? 'Preparing…' : 'Download history (.xlsx)'}</button>
    <span class="small muted" style="margin-left:8px;">One row per task: created, deadline, tagged people, started, submitted, approved, completed, who closed it, days taken, on time / late, each person's timeline and the comment thread.</span>
  </div>

  <div class="card">
    <div class="card-title">3 · Remove finished tasks from the site</div>
    <p class="small muted">Completed and cancelled tasks finished on or before the date below disappear from every task screen, and their attachments, comments and checklists are deleted to free space. A summary of each stays behind, so the history export and the spreadsheet timestamps still include them, performance and leaderboards don't change, and uploading the schedule again never re-creates them. Open tasks — and finished tasks that still have an open subtask — are never touched.</p>
    <div class="row" style="align-items:flex-end;">
      <div class="col" style="max-width:240px;"><label>Finished on or before</label><input type="date" id="arch-before" value="${esc(e.archiveBefore)}"></div>
      <div class="col" style="flex:0;"><button class="btn btn-sm" data-act="arch-preview">Check how many</button></div>
    </div>
    ${e.archivePreview ? `
    <div class="archive-box">
      ${e.archivePreview.count === 0 ? `<div>Nothing to remove — no finished tasks on or before ${esc(fmtDate(e.archiveBefore))} are still on the site.${e.archivePreview.alreadyArchived ? ` (${e.archivePreview.alreadyArchived} removed earlier.)` : ''}</div>` : `
      <div><b>${e.archivePreview.count}</b> finished task${e.archivePreview.count === 1 ? '' : 's'} will be removed from the site.</div>
      <label class="small" style="display:flex;gap:6px;align-items:center;margin:8px 0;font-weight:400;"><input type="checkbox" id="arch-confirm" style="width:auto;" ${e.downloadedHistory ? 'checked' : ''}> I've downloaded the history / schedule I need (attachments and comment files can't be recovered).</label>
      <button class="btn btn-danger btn-sm" data-act="arch-run" ${e.downloadedHistory && !e.busy ? '' : 'disabled'}>${e.busy === 'archive' ? 'Removing…' : `Remove ${e.archivePreview.count} task${e.archivePreview.count === 1 ? '' : 's'} from the site`}</button>`}
    </div>` : ''}
  </div>`;
}
async function loadSchedules() {
  try { ui.exp.schedules = await api('/api/schedules'); } catch (err) { ui.exp.schedules = []; setBanner(err.message); }
  render();
}
function bindExportsView() {
  const e = ui.exp; if (!e) return;
  if (e.schedules === null && !e.loadingSchedules) { e.loadingSchedules = true; loadSchedules().then(() => { e.loadingSchedules = false; }); }
  const busy = async (key, fn) => { if (e.busy) return; e.busy = key; render(); try { await fn(); } catch (err) { setBanner(err.message); } e.busy = null; render(); };
  document.querySelectorAll('[data-sched-download]').forEach(b => b.onclick = () => busy('sched-' + b.dataset.schedDownload, async () => {
    const r = await api(`/api/schedules/${b.dataset.schedDownload}/download`);
    downloadDataUrl(r.data, r.name);
    setBanner(`Downloaded — ${r.stats.completed} completed, ${r.stats.open} open, ${r.stats.cancelled} cancelled, ${r.stats.notImported} not imported yet.`, 'ok');
  }));
  document.querySelectorAll('[data-sched-remove]').forEach(b => b.onclick = async () => {
    if (!confirm('Forget this saved schedule? Your tasks are not affected — you can import the file again any time.')) return;
    try { await api(`/api/schedules/${b.dataset.schedRemove}`, { method: 'DELETE' }); await loadSchedules(); } catch (err) { setBanner(err.message); render(); }
  });
  const fillInput = document.getElementById('sched-fill-input');
  if (fillInput) fillInput.onchange = (ev) => {
    const f = ev.target.files[0]; if (!f) return;
    const reader = new FileReader();
    reader.onload = () => busy('fill', async () => {
      const r = await api('/api/schedules/fill', { method: 'POST', body: JSON.stringify({ fileData: reader.result, fileName: f.name }) });
      downloadDataUrl(r.data, r.name);
      setBanner(`Timestamps filled for ${r.stats.matched} of ${r.stats.rows} rows.`, 'ok');
    });
    reader.readAsDataURL(f);
  };
  const v = id => (document.getElementById(id) || {}).value;
  const syncHistory = () => { e.mode = v('exp-mode'); e.from = v('exp-from'); e.to = v('exp-to'); e.project = v('exp-project'); };
  ['exp-mode', 'exp-from', 'exp-to', 'exp-project'].forEach(id => { const el = document.getElementById(id); if (el) el.onchange = syncHistory; });
  document.querySelectorAll('[data-exp-quick]').forEach(b => b.onclick = () => {
    const now = new Date();
    if (b.dataset.expQuick === 'start') { e.from = ''; e.to = localISODate(now); }
    if (b.dataset.expQuick === 'lastmonth') { const lm = lastMonthRange(); e.from = lm.from; e.to = lm.to; }
    if (b.dataset.expQuick === 'thismonth') { e.from = localISODate(new Date(now.getFullYear(), now.getMonth(), 1)); e.to = localISODate(now); }
    render();
  });
  const dl = document.querySelector('[data-act="exp-download"]');
  if (dl) dl.onclick = () => { syncHistory(); busy('history', async () => {
    const q = new URLSearchParams({ mode: e.mode, to: e.to || '' }); if (e.from) q.set('from', e.from); if (e.project) q.set('project', e.project);
    const r = await api(`/api/tasks/history-export?${q}`);
    downloadDataUrl(r.data, r.name);
    e.downloadedHistory = true;
    setBanner(`History downloaded — ${r.count} task${r.count === 1 ? '' : 's'}.`, 'ok');
  }); };
  const archBefore = document.getElementById('arch-before');
  if (archBefore) archBefore.onchange = () => { e.archiveBefore = archBefore.value; e.archivePreview = null; render(); };
  const pv = document.querySelector('[data-act="arch-preview"]');
  if (pv) pv.onclick = () => busy('preview', async () => { e.archivePreview = await api(`/api/tasks/archive/preview?before=${encodeURIComponent(e.archiveBefore)}`); });
  const cb = document.getElementById('arch-confirm');
  if (cb) cb.onchange = () => { e.downloadedHistory = cb.checked; render(); };
  const run = document.querySelector('[data-act="arch-run"]');
  if (run) run.onclick = () => busy('archive', async () => {
    const r = await api('/api/tasks/archive', { method: 'POST', body: JSON.stringify({ before: e.archiveBefore }) });
    setBanner(`${r.archived} finished task${r.archived === 1 ? '' : 's'} removed from the site. Their history is still in exports and schedule downloads.`, 'ok');
    e.archivePreview = null; e.downloadedHistory = false;
    await refreshData();
  });
}
// First week of each month: remind Admin that last month can be exported and cleared.
function monthEndReminderHTML() {
  if (session.role !== 'admin' || new Date().getDate() > 7) return '';
  const lm = lastMonthRange();
  if (safeStorage.getItem('ls_month_export_dismissed') === lm.from) return '';
  return `<div class="notice" style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
    <span>${esc(lm.label)} is over — download its task history and schedule timestamps, then clear the finished tasks off the site.</span>
    <span><button class="btn btn-sm btn-primary" data-act="goto-exports">Export & Archive</button> <button class="btn btn-sm" data-act="dismiss-month-export" data-month="${lm.from}">Later</button></span></div>`;
}
function bindMonthEndReminder() {
  const go = document.querySelector('[data-act="goto-exports"]');
  if (go) go.onclick = () => { ui.adminTab = 'exports'; safeStorage.setItem('ls_last_tab', 'exports'); render(); };
  const later = document.querySelector('[data-act="dismiss-month-export"]');
  if (later) later.onclick = () => { safeStorage.setItem('ls_month_export_dismissed', later.dataset.month); render(); };
}
function renderTasksView() {
  return `
  <div class="card">
    <div class="flex-between">
      <div class="card-title" style="margin:0;">Create Task</div>
      <div>
        <button class="btn btn-sm" data-act="toggle-import-panel">${icon('upload', 14)} Import from CSV / Excel</button>
        <button class="btn btn-sm" data-act="toggle-task-form" style="margin-left:6px;">+ New Task</button>
      </div>
    </div>
    <div id="import-panel-box">${importPanelHTML()}</div>
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
    if (!titleEl) { setBanner('Something went wrong finding the form — try again.'); render(); return; }
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
    // Uses the effective deadline AS IT APPLIES TO THE PERSON VIEWING the calendar — if they're
    // tagged on this task with their own individual deadline set, that's the date that actually
    // matters to them, not the task's overall one. Previously this always used the task's
    // overall deadline regardless, so changing someone's individual deadline never moved
    // anything on the calendar at all — a real, meaningful gap between what was set and what
    // was shown.
    const dateKey = effectiveDeadlineFor(t).slice(0, 10); // strip time-of-day, if any — bucketing is by day here
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
function effectiveDeadlineFor(task) {
  const myAssigneeRow = (task.assignees || []).find(a => a.username === session.username);
  return (myAssigneeRow && myAssigneeRow.individual_deadline) || task.deadline;
}
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
    const dayTasks = sourceTasks.filter(t => effectiveDeadlineFor(t).slice(0, 10) === iso);
    return { date: d, iso, allDay: dayTasks.filter(t => !hasDeadlineTime(effectiveDeadlineFor(t))), timed: dayTasks.filter(t => hasDeadlineTime(effectiveDeadlineFor(t))) };
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
  const scoped = applyTodayScope(myTasks);
  const closedToday = scoped.filter(t => t.status === 'closed' && t.closed_at && new Date(t.closed_at) >= todayStart);
  const openTasks = scoped.filter(t => t.status === 'open');
  // Blocked tasks never count as overdue here either — same fairness reasoning as the per-task
  // OVERDUE badge: someone waiting on a prerequisite hasn't been given a fair chance yet.
  const overdue = openTasks.filter(t => !t.blocked && isOverdue(t.deadline, now));
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
  // Only tagged tasks have progress to show; capped (nearest deadline first) so a large imported
  // schedule doesn't turn this glance page into thousands of bars.
  const ongoingTagged = openTasks.filter(t => (t.assignees || []).length > 0)
    .sort((a, b) => String(a.deadline || '9999').localeCompare(String(b.deadline || '9999')));
  const ongoingShown = ongoingTagged.slice(0, 25);
  return `
  ${monthEndReminderHTML()}
  <div class="card">
    <div class="card-title">Today — ${esc(todayStr)}</div>
    <p class="small muted">A running summary of what's happened today and what's expected — not a substitute for My Tasks, just a quick daily glance.</p>
    ${todayScopeHTML()}
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
      ${todayCardHTML('overdue', 'Overdue', 'alertTriangle', overdue.length, overdue.length > 0 ? 'hero-rose needs-attention' : 'hero-violet')}
      ${todayCardHTML('due', 'Due Today', 'clock', dueToday.length, 'hero-coral')}
      ${todayCardHTML('done', 'Completed Today', 'checkCircle', closedToday.length, 'hero-teal')}
      ${todayCardHTML('open', 'Open Total', 'grid', openTasks.length, 'hero-violet')}
    </div>
    <p class="small muted" style="margin:10px 0 0;">Tap a card to see those tasks.</p>
  </div>
  ${todayCardListHTML({ overdue, due: dueToday, done: closedToday, open: openTasks })}
  ${session.role === 'admin' ? renderLeaderboardCard(monthlyLeaderboard, '🏆 Monthly Leaderboard', "Nobody has completed approved work yet this month.", 'today-monthly') : ''}
  ${renderLeaderboardCard(weeklyLeaderboard, '📅 This Week', "Nobody has completed approved work yet this week.", 'today-weekly')}
  <div class="card">
    <div class="card-title">Ongoing Tasks Progress</div>
    <p class="small muted">Green shows the share of tagged people whose part is approved. Click a bar to see exactly who's done and who's remaining.</p>
    ${ongoingTagged.length === 0 ? `<div class="empty">${openTasks.length ? `No tagged tasks in progress — ${openTasks.length} open task${openTasks.length === 1 ? ' is' : 's are'} still waiting for people to be tagged.` : 'Nothing ongoing right now.'}</div>` : ongoingShown.map(t => {
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
    ${ongoingTagged.length > ongoingShown.length ? `<div class="small muted">Showing the ${ongoingShown.length} with the nearest deadlines, of ${ongoingTagged.length} — see My Tasks for all of them.</div>` : ''}
  </div>
`;
}
// Shared "whose work" filter for the Today page and My Dashboard. Every task is looked at from
// one person's point of view (`who`) and has up to two "sides":
//   personal — it's their own work: self-assigned, or assigned to them by someone else
//   assigned — they created it and assigned it to other people (work they're overseeing)
// Each filter option picks which sides count:
const WORK_SCOPES = [
  { key: 'mine', label: 'My Tasks', them: 'Their Tasks', hint: 'All your own work — self-assigned plus assigned to you' },
  { key: 'self', label: 'Self-assigned', them: 'Self-assigned', hint: 'Tasks you created for yourself' },
  { key: 'tome', label: 'Assigned to Me', them: 'Assigned to Them', hint: 'Tasks other people assigned to you' },
  { key: 'byme', label: 'Assigned by Me', them: 'Assigned by Them', hint: 'Tasks you assigned to others' },
  { key: 'all', label: 'All', them: 'All', hint: 'Everything you are part of' },
];
function scopeSides(t, who, scope) {
  const b = taskOwnershipBuckets(t, who);
  switch (scope) {
    case 'self': return { personal: b.self, assigned: false };
    case 'tome': return { personal: b.byothers, assigned: false };
    case 'byme': return { personal: false, assigned: b.forothers };
    case 'all': return { personal: b.self || b.byothers, assigned: b.forothers };
    default: return { personal: b.self || b.byothers, assigned: false }; // 'mine'
  }
}
function inWorkScope(t, who, scope) { const s = scopeSides(t, who, scope); return s.personal || s.assigned; }
function validScope(v) { return WORK_SCOPES.some(o => o.key === v) ? v : 'mine'; }
// The filter buttons. attr = data attribute the click handler listens on; extraHint is appended
// to the description line under the buttons.
function workScopeHTML({ attr, current, tasks, who, extraHint }) {
  const viewingSelf = who === session.username;
  const scope = validScope(current);
  const openCount = key => tasks.filter(t => t.status === 'open' && inWorkScope(t, who, key)).length;
  const info = WORK_SCOPES.find(o => o.key === scope);
  let hint = info.hint;
  if (!viewingSelf) hint = hint.replace(/\byour\b/g, 'their').replace(/\byou\b/g, 'them');
  return `
    <div class="today-scope" role="tablist" aria-label="Show tasks">
      ${WORK_SCOPES.map(o => `
        <button type="button" role="tab" class="today-scope-btn${scope === o.key ? ' active' : ''}" aria-selected="${scope === o.key}" ${attr}="${o.key}">
          ${esc(viewingSelf ? o.label : o.them)} <span class="task-tab-count">${openCount(o.key)}</span>
        </button>`).join('')}
    </div>
    <p class="small muted" style="margin:6px 0 0;">${esc(hint)}${extraHint ? ' · ' + esc(extraHint) : ''}</p>`;
}
function applyTodayScope(tasks) {
  const scope = validScope(ui.todayScope);
  return tasks.filter(t => inWorkScope(t, session.username, scope));
}
function todayScopeHTML() {
  return workScopeHTML({ attr: 'data-today-scope', current: ui.todayScope, tasks: myTasks, who: session.username, extraHint: 'counts show open tasks' });
}
// The four Today stat cards are buttons: tapping one shows that card's tasks underneath (same
// expandable task rows as My Tasks); tapping it again, or the ✕, hides the list.
const TODAY_CARD_INFO = {
  overdue: { title: 'Overdue', empty: 'Nothing overdue. 👍' },
  due: { title: 'Due Today', empty: 'Nothing due today.' },
  done: { title: 'Completed Today', empty: 'Nothing closed yet today.' },
  open: { title: 'Open Total', empty: 'Nothing open right now.' },
};
function todayCardHTML(key, label, iconName, count, cls) {
  const active = ui.todayCardOpen === key;
  return `
      <button type="button" class="hero-stat-card today-card ${cls}${active ? ' today-card-active' : ''}" data-today-card="${key}" aria-expanded="${active}" aria-controls="today-card-list">
        <div class="hero-stat-label">${label}<span class="hero-stat-icon">${icon(iconName, 15)}</span></div>
        <div class="hero-stat-number">${count}</div>
        <div class="today-card-hint">${active ? 'Hide ▴' : 'View ▾'}</div>
      </button>`;
}
function todayCardListHTML(lists) {
  const key = ui.todayCardOpen;
  if (!key || !lists[key]) return '';
  const info = TODAY_CARD_INFO[key];
  const all = key === 'done' ? lists[key] : sortTasksForDisplay(lists[key]);
  const shown = all.slice(0, ui.todayCardShown || OPEN_PAGE_SIZE);
  return `
  <div class="card today-card-list" id="today-card-list">
    <div class="flex-between">
      <div class="card-title" style="margin:0;">${esc(info.title)} <span class="task-tab-count">${all.length}</span></div>
      <button class="link-btn" data-act="close-today-card">✕ Close</button>
    </div>
    <div class="task-list" style="margin-top:10px;">
      ${shown.length === 0 ? `<div class="empty">${info.empty}</div>` : shown.map(t => renderTaskItem(t)).join('')}
    </div>
    ${all.length > shown.length ? `<div class="flex-between" style="margin-top:8px;flex-wrap:wrap;gap:6px;"><span class="small muted">Showing ${shown.length} of ${all.length}.</span><button class="btn btn-sm" data-act="today-card-more">Show ${Math.min(OPEN_PAGE_SIZE, all.length - shown.length)} more</button></div>` : ''}
  </div>`;
}
function bindTodayFeed() {
  document.querySelectorAll('[data-today-scope]').forEach(b => b.onclick = () => {
    ui.todayScope = b.dataset.todayScope; ui.todayCardShown = OPEN_PAGE_SIZE; render();
  });
  document.querySelectorAll('[data-today-card]').forEach(b => b.onclick = () => {
    const k = b.dataset.todayCard;
    ui.todayCardOpen = ui.todayCardOpen === k ? null : k;
    ui.todayCardShown = OPEN_PAGE_SIZE;
    render();
    if (ui.todayCardOpen) { const el = document.getElementById('today-card-list'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  });
  const closeBtn = document.querySelector('[data-act="close-today-card"]');
  if (closeBtn) closeBtn.onclick = () => { ui.todayCardOpen = null; render(); };
  const moreBtn = document.querySelector('[data-act="today-card-more"]');
  if (moreBtn) moreBtn.onclick = () => { ui.todayCardShown = (ui.todayCardShown || OPEN_PAGE_SIZE) + OPEN_PAGE_SIZE; render(); };
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
      safeStorage.setItem('ls_token', token); safeStorage.setItem('ls_session', JSON.stringify(session));
      setBanner('Name updated.', 'ok'); await refreshData();
    } catch (e) { setBanner(e.message); render(); }
  };
  const saveEmail = document.querySelector('[data-act="save-profile-email"]');
  if (saveEmail) saveEmail.onclick = async () => {
    const email = document.getElementById('profile-email').value.trim();
    try {
      const data = await api('/api/auth/update-email', { method: 'POST', body: JSON.stringify({ email }) });
      session = { ...session, email: data.email };
      safeStorage.setItem('ls_session', JSON.stringify(session));
      setBanner('Email updated.', 'ok'); render();
    } catch (e) { setBanner(e.message); render(); }
  };
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
      safeStorage.setItem('ls_token', token);
      document.getElementById('profile-pw-new').value = ''; document.getElementById('profile-pw-confirm').value = '';
      setBanner('Password changed.', 'ok'); render();
    } catch (e) { setBanner(e.message); render(); }
  };
  const logoutEverywhere = document.querySelector('[data-act="logout-everywhere"]');
  if (logoutEverywhere) logoutEverywhere.onclick = async () => {
    if (!confirm('Log out every other device/browser signed into your account? This device will stay logged in.')) return;
    try {
      const data = await api('/api/auth/logout-everywhere', { method: 'POST' });
      token = data.token; safeStorage.setItem('ls_token', token);
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
    if (!projectEl) { setBanner('Something went wrong finding the form — try again.'); render(); return; }
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
const WORKING_HOURS_ORDER = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22];
function filterToWorkingHours(hours) {
  return WORKING_HOURS_ORDER.map(h => hours.find(x => x.hour === h)).filter(Boolean);
}
function renderHourlyCurveChart(hours, opts) {
  opts = opts || {};
  const width = 720, height = 190, padTop = 10, padBottom = 24, padX = 14;
  // A genuinely real crash, found and fixed: if `hours` is ever empty — data not loaded yet,
  // a failed fetch leaving the default empty array in place, or a working-hours filter that
  // happens to match nothing — every line below assumes at least one point exists and throws
  // "Cannot read properties of undefined" the moment it doesn't. Render a calm empty state
  // instead of crashing the whole page.
  if (!hours || hours.length === 0) {
    return `<div class="empty" style="height:${height}px;display:flex;align-items:center;justify-content:center;">No activity data yet.</div>`;
  }
  const maxTotal = Math.max(1, ...hours.map(h => h.total));
  const stepX = hours.length > 1 ? (width - 2 * padX) / (hours.length - 1) : 0;
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
/* ---- My Dashboard: scope switch + clickable cards (same behaviour as Today) ----
   Card numbers here are computed from the same task list the card opens, so the number on a
   card always equals the number of tasks you see when you tap it. Only available where the
   browser actually has that person's tasks: your own dashboard (everyone), and an Admin viewing
   one person. The Whole Company and HR-viewing-someone views keep the server totals as before. */
const DASH_DAY_MS = 86400000;
function dashTaskSource() {
  const d = myDashboardData;
  if (!d) return null;
  if (d.username === session.username) return { who: session.username, tasks: myTasks };
  if (d.username !== 'all' && session.role === 'admin') {
    const who = d.username;
    return { who, tasks: (allTasks || []).filter(t => t.created_by_username === who || (t.assignees || []).some(a => a.username === who)) };
  }
  return null;
}
function dashInScope(t, who, scope) { return inWorkScope(t, who, scope); }
// Where an open task stands for `who`: 'action' (they must do something — their own part, or
// reviewing a submission on work they assigned), 'hold' (their part isn't released yet), or
// 'waiting' (nothing for them right now — their part is approved, or the people they assigned
// are still working). A task that is both theirs and assigned-by-them takes the more urgent one.
function dashRightNowState(t, who, scope) {
  const tags = t.assignees || [];
  const approved = a => a.decision === 'approve' && !!a.completed_at;
  const sides = scopeSides(t, who, scope);
  const states = [];
  if (sides.personal) {
    const row = tags.find(a => a.username === who);
    states.push(!row ? 'action' : !row.is_released ? 'hold' : approved(row) ? 'waiting' : 'action');
  }
  if (sides.assigned) {
    const others = tags.filter(a => a.username !== who);
    states.push(others.some(a => a.submitted_at && !approved(a)) ? 'action' : 'waiting');
  }
  if (states.includes('action')) return 'action';
  if (states.includes('hold')) return 'hold';
  return states[0] || null;
}
// When a task counts as "completed" for `who`: their own part approved (by submission time, the
// same rule the server uses for completion credit), or — for work they assigned — the task closing.
function dashCompletedAt(t, who, scope) {
  const sides = scopeSides(t, who, scope);
  const times = [];
  if (sides.personal) {
    const row = (t.assignees || []).find(a => a.username === who);
    if (row && row.decision === 'approve' && row.submitted_at) times.push(new Date(row.submitted_at).getTime());
    else if (!row && t.status === 'closed' && t.closed_at) times.push(new Date(t.closed_at).getTime());
  }
  if (sides.assigned && t.status === 'closed' && t.closed_at) times.push(new Date(t.closed_at).getTime());
  return times.length ? Math.max(...times) : null;
}
function dashLists(src, scope) {
  const { who, tasks } = src;
  const L = { action: [], hold: [], waiting: [], week: [], month: [], year: [], allTime: [] };
  const now = Date.now();
  for (const t of tasks) {
    if (!dashInScope(t, who, scope)) continue;
    if (t.status === 'open') { const st = dashRightNowState(t, who, scope); if (st) L[st].push(t); }
    const at = dashCompletedAt(t, who, scope);
    if (at !== null) {
      const age = (now - at) / DASH_DAY_MS;
      L.allTime.push(t);
      if (age <= 365) L.year.push(t);
      if (age <= 30) L.month.push(t);
      if (age <= 7) L.week.push(t);
    }
  }
  const byDone = (a, b) => (dashCompletedAt(b, who, scope) || 0) - (dashCompletedAt(a, who, scope) || 0);
  ['week', 'month', 'year', 'allTime'].forEach(k => L[k].sort(byDone));
  ['action', 'hold', 'waiting'].forEach(k => { L[k] = sortTasksForDisplay(L[k]); });
  return L;
}
const DASH_CARD_INFO = {
  action: { title: 'Needs Action', empty: 'Nothing needs action right now. 👍' },
  hold: { title: 'On Hold', empty: 'Nothing on hold.' },
  waiting: { title: 'Waiting On Others', empty: 'Nothing waiting on others.' },
  week: { title: 'Completed This Week', empty: 'Nothing completed in the last 7 days.' },
  month: { title: 'Completed This Month', empty: 'Nothing completed in the last 30 days.' },
  year: { title: 'Completed This Year', empty: 'Nothing completed in the last 365 days.' },
  allTime: { title: 'Completed — All Time', empty: 'Nothing completed yet.' },
};
function dashScopeHTML(src) {
  const scope = validScope(ui.dashScope);
  const extra = (scope === 'byme' || scope === 'all') ? '"Needs Action" includes submissions waiting for approval · tap any card to see its tasks' : 'tap any card to see its tasks';
  return `
  <div class="card">
    <div style="margin-top:-10px;">${workScopeHTML({ attr: 'data-dash-scope', current: ui.dashScope, tasks: src.tasks, who: src.who, extraHint: extra })}</div>
  </div>`;
}
function dashCardHTML(key, label, iconName, count, cls) {
  const active = ui.dashCardOpen === key;
  return `
      <button type="button" class="hero-stat-card today-card ${cls}${active ? ' today-card-active' : ''}" data-dash-card="${key}" aria-expanded="${active}" aria-controls="dash-card-list">
        <div class="hero-stat-label">${label}<span class="hero-stat-icon">${icon(iconName, 15)}</span></div>
        <div class="hero-stat-number">${count}</div>
        <div class="today-card-hint">${active ? 'Hide ▴' : 'View ▾'}</div>
      </button>`;
}
function dashListHTML(lists, keys) {
  const key = ui.dashCardOpen;
  if (!key || !keys.includes(key)) return '';
  const info = DASH_CARD_INFO[key];
  const all = lists[key] || [];
  const shown = all.slice(0, ui.dashCardShown || OPEN_PAGE_SIZE);
  return `
  <div class="card today-card-list" id="dash-card-list">
    <div class="flex-between">
      <div class="card-title" style="margin:0;">${esc(info.title)} <span class="task-tab-count">${all.length}</span></div>
      <button class="link-btn" data-act="close-dash-card">✕ Close</button>
    </div>
    <div class="task-list" style="margin-top:10px;">
      ${shown.length === 0 ? `<div class="empty">${info.empty}</div>` : shown.map(t => renderTaskItem(t)).join('')}
    </div>
    ${all.length > shown.length ? `<div class="flex-between" style="margin-top:8px;flex-wrap:wrap;gap:6px;"><span class="small muted">Showing ${shown.length} of ${all.length}.</span><button class="btn btn-sm" data-act="dash-card-more">Show ${Math.min(OPEN_PAGE_SIZE, all.length - shown.length)} more</button></div>` : ''}
  </div>`;
}
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
  const src = dashTaskSource();
  const scope = validScope(ui.dashScope);
  const L = src ? dashLists(src, scope) : null;
  const rightNowCards = L ? `
      ${dashCardHTML('action', 'Needs Action', 'alertTriangle', L.action.length, L.action.length > 0 ? 'hero-rose needs-attention' : 'hero-teal')}
      ${dashCardHTML('hold', 'On Hold', 'clock', L.hold.length, 'hero-coral')}
      ${dashCardHTML('waiting', 'Waiting On Others', 'users', L.waiting.length, 'hero-violet')}` : null;
  const completedCards = L ? `
      ${dashCardHTML('week', 'This Week', 'checkCircle', L.week.length, 'hero-teal')}
      ${dashCardHTML('month', 'This Month', 'checkCircle', L.month.length, 'hero-violet')}
      ${dashCardHTML('year', 'This Year', 'checkCircle', L.year.length, 'hero-coral')}
      ${dashCardHTML('allTime', 'All Time', 'checkCircle', L.allTime.length, 'hero-rose')}` : null;
  return `
  ${adminSelector}
  <div class="notice">${viewingWholeCompany ? 'Aggregated across every employee — totals and averages, not any one person\'s individual numbers.' : (viewingSelf ? "Your own stats only — nobody else can see this page, and it doesn't show anyone else's numbers either." : `Viewing ${esc(viewedName)}'s individual dashboard as Admin — they can see this same view themselves too; it's not hidden from them.`)} Real computed statistics${viewingWholeCompany ? '' : ` from ${viewingSelf ? 'your own' : 'their'} history`}, not a trained model — just the honest numbers.</div>
  ${src ? dashScopeHTML(src) : ''}
  <div class="card">
    <div class="card-title">${pronounCaps} Right Now</div>
    <div class="hero-stat-grid">${rightNowCards !== null ? rightNowCards : `
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
      </div>`}
    </div>
  </div>
  ${L ? dashListHTML(L, ['action', 'hold', 'waiting']) : ''}
  <div class="card">
    <div class="card-title">${pronounCaps} Tasks Completed</div>
    <div class="hero-stat-grid">${completedCards !== null ? completedCards : `
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
      </div>`}
    </div>
    ${L ? '<p class="small muted" style="margin:10px 0 0;">Week, month and year are the last 7, 30 and 365 days. Archived tasks are not included.</p>' : ''}
  </div>
  ${L ? dashListHTML(L, ['week', 'month', 'year', 'allTime']) : ''}
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
  if (sel) sel.onchange = async () => { ui.dashboardViewUser = sel.value; ui.dashCardOpen = null; await refreshData(); };
  document.querySelectorAll('[data-dash-scope]').forEach(b => b.onclick = () => { ui.dashScope = b.dataset.dashScope; ui.dashCardShown = OPEN_PAGE_SIZE; render(); });
  document.querySelectorAll('[data-dash-card]').forEach(b => b.onclick = () => {
    const k = b.dataset.dashCard;
    ui.dashCardOpen = ui.dashCardOpen === k ? null : k;
    ui.dashCardShown = OPEN_PAGE_SIZE;
    render();
    if (ui.dashCardOpen) { const el = document.getElementById('dash-card-list'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  });
  const closeBtn = document.querySelector('[data-act="close-dash-card"]');
  if (closeBtn) closeBtn.onclick = () => { ui.dashCardOpen = null; render(); };
  const moreBtn = document.querySelector('[data-act="dash-card-more"]');
  if (moreBtn) moreBtn.onclick = () => { ui.dashCardShown = (ui.dashCardShown || OPEN_PAGE_SIZE) + OPEN_PAGE_SIZE; render(); };
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
        <td class="mono">${s.quarter != null ? s.quarter : 0}</td>
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
        s.name, s.username, s.team || '', s.week, s.month, s.quarter != null ? s.quarter : 0, s.year, s.allTime,
        r.rating !== undefined && r.rating !== null ? r.rating.toFixed(1) : '',
        r.volumeScore !== undefined && r.volumeScore !== null ? r.volumeScore.toFixed(1) : '',
        r.timelinessScore !== undefined && r.timelinessScore !== null ? r.timelinessScore.toFixed(1) : '',
        r.warningCount || 0,
      ]);
    });
    const csv = rows.map(row => row.map(cell => {
      const s = String(cell != null ? cell : '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(',')).join('\r\n');
    downloadDataUrl('data:text/csv;charset=utf-8;base64,' + btoa(unescape(encodeURIComponent('\uFEFF' + csv))), `performance-${new Date().toISOString().slice(0, 10)}.csv`);
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
// Which expandable rows (<details> with an id) the person has opened. A re-render must never
// snap them shut — the page refreshes itself every few seconds when data changes.
const openDetails = new Set();
document.addEventListener('toggle', (e) => {
  const d = e.target;
  if (d && d.tagName === 'DETAILS' && d.id) { if (d.open) openDetails.add(d.id); else openDetails.delete(d.id); }
}, true);
function morphAttributes(fromEl, toEl) {
  if (toEl.tagName === 'DETAILS') {
    const wantOpen = (toEl.id && openDetails.has(toEl.id)) || toEl.hasAttribute('open');
    if (wantOpen) toEl.setAttribute('open', ''); else toEl.removeAttribute('open');
  }
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
  // Expanded/collapsed state of <details> is preserved in morphAttributes (openDetails), so their
  // contents can — and must — be updated like everything else. (They used to be skipped entirely,
  // which left reused rows showing another task's old content.)
  morphChildren(fromNode, toNode);
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
  let showingToday = false; // Today is also the fallback page, so bind it by what was rendered, not by tab name
  if (!dataLoadedOnce) body = renderLoadingSkeleton();
  else if (ui.adminTab === 'tasks') body = renderTasksView();
  else if (ui.adminTab === 'alltasks' && session.role === 'admin') body = renderAllTasksCard();
  else if (ui.adminTab === 'accounts' && session.role === 'admin') body = renderAccountsView();
  else if (ui.adminTab === 'performance' && session.role === 'admin') body = renderPerformanceView();
  else if (ui.adminTab === 'auditlog' && session.role === 'admin') body = renderAuditLogView();
  else if (ui.adminTab === 'peakhours' && session.role === 'admin') body = renderPeakHoursView();
  else if (ui.adminTab === 'mydashboard') body = renderMyDashboardView();
  else if (ui.adminTab === 'hrdashboard' && (session.role === 'admin' || isHRTeamName(session.team))) body = renderHRDashboardView();
  else if (ui.adminTab === 'reports' && session.role === 'admin') body = renderReportsView();
  else if (ui.adminTab === 'exports' && session.role === 'admin') body = renderExportsView();
  else if (ui.adminTab === 'calendar') body = renderCalendarView();
  else if (ui.adminTab === 'profile') body = renderProfileView();
  else if (ui.adminTab === 'myteam' && session.role !== 'admin' && session.isTeamLead) body = renderMyTeamView();
  else { body = renderTodayFeed(); showingToday = true; }
  morphHTML(app, `
    <div class="app-shell${ui.sidebarCollapsed ? ' sidebar-collapsed' : ''}">
      ${renderSidebar()}
      <div class="main-col">
        ${renderTopbarSlim()}
        <main class="content">
          ${bannerHTML()}
          <div id="notif-prompt-box">${dataLoadedOnce ? notifPromptHTML() : ''}</div>
          ${body}
        </main>
      </div>
    </div>`);
  bindGlobal();
  if (ui.adminTab === 'tasks' || ui.adminTab === 'alltasks' || ui.adminTab === 'calendar' || ui.adminTab === 'mydashboard' || showingToday) { bindMyTasks(); bindFollowupForm(); bindSubtaskForm(); bindAddAssigneeForm(); }
  if (ui.adminTab === 'tasks') { bindApprovalForm(); bindApprovalsSection(); }
  if (ui.adminTab === 'calendar') bindCalendarView();
  if (ui.adminTab === 'tasks') { bindTaskForm(); bindImportPanel(); }
  if (ui.adminTab === 'accounts') bindAccounts();
  if (ui.adminTab === 'profile') bindProfile();
  if (ui.adminTab === 'myteam') bindMyTeam();
  if (ui.adminTab === 'peakhours') bindPeakHoursView();
  if (ui.adminTab === 'performance') bindPerformanceView();
  if (ui.adminTab === 'mydashboard') bindMyDashboardView();
  if (ui.adminTab === 'hrdashboard') bindHRDashboardView();
  if (ui.adminTab === 'auditlog') bindAuditLogView();
  if (ui.adminTab === 'reports') bindReportsView();
  if (ui.adminTab === 'exports') bindExportsView();
  bindMonthEndReminder();
  bindNotifPrompt();
  if (showingToday) bindTodayFeed();
}
function bindGlobal() {
  bindThemeToggle();
  document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => {
    ui.adminTab = b.dataset.tab; ui.sidebarOpen = false; safeStorage.setItem('ls_last_tab', ui.adminTab);
    loadTabExtras();
    render();
    // Switching tabs previously only re-rendered whatever was already in memory from login time
    // or the last background poll — meaning a page like Accounts could show stale (or, on a
    // slow/failed earlier fetch, still-empty) data even though the real data was one request
    // away. A fresh, immediate fetch on every tab switch fixes that without waiting for the
    // next poll cycle.
    refreshData();
  });
  // Phones/narrow windows: the menu slides over the page (sidebarOpen). Wider screens: it sits
  // beside the page and can be collapsed for a full-width view (sidebarCollapsed, remembered).
  const isNarrow = () => window.matchMedia('(max-width: 860px)').matches;
  const menuToggle = document.querySelector('[data-act="toggle-sidebar"]');
  if (menuToggle) menuToggle.onclick = () => {
    if (isNarrow()) ui.sidebarOpen = !ui.sidebarOpen;
    else { ui.sidebarCollapsed = !ui.sidebarCollapsed; safeStorage.setItem('ls_sidebar_collapsed', ui.sidebarCollapsed ? '1' : ''); }
    render();
  };
  document.querySelectorAll('[data-act="close-sidebar"]').forEach(b => b.onclick = () => {
    ui.sidebarOpen = false;
    if (!isNarrow()) { ui.sidebarCollapsed = true; safeStorage.setItem('ls_sidebar_collapsed', '1'); }
    render();
  });
  const logoutBtn = document.querySelector('[data-act="logout"]'); if (logoutBtn) logoutBtn.onclick = () => logout();
  const reopenPwChange = document.querySelector('[data-act="reopen-password-change"]'); if (reopenPwChange) reopenPwChange.onclick = () => { ui.showPasswordChangeModal = true; safeStorage.removeItem('ls_pw_reminder_dismissed'); render(); };
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
  if (searchInput) searchInput.oninput = () => { ui.taskSearchQuery = searchInput.value; ui.myHistoryShown = 20; ui.allHistoryShown = 20; ui.myOpenShown = OPEN_PAGE_SIZE; ui.allOpenShown = OPEN_PAGE_SIZE; render(); };
  const filterProjectSelect = document.getElementById('task-filter-project');
  if (filterProjectSelect) filterProjectSelect.onchange = () => { ui.taskFilterProject = filterProjectSelect.value; ui.myHistoryShown = 20; ui.allHistoryShown = 20; ui.myOpenShown = OPEN_PAGE_SIZE; ui.allOpenShown = OPEN_PAGE_SIZE; render(); };
  const filterPhaseSelect = document.getElementById('task-filter-phase');
  if (filterPhaseSelect) filterPhaseSelect.onchange = () => { ui.taskFilterPhase = filterPhaseSelect.value; ui.myHistoryShown = 20; ui.allHistoryShown = 20; ui.myOpenShown = OPEN_PAGE_SIZE; ui.allOpenShown = OPEN_PAGE_SIZE; render(); };
  const filterTaggingSelect = document.getElementById('task-filter-tagging');
  if (filterTaggingSelect) filterTaggingSelect.onchange = () => { ui.taskFilterTagging = filterTaggingSelect.value; ui.myOpenShown = OPEN_PAGE_SIZE; ui.allOpenShown = OPEN_PAGE_SIZE; render(); };
  document.querySelectorAll('[data-act="toggle-deadline-edit"]').forEach(b => b.onclick = () => { ui.deadlineEditTaskId = b.dataset.taskId; render(); });
  document.querySelectorAll('[data-act="cancel-deadline-edit"]').forEach(b => b.onclick = () => { ui.deadlineEditTaskId = null; render(); });
  document.querySelectorAll('[data-act="save-deadline-edit"]').forEach(b => b.onclick = async () => {
    const id = b.dataset.taskId;
    const date = document.getElementById(`deadline-edit-date-${id}`).value;
    const time = document.getElementById(`deadline-edit-time-${id}`).value;
    const reason = document.getElementById(`deadline-edit-reason-${id}`).value.trim();
    if (!date) { setBanner('Pick the new deadline date.'); render(); return; }
    try {
      const r = await api(`/api/tasks/${id}/deadline`, { method: 'POST', body: JSON.stringify({ deadline: time ? `${date}T${time}` : date, reason }) });
      ui.deadlineEditTaskId = null;
      setBanner(r.unchanged ? 'That is already the deadline.' : 'Deadline changed — everyone on the task has been told.', 'ok');
      await refreshData();
    } catch (e) { setBanner(e.message); render(); }
  });
  document.querySelectorAll('[data-owner-filter]').forEach(b => b.onclick = () => { document.querySelectorAll('[data-owner-person]').forEach(s => { s.value = ''; }); ui.myOwnerFilter = b.dataset.ownerFilter; ui.myOwnerPerson = ''; ui.myOpenShown = OPEN_PAGE_SIZE; ui.myHistoryShown = HISTORY_PAGE_SIZE; render(); });
  const ownerPersonSel = document.querySelector('[data-owner-person]');
  if (ownerPersonSel) ownerPersonSel.onchange = () => { ui.myOwnerPerson = ownerPersonSel.value; ui.myOpenShown = OPEN_PAGE_SIZE; ui.myHistoryShown = HISTORY_PAGE_SIZE; render(); };
  document.querySelectorAll('[data-my-tab]').forEach(b => b.onclick = () => { ui.myTasksTab = b.dataset.myTab; ui.myOpenShown = OPEN_PAGE_SIZE; ui.myHistoryShown = HISTORY_PAGE_SIZE; render(); });
  const personSel = document.getElementById('task-filter-person');
  if (personSel) personSel.onchange = () => { ui.taskFilterPerson = personSel.value; ui.allOpenShown = OPEN_PAGE_SIZE; ui.allHistoryShown = HISTORY_PAGE_SIZE; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  const personRoleSel = document.getElementById('task-filter-person-role');
  if (personRoleSel) personRoleSel.onchange = () => { ui.taskFilterPersonRole = personRoleSel.value; ui.allOpenShown = OPEN_PAGE_SIZE; render(); };
  const clearPerson = document.querySelector('[data-act="clear-person-filter"]');
  if (clearPerson) clearPerson.onclick = () => { ui.taskFilterPerson = ''; ui.taskFilterPersonRole = 'any'; render(); };
  document.querySelectorAll('[data-all-tab]').forEach(b => b.onclick = () => { ui.allTasksTab = b.dataset.allTab; ui.allOpenShown = OPEN_PAGE_SIZE; ui.allHistoryShown = HISTORY_PAGE_SIZE; render(); });
  const showMoreMyOpen = document.querySelector('[data-act="show-more-my-open"]');
  if (showMoreMyOpen) showMoreMyOpen.onclick = () => { ui.myOpenShown = (ui.myOpenShown || OPEN_PAGE_SIZE) + OPEN_PAGE_SIZE; render(); };
  const showMoreAllOpen = document.querySelector('[data-act="show-more-all-open"]');
  if (showMoreAllOpen) showMoreAllOpen.onclick = () => { ui.allOpenShown = (ui.allOpenShown || OPEN_PAGE_SIZE) + OPEN_PAGE_SIZE; render(); };
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
  document.querySelectorAll('[data-act="toggle-individual-deadlines"]').forEach(link => link.onclick = (e) => {
    e.preventDefault();
    const id = link.dataset.taskId;
    ui.individualDeadlineFormTaskId = (ui.individualDeadlineFormTaskId === id) ? null : id;
    render();
  });
  document.querySelectorAll('[data-save-individual-deadline]').forEach(btn => btn.onclick = async () => {
    const taskId = btn.dataset.saveIndividualDeadline;
    const username = btn.dataset.username;
    const input = document.getElementById(`individual-deadline-${taskId}-${username}`);
    const deadline = input ? input.value.trim() : '';
    try {
      await api(`/api/tasks/${taskId}/assignees/${encodeURIComponent(username)}/deadline`, { method: 'POST', body: JSON.stringify({ deadline }) });
      setBanner(deadline ? `Individual deadline set for ${username}.` : `Individual deadline cleared for ${username}.`, 'ok');
      await refreshData();
    } catch (e) { setBanner(e.message); render(); }
  });
  document.querySelectorAll('[data-act="toggle-reshuffle-levels"]').forEach(link => link.onclick = (e) => {
    e.preventDefault();
    const id = link.dataset.taskId;
    ui.reshuffleLevelsFormTaskId = (ui.reshuffleLevelsFormTaskId === id) ? null : id;
    render();
  });
  document.querySelectorAll('[data-save-reshuffle-level]').forEach(btn => btn.onclick = async () => {
    const taskId = btn.dataset.saveReshuffleLevel;
    const username = btn.dataset.username;
    const input = document.getElementById(`reshuffle-level-${taskId}-${username}`);
    const level = input ? input.value.trim() : '';
    if (!level) { setBanner('Enter a level number first.'); render(); return; }
    try {
      const result = await api(`/api/tasks/${taskId}/assignees/${encodeURIComponent(username)}/level`, { method: 'POST', body: JSON.stringify({ level: parseInt(level, 10) }) });
      setBanner(`${username} moved to Level ${result.newLevel}${result.isReleased ? ' and released to start now.' : ' (on hold for now).'}`, 'ok');
      await refreshData();
    } catch (e) { setBanner(e.message); render(); }
  });
  // Hover-to-edit level: click the small "✎ L{n}" affordance that appears on hovering an
  // assignee's badge → an inline number input opens right there → clicking Save doesn't call
  // the API immediately, it opens a confirmation step first ("Save changes: move X to Level Y?")
  // → only THAT confirmation actually commits the change, using the exact same endpoint and
  // exact same notify/audit behavior as the full Reshuffle panel.
  document.querySelectorAll('[data-act="show-level-edit"]').forEach(el => el.onclick = () => {
    ui.levelEditKey = `${el.dataset.taskId}::${el.dataset.username}`;
    ui.levelEditConfirmKey = null;
    render();
  });
  document.querySelectorAll('[data-act="toggle-delete-task"]').forEach(btn => btn.onclick = () => {
    ui.deleteTaskConfirmId = btn.dataset.taskId;
    render();
  });
  document.querySelectorAll('[data-act="cancel-delete-task"]').forEach(btn => btn.onclick = () => {
    ui.deleteTaskConfirmId = null;
    render();
  });
  document.querySelectorAll('[data-act="confirm-delete-task"]').forEach(btn => btn.onclick = async () => {
    const taskId = btn.dataset.taskId;
    ui.deleteTaskConfirmId = null;
    try {
      await api(`/api/tasks/${taskId}`, { method: 'DELETE' });
      setBanner('Task permanently deleted.', 'ok');
      await refreshData();
    } catch (e) { setBanner(e.message); render(); }
  });
  document.querySelectorAll('[data-act="cancel-level-edit"]').forEach(el => el.onclick = () => {
    ui.levelEditKey = null; ui.levelEditConfirmKey = null; ui.levelEditConfirmValue = null;
    render();
  });
  document.querySelectorAll('[data-act="request-level-edit"]').forEach(el => el.onclick = () => {
    const taskId = el.dataset.taskId, username = el.dataset.username;
    const input = document.getElementById(`level-edit-input-${taskId}-${username}`);
    const level = input ? input.value.trim() : '';
    if (!level) { setBanner('Enter a level number first.'); render(); return; }
    ui.levelEditKey = null;
    ui.levelEditConfirmKey = `${taskId}::${username}`;
    ui.levelEditConfirmValue = level;
    render();
  });
  document.querySelectorAll('[data-act="confirm-level-edit"]').forEach(el => el.onclick = async () => {
    const taskId = el.dataset.taskId, username = el.dataset.username;
    const level = ui.levelEditConfirmValue;
    ui.levelEditKey = null; ui.levelEditConfirmKey = null; ui.levelEditConfirmValue = null;
    try {
      const result = await api(`/api/tasks/${taskId}/assignees/${encodeURIComponent(username)}/level`, { method: 'POST', body: JSON.stringify({ level: parseInt(level, 10) }) });
      setBanner(`${username} moved to Level ${result.newLevel}${result.isReleased ? ' and released to start now.' : ' (on hold for now).'}`, 'ok');
      await refreshData();
    } catch (e) { setBanner(e.message); render(); }
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
    if (!field) { setBanner('Something went wrong finding the reply box — try again.'); render(); return; }
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
    if (!reasonEl) { setBanner('Something went wrong finding the reason field — try reopening the form again.'); render(); return; }
    const reason = reasonEl.value.trim();
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
    if (!inp) { setBanner('Something went wrong finding the checklist field — try again.'); render(); return; }
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
    if (!inp) { setBanner('Something went wrong finding the form field — try again.'); render(); return; }
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
    } catch (e) { setBanner(e.message); await refreshData(); }
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
  // Removing an account now deletes everything tied to it — so Admin sees exactly what will go
  // before confirming, and decides separately about drawings (project documents others may need).
  document.querySelectorAll('[data-remove-user]').forEach(btn => btn.onclick = async () => {
    const username = btn.dataset.removeUser;
    let impact;
    try { impact = await api(`/api/users/${encodeURIComponent(username)}/deletion-impact`); }
    catch (e) { setBanner(e.message); render(); return; }
    const lines = [
      impact.tasksCreated ? `• ${impact.tasksCreated} task(s) they created${impact.openTasksCreated ? ` (${impact.openTasksCreated} still open)` : ''}, with their subtasks` : '',
      impact.soleAssigneeTasks ? `• ${impact.soleAssigneeTasks} task(s) where they're the only person tagged` : '',
      impact.sharedTasks ? `• Their tag on ${impact.sharedTasks} shared task(s) — the others on those tasks carry on` : '',
      impact.replies ? `• ${impact.replies} comment(s) they wrote` : '',
      impact.followups ? `• ${impact.followups} follow-up tag(s)` : '',
      impact.approvalsCreated ? `• ${impact.approvalsCreated} approval request(s) they sent` : '',
      impact.approvalReviews ? `• Their approver slot on ${impact.approvalReviews} approval request(s)` : '',
      impact.notifications ? `• ${impact.notifications} notification(s), plus their logins and devices` : '• Their logins and devices',
    ].filter(Boolean);
    if (!confirm(`Permanently remove ${impact.name} (${username})?\n\nThis will also delete:\n${lines.join('\n')}\n\nThe audit log keeps a record of the removal. This cannot be undone.`)) return;
    let deleteDrawings = false;
    if (impact.drawings > 0) {
      deleteDrawings = confirm(`${impact.name} uploaded ${impact.drawings} drawing(s) to the project library.\n\nOK = delete those drawings too\nCancel = keep the drawings (recommended if others still use them)`);
    }
    try {
      await api(`/api/users/${encodeURIComponent(username)}${deleteDrawings ? '?deleteDrawings=1' : ''}`, { method: 'DELETE' });
      // Drop them from what's on screen AND from this device's saved copy right away, so reopening
      // the app can never show the removed account, not even for the second before fresh data loads.
      userDirectory = userDirectory.filter(u => u.username !== username);
      saveDataSnapshot();
      setBanner(`${impact.name}'s account and all related data were removed.`, 'ok');
      await refreshData();
    } catch (e) { setBanner(e.message); render(); }
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
if (session && token) {
  // Paint the last known data from this device instantly, then fetch fresh data.
  loadDataSnapshot().then(had => { if (had) render(); });
  refreshData().then(() => { lastFullRefreshAt = Date.now(); registerAndroidDevice(); ensurePushSubscription(false); });
}
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
// Reduced from 30s to 8s — the previous interval made updates from other people (or another of
// your own tabs/devices) feel stale and out of sync; this app has no push/WebSocket channel, so
// polling is the mechanism, and 8s is frequent enough to feel close to real-time without being
// wasteful. A person's OWN actions (creating a task, approving, etc.) already refresh
// immediately via their own explicit refreshData() call right after that action succeeds —
// this interval only covers picking up everyone else's changes.
setInterval(() => syncTick(false), 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) syncTick(true); });
window.addEventListener('focus', () => syncTick(true));
window.addEventListener('online', () => syncTick(true));
