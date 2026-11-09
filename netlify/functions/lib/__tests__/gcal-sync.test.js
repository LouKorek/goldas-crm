const test = require('node:test');
const assert = require('node:assert/strict');
const { occurrences } = require('@goldas/domain');
const G = require('../gcal-sync.js');

const players = [
  { id: 'p1', fullName: 'נווה סלנט', stage: 'represented', currentClub: 'הפועל באר שבע' },
  { id: 'p2', fullName: 'אסף אקרמן', stage: 'represented', currentClub: 'מכבי נתניה' },
  { id: 'p3', fullName: 'נועם ברזילי', stage: 'represented' },
];
const win = { from: '2026-11-05', to: '2027-01-07' };
const items = (matches, trainings) => G.crmItems({ matches, trainings, players, ...win, occurrences });
const foreign = (over) => ({ id: 'lou1', status: 'confirmed', updated: '2026-11-08T17:57:00Z', created: '2026-11-08T17:57:00Z', ...over });

test('parses the titles Lou uses', () => {
  assert.deepEqual(G.parseSummary('אימון — נווה סלנט'), { kind: 'training', label: 'אימון', names: ['נווה סלנט'], home: '', away: '' });
  const m = G.parseSummary('משחק — אסף אקרמן — שעה לאישור');
  assert.equal(m.kind, 'match'); assert.deepEqual(m.names, ['אסף אקרמן']);
  const f = G.parseSummary('משחק אימון — רפאל ליבסמן — הפועל ראשון נגד מכבי');
  assert.equal(f.label, 'משחק אימון'); assert.equal(f.home, 'הפועל ראשון'); assert.equal(f.away, 'מכבי');
  assert.equal(G.parseSummary('פגישה עם סוכן'), null);
});

test('a timed training is a one-minute marker with an hour reminder', () => {
  const [it] = items([], [{ id: 't1', title: 'אימון', date: '2026-11-09', time: '14:30', place: 'לכיש', linkedPlayers: ['p1'] }]);
  const b = G.desiredEvent(it);
  assert.equal(b.summary, 'אימון — נווה סלנט');
  assert.deepEqual(b.start, { dateTime: '2026-11-09T14:30:00', timeZone: 'Asia/Jerusalem' });
  assert.deepEqual(b.end, { dateTime: '2026-11-09T14:31:00', timeZone: 'Asia/Jerusalem' });
  assert.deepEqual(b.reminders.overrides, [{ method: 'popup', minutes: 60 }]);
  assert.equal(b.transparency, 'transparent'); assert.equal(b.visibility, 'private');
  assert.equal(b.location, 'לכיש');
  assert.equal(b.extendedProperties.private.goldasKey, 't_t1_2026-11-09');
});

test('a game without a time is all-day, "שעה לאישור", no reminder', () => {
  const [it] = items([{ id: 'm1', date: '2026-11-10', time: '', homeTeam: 'מכבי נתניה', awayTeam: 'הפועל חיפה', linkedPlayers: ['p2'] }], []);
  const b = G.desiredEvent(it);
  assert.equal(b.summary, 'משחק — אסף אקרמן — מכבי נתניה נגד הפועל חיפה — שעה לאישור');
  assert.deepEqual(b.start, { date: '2026-11-10' }); assert.deepEqual(b.end, { date: '2026-11-11' });
  assert.deepEqual(b.reminders.overrides, []);
});

test('23:59 marker ends on the next day', () => {
  assert.deepEqual(G.plusMinutes('2026-12-31', '23:59', 1), { date: '2027-01-01', time: '00:00' });
});

test('weekly training: one event per session, outside the window skipped', () => {
  const list = items([], [{ id: 't2', title: 'אימון', time: '17:00', linkedPlayers: ['p3'], rule: { freq: 'weekly', byWeekday: [0], start: '2026-11-01', until: '2026-11-30' } }]);
  assert.deepEqual(list.map((i) => i.date), ['2026-11-08', '2026-11-15', '2026-11-22', '2026-11-29']);
});

test('new CRM item with nothing in the calendar is inserted', () => {
  const its = items([], [{ id: 't1', date: '2026-11-09', time: '14:30', linkedPlayers: ['p1'] }]);
  const acts = G.plan({ items: its, events: [], links: new Map(), players });
  assert.equal(acts[0].type, 'insert');
});

