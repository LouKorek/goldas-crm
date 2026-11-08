// Golda in the field (phase A): voice notes, buttons and the menu, forwarded
// messages, schedule photos, "tell me about X" and the week's opportunities.
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.FIREBASE_SERVICE_ACCOUNT_KEY = '{}';
process.env.OWNER_EMAIL = 'lou.korek@gmail.com';

const speech = require('../golda-speech.js');
const wa = require('../wa-api.js');
const { parseButtons, isMenuCommand, inboundText, MENU_ROWS } = require('../golda-worker.js');
const { opportunitiesOf, playerBriefOf, clubBriefOf, checkScheduleOf } = require('../golda-briefs.js');
const { findPlayers } = require('../gcal-sync.js');
const { briefingFacts } = require('../golda-briefing-ai.js');
const { systemPrompt, toolsFor } = require('../wa-agent.js');

const NOW = new Date('2026-11-08T10:00:00Z');   // a Sunday

// --- voice notes -------------------------------------------------------------
function oggOpus({ channels = 1, rate = 16000 } = {}) {
  const head = Buffer.alloc(19);
  head.write('OpusHead', 0, 'latin1');
  head[8] = 1; head[9] = channels; head.writeUInt32LE(rate, 12);
  return Buffer.concat([Buffer.from('OggS', 'latin1'), Buffer.alloc(24), head, Buffer.alloc(40)]);
}

test('a WhatsApp voice note is read as Ogg Opus at its own rate, Hebrew first', () => {
  const c = speech.configFor(oggOpus({ rate: 48000 }), 'audio/ogg; codecs=opus');
  assert.equal(c.encoding, 'OGG_OPUS');
  assert.equal(c.sampleRateHertz, 48000);
  assert.equal(c.audioChannelCount, 1);
  assert.equal(c.languageCode, 'he-IL');
  assert.deepEqual(c.alternativeLanguageCodes, ['en-US']);
  assert.equal(speech.configFor(Buffer.from('xx'), 'video/mp4'), null);
  assert.equal(speech.opusHead(Buffer.from('nothing here')), null);
});

test('transcription returns the words; an empty result and an unsupported file are typed errors', async () => {
  const calls = [];
  const client = { async call(method, path) { calls.push(path); return { results: [{ alternatives: [{ transcript: 'תוסיפי משחק לאסף', confidence: 0.9 }], languageCode: 'he-il' }] }; }, async enable() { return { ok: true }; } };
  const out = await speech.transcribe(oggOpus(), 'audio/ogg', { client });
  assert.equal(out.text, 'תוסיפי משחק לאסף');
  assert.equal(out.confidence, 0.9);
  assert.deepEqual(calls, ['speech:recognize']);
  const empty = { async call() { return { results: [] }; }, async enable() { return { ok: true }; } };
  await assert.rejects(speech.transcribe(oggOpus(), 'audio/ogg', { client: empty }), (e) => e.state === 'empty');
  await assert.rejects(speech.transcribe(Buffer.from('x'), 'video/mp4', { client: empty }), (e) => e.state === 'unsupported');
});

test('a disabled Speech API is switched on once by the server and the call retried', async () => {
  let n = 0; let enabled = 0;
  const client = {
    async call() { n++; if (n === 1) throw new speech.SpeechError('needs_api', 'disabled', 403); return { results: [{ alternatives: [{ transcript: 'שלום' }] }] }; },
    async enable() { enabled++; return { ok: true }; },
  };
  const out = await speech.transcribe(oggOpus(), 'audio/ogg', { client, sleep: async () => {} });
  assert.equal(out.text, 'שלום');
  assert.equal(enabled, 1);
});

test('a long note goes through the long-running call and is polled to the end', async () => {
  const seen = [];
  let polls = 0;
  const client = {
    async call(method, path) {
      seen.push(path);
      if (path === 'speech:recognize') throw new speech.SpeechError('bad_audio', 'Sync input too long. For audio longer than 1 min use LongRunningRecognize', 400);
      if (path === 'speech:longrunningrecognize') return { name: 'op1', done: false };
      polls++;
      return polls < 2 ? { name: 'op1', done: false } : { done: true, response: { results: [{ alternatives: [{ transcript: 'חלק א' }] }, { alternatives: [{ transcript: 'חלק ב' }] }] } };
    },
    async enable() { return { ok: true }; },
  };
  const out = await speech.transcribe(oggOpus(), 'audio/ogg', { client, sleep: async () => {} });
  assert.equal(out.text, 'חלק א חלק ב');
  assert.deepEqual(seen, ['speech:recognize', 'speech:longrunningrecognize', 'operations/op1', 'operations/op1']);
});

