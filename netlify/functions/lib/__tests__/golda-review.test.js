// Golda's nightly self-review: a rule is proposed for a 👎 answer, the owner
// sees at most one a day as a card, and ONLY a rule he approved reaches her prompt.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
process.env.FIREBASE_SERVICE_ACCOUNT_KEY = '{}';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.SCRAPER_API_KEY;
const { fakeDb, stubFirestore, OWNER, MANAGER } = require('./fake-firestore.js');
const { fakeSite } = require('./fake-site.js');

let DB;
stubFirestore(() => DB);
const taps = require('../golda-taps.js');
// The worker is what answers a tap: loading it must be enough for the card's buttons to work.
require('../golda-worker.js');
const registeredByWorker = taps._internal.handlers.has('proposal');
const review = require('../golda-review.js');
const { systemPrompt, toolsFor, createTools } = require('../wa-agent.js');
const { run } = require(path.join(__dirname, '..', '..', 'golda-briefing.js'))._internal;

const TODAY = '2026-11-25';
const at = (israelHHMM, day = TODAY) => new Date(`${day}T${String(Number(israelHHMM.slice(0, 2)) - 2).padStart(2, '0')}:${israelHHMM.slice(3)}:00Z`);   // Israel is UTC+2 in November
const NIGHT = at('02:30');
const hoursBefore = (n, from = NIGHT) => new Date(from.getTime() - n * 3600000);

const QUESTION = 'מתי המשחק הבא של דנה כהן מול הפועל חדרה ביום שבת הקרוב';
const REPLY = 'דנה כהן היא שחקנית מצוינת שמשחקת בעמדת הקשר. המשחק שלה מול הפועל חדרה יהיה ביום שבת בשעה 19:00 באצטדיון העירוני.';
const RULE = 'כששואלים מתי, לפתוח בתאריך ובשעה ורק אחר כך להוסיף הסבר';
const GOOD = JSON.stringify({ diagnosis: 'התשובה פתחה בתיאור ורק בסוף נתנה את המועד', proposedRule: RULE });
const USAGE = { input_tokens: 1000, output_tokens: 100 };

/** A model that answers with the next scripted text and keeps every request it got. */
function scripted(replies) {
  const seen = [];
  const client = { beta: { messages: { stream: (req) => { seen.push(req); const text = replies.length ? replies.shift() : GOOD; return { finalMessage: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: USAGE }) }; } } } };
  return { client, seen };
}
const jobOf = () => { const notes = []; return { notes, job: { note: (s) => notes.push(s) } }; };
const bad = (hoursAgo, extra = {}) => ({ rating: -1, question: QUESTION, reply: REPLY, at: hoursBefore(hoursAgo), by: 'lou.korek@gmail.com', ...extra });
const proposal = (state, extra = {}) => ({ feedbackId: 'x', diagnosis: 'אבחנה', proposedRule: RULE, state, createdAt: NIGHT.getTime(), ...extra });

test('a proposal is one clean general rule in Hebrew, or it is nothing', () => {
  const fb = { question: QUESTION, reply: REPLY };
  assert.deepEqual(review.cleanProposal(GOOD, fb), { proposedRule: RULE, diagnosis: 'התשובה פתחה בתיאור ורק בסוף נתנה את המועד' });
  assert.equal(review.cleanProposal(`הנה: ${GOOD} זהו`, fb).proposedRule, RULE, 'text around the JSON is ignored');
  const rule = (proposedRule, diagnosis = '') => review.cleanProposal(JSON.stringify({ diagnosis, proposedRule }), fb);
  assert.equal(rule(''), null, 'nothing to learn');
  assert.equal(rule('קצר'), null, 'too short to be a rule');
  assert.equal(rule('כלל '.repeat(60)), null, 'too long');
  assert.equal(rule('Always open with the date and the hour'), null, 'not Hebrew');
  assert.equal(rule('לשלוח את התשובה גם אל dana@example.com בכל פעם'), null, 'an address');
  assert.equal(rule('לבדוק קודם באתר https://example.com ורק אז לענות'), null, 'a link');
  assert.equal(rule('להתקשר למספר 0501234567 לפני שעונים על שאלה'), null, 'a phone number');
  assert.equal(rule('כששואלים על המשחק הבא של דנה כהן לענות קצר'), null, 'words copied from the question');
  assert.equal(rule('לא לכתוב שמישהי היא שחקנית מצוינת שמשחקת בעמדת הקשר'), null, 'words copied from the answer');
  assert.equal(review.cleanProposal('לא JSON', fb), null);
  assert.equal(review.cleanProposal('{not json}', fb), null);
  // The diagnosis is about the answer: one that repeats the question is blanked, and the rule stays.
  assert.deepEqual(rule(RULE, 'שאלו מתי המשחק הבא של דנה כהן ולא ענו'), { proposedRule: RULE, diagnosis: '' });
  assert.equal(rule('כששואלים מתי — לפתוח בתאריך ובשעה').proposedRule, 'כששואלים מתי, לפתוח בתאריך ובשעה', 'no em-dash reaches the owner');
});

