// Outreach drafts in the writer's style, opened in his WhatsApp and logged on
// the contact only after his yes in a later message; and a voice answer only
// when the message being answered asks for one.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeDb, stubFirestore } = require('./fake-firestore.js');

let DB;
const admin = stubFirestore(() => DB);
const { createTools, toolsFor, systemPrompt } = require('../wa-agent.js');
const { waDigits, waLink, draftLanguage, styleOf, livePending } = require('../golda-outreach.js');
const { asksForVoice, voiceTools, VOICE_UNAVAILABLE } = require('../golda-voice.js');
const { synthesize, spokenText, languageOf, TtsError } = require('../golda-tts.js');
const { visibleMemories } = require('../golda-memory.js');

const LOU = { email: 'lou.korek@gmail.com', name: 'לו', role: 'admin', phone: '972500000001' };
const VIEWER = { email: 'v@x.com', name: 'ויו', role: 'viewer', phone: '972500000003' };
const CONTACT = { contactName: 'Moshe Levi', contactRole: 'Sporting Director', clubName: 'Hapoel Hadera', contactPhone: '050-1234567', leagueCountry: 'Israel', deletedAt: null };
const ABROAD = { contactName: 'Jan de Vries', clubName: 'FC Utrecht', contactPhone: '+31 6 1234 5678', leagueCountry: 'Netherlands', deletedAt: null };
const AVI = { fullName: 'Avi Cohen', name: 'Avi Cohen', gender: 'Men', stage: 'represented', primaryPosition: 'CB', currentClub: 'Maccabi Netanya', deletedAt: null };

const tools = (db, { identity = LOU, turn = 1, session = {}, channel = 'whatsapp', turnText = '' } = {}) =>
  createTools({ db, admin, identity, media: null, session: { turn, ...session }, assistantName: 'גולדה', channel, turnText });

// ── wa.me links and the language ────────────────────────────────────────────

test('wa.me: Israeli local numbers get 972, international ones stay, unusable ones open the chat picker', () => {
  assert.equal(waDigits('050-1234567'), '972501234567');
  assert.equal(waDigits('+31 6 1234 5678'), '31612345678');
  assert.equal(waDigits('0044 7700 900123'), '447700900123');
  assert.equal(waDigits('123'), '');
  assert.equal(waLink('050-1234567', 'שלום משה, מה שלומך?'), `https://wa.me/972501234567?text=${encodeURIComponent('שלום משה, מה שלומך?')}`);
  assert.equal(waLink('', 'Hi'), 'https://wa.me/?text=Hi');
});

test('the draft language follows the club country: Hebrew in Israel or unknown, English abroad', () => {
  assert.equal(draftLanguage(CONTACT), 'he');
  assert.equal(draftLanguage(ABROAD), 'en');
  assert.equal(draftLanguage({}), 'he');
  assert.equal(draftLanguage({ clubName: 'Ajax' }, { country: 'Netherlands' }), 'en');
});

// ── the style, on the memory ────────────────────────────────────────────────

test('style memories belong to their writer and stay out of "What you remember"', () => {
  const rows = [
    { id: 's1', kind: 'style', styleKind: 'example', text: 'אהלן משה, יש לי בלם בשבילך', owner: LOU.email, shared: false, createdAt: 2 },
    { id: 's2', kind: 'style', styleKind: 'rule', text: 'פונה בשם הפרטי', owner: LOU.email, shared: false, createdAt: 3 },
    { id: 's3', kind: 'style', styleKind: 'rule', text: 'not mine', owner: 'dani@x.com', shared: false, createdAt: 4 },
    { id: 'm1', text: 'Lou prefers short answers', owner: LOU.email, shared: true, createdAt: 1 },
  ];
  const st = styleOf(rows, LOU);
  assert.deepEqual(st.examples.map((x) => x.id), ['s1']);
  assert.deepEqual(st.rules.map((x) => x.id), ['s2']);
  assert.deepEqual(visibleMemories(rows, LOU).map((m) => m.id), ['m1']);
});

