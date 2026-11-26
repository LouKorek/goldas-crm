// What Golda's own-initiative messages share: only the owner gets them, they go
// through the outbox (with their reply buttons, also when they had to wait),
// and a question she asks is kept in the chat so the answer makes sense.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeDb, stubFirestore, OWNER, MANAGER } = require('./fake-firestore.js');
stubFirestore();

const outbox = require('../wa-outbox.js');
const { whatsappRecipients } = require('../golda-identity.js');
const { ownerOf, noteInChat, nudge, chatOf } = require('../golda-nudge.js');

const H = 3600000;
const quiet = { log: () => {} };
function fakeApi() {
  const calls = [];
  let i = 0;
  return {
    calls,
    async sendText(to, body, via) { calls.push({ kind: 'text', to, body, via }); return [`wamid.t${++i}`]; },
    async sendButtons(to, body, buttons, via) { calls.push({ kind: 'buttons', to, body, buttons, via }); return [`wamid.b${++i}`]; },
    async sendTemplate(to, name) { calls.push({ kind: 'template', to, name }); return `wamid.tpl${++i}`; },
  };
}

test('only the owner is written to: an admin with the owner address and a WhatsApp number', () => {
  const owner = ownerOf(whatsappRecipients([MANAGER, OWNER]));
  assert.equal(owner.email, 'lou.korek@gmail.com');
  assert.equal(owner.phone, '972500000001');
  assert.equal(ownerOf(whatsappRecipients([MANAGER])), null, 'a manager is never the owner');
  assert.equal(ownerOf(whatsappRecipients([{ ...MANAGER, role: 'admin' }])), null, 'another admin is not the owner either');
  assert.equal(ownerOf(whatsappRecipients([{ ...OWNER, channels: [] }])), null, 'no WhatsApp, no messages');
  assert.equal(ownerOf([]), null);
});

test('inside the window a message with buttons is sent with them', async () => {
  const now = Date.now();
  const db = fakeDb({ wa_contacts: { 972500000001: { lastInbound: now - H } } });
  const api = fakeApi();
  const r = await outbox.deliver(db, { to: '972500000001', body: 'לפרסם?', kind: 'website', buttons: ['כן, לפרסם', 'לא', '', 'ד', 'ה'] }, { now, api, ...quiet });
  assert.equal(r.state, 'sent');
  assert.deepEqual(api.calls, [{ kind: 'buttons', to: '972500000001', body: 'לפרסם?', buttons: ['כן, לפרסם', 'לא', 'ד'], via: null }]);
  assert.deepEqual(db.read('wa_outbox', 'wamid.b1').buttons, ['כן, לפרסם', 'לא', 'ד']);
  // without buttons it is the plain text it always was
  await outbox.deliver(db, { to: '972500000001', body: 'תדריך', kind: 'meeting' }, { now, api, ...quiet });
  assert.equal(api.calls[1].kind, 'text');
  assert.equal('buttons' in db.read('wa_outbox', 'wamid.t2'), false);
});

test('outside the window the message waits with its buttons and goes out with them when he writes', async () => {
  const now = Date.now();
  const db = fakeDb({ wa_contacts: { 972500000001: { lastInbound: now - 30 * H } } });
  const api = fakeApi();
  const r = await outbox.deliver(db, { to: '972500000001', body: 'מה הרגל החזקה של דנה?', kind: 'question', buttons: ['ימין', 'שמאל', 'שתיהן'] }, { now, api, ...quiet });
  assert.equal(r.state, 'queued');
  assert.ok(api.calls.every((c) => c.kind === 'template'), 'only a template may go out now');
  const row = db.all('wa_outbox')[0];
  assert.deepEqual([row.state, row.buttons], ['queued', ['ימין', 'שמאל', 'שתיהן']]);
  const flushed = await outbox.onInbound(db, '972500000001', 'p1', { now: now + H, api, release: true, ...quiet });
  assert.equal(flushed.flushed, 1);
  assert.deepEqual(api.calls.at(-1), { kind: 'buttons', to: '972500000001', body: 'מה הרגל החזקה של דנה?', buttons: ['ימין', 'שמאל', 'שתיהן'], via: 'p1' });
});

test('a question she asks is written into the chat of the topic he is in, as her turn', async () => {
  const owner = ownerOf(whatsappRecipients([OWNER]));
  const db = fakeDb({
    wa_sessions: { 972500000001: { turn: 7 } },
    'wa_sessions/972500000001/threads': { main: { topic: 'main', history: [{ role: 'user', text: 'תודה' }, { role: 'assistant', text: 'בשמחה' }] } },
  });
  const chat = await chatOf(db, owner);
  assert.equal(chat.turn, 7);
  await noteInChat(db, owner, { text: 'לפרסם?', buttons: ['כן, לפרסם', 'לא'], kind: 'website', now: 5000 });
  const { history } = db.read('wa_sessions/972500000001/threads', chat.threadRef.id);
  assert.equal(history.length, 3);
  assert.deepEqual(history[2], { role: 'assistant', text: 'לפרסם?', at: 5000, proactive: 'website', buttons: ['כן, לפרסם', 'לא'] });
});

test('nudge sends through the given sender; only a remembered message enters the chat, and a failed note never loses the message', async () => {
  const owner = ownerOf(whatsappRecipients([OWNER]));
  const db = fakeDb();
  const sent = [];
  const send = async (u, body, kind, buttons) => { sent.push({ to: u.email, body, kind, buttons }); return { state: 'queued' }; };
  const notes = [];
  const job = { note: (s) => notes.push(s) };
  await nudge(db, owner, { body: 'תדריך לפגישה', kind: 'meeting' }, { now: 1, send, job });
  assert.equal(db.all('wa_sessions/972500000001/threads').length, 0, 'a brief is not a turn of the conversation');
  await nudge(db, owner, { body: 'שאלה?', buttons: ['כן'], kind: 'question', remember: true }, { now: 2, send, job });
  assert.equal(db.all('wa_sessions/972500000001/threads')[0].history[0].text, 'שאלה?');
  assert.deepEqual(sent.map((s) => [s.kind, s.buttons]), [['meeting', []], ['question', ['כן']]]);
  assert.equal(notes[0], 'meeting: window closed, queued');
  for (const n of notes) assert.ok(!n.includes(owner.email) && !n.includes(owner.phone), 'a job note holds states only, never the address or the number');
  // the chat cannot be written: the message still went out
  const broken = { collection: () => { throw new Error('offline'); } };
  const r = await nudge(broken, owner, { body: 'שאלה?', kind: 'question', remember: true }, { now: 3, send, job });
  assert.equal(r.state, 'queued');
  assert.equal(notes.at(-1), 'question: chat note failed (Error)', 'the error\'s own text is not kept');
});
