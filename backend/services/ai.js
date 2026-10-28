// AI service — the ONLY place that talks to an AI provider. Application code calls
// ai.extractTasks() / ai.processAudio(); providers are swappable (AI_PROVIDER=gemini | mock).
// Every call: budget check first, usage + ₹ cost logged after, structured JSON out. The AI never
// touches the database or sends anything — it returns proposals that the app validates and a
// person confirms.
const PRICES_USD_PER_M = { // approximate published 2026 list prices; adjust via AI_PRICE_* if they change
  'gemini-3.5-flash-lite': { in: 0.10, out: 0.40, audioIn: 0.30 }, // estimate — set to the published price when known
  'gemini-3.5-flash': { in: 0.30, out: 2.50, audioIn: 1.00 },       // estimate
  'gemini-2.5-flash-lite': { in: 0.10, out: 0.40, audioIn: 0.30 },
  'gemini-2.5-flash': { in: 0.30, out: 2.50, audioIn: 1.00 },
};
class AIBudgetExceeded extends Error { constructor(spent, budget) { super(`Monthly AI budget reached (₹${spent.toFixed(0)} of ₹${budget}). Create the task manually, or ask Admin to raise MONTHLY_AI_BUDGET_INR.`); this.code = 'AI_BUDGET'; } }
class AINotConfigured extends Error { constructor() { super('AI is not configured (AI_PROVIDER / AI_API_KEY).'); this.code = 'AI_NOT_CONFIGURED'; } }

const TASK_ITEM_SCHEMA = {
  type: 'OBJECT',
  properties: {
    is_action: { type: 'BOOLEAN' }, kind: { type: 'STRING', enum: ['action', 'decision', 'discussion', 'question'] },
    title: { type: 'STRING' }, description: { type: 'STRING', nullable: true },
    assignee_names: { type: 'ARRAY', items: { type: 'STRING' } },
    deadline_date: { type: 'STRING', nullable: true }, deadline_time: { type: 'STRING', nullable: true },
    priority: { type: 'STRING', enum: ['low', 'medium', 'high'], nullable: true }, project: { type: 'STRING', nullable: true },
    confidence: { type: 'NUMBER' },
  },
  required: ['is_action', 'kind', 'title', 'assignee_names', 'confidence'],
};
const EXTRACT_SCHEMA = { type: 'OBJECT', properties: { language: { type: 'STRING' }, normalized_text: { type: 'STRING' }, transcript: { type: 'STRING', nullable: true },
  summary: { type: 'STRING', nullable: true }, decisions: { type: 'ARRAY', items: { type: 'STRING' } }, risks: { type: 'ARRAY', items: { type: 'STRING' } },
  tasks: { type: 'ARRAY', items: TASK_ITEM_SCHEMA } }, required: ['language', 'tasks'] };