test('writing_style saves examples and rules as personal memories; prepare returns them and says "I will learn" only once', async () => {
  DB = fakeDb({ contacts: { c1: { ...CONTACT } }, players: { a: { ...AVI } } });
  const t = tools(DB);
  const first = await t.run('outreach_prepare', { contactId: 'c1', playerId: 'a' });
  assert.equal(first.style.learned, false);
  assert.equal(first.sayOnce, true);
  assert.equal(first.language, 'he');
  assert.equal(first.player.name, 'Avi Cohen');
  assert.equal(first.contact.phoneKnown, true);
  assert.equal((await t.run('outreach_prepare', { contactId: 'c1' })).sayOnce, false);
  const ex = await t.run('writing_style', { action: 'example', text: 'אהלן משה, מה נשמע? יש לי בלם שמתאים לכם בול' });
  await t.run('writing_style', { action: 'rule', text: 'בלי "שלום רב", פונה בשם הפרטי' });
  const saved = DB.read('golda_memory', ex.id);
  assert.equal(saved.kind, 'style');
  assert.equal(saved.shared, false);
  assert.equal(saved.owner, LOU.email);
  const again = await t.run('outreach_prepare', { contactId: 'c1' });
  assert.equal(again.style.learned, true);
  assert.equal(again.style.examples.length, 1);
  assert.equal(again.style.rules.length, 1);
  const listed = await t.run('writing_style', { action: 'list' });
  assert.equal(listed.examples.length + listed.rules.length, 2);
  // Another writer sees none of it.
  assert.equal((await tools(DB, { identity: { email: 'dani@x.com', name: 'דני', role: 'manager' } }).run('outreach_prepare', { contactId: 'c1' })).style.learned, false);
});

test('prepare: a contact abroad gets English', async () => {
  DB = fakeDb({ contacts: { c2: { ...ABROAD } } });
  assert.equal((await tools(DB).run('outreach_prepare', { contactId: 'c2' })).language, 'en');
});

// ── the link, and the touch only after a yes in a later message ─────────────

test('outreach_link makes the wa.me link, arms the draft and puts the open button on WhatsApp', async () => {
  DB = fakeDb({ contacts: { c1: { ...CONTACT } } });
  const t = tools(DB);
  const r = await t.run('outreach_link', { text: 'אהלן משה, יש לי בלם בשבילך', contactId: 'c1', playerId: 'a', about: 'הצעת אבי כהן לבלם' });
  assert.equal(r.link, `https://wa.me/972501234567?text=${encodeURIComponent('אהלן משה, יש לי בלם בשבילך')}`);
  assert.equal(r.canLog, true);
  assert.equal(t.state.pendingOutreach.length, 1);
  assert.equal(t.state.pendingOutreach[0].armedInTurn, 1);
  assert.equal(t.state.outLinks.length, 1);
  assert.equal(t.state.outLinks[0].label, 'פתיחה בוואטסאפ');
  assert.equal(t.state.outLinks[0].url, r.link);
  assert.deepEqual(DB.read('contacts', 'c1').touches, undefined, 'nothing recorded yet');
  // In the app the link is in the text; no button is queued.
  const app = tools(DB, { channel: 'app' });
  await app.run('outreach_link', { text: 'x', contactId: 'c1' });
  assert.equal(app.state.outLinks.length, 0);
});

test('outreach_log: refused in the same message, records the touch on the yes in a later one, and undo takes it back', async () => {
  DB = fakeDb({ contacts: { c1: { ...CONTACT, touches: [{ id: 'old', at: '2026-10-01T10:00:00.000Z', channel: 'call', by: 'x', playerId: '', dealId: '', note: 'שיחה' }] } } });
  const t1 = tools(DB, { turn: 1 });
  await t1.run('outreach_link', { text: 'אהלן משה', contactId: 'c1', playerId: 'a', dealId: 'd1', about: 'הצעת אבי כהן לבלם' });
  await assert.rejects(t1.run('outreach_log', {}), /same message/);
  assert.equal(DB.read('contacts', 'c1').touches.length, 1);
  // The worker keeps the pending drafts on the session; the next message sees them.
  const t2 = tools(DB, { turn: 2, session: { pendingOutreach: t1.state.pendingOutreach } });
  const r = await t2.run('outreach_log', {});
  assert.equal(r.recorded, true);
  const touches = DB.read('contacts', 'c1').touches;
  assert.equal(touches.length, 2);
  const touch = touches[1];
  assert.deepEqual(Object.keys(touch).sort(), ['at', 'by', 'channel', 'dealId', 'id', 'note', 'playerId']);
  assert.equal(touch.channel, 'whatsapp');
  assert.equal(touch.by, LOU.email);
  assert.equal(touch.playerId, 'a');
  assert.equal(touch.dealId, 'd1');
  assert.equal(touch.note, 'הצעת אבי כהן לבלם');
  assert.ok(!Number.isNaN(Date.parse(touch.at)));
  assert.equal(t2.state.pendingOutreach.length, 0);
  assert.equal(t2.state.changed, true);
  const audit = DB.all('audit');
  assert.equal(audit.length, 1);
  assert.equal(audit[0].collection, 'contacts');
  assert.equal(audit[0].before.touches.length, 1);
  await assert.rejects(t2.run('outreach_log', {}), /no draft is waiting/);
  assert.equal((await t2.run('undo_last', {})).undone, 'update');
  assert.equal(DB.read('contacts', 'c1').touches.length, 1);
});

