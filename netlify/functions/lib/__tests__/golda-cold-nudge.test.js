// Relationship memory: Golda tells the owner about one contact he has not
// spoken with for 60 days, only when something open ties to that contact, at
// most once a day and the same contact at most once in 30 days. The map in the
// app keeps its own 90 days. In-memory Firestore; nothing reaches the network.
const test = require('node:test');
const assert = require('node:assert/strict');
delete process.env.ANTHROPIC_API_KEY;
delete process.env.SCRAPER_API_KEY;
globalThis.fetch = async () => { throw new Error('a test may not call the network'); };
const { fakeDb, stubFirestore, OWNER } = require('./fake-firestore.js');

stubFirestore(() => null);
const net = require('../golda-network.js');
const taps = require('../golda-taps.js');
const { buttonTitles, BUTTON_TITLE_MAX } = require('../wa-api.js');
const { COLD_AFTER_DAYS, addDays } = require('@goldas/domain');

const H = 3600000, DAY = 24 * H;
const NOW = new Date('2026-11-25T09:00:00Z');   // 11:00 in Israel
const TODAY = '2026-11-25';
const ago = (n) => `${addDays(TODAY, -n)}T09:00:00Z`;
const owner = { ...OWNER, phone: OWNER.whatsapp };
const THREAD = `wa_sessions/${OWNER.whatsapp}/threads`;
const touch = (days, extra = {}) => [{ id: `t${days}`, at: ago(days), channel: 'call', ...extra }];

// Who is tied to what:
//   b  spoke about the open deal d1 himself (a touch names it)          his own deal
//   c  gave the open requirement r2                                     his own requirement
//   h  works at the club of the open deal d1                            a deal at his club
//   a  works at the club of the open requirement r1                     a requirement at his club
//   d  cold, but nothing open ties to him; e spoke 20 days ago; f has no record at all; g only a closed deal
const WORLD = () => ({
  contacts: [
    { id: 'a', contactName: 'Avi Cohen', contactRole: 'Sporting Director', clubId: 'mh', clubName: 'Maccabi Haifa', contactPhone: '0501111111', touches: touch(70, { channel: 'whatsapp' }) },
    { id: 'b', contactName: 'Benny Levi', clubName: 'Real Betis', touches: touch(100, { dealId: 'd1' }) },
    { id: 'c', contactName: 'Carmel Dahan', clubName: 'Hapoel Tel Aviv' },
    { id: 'd', contactName: 'Dor Peretz', clubName: 'Ajax', touches: touch(200) },
    { id: 'e', contactName: 'Eli Mizrahi', clubId: 'mh', clubName: 'Maccabi Haifa', touches: touch(20) },
    { id: 'f', contactName: 'No Record', clubName: 'Real Betis' },
    { id: 'g', contactName: 'Gal Closed', clubName: 'Closed Club', touches: touch(150) },
    { id: 'h', contactName: 'Hugo Ruiz', contactRole: 'Scout', clubName: 'Real Betis', touches: touch(75, { channel: 'meeting' }) },
  ],
  clubs: [{ id: 'mh', name: 'Maccabi Haifa', key: 'maccabi haifa', aliases: ['מכבי חיפה'] }],
  deals: [
    { id: 'd1', playerId: 'p1', playerName: 'Noam Barzilai', clubName: 'Real Betis', stage: 'Negotiation', enteredStageAt: addDays(TODAY, -120), commission: 777777, payments: [{ amount: 777777 }] },
    { id: 'd2', playerName: 'Dana Levi', clubName: 'Closed Club', stage: 'Not Relevant', enteredStageAt: addDays(TODAY, -300) },
  ],
  requirements: [
    { id: 'r1', clubName: 'מכבי חיפה', status: 'open', requiredPosition: 'CB', budget: 555555, createdAt: ago(20) },
    { id: 'r2', clubName: 'Hapoel Tel Aviv', status: 'open', requiredPosition: 'ST', contactId: 'c', createdAt: ago(80) },
    { id: 'r3', clubName: 'Ajax', status: 'filled', createdAt: ago(90) },
  ],
  meetings: [], players: [{ id: 'p1', fullName: 'Noam Barzilai', stage: 'represented' }],
});
const byId = (list) => Object.fromEntries(list.map(({ id, ...rest }) => [id, rest]));
// The hourly run hands over what it already loaded (no contacts, no clubs); those are read from the database.
const hourly = () => { const { deals, requirements, meetings, players } = WORLD(); return { deals, requirements, meetings, players }; };
const store = (extra = {}) => { const w = WORLD(); return fakeDb({ contacts: byId(w.contacts), clubs: byId(w.clubs), ...extra }); };
const sender = () => { const out = []; return { out, send: async (u, body, kind, buttons = [], ref = null) => { out.push({ to: u.email, body, kind, buttons, ref }); return { state: 'sent' }; } }; };
const jobOf = () => { const notes = []; return { notes, note: (s) => notes.push(s) }; };
const later = (ms) => new Date(NOW.getTime() + ms);

