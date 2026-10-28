// AI service — the ONLY place that talks to an AI provider. Application code calls
// ai.extractTasks() / ai.processAudio(); providers are swappable (AI_PROVIDER=gemini | mock).
// Every call: budget check first, usage + ₹ cost logged after, structured JSON out. The AI never
// touches the database or sends anything — it returns proposals that the app validates and a
// person confirms.
const PRICES_USD_PER_M = { // approximate published 2026 list prices; adjust via AI_PRICE_* if they change
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
  const model = env.AI_MODEL || 'gemini-2.5-flash-lite';
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
    const p = PRICES_USD_PER_M[model] || PRICES_USD_PER_M['gemini-2.5-flash-lite'];
    const usd = provider === 'mock' ? 0 : ((inTokens * (audio ? p.audioIn : p.in)) + outTokens * p.out) / 1e6;
    await pool.query(`INSERT INTO ai_usage_events (feature, provider, model, input_tokens, output_tokens, cost_usd, cost_inr, username, task_id, source)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [feature, provider, provider === 'mock' ? 'mock' : model, inTokens, outTokens, usd, usd * usdInr, username || null, taskId || null, source || null]);
  }

  async function gemini(parts, systemText) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.AI_API_KEY },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: systemText }] }, contents: [{ role: 'user', parts }],
        generationConfig: { temperature: 0.1, responseMimeType: 'application/json', responseSchema: EXTRACT_SCHEMA } }) });
    if (!res.ok) throw new Error(`AI provider error (${res.status}): ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const j = await res.json();
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
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.AI_API_KEY },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: FIX_RULES }] }, contents: [{ role: 'user', parts: [{ text }] }],
        generationConfig: { temperature: 0, maxOutputTokens: Math.min(4096, Math.ceil(text.length / 2) + 200) } }) });
    if (!res.ok) throw new Error(`AI provider error (${res.status}): ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const j = await res.json();
    const out = ((((j.candidates || [])[0] || {}).content || {}).parts || []).map(x => x.text || '').join('').trim();
    await record({ feature: 'writing_fix', source: 'writing', username, inTokens: (j.usageMetadata || {}).promptTokenCount || 0, outTokens: (j.usageMetadata || {}).candidatesTokenCount || 0 });
    if (!out) throw new Error('AI returned nothing');
    // Guard against a runaway answer (an explanation instead of the text)
    if (out.length > text.length * 1.6 + 40) return text;
    return out;
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
    configured, provider: configured ? provider : null, model: provider === 'mock' ? 'mock' : model,
    extractTasks: ({ text, source, username, ctx }) => run({ feature: 'task_extraction', source, username, parts: [{ text: `MESSAGE:\n${text}` }], rawText: text, ctx: { ...ctx, mode: 'task' } }),
    // Audio → transcript (original language) + tasks in ONE call. In mock mode the "audio" bytes are read as UTF-8 text.
    processAudio: ({ buffer, mime, source, username, ctx, mode = 'task' }) => run({ feature: mode === 'meeting' ? 'meeting_transcription' : 'voice_task', source, username, audio: true,
      parts: [{ inline_data: { mime_type: mime || 'audio/webm', data: buffer.toString('base64') } }, { text: mode === 'meeting' ? 'Transcribe this meeting and extract action items, decisions and risks.' : 'Transcribe this voice note and extract the task(s).' }],
      rawText: buffer.toString('utf8'), ctx: { ...ctx, mode } }),
    // PDF / photo / video → tasks, read natively by the model. In mock mode the bytes are read as UTF-8 text.
    processMedia: ({ buffer, mime, source, username, ctx, contentType = 'document' }) => run({ feature: `${contentType}_extraction`, source, username, audio: contentType === 'video',
      parts: [{ inline_data: { mime_type: mime, data: buffer.toString('base64') } }, { text: contentType === 'video' ? 'Watch this site video (speech and visible notes) and extract the task(s). Put the spoken words in "transcript".' : 'Read this document / photo (including handwriting or scanned pages) and extract the task(s). Put the readable text in "transcript".' }],
      rawText: buffer.toString('utf8'), ctx: { ...ctx, mode: 'task' } }),
    fixText,
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
