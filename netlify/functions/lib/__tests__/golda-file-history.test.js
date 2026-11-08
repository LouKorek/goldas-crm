// A photo or PDF sent to Golda is shown to the model but never stored in the
// conversation history (a passport photo as base64 broke the history write).
const test = require('node:test');
const assert = require('node:assert/strict');
const { runAgent } = require('../wa-agent.js');

test('the file goes to the model, the returned turn text stays plain text', async () => {
  let seen;
  const client = { beta: { messages: { stream: (req) => ({ finalMessage: async () => {
    seen = req.messages.slice();
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'קיבלתי את הדרכון' }], usage: {} };
  } }) } } };
  const db = { collection: () => { throw new Error('no db in this test'); } };
  const media = { buffer: Buffer.alloc(900 * 1024, 7), mimeType: 'image/jpeg', filename: 'photo_abc.jpg' };
  for (const history of [[], [{ role: 'user', text: 'שלום' }, { role: 'assistant', text: 'היי' }]]) {
    const out = await runAgent({ db, admin: { firestore: { FieldValue: {} } }, identity: { name: 'לו קורק', role: 'admin', email: 'lou.korek@gmail.com' }, text: '', media,
      session: { history }, assistantName: 'גולדה', client, memories: [] });
    assert.equal(typeof out.userText, 'string');
    assert.ok(out.userText.length < 2000, 'no base64 in the stored text');
    assert.match(out.userText, /photo_abc\.jpg/);
    assert.ok(seen.some((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b.type === 'image')), 'the model still sees the photo');
  }
});
