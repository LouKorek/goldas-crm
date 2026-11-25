// The radar card and the cold-contact nudge where they really run: inside the
// hourly pass (golda-briefing.js), after everything else Golda starts with the
// owner, and in the worker, where a tap on a card is answered before the model.
// WhatsApp and the model are recorded, Firestore is in memory, no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
delete process.env.SCRAPER_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
const { fakeDb, stubFirestore, OWNER, MANAGER } = require('./fake-firestore.js');
const { fakeSite } = require('./fake-site.js');

let DB = null;
const admin = stubFirestore(() => DB);
admin.firestore.FieldValue.increment = (n) => n;
admin.firestore.Timestamp = { fromMillis: (ms) => ms, now: () => Date.now() };

// WhatsApp, recorded instead of sent; everything else in the module stays real.
const sent = [];
const waPath = require.resolve('../wa-api.js');
const realWa = require('../wa-api.js');
let nextId = 0;
require.cache[waPath].exports = {
  ...realWa,
  markRead: async () => {},
  sendText: async (to, body) => { sent.push({ to, body }); return [`wamid.out${++nextId}`]; },
  sendButtons: async (to, body, buttons) => { sent.push({ to, body, buttons }); return [`wamid.out${++nextId}`]; },
};
// The conversation's model, recorded instead of called.
const asked = [];
const agent = require('../wa-agent.js');
agent.runAgent = async ({ text }) => { asked.push(text); return { reply: 'תשובה מהמודל', pendingDeletes: [], changed: false, userText: text, usage: null, files: [] }; };
const { processMessage } = require('../golda-worker.js');
const { run } = require(path.join(__dirname, '..', '..', 'golda-briefing.js'))._internal;
const radar = require('../golda-radar.js');
const net = require('../golda-network.js');

const H = 3600000;
const TODAY = '2026-11-25';
const at = (israelHHMM) => new Date(`${TODAY}T${String(Number(israelHHMM.slice(0, 2)) - 2).padStart(2, '0')}:${israelHHMM.slice(3)}:00Z`);   // Israel is UTC+2 in November
const THREAD = `wa_sessions/${OWNER.whatsapp}/threads`;
const approved = { templates: { golda_digest: { accounts: { 1: { status: 'APPROVED' } } }, golda_update: { accounts: { 1: { status: 'APPROVED' } } } } };
const GAVIN = { fullName: 'Gavin Karam', gender: 'Men', stage: 'represented', currentClub: 'Hapoel Kfar Saba', contractStatus: 'Under Contract', contractEnd: '2028-06-30', reprEnd: '2028-06-30', passportExpiry: '2031-01-01',
  primaryPosition: 'CDM', secondaryPositions: ['CM'], dob: '2007-05-01', foot: 'Right', nationalities: ['Israel'] };
const FINDING = { key: 'f1', kind: 'coach', subject: 'club:real betis', title: 'בטיס החליפה מאמן', why: 'כדאי לחדש את השיחה', sources: ['https://www.one.co.il/betis'], playerIds: [], playerNames: [], clubNames: ['Real Betis'], league: 'La Liga',
  date: '2026-11-24', score: 7, state: 'new', snoozeUntil: null, foundAt: at('07:10').getTime() };
// A contact at the club of an open deal, last spoken with a hundred days ago.
const COLD = {
  contacts: { c1: { contactName: 'Benny Levi', clubName: 'Real Betis', touches: [{ id: 't1', at: '2026-08-17T09:00:00Z', channel: 'call' }] } },
  deals: { d1: { playerId: 'p1', playerName: 'Gavin Karam', clubName: 'Real Betis', stage: 'Negotiation', enteredStageAt: '2026-11-20', nextActionDate: '2026-12-20' } },
};

