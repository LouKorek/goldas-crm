// Documents Golda makes and hands over: today the one-page player CV, the
// same sheet the app downloads (apps/web/src/lib/playerCv.js), built here on
// the server so she can send it on WhatsApp or show it in the app chat.
//
// The CV source is an ES module of the web app; the functions bundler
// (esbuild) folds it, jsPDF and the embedded fonts into this function. Tests
// pass their own `load` (an esbuild bundle built on the fly).
const { playerName } = require('@goldas/domain');

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
 * The player's CV as a PDF buffer. lang 'en' (clubs abroad, the default) or 'he'.
 * Returns { buffer, filename, mimeType }.
 */
async function playerCvPdf(player, { lang = 'en', load = defaultLoad, logo } = {}) {
  const { buildPlayerCv, fonts, jsPDF } = load();
  const name = playerName(player);
  const { doc } = await buildPlayerCv(jsPDF, fonts, { ...player, playerName: name }, player.category || 'men',
    { lang: lang === 'he' ? 'he' : 'en', logo: logo === undefined ? await logoDataUrl() : logo });
  // The app's file name drops Hebrew; WhatsApp and the app show it, so keep it.
  const filename = `${String(name || 'player').replace(/[\\/:*?"<>|]/g, '').trim() || 'player'} - Gold A&S.pdf`;
  return { buffer: Buffer.from(doc.output('arraybuffer')), filename, mimeType: 'application/pdf' };
}

module.exports = { playerCvPdf, logoDataUrl, _reset: () => { _logo = undefined; } };
