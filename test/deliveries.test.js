const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, api, login, createMember, futureDate } = require('../testlib/helpers');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('deliveries: Purchase/Admin add them from a task; site team gets access, proof of delivery then unloading', async (t) => {
  const { baseUrl, stop } = await startTestServer();
  t.after(stop);
  const admin = await login(baseUrl, 'admin', 'admin123');
  const buyer = await createMember(baseUrl, admin, 'tanu.p', 'Tanu Purchase', 'Purchase Department');
  const site = await createMember(baseUrl, admin, 'sachin.s', 'Sachin Site', 'Execution Department');
  const eng = await createMember(baseUrl, admin, 'eng.d', 'Eng D', 'Execution Department');
  const outsider = await createMember(baseUrl, admin, 'out.d', 'Out Sider', 'Sales');
  const P = (tok, path, body) => api(baseUrl, path, { method: 'POST', token: tok, body });
  const G = (tok, path) => api(baseUrl, path, { token: tok });
  const taskId = (await P(buyer, '/api/tasks', { title: 'Tiles — 400 boxes, Tower B', priority: 'medium', deadline: futureDate(6), assignedToList: ['eng.d'] })).data.id;

  // Only Admin / Purchase can add
  assert.equal((await P(eng, '/api/deliveries', { title: 'x', expected_at: futureDate(2), receivers: ['sachin.s'] })).status, 403);
  // Validation
  assert.equal((await P(buyer, '/api/deliveries', { title: 'Tiles', receivers: ['sachin.s'] })).status, 400, 'date required');
  assert.equal((await P(buyer, '/api/deliveries', { title: 'Tiles', expected_at: futureDate(2), receivers: [] })).status, 400, 'site team required');
  assert.equal((await P(buyer, '/api/deliveries', { title: 'Tiles', expected_at: futureDate(2), receivers: ['nobody.zz'] })).status, 400);
  const c = await P(buyer, '/api/deliveries', { title: 'Tiles — 400 boxes, Tower B', expected_at: futureDate(2), receivers: ['sachin.s'], task_id: taskId, project: 'Mihir Amara' });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  const did = c.data.id; assert.match(c.data.ref, /^DLV-/);
  assert.equal(c.data.closedTask, true, 'adding the task to Deliveries closes it');
  assert.equal((await G(buyer, `/api/tasks/${taskId}`)).data.status, 'closed');
  // nothing nags the task's own people any more (no reminders for a closed task)
  await P(admin, '/api/tasks/send-reminders-now');
  assert.ok(!(await G(eng, '/api/notifications')).data.items.some(n => n.task_id === taskId && /reminder|overdue|warning/i.test(n.type)), 'no reminders for the closed task');
  // date + time also accepted
  assert.equal((await P(admin, '/api/deliveries', { title: 'Cement 50 bags', expected_at: `${futureDate(1)}T15:30`, receivers: ['sachin.s'] })).status, 200);

  // Site person: notified, sees the delivery, and can open the task (kept informed)
  assert.ok((await G(site, '/api/notifications')).data.items.some(n => n.type === 'delivery_scheduled' && /Tiles/.test(n.message)));
  const list = (await G(site, '/api/deliveries')).data;
  assert.equal(list.canManage, false);
  assert.ok(list.items.some(d => d.id === did));
  assert.equal((await G(site, `/api/tasks/${taskId}`)).status, 200, 'tagged on the delivery → can see the task');
  assert.ok((await G(site, '/api/tasks/watching')).data.some(x => x.id === taskId));
  assert.ok(!(await G(outsider, '/api/deliveries')).data.items.some(d => d.id === did), 'someone not on it does not see it');
  assert.ok((await G(eng, '/api/deliveries')).data.items.some(d => d.id === did), 'people on the linked task see it');

  // Details added later → site team told
  assert.equal((await P(site, `/api/deliveries/${did}/update`, { driver_name: 'X' })).status, 403, 'site team cannot edit');
  assert.equal((await P(buyer, `/api/deliveries/${did}/update`, { driver_name: 'Ramesh', driver_phone: '98765 43210', vehicle_no: 'MH12 AB 1234', porter_order_id: 'PRT-889' })).status, 200);
  assert.ok((await G(site, '/api/notifications')).data.items.some(n => n.type === 'delivery_update' && /Ramesh/.test(n.message)));
  assert.equal((await P(buyer, `/api/deliveries/${did}/status`, { status: 'dispatched' })).status, 200);

  // Proof: delivery first (photo required), then unloading
  assert.equal((await P(site, `/api/deliveries/${did}/proof`, { stage: 'unloaded', attachments: [{ name: 'a.png', data: PNG }] })).status, 400, 'unloading needs delivery first');
  assert.equal((await P(site, `/api/deliveries/${did}/proof`, { stage: 'delivered', attachments: [] })).status, 400, 'photo required');
  assert.equal((await P(outsider, `/api/deliveries/${did}/proof`, { stage: 'delivered', attachments: [{ name: 'a.png', data: PNG }] })).status, 403);
  assert.equal((await P(site, `/api/deliveries/${did}/proof`, { stage: 'delivered', note: '400 boxes counted', attachments: [{ name: 'gate.png', data: PNG }], takenAt: ['2026-10-26T10:15:00+05:30'] })).status, 200);
  assert.equal((await P(site, `/api/deliveries/${did}/proof`, { stage: 'unloaded', note: 'Stacked in store', attachments: [{ name: 'store.png', data: PNG }] })).status, 200);
  const d = (await G(buyer, '/api/deliveries')).data.items.find(x => x.id === did);
  assert.equal(d.status, 'unloaded'); assert.ok(d.delivered_at && d.unloaded_at);
  assert.deepEqual(d.files.map(f => f.kind).sort(), ['delivery_proof', 'unloading_proof']);
  assert.equal(d.files.find(f => f.kind === 'delivery_proof').taken_at, '2026-10-26T10:15:00+05:30');
  assert.ok((await G(buyer, '/api/notifications')).data.items.some(n => n.type === 'delivery_unloaded' && /^Unloaded: "Tiles/.test(n.message)), 'whoever added it is told it was unloaded');
  const hist = (await G(buyer, `/api/tasks/${taskId}/events`)).data.events.map(e => e.event_type || e.type);
  assert.ok(hist.includes('DELIVERY_ADDED') && hist.includes('DELIVERY_UNLOADED'), JSON.stringify(hist));
  // Files: people on it can open, others cannot
  const fid = d.files[0].id;
  assert.equal((await G(site, `/api/deliveries/${did}/files/${fid}`)).status, 200);
  assert.equal((await G(outsider, `/api/deliveries/${did}/files/${fid}`)).status, 403);
  // Admin can give delivery access to someone outside Purchase (e.g. the purchase head's assistant)
  const asst = await createMember(baseUrl, admin, 'asst.d', 'Assistant D', 'Accounts');
  const mk = () => P(asst, '/api/deliveries', { title: 'Sand 2 brass', expected_at: futureDate(3), receivers: ['sachin.s'] });
  assert.equal((await mk()).status, 403);
  assert.equal((await P(buyer, '/api/users/asst.d/delivery-access', { allowed: true })).status, 403, 'only Admin grants it');
  assert.equal((await P(admin, '/api/users/asst.d/delivery-access', { allowed: true })).status, 200);
  assert.equal((await G(asst, '/api/deliveries')).data.canManage, true);
  assert.equal((await mk()).status, 200, 'the assistant can now add deliveries');
  assert.equal((await G(admin, '/api/users')).data.find(u => u.username === 'asst.d').manage_deliveries, 1);
  assert.equal((await P(admin, '/api/users/asst.d/delivery-access', { allowed: false })).status, 200);
  assert.equal((await mk()).status, 403, 'removed again');
  // A task with an open subtask is kept open (and told why)
  const parent = (await P(buyer, '/api/tasks', { title: 'Plumbing material', priority: 'medium', deadline: futureDate(6), assignedToList: ['eng.d'] })).data.id;
  await P(buyer, '/api/tasks', { title: 'Sub: fittings', priority: 'low', deadline: futureDate(5), assignedToList: ['eng.d'], parentTaskId: parent });
  const kept = await P(buyer, '/api/deliveries', { title: 'Plumbing material', expected_at: futureDate(2), receivers: ['sachin.s'], task_id: parent });
  assert.equal(kept.status, 200); assert.equal(kept.data.closedTask, false); assert.match(kept.data.keptOpenWhy, /subtask/);
  // Delete: only the purchase side; can re-open the task it closed
  const t3 = (await P(buyer, '/api/tasks', { title: 'Doors — 40 nos', priority: 'medium', deadline: futureDate(6), assignedToList: ['eng.d'] })).data.id;
  const d3 = (await P(buyer, '/api/deliveries', { title: 'Doors — 40 nos', expected_at: futureDate(2), receivers: ['sachin.s'], task_id: t3 })).data;
  assert.equal((await G(buyer, `/api/tasks/${t3}`)).data.status, 'closed');
  assert.equal((await P(site, `/api/deliveries/${d3.id}/delete`, {})).status, 403);
  const del = await P(buyer, `/api/deliveries/${d3.id}/delete`, { reopenTask: true });
  assert.equal(del.status, 200); assert.equal(del.data.reopened, true);
  assert.equal((await G(buyer, `/api/tasks/${t3}`)).data.status, 'open', 'task re-opened');
  assert.ok(!(await G(buyer, '/api/deliveries')).data.items.some(x => x.id === d3.id), 'gone');
  assert.ok((await G(site, '/api/notifications')).data.items.some(n => n.type === 'delivery_update' && /deleted/.test(n.message)), 'site team told');
  assert.equal((await P(buyer, `/api/deliveries/${d3.id}/delete`, {})).status, 404);
  // Finished deliveries cannot be edited
  assert.equal((await P(buyer, `/api/deliveries/${did}/update`, { driver_name: 'Y' })).status, 400);
});
