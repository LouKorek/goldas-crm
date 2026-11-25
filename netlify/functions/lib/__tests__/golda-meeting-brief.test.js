// The brief before a meeting: which meetings are due, what the brief says,
// that it goes to the owner once per meeting, and that a failed one is tried again.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeDb, stubFirestore, recorder, OWNER, MANAGER } = require('./fake-firestore.js');
stubFirestore();

const { dueMeetings, subjectsOf, meetingFacts, buildMeetingBrief, dueNow, runMeetingBriefs, israelMinutes, FROM_MIN, TO_MIN } = require('../golda-meeting-brief.js');

// Wednesday 25/11/2026, 10:00 in Israel (UTC+2)
const NOW = new Date('2026-11-25T08:00:00Z');
const TODAY = '2026-11-25';
const meeting = (id, time, extra = {}) => ({ id, title: `פגישה ${id}`, date: TODAY, time, ...extra });

test('a meeting is due when it starts in 10 to 70 minutes, once', () => {
  assert.equal(israelMinutes(NOW), 600);
  assert.deepEqual([FROM_MIN, TO_MIN], [10, 70]);
  const rows = [meeting('early', '10:09'), meeting('soon', '10:10'), meeting('hour', '11:00'), meeting('edge', '11:10'), meeting('later', '11:11'), meeting('past', '09:30'),
    meeting('allday', '11:00', { allDay: true }), meeting('untimed', ''), meeting('gone', '11:00', { deletedAt: 'x' }), meeting('tomorrow', '11:00', { date: '2026-11-26' }),
    meeting('nodate', '11:00', { date: '' })];
  const due = dueMeetings(rows, {}, NOW);
  assert.deepEqual(due.map((m) => [m.id, m.inMinutes]), [['soon', 10], ['hour', 60], ['edge', 70]]);
  assert.equal(due[1].key, 'hour|2026-11-25');
  // already briefed: not again, while a meeting moved to another day is a new one
  assert.deepEqual(dueMeetings(rows, { 'hour|2026-11-25': 1, 'edge|2026-11-24': 1 }, NOW).map((m) => m.id), ['soon', 'edge']);
});

test('a meeting just after midnight is briefed the evening before', () => {
  const night = new Date('2026-11-25T21:30:00Z');   // 23:30 in Israel
  const due = dueMeetings([meeting('m', '00:15', { date: '2026-11-26' }), meeting('n', '01:00', { date: '2026-11-26' })], {}, night);
  assert.deepEqual(due.map((m) => [m.id, m.inMinutes]), [['m', 45]]);
});

const DATA = {
  players: [
    { id: 'p1', fullName: 'Dana Cohen', gender: 'Women', dob: '2004-03-01', primaryPosition: 'ST', currentClub: 'Maccabi Haifa', contractEnd: '2026-12-10', reprEnd: '2027-06-30', passportExpiry: '2030-01-01' },
    { id: 'p2', fullName: 'Assaf Levi', gender: 'Men', dob: '2006-12-30', contractStatus: 'Free', passportExpiry: '2026-11-20' },
    { id: 'p3', fullName: 'Old Player', deletedAt: 'x' },
  ],
  deals: [
    { id: 'd1', playerId: 'p1', playerName: 'Dana Cohen', clubName: 'Hapoel Test', stage: 'Offered to Club', enteredStageAt: '2026-11-15T10:00:00Z' },
    { id: 'd2', playerId: 'p1', playerName: 'Dana Cohen', clubName: 'Closed FC', stage: 'Offered to Club', closedAt: '2026-11-01' },
    { id: 'd3', playerId: 'p9', playerName: 'Noa Bar', clubName: 'Hapoel Test', stage: 'Offered to Club', enteredStageAt: '2026-11-20T10:00:00Z' },
  ],
  requirements: [{ id: 'r1', clubName: 'Hapoel Test', requiredPosition: 'CB', status: 'open' }, { id: 'r2', clubName: 'Hapoel Test', requiredPosition: 'GK', status: 'closed' }],
  tasks: [
    { id: 't1', title: 'לשלוח חוזה לדנה', linkedPlayers: ['p1'], dueDate: '2026-11-20' },
    { id: 't2', title: 'נסגרה', linkedPlayers: ['p1'], done: true },
    { id: 't3', title: 'לא קשורה', linkedPlayers: ['p2'] },
  ],
  meetings: [
    { id: 'old', title: 'שיחה עם דנה', date: '2026-11-10', time: '12:00', linkedPlayers: ['p1'], notes: 'סוכם שנחכה להצעה של הפועל עד סוף החודש.' },
    { id: 'older', title: 'היכרות', date: '2026-10-01', time: '12:00', linkedPlayers: ['p1'], notes: 'פגישה ראשונה.' },
    { id: 'future', title: 'אחרי', date: '2026-12-01', time: '12:00', linkedPlayers: ['p1'], notes: 'עוד לא קרה.' },
  ],
  memories: [{ id: 'a', text: 'Dana Cohen מעדיפה לשחק בחו"ל' }, { id: 'b', text: 'משהו על מישהו אחר' }],
};

