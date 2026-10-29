/* Voice / typed assistant — one command in Marathi, Hindi or English.

   POST /api/assistant/command { audio: dataUrl } or { text }
   The AI (services/ai.js parseCommand) turns the words into an intent; this module checks it against the
   tasks this person can see and answers:
     show_tasks  → a list (my tasks, tasks I gave, waiting for my approval, a person's tasks; overdue / today /
                   tomorrow / this week; a project)
     mark_done, approve, send_back, follow_up, comment → a proposed action for a confirm card. Nothing changes
                   here: the page calls the normal endpoints (submit-mine, approve, reject, nudge, reply) only after
                   the person presses Confirm — so every permission check of those endpoints still applies.
     create_task → the transcript, which the page sends to the usual "Tasks from a message" flow.
   The reply is written in the language that was spoken, for the screen and for reading aloud. */

const L = {
  en: {
    count: (n, what) => n ? `You have ${n} ${what}.` : `No ${what}.`,
    personCount: (n, who, what) => n ? `${who} has ${n} ${what}.` : `${who} has no ${what}.`,
    what: { mine: 'pending tasks', created_by_me: 'open tasks you gave', to_approve: 'tasks waiting for your approval', person: 'pending tasks', all: 'open tasks' },
    when: { overdue: 'overdue ', today: '', tomorrow: '', this_week: '', any: '' },
    whenAfter: { today: ' due today', tomorrow: ' due tomorrow', this_week: ' due this week' },
    notFound: 'I could not find that task. Please say a few words of its title.',
    personNotFound: 'I could not find that person.',
    nothingToApprove: 'Nothing on that task is waiting for your approval.',
    confirm: { submit: (t) => `Mark your part of "${t}" as done?`, approve: (t, p) => `Approve ${p}'s work on "${t}"?`, sendback: (t, p) => `Send ${p}'s work on "${t}" back?`,
      followup: (n) => n === 1 ? 'Send a follow-up on this task?' : `Send follow-ups on these ${n} tasks?`, comment: (t) => `Add this comment on "${t}"?` },
    create: 'Making the task from what you said — check it and press Create.',
    info: (t, d, n, late) => !d ? `"${t}" has no deadline.` : late ? `"${t}" was due on ${d} — overdue by ${-n} day${n === -1 ? '' : 's'}.` : n === 0 ? `"${t}" is due today (${d}).` : `"${t}" is due on ${d} — ${n} day${n === 1 ? '' : 's'} left.`,
    unknown: 'Sorry, I did not understand. Try: "show my overdue tasks", "mark the slab task done", "approve Ruchita\'s carpet task".',
  },
  hi: {
    count: (n, what) => n ? `आपके ${n} ${what} हैं।` : `कोई ${what} नहीं है।`,
    personCount: (n, who, what) => n ? `${who} के ${n} ${what} हैं।` : `${who} का कोई ${what} नहीं है।`,
    what: { mine: 'पेंडिंग टास्क', created_by_me: 'आपके दिए हुए खुले टास्क', to_approve: 'टास्क आपकी मंज़ूरी के लिए', person: 'पेंडिंग टास्क', all: 'खुले टास्क' },
    when: { overdue: 'ओवरड्यू ', today: 'आज के ', tomorrow: 'कल के ', this_week: 'इस हफ़्ते के ', any: '' },
    notFound: 'वह टास्क नहीं मिला। टास्क के नाम के कुछ शब्द बोलिए।',
    personNotFound: 'वह व्यक्ति नहीं मिला।',
    nothingToApprove: 'इस टास्क पर आपकी मंज़ूरी के लिए कुछ नहीं है।',
    confirm: { submit: (t) => `"${t}" में आपका काम पूरा मार्क करें?`, approve: (t, p) => `"${t}" पर ${p} का काम मंज़ूर करें?`, sendback: (t, p) => `"${t}" पर ${p} का काम वापस भेजें?`,
      followup: (n) => n === 1 ? 'इस टास्क पर फ़ॉलो-अप भेजें?' : `इन ${n} टास्क पर फ़ॉलो-अप भेजें?`, comment: (t) => `"${t}" पर यह कमेंट जोड़ें?` },
    create: 'आपकी बात से टास्क बना रहे हैं — जाँच कर Create दबाइए।',
    info: (t, d, n, late) => !d ? `"${t}" की कोई डेडलाइन नहीं है।` : late ? `"${t}" की डेडलाइन ${d} थी — ${-n} दिन ओवरड्यू।` : n === 0 ? `"${t}" आज (${d}) ड्यू है।` : `"${t}" की डेडलाइन ${d} है — ${n} दिन बाकी।`,
    unknown: 'माफ़ कीजिए, समझ नहीं आया। ऐसे बोलिए: "मेरे ओवरड्यू टास्क दिखाओ", "स्लैब वाला टास्क पूरा हो गया"।',
  },
  mr: {
    count: (n, what) => n ? `तुमचे ${n} ${what} आहेत.` : `एकही ${what} नाही.`,
    personCount: (n, who, what) => n ? `${who} यांचे ${n} ${what} आहेत.` : `${who} यांचे एकही ${what} नाही.`,
    what: { mine: 'प्रलंबित टास्क', created_by_me: 'तुम्ही दिलेले उघडे टास्क', to_approve: 'टास्क तुमच्या मंजुरीसाठी', person: 'प्रलंबित टास्क', all: 'उघडे टास्क' },
    when: { overdue: 'मुदत संपलेले ', today: 'आजचे ', tomorrow: 'उद्याचे ', this_week: 'या आठवड्याचे ', any: '' },
    notFound: 'तो टास्क सापडला नाही. टास्कच्या नावातले काही शब्द सांगा.',
    personNotFound: 'ती व्यक्ती सापडली नाही.',
    nothingToApprove: 'या टास्कवर तुमच्या मंजुरीसाठी काही नाही.',
    confirm: { submit: (t) => `"${t}" मधले तुमचे काम पूर्ण म्हणून नोंदवायचे?`, approve: (t, p) => `"${t}" वरचे ${p} यांचे काम मंजूर करायचे?`, sendback: (t, p) => `"${t}" वरचे ${p} यांचे काम परत पाठवायचे?`,
      followup: (n) => n === 1 ? 'या टास्कवर फॉलो-अप पाठवायचा?' : `या ${n} टास्कवर फॉलो-अप पाठवायचे?`, comment: (t) => `"${t}" वर ही कमेंट जोडायची?` },
    create: 'तुम्ही सांगितल्याप्रमाणे टास्क तयार करत आहोत — तपासून Create दाबा.',
    info: (t, d, n, late) => !d ? `"${t}" ला डेडलाइन नाही.` : late ? `"${t}" ची डेडलाइन ${d} होती — ${-n} दिवस उशीर.` : n === 0 ? `"${t}" आज (${d}) देय आहे.` : `"${t}" ची डेडलाइन ${d} आहे — ${n} दिवस बाकी.`,
    unknown: 'माफ करा, समजले नाही. असे बोला: "माझे मुदत संपलेले टास्क दाखव", "स्लॅबचे काम झाले".',
  },
};