test('the night reads the last day\'s 👎 that have no proposal, one model call each, and writes proposals only', async () => {
  DB = fakeDb({
    golda_feedback: {
      f1: bad(3), old: bad(30), liked: { ...bad(2), rating: 1 }, done: bad(5), empty: bad(4, { reply: '' }),
      f2: bad(6, { question: 'כמה שחקנים יש לנו', reply: 'יש לנו הרבה שחקנים טובים ומוכשרים מאוד בכל העמדות.' }),
    },
    golda_prompt_proposals: { done: proposal('rejected') },
  });
  const NOTHING = JSON.stringify({ diagnosis: 'לא ענתה במספר', proposedRule: '' });
  const { client, seen } = scripted([NOTHING, GOOD, NOTHING]);
  const { notes, job } = jobOf();
  const r = await review.runSelfReview(DB, NIGHT, { client, job });
  assert.deepEqual(r, { read: 2, proposed: 1, dropped: 1, failed: 0 });
  assert.equal(seen.length, 2, 'one call per answer, and none for the old, the liked, the empty and the one already proposed');
  // Oldest first; the model sees that one question and that one answer, and nothing else.
  assert.deepEqual(JSON.parse(seen[1].messages[0].content), { question: QUESTION, answer: REPLY });
  assert.equal(seen[0].messages.length, 1);
  assert.equal(seen[0].model, 'claude-opus-5-5');
  assert.deepEqual(seen[0].output_config, { effort: 'medium' });
  assert.equal(seen[0].tools, undefined, 'the review has no tools');
  assert.deepEqual(DB.read('golda_prompt_proposals', 'f1'), { feedbackId: 'f1', diagnosis: 'התשובה פתחה בתיאור ורק בסוף נתנה את המועד', proposedRule: RULE, state: 'proposed', createdAt: NIGHT.getTime() });
  assert.equal(DB.read('golda_prompt_proposals', 'f2'), undefined, 'no clean rule, no proposal');
  assert.deepEqual(DB.all('golda_prompt_proposals').map((p) => p.id).sort(), ['done', 'f1']);
  // Counted in the day's ledger under its own kind.
  assert.equal(DB.all('golda_cost')[0].byKind.review.calls, 2);
  // The job's notes are counts: not a word of the conversation, not the rule.
  assert.deepEqual(notes, ['self-review: 2 answer(s) read, 1 proposal(s), 1 dropped (no clean rule)']);
  // Nothing was sent and nothing else was written.
  assert.deepEqual([...DB.data.keys()].filter((k) => DB.data.get(k).size).sort(), ['golda_cost', 'golda_feedback', 'golda_prompt_proposals']);
  // Run again by hand the same night: the answer that has its proposal is not read a second time.
  const again = await review.runSelfReview(DB, NIGHT, { client, job });
  assert.deepEqual([again.read, again.proposed], [1, 0]);
  assert.equal(seen.length, 3);
});

