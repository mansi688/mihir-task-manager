/* People: directory & profile dates, birthdays / work anniversaries, "who's out", and attendance requests
   ("Raise Request": a person asks HR to fix a missed clock-out or a wrong time; HR approves → the day is corrected).
   Data: users.dob / users.join_date (entered by HR), attendance_requests, leave_requests + payroll_holidays (read).
   Routes: /api/people/*, /api/attendance/requests*. */
const IST_MS = 330 * 60000;
const istDay = (d = new Date()) => new Date(new Date(d).getTime() + IST_MS).toISOString().slice(0, 10);
const validDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !isNaN(Date.parse(`${v}T12:00:00Z`)) ? String(v) : null;
const validHM = (v) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(v || '')) ? String(v).padStart(5, '0') : null;
const addDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const KINDS = { missed_out: 'Forgot to clock out', missed_in: 'Forgot to clock in', wrong_time: 'Wrong clock-in / out time', other: 'Other' };

function mountPeople(app, deps) {
  const { db, auth, ALL_ROLES, auditFromReq, str } = deps;
  const q = (sql, params = []) => db.pool.query(sql, params);
  const rows = async (sql, params) => (await q(sql, params)).rows;
  const one = async (sql, params) => (await q(sql, params)).rows[0] || null;
  const now = () => new Date().toISOString();
  const isHr = (u, t) => u.role === 'admin' || /(^|\b)hr\b|human resource/i.test(t || '');
  async function who(req) {
    const u = await db.getUser(req.user.username);
    return { username: req.user.username, name: (u && u.name) || req.user.name, admin: req.user.role === 'admin', hr: isHr(req.user, u && u.team) };
  }
  // Next time a yearly date (MM-DD) comes round, counted from `today`; { day, inDays }.
  function nextOccurrence(md, today) {
    const y = Number(today.slice(0, 4));
    for (const yy of [y, y + 1]) {
      let d = `${yy}-${md}`;
      if (md === '02-29' && !(yy % 4 === 0 && (yy % 100 !== 0 || yy % 400 === 0))) d = `${yy}-02-28`;
      if (d >= today) return { day: d, inDays: Math.round((Date.parse(`${d}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 864e5) };
    }
    return null;
  }
  const people = async () => rows('SELECT username, name, team, designation, phone, email, dob, join_date, role FROM users ORDER BY name');

  // ---------- directory (everyone). Birth YEAR and the exact joining date are shown to HR / Admin only.
  app.get('/api/people/directory', auth(ALL_ROLES), async (req, res) => {
    const m = await who(req);
    const today = istDay();
    const list = (await people()).map(p => ({
      username: p.username, name: p.name, team: p.team || '', designation: p.designation || '', phone: p.phone || '', email: p.email || '',
      birthday: p.dob ? p.dob.slice(5) : '', joined: p.join_date ? (m.hr ? p.join_date : p.join_date.slice(0, 4)) : '',
      ...(m.hr ? { dob: p.dob || '', joinDate: p.join_date || '' } : {}),
    }));
    res.json({ canEdit: m.hr, today, list });
  });
  // HR / Admin set a person's dates (and designation / phone).
  app.post('/api/people/:username/profile', auth(ALL_ROLES), async (req, res) => {
    const m = await who(req);
    if (!m.hr) return res.status(403).json({ error: 'Only HR and Admin edit people\'s details.' });
    const u = await db.getUser(req.params.username); if (!u) return res.status(404).json({ error: 'User not found.' });
    const b = req.body || {};
    const sets = [], vals = [u.username];
    const put = (col, v) => { vals.push(v); sets.push(`${col}=$${vals.length}`); };
    if (b.dob !== undefined) { const d = b.dob === '' || b.dob === null ? null : validDay(b.dob); if (b.dob && !d) return res.status(400).json({ error: 'Date of birth must be a date.' }); if (d && d > istDay()) return res.status(400).json({ error: 'Date of birth is in the future.' }); put('dob', d); }
    if (b.joinDate !== undefined) { const d = b.joinDate === '' || b.joinDate === null ? null : validDay(b.joinDate); if (b.joinDate && !d) return res.status(400).json({ error: 'Joining date must be a date.' }); put('join_date', d); }
    if (b.designation !== undefined) put('designation', str(b.designation).trim().slice(0, 80) || null);
    if (b.phone !== undefined) put('phone', str(b.phone).trim().slice(0, 30) || null);
    if (!sets.length) return res.status(400).json({ error: 'Nothing to change.' });
    await q(`UPDATE users SET ${sets.join(', ')} WHERE username=$1`, vals);
    if (db.invalidateUserCache) db.invalidateUserCache();
    await auditFromReq(req, 'people_profile', `${m.name} updated the details (dates / designation / phone) of ${u.username}.`);
    res.json({ ok: true });
  });
  // HR: paste "username, date of birth, joining date" lines (dates as YYYY-MM-DD or DD-MM-YYYY, either may be blank).
  app.post('/api/people/dates/import', auth(ALL_ROLES), async (req, res) => {
    const m = await who(req);
    if (!m.hr) return res.status(403).json({ error: 'Only HR and Admin import dates.' });
    const norm = (v) => { v = String(v || '').trim(); if (!v) return ''; const dm = /^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})$/.exec(v); if (dm) v = `${dm[3]}-${dm[2].padStart(2, '0')}-${dm[1].padStart(2, '0')}`; return validDay(v) || null; };
    const out = { updated: 0, errors: [] };
    for (const [i, line] of String(req.body && req.body.text || '').split(/\r?\n/).entries()) {
      if (!line.trim() || /^username/i.test(line.trim())) continue;
      const [uname, dob, jd] = line.split(/[,\t;]/).map(x => (x || '').trim());
      const u = uname && await db.getUser(uname);
      const d1 = norm(dob), d2 = norm(jd);
      if (!u) { out.errors.push(`Line ${i + 1}: no user "${uname}"`); continue; }
      if (d1 === null || d2 === null) { out.errors.push(`Line ${i + 1}: a date is not valid (${line.trim()})`); continue; }
      const sets = [], vals = [u.username];
      if (d1) { vals.push(d1); sets.push(`dob=$${vals.length}`); }
      if (d2) { vals.push(d2); sets.push(`join_date=$${vals.length}`); }
      if (!sets.length) continue;
      await q(`UPDATE users SET ${sets.join(', ')} WHERE username=$1`, vals); out.updated++;
    }
    if (db.invalidateUserCache) db.invalidateUserCache();
    await auditFromReq(req, 'people_dates_import', `${m.name} imported dates for ${out.updated} people.`);
    res.json(out);
  });

  // ---------- celebrations, who is out, holidays (front page + People page)
  async function overview(m) {
    const today = istDay();
    // all five lookups at once (one round trip of waiting instead of five)
    const [all, leaves, holiday, holidays, wk] = await Promise.all([
      people(),
      rows(`SELECT username, from_day, to_day, half_day, kind FROM leave_requests WHERE status='approved' AND to_day >= $1 AND from_day <= $2 ORDER BY from_day`, [today, addDays(today, 14)]),
      one('SELECT name FROM payroll_holidays WHERE day=$1', [today]),
      rows('SELECT day, name FROM payroll_holidays WHERE day > $1 AND day <= $2 ORDER BY day LIMIT 8', [today, addDays(today, 90)]),
      one('SELECT data FROM payroll_settings WHERE id=1').catch(() => null),
    ]);
    const celebrations = [];
    for (const p of all) {
      if (p.dob) { const n = nextOccurrence(p.dob.slice(5), today); if (n && n.inDays <= 30) celebrations.push({ type: 'birthday', username: p.username, name: p.name, team: p.team || '', day: n.day, inDays: n.inDays }); }
      if (p.join_date) {
        const n = nextOccurrence(p.join_date.slice(5), today);
        const years = n ? Number(n.day.slice(0, 4)) - Number(p.join_date.slice(0, 4)) : 0;
        if (n && years >= 1 && n.inDays <= 30) celebrations.push({ type: 'anniversary', username: p.username, name: p.name, team: p.team || '', day: n.day, inDays: n.inDays, years });
      }
    }
    celebrations.sort((a, b) => a.inDays - b.inDays || a.name.localeCompare(b.name));
    const names = Object.fromEntries(all.map(p => [p.username, p]));
    const shape = (l) => ({ username: l.username, name: (names[l.username] || {}).name || l.username, team: (names[l.username] || {}).team || '', from: l.from_day, to: l.to_day, half: !!l.half_day, kind: l.kind });
    const outToday = leaves.filter(l => l.from_day <= today && l.to_day >= today).map(shape);
    const upcoming = leaves.filter(l => l.from_day > today).map(shape);
    const weeklyOff = (wk && wk.data && wk.data.weeklyOff) || [0];
    const isWeeklyOff = weeklyOff.includes(new Date(`${today}T12:00:00Z`).getUTCDay());
    return { today, celebrations, outToday, upcomingLeave: upcoming, holidayToday: holiday ? holiday.name : null, weeklyOffToday: isWeeklyOff, holidays, totalPeople: all.length };
  }
  app.get('/api/people/overview', auth(ALL_ROLES), async (req, res) => { res.json(await overview(await who(req))); });

  // ---------- Raise Request (attendance regularization)
  const shape = (r) => ({ id: r.id, username: r.username, name: r.name || r.username, day: r.day, kind: r.kind, kindLabel: KINDS[r.kind] || r.kind, inTime: r.in_time || '', outTime: r.out_time || '', outNextDay: !!r.out_next_day,
    reason: r.reason || '', status: r.status, decidedBy: r.decided_by_name || '', decidedAt: r.decided_at || '', note: r.decision_note || '', createdAt: r.created_at });
  app.post('/api/attendance/requests', auth(ALL_ROLES), async (req, res) => {
    const b = req.body || {};
    const day = validDay(b.day), kind = KINDS[b.kind] ? b.kind : null;
    if (!day || day > istDay()) return res.status(400).json({ error: 'Pick the day (today or earlier).' });
    if (day < addDays(istDay(), -45)) return res.status(400).json({ error: 'Requests can be raised for the last 45 days only — ask HR directly for older days.' });
    if (!kind) return res.status(400).json({ error: 'Pick what went wrong.' });
    const inT = b.inTime ? validHM(b.inTime) : null, outT = b.outTime ? validHM(b.outTime) : null;
    if ((b.inTime && !inT) || (b.outTime && !outT)) return res.status(400).json({ error: 'Times must look like 09:30.' });
    if (!inT && !outT) return res.status(400).json({ error: 'Give the correct clock-in time, clock-out time, or both.' });
    const reason = str(b.reason).trim();
    if (reason.length < 3) return res.status(400).json({ error: 'Write the reason.' });
    if (await one("SELECT 1 FROM attendance_requests WHERE username=$1 AND day=$2 AND status='pending'", [req.user.username, day])) return res.status(400).json({ error: 'You already have a request waiting for that day.' });
    const r = await one(`INSERT INTO attendance_requests(username, day, kind, in_time, out_time, out_next_day, reason, status, created_at) VALUES($1,$2,$3,$4,$5,$6,$7,'pending',$8) RETURNING id`,
      [req.user.username, day, kind, inT, outT, !!b.outNextDay, reason.slice(0, 300), now()]);
    const m = await who(req);
    const hrs = (await db.listUsers()).filter(u => isHr(u, u.team)).map(u => u.username).filter(u => u !== req.user.username);
    for (const to of new Set(hrs)) await db.createNotification({ username: to, type: 'attendance', message: `📝 ${m.name} raised an attendance request for ${day} (${KINDS[kind]}).`, task_id: null }).catch(() => {});
    res.json({ ok: true, id: r.id });
  });
  app.get('/api/attendance/requests', auth(ALL_ROLES), async (req, res) => {
    const m = await who(req);
    const mine = await rows(`SELECT r.*, u.name FROM attendance_requests r LEFT JOIN users u ON u.username=r.username WHERE r.username=$1 ORDER BY r.created_at DESC LIMIT 30`, [m.username]);
    const waiting = m.hr ? await rows(`SELECT r.*, u.name FROM attendance_requests r LEFT JOIN users u ON u.username=r.username WHERE r.status='pending' ORDER BY r.created_at`) : [];
    res.json({ canDecide: m.hr, mine: mine.map(shape), waiting: waiting.map(shape) });
  });
  app.post('/api/attendance/requests/:id/:decision', auth(ALL_ROLES), async (req, res) => {
    const m = await who(req);
    const decision = req.params.decision;
    if (!['approve', 'reject', 'withdraw'].includes(decision)) return res.status(404).json({ error: 'Unknown action.' });
    const r = await one('SELECT * FROM attendance_requests WHERE id=$1', [Number(req.params.id) || 0]);
    if (!r) return res.status(404).json({ error: 'That request is gone.' });
    if (r.status !== 'pending') return res.status(400).json({ error: `Already ${r.status}.` });
    const t = now();
    if (decision === 'withdraw') {
      if (r.username !== m.username) return res.status(403).json({ error: 'Only the person who asked can withdraw it.' });
      await q("UPDATE attendance_requests SET status='withdrawn', decided_at=$2 WHERE id=$1 AND status='pending'", [r.id, t]);
      return res.json({ ok: true });
    }
    if (!m.hr) return res.status(403).json({ error: 'Only HR and Admin decide requests.' });
    if (r.username === m.username && !m.admin) return res.status(403).json({ error: 'Someone else in HR must decide your own request.' });
    const note = str((req.body || {}).note).trim().slice(0, 200);
    if (decision === 'reject') {
      await q("UPDATE attendance_requests SET status='rejected', decided_by=$2, decided_by_name=$3, decided_at=$4, decision_note=$5 WHERE id=$1 AND status='pending'", [r.id, m.username, m.name, t, note || null]);
      await db.createNotification({ username: r.username, type: 'attendance', message: `${m.name} did not accept your attendance request for ${r.day}${note ? ` — “${note}”` : ''}.`, task_id: null }).catch(() => {});
      return res.json({ ok: true });
    }
    // approve → the day is corrected (times become the day's official in / out, like an HR correction)
    const at = (hm, plus) => new Date(Date.parse(`${r.day}T${hm}:00+05:30`) + (plus ? 864e5 : 0)).toISOString();
    const inIso = r.in_time ? at(r.in_time, false) : null, outIso = r.out_time ? at(r.out_time, r.out_next_day) : null;
    const cur = await one('SELECT check_in_at, check_out_at, manual_in, manual_out FROM attendance_days WHERE username=$1 AND day=$2', [r.username, r.day]);
    const fin = inIso || (cur && (cur.manual_in || cur.check_in_at)), fout = outIso || (cur && (cur.manual_out || cur.check_out_at));
    if (fin && fout && Date.parse(fout) <= Date.parse(fin)) return res.status(400).json({ error: 'The clock-out would be before the clock-in — reject it or ask the person to correct it.' });
    const reason = `Request approved by ${m.name}: ${KINDS[r.kind] || r.kind} — ${r.reason}`.slice(0, 300);
    await q(`INSERT INTO attendance_days(username, day, override_reason, override_by, override_at, manual_in, manual_out, created_at, updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$5,$5) ON CONFLICT (username, day) DO UPDATE SET override_reason=EXCLUDED.override_reason, override_by=EXCLUDED.override_by, override_at=EXCLUDED.override_at,
      manual_in=COALESCE(EXCLUDED.manual_in, attendance_days.manual_in), manual_out=COALESCE(EXCLUDED.manual_out, attendance_days.manual_out), updated_at=EXCLUDED.updated_at`,
    [r.username, r.day, reason, m.username, t, inIso, outIso]);
    await q("UPDATE attendance_requests SET status='approved', decided_by=$2, decided_by_name=$3, decided_at=$4, decision_note=$5 WHERE id=$1 AND status='pending'", [r.id, m.username, m.name, t, note || null]);
    await auditFromReq(req, 'attendance_request_approved', `${m.name} approved the attendance request of ${r.username} for ${r.day} (${KINDS[r.kind] || r.kind}).`);
    await db.createNotification({ username: r.username, type: 'attendance', message: `${m.name} accepted your attendance request for ${r.day} — the day is corrected.`, task_id: null }).catch(() => {});
    res.json({ ok: true });
  });

  // ---------- daily greetings: once a day after 08:00 IST (birthdays and work anniversaries)
  async function dailyGreetings(nowDate = new Date()) {
    const today = istDay(nowDate);
    const hour = new Date(nowDate.getTime() + IST_MS).getUTCHours();
    if (hour < 8) return { skipped: 'early' };
    const key = `people_daily_${today}`;
    const done = await one('SELECT 1 FROM company_settings WHERE key=$1', [key]);
    if (done) return { skipped: 'done' };
    const claim = await q('INSERT INTO company_settings(key, value, updated_at) VALUES($1,$2,$3) ON CONFLICT (key) DO NOTHING', [key, '1', now()]);
    if (!claim.rowCount) return { skipped: 'done' };
    const all = await people(); let sent = 0;
    for (const p of all) {
      const md = today.slice(5);
      const isB = p.dob && p.dob.slice(5) === md;
      const isA = p.join_date && p.join_date.slice(5) === md && Number(today.slice(0, 4)) - Number(p.join_date.slice(0, 4)) >= 1;
      if (!isB && !isA) continue;
      const years = isA ? Number(today.slice(0, 4)) - Number(p.join_date.slice(0, 4)) : 0;
      const events = [];
      if (isB) events.push({ own: `🎂 Happy birthday, ${p.name}! Everyone at MIHIR wishes you a wonderful year.`, others: `🎂 Today is ${p.name}'s birthday — wish them!` });
      if (isA) events.push({ own: `🎉 Happy work anniversary, ${p.name} — ${years} year${years === 1 ? '' : 's'} with MIHIR!`, others: `🎉 ${p.name} completes ${years} year${years === 1 ? '' : 's'} with MIHIR today.` });
      for (const e of events) {
        await db.createNotification({ username: p.username, type: 'celebration', message: e.own, task_id: null }).catch(() => {});
        for (const o of all) if (o.username !== p.username) { await db.createNotification({ username: o.username, type: 'celebration', message: e.others, task_id: null }).catch(() => {}); sent++; }
      }
    }
    return { sent };
  }
  function attachJobs(jobs) {
    if (!jobs) return;
    jobs.register('PEOPLE_DAILY', async () => dailyGreetings(), { maxAttempts: 2, baseDelayMs: 60000 });
    jobs.every('PEOPLE_DAILY', 30 * 60 * 1000);
  }
  app.post('/api/people/greetings-run', auth(ALL_ROLES), async (req, res) => {
    const m = await who(req);
    if (!m.admin) return res.status(403).json({ error: 'Admin only.' });
    res.json(await dailyGreetings(req.body && req.body.at ? new Date(req.body.at) : new Date()));
  });
  return { attachJobs, dailyGreetings, overview };
}
module.exports = { mountPeople };
