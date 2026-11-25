// Golda writes first to a connected player: when each of the three messages is
// due, who may get it, that it holds only his own schedule, that it goes once
// and never stale, that he can stop it himself, and that only an admin switches it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeDb, stubFirestore, OWNER } = require('./fake-firestore.js');
const admin = stubFirestore();

const ps = require('../golda-player-sends.js');
const outbox = require('../wa-outbox.js');
const { systemPrompt, toolsFor } = require('../wa-agent.js');
const gp = require('../golda-player.js');

const { TIMING, dueFor, buildWeek, buildTraining, buildMatch, runPlayerSends, dueNow, isStopCommand, stopForPlayer, stopConfirmation, playerMessagesTools } = ps;

// Israel is UTC+2 in November. Wednesday 25/11/2026; Saturday 28/11; Sunday 29/11.
const at = (date, hhmm) => new Date(`${date}T${hhmm}:00+02:00`);
const WED = '2026-11-25';
const THU = '2026-11-26';

const PLAYER = {
  id: 'p1', fullName: 'Noam Barzilai', gender: 'Men', stage: 'represented', goldaAccess: true, goldaPhone: '0521234567',
  goldaWeek: true, goldaTrainingReminder: true, goldaMatchWish: true,
};
const training = (id, extra = {}) => ({ id, title: 'אימון קבוצה', time: '17:30', place: 'מגרש הדר', linkedPlayers: ['p1'], date: WED, ...extra });
const match = (id, extra = {}) => ({ id, date: WED, time: '19:00', homeTeam: 'הפועל חדרה', awayTeam: 'מכבי נתניה', stadiumName: 'אצטדיון חדרה', linkedPlayers: ['p1'], ...extra });

test('the timings are in one place and are what was chosen', () => {
  assert.deepEqual({ ...TIMING }, {
    DAY_FROM_HOUR: 8, DAY_TO_HOUR: 22, WEEK_WEEKDAY: 6, WEEK_HOUR: 21, WEEK_CATCH_UP_UNTIL: 12,
    TRAINING_LEAD_MIN: 120, TRAINING_LAST_MIN: 30, MATCH_LEAD_MIN: 240, MATCH_LAST_MIN: 60,
    MATCH_NO_TIME_FROM: 9, MATCH_NO_TIME_UNTIL: 12, EVENING_BEFORE_HOUR: 20,
  });
});

test('a training reminder: two hours before, not in the last half hour, the evening before for an early one', () => {
  const kinds = (now, trainings) => dueFor(PLAYER, { trainings }, now).filter((d) => d.kind === 'training').map((d) => [d.training.id, d.date, d.time, d.evening]);
  const t = [training('t')];
  assert.deepEqual(kinds(at(WED, '15:20'), t), [], 'more than two hours ahead');
  assert.deepEqual(kinds(at(WED, '15:30'), t), [['t', WED, '17:30', false]]);
  assert.deepEqual(kinds(at(WED, '17:00'), t), [['t', WED, '17:30', false]], 'a late check still reminds');
  assert.deepEqual(kinds(at(WED, '17:01'), t), [], 'not in the last half hour');
  // a 09:00 training: 07:00 is in the night, so 20:00 the evening before
  const early = [training('e', { date: THU, time: '9:00' })];
  assert.deepEqual(kinds(at(WED, '19:50'), early), []);
  assert.deepEqual(kinds(at(WED, '20:00'), early), [['e', THU, '09:00', true]]);
  assert.deepEqual(kinds(at(THU, '08:00'), early), [['e', THU, '09:00', false]], 'missed in the evening: in the morning, if still in time');
  // a weekly training: its sessions, a cancelled one is skipped, a moved one counts at its new time
  const weekly = [training('w', { date: undefined, rule: { freq: 'weekly', byWeekday: [3, 4], start: '2026-11-01' }, exceptions: [{ date: WED, date2: WED, time: '18:30' }] })];
  assert.deepEqual(kinds(at(WED, '16:30'), weekly), [['w', WED, '18:30', false]]);
  assert.deepEqual(kinds(at(WED, '16:30'), [{ ...weekly[0], exceptions: [{ date: WED, cancelled: true }] }]), []);
  assert.deepEqual(kinds(at(WED, '15:30'), [training('x', { time: '' })]), [], 'a training without a time gets no reminder');
});

