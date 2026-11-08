// Lou's agency calendar "Gold A&S" <-> meetings: the rules (unit) and whole
// passes against an in-memory Firestore and an in-memory Google calendar.
const test = require('node:test');
const assert = require('node:assert/strict');
const { israelDate, addDays } = require('@goldas/domain');
const A = require('../agency-calendar.js');
const G = require('../gcal-sync.js');

process.env.FIREBASE_SERVICE_ACCOUNT_KEY = process.env.FIREBASE_SERVICE_ACCOUNT_KEY || '{"project_id":"x"}';
const today = israelDate();
const d = (n) => addDays(today, n);

test('a meeting without an end lasts an hour; an end before the start is not overnight', () => {
  assert.deepEqual(A.normalize({ title: ' פגישה ', date: '2026-11-09', time: '9:00' }),
    { title: 'פגישה', date: '2026-11-09', time: '09:00', endDate: '2026-11-09', endTime: '10:00', allDay: false, location: '', notes: '' });
  assert.equal(A.normalize({ date: '2026-11-09', time: '18:00', endTime: '17:00' }).endTime, '19:00');
  assert.deepEqual(A.normalize({ date: '2026-11-09', time: '23:30', endTime: '00:30', endDate: '2026-11-10' }).endDate, '2026-11-10');
  assert.equal(A.normalize({ date: '2026-11-09', time: '' }).allDay, true);
});

test('an event reads back as the same meeting it was written from', () => {
  const m = { id: 'x', title: 'Gold A&S | Harwin\'s', date: '2026-11-09', time: '21:00', endTime: '21:45', location: 'G כוכב הצפון', notes: 'שורה 1\nשורה 2', linkedPlayers: ['p1'] };
  const body = A.eventBody(m);
  const ev = { id: 'e', ...body, start: { dateTime: '2026-11-09T21:00:00+02:00' }, end: { dateTime: '2026-11-09T21:45:00+02:00' }, description: '<p>שורה 1<br>שורה 2</p>' };
  assert.equal(A.fieldsHash(A.fromEvent(ev)), A.fieldsHash(A.normalize(m)));
  assert.equal(body.extendedProperties.private.goldasMeeting, 'x');
  assert.equal(body.extendedProperties.private.goldasPlayers, 'p1');
  // Lou's own description is kept when the notes did not change.
  assert.equal(A.eventBody(m, ev).description, undefined);
  assert.equal(A.eventBody({ ...m, notes: 'אחר' }, ev).description, 'אחר');
});

test('an all-day item spans its days', () => {
  const ev = { id: 'e', summary: 'כנס', start: { date: '2026-11-10' }, end: { date: '2026-11-13' } };
  const n = A.fromEvent(ev);
  assert.equal(n.allDay, true); assert.equal(n.endDate, '2026-11-12');
  const body = A.eventBody({ id: 'm', ...n });
  assert.deepEqual(body.start, { date: '2026-11-10' }); assert.deepEqual(body.end, { date: '2026-11-13' });
});

test('moving a meeting keeps its length', () => {
  const before = { date: '2026-11-09', time: '21:00', endTime: '21:45', endDate: '2026-11-09' };
  assert.deepEqual(A.keepDuration(before, { time: '22:00' }), { time: '22:00', allDay: false, endTime: '22:45', endDate: '2026-11-09' });
  assert.deepEqual(A.keepDuration(before, { date: '2026-11-12' }), { date: '2026-11-12', endTime: '21:45', endDate: '2026-11-12' });
  assert.deepEqual(A.keepDuration(before, { title: 'x' }), { title: 'x' });
  assert.equal(A.keepDuration(before, { time: '23:30' }).endDate, '2026-11-10');
});

