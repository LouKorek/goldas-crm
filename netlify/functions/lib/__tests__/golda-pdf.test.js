// Golda's documents: the player CV made on the server (the same module the app
// uses, bundled on the fly like the functions bundler does) and sent on
// WhatsApp as a document.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const root = path.join(__dirname, '..', '..', '..', '..');

let loaded;
function load() {
  if (loaded) return loaded;
  const esbuild = require('esbuild');
  const out = esbuild.buildSync({
    stdin: { contents: "module.exports = { cv: require('./apps/web/src/lib/playerCv.js'), fonts: require('./apps/web/src/lib/pdfFonts.js'), jspdf: require('jspdf') };", resolveDir: root, loader: 'js' },
    bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'error', nodePaths: [path.join(root, 'node_modules')],
  });
  const m = { exports: {} };
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(m, m.exports, require); // eslint-disable-line no-new-func
  loaded = { buildPlayerCv: m.exports.cv.buildPlayerCv, fonts: m.exports.fonts, jsPDF: m.exports.jspdf.jsPDF };
  return loaded;
}
const { playerCvPdf } = require('../golda-pdf.js');
const player = { id: 'p1', fullName: 'Assaf Cohen', dob: '2004-03-01', primaryPosition: 'Striker', nationalities: ['Israel'], currentClub: 'Hapoel Test', foot: 'Right', category: 'men' };

test('the CV comes out as a real PDF, in English and in Hebrew', { timeout: 60000 }, async () => {
  for (const lang of ['en', 'he']) {
    const r = await playerCvPdf(player, { lang, logo: null, load });
    assert.equal(r.mimeType, 'application/pdf');
    assert.equal(r.buffer.slice(0, 5).toString(), '%PDF-');
    assert.ok(r.buffer.length > 5000);
    assert.equal(r.filename, 'Assaf Cohen - Gold A&S.pdf');
  }
});

test('a Hebrew name stays in the file name; characters files cannot hold are dropped', { timeout: 60000 }, async () => {
  const r = await playerCvPdf({ ...player, fullName: 'אסף / כהן' }, { lang: 'he', logo: null, load });
  assert.equal(r.filename, 'אסף  כהן - Gold A&S.pdf');
});

test('sendDocument uploads the file to WhatsApp, then sends it as a document with its name', async () => {
  process.env.WA_TOKEN = process.env.WA_TOKEN || 'test-token';
  process.env.WA_PHONE_ID = process.env.WA_PHONE_ID || '111';
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (/\/media$/.test(url)) return { ok: true, status: 200, json: async () => ({ id: 'MEDIA1' }), text: async () => '' };
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.DOC' }] }), text: async () => '' };
  };
  try {
    const wa = require('../wa-api.js');
    const ids = await wa.sendDocument('972500000001', { buffer: Buffer.from('%PDF-1.3 test'), filename: 'Assaf Cohen - Gold A&S.pdf', caption: 'CV' }, '111');
    assert.deepEqual(ids, ['wamid.DOC']);
    assert.match(calls[0].url, /\/111\/media$/);
    assert.ok(calls[0].init.body instanceof FormData);
    const sent = JSON.parse(calls[calls.length - 1].init.body);
    assert.equal(sent.type, 'document');
    assert.deepEqual(sent.document, { id: 'MEDIA1', filename: 'Assaf Cohen - Gold A&S.pdf', caption: 'CV' });
  } finally { global.fetch = realFetch; }
});