test('the writer gets a plain excuse when a note cannot be transcribed', () => {
  assert.match(speech.excuse('needs_billing'), /עוד לא פעיל/);
  assert.match(speech.excuse('empty'), /לא הצלחתי לשמוע/);
  assert.match(speech.excuse('whatever'), /לא הצלחתי לתמלל/);
});

// --- incoming messages ---------------------------------------------------------
test('a voice note, a forwarded message and a menu tap are flattened with their flags', () => {
  const payload = { entry: [{ changes: [{ value: { metadata: { phone_number_id: '111' }, messages: [
    { id: 'wamid.A', from: '972501', type: 'audio', timestamp: '1', audio: { id: 'media1', voice: true } },
    { id: 'wamid.B', from: '972501', type: 'text', timestamp: '2', text: { body: 'האימון זז ל-18:00' }, context: { forwarded: true } },
    { id: 'wamid.C', from: '972501', type: 'interactive', timestamp: '3', interactive: { type: 'list_reply', list_reply: { id: 'm_week', title: 'מה יש השבוע' } } },
  ] } }] }] };
  const [voice, fwd, tap] = wa.extractMessages(payload);
  assert.equal(voice.voice, true);
  assert.equal(voice.mediaId, 'media1');
  assert.equal(fwd.forwarded, true);
  assert.equal(inboundText(fwd, fwd.text), '[הודעה מועברת]\nהאימון זז ל-18:00');
  assert.equal(inboundText({}, 'רגיל'), 'רגיל');
  assert.equal(tap.text, 'מה יש השבוע');
  assert.equal(tap.payload, 'm_week');
});

// --- buttons and the menu --------------------------------------------------------
test('a reply ending with the buttons line becomes text plus up to three buttons', () => {
  assert.deepEqual(parseButtons('למחוק את 3 המשימות?\n[[כפתורים: כן, למחוק | לא]]'), { text: 'למחוק את 3 המשימות?', buttons: ['כן, למחוק', 'לא'] });
  assert.deepEqual(parseButtons('שאלה\n[[buttons: a | b | c | d | a]]').buttons, ['a', 'b', 'c']);
  assert.deepEqual(parseButtons('בלי כפתורים'), { text: 'בלי כפתורים', buttons: [] });
  // Only a final line counts; a marker in the middle stays text.
  assert.equal(parseButtons('[[כפתורים: א]] ועוד טקסט').buttons.length, 0);
});

test('the menu opens on one word, not inside a sentence', () => {
  for (const t of ['תפריט', 'גולדה, תפריט', 'menu', 'עזרה?', '?']) assert.ok(isMenuCommand(t), t);
  for (const t of ['תפריט של המסעדה', 'אני צריך עזרה עם החוזה', '']) assert.ok(!isMenuCommand(t), t);
  assert.ok(MENU_ROWS.length <= 10);
  for (const r of MENU_ROWS) { assert.ok(r.title.length <= 24, r.title); assert.ok((r.description || '').length <= 72); }
});

test('a long body with buttons keeps the last paragraph above the buttons', () => {
  const body = `${'א'.repeat(1500)}\n\nלמחוק?`;
  assert.deepEqual(wa.splitForButtons(body), { head: 'א'.repeat(1500), tail: 'למחוק?' });
  assert.equal(wa.splitForButtons('x'.repeat(2000)).tail, '👇');
});

// --- briefs ---------------------------------------------------------------------
const players = [
  { id: 'p1', fullName: 'Assaf Cohen', gender: 'Men', dob: '2004-03-01', primaryPosition: 'Striker', contractStatus: 'Free', nationalities: ['Israel'] },
  { id: 'p2', fullName: 'Noam Levi', gender: 'Men', dob: '2003-01-01', primaryPosition: 'Centre-Back', contractStatus: 'Under Contract', contractEnd: '2026-12-31' },
  { id: 'p3', fullName: 'Naveh Salant', gender: 'Men', dob: '2008-05-05', primaryPosition: 'Winger', contractStatus: 'Under Contract' },
];
const requirements = [
  { id: 'r1', clubName: 'Hapoel Test', gender: 'Men', requiredPosition: 'Striker', ageMin: 18, ageMax: 25, status: 'open' },
  { id: 'r2', clubName: 'Maccabi X', gender: 'Men', requiredPosition: 'Centre-Back', ageMin: 18, ageMax: 26, status: 'open' },
  { id: 'r3', clubName: 'Old Club', gender: 'Men', requiredPosition: 'Striker', status: 'open', validUntil: '2026-10-01' },
];

