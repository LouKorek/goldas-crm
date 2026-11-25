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

// ── the season row (per-match player data) ──────────────────────────────────
test('the season row: one line in both languages, nothing without data', { timeout: 60000 }, () => {
  const esbuild = require('esbuild');
  const out = esbuild.buildSync({ entryPoints: [path.join(root, 'apps/web/src/lib/playerCv.js')], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'error', nodePaths: [path.join(root, 'node_modules')] });
  const m = { exports: {} };
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(m, m.exports, require); // eslint-disable-line no-new-func
  const { seasonLine } = m.exports;
  const s = { label: '2026/27', apps: 12, minutes: 840, goals: 1, assists: 2, avgRating: 7.2, rated: 9 };
  assert.deepEqual(seasonLine(s, 'en'), { label: 'Season 2026/27', value: '12 matches   ·   840 min   ·   1 goal   ·   2 assists' });
  assert.deepEqual(seasonLine(s, 'he'), { label: 'עונה 2026/27', value: "12 משחקים   ·   840 דק'   ·   1 שער   ·   2 בישולים" });
  assert.ok(!/7\.2/.test(seasonLine(s, 'en').value), 'the agency\'s own rating stays off the sheet');
  assert.equal(seasonLine(null), null);
  assert.equal(seasonLine({ label: '2026/27', apps: 0, minutes: 0, goals: 0, assists: 0 }), null);
});

test('with every row, long notes and the season, the CV stays on one page', { timeout: 60000 }, async () => {
  const { buildPlayerCv, fonts, jsPDF } = load();
  const full = { ...player, playerName: 'Assaf Cohen', height: 182, secondaryPositions: ['CF'], natTeamCountry: 'Israel', natTeamStatus: 'Youth',
    notes: 'A long scouting note. '.repeat(80), videoLink: 'https://youtu.be/abcdefghijk', profileLink: 'transfermarkt.com/x' };
  for (const lang of ['en', 'he']) {
    const { doc } = await buildPlayerCv(jsPDF, fonts, full, 'men', { lang, season: { label: '2026/27', apps: 12, minutes: 840, goals: 3, assists: 2 } });
    assert.equal(doc.getNumberOfPages(), 1, lang);
  }
});

test('the server reads the season from the matches in Firestore', { timeout: 60000 }, async () => {
  const { fakeDb } = require('./fake-firestore.js');
  const { seasonOf } = require('../golda-pdf.js');
  const db = fakeDb({ matches: {
    m1: { date: '2026-10-01', linkedPlayers: ['p1'], playerStats: { p1: { minutes: 90, goals: 1 } } },
    m2: { date: '2026-11-01', linkedPlayers: ['p1'], playerStats: { p1: { minutes: 30 } } },
    m3: { date: '2026-03-01', linkedPlayers: ['p1'], playerStats: { p1: { minutes: 90, goals: 4 } } },   // last season
    m4: { date: '2026-11-08', linkedPlayers: ['p1'] },
  } });
  const now = new Date('2026-11-25T10:00:00Z');
  assert.deepEqual(await seasonOf(db, 'p1', now), { label: '2026/27', apps: 2, minutes: 120, goals: 1, assists: 0, avgRating: null, rated: 0 });
  assert.equal(await seasonOf(db, 'nobody', now), null);
  assert.equal(await seasonOf(null, 'p1', now), null);
  const r = await playerCvPdf(player, { lang: 'en', logo: null, load, db });
  assert.equal(r.buffer.slice(0, 5).toString(), '%PDF-');
});