function seed({ users = { lou: OWNER, dani: MANAGER }, briefed = TODAY, findings = { f1: FINDING }, extra = {} } = {}) {
  return fakeDb({
    app_users: users, players: { p1: GAVIN },
    backups: { b1: { status: 'ok', verified: true, startedAt: at('03:30').getTime() } },   // a good backup from last night: no operations alert about it
    app_meta: { whatsapp: approved, goldaSent: { briefings: { 'lou.korek@gmail.com': briefed, 'dani@x.com': briefed }, eventsAt: at('08:30').getTime() } },
    golda_radar: findings, ...extra,
  });
}
const write = Object.assign(async ({ fallbackText }) => ({ text: fallbackText, ai: false, reason: 'test' }), { recap: async ({ fallbackText }) => ({ text: fallbackText, ai: false, reason: 'test' }) });
async function hour(when) {
  const out = [], notes = [];
  const send = async (u, body, kind, buttons = [], ref = null) => { out.push({ to: u.email, kind, body, buttons, ref }); return { state: 'sent' }; };
  const r = await run({ note: (s) => notes.push(s) }, at(when), { send, write, site: fakeSite() });
  return { out, notes, r, hers: out.filter((m) => m.kind === 'radar' || m.kind === 'cold') };
}
const ownerWrites = async (when) => { const t = DB.read(THREAD, 'main'); await DB.collection(THREAD).doc('main').set({ ...t, history: [...t.history, { role: 'user', text: 'ראיתי, תודה', at: at(when).getTime() }] }); };

// ── the hourly pass ───────────────────────────────────────────────────────────

test('the hourly pass sends one radar card to the owner, in an hour when nothing else of hers goes out', async () => {
  DB = seed();
  const first = await hour('09:30');
  assert.deepEqual(first.hers.map((m) => [m.to, m.kind, m.buttons, m.ref]), [['lou.korek@gmail.com', 'radar', radar.BUTTONS, { type: 'radar', id: 'f1' }]]);
  assert.match(first.hers[0].body, /^\*רדאר שוק\* 📡 👔 חילופי מאמן\n\*בטיס החליפה מאמן\*\n[^]*\nמקור:\nhttps:\/\/www\.one\.co\.il\/betis$/);
  assert.ok(!first.out.some((m) => m.to === 'dani@x.com' && (m.kind === 'radar' || m.kind === 'cold')), 'a manager gets none of it');
  assert.ok(first.r.sent >= 1);
  assert.ok(first.notes.includes('radar card → the owner (1 of 3 today)'));
  assert.ok(!first.notes.some((n) => /failed/.test(n)), first.notes.join(' | '));
  assert.equal(DB.read('golda_radar', 'f1').state, 'sent');
  // Nothing more to offer an hour later, and nothing on top of a card he has not answered.
  assert.deepEqual((await hour('10:30')).hers, []);
});

test('with no card to send, the same slot carries one cold-contact nudge; a card comes first when there is one', async () => {
  DB = seed({ extra: COLD });
  // A card is waiting: it goes first, and the nudge does not ride with it.
  assert.deepEqual((await hour('09:30')).hers.map((m) => m.kind), ['radar']);
  await ownerWrites('09:40');
  const next = await hour('10:30');
  assert.deepEqual(next.hers.map((m) => [m.to, m.kind, m.buttons, m.ref]), [['lou.korek@gmail.com', 'cold', net.COLD_BUTTONS, { type: 'cold', id: 'c1' }]]);
  assert.match(next.hers[0].body, /^\*לא דיברתם מזמן\* 📇\nלו, עם \*Benny Levi\* \(Real Betis\) לא דיברתם כבר 100 ימים\. הפעם האחרונה: 17\.08\.2026, שיחה\.\nעסקה פתוחה: Gavin Karam ↔ Real Betis \(משא ומתן\)\.\nלנסח הודעה\? אתה שולח אותה בעצמך\.$/);
  assert.ok(next.notes.includes('cold-contact nudge → the owner'));
  assert.ok(!next.notes.some((n) => /Benny|Betis/.test(n) && /cold|radar/.test(n)), 'her notes name nobody');
  await ownerWrites('10:40');
  assert.deepEqual((await hour('11:30')).hers, [], 'one nudge a day');
});

test('at night, before his briefing, or with the owner off WhatsApp, neither goes out', async () => {
  DB = seed({ extra: COLD });
  assert.deepEqual((await hour('23:30')).hers, []);
  assert.deepEqual((await hour('07:30')).hers, []);
  DB = seed({ extra: COLD, briefed: '2026-11-24' });
  assert.deepEqual((await hour('09:30')).hers, [], 'today\'s briefing has not gone out yet');
  DB = seed({ extra: COLD, users: { lou: { ...OWNER, channels: [] }, dani: { ...MANAGER, role: 'admin' } } });
  assert.deepEqual((await hour('09:30')).hers, [], 'nobody else gets the owner\'s cards');
  assert.equal(DB.read('golda_radar', 'f1').state, 'new');
  assert.equal(DB.read('app_meta', 'goldaColdContacts'), undefined);
});

