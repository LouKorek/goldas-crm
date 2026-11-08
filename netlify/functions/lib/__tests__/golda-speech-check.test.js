const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { check, silenceWav } = require(path.join(__dirname, '..', '..', 'golda-speech-check.js'))._internal;
const speech = require('../golda-speech.js');

test('the silence clip is a valid 16 kHz mono WAV that the transcriber accepts', () => {
  const b = silenceWav();
  assert.equal(b.slice(0, 4).toString('latin1'), 'RIFF');
  assert.equal(b.readUInt32LE(24), 16000);
  assert.equal(b.length, 44 + 32000);
  assert.ok(speech.configFor(b, 'audio/wav'));
});

test('"no words heard" means the service works', async () => {
  const r = await check({ transcribe: async () => { throw new speech.SpeechError('empty', 'no speech recognised'); } });
  assert.deepEqual(r, { state: 'ok', message: '' });
});

test('a disabled or unpaid service is reported with its reason', async () => {
  const r = await check({ transcribe: async () => { throw new speech.SpeechError('needs_billing', 'billing off'); } });
  assert.equal(r.state, 'needs_billing');
  assert.equal(r.message, 'billing off');
});
