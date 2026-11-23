// Attendance rules for sessions that do not fit "one site, one day":
//   night work across midnight · break reminder and overrun · maximum session length · photos only at check-in,
//   deleted at 12:00 the next day · nobody is marked absent because of a system check-out.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember } = require('../testlib/helpers');

const PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACv/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AN//Z';
const istDay = (ms) => new Date(ms + 330 * 60000).toISOString().slice(0, 10);
const HM = (ms) => new Date(ms + 330 * 60000).toISOString().slice(11, 16);
const MIN = 60000;

test('attendance sessions, breaks and photos', async (t) => {
  const { baseUrl, stop, getRawClient } = await startTestServer();
  t.after(stop);
  const raw = await getRawClient(); t.after(() => raw.end());
  const admin = await login(baseUrl, 'admin', 'admin123');
  const hr = await createMember(baseUrl, admin, 'rule.hr', 'HR', 'HR Department');
  const P = (p, token, body) => api(baseUrl, p, { method: 'POST', token, body });
  const G = (p, token) => api(baseUrl, p, { token });
  const now = Date.now();
  const rec = (u) => raw.query('SELECT * FROM attendance_days WHERE username=$1 ORDER BY day DESC', [u]).then(r => r.rows);
  const notes = async (tok) => (await G('/api/notifications', tok)).data.items.map(n => n.message);
  const sweep = async () => { const r = await P('/api/attendance/auto-run', admin, {}); assert.equal(r.status, 200); return r.data; };

  await t.test('night work: a session that started last night is closed by a check-out after midnight', async () => {
    const n = await createMember(baseUrl, admin, 'rule.night', 'Night Worker', 'Execution Department');
    // checked in 6 hours ago under yesterday's date (22:00 the night before)
    await raw.query("INSERT INTO attendance_days(username, day, check_in_at, in_source, created_at) VALUES('rule.night', $1, $2, 'manual', $2)", [istDay(now - 36 * 3600000), new Date(now - 6 * 3600000).toISOString()]);
    let me = (await G('/api/attendance/me', n)).data.todayRec;
    assert.equal(me.in, HM(now - 6 * 3600000)); assert.equal(me.fromEarlierDay, true); assert.equal(me.out, '');
    assert.ok(me.timeline.grossMin >= 359 && me.timeline.effectiveMin <= me.timeline.grossMin, 'time log: gross / effective hours');
    assert.ok(Array.isArray(me.timeline.punches));
    assert.match((await P('/api/attendance/check-in', n, { photo: PHOTO })).data.error, /already checked in since/);
    assert.equal((await P('/api/attendance/break-start', n, {})).status, 200, 'breaks work in a session from an earlier day');
    assert.equal((await P('/api/attendance/break-end', n, {})).status, 200);
    const out = await P('/api/attendance/check-out', n, {});
    assert.equal(out.status, 200, JSON.stringify(out.data));
    const rows = await rec('rule.night');
    assert.equal(rows.length, 1, 'one session, not two days');
    assert.ok(rows[0].check_out_at && new Date(rows[0].check_out_at) > new Date(rows[0].check_in_at));
    assert.match((await P('/api/attendance/check-out', n, {})).data.error, /Check in first|already checked out/);
  });

  await t.test('break: reminder before it ends, then checked out when the break time ended — hours so far still count', async () => {
    const w = await createMember(baseUrl, admin, 'rule.brk', 'Break Worker', 'Execution Department');
    assert.equal((await P('/api/attendance/check-in', w, { photo: PHOTO })).status, 200);
    await raw.query("UPDATE attendance_days SET check_in_at = $2 WHERE username=$1", ['rule.brk', new Date(now - 6 * 3600000).toISOString()]);
    assert.equal((await P('/api/attendance/break-start', w, {})).status, 200);
    // 55 minutes into the 60-minute allowance → reminder
    await raw.query("UPDATE attendance_days SET breaks = $2 WHERE username=$1", ['rule.brk', JSON.stringify([{ start: new Date(now - 55 * MIN).toISOString() }])]);
    const s1 = await sweep(); assert.ok(s1.reminded >= 1);
    assert.ok((await notes(w)).some(m => /Your break ends in \d+ min/.test(m)));
    await sweep();
    assert.equal((await notes(w)).filter(m => /Your break ends in/.test(m)).length, 1, 'one reminder, not one per sweep');
    assert.equal((await G('/api/attendance/me', w)).data.todayRec.out, '', 'still within the break time');
    const me = (await G('/api/attendance/me', w)).data.todayRec;
    assert.equal(me.onBreak, true); assert.ok(me.breakLeftMin === 60 || me.breakLeftMin > 0); assert.ok(me.breakBackBy);
    // 70 minutes → over: checked out at the moment the 60 minutes ended
    const start = now - 70 * MIN;
    await raw.query("UPDATE attendance_days SET breaks = $2 WHERE username=$1", ['rule.brk', JSON.stringify([{ start: new Date(start).toISOString() }])]);
    const s2 = await sweep(); assert.ok(s2.closed >= 1);
    const r = (await G('/api/attendance/me', w)).data.todayRec;
    assert.equal(r.out, HM(start + 60 * MIN)); assert.equal(r.outAuto, true); assert.equal(r.onBreak, false);
    assert.ok((await notes(w)).some(m => /break time was over/.test(m)));
    // 6 h in, checked out 10 min before the end of the 70-min break → 5 h 50 min worked: a HALF day — not absent
    const day = (await G('/api/attendance/me', w)).data.days.find(d => d.out);
    assert.equal(day.status, 'H'); assert.equal(day.worked, 350);
  });

  await t.test('the day\'s break allowance is shared by all breaks; used up → no more breaks', async () => {
    const w = await createMember(baseUrl, admin, 'rule.brk2', 'Break Two', 'Execution Department');
    await raw.query("INSERT INTO attendance_days(username, day, check_in_at, breaks, in_source, created_at) VALUES('rule.brk2', $1, $2::text, $3::jsonb, 'manual', $2::text)",
      [istDay(now), new Date(now - 5 * 3600000).toISOString(), JSON.stringify([{ start: new Date(now - 200 * MIN).toISOString(), end: new Date(now - 150 * MIN).toISOString() }])]);
    const b = await P('/api/attendance/break-start', w, {});
    assert.equal(b.status, 200); assert.equal(b.data.leftMin, 10, '60 − 50 used');
    await P('/api/attendance/break-end', w, {});
    await raw.query("UPDATE attendance_days SET breaks = $1 WHERE username='rule.brk2'", [JSON.stringify([{ start: new Date(now - 200 * MIN).toISOString(), end: new Date(now - 140 * MIN).toISOString() }])]);
    assert.match((await P('/api/attendance/break-start', w, {})).data.error, /used up/);
  });

  await t.test('a session open for the maximum length (16 h) is closed; the person can check in again', async () => {
    const w = await createMember(baseUrl, admin, 'rule.max', 'Forgot Out', 'Execution Department');
    await raw.query("INSERT INTO attendance_days(username, day, check_in_at, in_source, created_at) VALUES('rule.max', $1, $2, 'manual', $2)", [istDay(now - 17 * 3600000), new Date(now - 17 * 3600000).toISOString()]);
    await sweep();
    const r = (await rec('rule.max'))[0];
    assert.ok(r.check_out_at); assert.equal(r.out_source, 'auto');
    assert.ok(new Date(r.check_out_at) - new Date(r.check_in_at) <= 16 * 3600000 + 1000, 'never longer than the limit');
    assert.equal((await P('/api/attendance/check-in', w, { photo: PHOTO })).status, 200);
  });

  await t.test('live photo: only at check-in (never kept at check-out) and deleted at 12:00 the next day', async () => {
    const w = await createMember(baseUrl, admin, 'rule.photo', 'Photo', 'Execution Department');
    assert.match((await P('/api/attendance/check-in', w, {})).data.error, /live photo/);
    assert.equal((await P('/api/attendance/check-in', w, { photo: PHOTO })).status, 200);
    assert.equal((await P('/api/attendance/check-out', w, { photo: PHOTO })).status, 200);
    const r = (await rec('rule.photo'))[0];
    assert.ok(r.in_photo); assert.equal(r.out_photo, null, 'a photo sent with check-out is not stored');
    // yesterday / two days ago / today with photos
    const days = [istDay(now), istDay(now - 24 * 3600000), istDay(now - 48 * 3600000)];
    for (const [i, d] of days.entries()) {
      if (i === 0) continue;
      await raw.query("INSERT INTO attendance_days(username, day, check_in_at, in_photo, created_at) VALUES('rule.photo', $1, $2, 'p', $2)", [d, `${d}T04:00:00.000Z`]);
    }
    await raw.query("INSERT INTO attendance_attempts(username, day, action, at, reason, photo) VALUES('rule.photo', $1, 'in', $2, 'old', 'p')", [days[1], `${days[1]}T04:00:00.000Z`]);
    await sweep();
    const cutoff = istDay(now - 12 * 3600000); // a day's photos go when this day is later than it
    const has = async (d) => !!(await raw.query("SELECT in_photo FROM attendance_days WHERE username='rule.photo' AND day=$1", [d])).rows[0].in_photo;
    assert.equal(await has(days[0]), true, "today's photo stays");
    assert.equal(await has(days[1]), !(days[1] < cutoff), "yesterday's photo goes at 12:00 today, not at midnight");
    assert.equal(await has(days[2]), false, 'older photos are gone');
    const att = (await raw.query("SELECT photo FROM attendance_attempts WHERE username='rule.photo'")).rows[0];
    assert.equal(!!att.photo, !(days[1] < cutoff));
  });

  await t.test('HR rules: new settings validate and are returned', async () => {
    const bad = await P('/api/payroll/settings', hr, { maxSessionHours: 99 });
    assert.equal(bad.status, 400);
    const ok = await P('/api/payroll/settings', hr, { maxSessionHours: 16, breakRemindMin: 10, autoOutAfterFullDay: true });
    assert.equal(ok.status, 200);
    const me = (await G('/api/attendance/me', hr)).data;
    assert.equal(me.rules.maxSessionHours, 16); assert.equal(me.rules.breakRemindMin, 10); assert.equal(me.rules.autoOutAfterFullDay, true);
  });
});
