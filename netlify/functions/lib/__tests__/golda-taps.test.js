// A tap on a button, tied back to the card that carried it: the message a
// tap answers (context.id), the outbox row that remembers what the card was
// about, and the worker asking the card's feature before the model.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeDb, stubFirestore, OWNER } = require('./fake-firestore.js');

let db = null;
const admin = stubFirestore(() => db);
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
const { extractMessages } = realWa;
// The player agent, recorded instead of calling the model.
const asked = [];
const gp = require('../golda-player.js');
gp.runPlayerAgent = async ({ text }) => { asked.push(text); return { reply: 'תשובה מהמודל', userText: text, usage: null, files: [], notes: [] }; };

const outbox = require('../wa-outbox.js');
const taps = require('../golda-taps.js');
const { nudge } = require('../golda-nudge.js');
const { processMessage } = require('../golda-worker.js');

const H = 3600000;
const PHONE = '972521234567';
const quiet = { log: () => {} };
const webhook = (message) => ({ entry: [{ changes: [{ value: { metadata: { phone_number_id: 'p1' }, messages: [message] } }] }] });
const fakeApi = () => {
  let i = 0;
  const calls = [];
  return {
    calls,
    sendText: async (to, body) => { calls.push({ kind: 'text', to, body }); return [`wamid.t${++i}`]; },
    sendButtons: async (to, body, buttons) => { calls.push({ kind: 'buttons', to, body, buttons }); return [`wamid.b${++i}`]; },
    sendTemplate: async (to, name) => { calls.push({ kind: 'template', to, name }); return `wamid.tpl${++i}`; },
  };
};
const reset = () => { taps._internal.handlers.clear(); sent.length = 0; asked.length = 0; };

// --- the inbound message -------------------------------------------------------
test('a tap names the message it answers; a message that answers nothing has no context', () => {
  const [tap] = extractMessages(webhook({ id: 'wamid.in1', from: PHONE, type: 'interactive', timestamp: '1', context: { from: '972550000000', id: 'wamid.card1' },
    interactive: { type: 'button_reply', button_reply: { id: 'b1', title: 'לא עכשיו' } } }));
  assert.deepEqual([tap.contextId, tap.payload, tap.text, tap.type], ['wamid.card1', 'b1', 'לא עכשיו', 'interactive']);
  const [template] = extractMessages(webhook({ id: 'wamid.in2', from: PHONE, type: 'button', timestamp: '1', context: { id: 'wamid.tpl9' }, button: { payload: 'כן', text: 'כן' } }));
  assert.equal(template.contextId, 'wamid.tpl9');
  const [swiped] = extractMessages(webhook({ id: 'wamid.in3', from: PHONE, type: 'text', timestamp: '1', context: { from: '972550000000', id: 'wamid.card1' }, text: { body: 'מה זה?' } }));
  assert.deepEqual([swiped.contextId, swiped.payload], ['wamid.card1', null]);
  const [plain] = extractMessages(webhook({ id: 'wamid.in4', from: PHONE, type: 'text', timestamp: '1', text: { body: 'שלום' } }));
  assert.equal(plain.contextId, null);
  assert.ok('contextId' in plain, 'always there, so the stored message has the same fields');
  // A forwarded message has a context without an id.
  const [forwarded] = extractMessages(webhook({ id: 'wamid.in5', from: PHONE, type: 'text', timestamp: '1', context: { forwarded: true }, text: { body: 'תראי' } }));
  assert.deepEqual([forwarded.contextId, forwarded.forwarded], [null, true]);
});

// --- the outbox row ------------------------------------------------------------
test('a message sent with a ref keeps it on its outbox row, with the WhatsApp id the send returned', async () => {
  const now = Date.now();
  const store = fakeDb({ wa_contacts: { [PHONE]: { lastInbound: now - H } } });
  const api = fakeApi();
  const r = await outbox.deliver(store, { to: PHONE, body: 'לפרסם את הטיוטה?', kind: 'site', buttons: ['כן, לפרסם', 'לא'], ref: { type: 'site_draft', id: 'd42' } }, { now, api, ...quiet });
  assert.deepEqual(r, { state: 'sent', ids: ['wamid.b1'] });
  const row = store.read('wa_outbox', 'wamid.b1');
  assert.deepEqual(row.ref, { type: 'site_draft', id: 'd42' });
  assert.equal(row.messageId, 'wamid.b1');
  assert.deepEqual([row.to, row.state, row.kind, row.buttons], [PHONE, 'sent', 'site', ['כן, לפרסם', 'לא']]);

  // Without a ref nothing is added, and half a ref is not a ref.
  await outbox.deliver(store, { to: PHONE, body: 'בוקר טוב', kind: 'briefing' }, { now, api, ...quiet });
  assert.ok(!('ref' in store.read('wa_outbox', 'wamid.t2')));
  assert.equal(store.read('wa_outbox', 'wamid.t2').messageId, 'wamid.t2');
  await outbox.deliver(store, { to: PHONE, body: 'משהו', buttons: ['כן'], ref: { type: 'site_draft' } }, { now, api, ...quiet });
  assert.ok(!('ref' in store.read('wa_outbox', 'wamid.b3')));
});

