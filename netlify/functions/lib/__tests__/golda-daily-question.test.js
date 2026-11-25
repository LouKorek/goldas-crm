// One question a day: which gap comes first, that it never repeats itself,
// when it is asked, how it is switched off and on, and how the answer finds
// its way back through the normal agent.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeDb, stubFirestore, recorder, OWNER } = require('./fake-firestore.js');
const admin = stubFirestore();

const { GAPS, pickDataGap, questionFor, askDaily, dailyQuestionTools, FROM_HOUR, TO_HOUR, COOLDOWN_DAYS } = require('../golda-daily-question.js');
const { whatsappRecipients } = require('../golda-identity.js');
const { ownerOf } = require('../golda-nudge.js');
const { chooseEffort, TOP } = require('../golda-effort.js');
const { systemPrompt, toolsFor } = require('../wa-agent.js');

const TODAY = '2026-11-25';
const NOW = new Date('2026-11-25T12:30:00Z');   // 14:30 in Israel
const owner = ownerOf(whatsappRecipients([OWNER]));
const FULL = { fullName: 'Full Player', gender: 'Men', contractStatus: 'Under Contract', contractEnd: '2027-06-30', reprEnd: '2027-06-30', passportExpiry: '2030-01-01', dob: '2005-01-01', primaryPosition: 'CB', currentClub: 'Maccabi Haifa', foot: 'Right', nationalities: ['Israel'] };
const field = (players, state) => { const g = pickDataGap(players, state, TODAY); return g ? g.field : null; };

test('a contract with no end date comes long before a missing preferred foot', () => {
  const players = [{ ...FULL, id: 'a', fullName: 'Avi Foot', foot: '' }, { ...FULL, id: 'b', fullName: 'Ben Contract', contractEnd: '' }];
  const g = pickDataGap(players, {}, TODAY);
  assert.deepEqual([g.key, g.field, g.player.fullName], ['b|contractEnd', 'contractEnd', 'Ben Contract']);
  assert.ok(GAPS.find((x) => x.field === 'contractEnd').weight > GAPS.find((x) => x.field === 'foot').weight);
});

test('the whole order, one answer at a time', () => {
  let p = { id: 'p1', fullName: 'Dana Cohen', gender: 'Women', contractStatus: 'Under Contract' };
  const order = [];
  const answers = { contractEnd: '2027-06-30', reprEnd: '2027-06-30', passportExpiry: '2030-01-01', dob: '2004-03-01', primaryPosition: 'ST', currentClub: 'Maccabi Haifa', foot: 'Left', nationalities: ['Israel'] };
  for (let i = 0; i < 12; i++) { const f = field([p]); if (!f) break; order.push(f); p = { ...p, [f]: answers[f] }; }
  assert.deepEqual(order, ['contractEnd', 'reprEnd', 'passportExpiry', 'dob', 'primaryPosition', 'currentClub', 'foot', 'nationalities']);
  // with no contract status at all, that is asked first; a free agent is not asked for a club or a contract end
  assert.equal(field([{ id: 'p2', fullName: 'No Status' }]), 'contractStatus');
  const free = { ...FULL, id: 'p3', contractStatus: 'Free', contractEnd: '', currentClub: '' };
  assert.equal(field([free]), null);
  assert.equal(field([{ ...free, contractStatus: 'Trial' }]), 'currentClub');
});

test('nothing important is missing: the day is skipped; links and notes are never asked', () => {
  assert.equal(pickDataGap([{ ...FULL, id: 'a', videoLink: '', notes: '', league: '', passportNumber: '', profileLink: '' }], {}, TODAY), null);
  assert.equal(pickDataGap([{ ...FULL, id: 'a', foot: '', deletedAt: 'x' }], {}, TODAY), null);
  assert.equal(pickDataGap([], {}, TODAY), null);
});

