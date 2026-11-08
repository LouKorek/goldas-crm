// Golda takes the initiative (phase B): transfer windows, deal follow-up
// tasks, new-requirement and team-move alerts, the week ahead, the Thursday
// recap and the team's 👍/👎 on her answers.
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.FIREBASE_SERVICE_ACCOUNT_KEY = '{}';
process.env.OWNER_EMAIL = 'lou.korek@gmail.com';

const tw = require('../transfer-windows.js');
const pro = require('../golda-proactive.js');
const fb = require('../golda-feedback.js');
const wa = require('../wa-api.js');
const { briefingFacts, buildRecap, writeRecap } = require('../golda-briefing-ai.js');
const { systemPrompt, toolsFor } = require('../wa-agent.js');

const NOW = new Date('2026-11-08T10:00:00Z');   // a Sunday
const iso = (d) => new Date(d).toISOString();

// --- transfer windows --------------------------------------------------------------
test('in November no big window is open; winter windows open within 60 days', () => {
  const s = tw.windowStatus(NOW);
  assert.equal(s.today, '2026-11-08');
  assert.equal(s.open.length, 0);
  assert.ok(s.opening.some((w) => w.league === 'Premier League' && w.kind === 'winter' && w.daysToOpen === 54));
  assert.ok(s.notCovered.length >= 1);
  assert.ok(s.source);
});

test('a window that is open counts its days left and is "closing soon" inside 30 days', () => {
  const s = tw.windowStatus(new Date('2026-08-25T09:00:00Z'));
  const pl = s.open.find((w) => w.league === 'Premier League');
  assert.equal(pl.daysLeft, 7);
  assert.ok(s.closingSoon.some((w) => w.league === 'Premier League'));
});

test('deadline marks: 14, 7, 3 and 1 days before closing, grouped per day, with a stable key', () => {
  const marks = tw.windowMarks(new Date('2026-08-25T09:00:00Z'));   // 7 days before 1 Sep
  const seven = marks.find((m) => m.kind === 'closes' && m.days === 7);
  assert.ok(seven.leagues.some((l) => l.startsWith('Premier League')));
  assert.ok(seven.leagues.some((l) => l.startsWith('Serie A')));
  assert.match(seven.key, /^tw\|summer\|2026-08-25\|closes\|7$/);
  assert.deepEqual(tw.windowMarks(new Date('2026-08-26T09:00:00Z')).filter((m) => m.days === 7 && m.leagues.some((l) => l.startsWith('Premier'))), []);
  const msg = tw.buildWindowMessage('לו', marks);
  assert.match(msg, /חלונות העברות, לו/);
  assert.match(msg, /נסגר בעוד 7 ימים/);
  assert.equal(tw.buildWindowMessage('לו', []), '');
});

test('opening day and 14 days before opening are marks too', () => {
  const opens = tw.windowMarks(new Date('2027-01-01T08:00:00Z'));
  assert.ok(opens.some((m) => m.kind === 'opens' && m.days === 0 && m.leagues.includes('Premier League')));
  const before = tw.windowMarks(new Date('2026-12-18T08:00:00Z'));
  assert.ok(before.some((m) => m.kind === 'opens' && m.days === 14));
});

// --- deal follow-ups ---------------------------------------------------------------
const deals = [
  { id: 'd1', playerId: 'p1', playerName: 'Assaf Cohen', clubName: 'Hapoel Test', stage: 'Offered to Club', enteredStageAt: iso('2026-10-30T10:00:00Z'), owner: 'dani@x.com' },
  { id: 'd2', playerId: 'p2', playerName: 'Noam Levi', clubName: 'Maccabi X', stage: 'Negotiation', enteredStageAt: iso('2026-11-06T10:00:00Z') },
  { id: 'd3', playerId: 'p3', playerName: 'Naveh Salant', clubName: 'Old', stage: 'Waiting Response', enteredStageAt: iso('2026-10-20T10:00:00Z') },
  { id: 'd4', playerId: 'p3', playerName: 'Naveh Salant', clubName: 'Done FC', stage: 'Contract Signed', enteredStageAt: iso('2026-09-01T10:00:00Z') },
];