test('good luck: four hours before kickoff, not in the last hour; the evening before a morning game; an untimed game in the morning', () => {
  const wish = (now, matches) => dueFor(PLAYER, { matches }, now).filter((d) => d.kind === 'match').map((d) => [d.match.id, d.time, d.evening]);
  assert.deepEqual(wish(at(WED, '14:50'), [match('m')]), []);
  assert.deepEqual(wish(at(WED, '15:00'), [match('m')]), [['m', '19:00', false]]);
  assert.deepEqual(wish(at(WED, '18:01'), [match('m')]), [], 'not in the dressing room');
  assert.deepEqual(wish(at(WED, '20:00'), [match('am', { date: THU, time: '11:00' })]), [['am', '11:00', true]]);
  assert.deepEqual(wish(at(WED, '09:00'), [match('tbc', { time: '' })]), [['tbc', '', false]]);
  assert.deepEqual(wish(at(WED, '12:00'), [match('tbc', { time: '' })]), []);
  assert.deepEqual(wish(at(WED, '15:00'), [match('other', { linkedPlayers: ['p2'] }), match('gone', { deletedAt: 'x' })]), []);
});

test('the week: Saturday from 21:00, or Sunday morning if missed; never at night', () => {
  const week = (now) => dueFor(PLAYER, {}, now).filter((d) => d.kind === 'week').map((d) => d.weekStart);
  assert.deepEqual(week(at('2026-11-28', '20:59')), []);
  assert.deepEqual(week(at('2026-11-28', '21:00')), ['2026-11-29']);
  assert.deepEqual(week(at('2026-11-28', '22:00')), [], 'not from 22:00');
  assert.deepEqual(week(at('2026-11-29', '07:50')), [], 'not before 08:00');
  assert.deepEqual(week(at('2026-11-29', '08:00')), ['2026-11-29']);
  assert.deepEqual(week(at('2026-11-29', '12:00')), []);
  assert.deepEqual(week(at(WED, '21:00')), []);
});

test('nothing for a player whose access is off, who is not represented, has no number, or whose switch is off', () => {
  const ev = { trainings: [training('t')], matches: [match('m', { time: '17:00' })] };
  const now = at(WED, '15:30');
  assert.equal(dueFor(PLAYER, ev, now).length, 2);
  for (const p of [{ ...PLAYER, goldaAccess: false }, { ...PLAYER, stage: 'prospect' }, { ...PLAYER, goldaPhone: '' }, { ...PLAYER, deletedAt: 'x' },
    { ...PLAYER, goldaTrainingReminder: false, goldaMatchWish: false }, { ...PLAYER, goldaWeek: undefined, goldaTrainingReminder: undefined, goldaMatchWish: undefined }]) {
    assert.deepEqual(dueFor(p, ev, now), []);
  }
  assert.deepEqual(dueFor({ ...PLAYER, goldaMatchWish: false }, ev, now).map((d) => d.kind), ['training'], 'each switch is its own');
});

// A record full of things a player must never see.
const PRIVATE = {
  ...PLAYER, notes: 'SECRET-note', contractTerms: { salary: 'SECRET-salary', releaseClause: 'SECRET-clause' }, passportNumber: 'SECRET-passport',
  agentName: 'SECRET-agent', deals: ['SECRET-deal'], scouting: 'SECRET-scout', interest: 'SECRET-club-interest', email: 'SECRET@example.com',
};
const PRIVATE_EVENTS = {
  trainings: [training('t', { notes: 'SECRET-training-note', linkedPlayers: ['p1', 'p2'], exceptions: [{ date: WED, notes: 'SECRET-exception-note' }], createdBy: 'SECRET-creator' })],
  matches: [match('m', { notes: 'SECRET-match-note', watchedBy: 'SECRET-scout-watching', playerStats: { p2: { note: 'SECRET-other-player' } }, linkedPlayers: ['p1', 'p2'] })],
};