test('the brief is about the linked players, or the names in the title', () => {
  assert.deepEqual(subjectsOf({ title: 'פגישה', linkedPlayers: ['p1', 'p3', 'nope'] }, DATA).players.map((p) => p.id), ['p1']);
  const byName = subjectsOf({ title: 'שיחה: Assaf Levi + Hapoel Test', notes: '' }, DATA);
  assert.deepEqual([byName.players.map((p) => p.id), byName.clubs], [['p2'], ['Hapoel Test']]);
  assert.deepEqual(subjectsOf({ title: 'ארוחת צהריים' }, DATA), { players: [], clubs: [] });
});

test('the facts: who, the dates that matter, open deals and tasks, what was last agreed', () => {
  const m = { id: 'm1', title: 'פגישה עם דנה', date: TODAY, time: '11:00', endTime: '12:00', location: 'קפה', guests: ['Dana Cohen'], notes: 'חידוש חוזה', linkedPlayers: ['p1'], inMinutes: 60 };
  const f = meetingFacts(m, DATA, NOW);
  assert.equal(f.people.length, 1);
  const p = f.people[0];
  assert.deepEqual([p.name, p.age, p.woman, p.position, p.club], ['Dana Cohen', 22, true, 'ST', 'Maccabi Haifa']);
  assert.equal(p.dates.length, 2, 'a passport far from its end is not a line');
  assert.match(p.dates[0], /חוזה עד 10\/12\/2026 \(בעוד 15 ימים\) ⏳/);
  assert.deepEqual(p.deals.map((d) => [d.club, d.days]), [['Hapoel Test', 10]]);
  assert.deepEqual(p.tasks, [{ title: 'לשלוח חוזה לדנה', dueDate: '2026-11-20', overdue: true }]);
  assert.deepEqual([f.last.date, f.last.title], ['2026-11-10', 'שיחה עם דנה']);
  assert.deepEqual(f.memories, ['Dana Cohen מעדיפה לשחק בחו"ל']);
  assert.equal(f.link, 'https://goldas-crm.netlify.app/players/p1');

  const text = buildMeetingBrief('לו', f);
  assert.match(text, /^\*לו, פגישה בעוד כשעה\* 🗓️\n\*פגישה עם דנה\* · 11:00–12:00 · קפה/);
  assert.match(text, /משתתפים: Dana Cohen/);
  assert.match(text, /על הפרק: חידוש חוזה/);
  assert.match(text, /\*Dana Cohen\* · ST · Maccabi Haifa · בת 22/);
  assert.match(text, /• עסקה פתוחה: Hapoel Test, בשלב ".+" כבר 10 ימים/);
  assert.match(text, /• משימה פתוחה: לשלוח חוזה לדנה \(עד 20\/11\) ⚠️ באיחור/);
  assert.match(text, /\*מה סוכם לאחרונה:\*\n• בפגישה הקודמת \(10\/11, שיחה עם דנה\): סוכם שנחכה להצעה/);
  assert.match(text, /• מהזיכרון שלי: Dana Cohen מעדיפה/);
  assert.ok(!text.includes('Closed FC') && !text.includes('נסגרה') && !text.includes('עוד לא קרה'));
});

test('a club in the title brings its open deals and requirements; a passport that ran out is flagged', () => {
  const f = meetingFacts({ id: 'm2', title: 'Assaf Levi מול Hapoel Test', date: TODAY, time: '10:30', inMinutes: 30 }, DATA, NOW);
  assert.deepEqual(f.people[0].club, 'שחקן חופשי');
  assert.match(f.people[0].dates[0], /דרכון עד 20\/11\/2026 \(עבר לפני 5 ימים\) ⚠️/);
  assert.deepEqual(f.clubs, [{ name: 'Hapoel Test', deals: [{ player: 'Dana Cohen', club: 'Hapoel Test', stage: f.clubs[0].deals[0].stage, days: 10 }, { player: 'Noa Bar', club: 'Hapoel Test', stage: f.clubs[0].deals[1].stage, days: 5 }], requirements: ['CB'] }]);
  const text = buildMeetingBrief('לו', f);
  assert.match(text, /פגישה בעוד 30 דקות/);
  assert.match(text, /\*Hapoel Test\*\n• עסקה פתוחה: Dana Cohen/);
  assert.match(text, /• דרישות פתוחות: CB/);
  assert.match(text, /https:\/\/goldas-crm\.netlify\.app\/players\/p2$/);
});

test('a meeting about nobody the CRM knows still gets a short brief that says so', () => {
  const text = buildMeetingBrief('לו', meetingFacts({ id: 'm3', title: 'רואה חשבון', date: TODAY, time: '11:00', inMinutes: 55 }, DATA, NOW));
  assert.match(text, /לא מצאתי במערכת שחקן או מועדון שקשורים לפגישה הזאת/);
  assert.match(text, /\/calendar$/);
});

