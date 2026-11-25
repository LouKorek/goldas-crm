// What every private public link of this site shares: the live player page
// (/p/<token>, lib/player-pages.js) and the representation agreement a player
// signs on his phone (/sign/<token>, lib/agreements.js).
//
// A link's token is 192 random bits, safe in an address. The database never
// holds it as it is: a link is filed under the SHA-256 of its token (so
// finding it is one document read and no secret is compared as a string) and
// keeps a sealed copy (lib/seal.js) for showing it to an admin again.
//
// The public endpoints answer every link that does not work (unknown,
// malformed, expired, revoked, used) with the same short 404, echo nothing
// from the request, are never cached or indexed and send no referrer.
const crypto = require('crypto');
const { header, resolveUser } = require('./auth.js');

const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;
const ID_RE = /^[a-f0-9]{64}$/;

const newToken = () => crypto.randomBytes(24).toString('base64url');
const validToken = (t) => typeof t === 'string' && TOKEN_RE.test(t);
const idOf = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const validId = (id) => ID_RE.test(String(id || ''));
const sha256 = (text) => crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');

/** 'phone' or 'desktop', and nothing else: the user agent itself is never stored. */
const deviceOf = (userAgent) => (/Mobi|Android|iPhone|iPad|iPod|Windows Phone/i.test(String(userAgent || '')) ? 'phone' : 'desktop');

/** The headers every answer of a public endpoint carries. */
const HEADERS = {
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};
const json = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json', ...HEADERS }, body: JSON.stringify(body) });
/** The one answer for a link that does not work, whatever the reason. */
const notAvailable = () => json(404, { error: 'not_available' });

/** A PDF as a download, with an ASCII file name and the real one beside it. */
function pdfResponse(file, fallback = 'document.pdf') {
  const name = String(file.filename || fallback);
  const ascii = name.replace(/[^\x20-\x7e]/g, '').replace(/["\\]/g, '').trim().replace(/^-\s*/, '');
  return {
    statusCode: 200, isBase64Encoded: true, body: Buffer.from(file.buffer).toString('base64'),
    headers: { ...HEADERS, 'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${/\.pdf$/i.test(ascii) && ascii.length > 4 ? ascii : fallback}"; filename*=UTF-8''${encodeURIComponent(name)}` },
  };
}

/** A signed-in CRM user looking at a link is a preview, never an opening. */
async function isPreview(event) {
  if (!header(event, 'authorization')) return false;
  try {
    const user = await resolveUser(event);
    return !!(user && user.role);
  } catch { return false; }
}

const two = (n) => String(n).padStart(2, '0');
/** 25/11 14:32 in Israel time. */
function whenHe(ms) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${two(parts.day)}/${two(parts.month)} ${two(parts.hour === '24' ? '00' : parts.hour)}:${two(parts.minute)}`;
}

module.exports = { TOKEN_RE, newToken, validToken, idOf, validId, sha256, deviceOf, HEADERS, json, notAvailable, pdfResponse, isPreview, whenHe };
