// Nightly trigger for the match-fixture sync.
//
// Until now the sync only ran when Lou pressed Sync Now — the file comment in
// sync-matches-background.js promised a cron that was never actually written.
// This is it. Same shape as tm-watch-cron / ig-watch-cron: background
// functions and schedule() don't mix reliably, so the scheduled function just
// kicks the background worker over HTTP and returns.
//
// The worker requires auth and a cron has no Firebase ID token, so it sends
// a single-use internal nonce (lib/auth.js) instead.
//
// 03:10 UTC = 05:10/06:10 Israel — fixtures are current before Lou's morning.

const { schedule } = require('@netlify/functions');
const { internalHeaders } = require('./lib/auth.js');

exports.handler = schedule('10 3 * * *', async () => {
  const base = process.env.URL || 'https://goldas-crm.netlify.app';
  try {
    const res = await fetch(`${base}/.netlify/functions/sync-matches-background`, {
      method: 'POST',
      headers: await internalHeaders('sync-matches-cron'),
    });
    return { statusCode: 200, body: `triggered: ${res.status}` };
  } catch (e) {
    return { statusCode: 500, body: String(e) };
  }
});