test('never the same question twice in a row, and not again for two weeks', () => {
  const players = [{ ...FULL, id: 'a', fullName: 'Avi', contractEnd: '', foot: '' }, { ...FULL, id: 'b', fullName: 'Ben', contractEnd: '' }];
  assert.equal(pickDataGap(players, {}, TODAY).key, 'a|contractEnd');
  // asked yesterday and not answered: the next most important one, about someone else
  const yesterday = { lastKey: 'a|contractEnd', recent: [{ key: 'a|contractEnd', on: '2026-11-24' }] };
  assert.equal(pickDataGap(players, yesterday, TODAY).key, 'b|contractEnd');
  // both asked lately: down to the foot
  const both = { lastKey: 'b|contractEnd', recent: [{ key: 'a|contractEnd', on: '2026-11-24' }, { key: 'b|contractEnd', on: '2026-11-25' }] };
  assert.equal(pickDataGap(players, both, TODAY).key, 'a|foot');
  // two weeks on it may come back, unless it was the very last question
  assert.equal(COOLDOWN_DAYS, 14);
  assert.equal(pickDataGap(players, { lastKey: 'b|contractEnd', recent: [{ key: 'a|contractEnd', on: '2026-11-11' }, { key: 'b|contractEnd', on: '2026-11-12' }] }, TODAY).key, 'a|contractEnd');
  assert.equal(pickDataGap(players, { lastKey: 'a|contractEnd', recent: [{ key: 'a|contractEnd', on: '2026-11-11' }, { key: 'b|contractEnd', on: '2026-11-20' }] }, TODAY).key, 'a|foot');
  // the only thing missing was asked last: nothing today
  assert.equal(pickDataGap([{ ...FULL, id: 'a', foot: '' }], { lastKey: 'a|foot', recent: [] }, TODAY), null);
  // the same weight: by name
  assert.equal(pickDataGap([{ ...FULL, id: 'z', fullName: 'Ziv', foot: '' }, { ...FULL, id: 'y', fullName: 'Adam', foot: '' }], {}, TODAY).key, 'y|foot');
});

test('the question is in Hebrew, with buttons when the answer is one of a few words', () => {
  const dana = { ...FULL, id: 'p1', fullName: 'Dana Cohen', gender: 'Women' };
  const foot = questionFor('לו', { field: 'foot', player: dana });
  assert.deepEqual(foot.buttons, ['ימין', 'שמאל', 'שתיהן']);
  assert.equal(foot.text, '*שאלה יומית, לו* ❓\nמה הרגל החזקה של Dana Cohen?\n\nזה חסר בכרטיס: https://goldas-crm.netlify.app/players/p1\nלא ידוע כרגע? אפשר לענות "דלג".');
  assert.deepEqual(questionFor('לו', { field: 'contractStatus', player: dana }).buttons, ['בחוזה', 'חופשייה', 'מושאלת']);
  assert.deepEqual(questionFor('לו', { field: 'contractStatus', player: { ...dana, gender: 'Men' } }).buttons, ['בחוזה', 'חופשי', 'מושאל']);
  const end = questionFor('לו', { field: 'contractEnd', player: dana }, { firstEver: true });
  assert.deepEqual(end.buttons, []);
  assert.match(end.text, /עד מתי החוזה של Dana Cohen \(Maccabi Haifa\)\?\nאפשר לענות בתאריך, למשל 30\/06\/2027\./);
  assert.match(end.text, /מספיק לכתוב לי "בלי שאלה יומית"\.$/);
  assert.match(questionFor('לו', { field: 'primaryPosition', player: dana }).text, /באיזו עמדה Dana Cohen משחקת\?/);
  for (const g of GAPS) assert.ok(questionFor('לו', { field: g.field, player: dana }).text.includes('?'), g.field);
  for (const g of GAPS) for (const b of questionFor('לו', { field: g.field, player: dana }).buttons) assert.ok(b.length <= 20, `${b} fits a WhatsApp button`);
});

