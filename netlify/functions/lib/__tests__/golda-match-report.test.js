// Per-match player data through Golda: she records a player's numbers through
// her own audited update (and undo_last takes them back), and the morning
// after a match with no numbers she asks the owner once, in one message, and
// never twice about the same match; that day the daily question waits.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
delete process.env.SCRAPER_API_KEY;
const { fakeDb, stubFirestore, recorder, OWNER, MANAGER } = require('./fake-firestore.js');

let DB;
const admin = stubFirestore(() => DB);
const { matchesToAsk, watchersOf, questionText, askMatches, MORNING_FROM, MORNING_TO } = require('../golda-match-report.js');
const { whatsappRecipients } = require('../golda-identity.js');
const { ownerOf } = require('../golda-nudge.js');
const { createTools, toolsFor, systemPrompt } = require('../wa-agent.js');
const { run } = require(path.join(__dirname, '..', '..', 'golda-briefing.js'))._internal;

const TODAY = '2026-11-25';
const YESTERDAY = '2026-11-24';
const at = (hhmm, day = TODAY) => new Date(`${day}T${String(Number(hhmm.slice(0, 2)) - 2).padStart(2, '0')}:${hhmm.slice(3)}:00Z`);   // Israel is UTC+2 in November
const owner = ownerOf(whatsappRecipients([OWNER]));
const AVI = { id: 'a', fullName: 'Avi Cohen', gender: 'Men' };
const BEN = { id: 'b', fullName: 'Ben Levi', gender: 'Men' };
const M1 = { id: 'm1', date: YESTERDAY, time: '18:00', homeTeam: 'הפועל חדרה', awayTeam: 'מכבי נתניה', linkedPlayers: ['a', 'b'] };
const M2 = { id: 'm2', date: YESTERDAY, time: '12:00', homeTeam: 'בית"ר', awayTeam: 'בני יהודה', linkedPlayers: ['b'], watchedBy: 'dani@x.com' };
const jobOf = () => { const notes = []; return { notes, note: (s) => notes.push(s) }; };

test('what to ask: yesterday\'s matches with a represented player and no numbers for him', () => {
  const items = matchesToAsk([M1, M2], [AVI, BEN], {}, TODAY);
  assert.deepEqual(items.map((x) => [x.match.id, x.players.map((p) => p.id)]), [['m2', ['b']], ['m1', ['a', 'b']]]);
  // numbers for one player leave the other
  const half = { ...M1, playerStats: { a: { minutes: 90 } } };
  assert.deepEqual(matchesToAsk([half], [AVI, BEN], {}, TODAY)[0].players.map((p) => p.id), ['b']);
});

test('nothing to ask: no match yesterday, all numbers in, not represented, in the bin', () => {
  assert.deepEqual(matchesToAsk([], [AVI], {}, TODAY), []);
  assert.deepEqual(matchesToAsk([{ ...M1, date: TODAY }, { ...M1, id: 'old', date: '2026-11-20' }], [AVI, BEN], {}, TODAY), []);
  assert.deepEqual(matchesToAsk([{ ...M1, playerStats: { a: { minutes: 0 }, b: { minutes: 45 } } }], [AVI, BEN], {}, TODAY), []);
  assert.deepEqual(matchesToAsk([{ ...M1, linkedPlayers: ['x'] }], [AVI, BEN], {}, TODAY), []);
  assert.deepEqual(matchesToAsk([{ ...M1, deletedAt: 'x' }], [AVI, BEN], {}, TODAY), []);
});

test('already asked about a match: never again', () => {
  assert.deepEqual(matchesToAsk([M1, M2], [AVI, BEN], { asked: { m1: TODAY } }, TODAY).map((x) => x.match.id), ['m2']);
});