test("Lou's own event for the same player and day is adopted, not duplicated; the newer side wins", () => {
  const its = items([], [{ id: 't1', date: '2026-11-09', time: '17:00', linkedPlayers: ['p1'], updatedAt: '2026-10-01T00:00:00Z' }]);
  const ev = foreign({ summary: 'אימון — נווה סלנט', start: { dateTime: '2026-11-09T14:30:00+02:00' }, location: 'לכיש', description: '<p>הגעה 14:30</p>' });
  const acts = G.plan({ items: its, events: [ev], links: new Map(), players });
  assert.equal(acts.length, 1);
  assert.equal(acts[0].type, 'adopt');
  assert.deepEqual(acts[0].patch, { time: '14:30', place: 'לכיש', notes: 'הגעה 14:30' });
});

test("Lou's event with no CRM record is imported and linked to the player", () => {
  const ev = foreign({ summary: 'משחק — אסף אקרמן — שעה לאישור', start: { date: '2026-11-10' }, end: { date: '2026-11-11' }, description: '<p>משחק; פרטים יימסרו בהמשך.</p>' });
  const acts = G.plan({ items: [], events: [ev], links: new Map(), players });
  assert.equal(acts[0].type, 'import');
  assert.equal(acts[0].record.collection, 'matches');
  assert.deepEqual(acts[0].record.data.linkedPlayers, ['p2']);
  assert.equal(acts[0].record.data.homeTeam, 'מכבי נתניה');
  assert.equal(acts[0].record.data.time, '');
  assert.equal(acts[0].record.data.notes, 'משחק; פרטים יימסרו בהמשך.');
});

test('an imported friendly keeps its label in the title', () => {
  const ev = foreign({ summary: 'משחק אימון — נווה סלנט — שעה לאישור', start: { date: '2026-11-13' }, location: 'ראשון לציון' });
  const [a] = G.plan({ items: [], events: [ev], links: new Map(), players });
  const rec = { id: 'new', ...a.record.data };
  const [it] = items([rec], []);
  assert.equal(G.desiredEvent(it).summary, 'משחק אימון — נווה סלנט — שעה לאישור');
});

test('an unknown name is left alone', () => {
  const ev = foreign({ summary: 'אימון — שחקן לא קיים', start: { date: '2026-11-13' } });
  const [a] = G.plan({ items: [], events: [ev], links: new Map(), players });
  assert.equal(a.type, 'ignore');
});

const synced = (tr, over = {}) => {
  const [it] = items([], [tr]);
  const body = G.desiredEvent(it);
  const ev = { id: 'gasx', status: 'confirmed', updated: '2026-11-08T10:00:00Z', ...body, start: { dateTime: `${it.date}T${it.time}:00+02:00` }, ...over };
  const links = new Map([[it.key, { key: it.key, hash: G.bodyHash(body), eventUpdated: '2026-11-08T10:00:00Z', eventId: 'gasx' }]]);
  return { it, ev, links };
};

test('nothing changed on either side: nothing to do', () => {
  const tr = { id: 't1', date: '2026-11-09', time: '14:30', linkedPlayers: ['p1'] };
  const { ev, links } = synced(tr);
  const acts = G.plan({ items: items([], [tr]), events: [ev], links, players });
  assert.deepEqual(acts.map((a) => a.type), ['none']);
});

test('changed in the CRM: pushed to the calendar', () => {
  const tr = { id: 't1', date: '2026-11-09', time: '14:30', linkedPlayers: ['p1'] };
  const { ev, links } = synced(tr);
  const acts = G.plan({ items: items([], [{ ...tr, time: '15:00' }]), events: [ev], links, players });
  assert.equal(acts[0].type, 'push');
  assert.equal(acts[0].body.start.dateTime, '2026-11-09T15:00:00');
});

test('moved in the calendar: one session of a weekly training becomes an exception', () => {
  const tr = { id: 't2', time: '17:00', linkedPlayers: ['p3'], rule: { freq: 'weekly', byWeekday: [0], start: '2026-11-08', until: '2026-11-08' } };
  const { ev, links } = synced(tr);
  const moved = { ...ev, updated: '2026-11-08T12:00:00Z', start: { dateTime: '2026-11-08T18:15:00+02:00' } };
  const acts = G.plan({ items: items([], [tr]), events: [moved], links, players });
  assert.equal(acts[0].type, 'pull');
  assert.deepEqual(acts[0].patch, { exceptions: [{ date: '2026-11-08', date2: '2026-11-08', time: '18:15' }] });
});

test('deleted in the calendar: the session is cancelled, the rule stays', () => {
  const tr = { id: 't2', time: '17:00', linkedPlayers: ['p3'], rule: { freq: 'weekly', byWeekday: [0], start: '2026-11-08', until: '2026-11-08' } };
  const { ev, links } = synced(tr);
  const acts = G.plan({ items: items([], [tr]), events: [{ ...ev, status: 'cancelled' }], links, players });
  assert.equal(acts[0].type, 'deleted_in_calendar');
  assert.deepEqual(acts[0].patch, { exceptions: [{ date: '2026-11-08', cancelled: true }] });
});