// Voice / typed commands for the assistant (Marathi, Hindi, English or a mix).
const COMMAND_SCHEMA = { type: 'OBJECT', properties: {
  language: { type: 'STRING', enum: ['mr', 'hi', 'en'] }, transcript: { type: 'STRING' },
  intent: { type: 'STRING', enum: ['show_tasks', 'mark_done', 'approve', 'send_back', 'follow_up', 'comment', 'create_task', 'unknown'] },
  scope: { type: 'STRING', enum: ['mine', 'created_by_me', 'to_approve', 'person', 'all'], nullable: true },
  when: { type: 'STRING', enum: ['overdue', 'today', 'tomorrow', 'this_week', 'any'], nullable: true },
  project: { type: 'STRING', nullable: true }, person_name: { type: 'STRING', nullable: true },
  task_id: { type: 'STRING', nullable: true }, task_words: { type: 'STRING', nullable: true }, note: { type: 'STRING', nullable: true },
}, required: ['language', 'transcript', 'intent'] };
function commandInstructions({ today, weekday, me, people, projects, tasks }) {
  return [
    'You are the voice assistant of the MIHIR Task Manager (a construction company in India). Understand ONE command in Marathi, Hindi, English or any mix and return JSON only.',
    `Today is ${weekday} ${today} (Asia/Kolkata). The speaker is ${me.name} (${me.username}).`,
    'language: the main language spoken (mr = Marathi, hi = Hindi, en = English). transcript: exactly what was said, in the original language and script.',
    'intent: show_tasks (list / how many / which tasks …), mark_done (my work on a task is finished — "ho gaya", "jhala", "complete", "done"), approve (approve someone\'s submitted work), send_back (reject / return someone\'s work with a reason), follow_up (remind / chase people on a task or a person\'s tasks), comment (add a note / update on a task), create_task (give someone new work), unknown.',
    'scope for show_tasks: mine (my own work, default), created_by_me (tasks I gave others), to_approve (work waiting for my approval), person (someone else\'s tasks — set person_name), all.',
    'when: overdue / today / tomorrow / this_week / any. project: one of PROJECTS if mentioned (e.g. Amara → Mihir Amara, Equinox → Nyati Equinox, Tathawade → Sierra (Tathawade)).',
    'person_name: the person mentioned, as in PEOPLE. task_id: the id from TASKS that the command is about, only if clearly identifiable; task_words: the words that describe the task. note: the comment / reason / what was done, in the original language.',
    `PEOPLE: ${people.map(p => `${p.name} (${p.username})`).join('; ')}`,
    `PROJECTS: ${projects.join('; ')}`,
    `TASKS (id | title | project | people): ${tasks.map(t => `${t.id} | ${t.title} | ${t.project || ''} | ${t.people || ''}`).join('\n')}`,
  ].join('\n');
}

function instructions({ mode, today, weekday, people, projects }) {
  return [
    'You turn construction-company messages into task proposals for the MIHIR Task Manager. Output JSON only.',
    `Today is ${weekday} ${today} (Asia/Kolkata). Resolve relative dates ("tomorrow", "उद्या", "kal", "Friday", "parso") to YYYY-MM-DD; times to HH:MM 24h.`,
    'Input may be English, Marathi, Hindi or any mix. Write task titles/descriptions in clear English; keep "transcript" in the ORIGINAL language exactly as spoken.',
    'Only real ACTIONS someone must do become tasks with is_action=true. Mere discussion ("we discussed the quotation"), decisions without an implied action, and questions without a clear assignee are NOT actions — mark kind accordingly and is_action=false.',
    'assignee_names: only people clearly asked to act, using names from the PEOPLE list when they match; never invent people. Leave empty if unclear.',
    'confidence 0–1: how sure you are this is a real, correctly understood task. Be conservative with unclear speech.',
    mode === 'meeting' ? 'This is a meeting recording: also give a short English summary, decisions and risks.' : 'Keep summary/decisions/risks empty unless obvious.',
    `PEOPLE: ${people.map(p => `${p.name} (${p.username})`).join('; ')}`,
    projects.length ? `PROJECTS: ${projects.join('; ')}` : '',
  ].filter(Boolean).join('\n');
}