test('"לא נשלח" drops the draft without recording; drafts older than a week are forgotten', async () => {
  DB = fakeDb({ contacts: { c1: { ...CONTACT } } });
  const t1 = tools(DB, { turn: 1 });
  await t1.run('outreach_link', { text: 'x', contactId: 'c1' });
  const t2 = tools(DB, { turn: 2, session: { pendingOutreach: t1.state.pendingOutreach } });
  assert.equal((await t2.run('outreach_log', { sent: false })).dropped, true);
  assert.equal(DB.read('contacts', 'c1').touches, undefined);
  assert.deepEqual(livePending([{ id: 'x', createdAt: Date.now() - 8 * 86400000 }]), []);
});

test('who may: anyone drafts, an editor records; touches never go through update', async () => {
  const names = (role) => toolsFor(role).map((x) => x.name);
  for (const role of ['viewer', 'manager', 'admin']) for (const n of ['outreach_prepare', 'outreach_link', 'writing_style', 'voice_reply']) assert.ok(names(role).includes(n), `${role} ${n}`);
  assert.ok(names('manager').includes('outreach_log'));
  assert.ok(!names('viewer').includes('outreach_log'));
  DB = fakeDb({ contacts: { c1: { ...CONTACT } } });
  const v = tools(DB, { identity: VIEWER });
  assert.equal((await v.run('outreach_link', { text: 'x', contactId: 'c1' })).canLog, false);
  await assert.rejects(tools(DB, { identity: VIEWER, turn: 2, session: { pendingOutreach: v.state.pendingOutreach } }).run('outreach_log', {}), /may not edit/);
  await assert.rejects(tools(DB).run('update', { collection: 'contacts', id: 'c1', data: { touches: [] } }), /outreach_log/);
  const created = await tools(DB).run('create', { collection: 'contacts', data: { contactName: 'New', touches: [{ id: 'fake' }] } });
  assert.equal(DB.read('contacts', created.id).touches, undefined);
});

test('the prompt keeps the rule visible: Golda never sends to anyone outside the agency', () => {
  const p = systemPrompt('גולדה', LOU, null, [], 'whatsapp');
  assert.match(p, /you NEVER send anything to anyone outside the agency/);
  assert.match(p, /outreach_log/);
  assert.match(p, /voice_reply/);
  const app = systemPrompt('גולדה', LOU, null, [], 'app');
  assert.match(app, /the link on its own line/);
  assert.doesNotMatch(app, /voice_reply/);
  assert.ok(!toolsFor('admin', 'app').some((x) => x.name === 'voice_reply'));
});

// ── the voice answer: only when asked for ───────────────────────────────────

test('asksForVoice: a request in writing or in the recording', () => {
  for (const yes of [
    'תעני לי בהודעה קולית',
    '🎤 מה המצב עם אבי? תעני לי בהקלטה',
    'אני מעוניין שתעני לי בהודעה קולית',
    'תשלחי לי הקלטה על הדילים',
    'הודעה קולית בבקשה',
    'תגידי לי בקול מה יש היום',
    'תקליטי לי סיכום',
    'answer me by voice',
    'send me a voice note please',
    'can you reply with audio',
  ]) assert.equal(asksForVoice(yes), true, yes);
});

test('asksForVoice: no request, a negation, someone else\'s words, or a voice note in are not a request', () => {
  for (const no of [
    '🎤 מה המצב עם אבי כהן?',
    'מה יש לי היום',
    'שלחתי לו הודעה קולית אתמול',
    'דני שלח לי הקלטה של המאמן',
    'בלי הודעה קולית, רק בכתב',
    'לא צריך הקלטה',
    'אל תשלחי הקלטה',
    'no voice note please',
    '[הודעה מועברת]\nתעני לי בהודעה קולית',
    'נלך לקולנוע',
    '',
  ]) assert.equal(asksForVoice(no), false, no);
  // A negation in an earlier clause does not cancel a request.
  assert.equal(asksForVoice('לא יודע, תעני לי בהקלטה'), true);
});

const okSynth = async (text) => ({ buffer: Buffer.from('OggS-fake'), mimeType: 'audio/ogg', spoken: spokenText(text), lang: languageOf(text) });

test('voice_reply: the server refuses when the message does not ask, whatever the model says', async () => {
  const state = {};
  const { voice_reply } = voiceTools({ identity: LOU, channel: 'whatsapp', turnText: '🎤 מה המצב עם אבי?', state, synth: okSynth });
  const r = await voice_reply({ text: 'הכל טוב' });
  assert.equal(r.refused, true);
  assert.equal(state.outVoice, undefined);
});