test('an IFA fixture deleted in the calendar is only hidden, never deleted', () => {
  const [it] = items([{ id: 'm9', date: '2026-11-10', time: '19:00', homeTeam: 'א', awayTeam: 'ב', linkedPlayers: ['p2'], source: 'ifa' }], []);
  assert.deepEqual(G.deletionPatch(it), { calendarSkip: true });
});

test('push-only mode never writes the CRM', () => {
  const ev = foreign({ summary: 'אימון — נווה סלנט', start: { date: '2026-11-13' } });
  const acts = G.plan({ items: [], events: [ev], links: new Map(), players, mode: 'push' });
  assert.equal(acts.length, 0);
});

test('a synced event whose CRM item is gone is removed', () => {
  const tr = { id: 't1', date: '2026-11-09', time: '14:30', linkedPlayers: ['p1'] };
  const { ev, links } = synced(tr);
  const acts = G.plan({ items: [], events: [ev], links, players });
  assert.deepEqual(acts.map((a) => a.type), ['remove']);
});

test('Israel local time from an event, both offsets', () => {
  assert.deepEqual(G.eventLocal({ start: { dateTime: '2026-11-09T12:30:00Z' } }), { date: '2026-11-09', time: '14:30' });
  assert.deepEqual(G.eventLocal({ start: { dateTime: '2026-07-01T22:30:00Z' } }), { date: '2026-07-02', time: '01:30' });
});

test('notes survive the footer round trip', () => {
  const [it] = items([], [{ id: 't1', date: '2026-11-09', time: '14:30', linkedPlayers: ['p1'], notes: 'הגעה 14:30\nסט שחור' }]);
  const b = G.desiredEvent(it);
  assert.equal(G.notesFromDescription(b.description), 'הגעה 14:30\nסט שחור');
  assert.equal(G.notesFromDescription(`<p>${b.description.replace(/\n/g, '<br>')}</p>`), 'הגעה 14:30\nסט שחור');
});

test('the access problem says what to do', () => {
  assert.equal(G.accessProblem({ status: 403, reason: 'accessNotConfigured', message: '' }, 'sa@x').state, 'needs_api');
  assert.equal(G.accessProblem({ status: 404, reason: 'notFound', message: '' }, 'sa@x').state, 'needs_share');
});

// Real shape: the CRM keeps names in English, Lou writes them in Hebrew.
const en = [
  { id: 'e1', fullName: 'Assaf Ackerman', stage: 'represented' },
  { id: 'e2', fullName: 'Naveh Salant', stage: 'represented' },
  { id: 'e3', fullName: 'Noam Barzilai', stage: 'represented' },
  { id: 'e4', fullName: 'Raphael Libesman', stage: 'represented' },
  { id: 'e5', fullName: 'Eyal Perchitsky', stage: 'represented' },
  { id: 'e6', fullName: 'Eitan Rosen', stage: 'represented' },
  { id: 'e7', fullName: 'Omri Shalom Takala', stage: 'represented' },
  { id: 'e8', fullName: 'Shay Dubinsky', stage: 'represented' },
];
const enItems = (matches, trainings = []) => G.crmItems({ matches, trainings, players: en, ...win, occurrences });

test('Hebrew names in the calendar find the English names in the CRM', () => {
  const ids = (n) => G.findPlayers([n], en);
  assert.deepEqual(ids('אסף אקרמן'), ['e1']);
  assert.deepEqual(ids('נווה סלנט'), ['e2']);
  assert.deepEqual(ids('נועם ברזילי'), ['e3']);
  assert.deepEqual(ids('רפאל ליבסמן'), ['e4']);
  assert.deepEqual(ids('אייל פרשיצקי'), ['e5']);
  assert.deepEqual(ids('איתן רוזן'), ['e6']);
  assert.deepEqual(ids('עומרי טקלה'), ['e7']);
  assert.deepEqual(ids('שי דובינסקי'), ['e8']);
  assert.deepEqual(ids('יוסי כהן'), []);
});

test('the same game twice in the CRM gets one event', () => {
  const g = { date: '2026-11-20', time: '12:00', homeTeam: 'הפ\' חדרה', awayTeam: 'מ.כ. שדרות', linkedPlayers: ['e6'], source: 'ifa' };
  const its = enItems([{ id: 'b', ...g, createdAt: '2026-11-02T00:00:00Z' }, { id: 'a', ...g, createdAt: '2026-11-01T00:00:00Z' }]);
  assert.equal(its.length, 1); assert.equal(its[0].crmId, 'a');
});