test('the texts: warm, short, Hebrew, his own schedule only', () => {
  const wk = buildWeek(PRIVATE, PRIVATE_EVENTS, '2026-11-22', WED);
  assert.equal(wk, [
    '*שבוע טוב, Noam* ⚽',
    'הלוח שלך לשבוע 25/11–28/11:',
    '',
    '*יום רביעי 25/11*',
    '• 17:30 אימון: אימון קבוצה · מגרש הדר',
    '• 19:00 משחק: הפועל חדרה – מכבי נתניה · אצטדיון חדרה',
    '',
    'שבוע מוצלח! אם משהו השתנה, כתוב לי ואעביר ללו.',
    'לא רוצה את ההודעות האלה? כתוב לי "די".',
  ].join('\n'));
  const tr = buildTraining(PRIVATE, { training: PRIVATE_EVENTS.trainings[0], date: WED, time: '17:30', evening: false });
  assert.equal(tr, '*Noam, תזכורת: אימון היום* ⏰\nצריך להיות שם ב-*17:30*\nאימון קבוצה\n📍 מגרש הדר\nשיהיה אימון טוב! 💪');
  const mt = buildMatch(PRIVATE, { match: PRIVATE_EVENTS.matches[0], date: WED, time: '19:00', evening: false });
  assert.equal(mt, '*בהצלחה היום, Noam!* ⚽🍀\nהפועל חדרה – מכבי נתניה · 19:00\n📍 אצטדיון חדרה\nתן הכל ותיהנה. מחזיקים לך אצבעות!');
  for (const text of [wk, tr, mt]) {
    assert.ok(!/SECRET|p2|Under Contract/.test(text), text);
  }
});

test('a woman player is written to in the feminine; the evening before says tomorrow', () => {
  const dana = { ...PLAYER, fullName: 'Dana Cohen', gender: 'Women' };
  assert.match(buildTraining(dana, { training: training('t', { ageGroup: 'noar', title: '' }), date: THU, time: '09:00', evening: true }), /^\*Dana, תזכורת: אימון מחר\* ⏰\nצריכה להיות שם ב-\*09:00\*\nנוער\n/);
  assert.match(buildMatch(dana, { match: match('m'), date: THU, time: '11:00', evening: true }), /^\*מחר משחק, Dana!\* ⚽\n.*\n.*\nתישני טוב, ומחר תני הכל/);
  assert.match(buildWeek(dana, { matches: [match('m')] }, '2026-11-22', WED), /כתבי לי ואעביר ללו\.\nלא רוצה את ההודעות האלה\? כתבי לי "די"\.$/);
  assert.equal(buildWeek(dana, {}, '2026-11-29'), null, 'an empty week is not a message');
});

// ── the run ─────────────────────────────────────────────────────────────────
const byId = (rows) => Object.fromEntries(rows.map(({ id, ...r }) => [id, r]));
function seed({ players = [PRIVATE], trainings = PRIVATE_EVENTS.trainings, matches = PRIVATE_EVENTS.matches, extra = {} } = {}) {
  return fakeDb({
    app_users: { lou: OWNER }, players: byId(players), trainings: byId(trainings), matches: byId(matches),
    deals: { d1: { playerId: 'p1', clubName: 'SECRET-club', stage: 'Offered to Club' } },
    ...extra,
  });
}
function sender() {
  const out = [];
  return { out, send: async (u, body, kind, buttons = []) => { out.push({ to: u.phone, role: u.role, body, kind, buttons }); return { state: 'sent' }; } };
}
const noJob = { note: () => {} };

test('the cron check reads nothing at night and is empty when nobody is switched on', async () => {
  let reads = 0;
  const db = seed();
  const spy = { collection: (c) => { reads++; return db.collection(c); } };
  assert.deepEqual(await dueNow(spy, at(WED, '23:00')), []);
  assert.equal(reads, 0);
  assert.deepEqual((await dueNow(seed(), at(WED, '15:30'))).map((d) => d.kind), ['training', 'match']);
  assert.deepEqual((await dueNow(seed(), at(WED, '14:00'))).map((d) => d.kind), []);
  assert.deepEqual(await dueNow(seed({ players: [{ ...PRIVATE, goldaWeek: false, goldaTrainingReminder: false, goldaMatchWish: false }] }), at(WED, '15:30')), []);
});