test('a message that waited for the window keeps its ref, and is found by the id it finally went out with', async () => {
  const now = Date.now();
  const store = fakeDb({ wa_contacts: { [PHONE]: { lastInbound: now - 30 * H } } });
  const api = fakeApi();
  const r = await outbox.deliver(store, { to: PHONE, body: 'לפרסם את הטיוטה?', kind: 'site', buttons: ['כן, לפרסם', 'לא'], ref: { type: 'site_draft', id: 'd42' } }, { now, api, ...quiet });
  assert.equal(r.state, 'queued');
  assert.deepEqual(store.read('wa_outbox', r.id).ref, { type: 'site_draft', id: 'd42' });
  assert.equal(await taps.resolveTap(store, { contextId: r.id, payload: 'b0' }) && true, true, 'the row is there under its own id');
  // The person writes: the window opens and the message goes out under a new WhatsApp id.
  await outbox.onInbound(store, PHONE, null, { now: now + 60000, api, release: true, ...quiet });
  const row = store.read('wa_outbox', r.id);
  assert.equal(row.state, 'sent');
  assert.equal(row.messageIds.length, 1);
  assert.deepEqual(row.ref, { type: 'site_draft', id: 'd42' });
  assert.deepEqual(await taps.resolveTap(store, { contextId: row.messageIds[0], payload: 'b1', title: 'לא' }), { ref: { type: 'site_draft', id: 'd42' }, button: 1 });
});

test('an own-initiative message carries its ref to the outbox', async () => {
  const now = Date.now();
  const store = fakeDb({ wa_contacts: { 972500000001: { lastInbound: now - H } } });
  const seen = [];
  const real = outbox.deliver;
  outbox.deliver = async (d, message, opts) => { seen.push(message); return { state: 'sent', ids: ['wamid.n1'] }; };
  try {
    await nudge(store, { ...OWNER, phone: OWNER.whatsapp }, { body: 'מי שיחק אתמול?', buttons: ['כולם', 'אף אחד'], kind: 'match', ref: { type: 'match_question', id: 'm7' } }, { now });
  } finally { outbox.deliver = real; }
  assert.deepEqual(seen[0].ref, { type: 'match_question', id: 'm7' });
  // The hourly run's injected sender gets it as its fifth argument.
  const got = [];
  await nudge(store, { ...OWNER, phone: OWNER.whatsapp }, { body: 'שאלה', kind: 'daily', ref: { type: 'daily', id: 'q1' } }, { now, send: async (...args) => { got.push(args); return { state: 'sent' }; } });
  assert.deepEqual(got[0][4], { type: 'daily', id: 'q1' });
});

// --- which card, which button ----------------------------------------------------
const CARD = { to: PHONE, body: 'לפרסם את הטיוטה?', kind: 'site', buttons: ['כן, לפרסם', 'לא', 'תזכירי לי מחר בבוקר בבקשה'], ref: { type: 'site_draft', id: 'd42' }, messageId: 'wamid.card1', state: 'sent' };
const cards = () => fakeDb({ wa_outbox: {
  'wamid.card1': CARD,
  'wamid.card2': { ...CARD, ref: { type: 'site_draft', id: 'd43' }, messageId: 'wamid.card2' },
  'wamid.plain': { to: PHONE, body: 'בוקר טוב', kind: 'briefing', buttons: ['כן', 'לא'], messageId: 'wamid.plain', state: 'sent' },
} });

test('the same word under two cards resolves to two different cards', async () => {
  const store = cards();
  assert.deepEqual(await taps.resolveTap(store, { contextId: 'wamid.card1', payload: 'b1', title: 'לא' }), { ref: { type: 'site_draft', id: 'd42' }, button: 1 });
  assert.deepEqual(await taps.resolveTap(store, { contextId: 'wamid.card2', payload: 'b1', title: 'לא' }), { ref: { type: 'site_draft', id: 'd43' }, button: 1 });
});