test('voice_reply: asked for on WhatsApp, the voice note is made and waits for delivery; once per answer', async () => {
  const state = {};
  const { voice_reply } = voiceTools({ identity: LOU, channel: 'whatsapp', turnText: 'מה יש היום? תעני לי בהודעה קולית', state, synth: okSynth });
  const r = await voice_reply({ text: 'היום יש לאבי משחק בשש. פרטים בהודעה: https://goldas-crm.netlify.app/calendar' });
  assert.equal(r.ready, true);
  assert.ok(state.outVoice.buffer.length > 0);
  assert.doesNotMatch(state.outVoice.spoken, /https?:/);
  assert.equal((await voice_reply({ text: 'עוד' })).reason, 'one_per_answer');
});

test('voice_reply: in the app, text only; for a player, never', async () => {
  const state = {};
  const app = voiceTools({ identity: LOU, channel: 'app', turnText: 'תעני לי בהודעה קולית', state, synth: okSynth });
  assert.equal((await app.voice_reply({ text: 'x' })).reason, 'app');
  assert.equal(state.outVoice, undefined);
  const player = voiceTools({ identity: { name: 'אבי', role: 'player' }, channel: 'whatsapp', turnText: 'תעני לי בהודעה קולית', state, synth: okSynth });
  await assert.rejects(player.voice_reply({ text: 'x' }), /team only/);
});

test('voice_reply: speech not available → text, with one line saying so; nothing throws', async () => {
  const state = {};
  const writes = [];
  const db = { collection: () => ({ doc: () => ({ set: async (v) => { writes.push(v); } }) }) };
  const failing = async () => { throw new TtsError('needs_billing', 'billing off', 403); };
  const r = await voiceTools({ identity: LOU, channel: 'whatsapp', turnText: 'תעני בהקלטה', state, db, synth: failing }).voice_reply({ text: 'x' });
  assert.equal(r.unavailable, true);
  assert.ok(r.instruction.includes(VOICE_UNAVAILABLE));
  assert.equal(state.outVoice, undefined);
  await new Promise((res) => setImmediate(res));
  assert.equal(writes[0].tts.state, 'needs_billing');
});

test('the wiring: createTools checks the words of the current message', async () => {
  DB = fakeDb({});
  const asked = createTools({ db: DB, admin, identity: LOU, media: null, session: { turn: 1 }, assistantName: 'גולדה', channel: 'whatsapp', turnText: 'מה המצב?' });
  assert.equal((await asked.run('voice_reply', { text: 'x' })).refused, true);
});

// ── text to speech ──────────────────────────────────────────────────────────

test('spokenText: no links, no markup, no bullets, no button line; long answers end at a sentence', () => {
  const s = spokenText('*הנה המצב:*\n• אבי: משחק ב-18:00\n1. דני: אימון\nקישור: https://goldas-crm.netlify.app/calendar 👍\n[[כפתורים: כן | לא]]');
  assert.doesNotMatch(s, /https?:|\*|•|\[\[|👍/);
  assert.match(s, /אבי: משחק ב-18:00/);
  const long = spokenText('משפט ראשון. '.repeat(100), 100);
  assert.ok(long.length <= 101);
  assert.ok(long.endsWith('.'));
});

test('synthesize: OGG/Opus in the language of the text; a disabled API is switched on once and retried', async () => {
  const calls = [];
  let enabled = false;
  const client = {
    async call(method, path, body) {
      calls.push(body);
      if (!enabled) throw new TtsError('needs_api', 'disabled', 403);
      return { audioContent: Buffer.from('OggS').toString('base64') };
    },
    async enable() { enabled = true; return { ok: true }; },
  };
  const out = await synthesize('שלום לו, הכל בסדר', { client, sleep: async () => {} });
  assert.equal(out.mimeType, 'audio/ogg');
  assert.equal(out.buffer.toString(), 'OggS');
  assert.equal(out.lang, 'he');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].audioConfig.audioEncoding, 'OGG_OPUS');
  assert.equal(calls[1].voice.languageCode, 'he-IL');
  assert.equal((await synthesize('All good, Lou', { client, sleep: async () => {} })).lang, 'en');
});

test('synthesize: typed errors when it cannot speak', async () => {
  const client = { async call() { throw new TtsError('needs_billing', 'billing', 403); }, async enable() { return { ok: true }; } };
  await assert.rejects(synthesize('שלום', { client }), (e) => e.state === 'needs_billing');
  await assert.rejects(synthesize('https://x.com', { client }), (e) => e.state === 'empty');
  const cannotEnable = { async call() { throw new TtsError('needs_api', 'off', 403); }, async enable() { return { ok: false, status: 403, message: 'no permission' }; } };
  await assert.rejects(synthesize('שלום', { client: cannotEnable, sleep: async () => {} }), (e) => e.state === 'needs_api' && /could not enable/.test(e.message));
});