test('linked pair: whoever changed since the last sync wins; both changed -> later edit', () => {
  const m = { id: 'm', title: 'א', date: '2026-11-09', time: '10:00', endTime: '11:00', calendarEventId: 'e', updatedAt: '2026-11-08T10:00:00Z' };
  const ev = { id: 'e', status: 'confirmed', summary: 'א', start: { dateTime: '2026-11-09T10:00:00+02:00' }, end: { dateTime: '2026-11-09T11:00:00+02:00' }, updated: '2026-11-08T09:00:00Z' };
  const link = { key: 'g_m', eventId: 'e', hash: A.fieldsHash(A.normalize(m)) };
  assert.equal(A.reconcile(m, ev, link, 'g_m', true).type, 'none');
  assert.equal(A.reconcile({ ...m, title: 'ב' }, ev, link, 'g_m', true).type, 'push');
  assert.equal(A.reconcile(m, { ...ev, summary: 'ג' }, link, 'g_m', true).type, 'pull');
  assert.equal(A.reconcile({ ...m, title: 'ב' }, { ...ev, summary: 'ג', updated: '2026-11-08T11:00:00Z' }, link, 'g_m', true).type, 'pull');
  assert.equal(A.reconcile({ ...m, title: 'ב', updatedAt: '2026-11-08T12:00:00Z' }, { ...ev, summary: 'ג', updated: '2026-11-08T11:00:00Z' }, link, 'g_m', true).type, 'push');
  assert.equal(A.reconcile(m, { ...ev, status: 'cancelled' }, link, 'g_m', true).type, 'cancel_meeting');
  assert.equal(A.reconcile(m, { ...ev, status: 'cancelled' }, null, 'g_m', true).type, 'revive');
});

// ───────────────────────── whole passes ─────────────────────────

function fakeDb(seed) {
  const data = {}; let n = 0;
  for (const [c, docs] of Object.entries(seed)) data[c] = new Map(Object.entries(docs));
  const col = (c) => { if (!data[c]) data[c] = new Map(); return data[c]; };
  const snap = (entries) => ({ empty: !entries.length, docs: entries.map(([id, v]) => ({ id, data: () => ({ ...v }) })) });
  const query = (c, filters = []) => ({
    where: (f, op, v) => query(c, [...filters, [f, op, v]]),
    limit: () => query(c, filters),
    get: async () => snap([...col(c)].filter(([, v]) => filters.every(([f, op, w]) => {
      const x = v[f]; if (x == null || typeof x === 'object') return false;
      return op === '>=' ? x >= w : op === '<=' ? x <= w : op === '>' ? x > w : x === w;
    }))),
  });
  const doc = (c, id) => ({
    id,
    get: async () => ({ exists: col(c).has(id), data: () => (col(c).has(id) ? { ...col(c).get(id) } : undefined) }),
    set: async (v, o) => { col(c).set(id, o && o.merge ? { ...(col(c).get(id) || {}), ...v } : { ...v }); },
    update: async (v) => { col(c).set(id, { ...col(c).get(id), ...v }); },
    delete: async () => { col(c).delete(id); },
  });
  return {
    data,
    collection: (c) => ({ ...query(c), doc: (id) => doc(c, id), add: async (v) => { const id = `new${++n}`; col(c).set(id, { ...v }); return { id }; } }),
    runTransaction: async (fn) => fn({ get: (r) => r.get(), set: (r, v, o) => r.set(v, o) }),
  };
}

function fakeCal(seed) {
  const ev = new Map(seed.map((e) => [e.id, e])); let clock = Date.parse('2026-11-08T18:30:00Z'); const log = [];
  const touch = (e) => { clock += 1000; e.updated = new Date(clock).toISOString(); return e; };
  // Google answers with Israel's offset for that day (+02:00 winter, +03:00 summer).
  const offset = (local) => ['+02:00', '+03:00'].find((o) => G.eventLocal({ start: { dateTime: `${local}${o}` } }).time === local.slice(11, 16)) || '+02:00';
  const zoned = (t) => (t && t.dateTime && !/[+Z]/.test(t.dateTime.slice(19)) ? { dateTime: `${t.dateTime}${offset(t.dateTime)}`, timeZone: t.timeZone } : t);
  const merge = (a, b0) => { const b = { ...b0 }; if (b.start) b.start = zoned(b.start); if (b.end) b.end = zoned(b.end); return mergeRaw(a, b); };
  const mergeRaw = (a, b) => ({ ...a, ...b, extendedProperties: b.extendedProperties ? { private: { ...((a.extendedProperties || {}).private || {}), ...b.extendedProperties.private } } : a.extendedProperties });
  return {
    ev, log,
    listWindow: async () => [...ev.values()].map((e) => JSON.parse(JSON.stringify(e))),
    changesSince: async () => ({ changed: true, token: 't' }),
    get: async (id) => { if (!ev.has(id)) { const e = new Error('nf'); e.status = 404; throw e; } return JSON.parse(JSON.stringify(ev.get(id))); },
    insertAt: async (id, body) => {
      log.push(['insert', body.summary]);
      const e = touch(ev.has(id) ? { ...merge(ev.get(id), body), status: 'confirmed' } : merge({ id, status: 'confirmed', htmlLink: `https://cal/${id}` }, body));
      ev.set(id, e); return JSON.parse(JSON.stringify(e));
    },
    patch: async (id, body) => { log.push(['patch', body.summary || 'tag']); const e = touch(merge(ev.get(id), body)); ev.set(id, e); return JSON.parse(JSON.stringify(e)); },
    remove: async (id) => { log.push(['remove', id]); touch(ev.get(id)).status = 'cancelled'; },
  };
}