test('a deal that waits past its stage limit gets one follow-up task, owned by the deal owner', () => {
  const out = pro.dealFollowups({ deals, tasks: [], now: NOW, owner: 'lou.korek@gmail.com' });
  assert.deepEqual(out.map((t) => t.dealId).sort(), ['d1', 'd3']);
  const t1 = out.find((t) => t.dealId === 'd1');
  assert.equal(t1.owner, 'dani@x.com');
  assert.equal(t1.dueDate, '2026-11-08');
  assert.equal(t1.priority, 'Normal');
  assert.equal(t1.auto, 'deal_followup');
  assert.deepEqual(t1.linkedPlayers, ['p1']);
  assert.match(t1.title, /^מעקב: Assaf Cohen בHapoel Test/);
  assert.match(t1.notes, /deal=d1/);
  const t3 = out.find((t) => t.dealId === 'd3');
  assert.equal(t3.owner, 'lou.korek@gmail.com');
  assert.equal(t3.priority, 'High');   // 19 days in a 7-day stage
});

test('no second task for the same deal and stage; a moved deal closes its task', () => {
  const existing = [{ id: 't1', dealId: 'd1', followStage: 'Offered to Club', auto: 'deal_followup', done: false }];
  assert.ok(!pro.dealFollowups({ deals, tasks: existing, now: NOW }).some((t) => t.dealId === 'd1'));
  assert.deepEqual(pro.followupsToClose({ deals, tasks: existing }), []);
  const moved = deals.map((d) => (d.id === 'd1' ? { ...d, stage: 'Negotiation' } : d));
  assert.deepEqual(pro.followupsToClose({ deals: moved, tasks: existing }).map((t) => t.id), ['t1']);
  assert.deepEqual(pro.followupsToClose({ deals: deals.filter((d) => d.id !== 'd1'), tasks: existing }).map((t) => t.id), ['t1']);
  assert.deepEqual(pro.followupsToClose({ deals, tasks: [{ ...existing[0], done: true }] }), []);
});

// --- alerts ------------------------------------------------------------------------
const players = [
  { id: 'p1', fullName: 'Assaf Cohen', gender: 'Men', dob: '2004-03-01', primaryPosition: 'Striker', contractStatus: 'Free', nationalities: ['Israel'] },
  { id: 'p2', fullName: 'Noam Levi', gender: 'Men', dob: '2003-01-01', primaryPosition: 'Centre-Back', contractStatus: 'Under Contract', contractEnd: '2026-12-31' },
];

test('a requirement added since the last check comes with its best fits; older ones are skipped', () => {
  const since = new Date('2026-11-08T08:00:00Z').getTime();
  const requirements = [
    { id: 'r1', clubName: 'Hapoel New', gender: 'Men', requiredPosition: 'Striker', ageMin: 18, ageMax: 25, status: 'open', createdAt: iso('2026-11-08T09:30:00Z'), createdBy: 'dani@x.com' },
    { id: 'r2', clubName: 'Old', gender: 'Men', requiredPosition: 'Striker', status: 'open', createdAt: iso('2026-11-01T09:30:00Z') },
  ];
  const out = pro.newRequirementFits({ requirements, players, deals: [], since, now: NOW, min: 0 });
  assert.deepEqual(out.map((r) => r.id), ['r1']);
  assert.equal(out[0].by, 'dani@x.com');
  assert.equal(out[0].fits[0].player, 'Assaf Cohen');
  const msg = pro.buildRequirementMessage('לו', out);
  assert.match(msg, /דרישה חדשה במערכת, לו/);
  assert.match(msg, /req=r1/);
});

test('team deal moves list what others changed since the last check, by name', () => {
  const since = new Date('2026-11-08T08:00:00Z').getTime();
  const d = [{ id: 'd1', playerName: 'Assaf', clubName: 'Hapoel', history: [
    { stage: 'Negotiation', at: iso('2026-11-08T09:00:00Z'), by: 'dani@x.com' },
    { stage: 'Offered to Club', at: iso('2026-11-07T09:00:00Z'), by: 'dani@x.com' },
    { stage: 'Contract Signed', at: iso('2026-11-08T09:30:00Z'), by: 'lou.korek@gmail.com' },
  ] }];
  const moves = pro.teamDealMoves({ deals: d, since, email: 'lou.korek@gmail.com', names: { 'dani@x.com': 'דני' } });
  assert.deepEqual(moves.map((m) => `${m.by}:${m.stage}`), ['דני:Negotiation']);
  assert.match(pro.buildMovesMessage('לו', moves), /דני: Assaf בHapoel/);
});

