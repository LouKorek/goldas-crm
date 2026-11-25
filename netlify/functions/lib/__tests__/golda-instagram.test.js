// Golda's Instagram graphics: the tool (who may, what it needs, where the
// photo comes from, what goes into the answer), the owner's offers (birthday
// today, a goal yesterday; once each, a few a day, in the day's hours) and
// the agent's wiring.
const test = require('node:test');
const assert = require('node:assert/strict');
const jpeg = require('jpeg-js');
const { fakeDb, stubFirestore, recorder, OWNER } = require('./fake-firestore.js');
stubFirestore();

const { instagramTools, offerGraphics, readStoredFile, recentGoal, FROM_HOUR, TO_HOUR, OFFERS_PER_DAY } = require('../golda-instagram.js');
const { graphicEvents, buildGraphicOffer } = require('../golda-proactive.js');
const { whatsappRecipients } = require('../golda-identity.js');
const { ownerOf } = require('../golda-nudge.js');
const { toolsFor, systemPrompt } = require('../wa-agent.js');

const TODAY = '2026-11-25';
const NOW = new Date('2026-11-25T12:30:00Z');   // 14:30 in Israel
const owner = ownerOf(whatsappRecipients([OWNER]));

// A small JPEG drawn here, stored the way the CRM stores a player's photo (files/{id} + chunks).
const shot = jpeg.encode({ data: Buffer.alloc(600 * 800 * 4, 120), width: 600, height: 800 }, 70).data;
const dataUrl = `data:image/jpeg;base64,${shot.toString('base64')}`;
const half = Math.ceil(dataUrl.length / 2);

const NOAM = { fullName: 'נועם ברזילי', stage: 'represented', gender: 'Men', currentClub: 'מכבי נתניה', dob: '2002-11-25' };
const seed = (extra = {}) => ({
  players: {
    p1: { ...NOAM, photoFiles: [{ fileId: 'ph1', name: 'noam.jpg', type: 'image/jpeg' }] },
    p2: { fullName: 'Dana Cohen', stage: 'represented', gender: 'Women', currentClub: '' },
    p3: { fullName: 'Old Player', stage: 'represented', deletedAt: 'x' },
  },
  files: { ph1: { name: 'noam.jpg', parts: 2, size: shot.length } },
  'files/ph1/chunks': { 0: { data: dataUrl.slice(0, half) }, 1: { data: dataUrl.slice(half) } },
  ...extra,
});

// A quick stand-in for the drawing, so the tool's own logic is what is tested.
function fakeRender() {
  const calls = [];
  const render = async ({ facts, size, photo }) => {
    calls.push({ facts, size, photo });
    return { bytes: Buffer.from('JPEG'), width: 1080, height: size === 'story' ? 1920 : 1350, photoUsed: !!photo, texts: { kicker: 'K', name: facts.name, details: [{ text: facts.club || facts.opponent || '' }] } };
  };
  return { calls, render };
}
const tool = (db, { role = 'manager', media = null, render } = {}) => {
  const state = { outFiles: [] };
  const t = instagramTools({ db, identity: { name: 'דני' }, role, media, state, now: () => NOW, render: render === 'real' ? undefined : render || fakeRender().render });
  return { make: t.instagram_graphic, state };
};

test('only someone who may edit players can make one', async () => {
  const { make, state } = tool(fakeDb(seed()), { role: 'viewer' });
  await assert.rejects(make({ playerId: 'p1', kind: 'signing' }), /edit permission/);
  assert.equal(state.outFiles.length, 0);
  assert.ok(toolsFor('manager').some((x) => x.name === 'instagram_graphic'));
  assert.ok(toolsFor('admin').some((x) => x.name === 'instagram_graphic'));
  assert.ok(!toolsFor('viewer').some((x) => x.name === 'instagram_graphic'));
});