function mountAssistant(app, deps) {
  const { db, auth, ALL_ROLES, ai, featureFlags, str, log, aiErrorStatus, dataUrlToBuffer, PROJECT_OPTIONS, rateLimiter } = deps;
  const q = (sql, params = []) => db.pool.query(sql, params);
  const pad = (n) => String(n).padStart(2, '0');
  // Wall-clock "now" in India, as YYYY-MM-DDTHH:MM (deadlines are stored the same way).
  function istNow() {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date()).filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
  }
  const addDays = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, d + n)); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`; };
  const dueAt = (d) => { if (!d) return null; const v = String(d); return /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T23:59` : v.slice(0, 16); };
  const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  const partDone = (a) => a.decision === 'approve' && !!a.completed_at;

  // Open tasks this person can see, with everyone's part.
  async function visibleOpenTasks(user) {
    const all = user.role === 'admin' || user.role === 'director';
    const r = await q(`SELECT t.id, t.title, t.project, t.deadline, t.created_by_username, a.username, a.individual_deadline, a.submitted_at, a.completed_at, a.decision, a.is_released
      FROM tasks t JOIN task_assignees a ON a.task_id = t.id
      WHERE t.status = 'open' AND t.archived_at IS NULL AND ($1::boolean OR t.created_by_username = $2
        OR EXISTS (SELECT 1 FROM task_assignees v WHERE v.task_id = t.id AND v.username = $2)
        OR EXISTS (SELECT 1 FROM task_followups f WHERE f.task_id = t.id AND f.username = $2))
      ORDER BY t.created_at DESC LIMIT 6000`, [all, user.username]);
    const byId = new Map();
    for (const row of r.rows) {
      if (!byId.has(row.id)) byId.set(row.id, { id: row.id, title: row.title, project: row.project, deadline: row.deadline, created_by: row.created_by_username, parts: [] });
      byId.get(row.id).parts.push({ username: row.username, deadline: row.individual_deadline || row.deadline, submitted: !!row.submitted_at, done: partDone(row), released: row.is_released !== 0 && row.is_released !== false });
    }
    return [...byId.values()];
  }
  function findPerson(users, name) {
    const n = norm(name); if (!n) return null;
    const exact = users.find(u => norm(u.name) === n || norm(u.username) === n);
    if (exact) return exact;
    const first = n.split(' ')[0];
    const hits = users.filter(u => norm(u.name).split(' ').includes(first) || norm(u.username).startsWith(first));
    return hits.length === 1 ? hits[0] : (hits.find(u => norm(u.name).includes(n)) || hits[0] || null);
  }
  // Pick a task: the id the AI chose (if it is one of the candidates), else the best word match.
  // Words that say what kind of question it is, not which task.
  const STOP = new Set('what is the of task tasks deadline due date status when who on for a an my me please tell show give latest last update about kab tak hai ka ki ke kya kaun chi cha che kay kadhi ahe aahe la var madhe मध्ये ची चा चे काय कधी आहे का की के है क्या कब तक'.split(' '));
  function rankTasks(list, words) {
    const w = norm(words).split(' ').filter(x => x.length > 1 && !STOP.has(x));
    if (!w.length) return [];
    const out = [];
    for (const t of list) {
      const title = norm(`${t.title} ${t.project || ''} ${t.id}`);
      const s = w.reduce((a, x) => a + (title.includes(x) ? (x.length > 3 ? 2 : 1) : 0), 0) / w.length;
      if (s >= 0.5) out.push({ t, s });
    }
    return out.sort((a, b) => b.s - a.s).map(x => x.t);
  }
  function pickTask(list, id, words) {
    if (id) { const t = list.find(x => x.id.toUpperCase() === String(id).toUpperCase()); if (t) return t; }
    const r = rankTasks(list, words);
    if (r.length) return r[0];
    return !norm(words).split(' ').some(x => x && !STOP.has(x)) && list.length === 1 ? list[0] : null;
  }
  const brief = (t, who) => {
    const p = who ? t.parts.find(x => x.username === who) : null;
    return { id: t.id, title: t.title, project: t.project || null, deadline: (p && p.deadline) || t.deadline || null };
  };

  app.post('/api/assistant/command', auth(ALL_ROLES), rateLimiter, async (req, res) => {
    const f = featureFlags();
    if (!ai.configured || !(f.voiceTasks || f.aiTaskExtraction)) return res.status(503).json({ error: 'The assistant needs the AI key (AI_API_KEY) on the server.' });
    const body = req.body || {};
    let audio = null, text = null;
    if (body.audio) {
      audio = dataUrlToBuffer(body.audio);
      if (!audio || !audio.buffer.length) return res.status(400).json({ error: 'No recording received.' });
      if (!/^audio\//.test(audio.mime)) return res.status(400).json({ error: 'That is not an audio recording.' });
      if (audio.buffer.length > 3 * 1024 * 1024) return res.status(413).json({ error: 'Keep a voice command short (under a minute).' });
    } else {
      text = str(body.text).trim();
      if (!text) return res.status(400).json({ error: 'Say or type a command.' });
      if (text.length > 1000) return res.status(400).json({ error: 'That is too long for one command.' });
    }
    const user = req.user;
    const users = await db.listUsers();
    const tasks = await visibleOpenTasks(user);
    const now = istNow(), today = now.slice(0, 10);
    // The AI sees the tasks most likely meant: mine and ones I gave first.
    const rank = (t) => (t.parts.some(p => p.username === user.username && !p.done) ? 0 : t.created_by === user.username ? 1 : 2);
    const cands = [...tasks].sort((a, b) => rank(a) - rank(b)).slice(0, 250)
      .map(t => ({ id: t.id, title: String(t.title).slice(0, 90), project: t.project, people: t.parts.map(p => (users.find(u => u.username === p.username) || {}).name || p.username).join(', ') }));
    const weekday = new Date(`${today}T12:00:00Z`).toLocaleDateString('en-IN', { weekday: 'long', timeZone: 'UTC' });
    let c;
    try {
      c = await ai.parseCommand({ text, audio, username: user.username,
        ctx: { today, weekday, me: { name: user.name, username: user.username }, people: users.map(u => ({ name: u.name, username: u.username })), projects: PROJECT_OPTIONS, tasks: cands } });
    } catch (e) { log('ERROR', 'assistant command failed', { requestId: req.id, error: e.message }); return res.status(aiErrorStatus(e)).json({ error: e.code ? e.message : 'Could not understand that right now — please try again.' }); }
    const lang = L[c.language] ? c.language : 'en';
    const T = L[lang];
    const out = { language: lang, transcript: c.transcript || text || '', intent: c.intent || 'unknown' };
    const person = c.person_name ? findPerson(users, c.person_name) : null;
    const project = c.project ? (PROJECT_OPTIONS.find(p => norm(p) === norm(c.project)) || PROJECT_OPTIONS.find(p => norm(p).includes(norm(c.project)) || norm(c.project).includes(norm(p).split(' ').pop())) || null) : null;
    const inWhen = (d, when) => {
      const at = dueAt(d); if (!when || when === 'any') return true; if (!at) return false;
      if (when === 'overdue') return at < now;
      if (when === 'today') return at.slice(0, 10) === today;
      if (when === 'tomorrow') return at.slice(0, 10) === addDays(today, 1);
      if (when === 'this_week') return at.slice(0, 10) >= today && at.slice(0, 10) <= addDays(today, 7);
      return true;
    };

    // A question about one task: deadline, status, people, latest update.
    if (out.intent === 'task_info' || (out.intent === 'show_tasks' && (c.task_id || (c.task_words && rankTasks(tasks, c.task_words).length && !c.when && !c.project && !person)))) {
      const ranked = c.task_id ? [pickTask(tasks, c.task_id, '')].filter(Boolean) : rankTasks(tasks, c.task_words || out.transcript);
      const t = ranked[0];
      if (!t) { out.intent = 'task_info'; out.reply = T.notFound; return res.json(out); }
      out.intent = 'task_info';
      const last = (await q(`SELECT by_name, by_username, message, created_at FROM task_replies WHERE task_id = $1 ORDER BY created_at DESC LIMIT 1`, [t.id])).rows[0] || null;
      const nm = (u) => (users.find(x => x.username === u) || {}).name || u;
      const at = dueAt(t.deadline);
      const days = at ? Math.round((Date.parse(`${at.slice(0, 10)}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 864e5) : null;
      const dateTxt = t.deadline ? new Date(`${String(t.deadline).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : null;
      out.reply = T.info(t.title, dateTxt, days, at && at < now);
      out.info = { task: brief(t), people: t.parts.map(p => ({ username: p.username, name: nm(p.username), done: p.done, submitted: p.submitted, deadline: p.deadline })),
        lastUpdate: last ? { by: last.by_name || nm(last.by_username), message: String(last.message || '').slice(0, 400), at: last.created_at } : null };
      out.list = ranked.length > 1 ? { scope: 'match', total: ranked.length - 1, tasks: ranked.slice(1, 6).map(x => brief(x)) } : null;
      if (out.list) out.list.label = 'Other matching tasks';
      return res.json(out);
    }
    if (out.intent === 'show_tasks') {
      let scope = c.scope || 'mine';
      // "all" with nothing to narrow it (Admin would get thousands) means my own tasks.
      if (scope === 'all' && (!c.when || c.when === 'any') && !c.project && !person) scope = 'mine';
      if (scope === 'person' && !person) { out.reply = T.personNotFound; return res.json(out); }
      if (person && person.username === user.username) scope = 'mine';
      const when = c.when || 'any';
      let list = [];
      if (scope === 'mine') list = tasks.filter(t => t.parts.some(p => p.username === user.username && !p.done && inWhen(p.deadline, when))).map(t => brief(t, user.username));
      else if (scope === 'person') list = tasks.filter(t => t.parts.some(p => p.username === person.username && !p.done && inWhen(p.deadline, when))).map(t => brief(t, person.username));
      else if (scope === 'created_by_me') list = tasks.filter(t => t.created_by === user.username && inWhen(t.deadline, when)).map(t => brief(t));
      else if (scope === 'to_approve') list = tasks.filter(t => (t.created_by === user.username || user.role === 'admin') && t.parts.some(p => p.submitted && !p.done))
        .map(t => ({ ...brief(t), waiting: t.parts.filter(p => p.submitted && !p.done).map(p => p.username) }));
      else list = tasks.filter(t => inWhen(t.deadline, when)).map(t => brief(t));
      if (project) list = list.filter(t => t.project === project);
      list.sort((a, b) => String(dueAt(a.deadline) || '9999').localeCompare(String(dueAt(b.deadline) || '9999')));
      const what = `${scope === 'to_approve' ? '' : T.when[when] || ''}${T.what[scope] || T.what.mine}${scope !== 'to_approve' && T.whenAfter ? T.whenAfter[when] || '' : ''}${project ? ` (${project})` : ''}`;
      out.reply = scope === 'person' ? T.personCount(list.length, person.name, what) : T.count(list.length, what);
      out.list = { scope, when, project, person: person ? { username: person.username, name: person.name } : null, total: list.length, tasks: list.slice(0, 40) };
      return res.json(out);
    }
    if (out.intent === 'create_task') { out.reply = T.create; out.createText = out.transcript; return res.json(out); }

    if (out.intent === 'mark_done') {
      const mine = tasks.filter(t => t.parts.some(p => p.username === user.username && !p.done));
      const t = pickTask(mine, c.task_id, c.task_words || out.transcript);
      if (!t) { out.reply = T.notFound; out.choices = mine.slice(0, 8).map(x => brief(x, user.username)); return res.json(out); }
      out.reply = T.confirm.submit(t.title);
      out.action = { kind: 'submit', task: brief(t, user.username), note: c.note || out.transcript };
      return res.json(out);
    }
    if (out.intent === 'approve' || out.intent === 'send_back') {
      const canDecide = tasks.filter(t => (t.created_by === user.username || user.role === 'admin') && t.parts.some(p => p.submitted && !p.done));
      let pool = canDecide;
      if (person) pool = pool.filter(t => t.parts.some(p => p.username === person.username && p.submitted && !p.done));
      const t = pickTask(pool, c.task_id, c.task_words || '') || (pool.length === 1 ? pool[0] : null);
      if (!t) { out.reply = pool.length ? T.notFound : T.nothingToApprove; out.choices = pool.slice(0, 8).map(x => brief(x)); return res.json(out); }
      const waiting = t.parts.filter(p => p.submitted && !p.done);
      const who = (person && waiting.find(p => p.username === person.username)) || (waiting.length === 1 ? waiting[0] : null);
      if (!who) { out.reply = T.nothingToApprove; return res.json(out); }
      const pName = (users.find(u => u.username === who.username) || {}).name || who.username;
      const kind = out.intent === 'approve' ? 'approve' : 'sendback';
      out.reply = kind === 'approve' ? T.confirm.approve(t.title, pName) : T.confirm.sendback(t.title, pName);
      out.action = { kind, task: brief(t), username: who.username, personName: pName, note: kind === 'sendback' ? (c.note || '') : '' };
      return res.json(out);
    }
    if (out.intent === 'follow_up') {
      let list = [];
      const t = pickTask(tasks, c.task_id, c.task_words || '');
      if (t && (c.task_id || !person)) list = [t];
      else if (person) list = tasks.filter(x => x.parts.some(p => p.username === person.username && !p.done));
      if (!list.length) { out.reply = person ? T.personCount(0, person.name, T.what.person) : T.notFound; return res.json(out); }
      out.reply = T.confirm.followup(Math.min(list.length, 20));
      out.action = { kind: 'followup', tasks: list.slice(0, 20).map(x => brief(x, person && person.username)), person: person ? person.name : null };
      return res.json(out);
    }
    if (out.intent === 'comment') {
      const t = pickTask(tasks, c.task_id, c.task_words || '');
      if (!t) { out.reply = T.notFound; return res.json(out); }
      out.reply = T.confirm.comment(t.title);
      out.action = { kind: 'comment', task: brief(t), note: c.note || '' };
      return res.json(out);
    }
    out.intent = 'unknown'; out.reply = T.unknown;
    res.json(out);
  });
}

module.exports = { mountAssistant, L };
