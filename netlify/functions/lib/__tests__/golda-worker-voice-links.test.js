// Delivery of a reply with a voice note and with "open in WhatsApp" buttons:
// the voice note first, then the text, the open button, and the "did it go
// out?" buttons last. A refused voice note or button never fails the reply.
const test = require('node:test');
const assert = require('node:assert/strict');

const fsPath = require.resolve('../firestore.js');
require.cache[fsPath] = { id: fsPath, filename: fsPath, loaded: true, exports: { admin: { firestore: { FieldValue: {} } }, getDb: () => null } };
const sent = [];
let refuse = new Set();
const real = require('../wa-api.js');
const waPath = require.resolve('../wa-api.js');
require.cache[waPath] = { id: waPath, filename: waPath, loaded: true, exports: {
  ...real,
  sendText: async (to, text) => { sent.push(['text', text]); return ['wamid.T']; },
  sendButtons: async (to, text, buttons) => { sent.push(['buttons', text, buttons]); return ['wamid.B']; },
  sendList: async () => ['wamid.L'],
  sendDocument: async (to, f) => { sent.push(['doc', f.filename]); return ['wamid.D']; },
  sendVoice: async () => { if (refuse.has('voice')) throw new Error('WhatsApp API 400'); sent.push(['voice']); return ['wamid.V']; },
  sendCtaUrl: async (to, l) => { if (refuse.has('cta')) throw new Error('WhatsApp API 400'); sent.push(['cta', l.label, l.url]); return ['wamid.C']; },
} };
const { deliver } = require('../golda-worker.js');
const { VOICE_UNAVAILABLE } = require('../golda-voice.js');

const MSG = { channel: 'whatsapp', from: '972500000001' };
const LINK = { url: 'https://wa.me/972501234567?text=hi', label: 'פתיחה בוואטסאפ', body: 'ההודעה למשה מוכנה.' };
const REPLY = 'הנה הטיוטה למשה:\n\nאהלן משה, יש לי בלם בשבילך\n\nשלחת?';

test('a draft: the text, then the open button, then the question with its buttons', async () => {
  sent.length = 0; refuse = new Set();
  const ids = await deliver(MSG, REPLY, { buttons: ['נשלח', 'לא נשלח'], links: [LINK] });
  assert.deepEqual(sent, [
    ['text', 'הנה הטיוטה למשה:\n\nאהלן משה, יש לי בלם בשבילך'],
    ['cta', 'פתיחה בוואטסאפ', LINK.url],
    ['buttons', 'שלחת?', ['נשלח', 'לא נשלח']],
  ]);
  assert.deepEqual(ids, ['wamid.T', 'wamid.C', 'wamid.B']);
});

test('a refused open button goes as the plain link', async () => {
  sent.length = 0; refuse = new Set(['cta']);
  await deliver(MSG, 'טיוטה', { links: [LINK] });
  assert.deepEqual(sent, [['text', 'טיוטה'], ['text', `${LINK.body}\n${LINK.url}`]]);
});

test('a voice answer goes before the text; a refused one adds one line and the text still goes', async () => {
  sent.length = 0; refuse = new Set();
  await deliver(MSG, 'התשובה', { voice: { buffer: Buffer.from('OggS'), mimeType: 'audio/ogg' } });
  assert.deepEqual(sent, [['voice'], ['text', 'התשובה']]);
  sent.length = 0; refuse = new Set(['voice']);
  await deliver(MSG, 'התשובה', { voice: { buffer: Buffer.from('OggS'), mimeType: 'audio/ogg' } });
  assert.deepEqual(sent, [['text', `התשובה\n\n${VOICE_UNAVAILABLE}`]]);
});

test('in the app nothing is sent: no voice, no buttons', async () => {
  sent.length = 0; refuse = new Set();
  assert.deepEqual(await deliver({ channel: 'app' }, 'x', { links: [LINK], voice: { buffer: Buffer.from('x') } }), []);
  assert.deepEqual(sent, []);
});
