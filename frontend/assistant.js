/* Voice assistant — a 🎙 button on every page (when the AI key is set).
   Speak or type one command in Marathi, Hindi or English:
     "show my overdue tasks" · "आज के टास्क दिखाओ" · "Amara che pending tasks dakhav"
     "slab cha kaam jhala" / "mark the scaffolding task done"   → confirm card → submits your part
     "approve Ruchita's carpet task" / "send back … because photos missing" → confirm card
     "follow up on Harsh's tasks" · "add comment on slab: vendor comes tomorrow" · "create a task for …"
   Nothing changes until Confirm is pressed; the confirm calls the normal endpoints (same permissions).
   The answer is shown and read aloud in the same language (🔊 can be switched off).
   Server: POST /api/assistant/command (backend/assistant.js). Loaded after app.js. */
(function () {
  const A = { open: false, busy: false, res: null, text: '', err: '', sending: false, done: null, note: '', speak: true };
  try { A.speak = localStorage.getItem('ls_asst_speak') !== 'off'; } catch (e) {}
  const DONE = {
    en: { submit: 'Done — your part was sent for approval.', approve: 'Approved.', sendback: 'Sent back.', followup: (n) => `Follow-up sent on ${n} task${n > 1 ? 's' : ''}.`, comment: 'Comment added.', create: 'Draft ready in Suggestions — check it and press Create.' },
    hi: { submit: 'हो गया — आपका काम मंज़ूरी के लिए भेज दिया।', approve: 'मंज़ूर कर दिया।', sendback: 'वापस भेज दिया।', followup: (n) => `${n} टास्क पर फ़ॉलो-अप भेज दिया।`, comment: 'कमेंट जोड़ दिया।', create: 'टास्क का ड्राफ़्ट Suggestions में तैयार है।' },
    mr: { submit: 'झाले — तुमचे काम मंजुरीसाठी पाठवले.', approve: 'मंजूर केले.', sendback: 'परत पाठवले.', followup: (n) => `${n} टास्कवर फॉलो-अप पाठवला.`, comment: 'कमेंट जोडली.', create: 'टास्कचा मसुदा Suggestions मध्ये तयार आहे.' },
  };
  const e = (s) => (typeof esc === 'function' ? esc(s) : String(s == null ? '' : s));
  const on = () => typeof session !== 'undefined' && session && typeof appFeatures !== 'undefined' && appFeatures && appFeatures.assistant;
  const root = document.createElement('div'); root.id = 'asst-root';
  const mount = () => { if (!root.isConnected) document.body.appendChild(root); };
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);

  // ---- speech
  function say(text, lang) {
    if (!A.speak || !text || !window.speechSynthesis) return;
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      const want = { mr: ['mr-IN', 'hi-IN', 'en-IN'], hi: ['hi-IN', 'en-IN'], en: ['en-IN', 'en-GB', 'en-US'] }[lang] || ['en-IN'];
      const voices = window.speechSynthesis.getVoices() || [];
      for (const w of want) { const v = voices.find(x => x.lang === w) || voices.find(x => x.lang && x.lang.startsWith(w.slice(0, 2))); if (v) { u.voice = v; u.lang = v.lang; break; } }
      if (!u.lang) u.lang = want[0];
      u.rate = 1;
      window.speechSynthesis.speak(u);
    } catch (err) {}
  }
  if (window.speechSynthesis) window.speechSynthesis.onvoiceschanged = () => {};

  const recording = () => typeof rec !== 'undefined' && rec.recorder && rec.kind === 'assistant';
  const due = (d) => { if (!d) return ''; try { return typeof fmtDate === 'function' ? fmtDate(d) : d; } catch (er) { return d; } };
  const pn = (u) => (typeof personName === 'function' ? personName(u) : u);
  const late = (d) => { if (!d) return false; const v = String(d); const at = /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T23:59` : v.slice(0, 16); const now = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 16); return at < now; };

  function taskRow(t, extra) {
    return `<div class="asst-task"><div style="min-width:0;flex:1;"><div class="asst-task-title">${e(t.title)} <span class="mono small muted">${e(t.id)}</span></div>
      <div class="small ${late(t.deadline) ? 'asst-late' : 'muted'}">${t.project ? `📁 ${e(t.project)} · ` : ''}${t.deadline ? `${late(t.deadline) ? '⚠️ Overdue · was due' : 'Due'} ${e(due(t.deadline))}` : 'No deadline'}${t.waiting ? ` · waiting: ${e(t.waiting.map(pn).join(', '))}` : ''}</div></div>
      ${extra || ''}<button type="button" class="btn btn-sm" data-asst-open="${e(t.id)}">Open ›</button></div>`;
  }
  function actionHTML(a) {
    if (A.done) return `<div class="asst-done">✓ ${e(A.done)}</div>`;
    const btn = (label, cls) => `<button type="button" class="btn btn-sm ${cls || 'btn-primary'}" data-asst-confirm="1" ${A.sending ? 'disabled' : ''}>${A.sending ? 'Working…' : label}</button>`;
    const cancel = '<button type="button" class="btn btn-sm" data-asst-cancel="1">Cancel</button>';
    if (a.kind === 'followup') return `<div class="asst-confirm"><div class="asst-btns">${btn(`📣 Send follow-up${a.tasks.length > 1 ? `s (${a.tasks.length})` : ''}`)}${cancel}</div>${a.tasks.map(t => taskRow(t)).join('')}</div>`;
    const task = taskRow(a.task);
    if (a.kind === 'submit') return `<div class="asst-confirm">${task}<label class="small" for="asst-note">What was done (sent with your part)</label><textarea id="asst-note" rows="2">${e(A.note)}</textarea><div class="asst-btns">${btn('✓ Mark my part done')}${cancel}</div></div>`;
    if (a.kind === 'approve') return `<div class="asst-confirm">${task}<div class="small">Work by <b>${e(a.personName)}</b></div><div class="asst-btns">${btn(`✓ Approve ${e(a.personName)}'s part`)}${cancel}</div></div>`;
    if (a.kind === 'sendback') return `<div class="asst-confirm">${task}<div class="small">Work by <b>${e(a.personName)}</b></div><label class="small" for="asst-note">What should they fix? (at least 5 characters)</label><textarea id="asst-note" rows="2">${e(A.note)}</textarea><div class="asst-btns">${btn('↩ Send back', 'btn-danger')}${cancel}</div></div>`;
    if (a.kind === 'comment') return `<div class="asst-confirm">${task}<label class="small" for="asst-note">Comment</label><textarea id="asst-note" rows="2">${e(A.note)}</textarea><div class="asst-btns">${btn('💬 Add comment')}${cancel}</div></div>`;
    return '';
  }
  function panelHTML() {
    const r = A.res;
    const isRec = recording();
    return `<div class="asst-sheet" role="dialog" aria-label="Assistant">
      <div class="asst-head"><b>🎙 Assistant</b><span class="small muted">मराठी · हिंदी · English</span>
        <button type="button" class="asst-icon" data-asst-speak="1" title="${A.speak ? 'Answers are read aloud — tap to turn off' : 'Tap to read answers aloud'}">${A.speak ? '🔊' : '🔇'}</button>
        <button type="button" class="asst-icon" data-asst-close="1" aria-label="Close">✕</button></div>
      <div class="asst-body">
        <div class="asst-mic-row">
          <button type="button" class="asst-mic ${isRec ? 'rec' : ''}" data-asst-mic="1" ${A.busy ? 'disabled' : ''}>${isRec ? '■' : A.busy ? '…' : '🎤'}</button>
          <div class="small">${isRec ? `Listening… <span id="rec-timer">0:00</span> — tap ■ when finished` : A.busy ? 'Understanding…' : 'Tap 🎤 and speak, or type below'}</div>
        </div>
        <div class="asst-type"><input type="text" id="asst-text" value="${e(A.text)}" placeholder="e.g. show my overdue tasks / आज के टास्क / माझे पेंडिंग टास्क" ${A.busy ? 'disabled' : ''}><button type="button" class="btn btn-sm btn-primary" data-asst-send="1" ${A.busy ? 'disabled' : ''}>Ask</button></div>
        ${A.err ? `<div class="asst-err">${e(A.err)}</div>` : ''}
        ${r ? `<div class="asst-result">
          ${r.transcript ? `<div class="small muted">You said: “${e(r.transcript)}”</div>` : ''}
          <div class="asst-reply">${e(r.reply || '')} <button type="button" class="asst-icon" data-asst-repeat="1" title="Read aloud">🔈</button></div>
          ${r.list ? `<div class="asst-list">${r.list.tasks.map(t => taskRow(t)).join('')}${r.list.total > r.list.tasks.length ? `<div class="small muted">Showing ${r.list.tasks.length} of ${r.list.total}.</div>` : ''}</div>` : ''}
          ${r.action ? actionHTML(r.action) : ''}
          ${!r.action && r.choices && r.choices.length ? `<div class="small muted" style="margin-top:6px;">Did you mean one of these?</div><div class="asst-list">${r.choices.map(t => taskRow(t, r.intent === 'mark_done' ? `<button type="button" class="btn btn-sm" data-asst-pick="${e(t.id)}">This one</button>` : '')).join('')}</div>` : ''}
          ${r.intent === 'create_task' && A.done ? `<div class="asst-done">✓ ${e(A.done)}</div>` : ''}
        </div>` : `<div class="asst-tips small muted">Try: “show my overdue tasks” · “Harsh che pending tasks” · “स्लैब वाला काम हो गया” · “approve Ruchita's carpet task” · “follow up on Komal” · “add comment on slab: vendor comes tomorrow”</div>`}
      </div></div>`;
  }
  function draw() {
    mount();
    if (!on()) { root.innerHTML = ''; return; }
    const focusId = document.activeElement && root.contains(document.activeElement) ? document.activeElement.id : null;
    root.innerHTML = `${A.open ? `<div class="asst-backdrop" data-asst-close="1"></div>${panelHTML()}` : ''}<button type="button" class="asst-fab ${A.open ? 'hide' : ''}" data-asst-fab="1" title="Assistant — speak or type a command">🎙</button>`;
    if (focusId) { const n = document.getElementById(focusId); if (n) { n.focus(); if (n.setSelectionRange && n.value) n.setSelectionRange(n.value.length, n.value.length); } }
  }
  async function ask(payload) {
    A.busy = true; A.err = ''; A.res = null; A.done = null; draw();
    try {
      const r = await api('/api/assistant/command', { method: 'POST', body: JSON.stringify(payload) });
      A.res = r; A.note = (r.action && r.action.note) || '';
      A.busy = false; draw(); say(r.reply, r.language);
      if (r.intent === 'create_task' && r.createText) {
        try {
          await api('/api/ingestion', { method: 'POST', body: JSON.stringify({ text: r.createText }) });
          A.done = (DONE[r.language] || DONE.en).create; draw();
          if (typeof refreshData === 'function') refreshData();
        } catch (er) { A.err = er.message; draw(); }
      }
    } catch (er) { A.busy = false; A.err = er.message || 'Something went wrong.'; draw(); }
  }
  async function confirm() {
    const r = A.res, a = r && r.action; if (!a || A.sending) return;
    const D = DONE[r.language] || DONE.en;
    const note = String(A.note || '').trim();
    if ((a.kind === 'submit' || a.kind === 'sendback') && note.length < 5) { A.err = a.kind === 'submit' ? 'Write a few words about what was done (at least 5 characters).' : 'Write what should be fixed (at least 5 characters).'; draw(); return; }
    if (a.kind === 'comment' && !note) { A.err = 'Write the comment.'; draw(); return; }
    A.sending = true; A.err = ''; draw();
    try {
      const id = (x) => encodeURIComponent(x);
      if (a.kind === 'submit') await api(`/api/tasks/${id(a.task.id)}/submit-mine`, { method: 'POST', body: JSON.stringify({ note }) });
      else if (a.kind === 'approve') await api(`/api/tasks/${id(a.task.id)}/approve/${id(a.username)}`, { method: 'POST' });
      else if (a.kind === 'sendback') await api(`/api/tasks/${id(a.task.id)}/reject/${id(a.username)}`, { method: 'POST', body: JSON.stringify({ reason: note }) });
      else if (a.kind === 'comment') await api(`/api/tasks/${id(a.task.id)}/reply`, { method: 'POST', body: JSON.stringify({ message: note }) });
      else if (a.kind === 'followup') {
        let ok = 0; const errs = [];
        for (const t of a.tasks) { try { await api(`/api/tasks/${id(t.id)}/nudge`, { method: 'POST' }); ok++; } catch (er) { errs.push(er.message); } }
        if (!ok && errs.length) throw new Error(errs[0]);
        A.done = D.followup(ok);
      }
      if (!A.done) A.done = D[a.kind];
      A.sending = false; draw(); say(A.done, r.language);
      if (typeof refreshData === 'function') refreshData();
    } catch (er) { A.sending = false; A.err = er.message; draw(); }
  }
  async function toggleMic() {
    if (A.busy) return;
    if (recording()) {
      const out = await stopRecording(); draw();
      if (!out || !out.blob || out.blob.size < 500) { A.err = 'Nothing was recorded — hold the phone closer and try again.'; draw(); return; }
      ask({ audio: await blobToDataUrl(out.blob) });
      return;
    }
    if (typeof rec !== 'undefined' && rec.recorder) { A.err = 'Another recording is running — stop it first.'; draw(); return; }
    A.err = ''; A.res = null; A.done = null;
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    const okRec = await startRecording('assistant', 60000);
    if (okRec) { rec.onDone = null; }
    draw();
  }
  root.addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-asst-fab],[data-asst-close],[data-asst-mic],[data-asst-send],[data-asst-confirm],[data-asst-cancel],[data-asst-open],[data-asst-speak],[data-asst-repeat],[data-asst-pick]');
    if (!t) return;
    ev.preventDefault();
    if (t.dataset.asstFab) { A.open = true; draw(); const n = document.getElementById('asst-text'); if (n && window.innerWidth > 700) n.focus(); return; }
    if (t.dataset.asstClose) { if (recording()) stopRecording(); A.open = false; if (window.speechSynthesis) window.speechSynthesis.cancel(); draw(); return; }
    if (t.dataset.asstMic) { toggleMic(); return; }
    if (t.dataset.asstSend) { const v = String(A.text || '').trim(); if (v) ask({ text: v }); return; }
    if (t.dataset.asstConfirm) { confirm(); return; }
    if (t.dataset.asstCancel) { A.res = Object.assign({}, A.res, { action: null }); A.err = ''; draw(); return; }
    if (t.dataset.asstSpeak) { A.speak = !A.speak; try { localStorage.setItem('ls_asst_speak', A.speak ? 'on' : 'off'); } catch (er) {} if (!A.speak && window.speechSynthesis) window.speechSynthesis.cancel(); draw(); return; }
    if (t.dataset.asstRepeat) { const was = A.speak; A.speak = true; say(A.res && A.res.reply, A.res && A.res.language); A.speak = was; return; }
    if (t.dataset.asstPick) { const c = (A.res.choices || []).find(x => x.id === t.dataset.asstPick); if (c) { A.res = Object.assign({}, A.res, { action: { kind: 'submit', task: c, note: A.res.transcript }, choices: [] }); A.note = A.res.transcript; draw(); } return; }
    if (t.dataset.asstOpen) { A.open = false; draw(); if (typeof openTaskOnMyTasks === 'function') openTaskOnMyTasks(t.dataset.asstOpen); return; }
  });
  root.addEventListener('input', (ev) => {
    if (ev.target.id === 'asst-text') A.text = ev.target.value;
    if (ev.target.id === 'asst-note') A.note = ev.target.value;
  });
  root.addEventListener('keydown', (ev) => { if (ev.target.id === 'asst-text' && ev.key === 'Enter') { ev.preventDefault(); const v = String(A.text || '').trim(); if (v && !A.busy) ask({ text: v }); } });
  // The 🎙 button follows sign-in / feature changes; while recording, keep the timer moving.
  let last = '';
  setInterval(() => { const k = `${on() ? 1 : 0}|${recording() ? 1 : 0}`; if (k !== last) { last = k; draw(); } }, 800);
  window.openAssistant = () => { A.open = true; draw(); };
})();
