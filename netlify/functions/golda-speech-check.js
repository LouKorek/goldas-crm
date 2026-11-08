// Is voice-note transcription working? The Golda screen calls this right after
// the admin switched Speech-to-Text on from their own browser (one Google
// popup), and whenever they press "check again". It sends Google one second of
// silence: "no words heard" proves the service answers, which is all we need.
// The result is kept in app_meta/whatsapp.speech, where the screen reads it.
//
// POST → 200 { state, message }
const { getDb } = require('./lib/firestore.js');
const { withAuth, json } = require('./lib/auth.js');
const speech = require('./lib/golda-speech.js');

/** One second of 16 kHz mono silence as a WAV file. */
function silenceWav(seconds = 1, rate = 16000) {
  const data = rate * seconds * 2;
  const b = Buffer.alloc(44 + data);
  b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(36 + data, 4); b.write('WAVE', 8, 'latin1');
  b.write('fmt ', 12, 'latin1'); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36, 'latin1'); b.writeUInt32LE(data, 40);
  return b;
}

async function check({ transcribe = speech.transcribe } = {}) {
  try {
    await transcribe(silenceWav(), 'audio/wav');
    return { state: 'ok', message: '' };
  } catch (e) {
    if (e.state === 'empty') return { state: 'ok', message: '' };     // the service answered; there were simply no words
    return { state: e.state || 'error', message: String(e.message || '').slice(0, 300) };
  }
}

exports.handler = withAuth({ action: 'manage_settings' }, async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  const r = await check();
  await getDb().collection('app_meta').doc('whatsapp').set({ speech: { ...r, at: Date.now(), checked: true } }, { merge: true });
  return json(200, r);
});

exports._internal = { check, silenceWav };