// --- the week ahead and the recap --------------------------------------------------
test('the week ahead groups games, trainings and meetings by day; cancelled sessions are left out', () => {
  const w = pro.weekAhead({
    players,
    matches: [{ id: 'm1', date: '2026-11-10', time: '19:00', homeTeam: 'A', awayTeam: 'B', linkedPlayers: ['p1'] }, { id: 'm2', date: '2026-11-20', homeTeam: 'C', awayTeam: 'D' }],
    trainings: [{ id: 't1', title: 'אימון כוח', time: '17:00', rule: { freq: 'weekly', byWeekday: [1, 3], start: '2026-11-01' }, linkedPlayers: ['p2'], exceptions: [{ date: '2026-11-09', cancelled: true }] }],
    meetings: [{ id: 'g1', date: '2026-11-08', time: '12:00', title: 'פגישה עם מועדון' }],
  }, NOW);
  const dates = w.map((d) => d.date);
  assert.ok(dates.includes('2026-11-08') && dates.includes('2026-11-10'));
  assert.ok(!dates.includes('2026-11-20'));
  const game = w.find((d) => d.date === '2026-11-10').items.find((i) => i.kind === 'game');
  assert.equal(game.who, 'Assaf Cohen');
  assert.ok(!(w.find((d) => d.date === '2026-11-09')?.items || []).some((i) => i.kind === 'training'));
  const wed = w.find((d) => d.date === '2026-11-11').items.find((i) => i.kind === 'training');
  assert.equal(wed.what, 'אימון כוח');
  assert.equal(wed.who, 'Noam Levi');
});

test('the recap counts the week and the 👍/👎, and the plain version needs no model', async () => {
  const f = pro.recapFacts({
    deals: [{ id: 'd1', playerName: 'Assaf', clubName: 'Hapoel', history: [{ stage: 'Contract Signed', at: iso('2026-11-07T09:00:00Z'), by: 'dani@x.com' }] }],
    requirements: [{ id: 'r1', clubName: 'New', requiredPosition: 'Striker', createdAt: iso('2026-11-05T09:00:00Z') }],
    tasks: [{ id: 't1', done: true, doneAt: iso('2026-11-06T09:00:00Z') }, { id: 't2', done: false, dueDate: '2026-11-01' }, { id: 't3', done: false }],
    matches: [{ id: 'm1', date: '2026-11-04', homeTeam: 'A', awayTeam: 'B', linkedPlayers: ['p1'] }],
    players, audit: [{ at: iso('2026-11-07T09:00:00Z'), via: 'golda' }, { at: iso('2026-11-07T10:00:00Z'), via: 'app' }],
    feedback: [{ rating: 1, at: iso('2026-11-07T09:00:00Z') }, { rating: -1, at: iso('2026-11-07T09:00:00Z'), question: 'מי פנוי?', reply: 'לא יודעת', name: 'דני' }],
  }, NOW);
  assert.equal(f.signed, 1);
  assert.equal(f.newRequirements.length, 1);
  assert.equal(f.tasksDone, 1);
  assert.equal(f.tasksOpen, 2);
  assert.equal(f.tasksOverdue, 1);
  assert.equal(f.gamesPlayed[0].players[0], 'Assaf Cohen');
  assert.equal(f.teamChanges, 2);
  assert.equal(f.goldaChanges, 1);
  assert.deepEqual([f.quality.up, f.quality.down], [1, 1]);
  assert.equal(f.quality.cases[0].by, 'דני');
  const plain = buildRecap('לו', f, f.quality);
  assert.match(plain, /^\*סיכום שבוע, לו\* 📋/);
  assert.match(plain, /1 חוזים נחתמו/);
  assert.match(plain, /1 👍 · 1 👎/);
  assert.doesNotMatch(buildRecap('דני', f, null), /איכות גולדה/);
  const saved = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY;
  const r = await writeRecap({ name: 'לו', facts: f, fallbackText: plain });
  if (saved) process.env.ANTHROPIC_API_KEY = saved;
  assert.equal(r.ai, false);
  assert.equal(r.text, plain);
});

test('the recap goes out on Thursday at 18:00 Israel time only', () => {
  assert.equal(pro.isRecapTime(new Date('2026-11-12T16:10:00Z')), true);    // Thu 18:10 Israel (winter, UTC+2)
  assert.equal(pro.isRecapTime(new Date('2026-11-12T15:10:00Z')), false);
  assert.equal(pro.isRecapTime(new Date('2026-11-11T16:10:00Z')), false);
  assert.deepEqual(pro.israelClock(NOW), { weekday: 0, hour: 12 });
});

test('the morning briefing carries the week ahead and the windows that open soon', () => {
  const f = briefingFacts({ name: 'לו', today: '2026-11-08', weekAhead: [{ date: '2026-11-10', items: [] }], transferWindows: tw.windowStatus(new Date('2026-12-20T08:00:00Z')) });
  assert.equal(f.weekAhead.length, 1);
  assert.ok(f.transferWindows.opening.every((w) => w.daysToOpen <= 21));
  assert.ok(f.transferWindows.opening.some((w) => w.league === 'Premier League'));
  assert.equal(briefingFacts({ name: 'לו', today: '2026-11-08' }).transferWindows, null);
});