test('the button is found by the id it was sent with, and by its title when there is no id', async () => {
  const store = cards();
  assert.equal((await taps.resolveTap(store, { contextId: 'wamid.card1', payload: 'b0', title: 'משהו אחר' })).button, 0, 'the id wins');
  assert.equal((await taps.resolveTap(store, { contextId: 'wamid.card1', title: 'לא' })).button, 1);
  assert.equal((await taps.resolveTap(store, { contextId: 'wamid.card1', payload: 'כן, לפרסם', title: 'כן, לפרסם' })).button, 0, 'a payload that is not b0–b2 falls back to the title');
  // A title longer than WhatsApp shows comes back cut the way it was sent.
  const shown = realWa.buttonTitles(CARD.buttons)[2];
  assert.ok(shown.length <= realWa.BUTTON_TITLE_MAX && shown !== CARD.buttons[2]);
  assert.equal((await taps.resolveTap(store, { contextId: 'wamid.card1', title: shown })).button, 2);
  assert.equal((await taps.resolveTap(store, { contextId: 'wamid.card1', title: CARD.buttons[2] })).button, 2);
});

test('nothing resolves when the message answers nothing we sent with a ref, or is not one of its buttons', async () => {
  const store = cards();
  assert.equal(await taps.resolveTap(store, { contextId: 'wamid.plain', payload: 'b0', title: 'כן' }), null, 'a row without a ref');
  assert.equal(await taps.resolveTap(store, { contextId: 'wamid.unknown', payload: 'b0', title: 'כן' }), null, 'not in the outbox');
  assert.equal(await taps.resolveTap(store, { contextId: '', payload: 'b0' }), null);
  assert.equal(await taps.resolveTap(store, { payload: 'b0' }), null);
  assert.equal(await taps.resolveTap(store), null);
  assert.equal(await taps.resolveTap(store, { contextId: 'wamid.card1', title: 'מה זה אומר?' }), null, 'a typed reply to the card');
  assert.equal(await taps.resolveTap(store, { contextId: 'wamid.card1', payload: 'b7', title: '' }), null, 'a button the card never had');
});

// --- the registry ----------------------------------------------------------------
test('a registered handler answers its own cards; the rest go on to the model', async () => {
  reset();
  const store = cards();
  const tap = { from: PHONE, text: 'לא', payload: 'b1', contextId: 'wamid.card1' };
  assert.deepEqual(await taps.handleTap(store, tap, {}), { handled: false }, 'nothing registered');
  const seen = [];
  taps.onTap('site_draft', async (a) => { seen.push(a); return { handled: true, reply: `  נשאר טיוטה: ${a.ref.id}  ` }; });
  assert.deepEqual(await taps.handleTap(store, tap, { first: 'לו' }), { handled: true, reply: 'נשאר טיוטה: d42' });
  assert.deepEqual([seen[0].ref, seen[0].button, seen[0].title, seen[0].ctx, seen[0].msg, seen[0].row.id], [{ type: 'site_draft', id: 'd42' }, 1, 'לא', { first: 'לו' }, tap, 'wamid.card1']);
  assert.equal(seen[0].db, store);
  // Not handled: no context, a card of another type, a row without a ref, a typed reply, another person's card.
  assert.deepEqual(await taps.handleTap(store, { ...tap, contextId: null }, {}), { handled: false });
  assert.deepEqual(await taps.handleTap(store, null, {}), { handled: false });
  assert.deepEqual(await taps.handleTap(store, { ...tap, contextId: 'wamid.plain' }, {}), { handled: false });
  assert.deepEqual(await taps.handleTap(store, { ...tap, payload: null, text: 'רגע, מה כתוב שם?' }, {}), { handled: false });
  assert.deepEqual(await taps.handleTap(store, { ...tap, from: '972500000009' }, {}), { handled: false }, 'a card belongs to the person it was sent to');
  const other = fakeDb({ wa_outbox: { 'wamid.card9': { ...CARD, ref: { type: 'match_question', id: 'm1' } } } });
  assert.deepEqual(await taps.handleTap(other, { ...tap, contextId: 'wamid.card9' }, {}), { handled: false }, 'no handler for that type');
  assert.equal(seen.length, 1);
});

test('what a handler may answer: a reply, nothing to say, a bare string, or "not mine"; a handler that throws loses nothing', async () => {
  reset();
  const store = cards();
  const tap = { from: PHONE, text: 'כן, לפרסם', payload: 'b0', contextId: 'wamid.card1' };
  taps.onTap('site_draft', async () => ({ handled: true }));
  assert.deepEqual(await taps.handleTap(store, tap), { handled: true });
  taps.onTap('site_draft', async () => ({ handled: true, reply: '   ' }));
  assert.deepEqual(await taps.handleTap(store, tap), { handled: true }, 'an empty reply is no reply');
  taps.onTap('site_draft', () => 'פורסם');
  assert.deepEqual(await taps.handleTap(store, tap), { handled: true, reply: 'פורסם' }, 'the last registration wins');
  taps.onTap('site_draft', async () => ({ handled: false, reply: 'לא אמור לצאת' }));
  assert.deepEqual(await taps.handleTap(store, tap), { handled: false });
  taps.onTap('site_draft', async () => null);
  assert.deepEqual(await taps.handleTap(store, tap), { handled: false });
  const err = console.error; console.error = () => {};
  try {
    taps.onTap('site_draft', async () => { throw new Error('boom'); });
    assert.deepEqual(await taps.handleTap(store, tap), { handled: false });
    const broken = { collection: () => { throw new Error('firestore is down'); } };
    assert.deepEqual(await taps.handleTap(broken, tap), { handled: false });
  } finally { console.error = err; }
  assert.throws(() => taps.onTap('', () => {}), TypeError);
  assert.throws(() => taps.onTap('site_draft', 'not a function'), TypeError);
});