test('opportunities pair open requirements with players that have no deal, each once', () => {
  const all = opportunitiesOf({ players, requirements, deals: [], now: NOW, min: 0 });
  assert.deepEqual(all.map((o) => `${o.player}>${o.club}`), ['Assaf Cohen>Hapoel Test', 'Noam Levi>Maccabi X']);
  assert.ok(all[0].score >= all[1].score);
  assert.match(all[0].links.player, /\/players\/p1$/);
  const withDeal = opportunitiesOf({ players, requirements, deals: [{ playerId: 'p1', clubName: 'Hapoel Test', stage: 'Offered' }], now: NOW, min: 0 });
  assert.ok(!withDeal.some((o) => o.playerId === 'p1' && o.club === 'Hapoel Test'));
  assert.equal(withDeal[0].player, 'Noam Levi');
});

test('a player brief carries the dates with days left, the next games and the fitting requirements', () => {
  const data = { players, requirements, deals: [], trainings: [], meetings: [], tasks: [{ id: 't1', title: 'לחדש דרכון', linkedPlayers: ['p2'] }], audit: [], memories: [],
    matches: [{ id: 'm1', date: '2026-11-10', time: '19:00', homeTeam: 'A', awayTeam: 'B', linkedPlayers: ['p2'] }, { id: 'm0', date: '2026-10-01', homeTeam: 'C', awayTeam: 'D', linkedPlayers: ['p2'] }] };
  const b = playerBriefOf(data, 'p2', NOW);
  assert.deepEqual(b.dates, [{ what: 'contract ends', date: '2026-12-31', daysLeft: 53 }]);
  assert.equal(b.nextGames.length, 1);
  assert.equal(b.openTasks.length, 1);
  assert.ok(b.fitsOpenRequirements.some((f) => f.club === 'Maccabi X'));
  assert.throws(() => playerBriefOf(data, 'nobody', NOW), /not found/);
});

test('a club brief finds the club by part of its name', () => {
  const b = clubBriefOf({ players, requirements, deals: [], matches: [], meetings: [], contacts: [{ id: 'c1', clubName: 'Maccabi X', contactName: 'Dani' }] }, 'maccabi', NOW);
  assert.equal(b.requirements.length, 1);
  assert.equal(b.contacts.length, 1);
});

test('a schedule read from a photo is checked line by line before anything is created', () => {
  const data = { players, matches: [{ id: 'm1', date: '2026-11-10', time: '19:00', homeTeam: 'A', awayTeam: 'B', linkedPlayers: ['p2'] }], trainings: [] };
  const out = checkScheduleOf([
    { kind: 'match', date: '2026-11-10', time: '19:00', players: ['נועם לוי'] },
    { kind: 'match', date: '2026-11-10', time: '20:30', players: ['נועם'] },
    { kind: 'training', date: '2026-11-11', time: '17:00', players: ['נוה סלנט'] },
    { kind: 'training', date: '2026-11-11', players: ['מישהו אחר'] },
    { kind: 'match', date: 'ביום ראשון', players: ['אסף'] },
  ], data, NOW);
  assert.deepEqual(out.map((x) => x.verdict), ['exists', 'update_time', 'create', 'unknown_player', 'bad_date']);
  assert.deepEqual(out[3].unknownNames, ['מישהו אחר']);
});

test('a single Hebrew ו is tried as a vowel and as a v', () => {
  assert.deepEqual(findPlayers(['נוה סלנט'], players), ['p3']);
  assert.deepEqual(findPlayers(['נועם לוי'], players), ['p2']);
  assert.deepEqual(findPlayers(['אסף כהן'], players), ['p1']);
});

// --- the briefing and the agent -----------------------------------------------------
test('the briefing sees the opportunities and knows it is Sunday', () => {
  const f = briefingFacts({ name: 'לו', today: '2026-11-08', opportunities: opportunitiesOf({ players, requirements, deals: [], now: NOW, min: 0 }) });
  assert.equal(f.isSunday, true);
  assert.equal(f.opportunities.length, 2);
  assert.equal(typeof f.opportunities[0].why, 'string');
  assert.equal(briefingFacts({ name: 'לו', today: '2026-11-09' }).isSunday, false);
});

test('the prompt teaches voice, forwards, schedule photos and the buttons line; viewers get the briefs', () => {
  const p = systemPrompt('גולדה');
  assert.match(p, /🎤/);
  assert.match(p, /\[הודעה מועברת\]/);
  assert.match(p, /check_schedule/);
  assert.match(p, /\[\[כפתורים:/);
  assert.match(p, /player_brief/);
  const viewer = toolsFor('viewer').map((t) => t.name);
  for (const n of ['player_brief', 'club_brief', 'opportunities', 'check_schedule']) assert.ok(viewer.includes(n), n);
});