// --- 👍/👎 --------------------------------------------------------------------------
test('reactions are read as +1, -1 or nothing, with skin tones ignored', () => {
  assert.equal(fb.ratingOf('👍'), 1);
  assert.equal(fb.ratingOf('👍🏽'), 1);
  assert.equal(fb.ratingOf('❤️'), 1);
  assert.equal(fb.ratingOf('👎'), -1);
  assert.equal(fb.ratingOf('🤦‍♂️'), -1);
  assert.equal(fb.ratingOf('😂'), 0);
  assert.equal(fb.ratingOf(''), 0);
});

test('a WhatsApp reaction arrives as a message naming the answer it is on', () => {
  const payload = { entry: [{ changes: [{ value: { metadata: { phone_number_id: '123' }, messages: [{ id: 'wamid.R', from: '972501234567', type: 'reaction', timestamp: '1700000000', reaction: { message_id: 'wamid.A', emoji: '👎' } }] } }] }] };
  const [m] = wa.extractMessages(payload);
  assert.equal(m.type, 'reaction');
  assert.deepEqual(m.reaction, { messageId: 'wamid.A', emoji: '👎' });
});

function fakeDb() {
  const store = new Map();
  const col = (name) => ({
    doc: (id) => ({
      async set(v) { store.set(`${name}/${id}`, v); },
      async delete() { store.delete(`${name}/${id}`); },
    }),
    where: (field, op, value) => ({
      limit: () => ({ async get() {
        const docs = [...store.entries()].filter(([k, v]) => k.startsWith(`${name}/`) && (op === 'array-contains' ? (v[field] || []).includes(value) : v[field] === value))
          .map(([k, v]) => ({ id: k.split('/')[1], data: () => v }));
        return { empty: !docs.length, docs };
      } }),
      async get() {
        const docs = [...store.entries()].filter(([k, v]) => k.startsWith(`${name}/`) && v[field] === value).map(([k, v]) => ({ id: k.split('/')[1], data: () => v }));
        return { empty: !docs.length, docs };
      },
    }),
  });
  return { store, collection: col };
}

test('a rating is stored once per person and answer, replaced on change and removed on 0; the inbox is found by sent id', async () => {
  const db = fakeDb();
  db.store.set('wa_inbox/wamid.Q', { text: 'מי פנוי?', reply: 'אסף', sentIds: ['wamid.A'] });
  const inbox = await fb.inboxForSentId(db, 'wamid.A');
  assert.equal(inbox.id, 'wamid.Q');
  await fb.recordFeedback(db, { who: '972501234567', answerId: 'wamid.A', inbox, rating: 1, emoji: '👍', channel: 'whatsapp' });
  await fb.recordFeedback(db, { who: '972501234567', answerId: 'wamid.A', inbox, rating: -1, emoji: '👎', channel: 'whatsapp' });
  const rows = [...db.store.keys()].filter((k) => k.startsWith('golda_feedback/'));
  assert.equal(rows.length, 1);
  const saved = db.store.get(rows[0]);
  assert.equal(saved.rating, -1);
  assert.equal(saved.question, 'מי פנוי?');
  assert.equal(saved.reply, 'אסף');
  const mistakes = await fb.recentMistakes(db);
  assert.equal(mistakes.length, 1);
  assert.match(fb.mistakesSection(mistakes), /marked 👎/);
  assert.equal(fb.mistakesSection([]), '');
  await fb.recordFeedback(db, { who: '972501234567', answerId: 'wamid.A', inbox, rating: 0, channel: 'whatsapp' });
  assert.equal([...db.store.keys()].filter((k) => k.startsWith('golda_feedback/')).length, 0);
});

// --- the agent ---------------------------------------------------------------------
test('every role can ask about transfer windows, and the prompt carries the 👎 cases', () => {
  assert.ok(toolsFor('viewer').some((t) => t.name === 'transfer_windows'));
  const p = systemPrompt('גולדה', { name: 'לו', role: 'admin' }, null, [], 'whatsapp', [], [{ question: 'מי פנוי?', reply: 'לא יודעת' }]);
  assert.match(p, /transfer_windows/);
  assert.match(p, /marked 👎[\s\S]*מי פנוי\?/);
  assert.doesNotMatch(systemPrompt('גולדה'), /marked 👎/);
});