function createAI({ pool, env = process.env, fetchImpl = fetch, log = () => {}, onBudgetAlert = async () => {} }) {
  const provider = (env.AI_PROVIDER || (env.AI_API_KEY ? 'gemini' : '')).toLowerCase();
  // Google retires older models for new keys; try the configured model first, then newer → older ones,
  // and remember the first that works (e.g. "gemini-2.5-flash-lite is no longer available to new users").
  const MODEL_CHAIN = [...new Set([env.AI_MODEL, 'gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-flash'].filter(Boolean))];
  let model = MODEL_CHAIN[0];
  const usdInr = Number(env.USD_INR) || 88;
  const budgetInr = Number(env.MONTHLY_AI_BUDGET_INR) || 1000;
  const alertAt = Number(env.AI_COST_ALERT_THRESHOLD) || 0.8;
  const budgetOn = !/^(0|false|no|off)$/i.test(String(env.ENABLE_AI_BUDGET_LIMIT || 'true'));
  const configured = provider === 'mock' || (provider === 'gemini' && !!env.AI_API_KEY);

  async function monthSpendInr() {
    const r = await pool.query("SELECT COALESCE(SUM(cost_inr),0)::float AS s FROM ai_usage_events WHERE created_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'");
    return r.rows[0].s;
  }
  async function guardBudget() {
    if (!budgetOn) return;
    const spent = await monthSpendInr();
    if (spent >= budgetInr) throw new AIBudgetExceeded(spent, budgetInr);
    if (spent >= budgetInr * alertAt) await onBudgetAlert({ spent, budget: budgetInr });
  }
  async function record({ feature, source, username, taskId, inTokens, outTokens, audio }) {
    const p = PRICES_USD_PER_M[model] || PRICES_USD_PER_M['gemini-3.5-flash-lite'];
    const usd = provider === 'mock' ? 0 : ((inTokens * (audio ? p.audioIn : p.in)) + outTokens * p.out) / 1e6;
    await pool.query(`INSERT INTO ai_usage_events (feature, provider, model, input_tokens, output_tokens, cost_usd, cost_inr, username, task_id, source)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [feature, provider, provider === 'mock' ? 'mock' : model, inTokens, outTokens, usd, usd * usdInr, username || null, taskId || null, source || null]);
  }

  async function geminiPost(body) {
    let lastErr = null;
    for (let i = Math.max(0, MODEL_CHAIN.indexOf(model)); i < MODEL_CHAIN.length; i++) {
      const m = MODEL_CHAIN[i];
      const res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent`,
        { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.AI_API_KEY }, body: JSON.stringify(body) });
      if (res.ok) { if (m !== model) { log('WARN', 'AI model switched', { from: model, to: m }); model = m; } return res.json(); }
      const text = await res.text().catch(() => '');
      lastErr = new Error(`AI provider error (${res.status}): ${text.slice(0, 200)}`);
      // Only a missing / retired model moves on to the next one; other errors (bad key, quota) stop here.
      if (!(res.status === 404 || (res.status === 400 && /not (found|supported)|no longer available/i.test(text)))) throw lastErr;
    }
    throw lastErr;
  }

  async function gemini(parts, systemText) {
    const j = await geminiPost({ systemInstruction: { parts: [{ text: systemText }] }, contents: [{ role: 'user', parts }],
        generationConfig: { temperature: 0.1, responseMimeType: 'application/json', responseSchema: EXTRACT_SCHEMA } });
    const text = (((j.candidates || [])[0] || {}).content || {}).parts?.map(x => x.text || '').join('') || '';
    let out; try { out = JSON.parse(text); } catch (e) { throw new Error('AI returned malformed output'); }
    return { out, inTokens: (j.usageMetadata || {}).promptTokenCount || 0, outTokens: (j.usageMetadata || {}).candidatesTokenCount || 0 };
  }

  // Deterministic stand-in used for tests and demos (AI_PROVIDER=mock): understands simple English /
  // Hinglish / Marathi phrasing with names from the people list and common date words.
  function mock(text, ctx) {
    const today = new Date(ctx.today + 'T12:00:00');
    const addDays = n => { const d = new Date(today); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
    const sentences = String(text).split(/(?<=[.!?।])\s+|\n+/).map(s => s.trim()).filter(s => s && !/^subject:/i.test(s)); // an email subject is context, not a task
    const tasks = [];
    for (const s of sentences) {
      const low = s.toLowerCase();
      if (/\b(we discussed|discussed|discussion)\b/.test(low)) { tasks.push({ is_action: false, kind: 'discussion', title: s, assignee_names: [], confidence: 0.9 }); continue; }
      if (/\b(we will use|decided|decision)\b/.test(low)) { tasks.push({ is_action: false, kind: 'decision', title: s, assignee_names: [], confidence: 0.85 }); continue; }
      const who = ctx.people.filter(p => low.includes(p.name.toLowerCase().split(' ')[0]) || low.includes(p.username.toLowerCase())).map(p => p.name);
      let date = null;
      if (/\b(tomorrow|kal)\b|उद्या/.test(low)) date = addDays(1); else if (/\b(today|aaj)\b|आज/.test(low)) date = addDays(0);
      else { const wd = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].findIndex(w => low.includes(w)); if (wd >= 0) { let n = (wd - today.getDay() + 7) % 7; if (n === 0) n = 7; date = addDays(n); } }
      const tm = low.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/); let time = null;
      if (tm) { let h = +tm[1] % 12; if (tm[3] === 'pm') h += 12; time = `${String(h).padStart(2, '0')}:${tm[2] || '00'}`; }
      const isQuestion = /\?$/.test(s) && !who.length;
      tasks.push({ is_action: !isQuestion, kind: isQuestion ? 'question' : 'action', title: s.replace(/[.!?।]+$/, ''), description: null, assignee_names: who,
        deadline_date: date, deadline_time: time, priority: /\burgent\b/.test(low) ? 'high' : null, project: (ctx.projects.find(p => low.includes(p.toLowerCase())) || null),
        confidence: who.length && date ? 0.9 : who.length || date ? 0.7 : 0.4 });
    }
    const lang = /[\u0900-\u097F]/.test(text) ? 'mr/hi+en' : 'en';
    return { language: lang, normalized_text: text, transcript: text, summary: ctx.mode === 'meeting' ? `Meeting with ${tasks.filter(t => t.is_action).length} action item(s).` : null,
      decisions: tasks.filter(t => t.kind === 'decision').map(t => t.title), risks: [], tasks };
  }

  // Writing help: fix spelling, grammar and punctuation of a short message, same language, nothing added.
  const FIX_RULES = [
    'You proofread short workplace messages written by staff of a construction company in India (site, purchase, accounts, design teams).',
    'Fix spelling, grammar, capitalisation and punctuation only. Keep the meaning, tone and length. Do not add or remove information, greetings or sign-offs.',
    'Keep the SAME language and mix exactly as written (English, Hinglish, Hindi, Marathi or any mix) — never translate, and never change Devanagari to Latin script or back.',
    'Keep unchanged: people and company names, @mentions (e.g. @tanishq.m), numbers, amounts, dates, units (sqm, cum, MT, bags), codes (TASK-…, BILL-…, JMR-…), product codes, emojis, line breaks and list layout.',
    'If the text is already correct, return it unchanged. Return ONLY the corrected text — no quotes, notes or explanations.',
  ].join('\n');
  function mockFix(text) {
    let t = String(text).replace(/[ \t]{2,}/g, ' ').replace(/ +([,.!?])/g, '$1').replace(/\bi\b/g, 'I').replace(/\b(dont|cant|wont|didnt|isnt)\b/gi, m => ({ dont: "don't", cant: "can't", wont: "won't", didnt: "didn't", isnt: "isn't" })[m.toLowerCase()] || m);
    t = t.split('\n').map(l => l.replace(/^(\s*)([a-z])/, (m, sp, c) => sp + c.toUpperCase())).join('\n').trim();
    if (t && !/[.!?…:)\]]$/.test(t) && !/^[-•*]/m.test(t)) t += '.';
    return t;
  }
  async function fixText({ text, username }) {
    if (!configured) throw new AINotConfigured();
    await guardBudget();
    if (provider === 'mock') {
      await record({ feature: 'writing_fix', source: 'writing', username, inTokens: Math.ceil(text.length / 4), outTokens: Math.ceil(text.length / 4) });
      return mockFix(text);
    }
    const j = await geminiPost({ systemInstruction: { parts: [{ text: FIX_RULES }] }, contents: [{ role: 'user', parts: [{ text }] }],
        generationConfig: { temperature: 0, maxOutputTokens: Math.min(4096, Math.ceil(text.length / 2) + 200) } });
    const out = ((((j.candidates || [])[0] || {}).content || {}).parts || []).map(x => x.text || '').join('').trim();
    await record({ feature: 'writing_fix', source: 'writing', username, inTokens: (j.usageMetadata || {}).promptTokenCount || 0, outTokens: (j.usageMetadata || {}).candidatesTokenCount || 0 });
    if (!out) throw new Error('AI returned nothing');
    // Guard against a runaway answer (an explanation instead of the text)
    if (out.length > text.length * 1.6 + 40) return text;
    return out;
  }

  // Short free-text answer (e.g. rephrasing a computed warning). Same budget and usage logging.
  async function complete({ system, text, feature = 'text', username, maxTokens = 300 }) {
    if (!configured) throw new AINotConfigured();
    await guardBudget();
    if (provider === 'mock') { await record({ feature, source: feature, username, inTokens: Math.ceil(text.length / 4), outTokens: 40 }); return text; }
    const j = await geminiPost({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text }] }], generationConfig: { temperature: 0.2, maxOutputTokens: maxTokens } });
    await record({ feature, source: feature, username, inTokens: (j.usageMetadata || {}).promptTokenCount || 0, outTokens: (j.usageMetadata || {}).candidatesTokenCount || 0 });
    return ((((j.candidates || [])[0] || {}).content || {}).parts || []).map(x => x.text || '').join('').trim();
  }

  // Rule-based stand-in for tests / demos (English words only).
  function mockCommand(text, ctx) {
    const t = String(text).trim(), low = t.toLowerCase();
    const person = (ctx.people || []).find(p => low.includes(p.name.toLowerCase().split(' ')[0].toLowerCase()) || low.includes(p.username.toLowerCase()));
    const proj = (ctx.projects || []).find(p => low.includes(p.toLowerCase().split(' ').pop().replace(/[()]/g, '')) || low.includes(p.toLowerCase()));
    const when = /overdue|late/.test(low) ? 'overdue' : /today/.test(low) ? 'today' : /tomorrow/.test(low) ? 'tomorrow' : /this week|week/.test(low) ? 'this_week' : 'any';
    const after = (re) => { const m = re.exec(t); return m ? m[1].trim() : null; };
    const strip = (s) => s.replace(/\b(mark|as|the|task|done|complete|completed|approve|approved|send back|follow up|on|add|comment|note|please|of|for|'s)\b/gi, ' ').replace(/[:,.]/g, ' ').replace(/\s+/g, ' ').trim();
    let intent = 'unknown', scope = null, note = null;
    if (/^(show|list|what|which|how many)/.test(low)) { intent = 'show_tasks'; scope = /approv/.test(low) ? 'to_approve' : /i gave|created by me|i created/.test(low) ? 'created_by_me' : person ? 'person' : 'mine'; }
    else if (/^(create|assign|new task|give)/.test(low) || /\btask for\b/.test(low)) intent = 'create_task';
    else if (/send back|reject|return/.test(low)) { intent = 'send_back'; note = after(/(?:because|note|reason)[: ]+(.+)$/i); }
    else if (/approve/.test(low)) intent = 'approve';
    else if (/follow up|follow-up|remind/.test(low)) intent = 'follow_up';
    else if (/^(add )?comment|^note/.test(low)) { intent = 'comment'; note = after(/:(.+)$/); }
    else if (/\b(done|complete|completed|finished)\b/.test(low)) { intent = 'mark_done'; note = after(/(?:note|because)[: ]+(.+)$/i); }
    const words = intent === 'comment' || intent === 'send_back' ? strip(t.split(/:|because/i)[0]) : strip(t.replace(person ? new RegExp(person.name.split(' ')[0], 'i') : /$^/, ''));
    return { language: /[\u0900-\u097F]/.test(t) ? 'hi' : 'en', transcript: t, intent, scope, when, project: proj || null, person_name: person ? person.name : null, task_id: null, task_words: words || null, note };
  }
  async function parseCommand({ text, audio, username, ctx }) {
    if (!configured) throw new AINotConfigured();
    await guardBudget();
    if (provider === 'mock') {
      const raw = text != null ? text : audio.buffer.toString('utf8');
      await record({ feature: 'assistant_command', source: audio ? 'voice' : 'text', username, inTokens: Math.ceil(raw.length / 4), outTokens: 60, audio: !!audio });
      return mockCommand(raw, ctx);
    }
    const parts = audio ? [{ inline_data: { mime_type: audio.mime || 'audio/webm', data: audio.buffer.toString('base64') } }, { text: 'Transcribe this voice command and interpret it.' }] : [{ text: `COMMAND:\n${text}` }];
    const j = await geminiPost({ systemInstruction: { parts: [{ text: commandInstructions(ctx) }] }, contents: [{ role: 'user', parts }],
        generationConfig: { temperature: 0.1, responseMimeType: 'application/json', responseSchema: COMMAND_SCHEMA } });
    const txt = ((((j.candidates || [])[0] || {}).content || {}).parts || []).map(x => x.text || '').join('');
    await record({ feature: 'assistant_command', source: audio ? 'voice' : 'text', username, inTokens: (j.usageMetadata || {}).promptTokenCount || 0, outTokens: (j.usageMetadata || {}).candidatesTokenCount || 0, audio: !!audio });
    try { return JSON.parse(txt); } catch (e) { throw new Error('AI returned malformed output'); }
  }

  async function run({ feature, source, username, parts, rawText, ctx, audio }) {
    if (!configured) throw new AINotConfigured();
    await guardBudget();
    let result;
    if (provider === 'mock') { result = { out: mock(rawText, ctx), inTokens: Math.ceil((rawText || '').length / 4), outTokens: 200 }; }
    else result = await gemini(parts, instructions(ctx));
    await record({ feature, source, username, inTokens: result.inTokens, outTokens: result.outTokens, audio });
    return result.out;
  }
  return {
    configured, provider: configured ? provider : null, get model() { return provider === 'mock' ? 'mock' : model; },
    extractTasks: ({ text, source, username, ctx }) => run({ feature: 'task_extraction', source, username, parts: [{ text: `MESSAGE:\n${text}` }], rawText: text, ctx: { ...ctx, mode: 'task' } }),
    // Audio → transcript (original language) + tasks in ONE call. In mock mode the "audio" bytes are read as UTF-8 text.
    processAudio: ({ buffer, mime, source, username, ctx, mode = 'task' }) => run({ feature: mode === 'meeting' ? 'meeting_transcription' : 'voice_task', source, username, audio: true,
      parts: [{ inline_data: { mime_type: mime || 'audio/webm', data: buffer.toString('base64') } }, { text: mode === 'meeting' ? 'Transcribe this meeting and extract action items, decisions and risks.' : 'Transcribe this voice note and extract the task(s).' }],
      rawText: buffer.toString('utf8'), ctx: { ...ctx, mode } }),
    // PDF / photo / video → tasks, read natively by the model. In mock mode the bytes are read as UTF-8 text.
    processMedia: ({ buffer, mime, source, username, ctx, contentType = 'document' }) => run({ feature: `${contentType}_extraction`, source, username, audio: contentType === 'video',
      parts: [{ inline_data: { mime_type: mime, data: buffer.toString('base64') } }, { text: contentType === 'video' ? 'Watch this site video (speech and visible notes) and extract the task(s). Put the spoken words in "transcript".' : 'Read this document / photo (including handwriting or scanned pages) and extract the task(s). Put the readable text in "transcript".' }],
      rawText: buffer.toString('utf8'), ctx: { ...ctx, mode: 'task' } }),
    fixText, complete, parseCommand,
    monthSpendInr, budgetInr,
    async usageSummary() {
      const r = await pool.query(`SELECT COALESCE(source, feature) AS k,
          SUM(cost_inr) FILTER (WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')::float AS today,
          SUM(cost_inr) FILTER (WHERE created_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')::float AS month,
          COUNT(*) FILTER (WHERE created_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')::int AS calls
        FROM ai_usage_events GROUP BY 1 ORDER BY 3 DESC NULLS LAST`);
      const month = r.rows.reduce((a, x) => a + (x.month || 0), 0), today = r.rows.reduce((a, x) => a + (x.today || 0), 0);
      return { todayInr: today, monthInr: month, budgetInr, bySource: r.rows };
    },
  };
}
module.exports = { createAI, AIBudgetExceeded, AINotConfigured, PRICES_USD_PER_M };