test('who is worth a nudge: silent for more than 60 days and tied to an open deal or an open requirement, the closest tie first', () => {
  const list = net.coldCandidates(WORLD(), NOW, net.GOLDA_COLD_DAYS);
  assert.deepEqual(list.map((c) => [c.contactId, c.days, c.tieRank, c.tie]), [
    ['b', 100, 4, 'עסקה פתוחה: Noam Barzilai ↔ Real Betis (משא ומתן)'],
    ['c', 80, 3, 'דרישה פתוחה של Hapoel Tel Aviv: ST'],
    ['h', 75, 2, 'עסקה פתוחה: Noam Barzilai ↔ Real Betis (משא ומתן)'],
    ['a', 70, 1, 'דרישה פתוחה של מכבי חיפה: CB'],
  ]);
  assert.deepEqual([list[3].name, list[3].role, list[3].club, list[3].lastDate, list[3].channel], ['Avi Cohen', 'Sporting Director', 'Maccabi Haifa', addDays(TODAY, -70), 'whatsapp']);
  assert.deepEqual([list[1].lastDate, list[1].channel], [addDays(TODAY, -80), 'requirement'], 'the requirement he gave is the last contact with him');
  assert.ok(!JSON.stringify(list).includes('777777') && !JSON.stringify(list).includes('555555'), 'never an amount');
  // Left out: nothing open (d, g), spoke recently (e), no date at all (f).
  for (const id of ['d', 'e', 'f', 'g']) assert.ok(!list.some((c) => c.contactId === id), id);
  assert.equal(net.coldCandidates(WORLD(), NOW).length, 4, '60 days is the default here');
});

test('60 days is Golda\'s own number: the map in the app keeps the domain\'s 90', () => {
  assert.equal(net.GOLDA_COLD_DAYS, 60);
  assert.equal(COLD_AFTER_DAYS, 90);
  assert.deepEqual(net.coldCandidates(WORLD(), NOW, COLD_AFTER_DAYS).map((c) => c.contactId), ['b']);
  assert.deepEqual(net.coldCandidates({ ...WORLD(), deals: [], requirements: [] }, NOW), [], 'with nothing open nobody is mentioned');
  // A deal that moved last week is contact with the people tied to it.
  const moved = WORLD();
  moved.deals[0].enteredStageAt = addDays(TODAY, -7);
  assert.ok(!net.coldCandidates(moved, NOW).some((c) => c.contactId === 'b'));
});

test('the nudge: who, how long, when and how they last spoke, what is open, and the offer to draft', () => {
  const [b, , , a] = net.coldCandidates(WORLD(), NOW);
  const msg = net.buildColdNudge('לו', b);
  assert.equal(msg.text, [
    '*לא דיברתם מזמן* 📇',
    `לו, עם *Benny Levi* (Real Betis) לא דיברתם כבר 100 ימים. הפעם האחרונה: ${addDays(TODAY, -100).split('-').reverse().join('.')}, שיחה.`,
    'עסקה פתוחה: Noam Barzilai ↔ Real Betis (משא ומתן).',
    'לנסח הודעה? אתה שולח אותה בעצמך.',
  ].join('\n'));
  assert.deepEqual(msg.buttons, ['לנסח הודעה', 'לא עכשיו']);
  assert.deepEqual(buttonTitles(msg.buttons), msg.buttons);
  assert.ok(msg.buttons.every((x) => x.length <= BUTTON_TITLE_MAX));
  assert.match(net.buildColdNudge('לו', a).text, /עם \*Avi Cohen\* \(מנהל מקצועי, Maccabi Haifa\) לא דיברתם כבר 70 ימים\. הפעם האחרונה: \d\d\.\d\d\.2026, וואטסאפ\./);
  for (const c of [b, a]) {
    const text = net.buildColdNudge('לו', c).text;
    assert.ok(text.length < 600);
    assert.ok(!/[‒-―]/.test(text), 'no dash in what a person reads');
    assert.ok(!/0501111111|777777|555555/.test(text), 'no phone number and no amount');
  }
});