test("Lou's placeholder takes over from the server's copy of the same game", () => {
  const m = { id: 'm1', date: '2026-11-10', time: '18:30', homeTeam: 'הפועל חדרה', awayTeam: 'הפ\' ירושלים', linkedPlayers: ['e1'], source: 'ifa', updatedAt: '2026-11-01T00:00:00Z' };
  const [item] = enItems([m]);
  const body = G.desiredEvent(item);
  const ours = { id: G.eventIdFor(item.key), status: 'confirmed', ...body, updated: '2026-11-08T18:58:59Z' };
  const lou = foreign({ id: 'lou-ph', summary: 'משחק — אסף אקרמן — שעה לאישור', start: { date: '2026-11-10' }, end: { date: '2026-11-11' }, description: 'משחק; פרטים יימסרו בהמשך.' });
  const links = new Map([[item.key, { hash: G.bodyHash(body), eventId: ours.id }]]);
  const acts = G.plan({ items: [item], events: [ours, lou], links, players: en });
  assert.equal(acts.length, 1);
  assert.equal(acts[0].type, 'adopt'); assert.equal(acts[0].event.id, 'lou-ph'); assert.equal(acts[0].replaces.id, ours.id);
  // Next pass: Lou's event carries the key, the copy is cancelled; nothing more to do.
  const adopted = { ...lou, ...body, id: 'lou-ph', status: 'confirmed', updated: '2026-11-08T19:10:00Z' };
  const next = G.plan({ items: [item], events: [{ ...ours, status: 'cancelled' }, adopted], links: new Map([[item.key, { hash: G.bodyHash(body), eventId: 'lou-ph', eventUpdated: adopted.updated }]]), players: en });
  assert.ok(next.every((a) => a.type === 'none'), JSON.stringify(next.map((a) => a.type)));
});

test("a second record with a similar name does not stop Lou's placeholder from taking over", () => {
  const twins = [...en, { id: 'x1', fullName: 'Asaf Akerman', stage: 'prospect' }];
  assert.deepEqual(G.findPlayers(['אסף אקרמן'], twins), []);   // ambiguous on the whole list
  const m = { id: 'm1', date: '2026-11-10', time: '18:30', homeTeam: 'הפועל חדרה', awayTeam: 'הפ\' ירושלים', linkedPlayers: ['e1'], source: 'ifa', updatedAt: '2026-11-01T00:00:00Z' };
  const [item] = G.crmItems({ matches: [m], trainings: [], players: twins, ...win, occurrences });
  const body = G.desiredEvent(item);
  const ours = { id: G.eventIdFor(item.key), status: 'confirmed', ...body, updated: '2026-11-08T18:58:59Z' };
  const lou = foreign({ id: 'lou-ph', summary: 'משחק — אסף אקרמן — שעה לאישור', start: { date: '2026-11-10' }, end: { date: '2026-11-11' } });
  const links = new Map([[item.key, { hash: G.bodyHash(body), eventId: ours.id }]]);
  const acts = G.plan({ items: [item], events: [ours, lou], links, players: twins });
  assert.equal(acts[0].type, 'adopt'); assert.equal(acts[0].event.id, 'lou-ph'); assert.equal(acts[0].replaces.id, ours.id);
});

test("patching an all-day placeholder into a timed game clears the all-day form (and back)", () => {
  const calls = [];
  const cal = G.api({ call: async (method, path, opts) => { calls.push({ method, path, data: opts && opts.data }); return { id: 'x' }; } }, 'cal1');
  const timed = G.desiredEvent(enItems([{ id: 'm1', date: '2026-11-10', time: '18:30', homeTeam: 'א', awayTeam: 'ב', linkedPlayers: ['e1'], updatedAt: '2026-11-01T00:00:00Z' }])[0]);
  return cal.patch('lou-ph', timed).then(() => {
    const { data } = calls[0];
    assert.equal(data.start.date, null); assert.equal(data.end.date, null);
    assert.equal(data.start.dateTime, '2026-11-10T18:30:00');
    // The hash the links keep is unaffected: desiredEvent itself is unchanged.
    assert.equal('date' in timed.start, false);
    const allDay = G.desiredEvent(enItems([{ id: 'm2', date: '2026-11-12', time: '', homeTeam: 'א', awayTeam: 'ב', linkedPlayers: ['e1'], updatedAt: '2026-11-01T00:00:00Z' }])[0]);
    return cal.patch('lou-2', allDay);
  }).then(() => {
    const { data } = calls[1];
    assert.equal(data.start.dateTime, null); assert.equal(data.start.date, '2026-11-12');
    assert.equal(data.end.dateTime, null);
    return cal.upsert('new1', timed);
  }).then(() => {
    // A plain insert sends the body as drawn, with no null fields.
    assert.equal(calls[2].method, 'POST'); assert.equal('date' in calls[2].data.start, false);
  });
});