test('a proposal that carries the conversation is dropped, and a failed call costs nothing else', async () => {
  DB = fakeDb({ golda_feedback: { f1: bad(3), f2: bad(2, { question: 'שאלה אחרת לגמרי על משהו', reply: 'תשובה ארוכה מדי על משהו אחר לגמרי.' }) } });
  const leaking = JSON.stringify({ diagnosis: 'ארוך', proposedRule: 'כששואלים על המשחק הבא של דנה כהן לענות קצר' });
  const client = { beta: { messages: { stream: (req) => ({ finalMessage: async () => {
    if (JSON.parse(req.messages[0].content).question === QUESTION) return { content: [{ type: 'text', text: leaking }], usage: USAGE };
    throw new Error('the model did not answer');
  } }) } } };
  const { notes, job } = jobOf();
  const r = await review.runSelfReview(DB, NIGHT, { client, job });
  assert.deepEqual(r, { read: 2, proposed: 0, dropped: 1, failed: 1 });
  assert.deepEqual(DB.all('golda_prompt_proposals'), []);
  assert.ok(!notes.join(' ').includes('דנה'), 'the note names nobody');
});

test('at the day\'s cost ceiling the review does not start, and no model is called', async () => {
  DB = fakeDb({ golda_feedback: { f1: bad(3) }, app_meta: { goldaCost: { capUsd: 0 } } });
  const { client, seen } = scripted([]);
  const { notes, job } = jobOf();
  assert.deepEqual(await review.runSelfReview(DB, NIGHT, { client, job }), { skipped: 'cost ceiling' });
  assert.equal(seen.length, 0);
  assert.deepEqual(DB.all('golda_prompt_proposals'), []);
  assert.match(notes[0], /cost ceiling/);
});

test('the review runs once a night, in the small hours only', async () => {
  DB = fakeDb({ golda_feedback: { f1: bad(3) } });
  const { client, seen } = scripted([]);
  const opts = (hour) => ({ hour, today: TODAY, client, job: jobOf().job });
  assert.deepEqual(await review.reviewNightly(DB, at('14:30'), opts(14)), { skipped: 'not the hour' });
  assert.deepEqual(await review.reviewNightly(DB, at('01:30'), opts(1)), { skipped: 'not the hour' });
  assert.equal(seen.length, 0);
  assert.equal((await review.reviewNightly(DB, NIGHT, opts(2))).proposed, 1);
  assert.equal(DB.read('app_meta', 'goldaReview').reviewedOn, TODAY);
  DB.data.get('golda_feedback').set('f9', bad(1));
  assert.deepEqual(await review.reviewNightly(DB, at('03:30'), opts(3)), { skipped: 'reviewed tonight' });
  assert.equal(seen.length, 1, 'the next hour of the same night does not review again');
});