test('the run sends each message once, to the player only, and keeps it in his chat', async () => {
  const db = seed();
  const { out, send } = sender();
  assert.equal((await runPlayerSends(db, at(WED, '14:50'), { send, job: noJob })).sent, 0, 'nothing due yet');
  const r = await runPlayerSends(db, at(WED, '15:30'), { send, job: noJob });
  assert.deepEqual([r.sent, r.failed], [2, 0]);
  assert.deepEqual(out.map((m) => [m.to, m.role, m.kind]), [['972521234567', 'player', 'player-training'], ['972521234567', 'player', 'player-match']]);
  assert.match(out[0].body, /^\*Noam, תזכורת: אימון היום\* ⏰/);
  assert.match(out[0].body, /לא רוצה את ההודעות האלה\? כתוב לי "די"\.$/, 'the first message he ever gets says how to stop');
  assert.match(out[1].body, /^\*בהצלחה היום, Noam!\*/);
  assert.ok(!/לא רוצה את ההודעות/.test(out[1].body), 'only the first one carries the hint');
  assert.ok(!out.some((m) => /SECRET/.test(m.body)));
  const history = db.all('wa_sessions/972521234567/threads')[0].history;
  assert.deepEqual(history.map((h) => h.proactive), ['player-training', 'player-match']);
  // ten minutes later: not again
  assert.equal((await runPlayerSends(db, at(WED, '15:40'), { send, job: noJob })).sent, 0);
  assert.equal(out.length, 2);
  assert.deepEqual(Object.keys(db.read('app_meta', 'goldaPlayerSends').keys).sort(), ['match|p1|m|2026-11-25|', 'training|p1|t@2026-11-25|2026-11-25|17:30']);
});

test('a training moved or cancelled after the check is read again before it is sent; a moved one gets its own reminder', async () => {
  const db = seed();
  const { out, send } = sender();
  await runPlayerSends(db, at(WED, '15:30'), { send, job: noJob });
  assert.equal(out.length, 2);
  // moved to 18:30 after the reminder: a second one, marked as a change
  await db.collection('trainings').doc('t').set({ time: '18:30' }, { merge: true });
  await runPlayerSends(db, at(WED, '16:30'), { send, job: noJob });
  assert.equal(out.length, 3);
  assert.match(out[2].body, /^\*Noam, שינוי באימון היום\* 🔄\nצריך להיות שם ב-\*18:30\* \(25\/11\)/);

  // cancelled between the cron's check and the send: nothing goes
  const db2 = seed();
  const planned = await dueNow(db2, at(WED, '15:30'));
  assert.deepEqual(planned.map((d) => d.kind), ['training', 'match']);
  const realGet = db2.collection;
  let cancelled = false;
  const racing = { collection: (c) => {
    const col = realGet(c);
    if (c !== 'trainings' || cancelled) return col;
    return { ...col, doc: (id) => { const d = col.doc(id); return { ...d, get: async () => { cancelled = true; await col.doc(id).set({ exceptions: [{ date: WED, cancelled: true }] }, { merge: true }); return d.get(); } }; } };
  } };
  const s2 = sender();
  const r = await runPlayerSends(racing, at(WED, '15:30'), { send: s2.send, job: noJob });
  assert.deepEqual([r.sent, r.skipped], [1, 1]);
  assert.deepEqual(s2.out.map((m) => m.kind), ['player-match'], 'the cancelled training is not reminded');
});

test('a player whose number belongs to the team, or whose access was turned off, gets nothing', async () => {
  const staff = seed({ players: [{ ...PRIVATE, goldaPhone: '972500000001' }] });
  const a = sender();
  const r = await runPlayerSends(staff, at(WED, '15:30'), { send: a.send, job: noJob });
  assert.deepEqual([r.sent, a.out.length], [0, 0]);
  const off = seed({ players: [{ ...PRIVATE, goldaAccess: false }] });
  const b = sender();
  assert.equal((await runPlayerSends(off, at(WED, '15:30'), { send: b.send, job: noJob })).sent, 0);
  assert.equal(b.out.length, 0);
});