test('one nudge a day, to the owner, with its ref and buttons, kept in the chat; the note names nobody', async () => {
  const db = store();
  const s = sender();
  const job = jobOf();
  assert.deepEqual(await net.coldNudge(db, owner, hourly(), NOW, { hour: 11, send: s.send, job }), { sent: 1, contactId: 'b' });
  assert.deepEqual([s.out[0].to, s.out[0].kind, s.out[0].buttons, s.out[0].ref], ['lou.korek@gmail.com', 'cold', ['לנסח הודעה', 'לא עכשיו'], { type: 'cold', id: 'b' }]);
  assert.match(s.out[0].body, /^\*לא דיברתם מזמן\* 📇\nלו, עם \*Benny Levi\*/);
  assert.deepEqual(db.read('app_meta', 'goldaColdContacts'), { lastSentOn: TODAY, nudged: { b: TODAY }, updatedAt: NOW.getTime() });
  const turn = db.read(THREAD, 'main').history.at(-1);
  assert.deepEqual([turn.role, turn.proactive, turn.buttons], ['assistant', 'cold', ['לנסח הודעה', 'לא עכשיו']]);
  assert.deepEqual(job.notes, ['cold-contact nudge → the owner']);
  // Later the same day, whatever he answered: not again.
  await db.collection(THREAD).doc('main').set({ history: [...db.read(THREAD, 'main').history, { role: 'user', text: 'לא עכשיו', at: NOW.getTime() + H }] });
  assert.deepEqual(await net.coldNudge(db, owner, hourly(), later(3 * H), { hour: 14, send: s.send, job }), { skipped: 'one a day' });
  assert.equal(s.out.length, 1);
});

test('the same contact at most once in 30 days: each day the next one, then nobody, and after a month the first again', async () => {
  const db = store();
  const s = sender();
  const on = async (days) => net.coldNudge(db, owner, hourly(), later(days * DAY), { hour: 11, send: s.send });
  // He never answers; a day later an unanswered nudge no longer holds the next one.
  assert.deepEqual([await on(0), await on(1), await on(2), await on(3)].map((r) => r.contactId), ['b', 'c', 'h', 'a']);
  assert.deepEqual(await on(4), { skipped: 'nobody to mention' });
  assert.deepEqual(await on(29), { skipped: 'nobody to mention' }, '29 days after the first: still too early for him');
  assert.deepEqual(await on(30), { sent: 1, contactId: 'b' });
  assert.deepEqual(db.read('app_meta', 'goldaColdContacts').nudged, { c: addDays(TODAY, 1), h: addDays(TODAY, 2), a: addDays(TODAY, 3), b: addDays(TODAY, 30) });
  assert.deepEqual(await on(31), { sent: 1, contactId: 'c' });
  assert.equal(s.out.length, 6);
});

test('never at night, and never on top of a question of hers he has not answered', async () => {
  const db = store();
  const s = sender();
  for (const hour of [0, 5, 7, 22, 23]) assert.deepEqual(await net.coldNudge(db, owner, hourly(), NOW, { hour, send: s.send }), { skipped: 'quiet hours' });
  assert.deepEqual(await net.coldNudge(db, owner, hourly(), new Date('2026-11-25T21:30:00Z'), { send: s.send }), { skipped: 'quiet hours' }, '23:30 in Israel, read from the clock');
  // Her card with buttons went out forty minutes ago.
  await db.collection(THREAD).doc('main').set({ history: [{ role: 'assistant', text: 'כרטיס', buttons: ['כן', 'לא'], at: NOW.getTime() - 40 * 60000 }] });
  assert.deepEqual(await net.coldNudge(db, owner, hourly(), NOW, { send: s.send }), { skipped: 'waiting for an answer' });
  assert.equal(db.read('app_meta', 'goldaColdContacts'), undefined, 'nothing is counted for a nudge that did not go');
  assert.equal(s.out.length, 0);
  // He answered: now it may go (the hour read from the clock: 11:00).
  await db.collection(THREAD).doc('main').set({ history: [...db.read(THREAD, 'main').history, { role: 'user', text: 'כן', at: NOW.getTime() - 60000 }] });
  assert.deepEqual(await net.coldNudge(db, owner, hourly(), NOW, { send: s.send }), { sent: 1, contactId: 'b' });
});

test('the taps: "not now" is answered at once with no model; "draft a message" goes on to the conversation', async () => {
  assert.equal(taps._internal.handlers.get('cold'), net.onColdTap, 'registered when the module loads');
  const db = fakeDb({ wa_outbox: { 'wamid.n1': { to: OWNER.whatsapp, body: 'nudge', kind: 'cold', buttons: net.COLD_BUTTONS, ref: { type: 'cold', id: 'b' }, messageId: 'wamid.n1', state: 'sent' } } });
  const tap = (i) => ({ from: OWNER.whatsapp, type: 'interactive', text: net.COLD_BUTTONS[i], payload: `b${i}`, contextId: 'wamid.n1' });
  assert.deepEqual(await taps.handleTap(db, tap(1), {}), { handled: true, reply: 'בסדר, לא אזכיר את זה שוב בחודש הקרוב.' });
  assert.deepEqual(await taps.handleTap(db, tap(0), {}), { handled: false });
});

test('the conversation knows the nudge: only the owner\'s prompt has it, and it says draft only', () => {
  assert.match(net.networkSection('admin'), /לא דיברתם מזמן.*silent for 60 days.*draft-only outreach flow.*You never send it yourself/s);
  assert.ok(!/לא דיברתם מזמן/.test(net.networkSection('manager')));
  assert.ok(!/לא דיברתם מזמן/.test(net.networkSection('viewer')));
});
