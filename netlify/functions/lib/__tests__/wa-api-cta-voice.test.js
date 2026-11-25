// The two new WhatsApp messages: a link as a real button (cta_url) and a voice
// note (audio uploaded, then sent; the voice flag dropped if refused).
const test = require('node:test');
const assert = require('node:assert/strict');

const fsPath = require.resolve('../firestore.js');
require.cache[fsPath] = { id: fsPath, filename: fsPath, loaded: true, exports: { admin: {}, getDb: () => { throw new Error('no db in tests'); } } };
process.env.WA_PHONE_ID = '111';
const wa = require('../wa-api.js');

const calls = [];
let refuseVoiceFlag = false;
global.fetch = async (url, opts = {}) => {
  const body = typeof opts.body === 'string' ? JSON.parse(opts.body) : null;
  calls.push({ url, body });
  if (String(url).endsWith('/media')) return { ok: true, json: async () => ({ id: 'MEDIA1' }) };
  if (refuseVoiceFlag && body && body.audio && body.audio.voice) return { ok: false, status: 400, text: async () => 'unknown field voice' };
  return { ok: true, json: async () => ({ messages: [{ id: 'wamid.X' }] }) };
};

test('sendCtaUrl: one button that opens the URL, label clipped to 20 characters', async () => {
  calls.length = 0;
  const ids = await wa.sendCtaUrl('+972 50-000-0001', { body: 'ההודעה מוכנה.', label: 'פתיחה בוואטסאפ', url: 'https://wa.me/972501234567?text=hi', footer: 'גולדה' });
  assert.deepEqual(ids, ['wamid.X']);
  const b = calls[0].body;
  assert.equal(b.to, '972500000001');
  assert.equal(b.type, 'interactive');
  assert.equal(b.interactive.type, 'cta_url');
  assert.deepEqual(b.interactive.action, { name: 'cta_url', parameters: { display_text: 'פתיחה בוואטסאפ', url: 'https://wa.me/972501234567?text=hi' } });
  assert.equal(b.interactive.footer.text, 'גולדה');
});

test('sendVoice: uploads the OGG, sends it as a voice note; without the flag when the API refuses it', async () => {
  calls.length = 0; refuseVoiceFlag = false;
  assert.deepEqual(await wa.sendVoice('972500000001', { buffer: Buffer.from('OggS'), mimeType: 'audio/ogg' }), ['wamid.X']);
  assert.match(calls[0].url, /\/111\/media$/);
  assert.deepEqual(calls[1].body.audio, { id: 'MEDIA1', voice: true });
  calls.length = 0; refuseVoiceFlag = true;
  assert.deepEqual(await wa.sendVoice('972500000001', { buffer: Buffer.from('OggS') }), ['wamid.X']);
  assert.deepEqual(calls[calls.length - 1].body.audio, { id: 'MEDIA1' });
});