test('the week goes on Saturday evening with the coming week; an empty week is skipped, once', async () => {
  const sat = at('2026-11-28', '21:10');
  const db = seed({ trainings: [training('w', { date: undefined, rule: { freq: 'weekly', byWeekday: [0, 2], start: '2026-11-01' } })], matches: [match('m', { date: '2026-12-01', time: '20:00' })] });
  const { out, send } = sender();
  const r = await runPlayerSends(db, sat, { send, job: noJob });
  assert.equal(r.sent, 1);
  assert.equal(out[0].kind, 'player-week');
  assert.match(out[0].body, /^\*שבוע טוב, Noam\* ⚽\nהלוח שלך לשבוע 29\/11–5\/12:\n\n\*יום ראשון 29\/11\*\n• 17:30 אימון: אימון קבוצה · מגרש הדר\n\n\*יום שלישי 1\/12\*\n• 17:30 אימון/);
  assert.match(out[0].body, /• 20:00 משחק: הפועל חדרה – מכבי נתניה/);
  assert.equal((await runPlayerSends(db, at('2026-11-29', '09:00'), { send, job: noJob })).sent, 0, 'not again on Sunday morning');

  const empty = seed({ trainings: [], matches: [] });
  const e = sender();
  const notes = [];
  const r2 = await runPlayerSends(empty, sat, { send: e.send, job: { note: (s) => notes.push(s) } });
  assert.deepEqual([r2.sent, r2.skipped, e.out.length], [0, 1, 0]);
  assert.match(notes[0], /nothing this week/);
  assert.ok(db.read('app_meta', 'goldaPlayerSends').keys['week|p1|-|2026-11-29|']);
});

test('a failed send is not marked, so the next check tries again', async () => {
  const db = seed();
  let fail = true;
  const sent = [];
  const send = async (u, body) => { if (fail) throw new Error('WhatsApp API 500'); sent.push(body); return { state: 'sent' }; };
  const r = await runPlayerSends(db, at(WED, '15:30'), { send, job: noJob });
  assert.deepEqual([r.sent, r.failed], [0, 2]);
  assert.equal(db.read('app_meta', 'goldaPlayerSends'), undefined);
  fail = false;
  assert.equal((await runPlayerSends(db, at(WED, '15:40'), { send, job: noJob })).sent, 2);
});

// ── through the outbox ──────────────────────────────────────────────────────
function fakeApi() {
  const calls = [];
  let i = 0;
  return {
    calls,
    async sendText(to, body) { calls.push({ kind: 'text', to, body }); return [`wamid.t${++i}`]; },
    async sendTemplate(to, name, language, via, components = []) {
      calls.push({ kind: 'template', to, name, components });
      if (name !== 'hello_world') throw new Error('WhatsApp API 404: {"error":{"code":132001,"message":"Template name does not exist"}}');
      return `wamid.tpl${++i}`;
    },
  };
}

test('outside the window a player never gets a content-free template, and a reminder that waited past its training is dropped', async () => {
  const now = at(WED, '15:30').getTime();
  const db = fakeDb({ wa_contacts: { 972521234567: { lastInbound: now - 30 * 3600000 } } });
  const api = fakeApi();
  const body = buildTraining(PLAYER, { training: training('t'), date: WED, time: '17:30', evening: false });
  const r = await outbox.deliver(db, { to: '972521234567', body, kind: 'player-training', carryOnly: true, expiresAt: ps.expiryOf({ kind: 'training', date: WED, time: '17:30' }) }, { now, api, log: () => {} });
  assert.equal(r.state, 'queued');
  assert.equal(r.reengage.skipped, 'no template carries the text');
  assert.ok(!api.calls.some((c) => c.name === 'hello_world' || c.name === 'golda_update'), JSON.stringify(api.calls));
  // he writes the next day: the stale reminder is not sent
  const later = now + 20 * 3600000;
  const rel = await outbox.onInbound(db, '972521234567', null, { now: later, api, log: () => {} });
  assert.deepEqual(rel, { pending: 0, flushed: 0 });
  assert.equal(db.all('wa_outbox')[0].state, 'expired');
  // the owner's messages keep their fallbacks
  const db2 = fakeDb({ wa_contacts: { 972500000001: { lastInbound: now - 30 * 3600000 } } });
  const api2 = fakeApi();
  const o = await outbox.deliver(db2, { to: '972500000001', body: 'עדכון', kind: 'update' }, { now, api: api2, log: () => {} });
  assert.equal(o.reengage.template, 'hello_world');
});

