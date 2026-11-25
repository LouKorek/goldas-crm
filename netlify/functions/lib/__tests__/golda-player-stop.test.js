// A connected player writes "די" on WhatsApp: the worker stops what Golda
// sends him on her own before any model call, answers in one line, and the
// admins hear about it; when nothing was on, the message goes to the model.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeDb, stubFirestore, OWNER } = require('./fake-firestore.js');

let db = null;
const admin = stubFirestore(() => db);
admin.firestore.FieldValue.increment = (n) => n;
admin.firestore.Timestamp = { fromMillis: (ms) => ms, now: () => Date.now() };

// WhatsApp, recorded instead of sent.
const sent = [];
const waPath = require.resolve('../wa-api.js');
require.cache[waPath] = { id: waPath, filename: waPath, loaded: true, exports: {
  markRead: async () => {}, sendText: async (to, body) => { sent.push({ to, body }); return ['wamid.1']; },
  sendButtons: async (to, body) => { sent.push({ to, body }); return ['wamid.2']; },
} };
// The player agent, recorded instead of calling the model.
const asked = [];
const gp = require('../golda-player.js');
gp.runPlayerAgent = async ({ text }) => { asked.push(text); return { reply: 'תשובה מהמודל', userText: text, usage: null, files: [], notes: [] }; };

const { processMessage } = require('../golda-worker.js');

const PLAYER = { fullName: 'Noam Barzilai', gender: 'Men', stage: 'represented', goldaAccess: true, goldaPhone: '0521234567', goldaWeek: true, goldaTrainingReminder: false, goldaMatchWish: true };
const inbound = (id, text) => ({ [id]: { from: '972521234567', text, type: 'text', channel: 'whatsapp', state: 'queued', attempts: 0 } });

test('"די" from a connected player stops all three, answers in one line, never reaches the model', async () => {
  db = fakeDb({ app_users: { lou: OWNER }, players: { p1: PLAYER }, wa_inbox: inbound('m1', 'די') });
  sent.length = 0; asked.length = 0;
  await processMessage('m1');
  assert.deepEqual(asked, []);
  assert.deepEqual(sent, [{ to: '972521234567', body: 'בסדר, Noam, הפסקתי לשלוח לך הודעות מעצמי. אפשר תמיד לכתוב לי ולשאול 🙂' }]);
  const p = db.read('players', 'p1');
  assert.deepEqual([p.goldaWeek, p.goldaTrainingReminder, p.goldaMatchWish, p.goldaAccess], [false, false, false, true]);
  const notes = db.all('golda_player_notes');
  assert.equal(notes.length, 1);
  assert.match(notes[0].summary, /\(לוח שבועי, איחולים לפני משחק\)/);
  assert.equal(db.read('wa_inbox', 'm1').state, 'done');
});

test('with nothing switched on, "די" is an ordinary message', async () => {
  db = fakeDb({ app_users: { lou: OWNER }, players: { p1: { ...PLAYER, goldaWeek: false, goldaMatchWish: false } }, wa_inbox: inbound('m2', 'די') });
  sent.length = 0; asked.length = 0;
  await processMessage('m2');
  assert.deepEqual(asked, ['די']);
  assert.equal(sent[0].body, 'תשובה מהמודל');
  assert.equal(db.all('golda_player_notes').length, 0);
});
