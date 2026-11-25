// The live player page's endpoint (/p/<token>, apps/web/src/pages/PlayerPage.jsx).
//
// No sign-in: the token in the link is the key (lib/player-pages.js). It is
// random (192 bits), belongs to one player, lives as long as the owner chose
// (14 days when he named none, 90 at most) and can do one thing only: show
// that player's public profile. Expiry and revocation are checked here on
// every request.
//
//   POST { t, action: 'view' }    → the profile; this is what counts as an opening
//   POST { t, action: 'photo' }   → { photo: 'data:image/…' }
//   GET  ?t=<token>&cv=1          → the CV as a PDF, made from the same fields
//
// The profile is asked for with a POST from the page's own script, so a robot
// that only fetches the address (WhatsApp does, for the link preview) never
// counts as a club opening the page, and nothing here is ever cached.
//
// Any link that does not work (unknown, malformed, revoked, expired, or its
// player was deleted) gets the same short answer, with no hint which it was.
// Nothing from the request is echoed back and no error text leaves the server.
//
// There is no per-address rate limit on this site, so every request is held
// to a small, fixed number of reads and writes: an unknown token costs one
// document read; a view costs two reads and one small transaction (plus one
// query of the player's matches at most every six hours per link); a photo at
// most eleven reads; the CV two reads.
const { getDb } = require('./lib/firestore.js');
const { header, internalHeaders } = require('./lib/auth.js');
const { originOf } = require('./lib/site.js');
const pages = require('./lib/player-pages.js');
// The headers, the one dead-link answer, the preview check and the PDF download are shared with /sign/ (lib/public-link.js).
const { HEADERS, json, notAvailable: NOT_AVAILABLE, isPreview, pdfResponse } = require('./lib/public-link.js');

// The agency's contact, the same line the CV closes with.
const CONTACT = { site: 'gold-as.com', url: 'https://gold-as.com', agent: { en: 'Lou Korek', he: 'לו קורק' }, title: { en: 'FIFA Licensed Agent', he: 'סוכן מורשה FIFA' } };

/** Wakes the function that tells the owner; never waits long and never fails the page. */
async function kickNotice(event) {
  try {
    await fetch(`${originOf(event)}/.netlify/functions/player-page-notify-background`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(await internalHeaders('player-page-notice')) },
      body: '{}', signal: AbortSignal.timeout(2500),
    });
  } catch (e) { console.warn('[player-page] the notice will go out on the next ten-minute check:', e.name); }
}

/** The live player a link points at, or null. */
async function playerOf(db, link) {
  const snap = await db.collection('players').doc(link.playerId).get();
  return snap.exists && !snap.data().deletedAt ? { id: snap.id, ...snap.data() } : null;
}

async function handle(event, deps = {}) {
  const db = deps.db || getDb();
  const now = deps.now || Date.now();
  const preview = deps.isPreview || isPreview;
  const kick = deps.kickNotice || kickNotice;

  if (event.httpMethod === 'GET') {
    const q = event.queryStringParameters || {};
    if (q.cv !== '1') return NOT_AVAILABLE();
    const link = await pages.linkByToken(db, q.t, now);
    const player = link ? await playerOf(db, link) : null;
    if (!player) return NOT_AVAILABLE();
    const pub = pages.publicPlayer(player, new Date(now));
    const makePdf = deps.cvPdf || require('./lib/golda-pdf.js').playerCvPdf;
    const file = await makePdf(pages.cvPlayer(pub, { women: player.gender === 'Women' }), { lang: link.lang });
    return pdfResponse(file, 'player.pdf');
  }

  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });
  if (String(event.body || '').length > 2000) return NOT_AVAILABLE();
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return NOT_AVAILABLE(); }
  if (!body || typeof body !== 'object' || !['view', 'photo'].includes(body.action)) return NOT_AVAILABLE();

  const link = await pages.linkByToken(db, body.t, now);
  const player = link ? await playerOf(db, link) : null;
  if (!player) return NOT_AVAILABLE();

  if (body.action === 'photo') {
    const photo = await pages.loadPhoto(db, player);
    return photo ? json(200, { photo }) : NOT_AVAILABLE();
  }

  const isOwn = await preview(event);
  if (!isOwn) {
    const opened = await pages.recordOpening(db, link.id, { device: pages.deviceOf(header(event, 'user-agent')), now });
    if (!opened) return NOT_AVAILABLE();          // revoked or expired between the two reads
    if (opened.first) await kick(event);
  }
  let stats = null;
  try { stats = await pages.statsFor(db, link, { now }); } catch (e) { console.warn('[player-page] season totals skipped:', e.message); }
  return json(200, {
    lang: link.lang === 'he' ? 'he' : 'en',
    player: pages.publicPlayer(player, new Date(now)),
    stats,
    contact: CONTACT,
    expiresAt: new Date(link.expiresAt).toISOString(),
    ...(isOwn ? { preview: true } : {}),
  });
}

exports.handler = async (event) => {
  try {
    return await handle(event);
  } catch (e) {
    console.error('[player-page]', e.message);
    return json(500, { error: 'unavailable' });
  }
};
exports._handle = handle;
exports.HEADERS = HEADERS;