test('with the templates approved, the reminder itself reaches him in the template', async () => {
  const now = at(WED, '15:30').getTime();
  const db = fakeDb({ wa_contacts: { 972521234567: { lastInbound: now - 30 * 3600000 } }, app_meta: { whatsapp: { templates: { golda_digest: { name: 'golda_digest', accounts: { 1: { status: 'APPROVED' } } } } } } });
  const calls = [];
  const api = { async sendTemplate(to, name, language, via, components) { calls.push({ name, components }); return 'wamid.x'; }, async sendText() { return ['wamid.y']; } };
  const body = buildTraining(PLAYER, { training: training('t'), date: WED, time: '17:30', evening: false });
  const r = await outbox.deliver(db, { to: '972521234567', body, kind: 'player-training', carryOnly: true, expiresAt: now + 3600000 }, { now, api, log: () => {} });
  assert.equal(r.reengage.template, 'golda_brief', 'a reminder has three lines to show');
  assert.deepEqual(calls[0].components[0].parameters.map((p) => p.text), ['Noam, תזכורת: אימון היום ⏰', 'צריך להיות שם ב-17:30', 'אימון קבוצה', '📍 מגרש הדר']);
  // a shorter one (no place, no title) fits the digest
  const short = buildMatch(PLAYER, { match: match('m', { stadiumName: '' }), date: WED, time: '19:00', evening: false });
  const db2 = fakeDb({ wa_contacts: { 972521234567: { lastInbound: now - 30 * 3600000 } } });
  calls.length = 0;
  const r2 = await outbox.deliver(db2, { to: '972521234567', body: short, kind: 'player-match', carryOnly: true }, { now, api, log: () => {} });
  assert.equal(r2.reengage.template, 'golda_digest');
  assert.deepEqual(calls[0].components[0].parameters.map((p) => p.text), ['בהצלחה היום, Noam! ⚽🍀', 'הפועל חדרה – מכבי נתניה · 19:00 · תן הכל ותיהנה. מחזיקים לך אצבעות!']);
});

// ── he stops it himself ─────────────────────────────────────────────────────
test('"די", "הפסיקי", "stop" and the like stop it; a sentence that only contains the word does not', () => {
  for (const t of ['די', 'די!', 'די כבר', 'הפסיקי', 'תפסיקי בבקשה', 'תפסיקי לשלוח לי', 'תפסיקי לשלוח לי תזכורות', 'עצרי', 'בלי הודעות', 'לא רוצה יותר הודעות', 'stop', 'STOP', 'Stop please', 'unsubscribe', ' די 🙏']) {
    assert.equal(isStopCommand(t), true, t);
  }
  for (const t of ['', 'די, מתי האימון מחר?', 'מתי המשחק?', 'תודה', 'הפסיקו לי את החוזה?', 'stop the contract talk with Maccabi']) {
    assert.equal(isStopCommand(t), false, t);
  }
});

