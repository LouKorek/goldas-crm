// End-to-end run of the calendar sync against an in-memory Firestore and an
// in-memory Google calendar: two passes must settle (the second does nothing).
const test = require('node:test');
const assert = require('node:assert/strict');

function fakeDb(seed) {
  const data = {}; let n = 0;
  for (const [c, docs] of Object.entries(seed)) data[c] = new Map(Object.entries(docs));
  const col = (c) => { if (!data[c]) data[c] = new Map(); return data[c]; };
  const snap = (c, entries) => ({ empty: !entries.length, docs: entries.map(([id, v]) => ({ id, data: () => ({ ...v }) })) });
  const query = (c, filters = []) => ({
    where: (f, op, v) => query(c, [...filters, [f, op, v]]),
    limit: () => query(c, filters),
    get: async () => snap(c, [...col(c)].filter(([, v]) => filters.every(([f, op, w]) => {
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
  const ev = new Map(seed.map((e) => [e.id, e])); let clock = Date.parse('2026-11-08T18:10:00Z'); const log = [];
  const touch = (e) => { clock += 1000; e.updated = new Date(clock).toISOString(); return e; };
  return {
    ev, log,
    listWindow: async () => [...ev.values()].map((e) => JSON.parse(JSON.stringify(e))),
    changesSince: async () => ({ changed: true, token: 't' }),
    get: async (id) => { if (!ev.has(id)) { const e = new Error('nf'); e.status = 404; throw e; } return ev.get(id); },
    upsert: async (id, body) => { log.push(['insert', body.summary]); const e = touch({ id, status: 'confirmed', ...body }); ev.set(id, e); return e; },
    patch: async (id, body) => { log.push(['patch', body.summary]); const e = touch({ ...ev.get(id), ...body }); ev.set(id, e); return e; },
    remove: async (id) => { log.push(['remove', id]); ev.get(id).status = 'cancelled'; },
  };
}

test('real-looking data: Lou\'s events are adopted or imported once, then everything settles', async () => {
  process.env.FIREBASE_SERVICE_ACCOUNT_KEY = process.env.FIREBASE_SERVICE_ACCOUNT_KEY || '{"project_id":"x"}';
  const { _internal } = require('../../calendar-sync-background.js');
  const today = require('@goldas/domain').israelDate();
  const d = (n) => require('@goldas/domain').addDays(today, n);
  const db = fakeDb({
    players: { p1: { fullName: 'נווה סלנט', stage: 'represented', currentClub: 'הפועל באר שבע' }, p2: { fullName: 'אסף אקרמן', stage: 'represented', currentClub: 'מכבי נתניה' } },
    trainings: { t1: { title: 'אימון', time: '15:15', linkedPlayers: ['p1'], rule: { freq: 'weekly', byWeekday: [0, 1, 2, 3, 4], start: d(0), until: d(13) }, exceptions: [], updatedAt: '2026-10-01T00:00:00Z' } },
    matches: { m1: { date: d(2), time: '19:00', homeTeam: 'מכבי נתניה', awayTeam: 'הפועל חיפה', linkedPlayers: ['p2'], source: 'ifa', updatedAt: '2026-10-01T00:00:00Z' } },
  });
  const cal = fakeCal([
    { id: 'a', status: 'confirmed', summary: 'אימון — נווה סלנט', start: { dateTime: `${d(1)}T14:30:00+02:00` }, location: 'לכיש', description: '<p>הגעה 14:30</p>', updated: '2026-11-08T18:00:13Z' },
    { id: 'b', status: 'confirmed', summary: 'משחק — אסף אקרמן — שעה לאישור', start: { date: d(2) }, end: { date: d(3) }, updated: '2026-11-08T17:57:20Z' },
    { id: 'c', status: 'confirmed', summary: 'אימון — אסף אקרמן', start: { dateTime: `${d(1)}T18:00:00+02:00` }, updated: '2026-11-08T18:00:17Z' },
    { id: 'z', status: 'confirmed', summary: 'יום הולדת לאמא', start: { date: d(4) }, updated: '2026-11-08T18:00:17Z' },
  ]);
  const notes = []; const job = { note: (s) => notes.push(s) };
  const r1 = await _internal.fullPass(db, cal, {}, job, { force: true });
  assert.equal(r1.counts.adopt, 2, JSON.stringify(r1.counts));
  assert.equal(r1.counts.import, 1);
  assert.equal(r1.counts.ignore, 1);
  // Naveh's session tomorrow moved to Lou's marker time, only that one.
  const t1 = db.data.trainings.get('t1');
  assert.deepEqual(t1.exceptions, [{ date: d(1), date2: d(1), time: '14:30', notes: 'הגעה 14:30' }]);
  // The IFA game kept its time and Lou's all-day marker became the timed event.
  assert.equal(cal.ev.get('b').start.dateTime, `${d(2)}T19:00:00`);
  assert.match(cal.ev.get('b').summary, /^משחק — אסף אקרמן — מכבי נתניה נגד הפועל חיפה$/);
  // Asaf's training came into the CRM.
  const imported = [...db.data.trainings.entries()].find(([, v]) => v.source === 'calendar');
  assert.ok(imported); assert.deepEqual(imported[1].linkedPlayers, ['p2']); assert.equal(imported[1].time, '18:00');
  assert.equal(cal.ev.get('z').summary, 'יום הולדת לאמא');

  const before = cal.log.length;
  const r2 = await _internal.fullPass(db, cal, {}, job, { force: true });
  const busy = Object.entries(r2.counts).filter(([k]) => !['none', 'ignore'].includes(k));
  assert.deepEqual(busy, [], `second pass should do nothing: ${JSON.stringify(r2.counts)} ${JSON.stringify(cal.log.slice(before))}`);

  // Lou moves Naveh's session in 3 days and deletes the one in 4 days.
  const ownNaveh = (n) => [...cal.ev.values()].find((e) => e.extendedProperties && e.extendedProperties.private.goldasKey === `t_t1_${d(n)}`);
  const mv = ownNaveh(3); mv.start = { dateTime: `${d(3)}T16:45:00+02:00` }; mv.updated = '2030-01-01T00:00:00Z';
  ownNaveh(4).status = 'cancelled';
  const r3 = await _internal.fullPass(db, cal, {}, job, { force: true });
  assert.equal(r3.counts.pull, 1, JSON.stringify(r3.counts));
  assert.equal(r3.counts.deleted_in_calendar, 1);
  const ex = db.data.trainings.get('t1').exceptions;
  assert.ok(ex.some((e) => e.date === d(3) && e.time === '16:45'));
  assert.ok(ex.some((e) => e.date === d(4) && e.cancelled));
  const r4 = await _internal.fullPass(db, cal, {}, job, { force: true });
  assert.deepEqual(Object.keys(r4.counts).filter((k) => !['none', 'ignore'].includes(k)), [], JSON.stringify(r4.counts));
});