test('a signing with his photo from the CRM: the picture and its caption go into the answer, never into the history', async () => {
  const r0 = fakeRender();
  const { make, state } = tool(fakeDb(seed()), { render: r0.render });
  const r = await make({ playerId: 'p1', kind: 'signing' });
  assert.equal(r.made, true);
  assert.equal(r.size, 'post 1080x1350');
  assert.equal(r.facts.club, 'מכבי נתניה');
  assert.equal(r.facts.from.club, 'his current club in the CRM');
  assert.match(r.photo, /noam\.jpg/);
  assert.ok(r0.calls[0].photo.equals(shot), 'the photo is read back whole from its chunks');
  assert.equal(state.outFiles.length, 1);
  const f = state.outFiles[0];
  assert.deepEqual([f.filename, f.mimeType, f.graphic], ['נועם ברזילי - signing - post.jpg', 'image/jpeg', true]);
  assert.equal(f.caption, r.caption);
  assert.match(f.caption, /^ברכות לנועם ברזילי על החתימה במכבי נתניה!/);
  assert.match(r.note, /גם סטורי \| לשנות טקסט/);
  assert.ok(!JSON.stringify(r).includes(shot.toString('base64').slice(0, 40)), 'no picture in what the model reads');
});

test('what is missing is asked, not made up', async () => {
  const db = fakeDb(seed());
  const { make } = tool(db);
  await assert.rejects(make({ playerId: 'p2', kind: 'signing' }), /which club/);
  await assert.rejects(make({ playerId: 'p1', kind: 'goal' }), /against whom/);
  await assert.rejects(make({ playerId: 'p1', kind: 'custom' }), /headline/);
  await assert.rejects(make({ playerId: 'p3', kind: 'signing', club: 'X' }), /not found/);
  await assert.rejects(make({ playerId: 'p1', kind: 'poster' }), /kind must be/);
  // Dana's club comes from the writer, a female player's goal word follows
  const r = await make({ playerId: 'p2', kind: 'signing', club: 'הפועל באר שבע' });
  assert.equal(r.facts.from.club, 'the writer');
  assert.equal(r.facts.female, true);
  assert.match(r.photo, /no photo in the CRM/);
});

test('a goal from the CRM match data: the opponent is the other team', async () => {
  const db = fakeDb(seed({ matches: {
    m1: { date: '2026-11-24', homeTeam: 'מכבי נתניה', awayTeam: 'הפועל תל אביב', linkedPlayers: ['p1'], playerStats: { p1: { goals: 2 } } },
    m0: { date: '2026-11-10', homeTeam: 'A', awayTeam: 'B', linkedPlayers: ['p1'], playerStats: { p1: { goals: 1 } } },
  } }));
  const g = await recentGoal(db, { id: 'p1', ...NOAM }, TODAY);
  assert.deepEqual([g.match.id, g.goals, g.opponent], ['m1', 2, 'הפועל תל אביב']);
  const { make, state } = tool(db);
  const r = await make({ playerId: 'p1', kind: 'goal', size: 'story' });
  assert.deepEqual([r.facts.opponent, r.facts.goals, r.size], ['הפועל תל אביב', 2, 'story 1080x1920']);
  assert.match(r.facts.from.match, /2026-11-24/);
  assert.equal(r.facts.score, '', 'no score that nobody said');
  assert.match(r.note, /גם פוסט/);
  assert.equal(state.outFiles[0].filename, 'נועם ברזילי - goal - story.jpg');
});

test('a photo sent with the message comes first; "none" gives the card of words; at most two per answer', async () => {
  const r0 = fakeRender();
  const media = { mimeType: 'image/jpeg', buffer: Buffer.from('sent-photo') };
  const { make } = tool(fakeDb(seed()), { media, render: r0.render });
  const a = await make({ playerId: 'p1', kind: 'birthday' });
  assert.equal(a.photo, 'the photo sent with this message');
  assert.equal(String(r0.calls[0].photo), 'sent-photo');
  assert.equal(a.facts.age, 24);
  const b = await make({ playerId: 'p1', kind: 'birthday', photo: 'none', size: 'story' });
  assert.match(b.photo, /^none/);
  assert.equal(r0.calls[1].photo, null);
  await assert.rejects(make({ playerId: 'p1', kind: 'birthday' }), /at most two/);
  const { make: make2 } = tool(fakeDb(seed()));
  await assert.rejects(make2({ playerId: 'p1', kind: 'birthday', photo: 'attached' }), /no photo came/);
});