// ── asking ──────────────────────────────────────────────────────────────────
const PLAYERS = [{ ...FULL, id: 'a', fullName: 'Avi', contractEnd: '', foot: '' }, { ...FULL, id: 'b', fullName: 'Ben', foot: '' }];
const jobOf = () => { const notes = []; return { notes, note: (s) => notes.push(s) }; };
const ask = (db, send, { now = NOW, hour = 14, players = PLAYERS, job = jobOf() } = {}) => askDaily(db, owner, players, now, { hour, send, job });

test('asked once a day, in the afternoon only', async () => {
  assert.deepEqual([FROM_HOUR, TO_HOUR], [13, 19]);
  const db = fakeDb();
  const { out, send } = recorder();
  for (const hour of [7, 12, 20, 23]) assert.deepEqual(await ask(db, send, { hour }), { skipped: 'not the hour' });
  assert.equal(out.length, 0);
  assert.deepEqual(await ask(db, send, { hour: 13 }), { sent: 1, key: 'a|contractEnd' });
  assert.deepEqual([out[0].to, out[0].kind, out[0].buttons], ['lou.korek@gmail.com', 'question', []]);
  assert.match(out[0].body, /^\*שאלה יומית, לו\* ❓\nעד מתי החוזה של Avi/);
  const state = db.read('app_meta', 'goldaDailyQuestion');
  assert.deepEqual([state.lastKey, state.lastAskedOn, state.recent], ['a|contractEnd', TODAY, [{ key: 'a|contractEnd', on: TODAY }]]);
  // the question is in the chat as her turn, so "30/6/2027" has something to answer
  const history = db.all('wa_sessions/972500000001/threads')[0].history;
  assert.deepEqual([history[0].role, history[0].proactive], ['assistant', 'question']);
  // later the same day: nothing more
  for (const hour of [14, 19]) assert.deepEqual(await ask(db, send, { hour }), { skipped: 'asked today' });
  assert.equal(out.length, 1);
});

test('the next day brings another question, with its buttons, even when the first got no answer', async () => {
  const db = fakeDb();
  const { out, send } = recorder();
  await ask(db, send);
  const tomorrow = new Date(NOW.getTime() + 24 * 3600000);
  const r = await ask(db, send, { now: tomorrow });
  assert.deepEqual(r, { sent: 1, key: 'a|foot' });
  assert.deepEqual(out[1].buttons, ['ימין', 'שמאל', 'שתיהן']);
  assert.ok(!/בלי שאלה יומית/.test(out[1].body), 'how to stop is said once, with the first question');
  assert.deepEqual(db.read('app_meta', 'goldaDailyQuestion').recent.map((x) => x.key), ['a|contractEnd', 'a|foot']);
});

test('nothing important is missing: no message, and the day is not used up', async () => {
  const db = fakeDb();
  const { out, send } = recorder();
  assert.deepEqual(await ask(db, send, { players: [{ ...FULL, id: 'a' }] }), { skipped: 'nothing important is missing' });
  assert.equal(out.length, 0);
  assert.equal(db.read('app_meta', 'goldaDailyQuestion'), undefined);
});

test('not on top of a question of hers that he has not answered yet; an old one does not block', async () => {
  const thread = (at, text, buttons) => ({ 'wa_sessions/972500000001/threads': { main: { topic: 'main', history: [{ role: 'user', text: 'תעדכני את האתר' }, { role: 'assistant', text, at, ...(buttons ? { buttons } : {}) }] } } });
  const { out, send } = recorder();
  const hourAgo = NOW.getTime() - 3600000;
  assert.deepEqual(await ask(fakeDb(thread(hourAgo, 'הטיוטה מוכנה.', ['כן, לפרסם', 'לא'])), send), { skipped: 'waiting for an answer' });
  assert.deepEqual(await ask(fakeDb(thread(hourAgo, 'למחוק את דנה כהן?')), send), { skipped: 'waiting for an answer' });
  assert.equal(out.length, 0);
  assert.equal((await ask(fakeDb(thread(hourAgo, 'עודכן.')), send)).sent, 1, 'nothing is open');
  assert.equal((await ask(fakeDb(thread(NOW.getTime() - 5 * 3600000, 'למחוק את דנה כהן?')), send)).sent, 1, 'a question from the morning does not block the day');
});