// --- the worker --------------------------------------------------------------------
const PLAYER = { fullName: 'Noam Barzilai', gender: 'Men', stage: 'represented', goldaAccess: true, goldaPhone: '0521234567', goldaWeek: false, goldaTrainingReminder: false, goldaMatchWish: false };
const inboxRow = (extra) => ({ from: PHONE, type: 'interactive', channel: 'whatsapp', state: 'queued', attempts: 0, ...extra });
const world = (inbox) => fakeDb({ app_users: { lou: OWNER }, players: { p1: PLAYER }, wa_outbox: { 'wamid.card1': { ...CARD, buttons: ['כן', 'לא'], ref: { type: 'week_plan', id: 'w1' } }, 'wamid.plain': { to: PHONE, body: 'שאלה', buttons: ['כן', 'לא'], state: 'sent' } }, wa_inbox: inbox });

test('the worker sends a handled tap\'s reply and never calls the model', async () => {
  reset();
  const got = [];
  taps.onTap('week_plan', async ({ ref, button, title, ctx }) => { got.push({ ref, button, title, first: ctx.first, admin: ctx.admin }); return { handled: true, reply: `רשמתי: ${title}` }; });
  db = world({ m1: inboxRow({ text: 'כן', payload: 'b0', contextId: 'wamid.card1' }) });
  await processMessage('m1');
  assert.deepEqual(asked, [], 'no model call');
  assert.deepEqual(sent.map((s) => [s.to, s.body]), [[PHONE, 'רשמתי: כן']]);
  assert.deepEqual(got.map((g) => [g.ref, g.button, g.title]), [[{ type: 'week_plan', id: 'w1' }, 0, 'כן']]);
  const row = db.read('wa_inbox', 'm1');
  assert.deepEqual([row.state, row.tapped], ['done', true]);
});

test('a handled tap with nothing to say sends nothing, and still calls no model', async () => {
  reset();
  taps.onTap('week_plan', async () => ({ handled: true }));
  db = world({ m1: inboxRow({ text: 'לא', payload: 'b1', contextId: 'wamid.card1' }) });
  await processMessage('m1');
  assert.deepEqual(asked, []);
  assert.deepEqual(sent, []);
  assert.deepEqual([db.read('wa_inbox', 'm1').state, db.read('wa_inbox', 'm1').tapped], ['done', true]);
});

test('without a handler, without a ref, or when the handler passes, the message reaches the model exactly as before', async () => {
  // No handler registered at all.
  reset();
  db = world({ m1: inboxRow({ text: 'כן', payload: 'b0', contextId: 'wamid.card1' }) });
  await processMessage('m1');
  assert.deepEqual(asked, ['כן']);
  assert.equal(sent[0].body, 'תשובה מהמודל');
  assert.ok(!db.read('wa_inbox', 'm1').tapped);

  // A handler for this type, but the tapped message carried no ref (one of Golda's ordinary replies).
  reset();
  let called = 0;
  taps.onTap('week_plan', async () => { called++; return { handled: false }; });
  db = world({ m2: inboxRow({ text: 'כן', payload: 'b0', contextId: 'wamid.plain' }) });
  await processMessage('m2');
  assert.deepEqual([asked, called], [['כן'], 0]);

  // The handler looks and says it is not for it.
  reset();
  taps.onTap('week_plan', async () => { called++; return { handled: false }; });
  db = world({ m3: inboxRow({ text: 'לא', payload: 'b1', contextId: 'wamid.card1' }) });
  await processMessage('m3');
  assert.deepEqual([asked, called], [['לא'], 1]);
  assert.equal(sent[0].body, 'תשובה מהמודל');

  // A message with no context never asks the registry.
  reset();
  taps.onTap('week_plan', async () => { called++; return { handled: true, reply: 'לא אמור לצאת' }; });
  db = world({ m4: { from: PHONE, text: 'מה יש לי השבוע?', type: 'text', channel: 'whatsapp', state: 'queued', attempts: 0 } });
  await processMessage('m4');
  assert.deepEqual([asked, called], [['מה יש לי השבוע?'], 1]);
  reset();
});

test('this module registers nothing by itself', () => {
  delete require.cache[require.resolve('../golda-taps.js')];
  assert.equal(require('../golda-taps.js')._internal.handlers.size, 0);
});