test('one message for all of yesterday\'s matches, naming who watched', () => {
  assert.equal(watchersOf({ watchedBy: 'dani@x.com' }, [MANAGER]), 'דני');
  assert.equal(watchersOf({ watchedBy: ['Noa', 'dani@x.com'] }, [MANAGER]), 'Noa ודני');
  assert.equal(watchersOf({}, []), '');
  const text = questionText('לו', matchesToAsk([M1, M2], [AVI, BEN], {}, TODAY), [MANAGER], { firstEver: true });
  assert.match(text, /^\*איך היה אתמול, לו\?\* ⚽/);
  assert.match(text, /• בית"ר – בני יהודה \(12:00\): Ben Levi · ראו: דני\n• הפועל חדרה – מכבי נתניה \(18:00\): Avi Cohen, Ben Levi\n/);
  assert.match(text, /"בלי שאלות על משחקים"/);
  assert.ok(!/ראו/.test(text.split('\n')[2]), 'a match nobody is down for watching names nobody');
});

test('asked once, in the morning, only to the owner; never twice about the same match', async () => {
  assert.deepEqual([MORNING_FROM, MORNING_TO], [8, 12]);
  const db = fakeDb();
  const { out, send } = recorder();
  const data = { matches: [M1, M2], players: [AVI, BEN], users: [OWNER, MANAGER] };
  for (const hour of [7, 13, 20]) assert.deepEqual(await askMatches(db, owner, data, at('09:30'), { hour, send }), { skipped: 'not the hour' });
  assert.deepEqual(await askMatches(db, owner, data, at('09:30'), { hour: 9, send, job: jobOf() }), { sent: 1, matches: ['m2', 'm1'] });
  assert.equal(out.length, 1);
  assert.deepEqual([out[0].to, out[0].kind], ['lou.korek@gmail.com', 'question']);
  const state = db.read('app_meta', 'goldaMatchQuestions');
  assert.deepEqual([state.lastAskedOn, state.asked], [TODAY, { m1: TODAY, m2: TODAY }]);
  // in the chat as her turn, so "70 דקות, גול, 7" has something to answer
  assert.equal(db.all('wa_sessions/972500000001/threads')[0].history[0].proactive, 'question');
  assert.deepEqual(await askMatches(db, owner, data, at('10:30'), { hour: 10, send }), { skipped: 'asked today' });
  // the next morning the same matches are not asked again
  const tomorrow = at('09:30', '2026-11-26');
  const again = { ...data, matches: [{ ...M1, date: TODAY }, M2] };
  assert.deepEqual(await askMatches(db, owner, again, tomorrow, { hour: 9, send }), { skipped: 'nothing to ask' });
  assert.equal(out.length, 1);
});

test('nothing to ask: no message and the day is not used up; off: nothing', async () => {
  const db = fakeDb();
  const { out, send } = recorder();
  assert.deepEqual(await askMatches(db, owner, { matches: [], players: [AVI] }, at('09:30'), { hour: 9, send }), { skipped: 'nothing to ask' });
  assert.equal(db.read('app_meta', 'goldaMatchQuestions'), undefined);
  const off = fakeDb({ app_meta: { goldaMatchQuestions: { enabled: false } } });
  assert.deepEqual(await askMatches(off, owner, { matches: [M1], players: [AVI, BEN] }, at('09:30'), { hour: 9, send }), { skipped: 'off' });
  assert.equal(out.length, 0);
});

// ── the hourly pass ──────────────────────────────────────────────────────────
const approved = { templates: { golda_digest: { accounts: { 1: { status: 'APPROVED' } } }, golda_update: { accounts: { 1: { status: 'APPROVED' } } } } };
const FULL = { gender: 'Men', currentClub: 'Hapoel Hadera', contractStatus: 'Under Contract', contractEnd: '2028-06-30', reprEnd: '2028-06-30', passportExpiry: '2031-01-01', primaryPosition: 'CDM', dob: '2007-05-01', foot: '', nationalities: ['Israel'] };
const write = Object.assign(async ({ fallbackText }) => ({ text: fallbackText, ai: false, reason: 'test' }), { recap: async ({ fallbackText }) => ({ text: fallbackText, ai: false, reason: 'test' }) });
async function hour(when) {
  const out = [];
  const send = async (u, body, kind, buttons = []) => { out.push({ to: u.email, kind, body, buttons }); return { state: 'sent' }; };
  await run({ note: () => {} }, when, { send, write, site: require('./fake-site.js').fakeSite() });
  return out.filter((m) => m.kind === 'question');
}

test('the hourly pass: the match question in the morning, and the daily question waits for the next day', async () => {
  DB = fakeDb({
    app_users: { lou: OWNER, dani: MANAGER },
    players: { a: { ...FULL, fullName: 'Avi Cohen' } },
    matches: { m1: { ...M1, linkedPlayers: ['a'], deletedAt: null } },
    backups: { b1: { status: 'ok', verified: true, startedAt: at('03:30').getTime() } },
    app_meta: { whatsapp: approved, goldaSent: { briefings: { 'lou.korek@gmail.com': TODAY, 'dani@x.com': TODAY }, eventsAt: at('08:30').getTime() },
      goldaSiteFollow: { seen: { a: require('../golda-site-follow.js').viewOf({ ...FULL, fullName: 'Avi Cohen' }) } } },
  });
  const morning = await hour(at('09:30'));
  assert.equal(morning.length, 1);
  assert.match(morning[0].body, /איך היה אתמול/);
  assert.ok(!morning.some((m) => m.to === 'dani@x.com'));
  assert.deepEqual(await hour(at('14:30')), [], 'no daily question on the day she asked about matches');
  const sent = DB.read('app_meta', 'goldaSent');
  await DB.collection('app_meta').doc('goldaSent').set({ ...sent, briefings: { 'lou.korek@gmail.com': '2026-11-26', 'dani@x.com': '2026-11-26' } });
  const next = await hour(at('14:30', '2026-11-26'));
  assert.match(next[0].body, /שאלה יומית/, 'it comes the next day');
});

// ── the tool ─────────────────────────────────────────────────────────────────
// fakeDb's update does not know field paths; this one does, like Firestore.
function withFieldPaths(base) {
  const wrapDoc = (d) => ({
    ...d,
    update: async (v) => {
      const cur = (await d.get()).data() || {};
      for (const [k, x] of Object.entries(v)) {
        if (!k.includes('.')) { cur[k] = x; continue; }
        const [a, b] = k.split('.');
        cur[a] = { ...(cur[a] || {}) };
        if (x === undefined) delete cur[a][b]; else cur[a][b] = x;
      }
      await d.set(cur);
    },
  });
  return { ...base, collection: (p) => { const c = base.collection(p); return { ...c, doc: (id) => wrapDoc(c.doc(id)) }; } };
}

const tools = (db, identity = { email: 'lou.korek@gmail.com', name: 'לו', role: 'admin', phone: '972500000001' }) =>
  createTools({ db, admin, identity, media: null, session: { turn: 1 }, assistantName: 'גולדה', channel: 'whatsapp' });

test('match_report saves his line through the audited update, and undo_last takes it back', async () => {
  const db = withFieldPaths(fakeDb({
    players: { a: { ...AVI, deletedAt: null } },
    matches: { m1: { ...M1, deletedAt: null, watchedBy: 'Dani', playerStats: { b: { minutes: 90 } } } },
  }));
  const t = tools(db);
  const r = await t.run('match_report', { playerId: 'a', date: YESTERDAY, minutes: 70, goals: 1, rating: 7, note: 'שיחק טוב' });
  assert.equal(r.recorded, true);
  assert.equal(r.matchId, 'm1');
  const saved = db.read('matches', 'm1').playerStats;
  assert.deepEqual({ ...saved.a, at: undefined }, { minutes: 70, goals: 1, rating: 7, note: 'שיחק טוב', watchedBy: 'Dani', by: 'lou.korek@gmail.com', at: undefined });
  assert.deepEqual(saved.b, { minutes: 90 }, 'another player\'s line is untouched');
  assert.deepEqual([r.seasonSoFar.apps, r.seasonSoFar.minutes, r.seasonSoFar.goals], [1, 70, 1]);
  const audit = db.all('audit');
  assert.equal(audit.length, 1);
  assert.deepEqual([audit[0].action, audit[0].collection, audit[0].docId, audit[0].fields], ['update', 'matches', 'm1', ['playerStats.a']]);
  assert.equal(audit[0].before['playerStats.a'], null);
  const u = await t.run('undo_last', {});
  assert.equal(u.undone, 'update');
  assert.deepEqual(db.read('matches', 'm1').playerStats, { b: { minutes: 90 } });
});

test('match_report: a second report updates his line; undo restores the first', async () => {
  const db = withFieldPaths(fakeDb({ players: { a: { ...AVI } }, matches: { m1: { ...M1, playerStats: { a: { minutes: 60, by: 'x', at: '2026-11-24T20:00:00Z' } } } } }));
  const t = tools(db);
  await t.run('match_report', { playerId: 'a', matchId: 'm1', goals: 2 });
  assert.equal(db.read('matches', 'm1').playerStats.a.minutes, 60);
  assert.equal(db.read('matches', 'm1').playerStats.a.goals, 2);
  await t.run('undo_last', {});
  assert.deepEqual(db.read('matches', 'm1').playerStats.a, { minutes: 60, by: 'x', at: '2026-11-24T20:00:00Z' });
});

test('match_report: no match that day lists his recent ones; bad input is refused', async () => {
  const db = withFieldPaths(fakeDb({ players: { a: { ...AVI } }, matches: { m1: { ...M1 } } }));
  const t = tools(db);
  const r = await t.run('match_report', { playerId: 'a', date: '2026-11-23', minutes: 90 });
  assert.equal(r.needsChoice, true);
  assert.deepEqual(r.matches.map((m) => m.matchId), ['m1']);
  assert.equal((await t.run('match_report', { playerId: 'a', date: '2026-01-01', minutes: 90 })).notFound, true);
  await assert.rejects(t.run('match_report', { playerId: 'a', matchId: 'm1', rating: 12 }), /rating is 1 to 10/);
  await assert.rejects(t.run('match_report', { playerId: 'a', matchId: 'm1' }), /nothing to record/);
  await assert.rejects(t.run('match_report', { playerId: 'zz', matchId: 'm1', minutes: 1 }), /player not found/);
  assert.equal(db.all('audit').length, 0);
});

test('who may: editors record, a viewer cannot; only the admin switches the question', async () => {
  const names = (role) => toolsFor(role).map((x) => x.name);
  assert.ok(names('manager').includes('match_report'));
  assert.ok(!names('viewer').includes('match_report'));
  assert.ok(names('admin').includes('match_questions'));
  assert.ok(!names('manager').includes('match_questions'));
  const db = withFieldPaths(fakeDb({ players: { a: { ...AVI } }, matches: { m1: { ...M1 } } }));
  await assert.rejects(tools(db, { email: 'v@x.com', name: 'V', role: 'viewer' }).run('match_report', { playerId: 'a', matchId: 'm1', minutes: 5 }), /may not edit/);
  const t = tools(db);
  assert.deepEqual(await t.run('match_questions', { action: 'off' }), { on: false, note: 'No more questions about matches until he asks for them again.' });
  assert.equal(db.read('app_meta', 'goldaMatchQuestions').enabled, false);
  assert.equal((await t.run('match_questions', { action: 'status' })).on, false);
  assert.equal((await t.run('match_questions', { action: 'on' })).on, true);
  await assert.rejects(tools(db, { email: 'd@x.com', name: 'D', role: 'manager' }).run('match_questions', { action: 'off' }), /only an admin/);
  assert.match(systemPrompt('גולדה'), /match_report/);
});
