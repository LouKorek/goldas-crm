// Documents Golda makes and hands over: today the one-page player CV, the
// same sheet the app downloads (apps/web/src/lib/playerCv.js), built here on
// the server so she can send it on WhatsApp or show it in the app chat.
//
// The CV source is an ES module of the web app; the functions bundler
// (esbuild) folds it, jsPDF and the embedded fonts into this function. Tests
// pass their own `load` (an esbuild bundle built on the fly).
const { playerName, playerMatchRows, summarizeStats, currentSeason } = require('@goldas/domain');

const APP_URL = () => (process.env.URL || 'https://goldas-crm.netlify.app').replace(/\/$/, '');

let _logo;
/** The agency logo as a data: URL (from the site itself), or null. Cached per instance. */
async function logoDataUrl(fetchImpl = fetch) {
  if (_logo !== undefined) return _logo;
  try {
    const res = await fetchImpl(`${APP_URL()}/logo.png`);
    _logo = res.ok ? `data:image/png;base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}` : null;
  } catch { _logo = null; }
  return _logo;
}

function defaultLoad() {
  /* eslint-disable global-require */
  const cv = require('../../../apps/web/src/lib/playerCv.js');
  const fonts = require('../../../apps/web/src/lib/pdfFonts.js');
  const jspdf = require('jspdf');
  return { buildPlayerCv: cv.buildPlayerCv, fonts, jsPDF: jspdf.jsPDF || jspdf.default || jspdf };
}

/**
 * The current season's totals of a player from the matches in Firestore
 * (matches/{id}.playerStats), for the CV's season row; null when none or on
 * any read failure (the CV never waits on it).
 */
async function seasonOf(db, playerId, now = new Date()) {
  if (!db || !playerId) return null;
  try {
    const snap = await db.collection('matches').where('linkedPlayers', 'array-contains', playerId).get();
    const label = currentSeason(now);
    const rows = playerMatchRows(snap.docs.map((d) => ({ id: d.id, ...d.data() })), playerId).filter((r) => r.season === label);
    return rows.length ? { label, ...summarizeStats(rows) } : null;
  } catch (e) {
    console.warn('[golda-pdf] season read failed:', e.message);
    return null;
  }
}

/**
 * The player's CV as a PDF buffer. lang 'en' (clubs abroad, the default) or 'he'.
 * With `db`, the current season's match totals are read and printed; pass
 * `season` to give them directly. Returns { buffer, filename, mimeType }.
 */
async function playerCvPdf(player, { lang = 'en', load = defaultLoad, logo, db = null, season } = {}) {
  const { buildPlayerCv, fonts, jsPDF } = load();
  const totals = season !== undefined ? season : await seasonOf(db, player.id);
  const name = playerName(player);
  const { doc } = await buildPlayerCv(jsPDF, fonts, { ...player, playerName: name }, player.category || 'men',
    { lang: lang === 'he' ? 'he' : 'en', logo: logo === undefined ? await logoDataUrl() : logo, season: totals });
  // The app's file name drops Hebrew; WhatsApp and the app show it, so keep it.
  const filename = `${String(name || 'player').replace(/[\\/:*?"<>|]/g, '').trim() || 'player'} - Gold A&S.pdf`;
  return { buffer: Buffer.from(doc.output('arraybuffer')), filename, mimeType: 'application/pdf' };
}

module.exports = { playerCvPdf, logoDataUrl, seasonOf, _reset: () => { _logo = undefined; } };