test('the writer\'s own caption replaces the written one', async () => {
  const { make, state } = tool(fakeDb(seed()));
  await make({ playerId: 'p1', kind: 'custom', headline: 'זימון ראשון לנבחרת', caption: 'גאים בך נועם!\r\n#GoldAS' });
  assert.equal(state.outFiles[0].caption, 'גאים בך נועם!\n#GoldAS');
});

test('the real picture, end to end: a JPEG of the right size from the stored photo', async () => {
  const { make, state } = tool(fakeDb(seed()), { render: 'real' });
  const r = await make({ playerId: 'p1', kind: 'signing', lang: 'en', name: 'Noam Barzilai' });
  const img = jpeg.decode(state.outFiles[0].buffer, { useTArray: true });
  assert.deepEqual([img.width, img.height], [1080, 1350]);
  assert.ok(state.outFiles[0].buffer.length < 5 * 1024 * 1024);
  assert.ok(r.onThePicture.includes('Noam Barzilai'));
  assert.match(r.caption, /^Congratulations to Noam Barzilai on signing with מכבי נתניה!/);
});

test('a stored file that is missing or broken reads as nothing', async () => {
  const db = fakeDb(seed({ files: { bad: { parts: 2 } }, 'files/bad/chunks': { 0: { data: 'data:image/jpeg;base64,AA' } } }));
  assert.equal(await readStoredFile(db, { fileId: 'bad' }), null);
  assert.equal(await readStoredFile(db, { fileId: 'nope' }), null);
  assert.equal((await readStoredFile(db, { url: dataUrl })).type, 'image/jpeg');
});

// ── offers ──────────────────────────────────────────────────────────────────
const PLAYERS = [
  { id: 'p1', ...NOAM },                                                     // birthday today
  { id: 'p2', fullName: 'Dana Cohen', stage: 'represented', gender: 'Women', dob: '2003-05-01' },
  { id: 'p4', fullName: 'Prospect', stage: 'prospect', dob: '2002-11-25' },  // not represented
];
const MATCHES = [
  { id: 'm1', date: '2026-11-24', homeTeam: 'Maccabi', awayTeam: 'Hapoel', playerStats: { p2: { goals: 1 }, p4: { goals: 3 } } },
  { id: 'm2', date: '2026-11-23', homeTeam: 'X', awayTeam: 'Y', playerStats: { p1: { goals: 1 } } },          // the day before yesterday
  { id: 'm3', date: '2026-11-24', homeTeam: 'Z', awayTeam: 'W', playerStats: { p1: { goals: 0 } } },
];

test('the events: a represented player\'s birthday today and his goals yesterday, each once', () => {
  const ev = graphicEvents({ players: PLAYERS, matches: MATCHES, offered: {}, today: TODAY });
  assert.deepEqual(ev.map((e) => e.key), ['birthday|p1|2026', 'goal|m1|p2']);
  assert.equal(ev[0].age, 24);
  assert.deepEqual(graphicEvents({ players: PLAYERS, matches: MATCHES, offered: { 'birthday|p1|2026': TODAY }, today: TODAY }).map((e) => e.key), ['goal|m1|p2']);
  const msg = buildGraphicOffer('לו', ev[1]);
  assert.deepEqual(msg.buttons, ['כן, להכין', 'לא הפעם']);
  assert.match(msg.text, /^\*גרפיקה לאינסטגרם, לו\?\* 🎨\n\*Dana Cohen\* כבשה גול אתמול בMaccabi – Hapoel\.\nלהכין לה גרפיקה/);
  assert.match(msg.text, /ההעלאה אצלך/);
});

