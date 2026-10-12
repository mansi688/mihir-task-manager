// Universal ingestion → AI → suggestion → human review → task. Every channel (voice, WhatsApp,
// email, meeting, pasted text) uses this one pipeline and, on acceptance, the SAME task-creation code
// as "+ New Task". Nothing here creates a task without a person accepting it.
const { buildPeopleResolver } = require('../task-import');

function createIngestion({ db, pool, ai, jobs, storage, notify, createTask, log }) {
  const MIN_CONF = Number(process.env.AI_MIN_CONFIDENCE) || 0.6;
  // Text from AI/transcription is stored as-is except control characters PostgreSQL can't hold (NUL).
  const clean = v => (v == null ? v : String(v).replace(/\u0000/g, '').replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g, ' '));
  const pad2 = n => String(n).padStart(2, '0');
  const todayIST = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };

  async function context() {
    const users = await db.listUsers();
    const projects = (await pool.query('SELECT name FROM projects ORDER BY name')).rows.map(r => r.name);
    const d = new Date();
    return { users, ctx: { today: todayIST(), weekday: d.toLocaleDateString('en-GB', { weekday: 'long' }), people: users.map(u => ({ name: u.name, username: u.username })), projects } };
  }

  // AI output → a clean, validated suggestion (people resolved by the app, not by the AI).
  function validate(raw, users, teams) {
    const resolve = buildPeopleResolver(users, teams || []);
    const assignees = [], unresolved = [];
    for (const name of raw.assignee_names || []) {
      const r = resolve(name);
      if (r.users && r.users.length) r.users.forEach(u => { if (!assignees.includes(u.username)) assignees.push(u.username); });
      else unresolved.push(name);
    }
    let deadline = null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw.deadline_date || '')) deadline = raw.deadline_date + (/^\d{2}:\d{2}$/.test(raw.deadline_time || '') ? `T${raw.deadline_time}` : '');
    const priority = ['low', 'medium', 'high'].includes(raw.priority) ? raw.priority : null;
    return { title: String(raw.title || '').trim().slice(0, 200), description: raw.description ? String(raw.description).slice(0, 5000) : null,
      assignees, unresolved, deadline, priority, project: raw.project || null,
      confidence: Math.max(0, Math.min(1, Number(raw.confidence) || 0)), kind: raw.kind || (raw.is_action ? 'action' : 'discussion'), isAction: !!raw.is_action };
  }

  async function receive({ source, sourceRef = null, submittedBy, contentType = 'text', text = null, fileId = null, metadata = {} }) {
    const r = await pool.query(`INSERT INTO ingestion_items (source, source_ref, submitted_by, content_type, original_text, file_id, metadata)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT (source, source_ref) WHERE source_ref IS NOT NULL DO NOTHING RETURNING id`,
      [source, sourceRef, submittedBy, contentType, text, fileId, JSON.stringify(metadata)]);
    if (!r.rows[0]) { const ex = await pool.query('SELECT id FROM ingestion_items WHERE source=$1 AND source_ref=$2', [source, sourceRef]); return { id: ex.rows[0].id, duplicate: true }; }
    return { id: r.rows[0].id, duplicate: false };
  }

  // Runs AI on an item and stores suggestions. audio: { buffer, mime } when the content is speech.
  async function processItem(itemId, { audio = null, media = null, mode = 'task', meetingId = null } = {}) {
    const item = (await pool.query('SELECT * FROM ingestion_items WHERE id=$1', [itemId])).rows[0];
    if (!item) throw new Error('ingestion item not found');
    if (['needs_review', 'done', 'ignored'].includes(item.status)) return { alreadyProcessed: true, suggestions: await listForItem(itemId) };
    await pool.query("UPDATE ingestion_items SET status='processing', updated_at=now() WHERE id=$1", [itemId]);
    try {
      const { users, ctx } = await context();
      const teams = await db.listTeams();
      const out = audio
        ? await ai.processAudio({ buffer: audio.buffer, mime: audio.mime, source: item.source, username: item.submitted_by, ctx, mode })
        : media
          ? await ai.processMedia({ buffer: media.buffer, mime: media.mime, contentType: media.contentType, source: item.source, username: item.submitted_by, ctx })
          : await ai.extractTasks({ text: item.original_text || '', source: item.source, username: item.submitted_by, ctx });
      for (const k of ['transcript', 'normalized_text', 'language', 'summary']) if (out[k] != null) out[k] = clean(out[k]);
      out.decisions = (out.decisions || []).map(clean); out.risks = (out.risks || []).map(clean);
      for (const t of out.tasks || []) { t.title = clean(t.title); t.description = clean(t.description); t.assignee_names = (t.assignee_names || []).map(clean); }
      const transcript = out.transcript || item.original_text || null;
      const created = [];
      // Safety cap: one message never floods anyone with suggestions (a confused model, noise, spam).
      const cap = mode === 'meeting' ? (Number(process.env.AI_MAX_SUGGESTIONS_MEETING) || 50) : (Number(process.env.AI_MAX_SUGGESTIONS) || 20);
      for (const raw of (out.tasks || []).slice(0, cap * 3)) {
        if (created.length >= cap) break;
        const v = validate(raw, users, teams);
        if (!v.isAction || !v.title.trim()) continue;
        const r = await pool.query(`INSERT INTO ai_suggestions (ingestion_id, meeting_id, title, description, assignees, unresolved_names, deadline, priority, project, confidence, kind, provider, model, owner_username)
          VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
          [itemId, meetingId, v.title, v.description, JSON.stringify(v.assignees), JSON.stringify(v.unresolved), v.deadline, v.priority, v.project, v.confidence, v.kind, ai.provider, ai.model, item.submitted_by]);
        created.push(r.rows[0]);
      }
      await pool.query(`UPDATE ingestion_items SET status=$2, normalized_text=$3, language=$4, original_text=COALESCE(original_text, $5), updated_at=now() WHERE id=$1`,
        [itemId, created.length ? 'needs_review' : 'done', out.normalized_text || null, out.language || null, transcript]);
      return { suggestions: created, transcript, language: out.language, summary: out.summary || null, decisions: out.decisions || [], risks: out.risks || [] };
    } catch (e) {
      await pool.query("UPDATE ingestion_items SET status='failed', error=$2, updated_at=now() WHERE id=$1", [itemId, String(e.message).slice(0, 500)]);
      throw e;
    }
  }
  const listForItem = async (itemId) => (await pool.query('SELECT * FROM ai_suggestions WHERE ingestion_id=$1 ORDER BY id', [itemId])).rows;

  async function canDecide(user, s) { return user.role === 'admin' || s.owner_username === user.username; }

  // Accept (optionally edited) → task through the common task-creation code. The status switch is
  // atomic, so a double click / two devices / a retried WhatsApp "CONFIRM" can't create two tasks.
  async function accept(id, user, edits = {}) {
    const s = (await pool.query('SELECT s.*, i.source FROM ai_suggestions s LEFT JOIN ingestion_items i ON i.id = s.ingestion_id WHERE s.id=$1', [id])).rows[0];
    if (!s) return { status: 404, error: 'Suggestion not found.' };
    if (!(await canDecide(user, s))) return { status: 403, error: 'Only the person who sent this (or Admin) can create it.' };
    if (s.status !== 'pending') return { status: 409, error: s.status === 'accepted' ? `Already created as ${s.task_id}.` : 'This suggestion was ignored.' };
    const title = String(edits.title != null ? edits.title : s.title).trim();
    const deadline = String(edits.deadline != null ? edits.deadline : (s.deadline || '')).trim();
    const assignees = Array.isArray(edits.assignees) ? edits.assignees : (s.assignees || []);
    if (!title) return { status: 400, error: 'A title is required.' };
    if (!deadline) return { status: 400, error: 'Please set a deadline before creating the task.' };
    const claim = await pool.query("UPDATE ai_suggestions SET status='accepted', decided_by=$2, decided_at=now() WHERE id=$1 AND status='pending' RETURNING id", [id, user.username]);
    if (!claim.rowCount) return { status: 409, error: 'Already handled.' };
    try {
      const sourceType = s.source || (s.meeting_id ? 'meeting' : 'ai');
      const r = await createTask(user, { title, description: edits.description != null ? edits.description : s.description, deadline, priority: edits.priority || s.priority || 'medium',
        project: edits.project != null ? edits.project : s.project, assignees, sourceType,
        provenance: { ingestion_id: s.ingestion_id, meeting_id: s.meeting_id, suggestion_id: s.id, model: s.model, provider: s.provider, confidence: Number(s.confidence), approved_by: user.username, edited: Object.keys(edits).length > 0 } });
      if (r.error) { await pool.query("UPDATE ai_suggestions SET status='pending', decided_by=NULL, decided_at=NULL WHERE id=$1", [id]); return r; }
      await pool.query('UPDATE ai_suggestions SET task_id=$2 WHERE id=$1', [id, r.id]);
      if (s.ingestion_id) await pool.query(`UPDATE ingestion_items SET status = CASE WHEN EXISTS (SELECT 1 FROM ai_suggestions WHERE ingestion_id=$1 AND status='pending') THEN status ELSE 'done' END, updated_at=now() WHERE id=$1`, [s.ingestion_id]);
      return { status: 200, taskId: r.id };
    } catch (e) {
      await pool.query("UPDATE ai_suggestions SET status='pending', decided_by=NULL, decided_at=NULL WHERE id=$1", [id]);
      throw e;
    }
  }
  async function ignore(id, user) {
    const s = (await pool.query('SELECT * FROM ai_suggestions WHERE id=$1', [id])).rows[0];
    if (!s) return { status: 404, error: 'Suggestion not found.' };
    if (!(await canDecide(user, s))) return { status: 403, error: 'Not allowed.' };
    const r = await pool.query("UPDATE ai_suggestions SET status='ignored', decided_by=$2, decided_at=now() WHERE id=$1 AND status='pending'", [id, user.username]);
    return r.rowCount ? { status: 200 } : { status: 409, error: 'Already handled.' };
  }
  async function listPending(user, { all = false } = {}) {
    const r = await pool.query(`SELECT s.*, i.source, i.original_text, i.language, i.created_at AS received_at FROM ai_suggestions s
      LEFT JOIN ingestion_items i ON i.id = s.ingestion_id
      WHERE s.status='pending' AND ($1::boolean OR s.owner_username=$2) ORDER BY s.created_at DESC LIMIT 200`, [all && user.role === 'admin', user.username]);
    return r.rows;
  }
  return { receive, process: processItem, accept, ignore, listPending, listForItem, validate, context, MIN_CONF };
}
module.exports = { createIngestion };
