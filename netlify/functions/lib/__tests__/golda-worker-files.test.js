// Documents Golda attaches to an answer: stored like CRM files, sent after the
// text on WhatsApp, read back for a reply that goes out later.
const test = require('node:test');
const assert = require('node:assert/strict');

const store = {};
const db = {
  collection: (c) => ({
    doc: (id) => ({
      async set(v) { store[`${c}/${id}`] = v; },
      async get() { const v = store[`${c}/${id}`]; return { exists: v !== undefined, data: () => v }; },
      collection: (sub) => ({ doc: (i) => ({
        async set(v) { store[`${c}/${id}/${sub}/${i}`] = v; },
        async get() { const v = store[`${c}/${id}/${sub}/${i}`]; return { exists: v !== undefined, data: () => v }; },
      }) }),
    }),
  }),
};
const fsPath = require.resolve('../firestore.js');
require.cache[fsPath] = { id: fsPath, filename: fsPath, loaded: true, exports: { admin: { firestore: { FieldValue: {} } }, getDb: () => db } };
const sent = [];
const waPath = require.resolve('../wa-api.js');
require.cache[waPath] = { id: waPath, filename: waPath, loaded: true, exports: {
  sendText: async (to, text) => { sent.push(['text', text]); return ['wamid.T']; },
  sendButtons: async () => ['wamid.B'], sendList: async () => ['wamid.L'],
  sendDocument: async (to, f) => { if (f.filename === 'bad.pdf') throw new Error('refused'); sent.push(['doc', f.filename]); return ['wamid.D']; },
} };
const { deliver, storeOutFile, loadOutFile } = require('../golda-worker.js');

const big = Buffer.alloc(700 * 1024, 7);    // more than one chunk once base64'd
const file = { buffer: big, filename: 'Assaf Cohen - Gold A&S.pdf', mimeType: 'application/pdf' };

test('a stored document comes back byte for byte, across chunks', async () => {
  const ref = await storeOutFile(db, file, { email: 'lou@x.com' });
  assert.match(ref.fileId, /^golda_/);
  assert.equal(store[`files/${ref.fileId}`].madeBy, 'golda');
  assert.ok(store[`files/${ref.fileId}`].parts > 1);
  const back = await loadOutFile(db, ref);
  assert.ok(back.buffer.equals(big));
  assert.equal(back.filename, file.filename);
});

test('on WhatsApp the text goes first, then each document; a refused document does not fail the reply', async () => {
  sent.length = 0;
  const ids = await deliver({ channel: 'whatsapp', from: '972500000001' }, 'הנה הדף', { files: [file, { ...file, filename: 'bad.pdf' }] });
  assert.deepEqual(sent, [['text', 'הנה הדף'], ['doc', 'Assaf Cohen - Gold A&S.pdf']]);
  assert.deepEqual(ids, ['wamid.T', 'wamid.D']);
});

test('in the app nothing is sent; the inbox document carries the files', async () => {
  sent.length = 0;
  assert.deepEqual(await deliver({ channel: 'app' }, 'x', { files: [file] }), []);
  assert.deepEqual(sent, []);
});