test('stopping turns all three off, tells the admins through the player notes, and is audited', async () => {
  const db = seed();
  const identity = { playerId: 'p1', name: 'Noam Barzilai', phone: '972521234567', role: 'player' };
  const r = await stopForPlayer(db, admin, identity, at(WED, '15:30'));
  assert.deepEqual(r, { wasOn: true, kinds: ['week', 'training', 'match'] });
  const p = db.read('players', 'p1');
  assert.deepEqual([p.goldaWeek, p.goldaTrainingReminder, p.goldaMatchWish, p.goldaAccess], [false, false, false, true], 'he can still ask her');
  const notes = db.all('golda_player_notes');
  assert.equal(notes.length, 1);
  assert.equal(notes[0].delivered, false);
  assert.match(notes[0].summary, /ביקש שגולדה תפסיק לשלוח הודעות מעצמה \(לוח שבועי, תזכורות לאימון, איחולים לפני משחק\)/);
  assert.match(gp.buildPlayerNotesMessage('לו', notes), /\*Noam Barzilai:\* ביקש שגולדה תפסיק/);
  const audit = db.all('audit')[0];
  assert.deepEqual([audit.collection, audit.docId, audit.after], ['players', 'p1', { goldaWeek: false, goldaTrainingReminder: false, goldaMatchWish: false }]);
  assert.equal(stopConfirmation(identity), 'בסדר, Noam, הפסקתי לשלוח לך הודעות מעצמי. אפשר תמיד לכתוב לי ולשאול 🙂');
  // nothing on any more: a second "די" is left to the conversation
  assert.deepEqual(await stopForPlayer(db, admin, identity), { wasOn: false, kinds: [] });
  assert.equal((await runPlayerSends(db, at(WED, '15:30'), { send: sender().send, job: noJob })).sent, 0);
});

// ── the admin's tool and the prompts ────────────────────────────────────────
test('only an admin switches what Golda sends, only for a connected player, audited', async () => {
  const db = seed({ players: [{ ...PLAYER, goldaWeek: undefined, goldaTrainingReminder: undefined, goldaMatchWish: undefined }, { id: 'p2', fullName: 'Not Connected', stage: 'represented' }] });
  const lou = { email: 'lou.korek@gmail.com', name: 'לו קורק', phone: '972500000001' };
  const tool = playerMessagesTools({ db, admin, identity: lou, role: 'admin' }).player_messages;
  await assert.rejects(playerMessagesTools({ db, admin, identity: {}, role: 'manager' }).player_messages({ playerId: 'p1', action: 'on' }), /only an admin/);
  await assert.rejects(tool({ playerId: 'p2', action: 'on', kinds: ['week'] }), /not connected to Golda yet/);
  assert.deepEqual(await tool({ playerId: 'p1', action: 'status' }), { player: 'Noam Barzilai', connected: true, week: false, training: false, match: false });
  const on = await tool({ playerId: 'p1', action: 'on', kinds: ['week'] });
  assert.deepEqual([on.week, on.training, on.match], [true, false, false]);
  const off = await tool({ playerId: 'p1', action: 'off', kinds: ['training'] });
  assert.equal(off.unchanged, true);
  await tool({ playerId: 'p1', action: 'on', kinds: ['all'] });
  await tool({ playerId: 'p1', action: 'off', kinds: ['training'] });
  const p = db.read('players', 'p1');
  assert.deepEqual([p.goldaWeek, p.goldaTrainingReminder, p.goldaMatchWish], [true, false, true]);
  const audit = db.all('audit');
  assert.equal(audit.length, 3);
  assert.deepEqual([audit[0].before, audit[0].after, audit[0].via, audit[0].onBehalfOf], [{ goldaWeek: false }, { goldaWeek: true }, 'golda', 'lou.korek@gmail.com']);
  // off works for a player who is no longer connected (switching off is always allowed)
  await db.collection('players').doc('p1').set({ goldaAccess: false }, { merge: true });
  assert.equal((await tool({ playerId: 'p1', action: 'off' })).week, false);
});

test('the tool is for admins; no prompt says she never writes to a player first', () => {
  assert.ok(toolsFor('admin').some((t) => t.name === 'player_messages'));
  assert.ok(!toolsFor('manager').some((t) => t.name === 'player_messages'));
  const prompt = systemPrompt('גולדה', { name: 'לו', role: 'admin', email: 'lou.korek@gmail.com' });
  assert.ok(!/never write to him first/i.test(prompt));
  assert.match(prompt, /player_messages/);
  const view = { profile: { name: 'Noam Barzilai' }, schedule: [], today: WED, sends: { week: true, trainingReminder: false, matchWish: true } };
  const pp = gp.systemPrompt(view, 'Noam');
  assert.match(pp, /You write to him first only with what his agency switched on/);
  assert.match(pp, /"messagesFromGolda":\{"week":true,"trainingReminder":false,"matchWish":true\}/);
});