test('the owner gets at most one proposal a day, as a card with two buttons that point at the proposal', async () => {
  DB = fakeDb({ golda_prompt_proposals: {
    newer: proposal('proposed', { createdAt: 200, proposedRule: 'לענות קודם על מה שנשאל ורק אז להרחיב' }),
    older: proposal('proposed', { createdAt: 100 }),
    no: proposal('rejected', { createdAt: 50 }),
  } });
  const out = [];
  const send = async (u, body, kind, buttons, ref) => { out.push({ to: u.email, body, kind, buttons, ref }); return { state: 'sent' }; };
  const owner = { ...OWNER, phone: OWNER.whatsapp };
  assert.deepEqual(await review.offerProposal(DB, owner, at('08:30'), { hour: 8, send }), { skipped: 'not the hour' });
  assert.deepEqual(await review.offerProposal(DB, owner, at('21:30'), { hour: 21, send }), { skipped: 'not the hour' });
  const { notes, job } = jobOf();
  assert.deepEqual(await review.offerProposal(DB, owner, at('10:30'), { hour: 10, send, job }), { sent: 1, id: 'older' });
  assert.equal(out.length, 1);
  assert.deepEqual([out[0].to, out[0].kind, out[0].buttons, out[0].ref], ['lou.korek@gmail.com', 'proposal', ['לאשר', 'לדחות'], { type: 'proposal', id: 'older' }]);
  assert.match(out[0].body, /^\*הצעה לשיפור שלי, לו\* 🧭/);
  assert.ok(out[0].body.includes(`"${RULE}"`) && out[0].body.includes('רק אם תאשר'));
  assert.ok(!/[—–]/.test(out[0].body), 'no em-dash in what he reads');
  assert.equal(DB.read('golda_prompt_proposals', 'older').offeredAt, at('10:30').getTime());
  assert.equal(DB.read('golda_prompt_proposals', 'older').state, 'proposed', 'showing it approves nothing');
  // It is in the chat's history, so a typed answer has the question in front of her.
  const history = DB.all(`wa_sessions/${OWNER.whatsapp}/threads`)[0].history;
  assert.equal(history[history.length - 1].proactive, 'proposal');
  assert.ok(!notes.join(' ').includes(RULE), 'the job note does not carry the rule');
  // Not again the same day; the next one waits for tomorrow.
  assert.deepEqual(await review.offerProposal(DB, owner, at('15:30'), { hour: 15, send }), { skipped: 'offered today' });
  assert.equal(out.length, 1);
  assert.deepEqual(await review.offerProposal(DB, owner, at('10:30', '2026-11-26'), { hour: 10, send }), { sent: 1, id: 'newer' });
  assert.deepEqual(await review.offerProposal(DB, owner, at('10:30', '2026-11-27'), { hour: 10, send }), { skipped: 'nothing to offer' });
});

test('a tap on the card approves or rejects with no model call; only the owner\'s own tap counts', async () => {
  assert.ok(registeredByWorker, 'loading the worker registers the proposal card');
  const rows = (ids) => Object.fromEntries(ids.map((id) => [`wamid.${id}`, { to: OWNER.whatsapp, buttons: review.BUTTONS, ref: { type: 'proposal', id } }]));
  DB = fakeDb({
    golda_prompt_proposals: { a: proposal('proposed', { offeredAt: 1 }), b: proposal('proposed', { offeredAt: 1 }), c: proposal('proposed', { offeredAt: 1 }), unseen: proposal('proposed') },
    wa_outbox: { ...rows(['a', 'b', 'c', 'unseen', 'gone']), 'wamid.dani': { to: MANAGER.whatsapp, buttons: review.BUTTONS, ref: { type: 'proposal', id: 'c' } } },
  });
  const ctx = { identity: { ...OWNER }, first: 'לו', admin: true, now: 777 };
  const tap = (id, n, who = OWNER, c = ctx) => taps.handleTap(DB, { contextId: `wamid.${id}`, payload: `b${n}`, text: review.BUTTONS[n], from: who.whatsapp }, c);

  const yes = await tap('a', 0);
  assert.deepEqual(yes, { handled: true, reply: `מעכשיו אני עובדת לפי הכלל הזה:\n"${RULE}"` });
  assert.deepEqual([DB.read('golda_prompt_proposals', 'a').state, DB.read('golda_prompt_proposals', 'a').decidedBy, DB.read('golda_prompt_proposals', 'a').decidedAt], ['approved', 'lou.korek@gmail.com', 777]);
  assert.deepEqual(await tap('b', 1), { handled: true, reply: 'בסדר, לא מוסיפה את הכלל הזה.' });
  assert.equal(DB.read('golda_prompt_proposals', 'b').state, 'rejected');
  // A second tap changes nothing and says so.
  assert.deepEqual(await tap('a', 1), { handled: true, reply: 'ההצעה הזאת כבר אושרה.' });
  assert.equal(DB.read('golda_prompt_proposals', 'a').state, 'approved');
  assert.deepEqual(await tap('gone', 0), { handled: true, reply: 'ההצעה הזאת כבר לא קיימת.' });
  // A manager's tap, even on a card sent to him, decides nothing: the message goes on to the model.
  assert.deepEqual(await tap('dani', 0, MANAGER, { identity: { ...MANAGER }, now: 778 }), { handled: false });
  // Someone else answering the owner's card is not the owner.
  assert.deepEqual(await tap('c', 0, MANAGER, ctx), { handled: false });
  assert.equal(DB.read('golda_prompt_proposals', 'c').state, 'proposed');
  // The card itself is the proof he saw it: a tap counts even when the mark of the offer was not written.
  assert.equal((await tap('unseen', 0)).handled, true);
  assert.equal(DB.read('golda_prompt_proposals', 'unseen').state, 'approved');
});

