// The system's own health in one small page, readable without signing in:
//   GET /.netlify/functions/system-status
// So a check after a change ("did the mail sync run? is last night's backup
// good?") needs nobody's computer and nobody's password. It is open, so it
// says states, times and counts only (the rule and the fixed word lists are
// in lib/system-status.js): no names, addresses, ids or error texts.
// Netlify's edge keeps an answer for a minute, so asking often costs nothing.
const { getDb } = require('./lib/firestore.js');
const { readStatus } = require('./lib/system-status.js');

const HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'Netlify-CDN-Cache-Control': 'public, max-age=60',
  'X-Robots-Tag': 'noindex, nofollow',
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'GET only' }) };
  try {
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify(await readStatus(getDb()), null, 2) };
  } catch (e) {
    console.error('[system-status] failed:', e.message);
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'the status could not be read' }) };
  }
};