test('a question that could not go out is not counted, so the next hour tries again', async () => {
  const db = fakeDb();
  await assert.rejects(ask(db, async () => { throw new Error('WhatsApp API 500'); }), /WhatsApp API 500/);
  assert.equal(db.read('app_meta', 'goldaDailyQuestion'), undefined);
  const { out, send } = recorder();
  assert.equal((await ask(db, send, { hour: 15 })).sent, 1);
  assert.equal(out.length, 1);
});

// ── off and on ──────────────────────────────────────────────────────────────
test('Lou turns it off and on by telling her; only an admin can', async () => {
  const db = fakeDb();
  const { out, send } = recorder();
  await ask(db, send);
  const tools = (role = 'admin') => dailyQuestionTools({ db, admin, identity: { ...owner, role }, role });
  assert.deepEqual(await tools().daily_question({ action: 'status' }), { on: true, lastAskedOn: TODAY });
  const off = await tools().daily_question({ action: 'off' });
  assert.equal(off.on, false);
  const state = db.read('app_meta', 'goldaDailyQuestion');
  assert.deepEqual([state.enabled, state.lastKey, state.changedBy], [false, 'a|contractEnd', 'lou.korek@gmail.com'], 'what was asked is not forgotten');
  // it is recorded like every change made through her
  const audit = db.all('audit');
  assert.equal(audit.length, 1);
  assert.deepEqual([audit[0].collection, audit[0].docId, audit[0].summary, audit[0].via, audit[0].actor, audit[0].onBehalfOf, 'before' in audit[0]],
    ['settings', 'goldaDailyQuestion', 'daily question: off', 'golda', 'golda', 'lou.korek@gmail.com', false]);
  // while it is off nothing is asked, day after day
  const tomorrow = new Date(NOW.getTime() + 24 * 3600000);
  assert.deepEqual(await ask(db, send, { now: tomorrow }), { skipped: 'off' });
  assert.deepEqual(await tools().daily_question({ action: 'off' }), { on: false, unchanged: true });
  assert.equal(db.all('audit').length, 1);
  // back on: the next question is not the one asked last
  assert.equal((await tools().daily_question({ action: 'on' })).on, true);
  assert.deepEqual(await ask(db, send, { now: tomorrow }), { sent: 1, key: 'a|foot' });
  assert.equal(out.length, 2);
  // asking does not switch it back off or on
  assert.equal(db.read('app_meta', 'goldaDailyQuestion').enabled, true);
  await assert.rejects(tools('manager').daily_question({ action: 'off' }), /only an admin/);
  await assert.rejects(tools().daily_question({ action: 'maybe' }), /on, off or status/);
});

test('the agent knows the question and its switch; the answer is thought about at the top level', () => {
  const names = (role) => toolsFor(role).map((t) => t.name);
  assert.ok(names('admin').includes('daily_question'));
  for (const role of ['manager', 'agent', 'viewer']) assert.ok(!names(role).includes('daily_question'), role);
  const p = systemPrompt('גולדה', { name: 'לו', role: 'admin', email: 'lou.korek@gmail.com' });
  assert.match(p, /Your daily question \(your message that opens with "שאלה יומית" ❓\)/);
  assert.match(p, /save the answer with update/);
  assert.match(p, /daily_question action=off/);
  // "ימין" after the question is an answer to save, not small talk
  const q = questionFor('לו', { field: 'foot', player: { ...FULL, id: 'p1' } });
  const history = [{ role: 'assistant', text: q.text, buttons: q.buttons, proactive: 'question' }];
  assert.equal(chooseEffort({ text: 'ימין', history }).effort, TOP);
  assert.equal(chooseEffort({ text: '30/6/2027', history: [{ role: 'assistant', text: questionFor('לו', { field: 'contractEnd', player: { ...FULL, id: 'p1' } }).text }] }).effort, TOP);
});