const job = { notes: [], note(s) { this.notes.push(s); } };
const live = (db) => [...db.data.meetings].filter(([, m]) => !m.deletedAt);

test("Lou's meetings come in once, a CRM meeting goes out once, then nothing to do", async () => {
  const { _internal } = require('../../calendar-sync-background.js');
  const db = fakeDb({
    players: { p1: { fullName: 'נווה סלנט', stage: 'represented' } },
    meetings: { m1: { title: 'פגישה עם נווה סלנט', date: d(1), time: '12:00', endTime: '13:00', linkedPlayers: ['p1'], location: 'המשרד', notes: '', updatedAt: '2026-11-08T18:00:00Z' } },
  });
  const cal = fakeCal([
    { id: 'uick', status: 'confirmed', summary: "Gold A&S | Harwin's (Jonah)", start: { dateTime: `${d(0)}T21:00:00+02:00` }, end: { dateTime: `${d(0)}T21:45:00+02:00` },
      attendees: [{ email: 'mharwin@gmail.com' }, { email: 'lou.korek@gmail.com', self: false, responseStatus: 'declined' }], hangoutLink: 'https://meet.google.com/rut', htmlLink: 'https://cal/uick', updated: '2026-11-04T13:18:40Z' },
    { id: 'e1n7', status: 'confirmed', summary: "Gold A&S | Dubinsky's (Shay)", start: { dateTime: `${d(2)}T18:00:00+02:00` }, end: { dateTime: `${d(2)}T18:45:00+02:00` }, location: 'G כוכב הצפון', description: '<b>חשוב</b>', updated: '2026-11-04T06:14:48Z' },
    { id: 'old', status: 'confirmed', summary: 'פגישה ישנה', start: { dateTime: `${d(-30)}T10:00:00+02:00` }, end: { dateTime: `${d(-30)}T11:00:00+02:00` }, updated: '2026-10-01T00:00:00Z' },
  ]);

  const r1 = await _internal.agencyPass(db, cal, {}, job, { force: true });
  assert.equal(r1.counts.import, 2);
  assert.equal(r1.counts.insert, 1);
  const rows = live(db).map(([, m]) => m);
  const harwin = rows.find((m) => m.title.includes('Harwin'));
  assert.equal(harwin.time, '21:00'); assert.equal(harwin.endTime, '21:45');
  assert.equal(harwin.meetUrl, 'https://meet.google.com/rut');
  assert.deepEqual(harwin.guests, ['mharwin@gmail.com', 'lou.korek@gmail.com']);
  assert.equal(rows.find((m) => m.title.includes('Dubinsky')).notes, 'חשוב');
  assert.ok(![...db.data.meetings.values()].some((m) => m.title === 'פגישה ישנה'), 'outside the window stays out');
  const out = [...cal.ev.values()].find((e) => e.summary === 'פגישה עם נווה סלנט');
  assert.equal(G.eventLocal(out).time, '12:00');
  assert.equal(out.extendedProperties.private.goldasMeeting, 'm1');
  assert.equal(db.data.meetings.get('m1').calendarEventId, out.id);
  // Lou's description and guests were not touched by the import tag.
  assert.equal(cal.ev.get('e1n7').description, '<b>חשוב</b>');
  assert.equal(cal.ev.get('uick').attendees.length, 2);

  cal.log.length = 0;
  const r2 = await _internal.agencyPass(db, cal, {}, job, { force: true });
  assert.deepEqual(Object.keys(r2.counts).filter((k) => k !== 'none'), [], `second pass: ${JSON.stringify(r2.counts)}`);
  assert.equal(cal.log.length, 0);
});