// ── the run ─────────────────────────────────────────────────────────────────
const byId = (rows) => Object.fromEntries(rows.map(({ id, ...r }) => [id, r]));
function seed(meetings, extra = {}) {
  return fakeDb({
    app_users: { lou: OWNER, dani: MANAGER },
    players: byId(DATA.players), deals: byId(DATA.deals), club_requirements: byId(DATA.requirements), tasks: byId(DATA.tasks),
    meetings: { ...byId(DATA.meetings), ...byId(meetings) }, golda_memory: { a: { text: 'Dana Cohen מעדיפה לשחק בחו"ל', shared: true }, mine: { text: 'Dana Cohen: פרטי של דני', owner: 'dani@x.com' } },
    ...extra,
  });
}
const DUE = { id: 'm1', title: 'פגישה עם דנה', date: TODAY, time: '11:00', linkedPlayers: ['p1'] };

test('the cron check is true only while a meeting waits for its brief', async () => {
  assert.deepEqual((await dueNow(seed([DUE]), NOW)).map((m) => m.id), ['m1']);
  assert.deepEqual(await dueNow(seed([{ ...DUE, time: '15:00' }]), NOW), []);
  assert.deepEqual(await dueNow(seed([DUE], { app_meta: { goldaMeetingBriefs: { keys: { 'm1|2026-11-25': 1 } } } }), NOW), []);
});

test('the brief goes to the owner only, once per meeting', async () => {
  const db = seed([DUE, { id: 'm4', title: 'רואה חשבון', date: TODAY, time: '10:40' }]);
  const { out, send } = recorder();
  const notes = [];
  const r = await runMeetingBriefs(db, NOW, { send, job: { note: (s) => notes.push(s) } });
  assert.deepEqual(r, { sent: 2, failed: 0, meetings: ['רואה חשבון', 'פגישה עם דנה'] });
  assert.deepEqual(out.map((m) => [m.to, m.kind, m.buttons]), [['lou.korek@gmail.com', 'meeting', []], ['lou.korek@gmail.com', 'meeting', []]]);
  assert.match(out[1].body, /\*Dana Cohen\*/);
  assert.match(out[1].body, /מהזיכרון שלי: Dana Cohen מעדיפה/);
  assert.ok(!out[1].body.includes('פרטי של דני'), "another person's private memory stays private");
  assert.deepEqual(Object.keys(db.read('app_meta', 'goldaMeetingBriefs').keys).sort(), ['m1|2026-11-25', 'm4|2026-11-25']);
  assert.equal(db.all('wa_sessions').length, 0, 'a brief is not a turn of the conversation');
  // ten minutes later: nothing again
  const again = await runMeetingBriefs(db, new Date(NOW.getTime() + 600000), { send, job: { note: () => {} } });
  assert.deepEqual([again.sent, out.length], [0, 2]);
});

test('a brief that failed is not marked, so the next check sends it; old keys are dropped', async () => {
  const db = seed([DUE], { app_meta: { goldaMeetingBriefs: { keys: { 'x|2026-11-01': 1, 'y|2026-11-24': 1 } } } });
  let fail = true;
  const sent = [];
  const send = async (u, body) => { if (fail) throw new Error('WhatsApp API 500'); sent.push(body); return { state: 'sent' }; };
  const notes = [];
  const first = await runMeetingBriefs(db, NOW, { send, job: { note: (s) => notes.push(s) } });
  assert.deepEqual([first.sent, first.failed], [0, 1]);
  assert.match(notes[0], /meeting brief failed \(פגישה עם דנה\): WhatsApp API 500/);
  assert.equal('m1|2026-11-25' in db.read('app_meta', 'goldaMeetingBriefs').keys, false);
  fail = false;
  const second = await runMeetingBriefs(db, new Date(NOW.getTime() + 600000), { send, job: { note: () => {} } });
  assert.equal(second.sent, 1);
  assert.match(sent[0], /פגישה בעוד 50 דקות|פגישה בעוד כשעה/);
  assert.deepEqual(Object.keys(db.read('app_meta', 'goldaMeetingBriefs').keys).sort(), ['m1|2026-11-25', 'y|2026-11-24']);
});

test('without the owner on WhatsApp nothing is sent, to anyone', async () => {
  const db = seed([DUE]);
  await db.collection('app_users').doc('lou').set({ ...OWNER, channels: [] });
  const { out, send } = recorder();
  const notes = [];
  const r = await runMeetingBriefs(db, NOW, { send, job: { note: (s) => notes.push(s) } });
  assert.equal(r.sent, 0);
  assert.equal(out.length, 0);
  assert.match(notes[0], /the owner has no WhatsApp number/);
});