const jobOf = () => { const notes = []; return { notes, note: (s) => notes.push(s) }; };
const offer = (db, send, { now = NOW, hour = 14, players = PLAYERS, matches = MATCHES } = {}) => offerGraphics(db, owner, { players, matches }, now, { hour, send, job: jobOf() });
const answer = (db) => { const t = db.all('wa_sessions/972500000001/threads')[0]; t.history.push({ role: 'user', text: 'לא הפעם', at: NOW.getTime() }); return db.collection('wa_sessions/972500000001/threads').doc('main').set(t); };

test('offers: in the day\'s hours, one an hour, never twice, buttons and no picture', async () => {
  assert.deepEqual([FROM_HOUR, TO_HOUR, OFFERS_PER_DAY], [10, 20, 3]);
  const db = fakeDb();
  const { out, send } = recorder();
  for (const hour of [7, 9, 21]) assert.deepEqual(await offer(db, send, { hour }), { skipped: 'not the hour' });
  assert.deepEqual(await offer(db, send), { sent: 1, key: 'birthday|p1|2026' });
  assert.deepEqual([out[0].to, out[0].kind, out[0].buttons], ['lou.korek@gmail.com', 'question', ['כן, להכין', 'לא הפעם']]);
  assert.match(out[0].body, /יום ההולדת ה-24 של \*נועם ברזילי\*/);
  // the offer is in the chat as her turn, so "כן, להכין" has something to answer; no file in it
  const h = db.all('wa_sessions/972500000001/threads')[0].history;
  assert.equal(h[h.length - 1].proactive, 'question');
  assert.equal(h[h.length - 1].files, undefined);
  // an hour later he has not answered: wait
  assert.deepEqual(await offer(db, send, { now: new Date(NOW.getTime() + 3600000), hour: 15 }), { skipped: 'waiting for an answer' });
  await answer(db);
  assert.deepEqual(await offer(db, send, { now: new Date(NOW.getTime() + 3600000), hour: 15 }), { sent: 1, key: 'goal|m1|p2' });
  await answer(db);
  assert.deepEqual(await offer(db, send, { now: new Date(NOW.getTime() + 2 * 3600000), hour: 16 }), { skipped: 'nothing to offer' });
  assert.equal(out.length, 2);
  const state = db.read('app_meta', 'goldaGraphicOffers');
  assert.deepEqual([state.day, state.sentToday, Object.keys(state.offered).sort()], [TODAY, 2, ['birthday|p1|2026', 'goal|m1|p2']]);
});

test('at most three a day; the next day counts again', async () => {
  const many = Array.from({ length: 5 }, (_, i) => ({ id: `b${i}`, fullName: `Player ${i}`, stage: 'represented', dob: '2000-11-25' }));
  const db = fakeDb();
  const { out, send } = recorder();
  for (let i = 0; i < OFFERS_PER_DAY; i++) {
    assert.equal((await offer(db, send, { players: many, matches: [], hour: 10 + i })).sent, 1);
    await answer(db);
  }
  assert.deepEqual(await offer(db, send, { players: many, matches: [], hour: 15 }), { skipped: 'enough for today' });
  assert.equal(out.length, 3);
  // tomorrow nobody has a birthday any more: the leftovers are not offered late
  const tomorrow = new Date(NOW.getTime() + 24 * 3600000);
  assert.deepEqual(await offer(db, send, { players: many, matches: [], now: tomorrow }), { skipped: 'nothing to offer' });
});

test('an offer that could not go out is not counted', async () => {
  const db = fakeDb();
  await assert.rejects(offer(db, async () => { throw new Error('WhatsApp API 500'); }), /WhatsApp API 500/);
  assert.equal(db.read('app_meta', 'goldaGraphicOffers'), undefined);
});

test('the prompt tells her what a yes to the offer means, and that she never posts', () => {
  const p = systemPrompt({ name: 'לו', role: 'admin', email: OWNER.email });
  const text = Array.isArray(p) ? p.map((x) => x.text || '').join('\n') : String(p);
  assert.match(text, /instagram_graphic/);
  assert.match(text, /גרפיקה לאינסטגרם/);
});