test('a failure of either is noted by its kind and costs the hour nothing else', async () => {
  DB = seed({ extra: COLD });
  const real = radar.offerRadar;
  radar.offerRadar = async () => { throw Object.assign(new Error('could not read the card about Benny Levi'), { code: 'unavailable' }); };
  try {
    const h = await hour('09:30');
    assert.ok(h.notes.includes('radar card failed (unavailable)'));
    assert.ok(!h.notes.some((n) => /Benny Levi/.test(n) && /failed/.test(n)), 'the error text is not copied into the notes');
    assert.deepEqual(h.hers.map((m) => m.kind), ['cold'], 'the nudge still goes');
    assert.ok(DB.read('app_meta', 'goldaSent').eventsAt, 'the hour\'s state is saved as always');
  } finally { radar.offerRadar = real; }
});

// ── the worker ────────────────────────────────────────────────────────────────

const cardRow = (ref, buttons) => ({ to: OWNER.whatsapp, body: 'card', kind: ref.type, buttons, ref, messageId: 'wamid.card1', state: 'sent' });
const world = (text, payload, { ref = { type: 'radar', id: 'f1' }, buttons = radar.BUTTONS } = {}) => fakeDb({
  app_users: { lou: OWNER }, golda_radar: { f1: { ...FINDING, state: 'sent' } },
  wa_outbox: { 'wamid.card1': cardRow(ref, buttons) },
  wa_inbox: { m1: { from: OWNER.whatsapp, type: 'interactive', channel: 'whatsapp', state: 'queued', attempts: 0, text, payload, contextId: 'wamid.card1' } },
});
const reset = () => { sent.length = 0; asked.length = 0; };

test('the worker answers "not relevant" and "remind me in a week" itself, in Hebrew, and never calls the model', async () => {
  reset();
  DB = world('לא רלוונטי', 'b1');
  await processMessage('m1');
  assert.deepEqual(asked, [], 'no model call');
  assert.deepEqual(sent.map((s) => [s.to, s.body]), [[OWNER.whatsapp, 'הבנתי, לא רלוונטי. אביא פחות דברים כאלה.']]);
  assert.equal(DB.read('golda_radar', 'f1').state, 'dismissed');
  assert.deepEqual(DB.read('app_meta', 'goldaRadar').prefs.kinds, { coach: { dismissed: 1 } });
  assert.deepEqual([DB.read('wa_inbox', 'm1').state, DB.read('wa_inbox', 'm1').tapped], ['done', true]);

  reset();
  DB = world('תזכירי בעוד שבוע', 'b2');
  const before = Date.now();
  await processMessage('m1');
  assert.deepEqual(asked, []);
  assert.deepEqual(sent.map((s) => s.body), ['אין בעיה, אחזיר את זה בעוד שבוע.']);
  const f = DB.read('golda_radar', 'f1');
  assert.equal(f.state, 'snoozed');
  assert.ok(f.snoozeUntil >= before + 7 * 24 * H && f.snoozeUntil <= Date.now() + 7 * 24 * H);
});

test('"prepare a pitch" reaches the conversation, with the finding already marked as the one he means', async () => {
  reset();
  DB = world('להכין פנייה', 'b0');
  await processMessage('m1');
  assert.deepEqual(asked, ['להכין פנייה'], 'the model gets the button\'s words');
  assert.equal(sent[0].body, 'תשובה מהמודל');
  assert.equal(DB.read('golda_radar', 'f1').state, 'pitch');
  assert.equal(DB.read('app_meta', 'goldaRadar').pitchId, 'f1');
  assert.ok(!DB.read('wa_inbox', 'm1').tapped);
  // Nothing was sent to anyone but the person who tapped.
  assert.ok(sent.every((s) => s.to === OWNER.whatsapp));
});

test('the cold nudge\'s buttons: "not now" with no model, "draft a message" through the conversation', async () => {
  reset();
  DB = world('לא עכשיו', 'b1', { ref: { type: 'cold', id: 'c1' }, buttons: net.COLD_BUTTONS });
  await processMessage('m1');
  assert.deepEqual([asked, sent.map((s) => s.body)], [[], ['בסדר, לא אזכיר את זה שוב בחודש הקרוב.']]);
  reset();
  DB = world('לנסח הודעה', 'b0', { ref: { type: 'cold', id: 'c1' }, buttons: net.COLD_BUTTONS });
  await processMessage('m1');
  assert.deepEqual([asked, sent.map((s) => s.body)], [['לנסח הודעה'], ['תשובה מהמודל']]);
  reset();
});