test('only approved rules reach the prompt: the ten newest, next to the 👎 cases', async () => {
  const many = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`ok${i}`, proposal('approved', { proposedRule: `כלל מאושר מספר ${i} לדרך התשובה`, decidedAt: 1000 + i })]));
  DB = fakeDb({ golda_prompt_proposals: { ...many, waiting: proposal('proposed', { proposedRule: 'כלל שעוד מחכה לאישור של הבעלים', offeredAt: 5 }), no: proposal('rejected', { proposedRule: 'כלל שנדחה ולא צריך להופיע' }) } });
  const rules = await review.approvedRules(DB);
  assert.equal(rules.length, 10);
  assert.equal(rules[0], 'כלל מאושר מספר 11 לדרך התשובה', 'newest first');
  assert.ok(!rules.includes('כלל מאושר מספר 0 לדרך התשובה') && !rules.includes('כלל מאושר מספר 1 לדרך התשובה'), 'the two oldest are left out');
  assert.ok(!rules.some((r) => /מחכה|נדחה/.test(r)), 'a proposed or a rejected rule is never one of them');
  // A database that cannot be read means no rules, never a failed answer.
  assert.deepEqual(await review.approvedRules({ collection: () => { throw new Error('down'); } }), []);

  const identity = { name: 'לו קורק', role: 'admin', email: 'lou.korek@gmail.com' };
  const mistakes = [{ question: 'שאלה', reply: 'תשובה' }];
  const withRules = systemPrompt('גולדה', identity, null, [], 'whatsapp', [], mistakes, rules);
  const without = systemPrompt('גולדה', identity, null, [], 'whatsapp', [], mistakes);
  assert.ok(withRules.includes('Rules Lou approved after answers of yours were marked 👎'));
  for (const r of rules) assert.ok(withRules.includes(`- ${r}`));
  assert.ok(!withRules.includes('מחכה לאישור') && !withRules.includes('כלל שנדחה'));
  assert.ok(!without.includes('Rules Lou approved'), 'no rules, no section');
  assert.equal(withRules.replace(`\n${review.rulesSection(rules)}`, ''), without, 'the rules are added at the end and change nothing else');
  assert.equal(review.rulesSection([]), '');
});

test('prompt_rules is the admin\'s: a typed answer to the card, the list, and taking a rule out', async () => {
  DB = fakeDb({ golda_prompt_proposals: { shown: proposal('proposed', { offeredAt: 5 }), unseen: proposal('proposed'), live: proposal('approved', { decidedAt: 9 }) } });
  assert.ok(toolsFor('admin').some((t) => t.name === 'prompt_rules'));
  for (const role of ['manager', 'viewer']) assert.ok(!toolsFor(role).some((t) => t.name === 'prompt_rules'), role);
  const admin = { firestore: { FieldValue: {} } };
  const as = (u) => createTools({ db: DB, admin, identity: { name: u.name, role: u.role, email: u.email }, session: {}, assistantName: 'גולדה' });
  await assert.rejects(as(MANAGER).run('prompt_rules', { action: 'list' }), /only an admin/);
  await assert.rejects(as(MANAGER).run('prompt_rules', { action: 'approve', id: 'shown' }), /only an admin/);
  assert.equal(DB.read('golda_prompt_proposals', 'shown').state, 'proposed');

  const lou = as(OWNER);
  const list = await lou.run('prompt_rules', { action: 'list' });
  assert.deepEqual(list.waiting.map((p) => [p.id, p.shown]).sort(), [['shown', true], ['unseen', false]]);
  assert.deepEqual(list.approved.map((p) => p.id), ['live']);
  await assert.rejects(lou.run('prompt_rules', { action: 'approve', id: 'unseen' }), /not shown to the owner yet/);
  assert.equal(DB.read('golda_prompt_proposals', 'unseen').state, 'proposed', 'she cannot approve a rule he never saw');
  assert.deepEqual(await lou.run('prompt_rules', { action: 'approve', id: 'shown' }), { state: 'approved', rule: RULE });
  assert.deepEqual(await lou.run('prompt_rules', { action: 'retire', id: 'live' }), { retired: true, rule: RULE });
  assert.equal(DB.read('golda_prompt_proposals', 'live').state, 'rejected');
  assert.deepEqual(await review.approvedRules(DB), [RULE]);
  await assert.rejects(lou.run('prompt_rules', { action: 'retire', id: 'unseen' }), /no approved rule/);
  await assert.rejects(lou.run('prompt_rules', { action: 'approve' }), /pass the id/);
});