test('edits, moves, deletes and a restore travel both ways and settle', async () => {
  const { _internal } = require('../../calendar-sync-background.js');
  const db = fakeDb({ players: {}, meetings: {} });
  const cal = fakeCal([
    { id: 'a', status: 'confirmed', summary: 'פגישה עסקית', start: { dateTime: `${d(3)}T10:00:00+02:00` }, end: { dateTime: `${d(3)}T11:30:00+02:00` }, description: '<p>שורה</p>', updated: '2026-11-08T10:00:00Z' },
    { id: 'b', status: 'confirmed', summary: 'פגישה עם מועדון', start: { dateTime: `${d(4)}T09:00:00+02:00` }, end: { dateTime: `${d(4)}T10:00:00+02:00` }, updated: '2026-11-08T10:00:00Z' },
    { id: 'c', status: 'confirmed', summary: 'שיחה', start: { dateTime: `${d(5)}T09:00:00+02:00` }, end: { dateTime: `${d(5)}T09:30:00+02:00` }, updated: '2026-11-08T10:00:00Z' },
  ]);
  await _internal.agencyPass(db, cal, {}, job, { force: true });
  const idOf = (evId) => [...db.data.meetings].find(([, m]) => m.calendarEventId === evId)[0];
  const [ma, mb, mc] = ['a', 'b', 'c'].map(idOf);

  // Lou moves "a" in Google; the CRM renames "b"; Lou deletes "c" in Google.
  Object.assign(cal.ev.get('a'), { start: { dateTime: `${d(6)}T14:00:00+02:00` }, end: { dateTime: `${d(6)}T15:30:00+02:00` }, updated: '2026-11-09T08:00:00Z' });
  db.data.meetings.set(mb, { ...db.data.meetings.get(mb), title: 'פגישה עם מכבי', updatedAt: '2026-11-09T08:00:00Z' });
  Object.assign(cal.ev.get('c'), { status: 'cancelled', updated: '2026-11-09T08:00:00Z' });
  const r = await _internal.agencyPass(db, cal, {}, job, { force: true });
  assert.equal(r.counts.pull, 1); assert.equal(r.counts.push, 1); assert.equal(r.counts.cancel_meeting, 1);
  assert.equal(db.data.meetings.get(ma).date, d(6)); assert.equal(db.data.meetings.get(ma).time, '14:00');
  assert.equal(cal.ev.get('b').summary, 'פגישה עם מכבי');
  assert.ok(db.data.meetings.get(mc).deletedAt, 'deleted in Google -> recycle bin');
  assert.equal(cal.ev.get('a').description, '<p>שורה</p>', 'a pull never rewrites the description');

  // The CRM deletes "b": gone from Google. Then it is restored: back in Google.
  db.data.meetings.set(mb, { ...db.data.meetings.get(mb), deletedAt: '2026-11-09T09:00:00Z' });
  const r3 = await _internal.agencyPass(db, cal, {}, job, { force: true });
  assert.equal(r3.counts.remove_event, 1);
  assert.equal(cal.ev.get('b').status, 'cancelled');
  db.data.meetings.set(mb, { ...db.data.meetings.get(mb), deletedAt: null, restoredAt: '2026-11-09T09:05:00Z' });
  const r4 = await _internal.agencyPass(db, cal, {}, job, { force: true });
  assert.equal(r4.counts.revive, 1);
  assert.equal(cal.ev.get('b').status, 'confirmed');

  cal.log.length = 0;
  const r5 = await _internal.agencyPass(db, cal, {}, job, { force: true });
  assert.deepEqual(Object.keys(r5.counts).filter((k) => k !== 'none'), [], `settled: ${JSON.stringify(r5.counts)}`);
  assert.equal(cal.log.length, 0);
});

test('a calendar event whose meeting was purged is removed, not imported again', () => {
  const ev = { id: 'z', status: 'confirmed', summary: 'x', start: { dateTime: `${d(1)}T10:00:00+02:00` }, end: { dateTime: `${d(1)}T11:00:00+02:00` }, extendedProperties: { private: { goldasMeeting: 'gone' } } };
  const w = A.windowRange();
  const acts = A.plan({ meetings: [], events: [ev], links: new Map(), from: w.from, to: w.to });
  assert.deepEqual(acts.map((a) => a.type), ['remove_orphan']);
});