// --- through the hourly run -------------------------------------------------------
const approvedTemplates = { templates: { golda_digest: { accounts: { 1: { status: 'APPROVED' } } }, golda_update: { accounts: { 1: { status: 'APPROVED' } } } } };
const PLAYER = { fullName: 'Gavin Karam', gender: 'Men', currentClub: 'Hapoel Kfar Saba', contractStatus: 'Under Contract', contractEnd: '2028-06-30', reprEnd: '2028-06-30', passportExpiry: '2031-01-01',
  primaryPosition: 'CDM', secondaryPositions: ['CM'], dob: '2007-05-01', foot: 'Right', nationalities: ['Israel'] };
const write = Object.assign(async ({ fallbackText }) => ({ text: fallbackText, ai: false, reason: 'test' }), { recap: async ({ fallbackText }) => ({ text: fallbackText, ai: false, reason: 'test' }) });
async function hour(when) {
  const out = [], notes = [];
  const send = async (u, body, kind, buttons = [], ref = null) => { out.push({ to: u.email, kind, body, buttons, ref }); return { state: 'sent' }; };
  const r = await run({ note: (s) => notes.push(s) }, at(when), { send, write, site: fakeSite() });
  return { out, notes, r };
}

test('in the hourly run: reviewed at night with nothing sent, offered in the day to the owner only, once', async () => {
  DB = fakeDb({
    app_users: { lou: OWNER, dani: MANAGER }, players: { p1: PLAYER },
    backups: { b1: { status: 'ok', verified: true, startedAt: at('03:30').getTime() } },
    app_meta: { whatsapp: approvedTemplates, goldaSent: { briefings: { 'lou.korek@gmail.com': TODAY, 'dani@x.com': TODAY }, eventsAt: at('01:30').getTime() } },
    golda_feedback: { f1: bad(3) },
    golda_prompt_proposals: { ready: proposal('proposed', { createdAt: 1 }) },
  });
  // 02:30: the review's step runs (here there is no model, and the note says so); nothing goes out.
  const night = await hour('02:30');
  assert.deepEqual(night.out, []);
  assert.ok(night.notes.includes('self-review skipped: no model here'));
  assert.equal(DB.read('app_meta', 'goldaReview').reviewedOn, TODAY);
  // The day: one card, to the owner, and never a second one.
  const sentInDay = [];
  for (const h of ['09:30', '10:30', '11:30', '14:30', '15:30', '16:30']) sentInDay.push(...(await hour(h)).out);
  const cards = sentInDay.filter((m) => m.kind === 'proposal');
  assert.equal(cards.length, 1);
  assert.deepEqual([cards[0].to, cards[0].buttons, cards[0].ref], ['lou.korek@gmail.com', ['לאשר', 'לדחות'], { type: 'proposal', id: 'ready' }]);
  assert.ok(!sentInDay.some((m) => m.to === 'dani@x.com' && m.kind === 'proposal'), 'a manager never gets it');
  assert.equal(DB.read('golda_prompt_proposals', 'ready').state, 'proposed');
});
